/** NEW narrow lifecycle regression. Real FE/controller; controlled HTTP, NOT backend/Docker. */
import React from 'react';
import test from 'node:test';
import assert from 'node:assert/strict';
import {renderToStaticMarkup} from 'react-dom/server';
import {ServicePreparationV2} from '../../src/services/ServicePreparationV2';
import {RuntimeStatusV2} from '../../src/components/RuntimeStatusV2';
import {fixture,MemoryStorage,prepared,storageKey} from './fixture';
import {run} from '../client-v2/fixtures';
const empty=(clientId='closed-tab')=>JSON.stringify({version:1,clientId,entries:[]});
function setup(storage=new MemoryStorage(),clientId='own-tab') {
  const a={projectId:'p1',clientId,sessionId:'s1',workspaceVersion:1,configurationGeneration:'cfg1',controlEpoch:0,stamp:'current',allowed:true};
  const bodies:unknown[]=[],c=new ServicePreparationV2({current:()=>a,requestId:()=>`request-${clientId}`,publish:()=>{},
    post:async body=>{bodies.push(structuredClone(body));return prepared();},refresh:async()=>true,isAbsence:()=>false});
  c.initialize(storage,storageKey,clientId);return {c,bodies,storage};
}
async function settled(t:Parameters<typeof fixture>[0]) {
  const first=await fixture(t,{clientId:'closed-tab'});assert.equal(await first.live.prepareRuntimeEnvironment(),true);
  assert.deepEqual(JSON.parse(first.storage.getItem(storageKey)!).entries,[]);first.live.close();return first.storage;
}
test('settled empty history is read-only on open; own explicit prepare persists own original BEFORE POST',async()=>{
  const storage=new MemoryStorage(),original=empty();storage.setItem(storageKey,original);
  const {c,bodies}=setup(storage);
  assert.equal(c.snapshot().blocked,false);assert.equal(c.snapshot().canPrepare,true);assert.equal(c.snapshot().canReconcile,false);
  assert.equal(storage.getItem(storageKey),original);assert.equal(bodies.length,0);
  assert.equal(await c.perform(true),false);assert.equal(storage.getItem(storageKey),original);
  assert.equal(await c.perform(),true);assert.equal(bodies.length,1);
  assert.deepEqual(bodies[0],{requestId:'request-own-tab',clientId:'own-tab',sessionId:'s1',expectedWorkspaceVersion:1,configurationGeneration:'cfg1',controlEpoch:0});
  assert.equal(JSON.parse(storage.getItem(storageKey)!).clientId,'own-tab');assert.deepEqual(JSON.parse(storage.getItem(storageKey)!).entries,[]);
});
test('success -> new authenticated own tab: ordinary Run and SAVE both reach HTTP and validate success',async t=>{
  const storage=await settled(t);
  // Separate fresh own clients exercise each ordinary action, with valid controlled replies.
  for(const operation of ['RUN','SAVE'] as const) {
    const f=await fixture(t,{storage,clientId:`new-${operation}`}),http=(f.live as any).fetcher;let requests=0;
    (f.live as any).fetcher=async(input:unknown,init:RequestInit)=>{
      const path=new URL(String(input)).pathname;
      if(path===(operation==='RUN'?'/api/run':'/api/project/settings')) {
        requests++;const body=JSON.parse(String(init.body));assert.equal(body.clientId,`new-${operation}`);
        assert.equal((init.headers as Record<string,string>).Authorization,'Bearer same-authenticated');
        return Response.json(operation==='RUN'?run():{...f.b.project,workspaceVersion:2});
      }
      return http(input,init);
    };
    assert.equal(f.maintenance().blocked,false);assert.equal(f.maintenance().canPrepare,true);
    if(operation==='RUN') {await f.live.run(true);assert.equal(f.live.getState().runtime!.run!.runId,'run1');}
    else assert.equal((await f.live.saveRuntimeSettings(f.b.project.settings,1)).ok,true);
    assert.equal(requests,1);assert.equal(f.live.getState().runtime!.reconciliationRequired,false);
    assert.equal(f.posts().length,0);assert.equal(JSON.parse(storage.getItem(storageKey)!).clientId,'closed-tab');
  }
  const next=await fixture(t,{storage,clientId:'new-prepare'});
  assert.equal(await next.live.prepareRuntimeEnvironment(),true);assert.equal(next.posts().length,1);
  assert.equal(next.posts()[0].body.clientId,'new-prepare');
});
for(const phase of ['UNKNOWN','ABSENT'] as const)for(const receipt of [null,prepared()])
  test(`foreign NONEMPTY ${phase}, receipt=${!!receipt}: never borrow, overwrite, reconcile or dispatch`,async t=>{
    const storage=new MemoryStorage(),record=JSON.stringify({version:1,clientId:'foreign',entries:[{projectId:'p1',phase,receipt,
      request:{requestId:'original',clientId:'foreign',sessionId:'s1',expectedWorkspaceVersion:1,configurationGeneration:'cfg1',controlEpoch:0}}]});
    storage.setItem(storageKey,record);const f=await fixture(t,{storage,clientId:'own-tab'});
    assert.equal(f.maintenance().blocked,true);assert.equal(f.maintenance().canPrepare,false);assert.equal(f.maintenance().canReconcile,false);
    assert.match(f.maintenance().message!,/innego klienta/);
    assert.equal(await f.live.prepareRuntimeEnvironment(),false);assert.equal(await f.live.prepareRuntimeEnvironment(true),false);
    await f.live.run(true);assert.equal((await f.live.saveRuntimeSettings(f.b.project.settings,1)).ok,false);
    assert.equal(f.calls.some(c=>['/api/run','/api/project/settings','/api/runtime/service-network/prepare'].includes(c.path)),false);
    assert.equal(storage.getItem(storageKey),record);assert.equal((f.live as any).clientId,'own-tab');
    f.live.saveFileContent('main.txt','manual still works');assert.equal(f.live.getState().files[0].content,'manual still works');
  });
test('CAS: foreign empty observed earlier cannot overwrite another client original admitted since then',async t=>{
  const storage=await settled(t),next=setup(storage);
  const first=await fixture(t,{storage,clientId:'closed-tab'});first.post=async()=>{throw Error('lost reply');};
  await first.live.prepareRuntimeEnvironment();const record=storage.getItem(storageKey);
  assert.equal(JSON.parse(record!).entries.length,1);assert.equal(await next.c.perform(),false);assert.equal(next.bodies.length,0);
  assert.equal(next.c.snapshot().blocked,true);assert.equal(storage.getItem(storageKey),record);
});
for(const failure of ['malformed-empty','quota','readback'] as const)test(`foreign empty validation/storage protection: ${failure}`,async()=>{
  const storage=new MemoryStorage();storage.setItem(storageKey,failure==='malformed-empty'?JSON.stringify({version:1,clientId:'bad id',entries:[]}):empty());
  const record=storage.getItem(storageKey),{c,bodies}=setup(storage);
  if(failure==='quota')storage.failSet=true;if(failure==='readback'){storage.afterSet=false;storage.failReadback=true;}
  assert.equal(await c.perform(),false);assert.equal(bodies.length,0);assert.equal(c.snapshot().blocked,true);
  if(failure!=='readback')assert.equal(storage.getItem(storageKey),record);
  else {storage.failReadback=false;const retained=JSON.parse(storage.getItem(storageKey)!);assert.equal(retained.clientId,'own-tab');assert.equal(retained.entries.length,1);}
});
test('affected UI reflects actual settled vs foreign unresolved state without changing labels or layout',async t=>{
  const storage=await settled(t),next=await fixture(t,{storage,clientId:'new-ui'});
  const markup=()=>renderToStaticMarkup(<RuntimeStatusV2 execution={next.live.getState().runtime!.execution} language={null} run={null}
    connected canExecute preparation={next.maintenance()} onPrepare={()=>{}} onRun={()=>{}} onStop={()=>{}} onSettings={()=>{}}/>);
  let html=markup();assert.doesNotMatch(html,/disabled=""[^>]*>Uruchom testy/);assert.doesNotMatch(html,/disabled=""[^>]*aria-describedby="[^\"]+-prepare"/);
  assert.match(html,/Przygotuj środowisko/);assert.doesNotMatch(html,/innego klienta/);
  const unknown=await fixture(t,{storage,clientId:'closed-tab'});unknown.post=async()=>{throw Error('lost');};await unknown.live.prepareRuntimeEnvironment();
  const foreign=await fixture(t,{storage,clientId:'other-ui'});
  html=renderToStaticMarkup(<RuntimeStatusV2 execution={foreign.live.getState().runtime!.execution} language={null} run={null}
    connected canExecute preparation={foreign.maintenance()} onPrepare={()=>{}} onRun={()=>{}} onStop={()=>{}} onSettings={()=>{}}/>);
  assert.match(html,/disabled=""[^>]*>Uruchom testy/);assert.match(html,/innego klienta/);
});
