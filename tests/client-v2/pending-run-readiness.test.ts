/** Actual client and LiveBackend composition; only HTTP/socket transports are controlled.
 * No RunV2 requestId exists: the original promise and matching run identity must agree. */
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { RuntimeClientV2, type RuntimeAuthorityV2, type RuntimeUnconfirmedMutationV2 } from '../../src/services/RuntimeClientV2';
import { LiveBackend } from '../../src/services/LiveBackend';
import type { ProjectV2, RunV2 } from '../../src/shared/runtime-v2';
import { project, run } from './fixtures';
import { bundle, doc } from '../frontend-cutover/fixtures';
const copy = <T,>(v: T): T => structuredClone(v);
const problem = { code:'PREPARE_REQUIRED', message:'Tests preparation required', recovery:'Prepare explicitly', retryable:true };
function ready(): ProjectV2 {
  const p=project();
  p.settings.runProfiles.unshift({kind:'RUN_MAIN',timeoutMs:120000,task:{workingDirectory:'.',entry:{kind:'SCRIPT',path:'main.txt'},tests:{paths:[],names:[]}}});
  p.capabilities.execution.modes.RUN_MAIN={canRun:true,problem:null};
  return p;
}
function main(status: RunV2['status']='QUEUED'): RunV2 {
  const terminal=status==='SUCCEEDED'||status==='FAILED'||status==='CANCELLED';
  return {...run(),mode:'RUN_MAIN',status,startedAt:status==='QUEUED'?null:run().startedAt,
    testOutcome:'NOT_APPLICABLE',exitCode:terminal?(status==='SUCCEEDED'?0:1):null,
    finishedAt:terminal?'2026-11-11T21:01:00.000Z':null};
}
function neutral(p: ProjectV2): ProjectV2 {
  const next=copy(p);next.capabilities.execution.modes.RUN_TESTS={canRun:false,problem:copy(problem)};return next;
}
function fixture(t: TestContext, previous: RunV2|null=null) {
  const a: RuntimeAuthorityV2={projectId:'p1',sessionId:'s1',clientId:'c1',connectionGeneration:'conn1',workspaceVersion:1,configurationGeneration:'cfg1',controlEpoch:0,connected:true,canExecute:true,canSaveSettings:true};
  let resolve!:(value:unknown)=>void, reject!:(error:Error)=>void, signal!:AbortSignal, requests=0;
  const held=new Promise<unknown>((yes,no)=>{resolve=yes;reject=no;});
  const calls: unknown[]=[], stops: string[]=[], confirmed: RuntimeUnconfirmedMutationV2[]=[];
  const p=ready(),client=new RuntimeClientV2({current:()=>a,requestId:()=>`original-${++requests}`,confirmedMutation:m=>confirmed.push(copy(m)),http:{
    run:async(body,s)=>{calls.push(copy(body));signal=s;return held;},
    stop:async(id)=>{stops.push(id);return {...main('CANCELLED'),runId:id};},
    saveSettings:async()=>{throw Error('Unexpected SAVE dispatch');},
  }});
  t.after(()=>client.dispose());assert.equal(client.applyProject(p,previous),true);
  return {client,p,a,calls,stops,confirmed,resolve,reject,get signal(){return signal;},get requests(){return requests;}};
}
function unresolved(f: ReturnType<typeof fixture>) {
  assert.equal(f.client.snapshot().reconciliationRequired,true);
  assert.equal(f.calls.length,1);assert.equal(f.confirmed.length,0);
  assert.deepEqual(f.client.retainedMutations(),[{kind:'RUN',requestId:'original-1',projectId:'p1',sessionId:'s1',clientId:'c1',expectedWorkspaceVersion:1}]);
}
for(const status of ['QUEUED','RUNNING','SUCCEEDED','FAILED'] as const) {
  test(`client: neutral TESTS snapshot preserves original MAIN 202 after own ${status}`,async t=>{
    const f=fixture(t),op=f.client.run('RUN_MAIN');
    assert.equal(f.client.applyProject(f.p,main()),true);
    const newer=main(status);assert.equal(f.client.applyProject(neutral(f.p),newer),true);
    assert.equal(f.client.snapshot().reconciliationRequired,true);
    assert.equal(await f.client.run('RUN_MAIN'),false);
    assert.equal((await f.client.saveSettings(f.p.settings,1)).ok,false);
    assert.equal(f.requests,1);f.resolve(main());assert.equal(await op,true);
    assert.deepEqual(f.client.snapshot().run,newer);assert.equal(f.signal.aborted,false);
    assert.equal(f.client.snapshot().reconciliationRequired,false);assert.deepEqual(f.client.retainedMutations(),[]);
    assert.deepEqual(f.confirmed,[{kind:'RUN',requestId:'original-1',projectId:'p1',sessionId:'s1',clientId:'c1',expectedWorkspaceVersion:1}]);
    assert.equal(f.calls.length,1);assert.equal('requestId' in main(),false);
    assert.equal(f.client.snapshot().project!.capabilities.execution.modes.RUN_TESTS.canRun,false);
  });
}
test('client: first own QUEUED together with neutral TESTS readiness can confirm original 202',async t=>{
  const f=fixture(t),op=f.client.run('RUN_MAIN');
  assert.equal(f.client.applyProject(neutral(f.p),main()),true);
  f.resolve(main());assert.equal(await op,true);assert.equal(f.client.snapshot().reconciliationRequired,false);
  assert.equal(f.confirmed.length,1);assert.equal(f.calls.length,1);
});
test('client: readiness before own QUEUED/null run cannot claim an observation; later match never unpoisons',async t=>{
  const f=fixture(t),op=f.client.run('RUN_MAIN');
  assert.equal(f.client.applyProject(neutral(f.p)),true);
  assert.equal(f.client.applyProject(neutral(f.p),main()),true);
  f.resolve(main());assert.equal(await op,false);unresolved(f);
});
test('client: readiness/own terminal without original response stays in-flight; loss retains UNKNOWN',async t=>{
  const f=fixture(t),op=f.client.run('RUN_MAIN');
  assert.equal(f.client.applyProject(neutral(f.p),main('SUCCEEDED')),true);
  assert.equal(f.client.snapshot().pending,'RUN');assert.equal(f.client.snapshot().reconciliationRequired,true);
  let reads=0;assert.equal(await f.client.reconcile(async()=>{reads++;return {project:f.p,run:main()};}),false);
  assert.equal(await f.client.run('RUN_MAIN'),false);assert.equal(reads,0);assert.equal(f.requests,1);
  f.reject(Error('Original 202 lost'));assert.equal(await op,false);unresolved(f);
  f.client.applyProject(f.p,main('SUCCEEDED'));unresolved(f);
  assert.equal(await f.client.run('RUN_MAIN'),false);assert.equal(f.calls.length,1);
});
type Drift = (p: ProjectV2,a: RuntimeAuthorityV2,r: RunV2)=>void;
const drifts: Record<string,Drift>={
  root:p=>{p.rootPath='/other';},
  project:(p,a)=>{a.projectId=p.projectId=p.capabilities.language.projectId='p2';},
  session:(p,a)=>{a.sessionId=p.sessionId='s2';},
  files:p=>{p.files.push({path:'other.txt',kind:'FILE',version:1});},
  settings:p=>{p.settings.reviewNotesPath='other.md';},
  workspace:(p,a)=>{a.workspaceVersion=p.workspaceVersion=2;},
  profile:(p,_a,r)=>{r.profileId=p.capabilities.execution.runtime.profileId=p.capabilities.language.profileId='profile2';},
  config:(p,a,r)=>{a.configurationGeneration=r.configurationGeneration=p.capabilities.execution.runtime.configurationGeneration=p.capabilities.language.configurationGeneration='cfg2';},
  provider:p=>{p.capabilities.language.providerGeneration='provider2';},
  client:(_p,a)=>{a.clientId='c2';},
  connection:(_p,a)=>{a.connectionGeneration='conn2';},
  epoch:(_p,a)=>{a.controlEpoch=1;},
  offline:(_p,a)=>{a.connected=false;},
  executePermission:(_p,a)=>{a.canExecute=false;},
  savePermission:(_p,a)=>{a.canSaveSettings=false;},
  selectedGuard:p=>{p.capabilities.execution.modes.RUN_MAIN={canRun:false,problem:copy(problem)};},
  runtime:p=>{p.capabilities.execution.runtime.state='PREPARE_REQUIRED';p.capabilities.execution.runtime.problem=copy(problem);p.capabilities.execution.modes.RUN_MAIN={canRun:false,problem:copy(problem)};},
  taskFields:p=>{p.capabilities.execution.runtime.taskFields[0].help='Changed field';},
  language:p=>{p.capabilities.language.state='OFF';p.capabilities.language.autocomplete='OFF';},
};
for(const [name,drift] of Object.entries(drifts))for(const restore of [false,true]) {
  test(`client: genuine ${name} drift${restore?' -> restore ABA':''} retains original UNKNOWN`,async t=>{
    const f=fixture(t),originalAuthority=copy(f.a),op=f.client.run('RUN_MAIN');
    assert.equal(f.client.applyProject(f.p,main()),true);
    const next=neutral(f.p),observed=main();drift(next,f.a,observed);
    assert.equal(f.client.applyProject(next,observed),true,'exercise an admitted observation, not malformed input');
    if(restore){Object.assign(f.a,originalAuthority);assert.equal(f.client.applyProject(neutral(f.p),main()),true);}
    f.resolve(main());assert.equal(await op,false);
    Object.assign(f.a,originalAuthority);unresolved(f);
    assert.equal(await f.client.run('RUN_MAIN'),false);assert.equal(f.calls.length,1);
  });
}
for(const field of ['run','mode','profile','config','version','previous'] as const) {
  test(`client: ${field} mismatch in original response cannot confirm observed own Run`,async t=>{
    const previous={...main('SUCCEEDED'),runId:'previous'};
    const f=fixture(t,previous),op=f.client.run('RUN_MAIN');
    assert.equal(f.client.applyProject(neutral(f.p),main()),true);
    const response=main();
    if(field==='run')response.runId='foreign';
    if(field==='previous')response.runId='previous';
    if(field==='mode'){response.mode='RUN_TESTS';response.testOutcome='UNKNOWN';}
    if(field==='profile')response.profileId='profile2';
    if(field==='config')response.configurationGeneration='cfg2';
    if(field==='version')response.workspaceVersionAtStart=0;
    f.resolve(response);assert.equal(await op,false);unresolved(f);
    assert.equal(f.client.snapshot().run?.runId,'run1');
  });
}
for(const foreign of ['foreign','previous','wrongmode','wrongversion'] as const) {
  test(`client: ${foreign} event followed by restore permanently poisons observation`,async t=>{
    const f=fixture(t,{...main('SUCCEEDED'),runId:'previous'}),op=f.client.run('RUN_MAIN');
    f.client.applyProject(neutral(f.p),main());const observed=main();
    if(foreign==='foreign'||foreign==='previous')observed.runId=foreign;
    if(foreign==='wrongmode'){observed.mode='RUN_TESTS';observed.testOutcome='UNKNOWN';}
    if(foreign==='wrongversion')observed.workspaceVersionAtStart=0;
    assert.equal(f.client.applyProject(neutral(f.p),observed),true);
    f.client.applyProject(neutral(f.p),main());f.resolve(main());assert.equal(await op,false);unresolved(f);
  });
}
test('client: Stop after neutral readiness targets same run; aborted original response never clears UNKNOWN',async t=>{
  const f=fixture(t),op=f.client.run('RUN_MAIN');
  f.client.applyProject(f.p,main());f.client.applyProject(neutral(f.p),main('RUNNING'));
  assert.equal(await f.client.stop(),true);assert.deepEqual(f.stops,['run1']);assert.equal(f.signal.aborted,true);
  f.resolve(main());assert.equal(await op,false);unresolved(f);
  assert.equal(f.client.snapshot().run?.status,'CANCELLED');assert.equal(await f.client.run('RUN_MAIN'),false);
});
test('client: invalidate/reconnect cannot make original late 202 current',async t=>{
  const f=fixture(t),op=f.client.run('RUN_MAIN');f.client.applyProject(neutral(f.p),main());
  f.client.invalidate();f.a.connectionGeneration='conn2';f.client.applyProject(neutral(f.p),main('SUCCEEDED'));
  f.resolve(main());assert.equal(await op,false);assert.equal(f.signal.aborted,true);unresolved(f);
});
async function liveFixture(t: TestContext) {
  const b: Omit<ReturnType<typeof bundle>,'lastRun'> & {lastRun:RunV2|null}=bundle();b.project=ready();b.project.files=[{path:'main.txt',kind:'FILE',version:1}];
  let seq=0,resolve!:(value:unknown)=>void;const held=new Promise(r=>resolve=r);
  const calls:{body:unknown;signal:AbortSignal|null|undefined}[]=[];
  const socket={readyState:1,onopen:null,onmessage:null,onclose:null,onerror:null,send(){},close(){this.readyState=3;}};
  const live=new LiveBackend({token:'synthetic-only',clientId:'c1',socket:()=>socket as unknown as WebSocket,fetch:async(input,init)=>{
    const url=new URL(String(input));
    if(url.pathname==='/api/run'){calls.push({body:JSON.parse(String(init!.body)),signal:init!.signal});return Response.json(await held,{status:202});}
    if(url.pathname==='/api/project')return Response.json(b.project);
    if(url.pathname==='/api/session')return Response.json(b.session);
    if(url.pathname==='/api/snapshots')return Response.json([]);
    return Response.json(doc(url.searchParams.get('path')??'main.txt'));
  }});
  t.after(()=>live.close());
  const receive=(type:string,payload:unknown)=>live.receive({protocolVersion:'3.0',messageId:`m${seq+1}`,sessionId:b.session.sessionId,seq:++seq,type,payload} as Parameters<LiveBackend['receive']>[0]);
  const snapshot=async()=>{receive('SESSION_SNAPSHOT',copy(b));await setImmediate();assert.equal(live.getState().isOffline,false);};
  await live.connect();await snapshot();return {live,b,calls,resolve,receive,snapshot};
}
for(const status of ['QUEUED','RUNNING','SUCCEEDED','FAILED'] as const) {
  test(`LiveBackend -> client: neutral TESTS snapshot and exact original 202 preserve own ${status}`,async t=>{
    const f=await liveFixture(t),op=f.live.run(false);await setImmediate();assert.equal(f.calls.length,1);
    f.b.lastRun=main();f.receive('RUN_STATE',copy(f.b.lastRun));await f.snapshot();
    f.b.project=neutral(f.b.project);f.b.lastRun=main(status);f.receive('RUN_STATE',copy(f.b.lastRun));await f.snapshot();
    assert.equal(f.live.getState().runtime!.pending,'RUN');assert.equal(f.live.getState().runtime!.reconciliationRequired,true);
    await f.live.run(false);assert.equal(f.calls.length,1);
    f.resolve(main());await op;const result=f.live.getState().runtime!;
    assert.equal(result.reconciliationRequired,false);assert.equal(result.pending,null);assert.equal(result.error,null);
    assert.deepEqual(result.run,f.b.lastRun);assert.equal(f.calls[0].signal!.aborted,false);assert.equal(f.calls.length,1);
    assert.deepEqual(f.calls[0].body,{requestId:(f.calls[0].body as {requestId:string}).requestId,clientId:'c1',sessionId:'s1',expectedWorkspaceVersion:1,mode:'RUN_MAIN',configurationGeneration:'cfg1'});
  });
}
test('LiveBackend -> client: pre-own null snapshot stays negative even after own QUEUED and original 202',async t=>{
  const f=await liveFixture(t),op=f.live.run(false);await setImmediate();
  f.b.project=neutral(f.b.project);await f.snapshot();
  f.b.lastRun=main();f.receive('RUN_STATE',copy(f.b.lastRun));await f.snapshot();
  f.resolve(main());await op;assert.equal(f.live.getState().runtime!.reconciliationRequired,true);assert.equal(f.calls.length,1);
});

test('LiveBackend -> client: first own QUEUED snapshot includes neutral TESTS delta; original 202 settles',async t=>{
  const f=await liveFixture(t),op=f.live.run(false);await setImmediate();
  f.b.project=neutral(f.b.project);f.b.lastRun=main();await f.snapshot();
  assert.equal(f.live.getState().runtime!.pending,'RUN');assert.equal(f.live.getState().runtime!.reconciliationRequired,true);
  f.resolve(main());await op;assert.equal(f.live.getState().runtime!.reconciliationRequired,false);
  assert.equal(f.live.getState().runtime!.error,null);assert.equal(f.calls.length,1);
});

for(const restore of [false,true])test(`client: pending TESTS keeps strict MAIN readiness equality${restore?' even after ABA':''}`,async t=>{
  const f=fixture(t),op=f.client.run('RUN_TESTS');
  assert.equal(f.client.applyProject(f.p,run()),true);
  const next=copy(f.p);next.capabilities.execution.modes.RUN_MAIN={canRun:false,problem:copy(problem)};
  assert.equal(f.client.applyProject(next,run()),true);
  if(restore)assert.equal(f.client.applyProject(f.p,run()),true);
  f.resolve(run());assert.equal(await op,false);unresolved(f);
  assert.equal(await f.client.run('RUN_TESTS'),false);assert.equal(f.calls.length,1);
});
