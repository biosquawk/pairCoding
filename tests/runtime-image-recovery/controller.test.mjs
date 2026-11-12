import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import path from 'node:path';
import { fixture,root,originalOptions,load,guard,hash,dockerModel,json,put } from './fixture.mjs';

test('UNMODIFIED read-only planner binds actual staged f6a0 and all 9 historical cache roots',async t=>{
 const dir=root(t),m=await load(),out=path.join(dir,'not-created');const before=fs.readdirSync(dir);
 const p=await m.buildRecoveryPlan(originalOptions(out));
 assert.equal(p.historical.cacheInventories.length,9);assert.equal(p.historical.cacheInventories.reduce((n,c)=>n+c.files,0),13355);assert.equal(p.historical.cacheInventories.reduce((n,c)=>n+c.bytes,0),456867366);
 assert.equal(p.sourceInventory.length,19);assert.deepEqual(p.jobs.map(j=>j.id),['java-maven-21--java-pattern','java-maven-27--java-pattern']);assert.deepEqual(fs.readdirSync(dir),before);assert.equal(fs.existsSync(out),false);
});

test('finite actual controller -> actual accepted prepare/retention with private FS and injected Docker ONLY',async t=>{
 const f=await fixture(t),plan=await f.plan('success'),bytes=f.m.planBytes(plan),h=hash(bytes),g=Buffer.from(JSON.stringify(guard(plan,h,f.dir))),m=dockerModel(plan);
 const result=await f.m.executeRecoveryPlan(bytes,h,g,hash(g),{spawnSync:m.spawn});
 assert.equal(result.status,'RECOVERY2_PREPARE_ONLY_COMPLETE_NOT_CONSUMER_OR_PRODUCT_ACCEPTANCE');
 assert.equal(m.events.filter(e=>e.type==='build').length,2);assert.equal(m.events.filter(e=>e.type==='create').length,2);assert.equal(m.events.filter(e=>e.type==='rm').length,2);assert.equal(m.containers.size,0);assert.ok(m.calls.length<=1024);
 const firstBuild=m.events.findIndex(e=>e.type==='build');for(const pin of plan.initialRequiredPins)assert.ok(m.events.slice(0,firstBuild).some(e=>e.type==='tag'&&e.id===pin.observedImage.Id),'all9 retained before first actual prepare build');
 assert.equal(result.imageRetention.pins.length,11);for(const e of result.imageRetention.pins){assert.ok(m.images.has(e.pin.observedImage.Id));assert.equal(m.refs.get(e.reference),e.pin.observedImage.Id);}
 assert.equal(result.jobs.length,2);assert.equal(json(path.join(plan.options.outputRoot,'receipt.json')).status,result.status);
 for(let i=0;i<2;i++){const leaf=json(result.jobs[i].receipt.file);assert.equal(leaf.imageRetention.pins.length,10+i);assert.equal(leaf.request.tools.root,plan.jobs[i].request.tools.root);}
});

test('NEW fail-closed hash/scope/source/output/guard cases have zero Docker dispatch and no output',async t=>{
 const f=await fixture(t);
 const attempt=async (name,edit,guardEdit=null)=>{
  const plan=await f.plan(name),bytes=f.m.planBytes(edit?edit(structuredClone(plan)):plan),h=hash(bytes),g=guard(plan,h,f.dir);if(guardEdit)guardEdit(g,plan);
  const gb=Buffer.from(JSON.stringify(g));let calls=0;
  await assert.rejects(f.m.executeRecoveryPlan(bytes,h,gb,hash(gb),{spawnSync:()=>{calls++;assert.fail('invalid plan/guard must not dispatch');}}));
  assert.equal(calls,0);assert.equal(fs.existsSync(plan.options.outputRoot),false);
 };
 await t.test('extra job/scope field is not execute authority',()=>attempt('extra-job',p=>{p.jobs.push(p.jobs[0]);return p;}));
 await t.test('tampered source inventory',()=>attempt('inventory',p=>{p.sourceInventory[0].sha256='f'.repeat(64);return p;}));
 await t.test('unknown schema member',()=>attempt('extra-member',p=>({...p,grantHostAdmission:true})));
 for(const [name,change] of [
  ['wrong-plan',g=>g.planSha256='0'.repeat(64)],['wrong-controller',g=>g.controllerSha256='0'.repeat(64)],['wrong-closure',g=>g.closureSha256='0'.repeat(64)],
  ['wrong-engine',g=>g.engine={...g.engine,ID:'OTHER'}],['wrong-base',g=>g.base='0'.repeat(40)],['future',g=>g.observedAtMs=Date.now()+600000],['stale',g=>g.observedAtMs=Date.now()-60001],
  ['no-lane',g=>g.singleHeavyLane=false],['low-vm',g=>g.measurements.vm.freeBytes=15*1024**3-1],['nonfinite-physical',g=>g.measurements.physical.freeBytes=null],
  ['wrong-storage',g=>g.measurements.host.storagePath='/other'],['raw-evidence-mismatch',g=>g.measurements.vm.evidenceSha256='f'.repeat(64)],
 ])await t.test(name,()=>attempt('guard-'+name,null,change));
 await t.test('wrong exact plan bytes SHA',async()=>{const p=await f.plan('wrong-hash');let called=0;await assert.rejects(f.m.executeRecoveryPlan(f.m.planBytes(p),'0'.repeat(64),Buffer.from('{}'),'0'.repeat(64),{spawnSync:()=>called++}),/plan bytes hash/);assert.equal(called,0);assert.equal(fs.existsSync(p.options.outputRoot),false);});
 await t.test('tampered exact guard SHA',async()=>{const p=await f.plan('guard-hash'),b=f.m.planBytes(p),h=hash(b);await assert.rejects(f.m.executeRecoveryPlan(b,h,Buffer.from(JSON.stringify(guard(p,h,f.dir))),'0'.repeat(64)),/guard receipt hash/);assert.equal(fs.existsSync(p.options.outputRoot),false);});
 await t.test('installed accepted producer source drift',async()=>{const file=path.join(f.o.producerRoot,'scripts/runtime-image-retention.mjs'),before=fs.readFileSync(file);try{put(file,Buffer.concat([before,Buffer.from('\n// drift')]));await assert.rejects(f.plan('source-drift'),/installed source changed/);}finally{put(file,before);}});
 await t.test('protected source output overlap',async()=>{await assert.rejects(f.m.buildRecoveryPlan({...f.o,outputRoot:path.join(f.o.producerRoot,'new-output')}),/overlaps/);});
 await t.test('symlink output parent',async()=>{fs.symlinkSync(f.dir,path.join(f.dir,'alias'));await assert.rejects(f.m.buildRecoveryPlan({...f.o,outputRoot:path.join(f.dir,'alias/output')}),/ancestry\/link/);});
 await t.test('ALL9 caches including old missing Pure are fully read and linked files rejected',async()=>{const c=json(f.o.cacheSnapshotFile).roots.find(c=>c.job==='java-maven-21--java-pattern'),file=path.join(c.root,'old-artifact.bin'),before=fs.readFileSync(file);try{put(file,'tampered missing-Pure cache');await assert.rejects(f.plan('cache-drift'),/ALL9 historical cache bytes differ/);}finally{put(file,before);}fs.linkSync(file,path.join(c.root,'hardlink'));try{await assert.rejects(f.plan('cache-link'),/no-link/);}finally{fs.unlinkSync(path.join(c.root,'hardlink'));}});
});

test('NEW image/transport/UNKNOWN/publication guard failures stop; images are not cache proof',async t=>{
 const f=await fixture(t);
 const failure=async(name,hook,pattern)=>{
  const p=await f.plan(name),b=f.m.planBytes(p),h=hash(b),gb=Buffer.from(JSON.stringify(guard(p,h,f.dir))),m=dockerModel(p);m.hook=(args)=>hook(args,m,p);
  await assert.rejects(f.m.executeRecoveryPlan(b,h,gb,hash(gb),{spawnSync:m.spawn}),pattern);
  const result=json(path.join(p.options.outputRoot,'receipt.json'));assert.notEqual(result.status,'RECOVERY2_PREPARE_ONLY_COMPLETE_NOT_CONSUMER_OR_PRODUCT_ACCEPTANCE');return {p,m,result};
 };
 const noMutation=m=>assert.equal(m.calls.some(a=>['tag','build','create','pull','start','rm'].includes(a[0])),false);
 await t.test('one of nine missing before retain',async()=>{const r=await failure('missing-nine',(a,m,p)=>{if(a[0]==='ps')m.images.delete(p.initialRequiredPins[8].observedImage.Id);},/failed|unknown/i);noMutation(r.m);});
 await t.test('same-ID wrong full Config before retain',async()=>{const r=await failure('config-drift',(a,m,p)=>{if(a[0]==='ps')m.images.get(p.initialRequiredPins[0].observedImage.Id).Config.Env=['CHANGED'];},/identity changed/);noMutation(r.m);});
 await t.test('known Spring mutable tag drift',async()=>{const r=await failure('tag-drift',(a,m,p)=>{if(a[0]==='ps')m.refs.set(p.jobs[0].request.imageTag,p.initialRequiredPins[0].observedImage.Id);},/identity changed|manifest/i);noMutation(r.m);});
 await t.test('historical missing Pure image unexpectedly present',async()=>{const r=await failure('old-present',(a,m,p)=>{if(a[0]==='ps'){const image=structuredClone(p.initialRequiredPins[0].observedImage);image.Id=p.jobs[0].oldUnavailableId;m.images.set(image.Id,image);}},/unexpectedly present/);noMutation(r.m);});
 await t.test('owned running before mutation',async()=>{const r=await failure('owned-running',a=>a[0]==='ps'?{status:0,stdout:'abc123\n',stderr:''}:undefined,/owned running/);noMutation(r.m);});
 await t.test('actual same-engine drift',async()=>{const r=await failure('engine-drift',(a,m)=>a[0]==='info'?{status:0,stdout:JSON.stringify({...m.engine,ID:'wrong'}),stderr:''}:undefined,/actual engine changed/);noMutation(r.m);});
 await t.test('conflicting retained reference stops without overwriting',async()=>{let target;const r=await failure('ref-conflict',(a,m,p)=>{if(a[0]==='ps'){target=json(p.options.proposalFile).preserveRun[0].proposedRetainedReference;m.refs.set(target,p.initialRequiredPins[1].observedImage.Id);}},/manifest|identity/i);assert.equal(r.m.calls.some(a=>a[0]==='tag'&&a[2]===target),false);assert.equal(r.m.events.some(e=>e.type==='build'),false);});
 for(const op of ['tag','build'])await t.test('UNKNOWN/lost reply '+op+' is durable and no later dispatch',async()=>{let count;const r=await failure('unknown-'+op,(a,m)=>{if(a[0]===op){count=m.calls.length;return {status:null,error:new Error('UNIT lost reply'),stdout:'',stderr:''};}},/UNKNOWN/);assert.equal(r.m.calls.length,count);assert.equal(r.result.commands.at(-1).status,'UNKNOWN_RETAIN_AND_RECONCILE');if(op==='tag')assert.equal(r.result.imageRetention.operations.at(-1).status,'TAG_INTENT');});
 await t.test('publication failure after dispatch retains intent, no later Docker mutation',async()=>{let count;const r=await failure('publish-failure',(a,m,p)=>{if(a[0]==='tag'){put(path.join(p.options.outputRoot,'receipt.tmp'),'foreign concurrent publication');count=m.calls.length;}},/EEXIST/);assert.equal(r.m.calls.length,count);assert.equal(r.result.commands.at(-1).status,'INTENT');assert.equal(r.result.imageRetention.operations.at(-1).status,'TAG_INTENT');});
 await t.test('expiry during inventory/preflight stops immediately before first tag',async()=>{const old=Date.now;try{let shifted=false;const r=await failure('late-expiry',(a,m,p)=>{if(a[0]==='image'&&a[2]===p.jobs[1].request.imageTag){shifted=true;Date.now=()=>old()+61000;}},/guard expired/);assert.equal(shifted,true);noMutation(r.m);}finally{Date.now=old;}});
 await t.test('old cache tamper with all images still valid blocks before mutation',async()=>{const c=json(f.o.cacheSnapshotFile).roots[8],file=path.join(c.root,'old-artifact.bin'),before=fs.readFileSync(file);try{const r=await failure('cache-after-plan',(a)=>{if(a[0]==='ps')put(file,'tampered after plan');},/old cache|bytes or identity/);noMutation(r.m);}finally{put(file,before);}});
 await t.test('post-two-prepare old missing-Pure cache tamper blocks final publication with valid final11 images',async()=>{const c=json(f.o.cacheSnapshotFile).roots[8],file=path.join(c.root,'old-artifact.bin'),before=fs.readFileSync(file);try{let removes=0;const r=await failure('final-cache-tamper',(a)=>{if(a[0]==='rm'&&++removes===2)put(file,'tamper after two actual prepares');},/old cache|bytes or identity/);assert.equal(r.m.events.filter(e=>e.type==='build').length,2);assert.equal(r.m.images.size,11);assert.equal(r.result.status,'FAILED_RETAIN_AND_RECONCILE');assert.equal(r.result.imageRetention.status,'ALL_REQUIRED_IDS_AND_REFERENCES_EXACT_CHECKED');}finally{put(file,before);}});
 await t.test('old receipt tamper with valid images stops before mutation',async()=>{const file=f.p.preserveRun[0].leafReceipt.file,before=fs.readFileSync(file);try{const r=await failure('receipt-after-plan',(a)=>{if(a[0]==='ps')put(file,Buffer.concat([before,Buffer.from(' ')]));},/historical\/source file bytes differ/);noMutation(r.m);}finally{put(file,before);}});
});

test('NEW exact inventory and shared dispatch budget boundaries (no Docker)',async t=>{
 const dir=root(t),m=await load(),file=path.join(dir,'file');put(file,'before');const before=m.inventory(dir);put(file,'after');assert.notDeepEqual(m.inventory(dir),before);
 assert.doesNotThrow(()=>m.assertCommandBudget(1023,100,99));assert.throws(()=>m.assertCommandBudget(1024,100,99),/count/);assert.throws(()=>m.assertCommandBudget(0,100,100),/budget/);assert.throws(()=>m.assertCommandBudget(-1,100,0),/budget/);
 const bound=path.join(dir,'too-big');fs.writeFileSync(bound,'');fs.truncateSync(bound,128*1024*1024+1);assert.throws(()=>m.inventory(dir),/byte ceiling/);
});
