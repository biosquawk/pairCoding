import type * as M from 'monaco-editor';
import { normalizeContent } from '../language/uriCodec';
import { createBuiltinCompletionProvider, type BuiltinWorkerFactory } from './editor-language/builtin';
import { createCurrentDocumentWordsProvider } from './editor-language/currentDocumentWords';
import type { LocalBuiltinProvider } from './monacoLspBridge';
// Monaco's onLanguage setup and public getters import the same lazy mode independently.
// Await that module first, so its already-requested model-language setup settles before
// any getter. Share the barrier across completion/readiness/diagnostics, not worker proxies.
const modeReady:Partial<Record<'javascript'|'typescript',Promise<unknown>>>={};
const initializeTypeScriptMode=(language:'javascript'|'typescript')=>modeReady[language]??=import('monaco-editor/esm/vs/language/typescript/tsMode.js');
/** Public local workers and current-model words only. Never register a native completion provider. */
export function createBuiltinLanguageRegistry(monaco:typeof M):LocalBuiltinProvider {
  // Only this adapter owns TS/JS markers; native diagnostics would ignore configuration flags.
  for(const mode of [monaco.typescript.typescriptDefaults,monaco.typescript.javascriptDefaults])
    mode.setModeConfiguration({...mode.modeConfiguration,diagnostics:false});
  const workerFor=(language:'javascript'|'typescript')=>async(model:M.editor.ITextModel)=>{
    await initializeTypeScriptMode(language);
    // A retired/switching model must not start or synchronize a worker after lazy loading.
    if(model.isDisposed()||model.getLanguageId()!==language)throw new Error('Retired local language model');
    const getter=language==='javascript'?monaco.typescript.getJavaScriptWorker:monaco.typescript.getTypeScriptWorker;
    return (await getter())(model.uri);
  };
  const workers:Record<string,(model:M.editor.ITextModel)=>Promise<M.typescript.TypeScriptWorker>>={
    javascript:workerFor('javascript'),typescript:workerFor('typescript'),
  };
  const factories:Record<string,BuiltinWorkerFactory>=workers;
  const words=createCurrentDocumentWordsProvider();
  const providers:Record<string,ReturnType<typeof createBuiltinCompletionProvider>>={
    ...Object.fromEntries(Object.entries(factories).map(([key,factory])=>[key,createBuiltinCompletionProvider(factory)])),
    java:words,python:words,
  };
  return Object.assign(((model,request,signal)=>providers[model.getLanguageId()]?.(model,request,signal)??null) as LocalBuiltinProvider,{
    ready:async(model:M.editor.ITextModel)=>{
      const worker=workers[model.getLanguageId()];
      if(worker) {
        const proxy=await worker(model),text=await proxy.getScriptText(model.uri.toString());
        return typeof text==='string'&&normalizeContent(text)===normalizeContent(model.getValue());
      }
      return !!providers[model.getLanguageId()];
    },
    hasDiagnostics:(model:M.editor.ITextModel)=>!!workers[model.getLanguageId()],
    diagnostics:async(model:M.editor.ITextModel)=>{
      const worker=workers[model.getLanguageId()];if(!worker)return null;
      const proxy=await worker(model),uri=model.uri.toString();
      const diagnostics=[...await proxy.getSyntacticDiagnostics(uri),...await proxy.getSemanticDiagnostics(uri)];
      const message=(m:string|{messageText:string;next?:readonly {messageText:string}[]}):string=>typeof m==='string'?m:[m.messageText,...(m.next??[]).map(message)].join('\n');
      return diagnostics.slice(0,500).flatMap(d=>{
        if(!Number.isSafeInteger(d.start)||!Number.isSafeInteger(d.length)||d.start!<0||d.length!<0||d.start!+d.length!>model.getValueLength())return [];
        const start=model.getPositionAt(d.start!),end=model.getPositionAt(d.start!+d.length!);
        return [{startLineNumber:start.lineNumber,startColumn:start.column,endLineNumber:end.lineNumber,endColumn:end.column,
          message:message(d.messageText),severity:d.category===1?monaco.MarkerSeverity.Error:d.category===0?monaco.MarkerSeverity.Warning:monaco.MarkerSeverity.Info,code:String(d.code)}];
      });
    },
  });
}
/** Syntax language is data, separate from approved completion provider. */
export function languageForPath(path:string):string {
  const languages:Record<string,string>={java:'java',py:'python',js:'javascript',mjs:'javascript',cjs:'javascript',ts:'typescript',tsx:'typescript',md:'markdown',markdown:'markdown',json:'json',html:'html',css:'css'};
  return languages[path.split('.').at(-1) ?? ''] ?? 'plaintext';
}
