/** UNIT full real production composition, synthetic preparation and injected Docker ONLY. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { executionFixture } from '../backend-cutover/execution-composition-fixture';
import { RuntimeRunState } from '../../src/server/runtime-coordinator/RuntimeRunState';

for(const first of ['executor','runner'] as const)test(`full production route: ${first}-first deadline durably retains TIMED_OUT, physical exit128 stays FAILED`,async t=>{
  t.mock.timers.enable({apis:['Date','setTimeout'],now:Date.now()});
  const f=await executionFixture(t),settingsFile=path.join(f.workspace,'.paircoach','settings.json');
  const settings=JSON.parse(fs.readFileSync(settingsFile,'utf8'));
  for(const profile of settings.runProfiles)profile.timeoutMs=1000;
  fs.writeFileSync(settingsFile,JSON.stringify(settings));
  // Actual executor createdAt precedes start. Advance ONLY before Runner.observe starts its timer.
  const states=new RuntimeRunState(path.join(f.layout.stateDirectory,'run-state'));
  let durableReasonBeforeEffect:string|null|undefined;
  f.fake.onStart=async()=>{if(first==='executor')t.mock.timers.tick(1001);};
  const docker=f.fake.run.bind(f.fake);
  f.fake.run=async args=>{
    if(args[0]==='stop'){
      const [owner]=await f.execution.journal.list();
      durableReasonBeforeEffect=states.read(owner.plan)?.requested;
    }
    return docker(args);
  };
  f.fake.onStop=async()=>{f.fake.v.State.ExitCode=128;};
  const run=await f.execution.start(f.request()),deadline=process.hrtime.bigint()+10000000000n;
  if(first==='runner')t.mock.timers.tick(1000);
  while(['QUEUED','RUNNING','STOPPING'].includes(f.execution.runner.get(run.runId).status)){
    assert.ok(process.hrtime.bigint()<deadline,'bounded full-composition interleaving');
    await new Promise<void>(resolve=>setImmediate(resolve));
  }
  assert.equal(f.execution.runner.get(run.runId).status,'TIMED_OUT');
  const record=await f.execution.journal.read(run.runId);
  assert.equal(record.plan.timeoutMs,1000);assert.equal(record.exit!.exitCode,128);assert.equal(record.outcome!.status,'FAILED');
  assert.equal(record.phase,'REMOVED');assert.ok(record.collection);
  assert.equal(durableReasonBeforeEffect,'TIMEOUT');
  const state=states.read(record.plan);
  assert.equal(state!.requested,'TIMEOUT');assert.equal(state!.run.status,'TIMED_OUT');
  assert.deepEqual(state!.run,f.execution.runner.get(run.runId));
  for(const operation of ['create','start','stop','rm'])assert.equal(f.fake.calls.filter(c=>c[0]===operation).length,1);
});
