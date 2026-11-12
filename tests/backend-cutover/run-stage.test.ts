/** Real original RUN journal, actual Runner/executor/adapter/gate/files. Docker is controlled UNIT.
 * Child SIGKILL is genuine process-death durability, NOT Docker/native/runtime readiness proof. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { executionFixture, until } from './execution-composition-fixture';
import { DurableMutationJournal, type MutationIdentity } from '../../src/server/runtime-coordinator/MutationJournal';
import { createRuntimeWorkspace } from '../../src/server/runtime-coordinator/RuntimeWorkspace';
import { RuntimeRunMutation } from '../../src/server/runtime-coordinator/RuntimeRunMutation';
import { DurableRunJournal } from '../../src/server/execution/DurableRunJournal';
const unknown = {state:'UNKNOWN',result:null}, aborted = {state:'DEFINITIVELY_ABORTED',result:null};
const committed = (result:unknown) => ({state:'COMMITTED',result} as const);
async function fixture(t:test.TestContext) {
  let journal!: DurableMutationJournal;
  // Register before fixture removal: production lease validates the still-existing canonical inode.
  t.after(async()=>{await journal?.close();});
  const f = await executionFixture(t), directory=path.join(f.core.workspace.dataDir,'run-mutations');
  journal = new DurableMutationJournal(directory);
  let mutations=new RuntimeRunMutation(f.core,journal,f.execution);
  const identity=(request=f.request()):MutationIdentity=>({projectId:f.core.workspace.projectId,
    sessionId:request.sessionId,clientId:request.clientId,requestId:request.requestId,kind:'RUN',payload:request});
  return {...f, get journal(){return journal;},get mutations(){return mutations;},identity,
    async reopen(){await journal.close();journal=new DurableMutationJournal(directory);
      mutations=new RuntimeRunMutation(f.core,journal,{start:async()=>assert.fail('No process replay after reopen')});}};
}
test('RUN durable original QUEUED exists before actual executor create; terminal/current changes never rewrite acceptance',async t=>{
  const f=await fixture(t), request=f.request(), runDocker=f.fake.run.bind(f.fake);let inspected=false;
  f.fake.run=async args=>{
    if(args[0]==='create'){
      const admissions=f.journal.runAdmissions();assert.equal(admissions.length,1);
      assert.equal(admissions[0].stage.result.status,'QUEUED');
      assert.deepEqual(admissions[0].identity.payload,request);
      assert.equal(fs.existsSync(path.join(admissions[0].stage.plan.input.immutableDirectory,'main.js')),true);
      inspected=true;
    }
    return runDocker(args);
  };
  const result=await f.mutations.execute(request);assert.equal(result.state,'COMMITTED');if(result.state!=='COMMITTED')return;
  assert.equal(inspected,true);assert.equal(result.result.status,'QUEUED');
  assert.equal(f.execution.runner.get(result.result.runId).status,'RUNNING');
  const staged=f.journal.runAdmissions()[0].stage;
  assert.deepEqual(staged.plan,(await f.execution.journal.read(result.result.runId)).plan);
  assert.equal(staged.policy.managedCacheRoot,f.preparedRoot);assert.equal(staged.policy.serviceNetwork,null);
  f.fake.finish();await until(()=>f.execution.runner.get(result.result.runId).status==='SUCCEEDED');
  const doc=f.core.workspace.getDocument('main.js');await f.core.gate.writeAsync({clientId:'tab',sessionId:request.sessionId,
    actor:'STUDENT',controlEpoch:f.core.session.state.controlEpoch,path:doc.path,baseVersion:doc.version,content:'AFTER ACCEPTANCE\n'});
  assert.deepEqual(await f.mutations.execute(request),result);
  await f.reopen();assert.deepEqual(await f.mutations.recover(request),result);
  assert.deepEqual(f.journal.runAdmissions()[0].stage,staged);
  assert.equal(f.fake.calls.filter(a=>a[0]==='create').length,1);
});
test('RUN actual pre-admission validation failure has typed no-start proof, durable abort and no late replay',async t=>{
  const f=await fixture(t),request=f.request();fs.writeFileSync(path.join(f.workspace,'package.json'),'{"changed":true}');
  assert.deepEqual(await f.mutations.execute(request),unknown);
  assert.equal(f.journal.readRunReservation(f.identity(request)).stage,null);
  assert.equal(f.fake.calls.some(a=>a[0]==='create'),false);
  assert.deepEqual(await f.mutations.recover(request),aborted);await f.reopen();
  assert.deepEqual(await f.mutations.execute(request),aborted);
});
test('RUN live FIFO capture cannot be aborted; caller mutation and Veto never adopt a new epoch',async t=>{
  const f=await fixture(t),request=f.request(),original=structuredClone(request);
  let enter!:()=>void,release!:()=>void;const entered=new Promise<void>(r=>enter=r),held=new Promise<void>(r=>release=r);
  const blocked=f.core.workspace._withQueuedMutation(async()=>{enter();await held;});await entered;
  const pending=f.mutations.execute(request);
  // Reservation is serialized before recovery; it must not return a premature definitive abort.
  assert.deepEqual(await f.mutations.recover(original),unknown);
  await assert.rejects(f.journal.execute({...f.identity(original),requestId:'new'},async()=>committed('no')),{code:'MUTATION_PENDING'});
  request.configurationGeneration='caller-mutated';request.mode='RUN_TESTS';
  f.core.session.veto();release();await blocked;
  assert.deepEqual(await pending,unknown);assert.deepEqual(await f.mutations.recover(original),aborted);
  assert.equal(f.fake.calls.some(a=>a[0]==='create'),false);
});
test('RUN fsynced acceptance then interrupted callback remains original accepted, never inferred aborted from no process',async t=>{
  const f=await fixture(t),request=f.request(),stage=f.journal.stageRun.bind(f.journal);
  f.journal.stageRun=(identity,original)=>{stage(identity,original);throw Error('lost after actual fsync');};
  assert.deepEqual(await f.mutations.execute(request),unknown);
  assert.equal(f.fake.calls.some(a=>a[0]==='create'),false);
  const original=f.journal.runAdmissions()[0].stage.result;
  assert.deepEqual(await f.mutations.recover(request),committed(original));await f.reopen();
  assert.deepEqual(await f.mutations.execute(request),committed(original));
});
test('RUN absent tombstone, changed immutable request and unrelated generic UNKNOWN are not admission proof',async t=>{
  const f=await fixture(t),request=f.request();
  assert.deepEqual(await f.mutations.recover(request),aborted);
  assert.deepEqual(await f.mutations.execute(request),aborted);assert.equal(f.fake.calls.some(a=>a[0]==='create'),false);
  await assert.rejects(f.mutations.execute({...request,mode:'RUN_TESTS'}),{code:'IDEMPOTENCY_CONFLICT'});
  const other={...request,requestId:'unrelated-generic'};
  await f.journal.execute(f.identity(other),async()=>{throw Error('generic unknown effect');});
  assert.deepEqual(await f.mutations.recover(other),unknown);await f.reopen();
  assert.deepEqual(await f.mutations.recover(other),unknown);
});
for(const boundary of ['RESERVED','ACCEPTED','STARTED'] as const)test('RUN actual SIGKILL '+boundary+' preserves protocol/original plan with zero replay',async t=>{
  const child=spawn(process.execPath,['--import','tsx',fileURLToPath(new URL('./run-stage-crash-child.ts',import.meta.url)),boundary],
    {env:{...process.env,TSX_DISABLE_CACHE:'1'},stdio:['ignore','pipe','pipe']});
  let stdout='',stderr='';child.stdout.on('data',b=>stdout+=b);child.stderr.on('data',b=>stderr+=b);
  const timer=setTimeout(()=>child.kill('SIGKILL'),10000);let expired=false;
  const observe=setTimeout(()=>expired=true,9900);
  const exit=await new Promise<{signal:string|null}>((resolve,reject)=>{child.once('error',reject);child.once('exit',(_code,signal)=>resolve({signal}));});
  clearTimeout(timer);clearTimeout(observe);assert.equal(expired,false,stderr);assert.equal(exit.signal,'SIGKILL',stderr);
  const data=JSON.parse(stdout.trim());
  const core=await createRuntimeWorkspace({rootPath:data.workspace});
  const journal=new DurableMutationJournal(data.directory);
  t.after(async()=>{await journal.close();core.close();
    const unlock=(p:string)=>{if(fs.lstatSync(p).isDirectory()){fs.chmodSync(p,0o700);for(const n of fs.readdirSync(p))unlock(path.join(p,n));}};
    unlock(data.root);fs.rmSync(data.root,{recursive:true,force:true});});
  const mutations=new RuntimeRunMutation(core,journal,{start:async()=>assert.fail('Restart MUST NOT replay start')});
  assert.deepEqual(await journal.reconcile(data.identity),unknown);
  const reservation=journal.readRunReservation(data.identity);assert.equal(reservation.protocol,true);
  if(boundary==='RESERVED') {
    assert.equal(reservation.stage,null);assert.deepEqual(await mutations.recover(data.request),aborted);
  }else{
    assert.ok(reservation.stage);assert.equal(reservation.stage.result.status,'QUEUED');
    // Later raw/current workspace is not original-result authority.
    fs.writeFileSync(path.join(data.workspace,'main.js'),'LATER RESTART SOURCE\n');
    assert.deepEqual(await mutations.recover(data.request),committed(reservation.stage.result));
    assert.deepEqual(await mutations.execute(data.request),committed(reservation.stage.result));
    const executionJournal=new DurableRunJournal(data.journalDirectory,data.installationId);
    const records=await executionJournal.list();assert.equal(records.length,boundary==='STARTED'?1:0);
    if(boundary==='STARTED') {assert.equal(records[0].phase,'RUNNING');assert.deepEqual(records[0].plan,reservation.stage.plan);}
    assert.deepEqual(journal.runAdmissions()[0].stage,reservation.stage);
  }
});
test('RUN Veto between durable reservation and actual coordinator admission cannot adopt later epoch',async t=>{
  const f=await fixture(t),request=f.request();
  const pending=f.mutations.execute(request);
  // Actual mutation serial admission yields. Caller Veto happens BEFORE coordinator.start.
  f.core.session.veto();
  assert.deepEqual(await pending,unknown);
  assert.equal(f.fake.calls.some(a=>a[0]==='create'),false);
  assert.deepEqual(await f.mutations.recover(request),aborted);
});
for(const substitution of ['RUN','PROJECT','POLICY'] as const)test('RUN rejects substituted original '+substitution+' before process invocation',async t=>{
  const f=await fixture(t),request=f.request();
  const mutations=new RuntimeRunMutation(f.core,f.journal,{start:(request,admit)=>f.execution.start(request,(run,plan,policy)=>{
    if(substitution==='RUN')run.startedAt='2026-11-12T00:00:00.000Z';
    if(substitution==='PROJECT')plan.input={...plan.input,projectId:'foreign'};
    if(substitution==='POLICY')policy.managedCacheRoot='relative/unapproved';
    admit(run,plan,policy);
  })});
  assert.deepEqual(await mutations.execute(request),unknown);
  assert.equal(f.fake.calls.some(a=>a[0]==='create'),false);
  assert.deepEqual(await mutations.recover(request),aborted);
});
test('RUN live start after durable acceptance excludes recovery and snapshots caller request without replay',async t=>{
  const f=await fixture(t),request=f.request(),original=structuredClone(request),runDocker=f.fake.run.bind(f.fake);
  let enter!:()=>void,release!:()=>void;const entered=new Promise<void>(r=>enter=r),held=new Promise<void>(r=>release=r);
  f.fake.run=async args=>{if(args[0]==='create'){enter();await held;}return runDocker(args);};
  const pending=f.mutations.execute(request);await entered;
  assert.equal(f.journal.runAdmissions().length,1);
  assert.deepEqual(await f.mutations.recover(original),unknown);
  assert.deepEqual(await f.mutations.execute(original),unknown);
  request.mode='RUN_TESTS';request.configurationGeneration='caller-mutated';
  release();const result=await pending;
  assert.equal(result.state,'COMMITTED');if(result.state!=='COMMITTED')return;
  assert.equal(result.result.mode,'RUN_MAIN');assert.equal(result.result.configurationGeneration,'cfg');
  assert.deepEqual(f.journal.runAdmissions()[0].identity.payload,original);
  const copy=f.journal.runAdmissions()[0];copy.stage.result.outputTail='caller';copy.stage.policy.managedCacheRoot='/foreign';
  assert.equal(f.journal.runAdmissions()[0].stage.result.outputTail,'');
  assert.equal(f.journal.runAdmissions()[0].stage.policy.managedCacheRoot,f.preparedRoot);
  assert.equal(f.fake.calls.filter(a=>a[0]==='create').length,1);
});
