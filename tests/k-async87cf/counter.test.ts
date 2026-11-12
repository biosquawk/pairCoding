import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import {join} from 'node:path';
import {fixture} from '../language-prepare-performance/selected-async-fixture';
import {LanguageFeatureRegistry} from '../../src/server/language/LanguageFeatureRegistry';
import {LanguageAckLedger} from '../../src/server/language/LanguageAckLedger';
import * as codec from '../../src/language/uriCodec';
const deferred=()=>{let resolve!:()=>void;const promise=new Promise<void>(r=>resolve=r);return{promise,resolve};};
const tick=async()=>{for(let n=0;n<8;n++)await new Promise<void>(r=>setImmediate(r));};
// Real Registry -> selected wrapper/resolver -> Factory -> Store/native durability/boot/journal.
// Only OCI/lease and provider-start/RPC are controlled; not actual Gate or LSP performance proof.
for(const revoke of [false,true])test('K integrated real Registry hint '+(revoke?'epoch revoked AFTER native stage drains, unused stage retired':'consumed before lease release and provider start'),async t=>{
 const f=await fixture(t),done=deferred(),started=deferred();
 const factory=f.factory,internal=factory as any,store=internal.store;
 let stages=0,creates=0,starts=0,fallback=0;const hints:unknown[]=[];
 const originalStage=store.stage.bind(store),originalCreate=factory.create.bind(factory),originalLease=factory.withCaptureLease.bind(factory);
 let registry!:LanguageFeatureRegistry;
 store.materialize=()=>{fallback++;throw Error('K forbidden synchronous fallback');};
 store.stage=async(authority:unknown)=>{stages++;const token=await originalStage(authority);f.lease.assertCurrent();if(revoke)registry.invalidateSource(f.scope);return token;};
 factory.withCaptureLease=async(scope,snapshot,action,hint)=>{
  hints.push(hint);assert.ok(Object.isFrozen(hint));
  try {await originalLease(scope,snapshot,action,hint);}finally{done.resolve();}
 };
 factory.create=(scope,phase,snapshot,callbacks,generation)=>{
  f.lease.assertCurrent();creates++;const launch=originalCreate(scope,phase,snapshot,callbacks,generation);
  assert.equal(phase,'completion');assert.equal(launch.generation,null);
  // This owner is genuine and transferred inside lease; do NOT dispatch a provider in this counter.
  launch.session.start=async()=>{assert.throws(()=>f.lease.assertCurrent(),/lease revoked/);starts++;started.resolve();};
  launch.session.open=async()=>{};
  return launch;
 };
 const ledger=new LanguageAckLedger({readCurrent:()=>null,readAnalysisSource:()=>null,readCommittedSave:()=>null},codec);
 registry=new LanguageFeatureRegistry({factory,ackLedger:ledger,
  clock:{set:()=>1,clear:()=>{}}, // diagnostics coalescing intentionally not fired; no real timers.
  authority:{capture:()=>f.snapshot,isCurrent:(_scope,snapshot)=>snapshot.revision===f.snapshot.revision}});
 t.after(()=>registry.disposeProject(f.scope));
 await registry.startProject(f.scope);await done.promise;
 if(!revoke)await started.promise;await tick();
 assert.deepEqual(hints,[{kind:'CREATE',phase:'completion'}]);assert.equal(stages,1);
 assert.equal(creates,revoke?0:1);assert.equal(starts,revoke?0:1);assert.equal(fallback,0);
 assert.equal(f.acquisitions,1);assert.deepEqual(f.mutations,[]);
 if(revoke)assert.deepEqual(fs.readdirSync(f.owned),[]);
 else {const roots=fs.readdirSync(f.owned);assert.equal(roots.length,1);assert.equal(JSON.parse(fs.readFileSync(join(f.owned,roots[0],'manifest.json'),'utf8')).phase,'completion');}
 await registry.disposeProject(f.scope);assert.deepEqual(f.mutations,[]);
});
