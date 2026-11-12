/** New finite UNIT cases. Actual public/operator -> actual producer -> injected OCI model.
 * No real tools/download/containers/native, and no nine-preparation/offline campaign. */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import path from 'node:path';
import { fixture, dockerModel, put, json, hash } from './fixture.mjs';
const configAbsent = p => assert.equal(fs.existsSync(p.runtimeConfig),false);
async function publicPlan(f,name) {
 const project=f.project(name),output=path.join(f.root,name+'-output');
 return f.cli.buildPublicPreparePlan(['--project',project,'--profile','javascript-node','--output',output]);
}
function languageUnit(root,lock,{run,save,receipt}) {
 receipt.language=[];
 for(const name of ['jdt','pylsp']){
  const tag='paircoach/language-'+name+':stage09';run(['build','--pull=false','--network=none','--tag',tag,'UNIT-context-no-real-build']);
  const actual=JSON.parse(run(['image','inspect',tag]).stdout)[0];receipt.language.push({observedImage:actual,imageTag:tag,engine:receipt.engine});save();
 }
}
async function operatorFixture(t) {
 const f=await fixture(t),root=path.join(f.root,'operator');fs.mkdirSync(root,{mode:0o700});f.stageTools(path.join(root,'stage/tools'));
 fs.mkdirSync(path.join(root,'download-journal'));put(path.join(root,'download-journal/receipt.json'),{status:'STAGED_NOT_PREPARED'});
 const plan=f.operator.buildOperatorPlan(root);plan.jobs=plan.jobs.filter(j=>['java-maven-21--java-pattern','java-maven-21--spring-counter'].includes(j.id));
 const model=dockerModel(plan.operatorEngine);
 const deps={buildPlan:()=>structuredClone(plan),spawnSync:model.spawn,prepareLanguageImages:languageUnit};
 return {f,root,plan,model,deps};
}
test('REGRESSION public actual producer: two independent same-profile outputs retain first OCI index before retarget',async t=>{
 const f=await fixture(t),m=dockerModel(),p=await publicPlan(f,'pure'),q=await publicPlan(f,'later');
 const first=await f.cli.executePublicPreparePlan(p,{stageInputs:f.stage,spawnSync:m.spawn});
 assert.equal(first.status,'PREPARED_CONFIG_GENERATED_NOT_ACCEPTANCE');const id=json(path.join(p.preparedRuntime,'receipt.json')).imageId;
 const oldCache=json(path.join(p.preparedRuntime,'receipt.json')).cacheEvidence,cacheHash=hash(fs.readFileSync(path.join(oldCache.root,'tools.json')));
 const second=await f.cli.executePublicPreparePlan(q,{stageInputs:f.stage,spawnSync:m.spawn});
 assert.equal(second.status,'PREPARED_CONFIG_GENERATED_NOT_ACCEPTANCE');assert.ok(m.images.has(id),'old OCI index remains available, not merely its cache');assert.deepEqual(m.removed,[]);
 const builds=m.calls.map((a,i)=>[a,i]).filter(([a])=>a[0]==='build');assert.equal(builds.length,2);
 assert.ok(m.calls.some((a,i)=>a[0]==='tag'&&a[1]===id&&i<builds[1][1]),'retention before second mutable tag retarget');
 assert.equal(hash(fs.readFileSync(path.join(oldCache.root,'tools.json'))),cacheHash,'earlier cache bytes unchanged');
 const outer=json(path.join(q.output,'receipt.json'));assert.equal(outer.imageRetention.pins.length,2,'leaf inferred prior identity propagated to public final proof');
 for(const entry of outer.imageRetention.pins){assert.ok(m.images.has(entry.pin.observedImage.Id));assert.equal(m.refs.get(entry.reference),entry.pin.observedImage.Id);}
});
test('REGRESSION public boundary catches prior pin loss with unchanged old cache and publishes no usable config',async t=>{
 const f=await fixture(t),m=dockerModel(),p=await publicPlan(f,'one'),q=await publicPlan(f,'two');
 await f.cli.executePublicPreparePlan(p,{stageInputs:f.stage,spawnSync:m.spawn});const first=json(path.join(p.preparedRuntime,'receipt.json')),bytes=fs.readFileSync(path.join(first.cacheEvidence.root,'tools.json'));
 await assert.rejects(f.cli.executePublicPreparePlan(q,{stageInputs:f.stage,spawnSync:m.spawn,prepare:(...args)=>{
  const result=f.producer.prepare(...args);m.images.delete(first.imageId);return result;
 }}),/Unknown\/failed Docker operation/);
 configAbsent(q);assert.deepEqual(fs.readFileSync(path.join(first.cacheEvidence.root,'tools.json')),bytes);assert.equal(m.builds.length,2);
 assert.equal(json(path.join(q.output,'receipt.json')).status,'FAILED_RETAIN_AND_RECONCILE');
});
test('UNIT finite two-job operator -> actual producer Pure21/Spring21 protects first index and both LANGUAGE pins',async t=>{
 const {root,plan,model:m,deps,f}=await operatorFixture(t);
 const result=f.operator.executeOperatorPlan(plan,deps);assert.equal(result.status,'PREPARE_ONLY_COMPLETE_OFFLINE_DEFERRED_NOT_PRODUCT_ACCEPTANCE');
 assert.equal(result.jobs.length,2);assert.equal(m.builds.length,4,'two Run + two stub language builds; zero offline/probes');assert.deepEqual(m.removed,[]);assert.equal(m.containers.size,0);
 const first=json(path.join(plan.jobs[0].request.outputRoot,'receipt.json'));assert.ok(m.images.has(first.imageId));
 assert.equal(result.imageRetention.pins.length,4);for(const entry of result.imageRetention.pins)assert.ok(m.images.has(entry.pin.observedImage.Id));
 assert.equal(json(path.join(root,'session/receipt.json')).imageRetention.status,'ALL_REQUIRED_IDS_AND_REFERENCES_EXACT_CHECKED');
});
test('UNIT finite operator final check detects old pin loss after LANGUAGE with unchanged cache',async t=>{
 const {plan,model:m,deps,f,root}=await operatorFixture(t);let savedBytes,firstId;
 deps.prepareLanguageImages=(...args)=>{
  const first=json(path.join(plan.jobs[0].request.outputRoot,'receipt.json'));firstId=first.imageId;savedBytes=fs.readFileSync(path.join(first.cacheEvidence.root,'tools.json'));
  languageUnit(...args);m.images.delete(firstId);
 };
 assert.throws(()=>f.operator.executeOperatorPlan(plan,deps),/Unknown\/failed Docker operation/);const first=json(path.join(plan.jobs[0].request.outputRoot,'receipt.json'));
 assert.deepEqual(fs.readFileSync(path.join(first.cacheEvidence.root,'tools.json')),savedBytes);assert.equal(first.imageId,firstId);
 assert.equal(json(path.join(root,'session/receipt.json')).status,'FAILED_RETAIN_AND_RECONCILE');assert.equal(m.builds.length,4);
});
test('UNIT public unknown tag or build outcome stops with durable intent and no subsequent Docker mutation',async t=>{
 for(const failure of ['tag','build']){
  const f=await fixture(t),m=dockerModel(),p=await publicPlan(f,'unknown-'+failure);let failed=false,count;
  m.hook=args=>{if(args[0]===failure){failed=true;count=m.calls.length;return {status:null,error:new Error('UNIT UNKNOWN'),stdout:'',stderr:''};}};
  await assert.rejects(f.cli.executePublicPreparePlan(p,{stageInputs:f.stage,spawnSync:m.spawn}));
  assert.equal(failed,true);assert.equal(m.calls.length,count,'no later Docker calls (not even retry)');configAbsent(p);
  const leaf=json(path.join(p.preparedRuntime,'receipt.json'));assert.equal(leaf.status,'FAILED_RETAIN_AND_RECONCILE');
  if(failure==='tag')assert.equal(leaf.imageRetention.operations.at(-1).status,'TAG_INTENT');else assert.equal(leaf.imageRetention.status,'RETAINED_BEFORE_MUTABLE_RETARGET');
  assert.equal(m.calls.some(a=>a[0]==='create'),false);
 }
});
test('UNIT validation and PLAN_ONLY still have zero child/retention writes',async t=>{
 const f=await fixture(t),m=dockerModel(),p=await publicPlan(f,'plan');assert.equal(m.calls.length,0);assert.equal(fs.existsSync(p.output),false);
 await assert.rejects(f.cli.executePublicPreparePlan({...p,dependencySha256:'0'.repeat(64)},{spawnSync:()=>assert.fail('tampered plan must not invoke child')}),/changed/);
 assert.equal(fs.existsSync(p.output),false);
});
test('UNIT remainder retains explicit reused leaf pin and refuses conflicting ref before any new preparation',async t=>{
 const f=await fixture(t),m=dockerModel(),p=await publicPlan(f,'reuse');await f.cli.executePublicPreparePlan(p,{stageInputs:f.stage,spawnSync:m.spawn});
 const remainder=await f.load('runtime-operator-remainder.mjs');
 const job={id:'javascript-node--javascript-counter',profile:p.profile,request:p.request};
 const reused=remainder.verifyPreparedReuse(job,m.actualEngine); // actual durable producer and qualified exact-rm evidence
 const {imagePin,retentionReference}=await f.load('runtime-image-retention.mjs'),leaf=json(reused.receipt.file),pin=imagePin(m.actualEngine,leaf.imageInspect,reused.receipt.file);
 const foreign={...structuredClone(leaf.imageInspect),Id:'sha256:'+'f'.repeat(64)};
 const ref=retentionReference(pin);m.refs.delete(ref);m.seed(ref,foreign); // explicit adversarial conflict
 const root=path.join(f.root,'remainder'),plan={options:{outputRoot:root},phase:'PREPARE_ONLY_REMAINDER_AFTER_REVIEWED_FAILURE',engine:m.actualEngine,sourceInventory:[],maxElapsedMs:2700000,maxCommandMs:480000,reuse:[reused],failure:{exactContainerId:'a'.repeat(64)}};
 const at=m.calls.length;m.hook=args=>args[0]==='container'?{status:1,stdout:'',stderr:'Error: No such container: '+plan.failure.exactContainerId}:undefined;
 assert.throws(()=>remainder.executeRemainderPlan(plan,{buildPlan:()=>structuredClone(plan),spawnSync:m.spawn,prepare:()=>assert.fail('conflicting retention must prevent prepare')}),/identity changed/);
 assert.equal(m.calls.slice(at).some(a=>['tag','build','create','pull'].includes(a[0])),false);
 assert.equal(json(path.join(root,'receipt.json')).status,'FAILED_RETAIN_AND_RECONCILE');assert.deepEqual(json(reused.receipt.file),leaf);
});
test('UNIT actual public/producer engine drift after tag is durable failure before cache create',async t=>{
 const f=await fixture(t),m=dockerModel(),p=await publicPlan(f,'engine-drift');
 m.hook=args=>args[0]==='info'&&m.calls.some(a=>a[0]==='tag')?{status:0,stdout:JSON.stringify({...m.actualEngine,ID:'other-engine'}),stderr:''}:undefined;
 await assert.rejects(f.cli.executePublicPreparePlan(p,{stageInputs:f.stage,spawnSync:m.spawn}),/engine changed/);configAbsent(p);
 assert.equal(m.calls.some(a=>a[0]==='create'),false);assert.equal(m.calls.at(-1)[0],'info');
 const leaf=json(path.join(p.preparedRuntime,'receipt.json'));assert.equal(leaf.status,'FAILED_RETAIN_AND_RECONCILE');assert.equal(leaf.imageRetention.operations.at(-1).status,'TAG_RETURNED_REQUIRES_EXACT_READBACK');
});
