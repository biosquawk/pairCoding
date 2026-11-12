/** Actual adapter builder/registry, production artifact reader, private real FS. No Docker/GUI execution. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createTaskRuntimeAdapterRegistry, dependencyHash, parseJUnit } from '../../src/server/runtime-adapters';
import type { ExecutionPlan, CollectedArtifacts, ExecutionExit, PlanContext } from '../../src/server/execution/ports';
import type { RuntimeProfile, RunProfileV2 } from '../../src/shared/runtime-v2';
import { encodeSpec, decodeSpec } from '../../scripts/runtime-spec.mjs';
const sha = (b:string|Uint8Array) => createHash('sha256').update(b).digest('hex');
const actual = await readFile(new URL('./actual-node22-failed.xml', import.meta.url));
const passed = '<?xml version="1.0"?><testsuites><testcase name="actual assertion" time="0.001" classname="test"/></testsuites>';
const registry = createTaskRuntimeAdapterRegistry();
const H='a'.repeat(64), I='sha256:'+H;
async function sample(xml:string|Uint8Array=passed, family:'node'|'typescript'='node', exitCode=0) {
  const root=await mkdtemp(path.join(process.env.TMPDIR!, 'node-junit-'));
  try {
    const runRoot=path.join(root,'run-1'), file=path.join(runRoot,'collected/files/junit-node.xml');
    await mkdir(path.dirname(file),{recursive:true}); await writeFile(file,xml);
    const profile:RuntimeProfile={id:family,label:family,adapterFamily:family,imageLockKey:family,expectedTools:['node',...(family==='typescript'?['typescript']:[])].map(name=>({name,version:'fixture-only'})),compilerRelease:null,analysis:{languageLevel:'ES2022',preview:false},language:{provider:'builtin',imageLockKey:null,serverJvm:null},taskFields:[]};
    const extension=family==='typescript'?'ts':'js';
    const run:RunProfileV2={kind:'RUN_TESTS',timeoutMs:1000,task:{workingDirectory:'.',entry:{kind:'TESTS'},tests:{paths:['sample.test.'+extension],names:[]}}};
    const files=[{path:run.task.tests.paths[0],documentVersion:1,sha256:H,bytes:1}, ...(family==='typescript'?[{path:'tsconfig.json',documentVersion:1,sha256:H,bytes:1}]:[])];
    const context:PlanContext={profile,ownership:{installationId:'fixture',runId:'run-1',profileId:family,engineId:'fixture',containerName:'fixture',imageId:I},lockedImage:{key:family,image:'fixture/runtime:test',imageId:I,digest:I,tools:profile.expectedTools},input:{projectId:'project',sessionId:'session',identity:{runId:'run-1',profileId:family,configurationGeneration:'generation',workspaceVersion:1,manifestSha256:H},files,immutableDirectory:path.join(runRoot,'input'),buildDirectory:path.join(runRoot,'build'),artifactsDirectory:path.join(runRoot,'artifacts')},caches:[{directory:path.join(root,'cache'),family,toolchainHash:H,dependencyHash:dependencyHash(files),readOnly:true}]};
    const plan=await registry.get(profile).buildPlan(context,run), handle={runId:'run-1',opaqueId:'handle'};
    const collection:CollectedArtifacts={handle,inputManifestSha256:H,collectionSha256:H,stdoutPath:path.join(runRoot,'collected/stdout'),stderrPath:path.join(runRoot,'collected/stderr'),tools:profile.expectedTools,files:[{kind:'JUNIT_XML',path:file,sha256:sha(xml),bytes:Buffer.byteLength(xml),freshForRun:true}]};
    const exit:ExecutionExit={handle,exitCode,exitedAt:'2026-11-12T00:00:00Z'};
    return {plan,collection,exit,root,run,context,interpret:()=>registry.get(plan.profile).interpret(plan,exit,collection),cleanup:()=>rm(root,{recursive:true,force:true})};
  } catch(e) {await rm(root,{recursive:true,force:true});throw e;}
}
async function withSample(fn:(s:Awaited<ReturnType<typeof sample>>)=>Promise<void>, xml:string|Uint8Array=passed, family:'node'|'typescript'='node', code=0) {
  const s=await sample(xml,family,code);try{await fn(s);}finally{await s.cleanup();}
}
test('retained ORIGINAL Node22 fixture exactly542B/hash; strict/default remains conservative',()=>{
  assert.equal(actual.length,542);assert.equal(sha(actual),'b90d9b4b9e60c084c4eba1ad24e719c4576082f362aaab43b458e334f0ac5aba');
  assert.equal(parseJUnit(actual.toString()),null);assert.equal(parseJUnit('<testsuites><testcase/></testsuites>'),null);
});
for(const family of ['node','typescript'] as const) {
  test(family+': original failure recognized, not UNKNOWN or PASSED',()=>withSample(async s=>{
    assert.deepEqual(await s.interpret(),{status:'FAILED',testOutcome:'FAILED',testCount:1,failures:1,errors:0,skipped:0,problem:null});
  },actual,family,1));
  test(family+': direct current case PASSED through adapter/real artifact reader',()=>withSample(async s=>{
    assert.deepEqual(await s.interpret(),{status:'SUCCEEDED',testOutcome:'PASSED',testCount:1,failures:0,errors:0,skipped:0,problem:null});
  },passed,family));
}
for(const [name,xml,code,outcome,count,skipped,failures,errors] of [
  ['all skipped','<testsuites><testcase><skipped/></testcase></testsuites>',0,'FAILED',1,1,0,0],
  ['mixed passing/skipped','<testsuites><testcase/><testcase><skipped/></testcase></testsuites>',0,'PASSED',2,1,0,0],
  ['zero never passes','<testsuites/>',0,'NO_TESTS',0,0,0,0],
  ['nonzero green','<testsuites><testcase/></testsuites>',2,'FAILED',1,0,0,0],
  ['failure with zero exit',actual,0,'FAILED',1,0,1,0],
  ['error child','<testsuites><testcase><error/></testcase></testsuites>',0,'FAILED',1,0,0,1],
  ['honest declared counts','<testsuites tests="1" failures="0"><testcase/></testsuites>',0,'PASSED',1,0,0,0],
  ['mixed suite and direct Node cases','<testsuites tests="2"><testsuite tests="1"><testcase/></testsuite><testcase/></testsuites>',0,'PASSED',2,0,0,0],
] as const) test('Node dialect '+name,()=>withSample(async s=>{
  const o=await s.interpret();assert.equal(o.testOutcome,outcome);assert.equal(o.testCount,count);assert.equal(o.skipped,skipped);assert.equal(o.failures,failures);assert.equal(o.errors,errors);assert.equal(o.status,outcome==='PASSED'?'SUCCEEDED':'FAILED');
},xml,'node',code));
for(const [name,xml] of [
  ['conflicting child outcomes','<testsuites><testcase><failure/><skipped/></testcase></testsuites>'],
  ['contradictory declared count','<testsuites tests="2"><testcase/></testsuites>'],
  ['contradictory failures','<testsuites failures="1"><testcase/></testsuites>'],
  ['negative count','<testsuites tests="-1"><testcase/></testsuites>'],
  ['unsafe count','<testsuites tests="9007199254740992"><testcase/></testsuites>'],
  ['malformed','<testsuites><testcase></testsuites>'],
  ['XXE','<!DOCTYPE testsuites [<!ENTITY x SYSTEM "file:///etc/passwd">]><testsuites><testcase/></testsuites>'],
  ['entity','<!ENTITY x "x"><testsuites><testcase/></testsuites>'],
  ['dual roots','<testsuites><testcase/></testsuites><testsuite tests="0"/>'],
  ['deep','<testsuites>'+ '<testsuite>'.repeat(70)+'<testcase/>'+ '</testsuite>'.repeat(70)+'</testsuites>'],
  ['overlimit',' '.repeat(4*1024*1024+1)],
] as const) test('UNKNOWN '+name,()=>withSample(async s=>{
  const o=await s.interpret();assert.equal(o.testOutcome,'UNKNOWN');assert.equal(o.testCount,null);assert.equal(o.status,'FAILED');
},xml));
const adverse:[string,(p:ExecutionPlan,a:CollectedArtifacts,e:ExecutionExit)=>void][]=[
  ['stale',(_p,a)=>{a.files[0].freshForRun=false;}],
  ['wrong input manifest',(_p,a)=>{a.inputManifestSha256='b'.repeat(64);}],
  ['wrong content hash',(_p,a)=>{a.files[0].sha256='b'.repeat(64);}],
  ['wrong size',(_p,a)=>{a.files[0].bytes++;}],
  ['wrong handle',(_p,_a,e)=>{e.handle={...e.handle,opaqueId:'another'};}],
  ['foreign path',(p,a)=>{a.files[0].path=path.join(path.dirname(p.input.immutableDirectory),'artifacts/junit-node.xml');}],
  ['duplicate report',(_p,a)=>{a.files=[...a.files,a.files[0]];}],
  ['too many reports',(_p,a)=>{a.files=Array.from({length:65},(_,i)=>({...a.files[0],path:a.files[0].path+i+'.xml'}));}],
  ['wrong pin ID',p=>{p.lockedImage={...p.lockedImage,imageId:'sha256:'+'b'.repeat(64)};}],
  ['wrong pin key',p=>{p.lockedImage={...p.lockedImage,key:'other'};}],
  ['wrong tool version',p=>{p.lockedImage={...p.lockedImage,tools:[{name:'node',version:'wrong'}]};}],
  ['wrong profile identity',p=>{p.input={...p.input,identity:{...p.input.identity,profileId:'other'}};}],
  ['foreign payload family',p=>{const spec=decodeSpec(p.command.args[1]);spec.family='python';spec.task.tests.paths=['test.py'];p.command.args=[p.command.args[0],encodeSpec(spec)];}],
];
for(const [name,mutate] of adverse) test('current-input/dialect fence '+name,()=>withSample(async s=>{
  mutate(s.plan,s.collection,s.exit);const o=await s.interpret();assert.equal(o.testOutcome,'UNKNOWN');assert.equal(o.status,'FAILED');assert.equal(o.testCount,null);
}));
for(const family of ['python','java-maven'] as const) test(family+' never opts into Node direct-case dialect',()=>withSample(async s=>{
  s.plan.profile={...s.plan.profile,adapterFamily:family};assert.equal((await s.interpret()).testOutcome,'UNKNOWN');
}));
test('TypeScript missing pinned compiler cannot enable dialect',()=>withSample(async s=>{
  s.plan.lockedImage={...s.plan.lockedImage,tools:s.plan.lockedImage.tools.filter(t=>t.name!=='typescript')};assert.equal((await s.interpret()).testOutcome,'UNKNOWN');
},passed,'typescript'));
