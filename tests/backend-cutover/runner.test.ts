/** UNIT controlled ports, no Docker/host-task execution. Never fabricate a branded terminal receipt. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { RuntimeRunner, type RuntimeRunAdmission } from '../../src/server/runtime-coordinator/RuntimeRunner';
import type { AdapterOutcome, ExecutionExit, ExecutionOutput, ExecutionPlan, ExecutionPort, PlanContext, StopConfirmation, TaskRuntimeAdapter } from '../../src/server/execution/ports';
import type { RuntimeProfile } from '../../src/shared/runtime-v2';
const defer=<T>()=>{let resolve!:(value:T)=>void,reject!:(error:unknown)=>void;const promise=new Promise<T>((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
const tick=()=>new Promise<void>(resolve=>setImmediate(resolve));
const profile:RuntimeProfile={id:'profile',label:'Profile',adapterFamily:'node',imageLockKey:'image',expectedTools:[],compilerRelease:null,
  analysis:{languageLevel:'level',preview:false},language:{provider:'off',imageLockKey:null,serverJvm:null},taskFields:[]};
const image={key:'image',image:'paircoach/runtime-unit:v1',imageId:'sha256:'+'a'.repeat(64),digest:'sha256:'+'b'.repeat(64),tools:[]};
const handle={runId:'run1',opaqueId:'handle1'};
const exit:ExecutionExit={handle,exitCode:0,exitedAt:'2026-11-11T22:00:00.000Z'};
const outcome:AdapterOutcome={status:'SUCCEEDED',testOutcome:'UNKNOWN',testCount:null,failures:null,errors:null,skipped:null,problem:null};
function fixture() {
  const context:PlanContext={ownership:{installationId:'install',runId:'run1',profileId:profile.id,engineId:'engine',containerName:'owned-run',imageId:image.imageId},profile,
    lockedImage:image,caches:[],input:{projectId:'project',sessionId:'session',identity:{runId:'run1',profileId:profile.id,configurationGeneration:'cfg',workspaceVersion:1,manifestSha256:'c'.repeat(64)},files:[],immutableDirectory:'/unit/input',buildDirectory:'/unit/build',artifactsDirectory:'/unit/artifacts'}};
  let version=1,listener:((o:ExecutionOutput)=>void)|null=null;
  const calls:string[]=[],events:{type:string;payload:any}[]=[],wait=defer<ExecutionExit>();
  const port:ExecutionPort={
    readiness:async(_profile,generation)=>{calls.push('readiness');return {configurationGeneration:generation,modes:{RUN_MAIN:{canRun:true,problem:null},RUN_TESTS:{canRun:true,problem:null}}};},
    start:async()=>{calls.push('start');return handle;},
    subscribe:(_h,fn)=>{listener=fn;return ()=>{listener=null;};},serviceReadiness:async()=>null,wait:()=>wait.promise,
    stop:async()=>{calls.push('stop');return {confirmed:false,handle,problem:{code:'PROCESS_STOP_UNCONFIRMED',message:'unit',recovery:'retry',retryable:true}};},
    collect:async()=>{calls.push('collect');return {handle,inputManifestSha256:context.input.identity.manifestSha256,collectionSha256:'d'.repeat(64),stdoutPath:'/unit/out',stderrPath:'/unit/err',files:[],tools:[]};},
    cleanup:async()=>{calls.push('cleanup');throw Error('No fake branded receipt in UNIT');},inspectOwnedOrphans:async()=>[]
  };
  const adapter:TaskRuntimeAdapter={family:profile.adapterFamily,validate:async()=>({valid:true,problem:null}),buildPlan:async c=>{
    calls.push('plan');return {ownership:c.ownership,input:c.input,profile:c.profile,lockedImage:c.lockedImage,caches:c.caches,mode:'RUN_MAIN',timeoutMs:300000,
      command:{executable:'/unit/dispatcher',args:[],workingDirectory:'/workspace',environment:{}},resources:{memoryBytes:128*1024*1024,cpus:1,pids:64,logBytes:10485760,logFiles:1},isolation:{nonRootUser:'10001:10001',capDropAll:true,noNewPrivileges:true,readOnlyRoot:true,network:'none'},service:null,artifacts:[]};},
    interpret:async()=>{calls.push('interpret');return outcome;}
  };
  const admission:RuntimeRunAdmission={projectId:'project',request:{requestId:'request',clientId:'client',sessionId:'session',expectedWorkspaceVersion:1,mode:'RUN_MAIN',configurationGeneration:'cfg'},profile:structuredClone(profile),runProfile:{kind:'RUN_MAIN',task:{workingDirectory:'.',entry:{kind:'SCRIPT',path:'main.js'},tests:{paths:[],names:[]}},timeoutMs:300000},adapter,
    assertCurrent:()=>{},capture:async()=>{calls.push('capture');return structuredClone(context);}};
  const runner=new RuntimeRunner({execution:port,newRunId:()=>handle.runId,getWorkspaceVersion:()=>version,emit:(type,payload)=>events.push({type,payload}),persistTerminal:async()=>{calls.push('persist');throw Error('Intentional genuine-receipt boundary; no mock brand');}});
  return {runner,port,adapter,admission,context,calls,events,wait,change:()=>{version++;},output:(stream:'STDOUT'|'STDERR',text:string)=>listener!({stream,text})};
}

test('UNIT neutral Runner reserves singleflight before await and captures immutable approved profile/request',async()=>{
  const f=fixture(),barrier=defer<void>();let observed:RuntimeProfile|undefined;
  f.port.readiness=async(p,g)=>{observed=p;await barrier.promise;return {configurationGeneration:g,modes:{RUN_MAIN:{canRun:true,problem:null},RUN_TESTS:{canRun:true,problem:null}}};};
  const starting=f.runner.start(f.admission);await tick();
  f.admission.profile.label='caller-mutation';f.admission.request.configurationGeneration='caller-generation';
  await assert.rejects(f.runner.start(f.admission),{code:'RUN_IN_PROGRESS'});
  barrier.resolve();const run=await starting;
  assert.equal(run.status,'RUNNING');assert.equal(run.configurationGeneration,'cfg');assert.equal(observed?.label,'Profile');
  const result=f.runner.get(run.runId);result.outputTail='caller-mutation';assert.equal(f.runner.get(run.runId).outputTail,'');
});

test('UNIT readiness failure releases no-effect admission; no capture or start and manual port remains untouched',async()=>{
  const f=fixture();f.port.readiness=async(_p,g)=>({configurationGeneration:g,modes:{RUN_MAIN:{canRun:false,problem:{code:'IMAGE_MISSING',message:'unit',recovery:'prepare',retryable:true}},RUN_TESTS:{canRun:false,problem:null}}});
  await assert.rejects(f.runner.start(f.admission),{code:'IMAGE_MISSING'});
  assert.deepEqual(f.calls,[]);assert.deepEqual(f.runner.list(),[]);
  await assert.rejects(f.runner.start(f.admission),{code:'IMAGE_MISSING'});
});

test('UNIT genuine admission revalidation after awaited capture rejects stale config before start',async()=>{
  const f=fixture();let current=true;
  f.admission.assertCurrent=()=>{if(!current)throw Error('stale authority');};
  f.admission.capture=async()=>{current=false;return f.context;};
  await assert.rejects(f.runner.start(f.admission),/stale authority/);
  assert.ok(!f.calls.includes('start'));assert.deepEqual(f.runner.list(),[]);
});

for(const kind of ['session','project','profile','plan'] as const)test(`UNIT rejects substituted ${kind} capture/plan authority`,async()=>{
  const f=fixture();
  if(kind==='session')f.context.input.sessionId='foreign';
  if(kind==='project')f.context.input.projectId='foreign';
  if(kind==='profile')f.context.ownership.profileId='foreign';
  if(kind==='plan'){const old=f.adapter.buildPlan;f.adapter.buildPlan=async(c,r)=>({...await old(c,r),caches:[{directory:'/foreign',family:'node',toolchainHash:'a',dependencyHash:'b',readOnly:true}]});}
  await assert.rejects(f.runner.start(f.admission),{code:'RUN_INPUT_CHANGED'});assert.ok(!f.calls.includes('start'));
});

test('UNIT output has ordered bounded UTF8 chunks/tail and workspace observation; shell-looking data stays literal',async()=>{
  const f=fixture(),run=await f.runner.start(f.admission);f.change();
  f.output('STDOUT','😀'.repeat(20000));f.output('STDERR',';echo NOT_A_SHELL');
  const actual=f.runner.get(run.runId),output=f.events.filter(e=>e.type==='RUN_OUTPUT');
  assert.ok(Buffer.byteLength(actual.outputTail)<=65536);assert.ok(actual.outputTruncated);assert.ok(actual.workspaceChangedDuringRun);
  assert.doesNotMatch(actual.outputTail,/\ufffd/);assert.match(actual.outputTail,/;echo NOT_A_SHELL$/);
  output.forEach((e,i)=>{assert.equal(e.payload.outputSeq,i+1);assert.ok(Buffer.byteLength(e.payload.chunk)<=16384);assert.doesNotMatch(e.payload.chunk,/\ufffd/);});
});

test('UNIT unconfirmed Stop and later terminal-persistence failure preserve ownership/fence; same-run retry never restarts',async()=>{
  const f=fixture(),run=await f.runner.start(f.admission);
  await assert.rejects(f.runner.stop(run.runId),{code:'PROCESS_STOP_UNCONFIRMED'});
  assert.equal(f.runner.get(run.runId).status,'PROCESS_STOP_UNCONFIRMED');await assert.rejects(f.runner.start(f.admission),{code:'RUN_IN_PROGRESS'});
  f.port.stop=async()=>{f.calls.push('stop');return {confirmed:true,exit};};
  await assert.rejects(f.runner.stop(run.runId),/genuine-receipt boundary/);
  assert.deepEqual(f.calls.slice(-4),['stop','collect','interpret','persist']);
  assert.equal(f.calls.filter(x=>x==='start').length,1);assert.ok(!f.calls.includes('cleanup'));assert.equal(f.runner.get(run.runId).finishedAt,null);
  await assert.rejects(f.runner.stop(run.runId),/genuine-receipt boundary/);
  assert.equal(f.calls.filter(x=>x==='collect').length,1);assert.equal(f.calls.filter(x=>x==='interpret').length,1);
  assert.equal(f.calls.filter(x=>x==='persist').length,2);
});

test('UNIT lost start never blind retries; foreign orphan cannot authorize Stop; exact ownership permits recovery attempt',async()=>{
  const f=fixture();f.port.start=async()=>{f.calls.push('start');throw Error('lost start response');};
  const run=await f.runner.start(f.admission);assert.equal(run.status,'PROCESS_STOP_UNCONFIRMED');
  f.port.inspectOwnedOrphans=async()=>[{ownership:{...f.context.ownership,engineId:'foreign'},handle,state:'RUNNING',durableReceipt:null}];
  await assert.rejects(f.runner.stop(run.runId),/unique exact-owned/);assert.ok(!f.calls.includes('stop'));
  f.port.inspectOwnedOrphans=async()=>[{ownership:f.context.ownership,handle,state:'RUNNING',durableReceipt:null}];
  await assert.rejects(f.runner.stop(run.runId),{code:'PROCESS_STOP_UNCONFIRMED'});
  assert.equal(f.calls.filter(x=>x==='start').length,1);assert.equal(f.calls.filter(x=>x==='stop').length,1);
});

test('UNIT service ready is nonterminal and does not collect/persist/cleanup',async()=>{
  const f=fixture();f.port.serviceReadiness=async()=>({handle,ready:true,url:'http://127.0.0.1:43210/',problem:null});
  const run=await f.runner.start(f.admission);await tick();assert.equal(f.runner.get(run.runId).status,'RUNNING');
  assert.equal(f.runner.get(run.runId).serviceReadiness?.ready,true);assert.ok(!f.calls.includes('collect'));
});

test('UNIT foreign exit never grants collection or terminal state',async()=>{
  const f=fixture(),run=await f.runner.start(f.admission);f.wait.resolve({...exit,handle:{runId:'foreign',opaqueId:'foreign'}});await tick();
  assert.equal(f.runner.get(run.runId).status,'PROCESS_STOP_UNCONFIRMED');assert.ok(!f.calls.includes('collect'));
});

test('UNIT Stop during capture cancels admission before invocation; no phantom terminal or second process',async()=>{
  const f=fixture(),barrier=defer<PlanContext>();f.admission.capture=()=>barrier.promise;
  const starting=f.runner.start(f.admission);await tick();await assert.rejects(f.runner.stop('run1'),{code:'RUN_ADMISSION_PENDING'});
  barrier.resolve(f.context);await assert.rejects(starting,{code:'RUN_CANCELLED_BEFORE_START'});
  assert.deepEqual(f.runner.list(),[]);assert.ok(!f.calls.includes('start'));
});
