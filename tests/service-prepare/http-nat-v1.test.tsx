/** Real FE lifecycle + static React rendering; controlled transport, NOT live integration. */
import React from 'react';
import test from 'node:test';
import assert from 'node:assert/strict';
import {setImmediate} from 'node:timers/promises';
import {renderToStaticMarkup} from 'react-dom/server';
import {RuntimeStatusV2} from '../../src/components/RuntimeStatusV2';
import {ServicePreparationV2} from '../../src/services/ServicePreparationV2';
import {fixture,prepared,MemoryStorage,storageKey,deferred} from './fixture';
import {execution} from '../client-v2/fixtures';
const currentReceipt=()=>({...prepared(),name:'paircoach-install1-service-http-v1'});
const legacyReceipt=()=>({...prepared(),name:'paircoach-install1-service'});
const body={requestId:'original-legacy',clientId:'c1',sessionId:'s1',expectedWorkspaceVersion:1,configurationGeneration:'cfg1',controlEpoch:0};
function retained(receipt:unknown=null) {
  const storage=new MemoryStorage();storage.setItem(storageKey,JSON.stringify({version:1,clientId:'c1',entries:[{projectId:'p1',request:body,receipt,phase:'UNKNOWN'}]}));return storage;
}

test('new exact HTTP NAT receipt: original six-field request then fresh measured GET, never receipt-driven READY',async t=>{
  const f=await fixture(t);f.post=async()=>currentReceipt();f.calls.length=0;
  assert.equal(await f.live.prepareRuntimeEnvironment(),true);
  assert.deepEqual(f.calls.map(c=>c.path),['/api/runtime/service-network/prepare','/api/project']);
  assert.deepEqual(Object.keys(f.posts()[0].body).sort(),Object.keys(body).sort());
  assert.equal(f.live.getState().runtime!.execution!.modes.RUN_MAIN.canRun,false);
  assert.equal(f.live.getState().runtime!.execution!.modes.RUN_TESTS.canRun,true);
  assert.deepEqual(JSON.parse(f.storage.getItem(storageKey)!).entries,[]);
});

test('fresh request cannot adopt an old exact internal receipt; original retained without GET',async t=>{
  const f=await fixture(t);f.post=async()=>legacyReceipt();f.calls.length=0;
  assert.equal(await f.live.prepareRuntimeEnvironment(),false);assert.equal(f.maintenance().uncertain,true);
  assert.equal(f.calls.filter(c=>c.path==='/api/project').length,0);
  assert.equal(JSON.parse(f.storage.getItem(storageKey)!).entries[0].receipt,null);
});

for(const initialReceipt of [null,legacyReceipt()])test(`legacy immutable original reconcile, saved receipt=${!!initialReceipt}: Main still requires separate NEW click`,async t=>{
  const storage=retained(initialReceipt),raw=storage.getItem(storageKey),f=await fixture(t,{storage});
  assert.equal(storage.getItem(storageKey),raw);assert.equal(f.posts().length,0);assert.equal(f.maintenance().uncertain,true);
  f.post=async()=>legacyReceipt();assert.equal(await f.live.prepareRuntimeEnvironment(),false);
  assert.equal(await f.live.prepareRuntimeEnvironment(true),true);
  assert.deepEqual(f.posts()[0].body,body);assert.equal(f.live.getState().runtime!.execution!.modes.RUN_MAIN.canRun,false);
  assert.deepEqual(JSON.parse(storage.getItem(storageKey)!).entries,[]);assert.equal(f.posts().length,1);
  f.post=async()=>currentReceipt();assert.equal(await f.live.prepareRuntimeEnvironment(),true);
  assert.notEqual(f.posts()[1].body.requestId,body.requestId);assert.equal(f.posts().length,2);
});

for(const receipt of [legacyReceipt(),currentReceipt()])test(`retained ${receipt.name}: loss of GET keeps exact receipt across restart; changed generation cannot replace it`,async t=>{
  const storage=retained(receipt),f=await fixture(t,{storage});f.post=async()=>receipt;f.get=async()=>{throw Error('lost measured GET');};
  assert.equal(await f.live.prepareRuntimeEnvironment(true),false);const raw=storage.getItem(storageKey);f.live.close();
  const next=await fixture(t,{storage});assert.equal(storage.getItem(storageKey),raw);assert.equal(next.posts().length,0);
  next.post=async()=>receipt.name.endsWith('-http-v1')?legacyReceipt():currentReceipt();next.calls.length=0;
  assert.equal(await next.live.prepareRuntimeEnvironment(true),false);assert.equal(next.calls.filter(c=>c.path==='/api/project').length,0);
  assert.equal(storage.getItem(storageKey),raw);
  next.post=async()=>({...receipt});assert.equal(await next.live.prepareRuntimeEnvironment(true),true);assert.deepEqual(next.posts()[1].body,body);
});

for(const value of [
  {...currentReceipt(),name:'paircoach-install2-service-http-v1'}, {...currentReceipt(),name:'paircoach-install1-service-http-v2'},
  {...currentReceipt(),name:'paircoach-install1-service-http-v1-extra'}, {...legacyReceipt(),name:'paircoach-install1-service-extra'},
  {...currentReceipt(),purpose:'http-nat-v1'}, {...currentReceipt(),projectId:'foreign'}, {...currentReceipt(),engineId:'bad engine'},
  {...currentReceipt(),installationId:'.bad'}, {...currentReceipt(),networkId:'g'.repeat(64)},
  {...currentReceipt(),installationId:'a'.repeat(55),name:`paircoach-${'a'.repeat(55)}-service-http-v1`},
  {...currentReceipt(),installationId:'a'.repeat(60),name:`paircoach-${'a'.repeat(60)}-service-http-v1`},
])for(const restored of [false,true])test(`strict foreign/extra/malformed receipt ${JSON.stringify(value)}, restored=${restored}`,async t=>{
  const storage=restored?retained():new MemoryStorage(),f=await fixture(t,{storage});f.post=async()=>value;f.calls.length=0;
  assert.equal(await f.live.prepareRuntimeEnvironment(restored),false);assert.equal(f.maintenance().uncertain,true);
  assert.equal(f.calls.filter(c=>c.path==='/api/project').length,0);
  const saved=JSON.parse(storage.getItem(storageKey)!).entries[0];assert.equal(saved.receipt,null);
  if(restored)assert.deepEqual(saved.request,body);
});

for(const receipt of [legacyReceipt(),currentReceipt()])test(`foreign client cannot adopt retained ${receipt.name}`,async t=>{
  const storage=retained(receipt),raw=storage.getItem(storageKey),f=await fixture(t,{storage,clientId:'foreign-client'});
  assert.equal(await f.live.prepareRuntimeEnvironment(true),false);assert.equal(await f.live.prepareRuntimeEnvironment(),false);
  assert.equal(f.posts().length,0);assert.equal(storage.getItem(storageKey),raw);assert.equal(f.maintenance().blocked,true);
});

for(const drift of ['source','control','session','generation'] as const)test(`NAT measured GET late ${drift} change cannot install READY`,{timeout:5000},async t=>{
  const f=await fixture(t),gate=deferred();f.post=async()=>currentReceipt();f.get=()=>gate.promise;
  const pending=f.live.prepareRuntimeEnvironment();await setImmediate();
  assert.equal(f.calls.at(-1)!.path,'/api/project');
  if(drift==='source')f.b.session.workspaceVersion=f.b.project.workspaceVersion=2;
  if(drift==='control')f.b.session.controlEpoch++;
  if(drift==='session')f.b.session.sessionId=f.b.project.sessionId='s2';
  if(drift==='generation')f.b.project.capabilities.execution.runtime.configurationGeneration=f.b.project.capabilities.language.configurationGeneration='cfg2';
  f.get=async()=>structuredClone(f.b.project);
  await f.snapshot();const before=structuredClone(f.live.getState().runtime!.execution),measured=structuredClone(f.b.project);
  measured.capabilities.execution.modes.RUN_MAIN={canRun:true,problem:null};gate.resolve(measured);
  assert.equal(await pending,false);assert.deepEqual(f.live.getState().runtime!.execution,before);
  assert.equal(f.maintenance().uncertain,true);assert.equal(f.posts().length,1);
});

for(const failure of ['quota','other-tab'] as const)test(`new NAT never bypasses ${failure} storage fence`,async t=>{
  const f=await fixture(t);f.post=async()=>currentReceipt();
  if(failure==='quota')f.storage.failSet=true;else f.storage.setItem(storageKey,'foreign original');
  assert.equal(await f.live.prepareRuntimeEnvironment(),false);assert.equal(f.posts().length,0);assert.equal(f.maintenance().canPrepare,false);
});

test('NAT pending remains singleflight; no new request or Run until original + fresh GET settle',async t=>{
  const f=await fixture(t),gate=deferred();f.post=()=>gate.promise;const pending=f.live.prepareRuntimeEnvironment();
  const raw=f.storage.getItem(storageKey);assert.equal(await f.live.prepareRuntimeEnvironment(),false);assert.equal(await f.live.prepareRuntimeEnvironment(true),false);
  await f.live.run(true);assert.equal(f.calls.some(c=>c.path==='/api/run'),false);assert.equal(f.storage.getItem(storageKey),raw);
  gate.resolve(currentReceipt());assert.equal(await pending,true);assert.equal(f.posts().length,1);
});

// Unit boundary as well as real LiveBackend wiring: exact max80 still includes both suffixes.
test('exact NAT name at max80 is accepted; no client purpose/name field is added',async()=>{
  const a={projectId:'p1',clientId:'c1',sessionId:'s1',workspaceVersion:1,configurationGeneration:'cfg1',controlEpoch:0,stamp:'current',allowed:true};
  const installationId='a'.repeat(54),value={...currentReceipt(),installationId,name:`paircoach-${installationId}-service-http-v1`};
  assert.equal(value.name.length,80);let reads=0;
  const c=new ServicePreparationV2({current:()=>a,requestId:()=>body.requestId,publish:()=>{},post:async request=>{assert.deepEqual(request,body);return value;},refresh:async()=>{reads++;return true;},isAbsence:()=>false});
  c.initialize(new MemoryStorage(),storageKey,'c1');assert.equal(await c.perform(),true);assert.equal(reads,1);
});

for(const controls of [true,false])test(`visible truthful network policy precedes prepare and Main even without prepare control=${!controls}`,()=>{
  const e=execution();e.modes.RUN_MAIN={canRun:true,problem:null};
  const markup=renderToStaticMarkup(<RuntimeStatusV2 execution={e} language={null} run={null} connected canExecute
    {...(controls?{onPrepare:()=>{}}:{})} preparation={{pending:false,blocked:false,uncertain:false,canPrepare:true,canReconcile:false,message:null}}
    onRun={()=>{}} onStop={()=>{}} onSettings={()=>{}}/>);
  for(const text of ['HTTP Main: port publikowany tylko na 127.0.0.1','program może łączyć się z siecią zewnętrzną','osiągalnymi usługami hosta/LAN','współuczestnikami sieci','Testy i programy bez HTTP działają bez sieci','Maven offline nie blokuje połączeń programu'])assert.ok(markup.includes(text),text);
  assert.ok(markup.indexOf('HTTP Main:')<markup.indexOf('>Uruchom program<'));
  if(controls)assert.ok(markup.indexOf('HTTP Main:')<markup.indexOf('>Przygotuj środowisko<'));
  assert.match(markup,/aria-describedby="[^"]+-network-policy [^"]+-RUN_MAIN-reason"/);
  assert.doesNotMatch(markup,/type="checkbox"|pełn[aey] izolacj/);
});

for(const bad of [{...currentReceipt(),name:'paircoach-install1-service-http-v2'},{...legacyReceipt(),purpose:'http-nat-v1'}])test(`invalid retained receipt is not rewritten or dispatched: ${JSON.stringify(bad)}`,async t=>{
  const storage=retained(bad),raw=storage.getItem(storageKey),f=await fixture(t,{storage});
  assert.equal(await f.live.prepareRuntimeEnvironment(),false);assert.equal(await f.live.prepareRuntimeEnvironment(true),false);
  assert.equal(f.posts().length,0);assert.equal(storage.getItem(storageKey),raw);assert.equal(f.maintenance().blocked,true);
});
