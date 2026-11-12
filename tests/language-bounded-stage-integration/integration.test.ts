/** Native Node22/tsx finite Store composition, not real Gate/Factory/Docker/performance proof. */
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import threads from 'node:worker_threads';
import { syncBuiltinESMExports } from 'node:module';
import { dirname, join, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { LanguageShadowStore, LANGUAGE_DEPENDENCY_DIRECTORY as DEPS, type TrustedLanguageSnapshot, type LanguageShadowAsyncIO } from '../../src/server/language/LanguageShadowStore';
import { NodeLanguageJournalDurability } from '../../src/server/language/LanguageJournalDurability';
import { assertRealDirectory, readRegular, sha256 } from '../../src/server/language/LanguageProcessJournal';
import * as codec from '../../src/language/uriCodec';
import { fixture, observe, fds, noStage, treeWitness, canonical } from './store-fixture';
test('sync policy equivalence: complete source/dependency directories, bytes, overlays, spelling and exclusions',t=>{
  const f=fixture(t),shadow=f.store.materialize('completion',f.authority);
  assert.deepEqual(shadow.manifest.directories,[DEPS,DEPS+'/empty',DEPS+'/lib',DEPS+'/target','empty','日本語'].sort());
  assert.deepEqual(shadow.manifest.files.map(v=>v.path),[DEPS+'/lib/a.jar',DEPS+'/target/included.bin','binary.dat','inactive.py','main.py','zero.py','日本語/é.py'].sort());
  assert.equal(fs.readFileSync(join(shadow.workspaceDirectory,'inactive.py'),'utf8'),'inactive draft\n');
  assert.deepEqual(fs.readFileSync(join(shadow.workspaceDirectory,'binary.dat')),Buffer.from([0,255,128,1]));
  f.store.assertIntegrity(shadow);
});
for(const kind of ['symlink','hardlink','case','unicode','secret-dep','depth','unsafe-path'] as const)test('sync policy equivalence: reject '+kind,t=>{
  const f=fixture(t);
  if(kind==='symlink')fs.symlinkSync(join(f.project,'main.py'),join(f.project,'link.py'));
  if(kind==='hardlink')fs.linkSync(join(f.project,'main.py'),join(f.project,'linked.py'));
  if(kind==='case')f.put(f.project,'MAIN.py','collision');
  if(kind==='unicode'){f.put(f.project,'é.py','a');f.put(f.project,'e\u0301.py','b');}
  if(kind==='secret-dep')f.put(f.deps,'private.key','secret');
  if(kind==='depth'){let p=f.project;for(let i=0;i<33;i++){p=join(p,'d');fs.mkdirSync(p);}}
  if(kind==='unsafe-path')f.put(f.project,'CON.py','bad');
  assert.throws(()=>f.store.materialize('completion',f.authority));noStage(f);
});

test('bounded initial capture: complete native read results equal synchronous materialize; sources immutable; max4 and drained before any stage write',async t=>{
  const f=fixture(t),before={source:treeWitness(f.project),deps:treeWitness(f.deps)};
  const sync=f.store.materialize('completion',f.authority);let writes=0;
  const o=observe(t,f,(phase)=>{if(phase==='dispatch')assert.equal(fs.readdirSync(f.owned).length,1,'ONLY existing synchronous control tree');});
  const mkdir=fs.mkdirSync;fs.mkdirSync=((...args:Parameters<typeof fs.mkdirSync>)=>{if(String(args[0]).startsWith(f.owned)){writes++;assert.equal(o.active(),0,'all worker exits before first directory mutation');}return mkdir(...args);}) as typeof fs.mkdirSync;
  syncBuiltinESMExports();t.after(()=>{fs.mkdirSync=mkdir;syncBuiltinESMExports();});
  const token=await f.store.stage(f.authority);o.drained();assert.ok(writes>0);assert.ok(o.created()>0);assert.ok(o.max()<=4);
  const async=f.store.consumeStage(token,'completion');assert.deepEqual(canonical(async.manifest),canonical(sync.manifest));
  for(const file of sync.manifest.files){const bytes=readRegular(join(async.workspaceDirectory,file.path),file.bytes);assert.equal(sha256(bytes),file.sha256);assert.deepEqual(bytes,fs.readFileSync(join(sync.workspaceDirectory,file.path)));}
  assert.deepEqual({source:treeWitness(f.project),deps:treeWitness(f.deps)},before);
  assert.throws(()=>f.store.consumeStage(token,'completion'),/Unknown\/used/);
  console.log('BOUNDED_STAGE_WITNESS '+JSON.stringify({before,after:{source:treeWitness(f.project),deps:treeWitness(f.deps)},events:o.events,maxWorkers:o.max(),manifest:async.manifest,drainedFDs:fds(f.root)}));
});
for(const kind of ['empty','source-size','dependency-size','source-total','dependency-total','entries','bad-inventory','bad-hash','hardlink','secret-dep'] as const)test('admission before dispatch and no stage publication: '+kind,async t=>{
  const f=fixture(t);
  if(kind==='empty'){for(const p of [f.project,f.deps]){fs.rmSync(p,{recursive:true});fs.mkdirSync(p);}f.snapshot.overlays=[];f.reset();}
  if(kind==='source-size'||kind==='dependency-size'){const p=join(kind==='source-size'?f.project:f.deps,'large.bin');const fd=fs.openSync(p,'w');fs.ftruncateSync(fd,(kind==='source-size'?4:64)*1024*1024+1);fs.closeSync(fd);}
  if(kind==='source-total'||kind==='dependency-total'){const base=kind==='source-total'?f.project:f.deps,unit=kind==='source-total'?4:64,count=kind==='source-total'?17:5;for(let i=0;i<count;i++){const fd=fs.openSync(join(base,'sparse'+i),'w');fs.ftruncateSync(fd,unit*1024*1024);fs.closeSync(fd);}}
  if(kind==='entries')for(let i=0;i<16001;i++)fs.writeFileSync(join(f.project,'e'+i),'');
  if(kind==='bad-inventory')f.snapshot.files=f.snapshot.files.slice(1);
  if(kind==='bad-hash')f.snapshot.files=f.snapshot.files.map((v,i)=>i? v:{...v,sha256:'bad'});
  if(kind==='hardlink')fs.linkSync(join(f.project,'main.py'),join(f.project,'linked.py'));
  if(kind==='secret-dep')f.put(f.deps,'private.key','secret');
  // Admission test authority intentionally attests ONLY held vector, not an eager duplicate disk scan.
  const authority={capture:()=>f.snapshot,isCurrent:()=>true},o=observe(t,f);
  if(kind==='empty'){const token=await f.store.stage(authority);const shadow=f.store.consumeStage(token,'diagnostics');assert.deepEqual(shadow.manifest.files,[]);assert.equal(shadow.phase,'diagnostics');assert.equal(o.created(),0);}
  else {await assert.rejects(f.store.stage(authority));assert.equal(o.created(),0);noStage(f);}
  o.drained();
});
for(const kind of ['source','dependency','inactive-overlay','inactive-stamp','revoke','root','parent','new-empty','growth','symlink-race','hardlink-race'] as const)test('native worker-await race rejects only AFTER all exits/FD drain: '+kind,async t=>{
  const f=fixture(t);let applied=false;
  const o=observe(t,f,(phase,path)=>{if(applied||phase!=='dispatch'||(kind==='dependency'&&!path.startsWith(f.deps)))return;applied=true;
    assert.deepEqual(fs.readdirSync(f.owned),[],'no initial stage directory/token before proof');
    if(kind==='source')fs.writeFileSync(join(f.project,'main.py'),'DIFF!\n');
    if(kind==='dependency')fs.writeFileSync(join(f.deps,'lib/a.jar'),Buffer.from([8,7,6]));
    if(kind==='inactive-overlay')f.overlay('inactive.py','changed inactive',2);
    if(kind==='inactive-stamp')f.overlay('inactive.py','inactive draft\n',2);
    if(kind==='revoke')f.revoke();
    if(kind==='root'){fs.renameSync(f.project,f.project+'-old');fs.cpSync(f.project+'-old',f.project,{recursive:true});}
    if(kind==='parent'){fs.renameSync(join(f.project,'日本語'),join(f.project,'old-parent'));fs.mkdirSync(join(f.project,'日本語'));fs.writeFileSync(join(f.project,'日本語/é.py'),'unicode\n');}
    if(kind==='new-empty')fs.mkdirSync(join(f.project,'new-empty'));
    if(kind==='growth')fs.appendFileSync(path,'grew');
    if(kind==='symlink-race'){fs.unlinkSync(path);fs.symlinkSync(join(f.project,'inactive.py'),path);}
    if(kind==='hardlink-race'){fs.unlinkSync(path);fs.linkSync(join(f.project,'inactive.py'),path);}
  });
  await assert.rejects(f.store.stage(f.authority));assert.ok(applied);o.drained();noStage(f);assert.ok(o.created()<=8);
  console.log('DRAIN_WITNESS '+JSON.stringify({kind,events:o.events,openFDs:fds(f.root),stageEntries:fs.readdirSync(f.owned)}));
});
for(const kind of ['source','dependency','inactive-overlay','new-empty','private-byte'] as const)test('unchanged final synchronous consume proof rejects later '+kind,async t=>{
  const f=fixture(t),o=observe(t,f),token=await f.store.stage(f.authority);o.drained();
  if(kind==='source')fs.writeFileSync(join(f.project,'main.py'),'later');
  if(kind==='dependency')fs.writeFileSync(join(f.deps,'lib/a.jar'),'later');
  if(kind==='inactive-overlay')f.overlay('inactive.py','later');
  if(kind==='new-empty')fs.mkdirSync(join(f.project,'later-empty'));
  if(kind==='private-byte'){const p=join(f.owned,fs.readdirSync(f.owned)[0],'workspace/main.py');fs.chmodSync(p,0o600);fs.writeFileSync(p,'tampered');}
  assert.throws(()=>f.store.consumeStage(token,'completion'));noStage(f);assert.throws(()=>f.store.consumeStage(token,'completion'),/Unknown\/used/);
});
for(const fail of [false,true])test('existing native async WRITE waves '+(fail?'drain on error before cleanup':'max4 fsync/close before rename; manifest after bottom-up flush'),async t=>{
  const f=fixture(t),o=observe(t,f),events:{kind:string;path:string}[]=[],paths=new Map<number,string>();let active=0,max=0,fault=false;
  const io:LanguageShadowAsyncIO={
    open:(path,flags,mode)=>new Promise((resolve,reject)=>fs.open(path,flags,mode,(error,fd)=>{if(error){reject(error);return;}paths.set(fd,path);active++;max=Math.max(max,active);events.push({kind:'open',path});resolve(fd);})),
    writeFile:(fd,bytes)=>new Promise((resolve,reject)=>fs.writeFile(fd,bytes,error=>{events.push({kind:'write',path:paths.get(fd)!});if(error)reject(error);else if(fail&&!fault){fault=true;reject(Error('NEW native write completion fault'));}else resolve();})),
    chmod:(fd,mode)=>new Promise((resolve,reject)=>fs.fchmod(fd,mode,error=>error?reject(error):resolve())),
    sync:fd=>new Promise((resolve,reject)=>fs.fsync(fd,error=>{events.push({kind:'fsync',path:paths.get(fd)!});error?reject(error):resolve();})),
    close:fd=>new Promise((resolve,reject)=>fs.close(fd,error=>{events.push({kind:'close',path:paths.get(fd)!});active--;paths.delete(fd);error?reject(error):resolve();})),
  };
  const real=new NodeLanguageJournalDurability(assertRealDirectory);
  const store=new LanguageShadowStore(f.owned,codec,{policy:real.policy,file(fd){real.file(fd);events.push({kind:'manifest-file-fsync',path:fs.readlinkSync('/proc/self/fd/'+fd)});},directory(path){real.directory(path);events.push({kind:'dir-fsync',path});}},io);
  const rename=fs.renameSync;fs.renameSync=((a,b)=>{assert.equal(paths.has([...paths.entries()].find(([,p])=>p===String(a))?.[0]??-1),false,'descriptor closed BEFORE rename');rename(a,b);events.push({kind:'rename',path:String(b)});}) as typeof fs.renameSync;
  const rm=fs.rmSync;fs.rmSync=((...args:Parameters<typeof fs.rmSync>)=>{if(String(args[0]).startsWith(f.owned)){assert.equal(active,0,'ALL pending writes/FDs close BEFORE cleanup');o.drained();}return rm(...args);}) as typeof fs.rmSync;
  syncBuiltinESMExports();t.after(()=>{fs.renameSync=rename;fs.rmSync=rm;syncBuiltinESMExports();});
  if(fail){await assert.rejects(store.stage(f.authority),/native write completion fault/);assert.ok(fault);assert.ok(events.filter(e=>e.kind==='open').length<=4,'no next wave after error');noStage(f);}
  else {const token=await store.stage(f.authority);assert.ok(!events.some(e=>e.kind==='manifest-file-fsync'),'no manifest/readiness before consume');const shadow=store.consumeStage(token,'completion');assert.equal(events.filter(e=>e.kind==='manifest-file-fsync').length,1);const mi=events.findIndex(e=>e.kind==='manifest-file-fsync');assert.ok(events.slice(0,mi).some(e=>e.kind==='dir-fsync'&&e.path===f.owned));
    for(const [i,e] of events.entries())if(e.kind==='rename'&&e.path.startsWith(shadow.workspaceDirectory)){const temp=events.slice(0,i).filter(v=>v.kind==='close').at(-1);assert.ok(temp);const target=events.filter(v=>v.path===temp!.path).map(v=>v.kind);assert.deepEqual(target,['open','write','fsync','close']);}
    const dirs=events.slice(0,mi).filter(e=>e.kind==='dir-fsync').map(e=>e.path);const ws=shadow.workspaceDirectory;assert.ok(dirs.indexOf(join(ws,DEPS,'lib'))<dirs.indexOf(join(ws,DEPS)));assert.ok(dirs.indexOf(join(ws,DEPS))<dirs.indexOf(ws));store.assertIntegrity(shadow);
  }
  assert.equal(active,0);assert.ok(max<=4);assert.ok(max>1);o.drained();
  console.log('WRITE_DRAIN_WITNESS '+JSON.stringify({fail,max,events,workers:o.events,openFDs:fds(f.root)}));
});
test('outer captureStage await is itself a revocation fence before directory mutation',async t=>{
  const f=fixture(t),o=observe(t,f);let captures=0;
  const authority={...f.authority,capture:()=>{if(++captures===2)queueMicrotask(()=>f.revoke());return f.snapshot;}};
  await assert.rejects(f.store.stage(authority),/Stale/);assert.equal(captures,2);o.drained();noStage(f);
});
test('copied frozen ALL-overlay vector rejects in-place trusted lease alias mutation even with permissive currentness seam',async t=>{
  const f=fixture(t);let applied=false;const o=observe(t,f,phase=>{if(!applied&&phase==='dispatch'){applied=true;f.overlay('inactive.py','inactive draft\n',2);}});
  await assert.rejects(f.store.stage({capture:()=>f.snapshot,isCurrent:()=>true}),/Changed staged capture/);assert.ok(applied);o.drained();noStage(f);
});
test('native bytes must match full valid trusted SHA inventory, not only discovery size',async t=>{
  const f=fixture(t);f.snapshot.files=f.snapshot.files.map((v,i)=>i?v:{...v,sha256:'0'.repeat(64)});const o=observe(t,f);
  await assert.rejects(f.store.stage({capture:()=>f.snapshot,isCurrent:()=>true}),/manifest mismatch/);assert.ok(o.created()>0);o.drained();noStage(f);
});
