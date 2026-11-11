import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LanguageClientV2 } from '../../src/services/LanguageClientV2';
import { authority, diagnostics, hash, stamp } from './fixtures';
import type { LanguageClientMessage, LanguageServerPayloads } from '../../src/shared/language-v2';
function fixture() {
  let current = authority(), identity = {sessionId:'s1',clientId:'client1',connectionGeneration:'conn1'}, proof = true, n=0;
  const sent: LanguageClientMessage[] = [], events: any[] = [], order: string[] = [];
  const client = new LanguageClientV2({ identity:()=>identity,current:()=>current,contentSha256:hash,
    verifyDiagnostics:()=>proof,messageId:()=>`msg${++n}`,send:m=>{order.push(m.type);sent.push(m);},invalidate:r=>order.push(`invalidate:${r}`) });
  client.subscribe(e=>events.push(e));
  const open = () => client.open({stamp:current.stamp,content:current.content,reason:'OPEN'});
  const complete = (requestId='req1') => client.complete({requestId,stamp:current.stamp,position:{line:1,column:6},trigger:'.'});
  const message = <K extends keyof LanguageServerPayloads>(type:K,payload:LanguageServerPayloads[K],seq=1) => ({protocolVersion:'3.0',messageId:`server${seq}`,sessionId:'s1',seq,type,payload});
  return {client,sent,events,order,open,complete,message,get current(){return current;},set current(v){current=v;},get identity(){return identity;},set identity(v){identity=v;},set proof(v:boolean){proof=v;}};
}
test('ordered authenticated injection, captured completion, one-shot duplicate/late drops',()=>{
  const f=fixture(); assert.equal(f.open(),true); assert.equal(f.complete(),true);
  const result={requestId:'req1',stamp:stamp(),items:[],isIncomplete:false};
  assert.equal(f.client.receive(f.message('COMPLETE_RESULT',result)),true);
  assert.equal(f.client.receive(f.message('COMPLETE_RESULT',result,2)),false);
  assert.equal(f.events.filter(e=>e.type==='completion').length,1);
  assert.equal(f.sent.filter(m=>m.type==='LANGUAGE_COMPLETE').length,1);
});
test('CONTROL_PREPARE invalidates widget synchronously before cancellation and denied prepare never reopens',()=>{
  const f=fixture();f.open();f.complete();f.order.length=0;
  f.client.invalidate('CONTROL_PREPARE');
  assert.deepEqual(f.order,['invalidate:CONTROL_PREPARE','LANGUAGE_CANCEL']);
  assert.equal(f.client.receive(f.message('COMPLETE_RESULT',{requestId:'req1',stamp:stamp(),items:[],isIncomplete:false})),false);
  assert.equal(f.client.receive(f.message('DIAGNOSTICS',diagnostics(),2)),false);
});
test('actual bytes, all generations and session/permission changes fence old completion',()=>{
  for(const mutate of [
    (a:any)=>a.content='changed', (a:any)=>a.stamp.modelLifetime='life2', (a:any)=>a.stamp.shadowGeneration='shadow2',
    (a:any)=>a.stamp.providerGeneration='provider2', (a:any)=>a.stamp.controlEpoch++, (a:any)=>a.stamp.requestGeneration++,
    (a:any)=>a.controlPrepare=true,(a:any)=>a.writeOwner='COACH',(a:any)=>a.vetoPending=true,(a:any)=>a.conflict=true,(a:any)=>a.readOnly=true,(a:any)=>a.connected=false,
  ]) { const f=fixture();f.open();f.complete();mutate(f.current);
    assert.equal(f.client.receive(f.message('COMPLETE_RESULT',{requestId:'req1',stamp:stamp(),items:[],isIncomplete:false})),false);
  }
});
test('strict bounds reject unknown actions, oversized response, wrong scope, raw command and unsafe edits',()=>{
  const f=fixture(); f.open();f.complete();
  const m=f.message('COMPLETE_RESULT',{requestId:'req1',stamp:stamp(),items:[],isIncomplete:false});
  assert.equal(f.client.receive({...m,sessionId:'s2'}),false);
  assert.equal(f.client.receive({...m,extra:true}),false);
  assert.equal(f.client.receive({...m,payload:{...m.payload,items:[{id:'i',label:'x',detail:null,command:{command:'oops'},primary:{path:stamp().path,range:{startLine:1,startColumn:1,endLine:1,endColumn:1},text:'x'},additionalTextEdits:[]}]}}),false);
  assert.equal(f.client.receive({...m,payload:{...m.payload,items:[],padding:'x'.repeat(270000)}}),false);
  assert.equal(f.client.receive(m),true); // malformed messages cannot consume sequence
});
test('source/provenance unchanged, empty diagnostic clear delivered, trusted ACK association required',()=>{
  const f=fixture();f.open(); const original=diagnostics();
  assert.equal(f.client.receive(f.message('DIAGNOSTICS',original)),true);
  f.current.stamp={...f.current.stamp,baseDocumentVersion:2,documentVersion:2,requestGeneration:2};
  f.client.invalidate('ACK_TRANSITION');
  const alias={...original,presentationStamp:{...f.current.stamp},association:{saveReceiptId:'receipt1'}};
  f.proof=false; assert.equal(f.client.receive(f.message('DIAGNOSTICS',alias,2)),false);
  f.proof=true; assert.equal(f.client.receive(f.message('DIAGNOSTICS',alias,3)),true);
  assert.deepEqual(f.events.at(-1).result.sourceStamp,original.sourceStamp);
  assert.deepEqual(f.events.at(-1).result.provenance,original.provenance);
  assert.equal(f.client.receive(f.message('DIAGNOSTICS',original,4)),false);
  assert.equal(f.client.receive(f.message('COMPLETE_RESULT',{requestId:'req1',stamp:stamp(),items:[],isIncomplete:false},5)),false);
});
test('reconnect resets transport sequence but never replays stale mutation/request; close/dispose drop',()=>{
  const f=fixture(); f.open();f.complete(); const old=stamp();
  f.identity={...f.identity,connectionGeneration:'conn2'};f.current.stamp.connectionGeneration='conn2';
  assert.equal(f.client.receive(f.message('DIAGNOSTICS',diagnostics())),false);
  assert.equal(f.open(),true);assert.equal(f.sent.filter(m=>m.type==='LANGUAGE_COMPLETE').length,1);
  assert.equal(f.client.close(f.current.stamp),true);
  assert.equal(f.client.receive(f.message('DIAGNOSTICS',{...diagnostics(),sourceStamp:f.current.stamp,presentationStamp:f.current.stamp},2)),false);
  f.client.dispose();assert.equal(f.open(),false);assert.equal(f.client.complete({requestId:'r2',stamp:old,position:{line:1,column:1},trigger:null}),false);
});
test('all model change causes use ordered open/change only; content or reason mismatch rejected',()=>{
  const f=fixture();f.open();
  for (const reason of ['TYPING','COMPLETION','UNDO','REDO','COACH_STEP_EDIT','EXTERNAL_FILE_SYNC','RESTORE_SNAPSHOT','DRAFT_RECOVERY'] as const) {
    f.current.content+=reason; f.current.stamp={...f.current.stamp,contentSha256:hash(f.current.content),localModelVersion:f.current.stamp.localModelVersion+1,requestGeneration:f.current.stamp.requestGeneration+1};
    assert.equal(f.client.change({stamp:f.current.stamp,content:f.current.content,reason}),true);
  }
  assert.equal(f.client.change({stamp:f.current.stamp,content:'different',reason:'TYPING'}),false);
  assert.equal(f.client.change({stamp:f.current.stamp,content:f.current.content,reason:'OPEN'}),false);
  assert.equal(f.sent.some(m=>!/^(LANGUAGE_OPEN|LANGUAGE_CHANGE)$/.test(m.type)),false);
});
test('subscriber cannot mutate stored request/result, status scoped to active full authority',()=>{
  const f=fixture();f.open();const view={projectId:'p1',profileId:'profile1',configurationGeneration:'cfg1',providerGeneration:'provider1',state:'ON' as const,autocomplete:'ON' as const,docs:'N/A' as const,problem:null};
  assert.equal(f.client.receive(f.message('LANGUAGE_STATUS',view)),true);
  assert.equal(f.client.receive(f.message('LANGUAGE_STATUS',{...view,providerGeneration:'stale'},2)),false);
  f.client.subscribe(e=>{if(e.type==='completion') e.result.stamp.contentSha256='bad';});f.complete();
  const r={requestId:'req1',stamp:stamp(),items:[],isIncomplete:false}; assert.equal(f.client.receive(f.message('COMPLETE_RESULT',r,3)),true); assert.equal(r.stamp.contentSha256,hash('hello'));
});
test('cancelled/completed request IDs cannot be reused in same connection; all source identities remain distinct',()=>{
  const f=fixture();f.open();f.complete();f.client.cancel();assert.equal(f.complete(),false);
  assert.equal(f.complete('req2'),true);const captured=stamp();f.current.stamp.localModelVersion++;
  assert.equal(f.client.receive(f.message('COMPLETE_RESULT',{requestId:'req2',stamp:captured,items:[],isIncomplete:false})),false);
  assert.equal(f.events.filter(e=>e.type==='completion').length,0);
});
