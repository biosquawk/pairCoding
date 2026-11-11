import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RuntimeClientV2, type RuntimeAuthorityV2 } from '../../src/services/RuntimeClientV2';
import { project, run, settings } from './fixtures';
import { validateV2WireShape } from '../../src/shared/validation-v2';
const deferred = () => {let resolve!:(v:unknown)=>void;const promise=new Promise<unknown>(r=>resolve=r);return {promise,resolve};};
function fixture() {
  let a: RuntimeAuthorityV2 = {projectId:'p1',sessionId:'s1',clientId:'client1',connectionGeneration:'conn1',workspaceVersion:1,configurationGeneration:'cfg1',connected:true,canExecute:true,canSaveSettings:true};
  const calls:any[]=[];let response:unknown=run(), gate:ReturnType<typeof deferred>|null=null, fail: Error|null=null,n=0;
  const call=async(kind:string,...args:any[])=>{calls.push([kind,...args]);if(fail)throw fail;return gate?gate.promise:structuredClone(response);};
  const client=new RuntimeClientV2({current:()=>a,requestId:()=>`r${++n}`,http:{run:(...args)=>call('RUN',...args),stop:(...args)=>call('STOP',...args),saveSettings:(...args)=>call('SAVE',...args)}});
  assert.equal(validateV2WireShape('Project',project()),true);assert.equal(client.applyProject(project()),true);
  return {client,calls,get a(){return a;},set a(v){a=v;},set response(v:unknown){response=v;},set gate(v:ReturnType<typeof deferred>|null){gate=v;},set fail(v:Error|null){fail=v;}};
}
test('real reusable run client builds exact shared request with server generation and immutable snapshot',async()=>{
  const f=fixture();assert.equal(await f.client.run('RUN_TESTS'),true);
  assert.deepEqual(f.calls[0][1],{requestId:'r1',clientId:'client1',sessionId:'s1',expectedWorkspaceVersion:1,mode:'RUN_TESTS',configurationGeneration:'cfg1'});
  const s=f.client.snapshot();s.run!.runId='tampered';assert.equal(f.client.snapshot().run!.runId,'run1');
});
test('per-mode disabled, [] disabled, offline and permissions fail before HTTP; editor unaffected',async()=>{
  const f=fixture();assert.equal(await f.client.run('RUN_MAIN'),false);assert.equal(f.calls.length,0);
  const p=project();p.settings.runProfiles=[];assert.equal(f.client.applyProject(p),true);assert.equal(await f.client.run('RUN_TESTS'),false);
  f.client.applyProject(project());f.a.connected=false;assert.equal(await f.client.run('RUN_TESTS'),false);
  f.a.connected=true;f.a.canExecute=false;assert.equal(await f.client.run('RUN_TESTS'),false);assert.equal(f.calls.length,0);
});
test('STOPPING/unconfirmed block new Run, Stop targets same runId and retry keeps ownership',async()=>{
  const f=fixture(), unconfirmed={...run(),status:'PROCESS_STOP_UNCONFIRMED' as const,processProblem:{code:'PROCESS_STOP_UNCONFIRMED',message:'Brak potwierdzenia.',recovery:'Ponów Stop.',retryable:true}};
  assert.equal(f.client.applyProject(project(),unconfirmed),true);assert.equal(await f.client.run('RUN_TESTS'),false);assert.equal(f.calls.length,0);
  f.response=unconfirmed;assert.equal(await f.client.stop(),true);assert.equal(f.calls[0][1],'run1');
  f.response={...run(),status:'CANCELLED',exitCode:137,finishedAt:'2026-11-11T21:01:00.000Z'};assert.equal(await f.client.stop(),true);assert.equal(f.calls[1][1],'run1');
  assert.equal(f.client.snapshot().run!.status,'CANCELLED');
});
test('unknown stop failure never invents success/forgets handle; retry never starts another run',async()=>{
  const f=fixture();f.client.applyProject(project(),run());f.fail=new Error('Daemon indisponible');
  assert.equal(await f.client.stop(),false);assert.equal(f.client.snapshot().run!.runId,'run1');assert.equal(f.client.snapshot().run!.status,'RUNNING');
  assert.equal(await f.client.run('RUN_TESTS'),false);f.fail=null;f.response=run();assert.equal(await f.client.stop(),true);assert.equal(f.calls.at(-1)[1],'run1');
});
test('cancel/old response, reconnect, new version/generation and singleflight fenced',async()=>{
  for(const mutate of [(a:RuntimeAuthorityV2)=>a.sessionId='s2',(a:RuntimeAuthorityV2)=>a.configurationGeneration='cfg2',(a:RuntimeAuthorityV2)=>a.connectionGeneration='conn2',(a:RuntimeAuthorityV2)=>a.workspaceVersion++]) {
    const f=fixture(),g=deferred();f.gate=g;const started=f.client.run('RUN_TESTS');assert.equal(await f.client.run('RUN_TESTS'),false);mutate(f.a);g.resolve(run());assert.equal(await started,false);assert.equal(f.client.snapshot().run,null);
  }
  const f=fixture(),g=deferred();f.gate=g;const started=f.client.run('RUN_TESTS');f.client.invalidate();assert.equal(f.calls[0][2].aborted,true);g.resolve(run());assert.equal(await started,false);assert.equal(f.client.snapshot().project,null);
});
test('strict run guards reject false PASSED, other run mode/profile and invalid service HTTP readiness',async()=>{
  for(const value of [{...run(),mode:'RUN_MAIN'},{...run(),profileId:'other'},{...run(),status:'SUCCEEDED',exitCode:0,testOutcome:'PASSED',testCount:0},{...run(),serviceReadiness:{ready:true,url:'http://evil:8080/'}}]){
    const f=fixture();f.response=value;assert.equal(await f.client.run('RUN_TESTS'),false);assert.equal(f.client.snapshot().run,null);
  }
});
test('settings optimistic version/idempotency request; accepted new generation and reordered keys, no metadata loss',async()=>{
  const f=fixture(),next=settings();next.runProfiles=[];
  const accepted={...project(),workspaceVersion:2,settings:JSON.parse(JSON.stringify(next)),capabilities:structuredClone(project().capabilities)};
  accepted.capabilities.execution.runtime.configurationGeneration='cfg2';accepted.capabilities.language.configurationGeneration='cfg2';
  accepted.settings=Object.fromEntries(Object.entries(next).reverse()) as any;
  f.response=accepted;const result=await f.client.saveSettings(next,1);assert.equal(result.ok,true);
  assert.deepEqual(f.calls[0][1],{requestId:'r1',clientId:'client1',sessionId:'s1',expectedWorkspaceVersion:1,settings:next});
  assert.deepEqual(f.client.snapshot().project!.settings.contextPatterns,['src/**']);
});
test('conflict/error/false-save confirmation leave original settings and caller draft untouched',async()=>{
  const f=fixture(),next=settings();next.aiConsent=true;
  assert.equal((await f.client.saveSettings(next,0)).ok,false);assert.equal(f.calls.length,0);
  f.fail=new Error('409 VERSION_CONFLICT');assert.equal((await f.client.saveSettings(next,1)).ok,false);
  assert.equal(f.client.snapshot().project!.settings.aiConsent,false);assert.equal(next.aiConsent,true);
  f.fail=null;f.response={...project(),workspaceVersion:2};assert.equal((await f.client.saveSettings(next,1)).ok,false);
  assert.equal(f.client.snapshot().project!.settings.aiConsent,false);
});
test('authoritative event wins over pending HTTP, no rollback; dispose fences all calls',async()=>{
  const f=fixture(),g=deferred();f.gate=g;const pending=f.client.run('RUN_TESTS');
  const running={...run(),runId:'eventRun'};assert.equal(f.client.applyProject(project(),running),true);g.resolve(run());assert.equal(await pending,false);assert.equal(f.client.snapshot().run!.runId,'eventRun');
  f.client.dispose();assert.equal(await f.client.run('RUN_TESTS'),false);assert.equal(f.client.applyProject(project()),false);
});
test('legacy readiness admits explicit human migration without inventing V2 settings or rewriting raw commands',async()=>{
  const f=fixture(),original='{"schemaVersion":1,"runProfiles":[{"executable":"do-not-guess"}],"unrelated":{"keep":true}}';
  const legacy={...project(),settings:JSON.parse(original)};assert.equal(f.client.applyProject(legacy),false);
  const view=project().capabilities.execution,problem={code:'LEGACY_RUN_PROFILE_REQUIRES_MIGRATION',message:'Migracja wymagana.',recovery:'Zapisz jawne V2.',retryable:false};
  view.runtime.state='CONFIG_ERROR';view.runtime.problem=problem;view.modes.RUN_MAIN={canRun:false,problem};view.modes.RUN_TESTS={canRun:false,problem};
  assert.equal(f.client.applyExecution(view),true);assert.equal(f.client.snapshot().project,null);assert.equal(await f.client.run('RUN_TESTS'),false);assert.equal(f.calls.length,0);
  const migrated={...project(),workspaceVersion:2};f.response=migrated;
  assert.equal((await f.client.saveSettings(settings(),1)).ok,true);assert.equal(f.calls.length,1);assert.equal(f.calls[0][0],'SAVE');
  assert.equal(original,'{"schemaVersion":1,"runProfiles":[{"executable":"do-not-guess"}],"unrelated":{"keep":true}}');assert.equal(f.client.snapshot().project!.settings.schemaVersion,2);
});
