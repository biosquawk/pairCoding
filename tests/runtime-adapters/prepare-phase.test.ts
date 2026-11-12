import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {buildOperatorPlan,cleanupOfflineFixture,executeOperatorPlan} from '../../scripts/runtime-operator.mjs';
import {resolvePreparedToolchainIdentity} from '../../scripts/runtime-prepare.mjs';
const sha=(b:any)=>createHash('sha256').update(b).digest('hex');
const image='sha256:'+'a'.repeat(64),id='b'.repeat(64);
const state=()=>({Id:id,State:{Running:false,ExitCode:1},Config:{Image:image,Labels:{'paircoach.installation':'stage09-runtime-assets','paircoach.role':'offline-smoke'}}});
test('offline cleanup re-inspects and removes verified final ID, never name; mismatched/rebound/running/foreign/exit/malformed refused',()=>{
 const commands:any[]=[];
 cleanupOfflineFixture(state(),image,(a:any)=>{commands.push(a);return {stdout:JSON.stringify([state()])};});
 assert.deepEqual(commands,[['inspect',id],['rm',id]]);
 for(const mutate of [(s:any)=>s.Id='c'.repeat(64),(s:any)=>s.State.Running=true,(s:any)=>s.State.ExitCode=0,(s:any)=>s.Config.Image='sha256:'+'d'.repeat(64),(s:any)=>s.Config.Labels['paircoach.role']='other',(s:any)=>s.Id='name']) {
  const changed=state();mutate(changed);const seen:any[]=[];
  assert.throws(()=>cleanupOfflineFixture(state(),image,(a:any)=>{seen.push(a);return {stdout:JSON.stringify([changed])};}),/identity/);
  assert.deepEqual(seen,[['inspect',id]]);
 }
 for(const bad of [undefined,{...state(),Id:'name'},{...state(),State:{Running:true,ExitCode:1}}])assert.throws(()=>cleanupOfflineFixture(bad,image,()=>{throw Error('must not inspect');}),/initial/);
});
test('explicit PREPARE_ONLY freezes seven profiles/nine caches with no language images; 18 offline fixtures remain separate final phase',()=>{
 const p=buildOperatorPlan('/not-created/prepare-phase'),f=buildOperatorPlan(p.operatorRoot,'FINAL_QA_OFFLINE');
 assert.equal(p.phase,'PREPARE_ONLY');assert.equal(p.offlineFixtureContainers,0);assert.equal(p.jobs.length,9);assert.equal(new Set(p.jobs.map((j:any)=>j.profile.id)).size,7);
 assert.equal(p.maxHeavyConcurrency,1);assert.equal(p.maxElapsedMs,2700000);assert.equal(p.maxCommandMs,480000);
 assert.equal(f.phase,'FINAL_QA_OFFLINE');assert.equal(f.offlineFixtureContainers,18);assert.deepEqual(p.jobs,f.jobs);assert.deepEqual(p.sourceInventory,f.sourceInventory);
 assert.deepEqual(p.language,[]);assert.ok(p.jobs.every(j=>j.profile.language.provider==='builtin' && j.profile.language.imageLockKey===null));
 assert.deepEqual(p,buildOperatorPlan(p.operatorRoot));assert.throws(()=>buildOperatorPlan(p.operatorRoot,'skip-tests'),/phase/);
 // No root access, download, Docker or write is reached for tampered phase/source/fixture.
 for(const field of ['phase','sourceInventory','jobs']) {const bad:any=structuredClone(p);bad[field]=field==='phase'?'skip-tests':[];assert.throws(()=>executeOperatorPlan(bad));}
});
test('single producer identity reads installed dispatcher bytes, validates production metadata without old staging roots or output writes',()=>{
 const p=buildOperatorPlan('/absent-prepared-identity');const req=p.jobs[0].request,copy=structuredClone(req),result=resolvePreparedToolchainIdentity(req);
 assert.deepEqual(req,copy);assert.match(result.toolchainHash,/^[a-f0-9]{64}$/);assert.equal(result.dispatcherFiles.length,8);
 for(const f of result.dispatcherFiles)assert.equal(f.sha256,sha(fs.readFileSync(f.path)));
 assert.equal(fs.existsSync(req.outputRoot),false);
 const moved={...req,tools:{...req.tools,root:'/old-tools-absent'},project:{...req.project,root:'/old-project-absent'},outputRoot:'/new-output-absent'};
 assert.deepEqual(resolvePreparedToolchainIdentity(moved),result);
 for(const change of [(r:any)=>r.expectedTools[0].version='wrong',(r:any)=>r.baseImage='node@sha256:'+'c'.repeat(64),(r:any)=>r.tools.files[0].sha256='c'.repeat(64),(r:any)=>r.dependencySha256='c'.repeat(64)]) {
  const bad=structuredClone(req);change(bad);assert.throws(()=>resolvePreparedToolchainIdentity(bad));
 }
});
test('UNIT fake Docker producer preserves actual engine/manifest/tools/cache evidence and refuses absent/switched/mismatched engines',()=>{
 const r=spawnSync(process.execPath,['tests/runtime-adapters/prepare-engine-counter.mjs',path.resolve('scripts/runtime-prepare.mjs')],{encoding:'utf8',env:{...process.env},maxBuffer:1024*1024});
 assert.equal(r.status,0,r.stdout+r.stderr);const result=JSON.parse(r.stdout);assert.equal(result.success,1);assert.equal(result.negatives,5);assert.equal(result.scope,'UNIT_FAKE_DOCKER_NOT_RUNTIME_PROOF');
});

test('UNIT exact operator PREPARE_ONLY executes nine injected preparation jobs and two language-image closure without entering offline path',()=>{
 const r=spawnSync(process.execPath,['tests/runtime-adapters/prepare-orchestration-counter.mjs'],{encoding:'utf8',env:{...process.env},maxBuffer:1024*1024});
 assert.equal(r.status,0,r.stdout+r.stderr);const result=JSON.parse(r.stdout);assert.equal(result.caches,9);assert.equal(result.languageImages,2);assert.equal(result.offlineContainers,0);
});
