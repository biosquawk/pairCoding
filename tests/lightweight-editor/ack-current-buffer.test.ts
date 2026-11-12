/** Structural composition tests. Not browser/real worker/HTTP proof. */
import test from 'node:test';
import {setImmediate} from 'node:timers/promises';
import assert from 'node:assert/strict';
import { RuntimeWiringV2, type WiringControllerV2 } from '../../src/services/runtimeWiringV2';
import { MonacoLspBridge } from '../../src/services/monacoLspBridge';
import { harness } from '../editor-language/harness';
import { result } from '../editor-language/fixtures';
function setup(t:any) {
  const h=harness();h.bridge.dispose();
  const docs=new Map(h.models.map(m=>[m.path,{content:m.content,version:1,readOnly:false,conflict:false}]));
  const c:WiringControllerV2={projectId:'projekt',sessionId:'s1',clientId:'c1',connectionGeneration:'transport',connected:true,synced:true,writeOwner:'STUDENT',controlEpoch:0,preparing:false,vetoPending:false,
    language:{projectId:'projekt',sessionId:'s1',profileId:'profile',connectionGeneration:'local',configurationGeneration:'cfg',providerGeneration:'builtin',shadowGeneration:'opaque-lifetime',provider:'builtin',features:{completion:true,diagnostics:true}},document:p=>docs.get(p)??null};
  const sent:any[]=[],status:any[]=[],problems:string[]=[];let calls=0;
  const wiring=new RuntimeWiringV2({current:()=>c,messageId:()=>crypto.randomUUID(),send:m=>sent.push(m),problem:m=>problems.push(m),status:()=>{},localStatus:(...args)=>status.push(args),runtime:{current:()=>null,requestId:()=>crypto.randomUUID(),http:{run:async()=>null,stop:async()=>null,saveSettings:async()=>null}}});
  const provider=Object.assign(async(_m:any,r:any)=>{calls++;return result(r.stamp,r.requestId);},{ready:async()=>true,hasDiagnostics:()=>false,diagnostics:async()=>null});
  wiring.setBuiltin(provider);
  const binding=wiring.getBinding('projekt'),bridge=new MonacoLspBridge(h.monaco,h.editor,binding);
  t.after(()=>{bridge.dispose();wiring.invalidate('DISCONNECTED');});
  const shown=()=>h.widgets[0].getDomNode().children;
  return {h,c,docs,sent,status,problems,wiring,bridge,binding,provider,shown,get calls(){return calls;}};
}

const ownAck=(f:ReturnType<typeof setup>,overrides:Record<string,unknown>={})=>f.wiring.ackTransition({messageId:'reply',sessionId:f.c.sessionId,replyTo:'verified-save-flight',status:'OK',documentVersion:f.docs.get(f.h.primary.path)!.version,workspaceVersion:2,controlEpoch:f.c.controlEpoch,...overrides} as any);

test('verified own ACK during local provider flight requests a FRESH same-buffer result, never rebinds old result',async t=>{
 const f=setup(t);const requests:any[]=[];let release!:()=>void;
 f.wiring.setBuiltin(async(_m,r)=>{requests.push(r);if(requests.length===1)return new Promise(resolve=>{release=()=>resolve(result(r.stamp,r.requestId));});return result(r.stamp,r.requestId);});
 f.h.primary.change('obj.');await Promise.resolve();
 assert.equal(requests.length,1);const first=requests[0];
 f.docs.get(f.h.primary.path)!.content='obj.';f.docs.get(f.h.primary.path)!.version=2;
 ownAck(f);await setImmediate();
 assert.equal(requests.length,2,'ACK must replace the invalidated current-buffer request, not silently lose it');
 assert.notEqual(requests[1].requestId,first.requestId);assert.notEqual(requests[1].stamp.requestGeneration,first.stamp.requestGeneration);
 assert.equal(requests[1].stamp.documentVersion,2);assert.equal(f.shown().length,1);
 release();await setImmediate();assert.equal(f.shown().length,1);assert.equal(f.h.primary.pushes,0);
 f.h.key(3);assert.equal(f.h.primary.content,'obj.method()');assert.equal(f.h.primary.pushes,1);assert.deepEqual(f.sent,[]);
});
test('ACK while list is visible retires captured old candidate and presents only fresh request',async t=>{
 const f=setup(t);await f.bridge.requestCompletion(null);const old=f.shown()[0],calls=f.calls;
 f.docs.get(f.h.primary.path)!.version=2;ownAck(f);await setImmediate();
 assert.equal(f.calls,calls+1);assert.equal(f.shown().length,1);old.onmousedown({preventDefault(){}});assert.equal(f.h.primary.pushes,0);
 f.h.key(2);assert.equal(f.h.primary.pushes,1);assert.deepEqual(f.sent,[]);
});
test('ACK never refreshes after cursor cancellation, Escape, scope change or loss of write authority',async t=>{
 for(const reason of ['cursor','escape','veto','prepare','scope','disconnect','config','readOnly','conflict','model','inactive-file'] as const){
  const f=setup(t);await f.bridge.requestCompletion(null);const old=f.shown()[0];
  if(reason==='cursor')f.h.position={lineNumber:1,column:4};
  if(reason==='escape')f.h.key(9);
  if(reason==='veto')f.wiring.invalidate('VETO');
  if(reason==='prepare')f.wiring.invalidate('CONTROL_PREPARE');
  if(reason==='scope'){f.wiring.invalidate('SCOPE');f.c.language!.configurationGeneration='different';}
  if(reason==='disconnect')f.wiring.invalidate('DISCONNECTED');
  if(reason==='config')f.c.language!.features={completion:false,diagnostics:true};
  if(reason==='readOnly')f.docs.get(f.h.primary.path)!.readOnly=true;
  if(reason==='conflict')f.docs.get(f.h.primary.path)!.conflict=true;
  if(reason==='model')f.h.primary.change('other buffer');
  if(reason==='inactive-file'){f.wiring.sourceChanged();f.h.inactive.change('dependency');}
  const calls=f.calls;f.docs.get(f.h.primary.path)!.version=2;ownAck(f);await setImmediate();
  assert.equal(f.calls,calls,reason);assert.equal(f.shown().length,0,reason);old.onmousedown({preventDefault(){}});assert.equal(f.h.primary.pushes,0,reason);
 }
});

test('back-to-back own ACKs retire each prior flight; Escape still cancels the last replacement',async t=>{
 const f=setup(t);const requests:any[]=[];const releases:(()=>void)[]=[];
 f.wiring.setBuiltin(async(_m,r)=>new Promise(resolve=>{requests.push(r);releases.push(()=>resolve(result(r.stamp,r.requestId)));}));
 const initial=f.bridge.requestCompletion(null);
 f.docs.get(f.h.primary.path)!.version=2;ownAck(f);
 f.docs.get(f.h.primary.path)!.version=3;ownAck(f);
 assert.equal(requests.length,3);assert.equal(new Set(requests.map(r=>r.requestId)).size,3);
 f.h.key(9);releases.forEach(release=>release());await initial;await setImmediate();
 assert.equal(f.shown().length,0);assert.equal(f.h.primary.pushes,0);assert.deepEqual(f.sent,[]);
});

test('ACK replacement preserves every scope/control identity and never becomes a blanket authority refresh',async t=>{
 for(const field of ['projectId','sessionId','profileId','connectionGeneration','configurationGeneration','providerGeneration','shadowGeneration','controlEpoch'] as const){
  const h=harness();t.after(()=>h.bridge.dispose());await h.bridge.requestCompletion(null);const old=h.widgets[0].getDomNode().children[0],calls=h.requests.length;
  h.authorityStamp={...h.authorityStamp,[field]:field==='controlEpoch'?1:'different'};h.revision++;h.emit({type:'AUTOSAVE_ACK'});await setImmediate();
  assert.equal(h.requests.length,calls,field);assert.equal(h.widgets[0].getDomNode().children.length,0,field);old.onmousedown({preventDefault(){}});assert.equal(h.primary.pushes,0,field);
 }
});

test('rejected, missing and foreign-scope ACKs can retire but never refresh an active local intent',async t=>{
 for(const bad of [{status:'REJECTED',documentVersion:null},{sessionId:'foreign'},{controlEpoch:5},{documentVersion:0},{documentVersion:null}]){
  const f=setup(t);await f.bridge.requestCompletion(null);const calls=f.calls;ownAck(f,bad);await setImmediate();assert.equal(f.calls,calls);assert.equal(f.shown().length,0);assert.equal(f.h.primary.pushes,0);
 }
 const f=setup(t);await f.bridge.requestCompletion(null);const calls=f.calls;f.wiring.ackTransition();await setImmediate();assert.equal(f.calls,calls);assert.equal(f.shown().length,0);
});
