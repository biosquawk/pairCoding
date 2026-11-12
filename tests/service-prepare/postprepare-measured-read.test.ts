/** Offline actual LiveBackend -> ServicePreparationV2 -> RuntimeClientV2 wiring.
 * Only fetch/WebSocket/storage are doubled. No server, browser, Docker or live acceptance.
 */
import test, {type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {setImmediate} from 'node:timers/promises';
import {LiveBackend, type LiveOptions} from '../../src/services/LiveBackend';
import type {ProjectV2} from '../../src/shared/runtime-v2';
import {bundle,doc} from '../frontend-cutover/fixtures';
import {MemoryStorage,prepared,storageKey} from './fixture';

const deadlineMs=3*120000+5000; // Existing three sequential readiness phases, plus response margin.
const problem=(code:string)=>({code,message:code,recovery:'Measure current readiness.',retryable:true});
function pendingProject():ProjectV2 {
  const p=bundle().project,e=p.capabilities.execution;
  e.runtime.state='PREPARE_REQUIRED';e.runtime.problem=problem('RUNTIME_READINESS_PENDING');
  e.modes={RUN_MAIN:{canRun:false,problem:problem('RUNTIME_READINESS_PENDING')},RUN_TESTS:{canRun:false,problem:problem('RUNTIME_READINESS_PENDING')}};
  return p;
}
function readyProject():ProjectV2 {
  const p=bundle().project;
  p.capabilities.execution.modes={RUN_MAIN:{canRun:true,problem:null},RUN_TESTS:{canRun:true,problem:null}};
  return p;
}
function deferred<T>() {let resolve!:(value:T)=>void;let reject!:(error:unknown)=>void;const promise=new Promise<T>((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};}
async function fixture(t:TestContext) {
  const b=bundle();b.project=pendingProject();
  const storage=new MemoryStorage(),calls:{path:string;method:string;body:any;signal:AbortSignal;authorization:string|null}[]=[],sent:any[]=[];
  let seq=0,post:(signal:AbortSignal)=>Promise<unknown>=async()=>prepared();
  // Accurately distinguish the cheap production endpoint from the explicit measured endpoint.
  let measured:(signal:AbortSignal)=>Promise<unknown>=async()=>readyProject();
  const socket:any={readyState:1,onopen:null,onmessage:null,onclose:null,onerror:null,send(raw:string){sent.push(JSON.parse(raw));},close(){this.readyState=3;}};
  const live=new LiveBackend({token:'private-test-auth',clientId:'c1',storage,socket:()=>socket,fetch:async(input,init)=>{
    const url=new URL(String(input)),body=init?.body?JSON.parse(String(init.body)):null,signal=init!.signal!;
    const path=url.pathname+url.search;
    calls.push({path,body,method:init?.method??'GET',signal,authorization:new Headers(init?.headers).get('Authorization')});
    let value:unknown;
    if(url.pathname==='/api/runtime/service-network/prepare') {
      assert.deepEqual(JSON.parse(storage.getItem(storageKey)!).entries[0].request,body,'exact original persisted before POST');
      value=await post(signal);
    } else if(path==='/api/project?readiness=actual')value=await measured(signal);
    else if(path==='/api/project')value=structuredClone(b.project);
    else if(path==='/api/session')value=structuredClone(b.session);
    else if(path==='/api/snapshots')value=[];
    else if(url.pathname==='/api/file'&&init?.method==='POST')value=Response.json({code:'CONFLICT',message:'recorded source mutation refusal'},{status:409});
    else if(url.pathname==='/api/file')value=doc(url.searchParams.get('path')??'main.txt');
    else throw Error(`Unexpected network effect ${path}`);
    return value instanceof Response?value:Response.json(value);
  }} as LiveOptions);
  t.after(()=>live.close());
  const receive=(type:string,payload:unknown)=>live.receive({protocolVersion:'3.0',messageId:`event${seq+1}`,sessionId:b.session.sessionId,seq:++seq,type,payload} as any);
  const snapshot=async()=>{if((live as any).session?.sessionId!==b.session.sessionId){socket.readyState=1;await live.connect();socket.onopen?.();}receive('SESSION_SNAPSHOT',structuredClone(b));await setImmediate();assert.equal(live.getState().isOffline,false);};
  await live.connect();socket.onopen?.();await snapshot();
  const original=()=>JSON.parse(storage.getItem(storageKey)!).entries[0];
  return {live,b,storage,calls,sent,socket,snapshot,receive,original,
    maintenance:()=>live.getState().runtime!.maintenance!,execution:()=>live.getState().runtime!.execution!,
    posts:()=>calls.filter(c=>c.method==='POST'),reads:()=>calls.filter(c=>c.path==='/api/project?readiness=actual'),
    set measured(v:typeof measured){measured=v;},set post(v:typeof post){post=v;}};
}

test('cheap bootstrap PENDING -> positively PREPARED -> authenticated measured READY in real class wiring',async t=>{
  const f=await fixture(t);
  assert.equal(f.calls.filter(c=>c.path==='/api/project').length,1);assert.equal(f.reads().length,0);assert.equal(f.posts().length,0);
  assert.equal(f.sent.filter(m=>m.type==='HELLO').length,1);
  assert.equal(f.execution().runtime.problem?.code,'RUNTIME_READINESS_PENDING');
  assert.equal(await f.live.prepareRuntimeEnvironment(),true);
  assert.deepEqual(f.calls.filter(c=>c.path.startsWith('/api/project')||c.method==='POST').map(c=>c.path),['/api/project','/api/runtime/service-network/prepare','/api/project?readiness=actual']);
  assert.equal(f.reads()[0].authorization,'Bearer private-test-auth');assert.equal(f.reads()[0].method,'GET');assert.equal(f.reads()[0].body,null);
  assert.equal(f.execution().runtime.state,'READY');assert.equal(f.execution().modes.RUN_MAIN.canRun,true);assert.equal(f.execution().modes.RUN_TESTS.canRun,true);
  assert.deepEqual(JSON.parse(f.storage.getItem(storageKey)!).entries,[]);assert.equal(f.maintenance().blocked,false);
});

test('no measured read until positive CURRENT original PREPARED; unknown POST never retries automatically',async t=>{
  const f=await fixture(t),gate=deferred<unknown>();f.post=()=>gate.promise;
  const pending=f.live.prepareRuntimeEnvironment();assert.equal(f.reads().length,0);assert.equal(f.maintenance().pending,true);
  assert.equal(await f.live.prepareRuntimeEnvironment(),false);assert.equal(f.posts().length,1);
  gate.reject(Error('POST response lost'));assert.equal(await pending,false);await setImmediate();
  assert.equal(f.reads().length,0);assert.equal(f.posts().length,1);assert.equal(f.maintenance().uncertain,true);assert.equal(f.original().receipt,null);
});
for(const receipt of [null,{...prepared(),projectId:'foreign'},{...prepared(),extra:true}])test(`invalid PREPARED ${JSON.stringify(receipt)} cannot start measured read`,async t=>{
  const f=await fixture(t);f.post=async()=>receipt;
  assert.equal(await f.live.prepareRuntimeEnvironment(),false);assert.equal(f.reads().length,0);assert.equal(f.posts().length,1);assert.equal(f.maintenance().uncertain,true);
});

test('per-call budget survives >5s and all THREE schema-max phases plus response margin (fakeclock)',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});const f=await fixture(t),gate=deferred<unknown>();
  f.measured=signal=>{signal.addEventListener('abort',()=>gate.reject(Error('aborted')),{once:true});return gate.promise;};
  const pending=f.live.prepareRuntimeEnvironment();await setImmediate();assert.equal(f.reads().length,1);
  t.mock.timers.tick(5001);await setImmediate();assert.equal(f.reads()[0].signal.aborted,false);assert.equal(f.maintenance().pending,true);
  t.mock.timers.tick(3*120000-5001);await setImmediate();assert.equal(f.reads()[0].signal.aborted,false);
  t.mock.timers.tick(4999);assert.equal(f.reads()[0].signal.aborted,false);
  gate.resolve(readyProject());assert.equal(await pending,true);assert.equal(f.execution().modes.RUN_MAIN.canRun,true);assert.equal(f.posts().length,1);
});
test('bounded deadline aborts measured GET, retains exact original+receipt, no retry or fake success (fakeclock)',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});const f=await fixture(t),gate=deferred<unknown>();
  f.measured=signal=>{signal.addEventListener('abort',()=>gate.reject(Error('aborted')),{once:true});return gate.promise;};
  const pending=f.live.prepareRuntimeEnvironment();await setImmediate();const original=structuredClone(f.original());
  t.mock.timers.tick(deadlineMs-1);assert.equal(f.reads()[0].signal.aborted,false);
  t.mock.timers.tick(1);assert.equal(await pending,false);assert.equal(f.reads()[0].signal.aborted,true);
  assert.deepEqual(f.original(),original);assert.equal(f.maintenance().uncertain,true);assert.equal(f.execution().modes.RUN_MAIN.canRun,false);
  assert.equal(await f.live.prepareRuntimeEnvironment(),false);assert.equal(f.posts().length,1);assert.equal(f.reads().length,1);
});

for(const failed of ['RUN_MAIN','RUN_TESTS'] as const)test(`measured ${failed} denial stays independent, never promoted by PREPARED`,async t=>{
  const f=await fixture(t),p=readyProject();p.capabilities.execution.modes[failed]={canRun:false,problem:problem('PREPARE_REQUIRED')};
  f.measured=async()=>p;assert.equal(await f.live.prepareRuntimeEnvironment(),true,'confirmed preparation/read is not both modes READY');
  assert.deepEqual(f.execution(),p.capabilities.execution);assert.equal(f.execution().modes[failed].canRun,false);
  assert.equal(f.execution().modes[failed==='RUN_MAIN'?'RUN_TESTS':'RUN_MAIN'].canRun,true);
});
for(const code of ['RUNTIME_READINESS_TIMEOUT','RUNTIME_READINESS_UNAVAILABLE','RUNTIME_READINESS_PENDING'])test(`truthful ${code} cannot become READY/canRun`,async t=>{
  const f=await fixture(t),p=pendingProject();p.capabilities.execution.runtime.problem=problem(code);
  for(const mode of ['RUN_MAIN','RUN_TESTS'] as const)p.capabilities.execution.modes[mode].problem=problem(code);
  f.measured=async()=>p;await f.live.prepareRuntimeEnvironment();assert.deepEqual(f.execution(),p.capabilities.execution);
  assert.equal(f.execution().modes.RUN_MAIN.canRun,false);assert.equal(f.execution().modes.RUN_TESTS.canRun,false);assert.notEqual(f.execution().runtime.state,'READY');
});

for(const failure of ['lost','unreadable','unauthorized','malformed','inconsistent-main','inconsistent-tests','wrong-project','wrong-session','wrong-version','wrong-config','wrong-profile'] as const)test(`measured ${failure} retains original/receipt and refuses installation`,async t=>{
  const f=await fixture(t),before=structuredClone(f.execution()),p=readyProject();
  if(failure==='wrong-project')p.projectId='p2';if(failure==='wrong-session')p.sessionId='s2';if(failure==='wrong-version')p.workspaceVersion++;
  if(failure==='wrong-config')p.capabilities.execution.runtime.configurationGeneration='cfg2';
  if(failure==='wrong-profile')p.capabilities.execution.runtime.profileId='profile2';
  if(failure==='inconsistent-main')p.capabilities.execution.modes.RUN_MAIN={canRun:true,problem:problem('PREPARE_REQUIRED')};
  if(failure==='inconsistent-tests')p.capabilities.execution.modes.RUN_TESTS={canRun:false,problem:null};
  f.measured=async()=>{if(failure==='lost')throw Error('GET response lost');if(failure==='unreadable')return new Response('broken');if(failure==='unauthorized')return Response.json({code:'UNAUTHORIZED'},{status:401});return failure==='malformed'?{}:p;};
  assert.equal(await f.live.prepareRuntimeEnvironment(),false);assert.deepEqual(f.execution(),before);assert.equal(f.maintenance().uncertain,true);
  assert.deepEqual(f.original().request,f.posts()[0].body);assert.deepEqual(f.original().receipt,prepared());assert.equal(f.posts().length,1);
  await setImmediate();assert.equal(f.posts().length,1);assert.equal(f.reads().length,1);
});

// HUMAN35aa / K TASKfc77: seq-only and same-binding WS readiness are presentation,
// not source/control drift. Genuine negatives below retain their original assertions.
for(const neutral of ['seq-only','WS-ready'] as const)test(`neutral ${neutral} accepts only the fresh measured GET`,async t=>{
  const f=await fixture(t),gate=deferred<unknown>();f.measured=()=>gate.promise;t.after(()=>gate.resolve(readyProject()));
  const pending=f.live.prepareRuntimeEnvironment();await setImmediate();assert.equal(f.reads().length,1);const original=structuredClone(f.original());
  if(neutral==='seq-only')f.receive('SESSION_STATE',structuredClone(f.b.session));
  if(neutral==='WS-ready'){f.b.project=readyProject();await f.snapshot();}
  assert.equal(f.maintenance().pending,true);assert.equal(f.maintenance().uncertain,true);assert.deepEqual(f.original(),original);
  gate.resolve(readyProject());assert.equal(await pending,true);assert.equal(f.posts().length,1);assert.equal(f.reads().length,1);
  assert.deepEqual(JSON.parse(f.storage.getItem(storageKey)!).entries,[]);assert.equal(f.execution().modes.RUN_MAIN.canRun,true);
});
for(const drift of ['session','project','workspace','config','source','source-request','local-draft','epoch','connection','closed','finished','coach'] as const)test(`concurrent ${drift} fences measured installation and preserves original`,async t=>{
  const f=await fixture(t),gate=deferred<unknown>();f.measured=()=>gate.promise;t.after(()=>gate.resolve(readyProject()));
  const pending=f.live.prepareRuntimeEnvironment();await setImmediate();assert.equal(f.reads().length,1);const original=structuredClone(f.original());
  if(drift==='session'){f.b.session.sessionId=f.b.project.sessionId='s2';await f.snapshot();}
  if(drift==='project'){f.b.session.projectId=f.b.project.projectId=f.b.project.capabilities.language.projectId='p2';await f.snapshot();}
  if(drift==='workspace'){f.b.session.workspaceVersion=f.b.project.workspaceVersion=2;await f.snapshot();}
  if(drift==='config'){f.b.project.capabilities.execution.runtime.configurationGeneration=f.b.project.capabilities.language.configurationGeneration='cfg2';await f.snapshot();}
  if(drift==='source')f.receive('EXTERNAL_FILE_SYNC',{operation:'MODIFIED',path:'main.txt',version:2,workspaceVersion:2,document:doc('main.txt','new source',2)});
  if(drift==='source-request')await f.live.mutateFile('CREATE','new.txt',null,'new source');
  if(drift==='local-draft')f.live.saveFileContent('main.txt','student draft remains');
  if(drift==='epoch')f.receive('CONTROL_STATE',{controlEpoch:1,writeOwner:'STUDENT',coachMode:'UNAVAILABLE'});
  if(drift==='connection'){f.socket.onclose?.();}
  if(drift==='closed')f.live.close();
  if(drift==='finished'){f.b.session.lifecycle='FINISHED';f.receive('SESSION_STATE',structuredClone(f.b.session));}
  if(drift==='coach')f.receive('CONTROL_STATE',{controlEpoch:1,writeOwner:'COACH',coachMode:'UNAVAILABLE'});
  const before=structuredClone(f.execution());gate.resolve(readyProject());assert.equal(await pending,false);
  assert.deepEqual(f.execution(),before,'late measured result never overwrites current WS/session/source state');
  assert.deepEqual(JSON.parse(f.storage.getItem(storageKey)!).entries.find((e:any)=>e.projectId==='p1'),original);assert.equal(f.posts().filter(c=>c.path==='/api/runtime/service-network/prepare').length,1);
});

test('explicit recovery after lost GET retains byte-identical original; cheap reconnect never sends prepare',async t=>{
  const f=await fixture(t);f.measured=async()=>{throw Error('GET lost');};
  assert.equal(await f.live.prepareRuntimeEnvironment(),false);const raw=JSON.stringify(f.posts()[0].body),original=structuredClone(f.original());
  await f.snapshot();assert.equal(f.posts().length,1);assert.deepEqual(f.original(),original);
  f.measured=async()=>readyProject();assert.equal(await f.live.prepareRuntimeEnvironment(true),true);
  assert.equal(f.posts().length,2);assert.equal(JSON.stringify(f.posts()[1].body),raw);assert.equal(f.reads().length,2);
  assert.deepEqual(JSON.parse(f.storage.getItem(storageKey)!).entries,[]);assert.equal(f.execution().modes.RUN_TESTS.canRun,true);
});


// HUMANf9f99813/1ef77b83: the legitimate prepare POST has its own producer-derived
// bounded wait. Only this obsolete POST5000 expectation changes; measured GET is unchanged.
test('original POST has scoped bounded maintenance deadline, not ordinary editor5s (fakeclock)',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});const f=await fixture(t),gate=deferred<unknown>();
  f.post=signal=>{signal.addEventListener('abort',()=>gate.reject(Error('POST aborted')),{once:true});return gate.promise;};
  const pending=f.live.prepareRuntimeEnvironment();await setImmediate();
  const original=structuredClone(f.original()),postBudgetMs=(1+3*16)*3000+10*10000+5000;
  t.mock.timers.tick(5001);assert.equal(f.posts()[0].signal.aborted,false);
  t.mock.timers.tick(postBudgetMs-5002);assert.equal(f.posts()[0].signal.aborted,false);
  t.mock.timers.tick(1);assert.equal(await pending,false);assert.equal(f.posts()[0].signal.aborted,true);
  assert.deepEqual(f.original(),original);assert.equal(await f.live.prepareRuntimeEnvironment(),false);
  assert.equal(f.reads().length,0);assert.equal(f.maintenance().uncertain,true);assert.equal(f.original().receipt,null);
  assert.equal(f.posts().length,1);
});
