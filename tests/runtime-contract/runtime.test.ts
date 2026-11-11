import test from 'node:test';
import assert from 'node:assert/strict';
import Ajv2020 from 'ajv/dist/2020.js';
import * as v from '../../src/shared/validation-v2';
import { SettingsV2Schema } from '../../src/shared/runtime-v2.schema';
import { hash, profile, settings, testsOnly } from './fixtures';

test('strict settings: tests-only and explicit [] disabled; MAIN rejects TESTS; no legacy/mixed coercion',()=>{
  assert.equal(v.validateSettingsV2(settings()),true);
  assert.equal(v.validateSettingsV2({...settings(),runProfiles:[]}),true);
  assert.equal(v.validateSettingsV2({...settings(),runProfiles:[{...testsOnly(),kind:'RUN_MAIN'}]}),false);
  const legacy:any={...settings()};delete legacy.schemaVersion;
  assert.equal(v.validateSettingsV2(legacy),false);
  for(const version of [1,3,'2',null]) assert.equal(v.validateSettingsV2({...settings(),schemaVersion:version}),false);
  for(const extra of ['runProfileSchemaVersion','executable','args','env']) assert.equal(v.validateSettingsV2({...settings(),[extra]:'x'}),false);
});
test('closed objects at every level reject task execution/image/report keys, not silently remove them',()=>{
  for(const key of ['executable','args','env','image','dockerArgs','reportGlob','reportFormat','testReportGlob','testReportFormat']) {
    for(const at of ['profile','task','entry','tests']) {
      const input:any=testsOnly();const target=at==='profile'?input:at==='task'?input.task:input.task[at];
      target[key]=key==='args'?['--x']:'forbidden';const before=JSON.stringify(input);
      assert.equal(v.validateRunProfileV2(input),false,`${at}.${key}`);assert.equal(JSON.stringify(input),before);
    }
  }
});
test('schema itself rejects duplicate kinds, unknown nested fields and invalid TESTS mode',()=>{
  const validate=new Ajv2020({strict:true}).compile(SettingsV2Schema);
  assert.equal(validate(settings()),true);
  assert.equal(validate({...settings(),runProfiles:[]}),true);
  assert.equal(validate({...settings(),runProfiles:[testsOnly(),testsOnly()]}),false);
  assert.equal(validate({...settings(),runProfiles:[{...testsOnly(),kind:'RUN_MAIN'}]}),false);
  assert.equal(validate({...settings(),runProfiles:[{...testsOnly(),task:{...testsOnly().task,args:[]}}]}),false);
});
test('bounded profiles, strings, paths and strict discriminated entry union',()=>{
  assert.equal(v.validateSettingsV2({...settings(),runProfiles:[testsOnly(),testsOnly()]}),false);
  assert.equal(v.validateSettingsV2({...settings(),runProfiles:Array(3).fill(testsOnly())}),false);
  for(const timeoutMs of [999,300001,1000.1,'1000']) assert.equal(v.validateRunProfileV2({...testsOnly(),timeoutMs}),false);
  for(const timeoutMs of [1000,300000]) assert.equal(v.validateRunProfileV2({...testsOnly(),timeoutMs}),true);
  for(const entry of [
    {kind:'SCRIPT',path:'main.py'}, {kind:'MODULE',name:'school.main'}, {kind:'JAVA_MAIN',className:'org.school.Main'},
    {kind:'SPRING_BOOT',containerPort:8080,healthPath:'/actuator/health'}, {kind:'TESTS'},
  ]) assert.equal(v.validateTaskRunConfig({...testsOnly().task,entry}),true);
  for(const entry of [{kind:'TESTS',path:'fake.py'},{kind:'MODULE',name:'-m os'},{kind:'JAVA_MAIN',className:'a;rm'},
    {kind:'SPRING_BOOT',containerPort:0,healthPath:'http://bad'}, {kind:'SCRIPT',path:'../escape.py'}])
    assert.equal(v.validateTaskRunConfig({...testsOnly().task,entry}),false);
  for(const path of ['/absolute','a\\b','a/../b','a//b','a/./b','C:/file','a\0b','a\nb','a/'])
    assert.equal(v.validateTaskRunConfig({...testsOnly().task,tests:{paths:[path],names:[]}}),false,path);
  assert.equal(v.validateTaskRunConfig({...testsOnly().task,tests:{paths:Array(101).fill('a'),names:[]}}),false);
});
test('prototype, accessor, sparse array and JSON prototype keys never enter a DTO',()=>{
  assert.equal(v.validateSettingsV2(Object.assign(Object.create({evil:true}),settings())),false);
  const data:any=settings();data.runProfiles[0].task.entry=JSON.parse('{"kind":"TESTS","__proto__":{"polluted":true}}');
  assert.equal(v.validateSettingsV2(data),false);
  const getter:any=settings();Object.defineProperty(getter,'runProfiles',{get(){throw Error('must not run')},enumerable:true});
  assert.equal(v.validateSettingsV2(getter),false);
  const sparse:any=settings();sparse.runProfiles=Array(1);assert.equal(v.validateSettingsV2(sparse),false);
  const sy:any=settings();sy[Symbol('x')]=1;assert.equal(v.validateSettingsV2(sy),false);
  assert.equal(({} as any).polluted,undefined);
});
test('neutral taskFields only exact allowlisted keys, choice/bounds/duplicate validity',()=>{
  const field={key:'entry.kind',label:'Entry',help:'',required:true,input:'CHOICE',choices:[{value:'TESTS',label:'Tests'}],min:null,max:null};
  assert.equal(v.validateTaskField(field),true);
  for(const key of ['__proto__','constructor','prototype','entry.__proto__','entry.foo','image','args','tests.names.0'])
    assert.equal(v.validateTaskField({...field,key}),false,key);
  assert.equal(v.validateTaskField({...field,choices:[]}),false);
  assert.equal(v.validateTaskField({...field,choices:[{value:'SHELL',label:'bad'}]}),false);
  assert.equal(v.validateTaskField({...field,choices:[field.choices[0],field.choices[0]]}),false);
  const n={...field,key:'entry.containerPort',input:'INTEGER',choices:[],min:1,max:65535};
  assert.equal(v.validateTaskField(n),true);assert.equal(v.validateTaskField({...n,max:65536}),false);
  const p={...profile(),taskFields:[field,field]};assert.equal(v.validateRuntimeProfile(p),false);
});
test('backend config/catalog/imageLock strict, pinned cross-file tools; unknown refs/dup identities fail',()=>{
  const config={schemaVersion:1,activeProfile:'python-3.13',workspaceRoot:'./examples/py',runtimeCatalog:'./runtimes/catalog.json',imageLock:'./runtimes/images.lock.json',
    languageFeatures:{completion:true,diagnostics:true},execution:{backend:'docker',pullPolicy:'never'}};
  assert.equal(v.validateRuntimeConfigV1(config),true);
  assert.equal(v.validateRuntimeProfile({...profile('java-maven'),analysis:{languageLevel:'27',preview:false}}),false,'analysis/release conflict');
  for(const execution of [{backend:'host',pullPolicy:'never'},{backend:'docker',pullPolicy:'always'},{backend:'docker',pullPolicy:'never',args:[]}])
    assert.equal(v.validateRuntimeConfigV1({...config,execution}),false);
  assert.equal(v.validateRuntimeConfigV1({...config,env:{}}),false);
  const catalog={schemaVersion:1,profiles:[profile()]};
  const image={key:'python',image:'paircoach/runtime-python:3.13-v1',imageId:`sha256:${hash}`,digest:`sha256:${hash}`,tools:[{name:'python',version:'3.13.9'}]};
  const lock={schemaVersion:1,images:[image,{...image,key:'pylsp'}]};
  assert.equal(v.validateCatalogImageReferences(catalog,lock),true);
  assert.equal(v.validateRuntimeCatalog({...catalog,profiles:[profile(),profile()]}),false);
  assert.equal(v.validateImageLock({...lock,images:[image,image]}),false);
  assert.equal(v.validateImageLock({...lock,images:[{...image,imageId:'latest'}]}),false);
  assert.equal(v.validateCatalogImageReferences(catalog,{schemaVersion:1,images:[image]}),false);
  assert.equal(v.validateCatalogImageReferences(catalog,{...lock,images:lock.images.map(i=>({...i,tools:[{name:'python',version:'3.12'}]}))}),false);
});
test('profile-specific tests-only selector rules; Spring only single Java adapter release21/27',()=>{
  assert.equal(v.validateTaskForProfile(profile(),testsOnly()),true);
  const empty={...testsOnly(),task:{...testsOnly().task,tests:{paths:[],names:[]}}};
  assert.equal(v.validateTaskForProfile(profile(),empty),false);
  assert.equal(v.validateTaskForProfile(profile('java-maven'),empty),true);
  const spring={...testsOnly(),kind:'RUN_MAIN',task:{...testsOnly().task,entry:{kind:'SPRING_BOOT',containerPort:8080,healthPath:'/health'},tests:{paths:[],names:[]}}};
  assert.equal(v.validateTaskForProfile(profile('java-maven'),spring),true);
  assert.equal(v.validateTaskForProfile({...profile('java-maven'),compilerRelease:11,analysis:{languageLevel:'11',preview:false}},spring),false);
  assert.equal(v.validateTaskForProfile(profile(),spring),false);
  const node={...profile(),adapterFamily:'node',language:{provider:'builtin',imageLockKey:null,serverJvm:null}};
  assert.equal(v.validateTaskForProfile(node,testsOnly()),true);
  assert.equal(v.validateTaskForProfile(node,empty),false);
});
test('new Run/Settings requests require generation/current version/idempotency, never accept legacy commands',()=>{
  const r={requestId:'r1',clientId:'c1',sessionId:'s1',expectedWorkspaceVersion:0,mode:'RUN_TESTS',configurationGeneration:'cfg1'};
  assert.equal(v.validateV2Request('RunRequest',r),true);
  const missing:any={...r};delete missing.configurationGeneration;assert.equal(v.validateRunRequestV2(missing),false);
  assert.equal(v.validateRunRequestV2({...r,expectedWorkspaceVersion:-1}),false);
  assert.equal(v.validateRunRequestV2({...r,image:'x'}),false);
  const u={requestId:'r1',clientId:'c1',sessionId:'s1',expectedWorkspaceVersion:0,settings:settings()};
  assert.equal(v.validateV2Request('UpdateSettingsRequest',u),true);
  assert.equal(v.validateUpdateSettingsRequestV2({...u,settings:{...settings(),runProfiles:[testsOnly(),testsOnly()]}}),false);
});
test('separate per-mode actionable readiness and stop-unconfirmed nonterminal state',()=>{
  const problem={code:'PREPARE_REQUIRED',message:'Prepare runtime',recovery:'Run approved prepare',retryable:true};
  const ready={runtime:{profileId:'p',label:'P',configurationGeneration:'cfg',state:'READY',problem:null,taskFields:[]},modes:{RUN_MAIN:{canRun:true,problem:null},RUN_TESTS:{canRun:false,problem}}};
  assert.equal(v.validateExecutionView(ready),true);
  assert.equal(v.validateExecutionView({...ready,modes:{...ready.modes,RUN_MAIN:{canRun:true,problem}}}),false);
  assert.equal(v.validateExecutionView({...ready,runtime:{...ready.runtime,state:'DAEMON_OFF',problem}}),false);
  const run={runId:'r',mode:'RUN_MAIN',status:'PROCESS_STOP_UNCONFIRMED',exitCode:null,workspaceVersionAtStart:1,workspaceChangedDuringRun:false,
    testOutcome:'NOT_APPLICABLE',testCount:null,outputTail:'',outputTruncated:false,startedAt:null,finishedAt:null,profileId:'p',configurationGeneration:'cfg',
    processProblem:{...problem,code:'PROCESS_STOP_UNCONFIRMED'},serviceReadiness:null};
  assert.equal(v.validateRunV2(run),true);
  assert.equal(v.validateRunV2({...run,processProblem:null}),false);
  assert.equal(v.validateRunV2({...run,status:'RUNNING'}),false,'stop uncertainty cannot hide in RUNNING');
  const passed={...run,mode:'RUN_TESTS',status:'SUCCEEDED',processProblem:null,exitCode:0,testOutcome:'PASSED',testCount:1};
  assert.equal(v.validateRunV2(passed),true);
  assert.equal(v.validateRunV2({...passed,exitCode:1}),false);
  assert.equal(v.validateRunV2({...passed,testCount:0}),false);
  assert.equal(v.validateRunV2({...run,finishedAt:'2026-11-11T00:00:00Z'}),false);
  assert.equal(v.validateRunV2({...run,status:'RUNNING',processProblem:null,serviceReadiness:{ready:true,url:'http://127.0.0.1:8080/health'}}),true);
  assert.equal(v.validateRunV2({...run,serviceReadiness:{ready:true,url:'http://0.0.0.0:8080/health'}}),false);
  assert.equal(v.validateRunV2({...run,status:'RUNNING',processProblem:null,serviceReadiness:{ready:true,url:'http://127.0.0.1:99999/health'}}),false);
});
