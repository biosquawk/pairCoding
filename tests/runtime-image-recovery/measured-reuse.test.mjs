import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import path from 'node:path';
import { fixture,guard,hash,dockerModel,json,put } from './fixture.mjs';

// Only Docker is modeled. The real controller -> accepted f6a0 prepare/retention/client,
// private historical FS, two builds, two caches and durable receipts remain in use.
function measuredBuild(args,model,plan) {
 if(args[0]!=='build')return;
 const tag=args[args.indexOf('--tag')+1],job=plan.jobs.find(j=>j.request.imageTag===tag);
 assert.ok(job,'build must belong to the actual active reviewed job');
 const image=structuredClone(job.currentTagPin.observedImage);
 // First job: legitimate content-addressed reuse of the retained Spring image.
 // Second: genuine post-build reproduction of an old Pure ID absent at preflight.
 if(job.id===plan.jobs[1].id)image.Id=job.oldUnavailableId;
 model.images.set(image.Id,image);model.refs.set(tag,image.Id);
 model.events.push({type:'build',tag,id:image.Id});
 return {status:0,signal:null,stdout:'UNIT actual modeled build measured '+image.Id,stderr:''};
}
async function run(f,name,hook=()=>{}) {
 const plan=await f.plan(name),bytes=f.m.planBytes(plan),h=hash(bytes),gb=Buffer.from(JSON.stringify(guard(plan,h,f.dir))),model=dockerModel(plan);
 model.hook=args=>hook(args,model,plan)??measuredBuild(args,model,plan);
 return {plan,model,execute:()=>f.m.executeRecoveryPlan(bytes,h,gb,hash(gb),{spawnSync:model.spawn})};
}

test('NEW measured reuse: actual two prepares allow retained Spring ID and reproduced absent Pure ID; 11 role bindings, 10 unique IDs',async t=>{
 const f=await fixture(t),r=await run(f,'measured-reuse'),result=await r.execute();
 assert.equal(result.status,'RECOVERY2_PREPARE_ONLY_COMPLETE_NOT_CONSUMER_OR_PRODUCT_ACCEPTANCE');
 for(const type of ['build','create','rm'])assert.equal(r.model.events.filter(e=>e.type===type).length,2);
 assert.equal(r.model.containers.size,0);assert.equal(result.imageRetention.pins.length,10);
 assert.equal(result.requiredImageBindings.length,11);assert.equal(new Set(result.requiredImageBindings.map(b=>b.role+':'+b.job)).size,11);
 assert.equal(result.requiredImageBindings.filter(b=>b.role==='RUN').length,9);assert.equal(result.requiredImageBindings.filter(b=>b.role==='LANGUAGE').length,2);
 const leaves=result.jobs.map(j=>json(j.receipt.file));
 assert.equal(leaves[0].imageId,r.plan.jobs[0].currentTagPin.observedImage.Id);assert.equal(leaves[1].imageId,r.plan.jobs[1].oldUnavailableId);
 assert.notEqual(leaves[0].cacheEvidence.root,leaves[1].cacheEvidence.root);
 for(let i=0;i<2;i++){
  const job=r.plan.jobs[i],leaf=leaves[i],binding=result.requiredImageBindings.find(b=>b.role==='RUN'&&b.job===job.id);
  assert.deepEqual(leaf.request,job.request);assert.equal(binding.receipt.file,result.jobs[i].receipt.file);assert.equal(binding.pin.source,binding.receipt.file);
  assert.equal(binding.pin.observedImage.Id,leaf.imageId);assert.deepEqual(binding.pin.engine,r.plan.engine);
  assert.equal(binding.pin.manifestDigest,leaf.imageInspect.Descriptor.digest);assert.deepEqual(binding.pin.observedImage.Config,leaf.imageInspect.Config);
  assert.equal(leaf.toolchainHash,job.toolchainIdentity.toolchainHash);assert.equal(leaf.cacheEvidence.dependencies.actual.dependencySha256,job.request.dependencySha256);
  assert.equal(leaf.imageRetention.pins.length,9+i);assert.equal(binding.receipt.sha256,hash(fs.readFileSync(binding.receipt.file)));
 }
 for(const entry of result.imageRetention.pins)assert.equal(r.model.refs.get(entry.reference),entry.pin.observedImage.Id);
 const firstBuild=r.model.events.findIndex(e=>e.type==='build');for(const pin of r.plan.initialRequiredPins)assert.ok(r.model.events.slice(0,firstBuild).some(e=>e.type==='tag'&&e.id===pin.observedImage.Id));
 assert.equal(json(path.join(r.plan.options.outputRoot,'receipt.json')).status,result.status);
});

for(const field of ['Config','manifest'])test('NEW measured same-ID reuse rejects wrong '+field+' after actual build',async t=>{
 const f=await fixture(t);let afterBuild=false,dispatches;
 const r=await run(f,'wrong-'+field,(args,m,p)=>{
  if(args[0]!=='build')return;
  const raw=measuredBuild(args,m,p),image=m.images.get(p.jobs[0].currentTagPin.observedImage.Id);
  if(field==='Config')image.Config.Env=['FOREIGN_CONFIG=1'];else image.Descriptor.digest='sha256:'+hash('foreign manifest');
  afterBuild=true;dispatches=m.calls.length;return raw;
 });
 await assert.rejects(r.execute(),/identity changed|manifest/i);assert.equal(afterBuild,true);
 assert.equal(r.model.events.filter(e=>e.type==='create').length,0);assert.ok(r.model.calls.length>=dispatches);
 assert.equal(json(path.join(r.plan.options.outputRoot,'receipt.json')).status,'FAILED_RETAIN_AND_RECONCILE');
});

test('NEW valid reused ID does not excuse changed reviewed producer source',async t=>{
 const f=await fixture(t),file=path.join(f.o.producerRoot,'docker/runtime.Dockerfile'),before=fs.readFileSync(file);let count;
 const r=await run(f,'wrong-source',(args,m,p)=>{if(args[0]==='build'){const raw=measuredBuild(args,m,p);put(file,Buffer.concat([before,Buffer.from('\n# foreign source')]));count=m.calls.length;return raw;}});
 try{await assert.rejects(r.execute(),/accepted installed source changed/);assert.equal(r.model.calls.length,count);assert.equal(r.model.events.filter(e=>e.type==='create').length,0);}finally{put(file,before);}
});

test('NEW valid reused ID cannot bind a foreign job container',async t=>{
 const f=await fixture(t);let attacked=false;
 const r=await run(f,'foreign-binding',(args,m,p)=>{if(args[0]==='inspect'){const state=m.containers.get(args[1]);assert.ok(state);state.Config.Image=p.initialRequiredPins.find(pin=>pin.observedImage.Id!==p.jobs[0].currentTagPin.observedImage.Id).observedImage.Id;attacked=true;}});
 await assert.rejects(r.execute(),/terminal ownership uncertain/);assert.equal(attacked,true);
 assert.equal(r.model.events.filter(e=>e.type==='build').length,1);assert.equal(r.model.events.filter(e=>e.type==='create').length,1);assert.equal(r.model.events.filter(e=>e.type==='rm').length,0);
 assert.equal(json(path.join(r.plan.options.outputRoot,'receipt.json')).status,'FAILED_RETAIN_AND_RECONCILE');
});

test('NEW reuse policy still refuses unexpected old Pure presence BEFORE any mutation',async t=>{
 const f=await fixture(t),r=await run(f,'old-present',(args,m,p)=>{if(args[0]==='ps'){const image=structuredClone(p.jobs[0].currentTagPin.observedImage);image.Id=p.jobs[0].oldUnavailableId;m.images.set(image.Id,image);}});
 await assert.rejects(r.execute(),/historical missing ID unexpectedly present/);
 assert.equal(r.model.calls.some(a=>['tag','pull','build','create','start','rm'].includes(a[0])),false);
});
