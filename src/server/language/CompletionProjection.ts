import type { CompleteRequest, CompleteResult, CompletionEdit, CompletionItem } from '../../shared/language-v2';
import { LANGUAGE_LIMITS } from '../../shared/language-v2';
import { validateCompleteRequest, validateCompleteResult, validateCompletionEdits } from '../../shared/validation-v2';
import type { Range } from '../../shared/protocol';
/** SAME central mapper exports. UTF16/disjoint checks use the frozen shared validator, not a second mapper. */
export interface CompletionProjectionCodec {
  normalizeContent(content: string): string;
  contentSha256(content: string): string;
  toWorkspaceUri(path: string): string;
}
/** Captured from exact sent request/version ledger, never the currently active document on receipt. */
export interface CompletionProjectionInput {
  request: Readonly<CompleteRequest>; content: string; workspaceUri: string;
}
const record=(v:unknown):v is Record<string,unknown>=>!!v && typeof v==='object' && !Array.isArray(v) && Object.getPrototypeOf(v)===Object.prototype;
const copy=<T>(v:T):T=>JSON.parse(JSON.stringify(v));
const boundedInt=(v:unknown):v is number=>Number.isSafeInteger(v) && (v as number)>=0 && (v as number)<Number.MAX_SAFE_INTEGER;
function range(v:unknown):Range|null {
  if(!record(v) || !record(v.start) || !record(v.end) || !boundedInt(v.start.line) || !boundedInt(v.start.character) ||
    !boundedInt(v.end.line) || !boundedInt(v.end.character)) return null;
  return {startLine:v.start.line+1,startColumn:v.start.character+1,endLine:v.end.line+1,endColumn:v.end.character+1};
}
function edit(v:unknown,path:string):CompletionEdit|null {
  if(!record(v) || typeof v.newText!=='string' || v.newText.length>LANGUAGE_LIMITS.editUtf16 ||
    // No TextDocumentEdit, InsertReplaceEdit, snippet, URI, action or hidden multi-file semantics.
    Object.keys(v).some(k=>!['range','newText'].includes(k))) return null;
  const r=range(v.range);return r ? {path,range:r,text:v.newText} : null;
}
/**
 * Allowlist only. Self-contained textEdit required: insertText/label defaults/resolve cannot manufacture it.
 * JDT ancillary command/data/documentation are discarded, NEVER forwarded/executed. Snippets rejected.
 * Unsupported itemDefaults reject the list; applying inherited defaults would change its edit semantics.
 */
export function projectCompletion(raw:unknown,input:CompletionProjectionInput,codec:CompletionProjectionCodec):CompleteResult {
  const request=copy(input.request), result:CompleteResult={requestId:request.requestId,stamp:copy(request.stamp),items:[],isIncomplete:false};
  if(!validateCompleteRequest(request) || codec.toWorkspaceUri(request.stamp.path)!==input.workspaceUri ||
    codec.contentSha256(input.content)!==request.stamp.contentSha256) throw new Error('Invalid captured completion source');
  const content=codec.normalizeContent(input.content);
  // LSP uses zero-based coordinates; bounds and UTF16 surrogate boundaries remain the shared validator's job.
  const cursor:CompletionItem={id:'cursor',label:'cursor',detail:null,primary:{path:request.stamp.path,
    range:{startLine:request.position.line,startColumn:request.position.column,endLine:request.position.line,endColumn:request.position.column},text:''},additionalTextEdits:[]};
  if(!validateCompletionEdits(cursor,request.stamp,content)) throw new Error('Invalid captured completion position');
  let items:unknown[];
  if(raw===null) return result;
  try { if(Buffer.byteLength(JSON.stringify(raw),'utf8')>LANGUAGE_LIMITS.responseBytes) return result; } catch { return result; }
  if(Array.isArray(raw)) items=raw;
  else if(record(raw) && Array.isArray(raw.items) && typeof raw.isIncomplete==='boolean' && !Object.hasOwn(raw,'itemDefaults')) {
    items=raw.items;result.isIncomplete=raw.isIncomplete;
  } else return result;
  // Bound raw candidates too; never truncate arbitrary huge LSP input before establishing a limit.
  if(items.length>LANGUAGE_LIMITS.completionItems) return result;
  for(const [index,v] of items.entries()) {
    if(!record(v) || typeof v.label!=='string' || v.label.length<1 || v.label.length>256 ||
      (v.insertTextFormat!==undefined && v.insertTextFormat!==1) ||
      (v.insertTextMode!==undefined && v.insertTextMode!==1) ||
      (v.detail!==undefined && (typeof v.detail!=='string' || v.detail.length>1024))) continue;
    const primary=edit(v.textEdit,request.stamp.path);if(!primary) continue;
    if(v.additionalTextEdits!==undefined && (!Array.isArray(v.additionalTextEdits) || v.additionalTextEdits.length>100)) continue;
    const additional=(v.additionalTextEdits as unknown[]|undefined ?? []).map(e=>edit(e,request.stamp.path));
    if(additional.some(e=>!e)) continue;
    const item:CompletionItem={id:`item:${index}`,label:v.label,detail:typeof v.detail==='string'?v.detail:null,
      primary,additionalTextEdits:additional as CompletionEdit[]};
    if(!validateCompletionEdits(item,request.stamp,content)) continue;
    result.items.push(item);
    // Projection can expand coordinate keys; cap the actual outgoing DTO, not only the raw response.
    const valid:boolean=validateCompleteResult(result);
    if(!valid) { result.items.pop();break; }
  }
  return result;
}
