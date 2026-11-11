/** UNIT composition with structural model inputs; not a browser/service/native proof. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { RuntimeWiringV2, type WiringControllerV2 } from '../../src/services/runtimeWiringV2';
import { contentSha256 } from '../../src/language/uriCodec';
import type { DocumentStamp, CompleteResult } from '../../src/shared/language-v2';
import type { EditorLanguageBinding, ModelSnapshot } from '../../src/services/monacoLspBridge';
function fixture(t:any){
 const c:WiringControllerV2={projectId:'p1',sessionId:'s1',clientId:'c1',connectionGeneration:'transport1',connected:true,synced:true,writeOwner:'STUDENT',controlEpoch:0,preparing:false,vetoPending:false,
  language:{projectId:'p1',sessionId:'s1',profileId:'profile',connectionGeneration:'server1',configurationGeneration:'cfg1',providerGeneration:'provider1',shadowGeneration:'shadow1',provider:'remote'},document:()=>({content:'draft',version:1,readOnly:false,conflict:false})};
 const sent:any[]=[],problems:string[]=[];
 const w=new RuntimeWiringV2({current:()=>c,messageId:()=>crypto.randomUUID(),send:m=>sent.push(m),problem:m=>problems.push(m),status:()=>{},runtime:{current:()=>null,requestId:()=>crypto.randomUUID(),http:{run:async()=>null,stop:async()=>null,saveSettings:async()=>null}}});t.after(()=>w.invalidate('DISCONNECTED'));
 const model=(lifetime:string,content='draft'):ModelSnapshot=>({path:'main.txt',modelLifetime:lifetime,localModelVersion:1,content,contentSha256:contentSha256(content)});
 const document=(binding:EditorLanguageBinding,m:ModelSnapshot)=>{const a=binding.readAuthority(m);assert.ok(a);return {stamp:{...a.stamp,path:m.path,modelLifetime:m.modelLifetime,localModelVersion:m.localModelVersion,contentSha256:m.contentSha256},content:m.content,reason:'OPEN' as const};};
 const switchTo=(projectId:string,sessionId:string,connection:string)=>{w.invalidate('DISCONNECTED');Object.assign(c,{projectId,sessionId,connectionGeneration:'transport-'+connection});Object.assign(c.language!,{projectId,sessionId,connectionGeneration:'server-'+connection,shadowGeneration:'shadow-'+connection});w.authoritativeState(0);return w.getBinding(projectId);};
 let seq=0;const result=(stamp:DocumentStamp,requestId:string):CompleteResult=>({stamp,requestId,items:[],isIncomplete:false});
 const reply=(r:CompleteResult)=>w.receive({protocolVersion:'3.0',messageId:crypto.randomUUID(),sessionId:c.sessionId,seq:++seq,type:'COMPLETE_RESULT',payload:r});
 return {c,w,sent,problems,model,document,switchTo,result,reply};
}
for(const change of ['project','session','reconnect'] as const){
 test(`retired ${change} binding cannot read/send/complete/verify/builtin/report or observe new lifecycle`,async t=>{
  const f=fixture(t),old=f.w.getBinding('p1'),m=f.model('old','PRIVATE_OLD_PROJECT_DRAFT'),oldDoc=f.document(old,m);
  old.sendDocument('OPEN',oldDoc);const oldEvents:string[]=[];old.subscribe(e=>oldEvents.push(e.type));
  const binding=f.switchTo(change==='project'?'p2':'p1',change==='session'||change==='project'?'s2':'s1','new');
  assert.notEqual(binding,old);assert.equal(oldEvents.at(-1),'DISCONNECTED');const boundary=oldEvents.length;
  const current=f.model('new'),d=f.document(binding,current);binding.sendDocument('OPEN',d);
  const diagnostics={sourceStamp:d.stamp,presentationStamp:d.stamp,association:null,provenance:{kind:'IMMUTABLE_GENERATION' as const,launchId:'launch',lspVersion:null,inputManifestSha256:contentSha256('input')},items:[],truncated:false};
  assert.equal(binding.verifyDiagnostics(diagnostics,[current]),true);
  const count=f.sent.length;assert.equal(old.readAuthority(m),null);
  old.sendDocument('OPEN',{...d,content:m.content});old.sendDocument('CHANGE',oldDoc);old.sendDocument('CLOSE',d);
  assert.equal(old.verifyDiagnostics(diagnostics,[current]),false);old.onProblem?.('old problem');assert.deepEqual(f.problems,[]);
  await assert.rejects(old.complete({requestId:'retired-request',stamp:d.stamp,position:{line:1,column:1},trigger:null},new AbortController().signal));
  let builtinCalls=0;f.c.language!.provider='builtin';f.w.setBuiltin(async(_m,r)=>{builtinCalls++;return f.result(r.stamp,r.requestId);});
  assert.equal(old.builtin?.({} as any,{requestId:'retired-builtin',stamp:d.stamp,position:{line:1,column:1},trigger:null},new AbortController().signal),null);assert.equal(builtinCalls,0);f.c.language!.provider='remote';
  const lateEvents:string[]=[];const unsubscribe=old.subscribe(e=>lateEvents.push(e.type));f.w.authoritativeState(1);unsubscribe();
  assert.equal(oldEvents.length,boundary);assert.deepEqual(lateEvents,[]);assert.equal(f.sent.length,count);
  assert.equal(binding.verifyDiagnostics(diagnostics,[current]),true,'old CLOSE did not erase new model/ledger');
 });
 test(`retired ${change} CLOSE/cancel cannot erase new same-path lifetime or cancel its pending completion`,async t=>{
  const f=fixture(t),old=f.w.getBinding('p1'),oldDoc=f.document(old,f.model('old'));old.sendDocument('OPEN',oldDoc);
  const binding=f.switchTo(change==='project'?'p2':'p1',change==='session'||change==='project'?'s2':'s1','new');
  const d=f.document(binding,f.model('new'));binding.sendDocument('OPEN',d);
  const request={requestId:'current-request',stamp:d.stamp,position:{line:1,column:1},trigger:null};
  const pending=binding.complete(request,new AbortController().signal);pending.catch(()=>{});assert.equal(f.sent.at(-1).type,'LANGUAGE_COMPLETE');const count=f.sent.length;
  old.cancel({requestId:request.requestId,stamp:d.stamp});old.sendDocument('CLOSE',d);old.sendDocument('CLOSE',oldDoc);
  assert.equal(f.sent.length,count);assert.equal(f.reply(f.result(d.stamp,request.requestId)),true);
  assert.deepEqual(await pending,f.result(d.stamp,request.requestId));
 });
}
test('return to original project never resurrects its retired binding; current binding remains stable within scope',t=>{
 const f=fixture(t),old=f.w.getBinding('p1');f.document(old,f.model('private','PRIVATE_OLD_PROJECT_DRAFT'));
 f.switchTo('p2','s2','second');const current=f.switchTo('p1','s3','third');
 assert.notEqual(current,old);assert.equal(f.w.getBinding('p1'),current);assert.equal(old.readAuthority(f.model('private')),null);
 assert.ok(current.readAuthority(f.model('fresh')));
});
test('late builtin result is rejected after its binding retires; no effects on new completion',async t=>{
 const f=fixture(t);f.c.language!.provider='builtin';const old=f.w.getBinding('p1'),d=f.document(old,f.model('old'));
 let resolve!:(v:CompleteResult)=>void;const gate=new Promise<CompleteResult>(r=>resolve=r);f.w.setBuiltin(()=>gate);
 const pending=old.builtin!({} as any,{requestId:'builtin',stamp:d.stamp,position:{line:1,column:1},trigger:null},new AbortController().signal)!;
 const rejected=assert.rejects(pending);const current=f.switchTo('p2','s2','new');f.document(current,f.model('new'));
 resolve(f.result(d.stamp,'builtin'));await rejected;assert.equal(old.readAuthority(f.model('old')),null);
});

test('authoritative project switch retires old capability even if React skips intermediate getBinding (ABA)',t=>{
 const f=fixture(t),old=f.w.getBinding('p1');f.document(old,f.model('old'));
 f.w.invalidate('SCOPE');f.c.projectId='p2';f.c.language!.projectId='p2';f.w.authoritativeState(0);
 f.w.invalidate('SCOPE');f.c.projectId='p1';f.c.language!.projectId='p1';f.w.authoritativeState(0);
 assert.equal(old.readAuthority(f.model('old','PRIVATE_OLD_PROJECT_DRAFT')),null);assert.notEqual(f.w.getBinding('p1'),old);
});
test('current capability rejects old same-path CLOSE lifetime and unrelated cancel request id',async t=>{
 const f=fixture(t),binding=f.w.getBinding('p1'),old=f.document(binding,f.model('old'));binding.sendDocument('OPEN',old);
 const current=f.document(binding,f.model('new'));binding.sendDocument('OPEN',current);
 const request={requestId:'current',stamp:current.stamp,position:{line:1,column:1},trigger:null};
 const pending=binding.complete(request,new AbortController().signal);pending.catch(()=>{});const count=f.sent.length;
 binding.sendDocument('CLOSE',old);binding.cancel({requestId:'retired-request',stamp:current.stamp});assert.equal(f.sent.length,count);
 assert.equal(f.reply(f.result(current.stamp,request.requestId)),true);await pending;
});
