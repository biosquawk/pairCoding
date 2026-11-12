import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { fixture, callbacks } from './selected-async-fixture';
const createHint=Object.freeze({kind:'CREATE' as const,phase:'diagnostics' as const});
import type { LanguageShadowStore, LanguageShadowAsyncIO } from '../../src/server/language/LanguageShadowStore';
function instrument(f: Awaited<ReturnType<typeof fixture>>) {
 const internal=f.factory as unknown as {store:Pick<LanguageShadowStore,'stage'|'materialize'>&{asyncIO:LanguageShadowAsyncIO}},store=internal.store,native=store.asyncIO;
 let open=0,max=0,stages=0,fallback=0;const originalStage=store.stage.bind(store);
 store.stage=async a=>{stages++;return originalStage(a);};
 store.materialize=()=>{fallback++;throw Error('Forbidden sync fallback in selected async path');};
 store.asyncIO={...native,async open(...a){const fd=await native.open(...a);open++;max=Math.max(max,open);return fd;},async sync(fd){f.lease.assertCurrent();await native.sync(fd);f.lease.assertCurrent();},async close(fd){await native.close(fd);open--;}};
 return {store,native,get open(){return open;},get max(){return max;},get stages(){return stages;},get fallback(){return fallback;}};
}
test('selected wrapper holds SAME lease through real async staging, source-currentness, synchronous action/owner and final disposal',async t=>{
 const f=await fixture(t),i=instrument(f);f.release();let launch!:ReturnType<typeof f.create>,action=false;
 await f.factory.withCaptureLease(f.scope,f.snapshot,()=>{f.lease.assertCurrent();assert.equal(i.open,0);assert.equal(i.stages,1);
  for(const d of fs.readdirSync(f.owned))assert.equal(fs.existsSync(join(f.owned,d,'manifest.json')),false);
  launch=f.create();action=true;assert.equal(i.fallback,0);assert.deepEqual(f.mutations,[]);},createHint);
 assert.ok(action);assert.ok(i.max>1&&i.max<=4);assert.equal(i.open,0);assert.equal(f.acquisitions,1);
 assert.throws(()=>f.authority.capture(f.scope,f.snapshot),/lease revoked/);assert.deepEqual(await launch.session.retire(),{confirmed:true,removed:true,problem:null});assert.deepEqual(f.mutations,[]);
});
test('selected stage error drains/closes/cleans BEFORE lease release, never action or synchronous fallback',async t=>{
 const f=await fixture(t),i=instrument(f);let action=false;
 const native=i.store.asyncIO;i.store.asyncIO={...native,async sync(fd){await native.sync(fd);throw Error('actual async sync error');}};
 await assert.rejects(f.factory.withCaptureLease(f.scope,f.snapshot,()=>{action=true;f.create();},createHint),/actual async sync error/);
 assert.equal(action,false);assert.equal(i.open,0);assert.equal(i.fallback,0);assert.deepEqual(fs.readdirSync(f.owned),[]);assert.deepEqual(f.mutations,[]);assert.throws(()=>f.authority.capture(f.scope,f.snapshot),/lease revoked/);
});
for(const effect of ['foreign-scope','foreign-snapshot','foreign-phase','one-use','source-change'] as const)test('selected '+effect+' cannot borrow/reuse staged capability or downgrade',async t=>{
 const f=await fixture(t),i=instrument(f);let launch:ReturnType<typeof f.create>|undefined;
 if(effect==='source-change'){const native=i.store.asyncIO;let changed=false;i.store.asyncIO={...native,async sync(fd){await native.sync(fd);if(!changed){changed=true;fs.writeFileSync(join(f.workspace,'inactive.txt'),'external mutation');}}};}
 const action=()=>{
  if(effect==='foreign-phase')f.factory.create(f.scope,'completion',f.snapshot,callbacks);
  if(effect==='foreign-scope')f.factory.create({...f.scope,projectId:'foreign'},'completion',f.snapshot,callbacks);
  if(effect==='foreign-snapshot')f.factory.create(f.scope,'completion',{...f.snapshot,revision:'foreign'},callbacks);
  if(effect==='one-use'){launch=f.create();assert.throws(()=>f.create(),/Mismatched\/reused/);}
 };
 if(effect==='one-use')await f.factory.withCaptureLease(f.scope,f.snapshot,action,createHint);
 else await assert.rejects(f.factory.withCaptureLease(f.scope,f.snapshot,action,createHint));
 assert.equal(i.fallback,0);assert.equal(i.open,0);assert.deepEqual(f.mutations,[]);
 if(launch)await launch.session.retire();else assert.deepEqual(fs.readdirSync(f.owned),[]);
});
test('active refresh uses original per-file sync behavior; REFRESH does not stage another tree',async t=>{
 const f=await fixture(t),i=instrument(f);let launch!:ReturnType<typeof f.create>;
 await f.factory.withCaptureLease(f.scope,f.snapshot,()=>{launch=f.factory.create(f.scope,'completion',f.snapshot,callbacks);},Object.freeze({kind:'CREATE',phase:'completion'}));
 const root=fs.readdirSync(f.owned)[0],inode=fs.statSync(join(f.owned,root,'workspace')).ino;
 await f.factory.withCaptureLease(f.scope,f.snapshot,()=>{assert.equal(f.factory.refreshCompletion(f.scope,f.snapshot,launch),true);assert.equal(i.open,0);},Object.freeze({kind:'REFRESH',phase:'completion'}));
 assert.equal(i.stages,1);assert.deepEqual(fs.readdirSync(f.owned),[root]);assert.equal(fs.statSync(join(f.owned,root,'workspace')).ino,inode);assert.equal(i.fallback,0);await launch.session.retire();
});
test('lazy actual verifier compatibility: absent trusted receipt does not break constructor, rejects at real remote verification boundary',async t=>{
 const f=await fixture(t,'python',true,true);assert.equal(f.calls.length,0);
 await assert.rejects(f.factory.withCaptureLease(f.scope,f.snapshot,()=>{assert.fail('no action without receipt');},createHint),/Explicit trusted language receipt/);
 assert.ok(f.calls.some(a=>a[0]==='info'),'real selected resolver reached synthetic OCI boundary');assert.deepEqual(fs.readdirSync(f.owned),[]);assert.deepEqual(f.mutations,[]);
});

test('missing/ambiguous scheduling hints and no-op REFRESH never trigger eager staging',async t=>{
 const f=await fixture(t),i=instrument(f);let actions=0;
 for(const hint of [undefined,{kind:'REFRESH',phase:'completion'},{kind:'CREATE',phase:'invalid'},{kind:'CREATE',phase:'completion',extra:true}]) {
  await f.factory.withCaptureLease(f.scope,f.snapshot,()=>{actions++;},hint as never);
 }
 assert.equal(actions,4);assert.equal(i.stages,0);assert.equal(i.open,0);assert.equal(i.fallback,0);assert.deepEqual(fs.readdirSync(f.owned),[]);
});
test('genuine staged CREATE whose epoch action becomes no-op retires unused capability before lease release',async t=>{
 const f=await fixture(t),i=instrument(f);let called=0;
 await f.factory.withCaptureLease(f.scope,f.snapshot,()=>{f.lease.assertCurrent();called++;assert.equal(fs.readdirSync(f.owned).length,1);},createHint);
 assert.equal(called,1);assert.equal(i.stages,1);assert.equal(i.open,0);assert.equal(i.fallback,0);assert.deepEqual(fs.readdirSync(f.owned),[]);assert.throws(()=>f.lease.assertCurrent(),/lease revoked/);
});
