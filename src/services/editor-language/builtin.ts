import type * as M from 'monaco-editor';
import type { CompleteRequest, CompleteResult, CompletionItem } from '../../shared/language-v2';
import { validateCompletionEdits } from '../../shared/validation-v2';
import { normalizeContent } from '../../language/uriCodec';
/** Public TS/JS worker factory is injected by language registry; no family selection in GUI/bridge. */
export type BuiltinWorkerFactory = (model: M.editor.ITextModel) => Promise<{
  getCompletionsAtPosition(fileName: string, position: number): Promise<{
    entries: readonly {name:string;insertText?:string;replacementSpan?:{start:number;length:number};
      isSnippet?:boolean;hasAction?:boolean;source?:string;data?:unknown}[];
    optionalReplacementSpan?:{start:number;length:number}; isIncomplete?:boolean;
  } | undefined>;
}>;
/** No registerCompletionItemProvider/native widget: plain independently safe edits go through the facade. */
export function createBuiltinCompletionProvider(workerFactory: BuiltinWorkerFactory) {
  return async (model: M.editor.ITextModel, request: CompleteRequest, signal: AbortSignal): Promise<CompleteResult> => {
    const empty = ():CompleteResult => ({requestId:request.requestId,stamp:request.stamp,items:[],isIncomplete:false});
    if (signal.aborted || model.isDisposed() || model.getVersionId() !== request.stamp.localModelVersion) return empty();
    const worker = await workerFactory(model);
    if (signal.aborted || model.isDisposed() || model.getVersionId() !== request.stamp.localModelVersion) return empty();
    const position = {lineNumber:request.position.line,column:request.position.column};
    const info = await worker.getCompletionsAtPosition(model.uri.toString(),model.getOffsetAt(position));
    if (!info || signal.aborted || model.isDisposed() || model.getVersionId() !== request.stamp.localModelVersion) return empty();
    const items: CompletionItem[] = [], content=normalizeContent(model.getValue());
    for (const entry of info.entries) {
      if (items.length >= 100) break;
      // Auto-import/resolve/snippet effects are not independently self-contained. Never resolve or execute them.
      if (entry.isSnippet || entry.hasAction || entry.source || entry.data || !entry.name || entry.name.length>256) continue;
      const span = entry.replacementSpan ?? info.optionalReplacementSpan;
      let range;
      if (span) {
        if (!Number.isSafeInteger(span.start) || !Number.isSafeInteger(span.length) || span.start<0 || span.length<0 || span.start+span.length>model.getValueLength()) continue;
        const start=model.getPositionAt(span.start),end=model.getPositionAt(span.start+span.length);
        range={startLine:start.lineNumber,startColumn:start.column,endLine:end.lineNumber,endColumn:end.column};
      } else {
        const word=model.getWordUntilPosition(position);
        range={startLine:position.lineNumber,startColumn:word.startColumn,endLine:position.lineNumber,endColumn:word.endColumn};
      }
      const item:CompletionItem={id:`builtin-${items.length}`,label:entry.name,detail:null,
        primary:{path:request.stamp.path,range,text:entry.insertText ?? entry.name},additionalTextEdits:[]};
      if (validateCompletionEdits(item,request.stamp,content)) items.push(item);
    }
    return {requestId:request.requestId,stamp:request.stamp,items,isIncomplete:info.isIncomplete ?? false};
  };
}
