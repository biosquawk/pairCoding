import type * as M from 'monaco-editor';
import { createBuiltinCompletionProvider, type BuiltinWorkerFactory } from './editor-language/builtin';
import type { EditorLanguageBinding } from './monacoLspBridge';
/** Public factories only, invoked after server approval. No competing native provider/widget. */
export function createBuiltinLanguageRegistry(monaco:typeof M):NonNullable<EditorLanguageBinding['builtin']> {
  const factories:Record<string,BuiltinWorkerFactory>={
    javascript:async model=>(await monaco.typescript.getJavaScriptWorker())(model.uri),
    typescript:async model=>(await monaco.typescript.getTypeScriptWorker())(model.uri),
  };
  const providers=Object.fromEntries(Object.entries(factories).map(([key,factory])=>[key,createBuiltinCompletionProvider(factory)]));
  return (model,request,signal)=>providers[model.getLanguageId()]?.(model,request,signal)??null;
}

/** Syntax language is data, separate from approved completion provider. */
export function languageForPath(path:string):string {
  const languages:Record<string,string>={java:'java',py:'python',js:'javascript',mjs:'javascript',cjs:'javascript',ts:'typescript',tsx:'typescript',md:'markdown',markdown:'markdown',json:'json',html:'html',css:'css'};
  return languages[path.split('.').at(-1) ?? ''] ?? 'plaintext';
}
