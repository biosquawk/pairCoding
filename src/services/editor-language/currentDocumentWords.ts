import type * as M from 'monaco-editor';
import type { CompleteRequest, CompleteResult, CompletionItem } from '../../shared/language-v2';
import { validateCompletionEdits } from '../../shared/validation-v2';
import { contentSha256, normalizeContent } from '../../language/uriCodec';
/** Java/Python deliberately have no parser, index, filesystem, other-model or AI input. */
export function createCurrentDocumentWordsProvider() {
  return async(model:M.editor.ITextModel,request:CompleteRequest,signal:AbortSignal):Promise<CompleteResult>=>{
    const result:CompleteResult={requestId:request.requestId,stamp:request.stamp,items:[],isIncomplete:false};
    if(signal.aborted||model.isDisposed()||model.getVersionId()!==request.stamp.localModelVersion)return result;
    const content=normalizeContent(model.getValue());
    if(contentSha256(content)!==request.stamp.contentSha256)return result;
    const offset=model.getOffsetAt({lineNumber:request.position.line,column:request.position.column});
    const before=content.slice(0,offset),prefix=before.match(/[\p{L}\p{N}_$]+$/u)?.[0]??'';
    // No object-member/semantic promise, and no unbounded empty-prefix list.
    if(!prefix||before.slice(0,-prefix.length).endsWith('.'))return result;
    const words=new Set<string>();
    for(const match of content.matchAll(/[\p{L}_$][\p{L}\p{N}_$]*/gu)){
      const word=match[0];
      if(word.length<=256&&word!==prefix&&word.startsWith(prefix))words.add(word);
      if(words.size>=100)break;
    }
    for(const word of [...words].sort()){
      const item:CompletionItem={id:`word-${result.items.length}`,label:word,detail:'Słowo z bieżącego dokumentu',
        primary:{path:request.stamp.path,range:{startLine:request.position.line,startColumn:request.position.column-prefix.length,endLine:request.position.line,endColumn:request.position.column},text:word},additionalTextEdits:[]};
      if(validateCompletionEdits(item,request.stamp,content))result.items.push(item);
    }
    return result;
  };
}
