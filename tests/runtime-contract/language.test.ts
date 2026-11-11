import test from 'node:test';
import assert from 'node:assert/strict';
import * as v from '../../src/shared/validation-v2';
import { diagnostics, hash, item, stamp } from './fixtures';

test('full captured stamp: explicit preACK null, no missing/version guess, no alternative names',()=>{
  assert.equal(v.validateDocumentStamp(stamp()),true);
  assert.equal(v.validateDocumentStamp({...stamp(),documentVersion:1}),true);
  assert.equal(v.validateDocumentStamp({...stamp(),documentVersion:2}),false);
  for(const key of Object.keys(stamp())) { const s:any=stamp();delete s[key];assert.equal(v.validateDocumentStamp(s),false,key); }
  for(const key of ['localModelVersion','baseDocumentVersion','requestGeneration'])
    for(const value of [0,-1,1.2,'1']) assert.equal(v.validateDocumentStamp({...stamp(),[key]:value}),false);
  for(const key of ['modelHandle','ownershipEpoch','alternativeVersionId','command']) assert.equal(v.validateDocumentStamp({...stamp(),[key]:'x'}),false);
  assert.equal(v.validateDocumentStamp({...stamp(),path:'../escape.py'}),false);
  assert.equal(v.validateDocumentStamp({...stamp(),contentSha256:'missing'}),false);
});
test('language wire extends SAME sequenced session envelope, no ACK grant/file-write messages',()=>{
  const open={protocolVersion:'3.0',messageId:'m1',clientId:'c1',sessionId:'s1',type:'LANGUAGE_OPEN',payload:{stamp:stamp(),content:'print(1)',reason:'OPEN'}};
  assert.equal(v.validateLanguageClientMessage(open),true);
  assert.equal(v.validateV2WireShape('ClientMessage',open),true);
  assert.equal(v.validateLanguageClientMessage({...open,sessionId:'foreign'}),false);
  assert.equal(v.validateLanguageClientMessage({...open,type:'LANGUAGE_CHANGE'}),false);
  assert.equal(v.validateLanguageClientMessage({...open,type:'LANGUAGE_ACK'}),false);
  assert.equal(v.validateLanguageClientMessage({...open,type:'LANGUAGE_FILE_OPERATION'}),false);
  assert.equal(v.validateLanguageClientMessage({...open,payload:{...open.payload,verifiedSaveReceiptId:'forged'}}),false);
  const result={protocolVersion:'3.0',messageId:'m2',sessionId:'s1',seq:1,type:'COMPLETE_RESULT',payload:{requestId:'r1',stamp:stamp(),items:[item()],isIncomplete:false}};
  assert.equal(v.validateLanguageServerMessage(result),true);
  assert.equal(v.validateV2WireShape('ServerMessage',result),true);
  assert.equal(v.validateLanguageServerMessage({...result,seq:0}),false);
  assert.equal(v.validateLanguageServerMessage({...result,serverSeq:1}),false);
  assert.equal(v.validateLanguageServerMessage({...result,sessionId:'foreign'}),false);
});
test('strict safe plain completion projection: command/data/resolve/snippets/unknown edit actions rejected at every level',()=>{
  assert.equal(v.validateCompletionItem(item()),true);
  for(const key of ['command','data','resolve','insertTextFormat','insertText','documentation','textEdit','workspaceEdit'])
    assert.equal(v.validateCompletionItem({...item(),[key]:key==='command'?{command:'evil'}:'evil'}),false,key);
  for(const key of ['command','data','uri','newText']) assert.equal(v.validateCompletionItem({...item(),primary:{...item().primary,[key]:'evil'}}),false,key);
  assert.equal(v.validateCompletionItem({...item(),primary:{...item().primary,range:{...item().primary.range,command:'evil'}}}),false);
  const r={requestId:'r1',stamp:stamp(),items:[item()],isIncomplete:false};
  assert.equal(v.validateCompleteResult(r),true);
  assert.equal(v.validateCompleteResult({...r,items:[{...item(),additionalTextEdits:[{...item().primary,path:'other.py'}]}]}),false);
  assert.equal(v.validateCompleteResult({...r,items:[item(),item()]}),false);
  assert.equal(v.validateCompleteResult({...r,items:Array.from({length:101},(_,i)=>({...item(),id:`i${i}`}))}),false);
  assert.equal(v.validateCompletionItem({...item(),primary:{...item().primary,text:'😀'.repeat(2049)}}),false,'UTF16 not code points');
});
test('wire response256KiB + single4096UTF16 + total64KiB edits are real bounds, not JSON schema code-point approximation',()=>{
  const full={...item(),primary:{...item().primary,text:'x'.repeat(4096)}};
  assert.equal(v.validateCompletionItem(full),true);
  assert.equal(v.validateCompletionItem({...full,additionalTextEdits:Array.from({length:15},(_,i)=>({...full.primary,range:{startLine:i+2,startColumn:1,endLine:i+2,endColumn:1}}))}),true,'exact64KiB');
  assert.equal(v.validateCompleteResult({requestId:'r',stamp:stamp(),items:Array.from({length:100},(_,i)=>({...item(),id:`i${i}`})),isIncomplete:false}),true);
  assert.equal(v.validateDiagnosticsResult({...diagnostics(),items:Array.from({length:500},()=>({range:item().primary.range,severity:'ERROR',message:'x',code:null}))}),true);
  assert.equal(v.validateCompletionItem({...full,additionalTextEdits:Array.from({length:16},(_,i)=>({...full.primary,range:{startLine:i+2,startColumn:1,endLine:i+2,endColumn:1}}))}),false);
  assert.equal(v.validateCompleteResult({requestId:'r',stamp:stamp(),items:Array.from({length:64},(_,i)=>({...full,id:`i${i}`})),isIncomplete:false}),false);
  assert.equal(v.validateDiagnosticsResult({...diagnostics(),items:Array.from({length:500},()=>({range:item().primary.range,severity:'ERROR',message:'x'.repeat(4096),code:null}))}),false);
  assert.equal(v.validateDiagnosticsResult({...diagnostics(),items:Array.from({length:501},()=>({range:item().primary.range,severity:'ERROR',message:'x',code:null}))}),false);
  assert.equal(v.validateOpenOrChange({stamp:stamp(),reason:'TYPING',content:'😀'.repeat(524289)}),false);
});
test('atomic edits validate actual UTF16 lines, no surrogate split, out of bounds, reversal, overlap or multiple insertion order',()=>{
  const content='a😀b\nZażółć';
  const edit=(startLine:number,startColumn:number,endLine:number,endColumn:number)=>({...item().primary,range:{startLine,startColumn,endLine,endColumn}});
  assert.equal(v.validateCompletionEdits({...item(),primary:edit(1,2,1,4)},stamp(),content),true,'whole astral symbol');
  for(const primary of [edit(1,3,1,4),edit(1,2,1,3),edit(1,5,1,2),edit(3,1,3,1),edit(1,6,1,6)])
    assert.equal(v.validateCompletionEdits({...item(),primary},stamp(),content),false);
  assert.equal(v.validateCompletionEdits({...item(),primary:edit(1,1,1,5),additionalTextEdits:[edit(1,2,1,4)]},stamp(),content),false);
  assert.equal(v.validateCompletionEdits({...item(),additionalTextEdits:[item().primary]},stamp(),content),false);
  assert.equal(v.validateCompletionEdits({...item(),primary:edit(1,1,1,2),additionalTextEdits:[edit(1,2,1,4)]},stamp(),content),true,'adjacent nonempty edits');
  assert.equal(v.validateCompletionEdits({...item(),additionalTextEdits:[{...item().primary,path:'other.py'}]},stamp(),content),false);
});
test('diagnostic provenance is explicit; mutable unversioned/unknown/extra or unsafe stamps rejected',()=>{
  assert.equal(v.validateDiagnosticsResult(diagnostics()),true);
  for(const provenance of [{kind:'UNVERSIONED_PUSH'},{kind:'VERSIONED_PUSH',lspVersion:null,inputManifestSha256:hash},
    {kind:'PULL',requestId:'r1'}, {...diagnostics().provenance,lspVersion:0}, {...diagnostics().provenance,receivedAt:'now'}])
    assert.equal(v.validateDiagnosticsResult({...diagnostics(),provenance}),false);
  assert.equal(v.validateDiagnosticsResult({...diagnostics(),stamp:stamp()}),false,'no obsolete stamp-only envelope');
  assert.equal(v.validateDiagnosticsResult({...diagnostics(),items:[{range:item().primary.range,severity:'ERROR',message:'x',code:null,command:'bad'}]}),false);
});
test('immutable source vs presentation ACK-only association; all non-ACK identity changes and no-link rebind rejected',()=>{
  const d=diagnostics();const next={...stamp(),baseDocumentVersion:2,documentVersion:2,requestGeneration:2};
  const linked={...d,presentationStamp:next,association:{saveReceiptId:'save1'}};
  assert.equal(v.validateDiagnosticsResult(linked),true,'link syntax only, NOT authority');
  assert.equal(v.validateDiagnosticsResult({...linked,presentationStamp:{...next,requestGeneration:1}}),true,'ACK need not change request generation');
  assert.equal(v.validateDiagnosticsResult({...linked,association:null}),false);
  assert.equal(v.validateDiagnosticsResult({...d,association:{saveReceiptId:'save1'}}),false);
  for(const key of ['projectId','sessionId','path','profileId','connectionGeneration','configurationGeneration','providerGeneration','shadowGeneration','modelLifetime','contentSha256'])
    assert.equal(v.validateDiagnosticsResult({...linked,presentationStamp:{...next,[key]:key==='contentSha256'?'b'.repeat(64):'changed'}}),false,key);
  for(const key of ['localModelVersion','controlEpoch'] as const) assert.equal(v.validateDiagnosticsResult({...linked,presentationStamp:{...next,[key]:next[key]+1}}),false,key);
  assert.equal(v.validateDiagnosticsResult({...linked,presentationStamp:{...next,requestGeneration:0}}),false);
  assert.equal(v.validateDiagnosticsResult({...linked,presentationStamp:{...next,baseDocumentVersion:1,documentVersion:1}}),false);
  assert.equal(v.matchesAnalysisSource(linked,{sourceStamp:d.sourceStamp,provenance:d.provenance}),true);
  assert.equal(v.matchesAnalysisSource({...linked,sourceStamp:{...d.sourceStamp,shadowGeneration:'old'}},{sourceStamp:d.sourceStamp,provenance:d.provenance}),false);
  assert.equal(v.matchesAnalysisSource({...d,provenance:{...d.provenance,inputManifestSha256:'b'.repeat(64)}},d),false,'launch/dependencies cannot be rebound by receipt time');
  assert.equal(v.matchesAnalysisSource({...d,provenance:{...d.provenance,lspVersion:99}},d),false,'future/old versions must match exact launch ledger');
});
test('status/actionable FAILED does not imply typing disabled; Docs N/A and no NOT_INSTALLED fallback',()=>{
  const status={projectId:'p',profileId:'python-3.13',configurationGeneration:'cfg',providerGeneration:'gen',state:'INDEXING',autocomplete:'INDEXING',docs:'N/A',problem:null};
  assert.equal(v.validateLanguageView(status),true);
  assert.equal(v.validateLanguageView({...status,state:'FAILED'}),false);
  assert.equal(v.validateLanguageView({...status,docs:'ON'}),false);
  assert.equal(v.validateLanguageView({...status,state:'NOT_INSTALLED'}),false);
});

test('authorized internal file-operation feed remains closed, bounded and separate from client wire',()=>{
  assert.equal(v.validateLanguageFileOperation({kind:'CREATE',path:'new.py',content:'print(1)'}),true);
  assert.equal(v.validateLanguageFileOperation({kind:'RENAME',path:'old.py',newPath:'new.py'}),true);
  assert.equal(v.validateLanguageFileOperation({kind:'DELETE',path:'old.py'}),true);
  assert.equal(v.validateLanguageFileOperation({kind:'RENAME',path:'old.py',newPath:'old.py'}),false);
  assert.equal(v.validateLanguageFileOperation({kind:'DELETE',path:'old.py',command:'rm'}),false);
});
