/** Client authority/singleflight negatives; no real network or Docker. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { RuntimeClientV2, type RuntimeAuthorityV2 } from '../../src/services/RuntimeClientV2';
import { project, run } from '../client-v2/fixtures';
import type { RunV2 } from '../../src/shared/runtime-v2';
function fixture(t:test.TestContext,previous:RunV2|null=null){
  let authority:RuntimeAuthorityV2={projectId:'p1',sessionId:'s1',clientId:'c1',connectionGeneration:'conn1',workspaceVersion:1,configurationGeneration:'cfg1',connected:true,canExecute:true,canSaveSettings:true};
  let resolve!:(v:RunV2)=>void,signal!:AbortSignal;
  const pending=new Promise<RunV2>(r=>resolve=r),runs:any[]=[],stops:any[]=[],saves:any[]=[],confirmed:any[]=[];
  const cancelled={...run(),status:'CANCELLED' as const,finishedAt:'2026-11-11T21:00:01.000Z'};
  const p=project(),client=new RuntimeClientV2({current:()=>authority,requestId:()=>`req${runs.length+stops.length+saves.length}`,confirmedMutation:m=>confirmed.push(m),http:{
    run:async(body,s)=>{runs.push(body);signal=s;return pending;},stop:async(id,body)=>{stops.push({id,body});return cancelled;},saveSettings:async(body)=>{saves.push(body);return p;},
  }});
  t.after(()=>client.dispose());assert.equal(client.applyProject(p,previous),true);
  return {client,p,runs,stops,saves,confirmed,cancelled,resolve,get signal(){return signal;},get authority(){return authority;},setAuthority:(a:RuntimeAuthorityV2)=>authority=a};
}
test('known same-run Stop interrupts pending RUN wait; late original reply cannot overwrite Stop or clear exact unknown',async t=>{
  const f=fixture(t),pending=f.client.run('RUN_TESTS');
  assert.equal(f.runs.length,1);
  assert.equal(f.client.applyProject(f.p,{...run(),status:'QUEUED',startedAt:null}),true);
  const original={kind:'RUN' as const,requestId:f.runs[0].requestId,projectId:'p1',sessionId:'s1',clientId:'c1',expectedWorkspaceVersion:1};
  assert.equal(await f.client.stop(),true);
  assert.equal(f.signal.aborted,true);
  assert.equal(f.stops.length,1);assert.equal(f.stops[0].id,'run1');
  assert.equal(f.client.snapshot().run?.status,'CANCELLED');
  assert.deepEqual(f.client.retainedMutations(),[original]);
  assert.equal(await f.client.run('RUN_TESTS'),false);
  assert.equal((await f.client.saveSettings(f.p.settings,1)).ok,false);
  assert.equal(f.runs.length,1);assert.equal(f.saves.length,0);
  f.resolve({...run(),status:'QUEUED',startedAt:null});
  assert.equal(await pending,false);
  assert.equal(f.client.snapshot().run?.status,'CANCELLED');
  assert.deepEqual(f.client.retainedMutations(),[original]);assert.equal(f.confirmed.length,0);
  assert.equal(await f.client.reconcileRetained(original,async()=>({project:f.p,run:f.cancelled})),true);
  assert.equal(f.client.snapshot().reconciliationRequired,false);
  assert.equal(f.runs.length,1);
});
for(const kind of ['unobserved','previous','wrong-mode','wrong-version','wrong-config','offline','binding','disposed'] as const)test('pending RUN Stop is still denied for '+kind,async t=>{
  const prior=kind==='previous'?{...run(),status:'SUCCEEDED' as const,exitCode:0,finishedAt:'2026-11-11T21:00:01.000Z',testOutcome:'PASSED' as const,testCount:1}:null;
  const f=fixture(t,prior),pending=f.client.run('RUN_TESTS');
  let value:RunV2={...run(),status:'QUEUED',startedAt:null};
  if(kind==='wrong-mode')value={...value,mode:'RUN_MAIN',testOutcome:'NOT_APPLICABLE'};
  if(kind==='wrong-version')value={...value,workspaceVersionAtStart:0};
  if(kind==='wrong-config')value={...value,configurationGeneration:'foreign'};
  if(kind!=='unobserved')f.client.applyProject(f.p,value);
  if(kind==='offline')f.setAuthority({...f.authority,connected:false});
  if(kind==='binding')f.setAuthority({...f.authority,connectionGeneration:'different'});
  if(kind==='disposed')f.client.dispose();
  assert.equal(await f.client.stop(),false);
  assert.equal(f.stops.length,0);
  f.resolve(run());await pending;
});
test('own streamed RUNNING state remains newer than the original QUEUED HTTP acceptance',async t=>{
  const f=fixture(t),pending=f.client.run('RUN_TESTS');
  f.client.applyProject(f.p,run());f.resolve({...run(),status:'QUEUED',startedAt:null});
  assert.equal(await pending,true);
  assert.equal(f.client.snapshot().run?.status,'RUNNING');
  assert.equal(f.client.snapshot().reconciliationRequired,false);
  assert.equal(f.confirmed.length,1);
});
test('different returned run ID cannot discharge the pending original observed Run',async t=>{
  const f=fixture(t),pending=f.client.run('RUN_TESTS');f.client.applyProject(f.p,run());f.resolve({...run(),runId:'foreign-run'});
  assert.equal(await pending,false);assert.equal(f.client.snapshot().run?.runId,'run1');
  assert.equal(f.client.snapshot().reconciliationRequired,true);
});
for(const kind of ['nullrun','other-run','settings','execution','scope','workspace','connection','intervening-null'] as const)test('unrelated observation cannot legitimize a late RUN receipt: '+kind,async t=>{
  const f=fixture(t),pending=f.client.run('RUN_TESTS');
  f.client.applyProject(f.p,run());
  const p=structuredClone(f.p);
  if(kind==='settings')p.settings.reviewNotesPath='changed.md';
  if(kind==='execution')p.capabilities.execution.modes.RUN_TESTS={canRun:false,problem:{code:'PENDING',message:'Pending',recovery:'Wait',retryable:true}};
  if(kind==='scope'){p.projectId='other';p.capabilities.language.projectId='other';f.setAuthority({...f.authority,projectId:'other'});}
  if(kind==='workspace'){p.workspaceVersion=2;f.setAuthority({...f.authority,workspaceVersion:2});}
  if(kind==='connection')f.setAuthority({...f.authority,connectionGeneration:'different'});
  assert.equal(f.client.applyProject(p,kind==='nullrun'||kind==='intervening-null'?null:kind==='other-run'?{...run(),runId:'unrelated'}:run()),true);
  if(kind==='intervening-null')f.client.applyProject(f.p,run());
  f.resolve({...run(),status:'QUEUED',startedAt:null});
  assert.equal(await pending,false);
  assert.equal(f.confirmed.length,0);
  // An old-project operation stays retained internally even if the current scope differs.
  f.setAuthority({...f.authority,projectId:'p1'});
  assert.equal(f.client.snapshot().reconciliationRequired,true);
});
test('streamed terminal result is not rewound by a late original acceptance',async t=>{
  const f=fixture(t),pending=f.client.run('RUN_TESTS');
  const terminal={...run(),status:'SUCCEEDED' as const,exitCode:0,finishedAt:'2026-11-11T21:00:01.000Z',testOutcome:'PASSED' as const,testCount:1};
  assert.equal(f.client.applyProject(f.p,terminal),true);
  f.resolve({...run(),status:'QUEUED',startedAt:null});assert.equal(await pending,true);
  assert.deepEqual(f.client.snapshot().run,terminal);assert.equal(f.client.snapshot().reconciliationRequired,false);
});
test('pending SAVE/reconcile do not gain the narrow pending-RUN Stop exception',async t=>{
  const a:RuntimeAuthorityV2={projectId:'p1',sessionId:'s1',clientId:'c1',connectionGeneration:'conn1',workspaceVersion:1,configurationGeneration:'cfg1',connected:true,canExecute:true,canSaveSettings:true};
  const p=project();let resolve!:(v:any)=>void,stops=0;
  const client=new RuntimeClientV2({current:()=>a,requestId:()=> 'request',http:{
    run:async()=>{throw Error('lost RUN response');},saveSettings:async()=>new Promise(r=>resolve=r),stop:async()=>{stops++;return run();},
  }});t.after(()=>client.dispose());client.applyProject(p,run());
  const save=client.saveSettings(p.settings,1);assert.equal(await client.stop(),false);assert.equal(stops,0);
  resolve(p);await save;
  // Invalid result leaves an exact unresolved SAVE; recovery is still singleflight.
  const original=client.retainedMutations()[0];assert.ok(original);
  const recovery=client.reconcileRetained(original,async()=>new Promise(r=>resolve=r));
  assert.equal(await client.stop(),false);assert.equal(stops,0);
  resolve({project:p,run:run()});await recovery;
});
test('late RUN reply after invalidation cannot replace a new binding or erase the original uncertainty',async t=>{
  const f=fixture(t),pending=f.client.run('RUN_TESTS');f.client.applyProject(f.p,run());
  f.client.invalidate();f.setAuthority({...f.authority,connectionGeneration:'new-connection'});
  const current={...run(),runId:'current-run'};f.client.applyProject(f.p,current);
  f.resolve({...run(),status:'QUEUED',startedAt:null});assert.equal(await pending,false);
  assert.deepEqual(f.client.snapshot().run,current);assert.equal(f.client.snapshot().reconciliationRequired,true);assert.equal(f.confirmed.length,0);
});
