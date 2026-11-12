/** UNIT filesystem receipts and injected transport only; no ROOT fixture dependence or Docker. */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { artifactInventory, verifyPreparedReuse, buildRemainderPlan, executeRemainderPlan } from '../../scripts/runtime-operator-remainder.mjs';
import { buildOperatorPlan } from '../../scripts/runtime-operator.mjs';
import { resolvePreparedToolchainIdentity } from '../../scripts/runtime-prepare.mjs';
import { receiptWriter } from '../../scripts/runtime-files.mjs';
const hash = b => createHash('sha256').update(b).digest('hex');
const engine = { ID: 'UNIT-engine', ServerVersion: '29.7.2', OSType: 'linux', Architecture: 'x86_64' };
const put = (file, value) => fs.writeFileSync(file, JSON.stringify(value), { mode: 0o600 });
function fixture(t) {
 const root=fs.mkdtempSync(path.join(process.env.TMPDIR??path.dirname(process.cwd()),'remainder-unit-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const original=path.join(root,'original'),next=path.join(root,'next');fs.mkdirSync(original);
 const template=buildOperatorPlan(original).jobs[0],request=template.request;
 fs.mkdirSync(path.join(original,'projects'));fs.mkdirSync(path.join(original,'jobs'));fs.mkdirSync(request.project.root);fs.writeFileSync(path.join(request.project.root,'main.js'),'unit');
 request.project.files=[{path:'main.js',sha256:hash('unit')}];request.dependencySha256=hash('[]');
 const identity=resolvePreparedToolchainIdentity(request),publish=receiptWriter(request.outputRoot),cache=path.join(request.outputRoot,'cache',request.family,identity.toolchainHash,request.dependencySha256);fs.mkdirSync(cache,{recursive:true,mode:0o700});
 const tools=request.expectedTools.map(t=>({...t,raw:'UNIT '+t.version})),dependencies={family:request.family,workingDirectory:request.workingDirectory,dependencySha256:request.dependencySha256,tools};
 put(path.join(cache,'tools.json'),tools);put(path.join(cache,'dependencies-prepared.json'),dependencies);
 const imageId='sha256:'+'a'.repeat(64),container={Id:'c'.repeat(64),State:{Running:false,ExitCode:0},Config:{Image:imageId,Labels:{'paircoach.installation':request.installationId,'paircoach.role':'prepare'}}};
 const receipt={status:'PREPARED_REQUIRES_OFFLINE_AND_TOOL_VALIDATION',request,...identity,engine,imageId,observedImage:{Id:imageId,Descriptor:{mediaType:'application/vnd.oci.image.index.v1+json',size:856,digest:'sha256:'+'b'.repeat(64)},RepoDigests:[]},container,commands:[{argv:['docker','rm',container.Id],exit:0}],cacheEvidence:{root:cache,tools:{sha256:hash(JSON.stringify(tools)),actual:tools},dependencies:{sha256:hash(JSON.stringify(dependencies)),actual:dependencies}}};publish(receipt);
 return {root,original,next,job:template,receipt,cache,file:path.join(request.outputRoot,'receipt.json')};
}
test('reuse is exact real receipt/request/helper/engine/cache/project bytes, not status/path; mutation negatives',t=>{
 const f=fixture(t),valid=verifyPreparedReuse(f.job,engine);assert.equal(valid.cacheRoot,f.cache);assert.ok(valid.cacheInventory.length===2);assert.equal(valid.receipt.sha256,hash(fs.readFileSync(f.file)));
 const original=fs.readFileSync(f.file);
 for(const mutate of [r=>{r.request.workingDirectory='other';},r=>{r.toolchainHash='0'.repeat(64);},r=>{r.engine.ID='foreign';},r=>{r.commands=[];},r=>{r.observedImage.Descriptor=null;},r=>{r.container.State.Running=true;},r=>{r.imageId='sha256:'+'f'.repeat(64);},r=>{r.cacheEvidence.root=f.root;}]){const r=JSON.parse(original);mutate(r);put(f.file,r);assert.throws(()=>verifyPreparedReuse(f.job,engine));}
 fs.writeFileSync(f.file,original);
 fs.appendFileSync(path.join(f.cache,'tools.json'),' ');assert.throws(()=>verifyPreparedReuse(f.job,engine),/proof changed/);
});
test('artifact inventory preserves bytes/refuses links; original unknown plan/absent evidence no output',t=>{
 const f=fixture(t);fs.writeFileSync(path.join(f.cache,'extra'),'unit');assert.ok(artifactInventory(f.cache).some(f=>f.path==='extra'));
 fs.symlinkSync(path.join(f.cache,'extra'),path.join(f.cache,'link'));assert.throws(()=>artifactInventory(f.cache),/link/);
 const options={previousRoot:f.original,outputRoot:f.next,previousPlanFile:path.join(f.root,'old.json'),previousPlanSha256:'0'.repeat(64),failureEvidenceDirectory:f.root};put(options.previousPlanFile,{});
 assert.throws(()=>buildRemainderPlan(options),/SHA/);assert.equal(fs.existsSync(f.next),false);
});
test('UNIT frozen source tamper blocks before writes; exact old failure still present prevents any acquisition and retains error, never rm',t=>{
 const f=fixture(t);const plan={options:{outputRoot:f.next},phase:'PREPARE_ONLY_REMAINDER_AFTER_REVIEWED_FAILURE',engine,sourceInventory:[],maxElapsedMs:2700000,maxCommandMs:480000,reuse:[],failure:{exactContainerId:'c'.repeat(64)}};
 assert.throws(()=>executeRemainderPlan(plan,{buildPlan:()=>({...plan,phase:'tampered'})}),/Frozen/);assert.equal(fs.existsSync(f.next),false);
 const calls=[];
 assert.throws(()=>executeRemainderPlan(plan,{buildPlan:()=>structuredClone(plan),spawnSync:(exe,args,options)=>{
  calls.push(args);assert.equal(exe,'docker');assert.equal(options.shell,false);assert.deepEqual(args.slice(0,3),['--host',process.platform==='win32'?'npipe:////./pipe/docker_engine':'unix:///var/run/docker.sock','--config']);
  return {status:0,stdout:JSON.stringify(engine),stderr:''};
 },prepare:()=>assert.fail('old resource must block preparation'),prepareLanguageImages:()=>assert.fail('old resource must block language')}),/old failed resource/);
 assert.equal(calls.length,2);assert.ok(calls.every(a=>!a.includes('rm')));assert.equal(JSON.parse(fs.readFileSync(path.join(f.next,'receipt.json'))).status,'FAILED_RETAIN_AND_RECONCILE');
});
