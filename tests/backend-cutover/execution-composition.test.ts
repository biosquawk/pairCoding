/** Fake Docker ONLY, genuine default public Runner/registry/executor/gate/input/receipt path. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { executionFixture, until } from './execution-composition-fixture';
test('UNIT actual production composition preserves immutable ACK input and settles Main through genuine terminal receipt before rm',async t=>{
  const f=await executionFixture(t),original=fs.readFileSync(path.join(f.workspace,'main.js'));
  const run=await f.execution.start(f.request());assert.equal(run.status,'RUNNING');
  const record=await f.execution.journal.read(run.runId);assert.equal(record.phase,'RUNNING');
  assert.deepEqual(fs.readFileSync(path.join(record.plan.input.immutableDirectory,'main.js')),original);
  const doc=f.core.workspace.getDocument('main.js');await f.core.gate.writeAsync({clientId:'tab',sessionId:f.core.session.state.sessionId,actor:'STUDENT',controlEpoch:f.core.session.state.controlEpoch,path:'main.js',baseVersion:doc.version,content:'LATER\n'});
  assert.deepEqual(fs.readFileSync(path.join(record.plan.input.immutableDirectory,'main.js')),original);
  await assert.rejects(f.execution.start(f.request()),{code:'RUN_IN_PROGRESS'});
  f.fake.finish();await until(()=>f.execution.runner.get(run.runId).status==='SUCCEEDED');
  const terminal=f.execution.runner.get(run.runId);assert.equal(terminal.testOutcome,'NOT_APPLICABLE');assert.equal(terminal.workspaceChangedDuringRun,true);
  const persisted=await f.execution.journal.read(run.runId);assert.equal(persisted.phase,'REMOVED');assert.equal(persisted.outcome?.status,'SUCCEEDED');
  assert.equal(f.fake.calls.filter(a=>a[0]==='create').length,1);assert.equal(f.fake.calls.filter(a=>a[0]==='rm').length,1);
});
test('UNIT current raw dependency change rejects before actual executor create while manual editing remains live',async t=>{
  const f=await executionFixture(t);fs.writeFileSync(path.join(f.workspace,'package.json'),'{"changed":true}');
  await assert.rejects(f.execution.start(f.request()));assert.equal(f.fake.calls.some(a=>a[0]==='create'),false);
  const doc=f.core.workspace.getDocument('main.js');await f.core.gate.writeAsync({clientId:'tab',sessionId:f.core.session.state.sessionId,actor:'STUDENT',controlEpoch:f.core.session.state.controlEpoch,path:'main.js',baseVersion:doc.version,content:'EDITABLE\n'});
  assert.equal(f.core.workspace.getDocument('main.js').content,'EDITABLE\n');
});
test('UNIT lost daemon retains same actual Run ownership, prohibits new Run and only same-run Stop settles it',async t=>{
  const f=await executionFixture(t),run=await f.execution.start(f.request());f.fake.daemon=false;
  await assert.rejects(f.execution.runner.stop(run.runId));assert.equal(f.execution.runner.get(run.runId).status,'PROCESS_STOP_UNCONFIRMED');
  await assert.rejects(f.execution.start(f.request()),{code:'RUN_IN_PROGRESS'});assert.equal(f.fake.calls.filter(a=>a[0]==='rm').length,0);
  f.fake.daemon=true;assert.equal((await f.execution.runner.stop(run.runId)).status,'CANCELLED');
  assert.equal((await f.execution.journal.read(run.runId)).phase,'REMOVED');assert.equal(f.fake.calls.filter(a=>a[0]==='create').length,1);
});
