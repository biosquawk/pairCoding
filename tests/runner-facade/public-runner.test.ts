/** Actual public import, controlled port UNIT only; never host task/Docker execution. */
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import * as Public from '../../src/server/Runner';
import { RuntimeRunner as InternalRunner } from '../../src/server/runtime-coordinator/RuntimeRunner';
import type { ExecutionPlan } from '../../src/server/execution/ports';
import { deferred, fixture } from './fixture';

// Guard real host-process primitives as well as checking the source boundary in boundary.test.ts.
function forbidHostTask(t: TestContext) {
  for (const name of ['spawn','spawnSync','exec','execSync','execFile','execFileSync','fork'] as const) {
    t.mock.method(childProcess, name, () => { assert.fail('Host process execution is forbidden'); });
  }
  syncBuiltinESMExports();
  t.after(()=>{t.mock.restoreAll();syncBuiltinESMExports();});
}

test('public Runner and RuntimeRunner are the exact existing coordinator, without a legacy host API',()=>{
  assert.equal(Public.Runner,InternalRunner);
  assert.equal(Public.RuntimeRunner,InternalRunner);
  assert.equal('setApprovedProfiles' in Public.Runner.prototype,false);
  assert.deepEqual(Object.keys(Public).sort(),['Runner','RuntimeRunner','parseJUnit']);
});

test('public Runner uses the injected typed execution port, approved immutable plan and output',async t=>{
  forbidHostTask(t);
  const f=fixture();let seen:ExecutionPlan|undefined;
  f.execution.start=async plan=>{seen=plan;f.calls.push('start');return f.handle;};
  const run=await f.runner.start(f.admission);
  assert.equal(run.status,'RUNNING');
  assert.deepEqual(f.calls,['readiness','capture','plan','start']);
  assert.deepEqual(seen?.command.environment,{});
  assert.deepEqual(seen?.command.args,[';literal']);
  assert.equal(seen?.input.identity.manifestSha256,f.context.input.identity.manifestSha256);
  assert.equal(seen?.lockedImage.imageId,f.context.lockedImage.imageId);
  f.admission.profile.label='caller mutation';
  assert.equal(seen?.profile.label,'Unit profile');
  f.output('literal output');f.change();
  assert.equal(f.runner.get(run.runId).outputTail,'literal output');
  assert.equal(f.runner.get(run.runId).workspaceChangedDuringRun,true);
  const copy=f.runner.get(run.runId);copy.outputTail='not internal state';
  assert.equal(f.runner.get(run.runId).outputTail,'literal output');
  assert.ok(!f.calls.includes('persist'));assert.ok(!f.calls.includes('cleanup'));
});

test('public Runner denied readiness performs zero capture/start and releases its admission',async t=>{
  forbidHostTask(t);
  const f=fixture();
  f.execution.readiness=async(_p,g)=>({configurationGeneration:g,modes:{
    RUN_MAIN:{canRun:false,problem:{code:'IMAGE_MISSING',message:'missing',recovery:'prepare',retryable:true}},RUN_TESTS:{canRun:false,problem:null}}});
  for(let attempt=0;attempt<2;attempt++)await assert.rejects(f.runner.start(f.admission),{code:'IMAGE_MISSING'});
  assert.deepEqual(f.calls,[]);assert.deepEqual(f.runner.list(),[]);
});

test('public Runner reserves singleflight synchronously before readiness completes',async t=>{
  forbidHostTask(t);
  const f=fixture(),barrier=deferred<void>();
  const ready=f.execution.readiness;
  f.execution.readiness=async(p,g)=>{await barrier.promise;return ready(p,g);};
  const pending=f.runner.start(f.admission);
  await assert.rejects(f.runner.start(f.admission),{code:'RUN_IN_PROGRESS'});
  assert.equal(f.runner.list()[0].status,'QUEUED');assert.deepEqual(f.calls,[]);
  barrier.resolve();assert.equal((await pending).status,'RUNNING');
  assert.equal(f.calls.filter(c=>c==='start').length,1);
});

test('public Runner unconfirmed Stop and same-run retry retain ownership through missing genuine receipt',async t=>{
  forbidHostTask(t);
  const f=fixture(),run=await f.runner.start(f.admission);
  await assert.rejects(f.runner.stop(run.runId),{code:'PROCESS_STOP_UNCONFIRMED'});
  assert.equal(f.runner.get(run.runId).status,'PROCESS_STOP_UNCONFIRMED');
  assert.equal(f.runner.get(run.runId).finishedAt,null);
  await assert.rejects(f.runner.start(f.admission),{code:'RUN_IN_PROGRESS'});
  f.execution.stop=async(handle,reason)=>{
    assert.deepEqual(handle,f.handle);assert.equal(reason,'USER');f.calls.push('stop');return {confirmed:true,exit:f.exit};
  };
  await assert.rejects(f.runner.stop(run.runId),/Genuine receipt boundary/);
  assert.deepEqual(f.calls.slice(-4),['stop','collect','interpret','persist']);
  await assert.rejects(f.runner.stop(run.runId),/Genuine receipt boundary/);
  await assert.rejects(f.runner.start(f.admission),{code:'RUN_IN_PROGRESS'});
  assert.equal(f.calls.filter(c=>c==='start').length,1);
  assert.equal(f.calls.filter(c=>c==='stop').length,2);
  assert.equal(f.calls.filter(c=>c==='collect').length,1);
  assert.equal(f.calls.filter(c=>c==='persist').length,2);
  assert.ok(!f.calls.includes('cleanup'));assert.equal(f.runner.get(run.runId).finishedAt,null);
});

test('public Runner lost start never falls back; foreign orphan cannot authorize a same-run Stop',async t=>{
  forbidHostTask(t);
  const f=fixture();
  f.execution.start=async()=>{f.calls.push('start');throw Error('lost start response');};
  const run=await f.runner.start(f.admission);
  assert.equal(run.status,'PROCESS_STOP_UNCONFIRMED');
  f.execution.inspectOwnedOrphans=async()=>[{ownership:{...f.context.ownership,engineId:'foreign'},handle:f.handle,state:'RUNNING',durableReceipt:null}];
  await assert.rejects(f.runner.stop(run.runId),/unique exact-owned/);
  assert.ok(!f.calls.includes('stop'));
  await assert.rejects(f.runner.start(f.admission),{code:'RUN_IN_PROGRESS'});
  assert.equal(f.calls.filter(c=>c==='start').length,1);
});
