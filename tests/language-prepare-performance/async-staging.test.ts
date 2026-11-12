import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { join, relative } from 'node:path';
import { LanguageShadowStore } from '../../src/server/language/LanguageShadowStore';
import * as codec from '../../src/language/uriCodec';
import { fixture, deferred } from './async-fixture';
test('native async stage has max4 overlap, all file fsync/close/readback and bottom-up directories BEFORE manifest/phase publication',async t=>{
 const f=fixture(t),arrived=deferred(),release=deferred();let count=0;
 f.hook(async op=>{if(op==='sync'&&++count<=4){if(count===4)arrived.resolve();await release.promise;}});
 const staging=f.store.stage(f.authority);await arrived.promise;
 assert.equal(f.max,4);assert.equal(f.fds.size,4);
 const root=join(f.owned,fs.readdirSync(f.owned)[0]);assert.equal(fs.existsSync(join(root,'manifest.json')),false);
 assert.deepEqual(fs.readdirSync(join(root,'boot')),[]);assert.deepEqual(fs.readdirSync(join(root,'state')),[]);
 release.resolve();const token=await staging;assert.equal(f.fds.size,0);assert.equal(f.max,4);assert.equal(fs.existsSync(join(root,'manifest.json')),false);
 const shadow=f.store.consumeStage(token,'diagnostics');assert.equal(shadow.manifest.phase,'diagnostics');
 assert.equal(f.events.filter(e=>e.op==='sync').length,10);assert.equal(f.events.filter(e=>e.op==='write').length,10);assert.equal(f.events.filter(e=>e.op==='close').length,10);
 const firstDir=f.events.findIndex(e=>e.op==='directory'),lastClose=f.events.reduce((last,e,i)=>e.op==='close'?i:last,-1);assert.ok(firstDir>lastClose);
 const dirs=f.events.filter(e=>e.op==='directory').map(e=>relative(root,e.path));
 assert.ok(dirs.indexOf('workspace/nested/empty')<dirs.indexOf('workspace/nested'));assert.ok(dirs.indexOf('workspace/nested')<dirs.indexOf('workspace'));
 assert.ok(f.events.findIndex(e=>e.op==='manifest-file')>firstDir);f.store.assertIntegrity(shadow);
 assert.equal(fs.readFileSync(join(shadow.workspaceDirectory,'a0.py'),'utf8'),'draft\n');
 assert.equal(fs.readFileSync(join(f.project,'a0.py'),'utf8'),'print("original")\n');
 assert.throws(()=>f.store.consumeStage(token,'completion'),/Unknown\/used/);
});
for(const effect of ['write','sync','close'] as const)test('first '+effect+' error drains delayed inflight native IO/closes BEFORE cleanup, no next wave',async t=>{
 const f=fixture(t),arrived=deferred(),firstRelease=deferred(),othersRelease=deferred(),firstClosed=deferred();let count=0,first=-1,settled=false;
 f.hook(async(op,fd)=>{
  if(op==='close'&&fd===first)firstClosed.resolve();
  if(op===effect){if(first<0)first=fd;if(++count===4)arrived.resolve();if(fd===first){await firstRelease.promise;if(effect==='close')firstClosed.resolve();throw Error('injected '+effect+' failure');}await othersRelease.promise;}
 });
 const staging=f.store.stage(f.authority).finally(()=>{settled=true;});await arrived.promise;
 firstRelease.resolve();await firstClosed.promise;
 // First file has genuinely failed and closed, while the other three native operations remain
 // deliberately suspended. Cleanup and lease exit MUST NOT race those still-pending callbacks.
 assert.equal(settled,false);assert.equal(fs.readdirSync(f.owned).length,1);
 assert.equal(f.events.filter(e=>e.op==='open').length,4);
 othersRelease.resolve();await assert.rejects(staging,new RegExp('injected '+effect));
 assert.equal(f.fds.size,0);assert.equal(f.events.filter(e=>e.op==='open').length,4);assert.deepEqual(fs.readdirSync(f.owned),[]);
});
for(const effect of ['Veto','lease-release','source-change','active-overlay','inactive-overlay','commit-generation'] as const)test(effect+' while native IO awaits prevents next wave/manifest/handle',async t=>{
 const f=fixture(t),arrived=deferred(),release=deferred();let count=0;
 f.hook(async op=>{if(op==='sync'&&++count<=4){if(count===4)arrived.resolve();await release.promise;}});
 const staging=f.store.stage(f.authority);await arrived.promise;
 if(effect==='Veto')f.veto();if(effect==='lease-release')f.release();
 if(effect==='source-change')fs.writeFileSync(join(f.project,'nested/a9.py'),'external change');
 if(effect==='active-overlay'||effect==='inactive-overlay')f.snapshot.overlays[effect==='active-overlay'?0:1].content='stale';
 if(effect==='commit-generation')f.snapshot.leaseId='next-commit';
 release.resolve();await assert.rejects(staging);assert.equal(f.fds.size,0);assert.equal(f.events.filter(e=>e.op==='open').length,4);assert.deepEqual(fs.readdirSync(f.owned),[]);
});
test('unforgeable token is store-local; same-byte replacement/link/new-directory tamper rejects before manifest',async t=>{
 for(const effect of ['clone','other-store','bytes','link','empty-dir','release','snapshot','dependency'] as const){
  const f=fixture(t),token=await f.store.stage(f.authority),root=join(f.owned,fs.readdirSync(f.owned)[0]);
  if(effect==='clone'){assert.throws(()=>f.store.consumeStage({...token},'completion'),/Unknown/);f.store.discardStage(token);continue;}
  if(effect==='other-store'){assert.throws(()=>new LanguageShadowStore(f.owned,codec).consumeStage(token,'completion'),/Unknown/);f.store.discardStage(token);continue;}
  if(effect==='bytes'){const p=join(root,'workspace/a0.py');fs.chmodSync(p,0o600);fs.writeFileSync(p,'tampered');}
  if(effect==='link'){const p=join(root,'workspace/a0.py');fs.chmodSync(p,0o600);fs.unlinkSync(p);fs.symlinkSync(join(f.project,'a0.py'),p);}
  if(effect==='empty-dir')fs.mkdirSync(join(root,'workspace/new-empty'));
  if(effect==='release')f.release();if(effect==='snapshot')f.snapshot.leaseId='different';
  if(effect==='dependency')f.snapshot.dependencies={root:f.project,files:[]};
  assert.throws(()=>f.store.consumeStage(token,'completion'));assert.deepEqual(fs.readdirSync(f.owned),[]);
 }
});
test('output directory replacement during awaited file write fails and leaves no usable capability',async t=>{
 const f=fixture(t);let changed=false;
 f.hook((op,_fd,path)=>{if(op==='write'&&!changed){changed=true;const dir=f.dirname(path);fs.renameSync(dir,dir+'-old');fs.mkdirSync(dir);}});
 await assert.rejects(f.store.stage(f.authority));assert.ok(changed);assert.equal(f.fds.size,0);assert.deepEqual(fs.readdirSync(f.owned),[]);
});
test('cleanup failure is propagated alongside original IO error only after all inflight closes',async t=>{
 const f=fixture(t),internal=f.store as unknown as {removeUnlaunched:(root:string)=>void};const original=internal.removeUnlaunched;
 internal.removeUnlaunched=()=>{assert.equal(f.fds.size,0);throw Error('injected cleanup failure');};
 f.hook(op=>{if(op==='sync')throw Error('original sync error');});
 await assert.rejects(f.store.stage(f.authority),(e:unknown)=>e instanceof AggregateError&&e.errors.some(x=>String(x).includes('original sync'))&&e.errors.some(x=>String(x).includes('cleanup failure')));
 internal.removeUnlaunched=original;assert.equal(f.fds.size,0);assert.equal(fs.readdirSync(f.owned).length,1);
});
test('legacy direct materialize and active refresh keep their original per-file policy',t=>{
 const f=fixture(t),shadow=f.store.materialize('completion',f.authority);f.events.length=0;
 const next=f.store.refreshCompletion(shadow,f.authority);assert.equal(f.events.filter(e=>e.op==='sync').length,0);
 assert.equal(f.events.filter(e=>e.op==='manifest-file').length,next.manifest.files.length+1);
 assert.equal(f.events.filter(e=>e.op==='directory').length,next.manifest.files.length+1);
});

test('uncertain close with descriptor reused by another file never closes the foreign descriptor',async t=>{
 const f=fixture(t,1),internal=f.store as unknown as {asyncIO:import('../../src/server/language/LanguageShadowStore').LanguageShadowAsyncIO},native=internal.asyncIO;
 let foreign:number|undefined,applied=false;
 internal.asyncIO={...native,async close(fd){await native.close(fd);if(!applied){applied=true;foreign=fs.openSync(join(f.root,'foreign-control'),'w+');assert.equal(foreign,fd,'native lowest free descriptor reused in controlled schedule');throw Error('close callback uncertain after success');}}};
 await assert.rejects(f.store.stage(f.authority));assert.ok(applied);assert.ok(foreign!==undefined);assert.equal(fs.fstatSync(foreign).isFile(),true);
 fs.writeFileSync(foreign,'still open');fs.closeSync(foreign);assert.equal(fs.readFileSync(join(f.root,'foreign-control'),'utf8'),'still open');assert.deepEqual(fs.readdirSync(f.owned),[]);
});
