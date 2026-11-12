/** Structural composition tests. Not browser/real worker/HTTP proof. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { RuntimeWiringV2, type WiringControllerV2 } from '../../src/services/runtimeWiringV2';
import { MonacoLspBridge } from '../../src/services/monacoLspBridge';
import { harness,Model } from '../editor-language/harness';
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
test('local current dirty buffer accepts one Undo unit before ACK; zero remote frames on change/Undo/dispose',async t=>{
  const f=setup(t);f.h.primary.change('obj.');await Promise.resolve();await f.bridge.requestCompletion(null);
  assert.equal(f.shown().length,1);const before=f.h.primary.version;f.h.key(3);
  assert.equal(f.h.primary.content,'obj.method()');assert.equal(f.h.primary.pushes,1);assert.equal(f.h.primary.boundaries,2);
  f.h.primary.undo();assert.equal(f.h.primary.content,'obj.');assert.ok(f.h.primary.version>before);
  f.h.inactive.change('changed dependency');f.bridge.dispose();assert.deepEqual(f.sent,[]);
});
test('CONTROL_PREPARE closes immediately and Enter+Tab/captured click mutate zero; denied same epoch cannot reopen',async t=>{
  const f=setup(t);await f.bridge.requestCompletion(null);const old=f.shown()[0];assert.ok(old);
  f.wiring.invalidate('CONTROL_PREPARE');assert.equal(f.shown().length,0);f.h.key(3);f.h.key(2);old.onmousedown({preventDefault(){}});
  assert.equal(f.h.primary.pushes,0);f.wiring.authoritativeState(0);await f.bridge.requestCompletion(null);assert.equal(f.shown().length,0);
  f.c.controlEpoch=1;f.wiring.authoritativeState(1);await f.bridge.requestCompletion(null);assert.equal(f.shown().length,1);assert.deepEqual(f.sent,[]);
});
test('late worker after veto/scope/change/lifetime never reopens list; no ACK or remote cancel needed',async t=>{
  for(const event of ['VETO','SCOPE','DISCONNECTED'] as const){
    const f=setup(t);let release!:(r:any)=>void;
    f.wiring.setBuiltin(async(_m,r)=>new Promise(resolve=>{release=()=>resolve(result(r.stamp,r.requestId));}));
    const request=f.bridge.requestCompletion(null);f.wiring.invalidate(event);release(null);await request;
    assert.equal(f.shown().length,0);assert.equal(f.h.primary.pushes,0);assert.deepEqual(f.sent,[]);
  }
});
test('every live authority flag and config false/missing is failclosed; manual typing remains possible',async t=>{
  for(const flag of ['preparing','vetoPending','connected','synced','writeOwner','conflict','readOnly','features'] as const){
    const f=setup(t);await f.bridge.requestCompletion(null);const old=f.shown()[0];
    if(flag==='features')f.c.language!.features={completion:false,diagnostics:false};
    else if(flag==='writeOwner')f.c.writeOwner='COACH';
    else if(flag==='conflict'||flag==='readOnly')f.docs.get(f.h.primary.path)![flag]=true;
    else (f.c as any)[flag]=flag==='connected'||flag==='synced'?false:true;
    old.onmousedown({preventDefault(){}});assert.equal(f.h.primary.pushes,0,flag);
    f.h.primary.change('manual draft');assert.equal(f.h.primary.content,'manual draft');
  }
  const f=setup(t);delete f.c.language!.features;await f.bridge.requestCompletion(null);assert.equal(f.calls,0);assert.equal(f.shown().length,0);
});
test('worker failure reports FAILED, never ON and does not throw or mutate manual model',async t=>{
  const f=setup(t);f.wiring.setBuiltin(Object.assign(async()=>{throw Error('worker unavailable');},{ready:async()=>{throw Error('worker unavailable');},hasDiagnostics:()=>true}));
  await f.bridge.requestCompletion(null);await Promise.resolve();assert.ok(f.status.some(s=>s[0]==='FAILED'));assert.equal(f.shown().length,0);
  f.h.primary.change('manual after failure');assert.equal(f.h.primary.content,'manual after failure');assert.equal(f.h.primary.pushes,0);
});
test('ACK transitions and stale/model/project/reconnect bindings do not grant local request acceptance',async t=>{
  const f=setup(t);await f.bridge.requestCompletion(null);const old=f.shown()[0],version=f.h.primary.version;
  f.docs.get(f.h.primary.path)!.version=2;f.wiring.ackTransition();old.onmousedown({preventDefault(){}});assert.equal(f.h.primary.pushes,0);assert.equal(f.h.primary.version,version);
  const original=f.binding;f.c.connectionGeneration='other';f.wiring.authoritativeState(0);assert.equal(original.readAuthority(f.bridge.getModelSnapshots()[0]),null);
  f.c.connectionGeneration='transport';assert.notEqual(f.wiring.getBinding('projekt'),original);assert.equal(original.features!(),null);assert.deepEqual(f.sent,[]);
});
test('unsupported required additional edits reject whole response (never silently stripped)',async t=>{
  const f=setup(t);f.wiring.setBuiltin(async(_m,r)=>{const value=result(r.stamp,r.requestId);value.items[0].additionalTextEdits=[{...value.items[0].primary,text:'extra'}];return value;});
  await f.bridge.requestCompletion(null);assert.equal(f.shown().length,0);assert.equal(f.h.primary.pushes,0);
});
test('recreated same-path model rejects old worker reply and candidate even with identical bytes',async t=>{
  const f=setup(t);let release!:(r:any)=>void;
  f.wiring.setBuiltin(async(_m,r)=>new Promise(resolve=>{release=()=>resolve(result(r.stamp,r.requestId));}));
  const pending=f.bridge.requestCompletion(null),oldLifetime=f.bridge.acceptance.current().stamp.modelLifetime;
  const recreated=new Model(f.h.primary.path,'obj.');f.h.primary.disposed=true;f.h.add(recreated);f.h.switch(recreated);
  assert.notEqual(f.bridge.acceptance.current().stamp.modelLifetime,oldLifetime);release(null);await pending;
  assert.equal(f.shown().length,0);assert.equal(recreated.pushes,0);
});
test('one-shot result immutable after presentation, request IDs and old caller objects cannot revive acceptance',async t=>{
  const f=setup(t);let captured:any;
  f.wiring.setBuiltin(async(_m,r)=>{captured=result(r.stamp,r.requestId);return captured;});
  await f.bridge.requestCompletion(null);const row=f.shown()[0];captured.items[0].primary.text='MUTATED';
  row.onmousedown({preventDefault(){}});assert.equal(f.h.primary.content,'obj.method()');assert.equal(f.h.primary.pushes,1);
  row.onmousedown({preventDefault(){}});assert.equal(f.h.primary.pushes,1);
  assert.equal(f.wiring.receive({type:'COMPLETE_RESULT',payload:captured} as any),false);
});
test('completion false + diagnostics false never touches worker; diagnostics config and worker markers are locally honest',async t=>{
  const f=setup(t);let ready=0,diagnostics=0;
  f.c.language!.features={completion:false,diagnostics:false};
  f.wiring.setBuiltin(Object.assign(async(_m:any,r:any)=>result(r.stamp,r.requestId),{ready:async()=>{ready++;return true;},hasDiagnostics:()=>true,diagnostics:async()=>{diagnostics++;return [{startLineNumber:1,startColumn:1,endLineNumber:1,endColumn:4,severity:4,message:'raw warning'}];}}));
  await Promise.resolve();await f.bridge.requestCompletion(null);assert.equal(ready,0);assert.equal(diagnostics,0);assert.equal(f.shown().length,0);
  f.c.language!.features={completion:false,diagnostics:true};f.wiring.authoritativeState(0);await new Promise(r=>setTimeout(r,0));
  assert.equal(ready,1);assert.equal(diagnostics,1);assert.equal(f.h.markers.get(f.h.primary)?.[0].severity,4);assert.deepEqual(f.status.at(-1),['OFF','ON',null]);
  f.c.language!.features={completion:false,diagnostics:false};f.wiring.authoritativeState(0);assert.equal(f.h.markers.get(f.h.primary)?.length,0);assert.deepEqual(f.status.at(-1),['OFF','OFF',null]);
});
test('strict local results reject unknown actions, oversized edits/list, wrong scope and raw command all-or-none',async t=>{
  for(const mutate of [
    (v:any)=>v.items[0].command={command:'side-effect'},
    (v:any)=>v.items[0].primary.text='x'.repeat(4097),
    (v:any)=>v.items=Array.from({length:101},(_,i)=>({...v.items[0],id:`item-${i}`})),
    (v:any)=>v.stamp.projectId='foreign',
    (v:any)=>v.items[0].primary.path='other.ts',
    (v:any)=>v.items[0].primary.range.endColumn=999,
    (v:any)=>v.extra=true,
  ]) {
    const f=setup(t);f.wiring.setBuiltin(async(_m,r)=>{const value=result(r.stamp,r.requestId);mutate(value);return value;});
    await f.bridge.requestCompletion(null);assert.equal(f.shown().length,0);assert.equal(f.h.primary.pushes,0);
  }
});
