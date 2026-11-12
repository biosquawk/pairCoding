/** Migrated public Runner fixture. UNIT injected Docker is not LIVE process proof.
 * Unfiltered LIVE cases deliberately fail with actionable prerequisites, never skip/todo.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { Runner, parseJUnit } from '../../src/server/Runner';
import { validatePlan } from '../../src/server/execution/PlanPolicy';
import { fixture, profile, testsProfile, outputPayload } from '../runner-fixture-migration/fixture';
import { literalTransport } from '../runner-fixture-migration/transport';
import { liveFixture, liveTree } from '../runner-fixture-migration/live';
const passedXML = '<testsuite tests="1" failures="0" errors="0" skipped="0"><testcase name="real-case"/></testsuite>';

test('UNIT TEST-019 approved profiles deny by default; modified args and escaped cwd cannot run', async t => {
  const f=await fixture(t), p=profile();
  assert.equal('setApprovedProfiles' in Runner.prototype,false,'No legacy compatibility runner');
  const denied={...f.policy,runtimes:[]};
  const run=await f.start(p), plan=await f.plan(run.runId,p);
  await assert.rejects(validatePlan(denied,plan),/Unapproved runtime profile/);
  // Command grammar is pure and independent of mutable build/artifacts admission.
  const invalidArgs=structuredClone(plan);invalidArgs.command.args=['-e','throw Error()'];
  // Exercise the actual independent production validator, not a mocked adapter decision.
  const { validateRuntimeCommand }=await import('../../src/server/execution/RuntimeCommand');
  assert.throws(()=>validateRuntimeCommand(invalidArgs),/TASK_CONFIG_INVALID/);
  assert.equal((await f.adapter.validate(f.runtime,profile({task:{...p.task,entry:{kind:'SCRIPT',path:';echo NOT_A_SHELL.cjs'}}}))).valid,false);
  const escape=profile({task:{...p.task,workingDirectory:'..'}});
  assert.equal((await f.adapter.validate(f.runtime,escape)).valid,false);
  const invalid=profile({timeoutMs:999});
  await assert.rejects(f.runner.start(f.admission(invalid)),{code:'RUN_IN_PROGRESS'});
  await f.finish(run);
  await assert.rejects(f.runner.start(f.admission(invalid)),/Run admission/);
  f.revoke();await assert.rejects(f.runner.start(f.admission(p)),/current approved/);
});

test('UNIT Run streams stdout/stderr with bounded tail, sequence, no shell interpolation, version change', async t => {
  const f=await fixture(t),run=await f.start();
  await assert.rejects(f.runner.start(f.admission()),/aktywne/);
  f.change();
  // Injected logs, but real executor delta/chunk pipeline -> actual public Runner state.
  f.unit.logs={stdout:'x'.repeat(70000),stderr:';echo NOT_A_SHELL'};
  const result=await f.finish(run);
  assert.equal(result.status,'SUCCEEDED');assert.equal(result.exitCode,0);assert.equal(result.testOutcome,'NOT_APPLICABLE');
  assert.equal(result.outputTail.length,65536);assert.equal(result.outputTruncated,true);assert.equal(result.workspaceChangedDuringRun,true);
  const output=f.events.filter(e=>e.type==='RUN_OUTPUT').map(e=>e.payload);
  assert.ok(output.every(outputPayload));
  const typed=output.filter(outputPayload);
  assert.ok(typed.some(e=>e.stream==='STDERR' && e.chunk.includes(';echo NOT_A_SHELL')));
  typed.forEach((e,i)=>{assert.equal(e.outputSeq,i+1);assert.ok(e.chunk.length<=16384);});
  result.outputTail='mutation';assert.notEqual(f.runner.get(run.runId).outputTail,'mutation');
  await literalTransport(t); // genuine shell:false/env composition, intercepted spawn only
});

test('UNIT TEST-019 exit zero without a report is UNKNOWN; missing runtime is not a pass', async t => {
  const f=await fixture(t),run=await f.start(testsProfile());
  assert.equal((await f.finish(run)).testOutcome,'UNKNOWN');
  f.unit.imagePresent=false;
  // V2 has no task executable slot; missing pinned runtime is admission rejection, never SUCCEEDED.
  await assert.rejects(f.start(),{code:'IMAGE_MISSING'});
  assert.equal(f.runner.list().length,1);
  assert.equal(f.unit.calls.filter(a=>a[0]==='create').length,1);
  assert.equal((await fs.readdir(f.runs)).length,1,'Missing runtime performs zero capture');
});

test('UNIT TEST-019 fresh runId JUnit is PASSED; old unchanged report cannot produce PASSED', async t => {
  const f=await fixture(t),run=await f.start(testsProfile());
  const artifact=path.join(f.context(run.runId).input.artifactsDirectory,`report-${run.runId}.xml`);
  const result=await f.finish(run,passedXML);
  assert.equal(result.testOutcome,'PASSED');assert.equal(result.testCount,1);
  assert.equal(await fs.readFile(artifact,'utf8'),passedXML);
  const stale=path.join(f.root,'old.xml');await fs.writeFile(stale,passedXML);await fs.utimes(stale,new Date(10000),new Date(10000));
  // A stale student report in the build copy is not an execution-output artifact;
  // actual empty artifacts collection from the next Run must never discover workspace old.xml.
  const second=await f.start(testsProfile());
  assert.notEqual(second.runId,run.runId);
  await fs.copyFile(stale,path.join(f.context(second.runId).input.buildDirectory,'old.xml'));
  assert.equal((await f.finish(second)).testOutcome,'UNKNOWN');
  assert.equal(await fs.readFile(stale,'utf8'),passedXML);
  // The actual interpreter also refuses a retained collected report marked stale for THIS run.
  const collected=await f.journal.read(run.runId);assert.ok(collected.collection && collected.exit);
  const staleCollection=structuredClone(collected.collection);staleCollection.files[0].freshForRun=false;
  assert.equal((await f.adapter.interpret(collected.plan,collected.exit,staleCollection)).testOutcome,'UNKNOWN');
});

for (const [xml, outcome, status] of [
    ['<testsuite tests="0"/>', 'NO_TESTS', 'FAILED'],
    ['<testsuite tests="1"><testcase name="x"><failure/></testcase></testsuite>', 'UNKNOWN', 'FAILED'],
    ['<testsuite tests="1" failures="1"><testcase name="x"><failure/></testcase></testsuite>', 'FAILED', 'FAILED'],
    ['<testsuite tests="1"/>', 'UNKNOWN', 'FAILED'],
    ['<!DOCTYPE testsuite [<!ENTITY x "test">]><testsuite tests="0"/>', 'UNKNOWN', 'FAILED'],
  ] as const) {
  test(`UNIT TEST-019 XML ${outcome}: ${xml}`, async t=>{
    const f=await fixture(t),run=await f.start(testsProfile());
    const result=await f.finish(run,xml);
    assert.equal(result.testOutcome,outcome,xml);assert.equal(result.status,status,xml);
    assert.equal(result.exitCode,0);
  });
}

test('UNIT JUnit XML parser rejects forged counters, nested aggregation double counting and malformed XML', () => {
  assert.equal(parseJUnit('<testsuite tests="1"><testcase/></testsuite>')?.count, 1);
  assert.equal(parseJUnit('<testsuite tests="99"><testcase/></testsuite>'), null);
  assert.equal(parseJUnit('<testsuite tests="1"><testcase>'), null);
  assert.deepEqual(parseJUnit('<testsuites tests="1"><testsuite tests="1"><testcase/></testsuite></testsuites>'), { count: 1, failures: 0, skipped: 0 });
});

test('UNIT Runner rejects symlink/junction cwd and never reads linked reports outside the task root', async t => {
  const f=await fixture(t),outside=await fs.mkdtemp(path.join(f.root,'outside-'));
  await fs.writeFile(path.join(outside,'external.xml'),passedXML);
  await fs.symlink(outside,path.join(f.workspace,'linked'),process.platform==='win32'?'junction':'dir');
  const p=profile({task:{workingDirectory:'linked',entry:{kind:'SCRIPT',path:'main.cjs'},tests:{paths:[],names:[]}}});
  // Real immutable snapshot inventory rejects the link before any task start (new ownership layer).
  await assert.rejects(f.start(p),/symlink/);
  assert.equal(f.unit.calls.filter(a=>a[0]==='create').length,0);
  await fs.unlink(path.join(f.workspace,'linked'));
  const run=await f.start(testsProfile());
  await fs.symlink(outside,path.join(f.context(run.runId).input.artifactsDirectory,'linked'),process.platform==='win32'?'junction':'dir');
  f.unit.finish();
  const result=await f.finished(run);
  assert.equal(result.testOutcome,'UNKNOWN');assert.equal(result.status,'PROCESS_STOP_UNCONFIRMED');
  assert.equal(await fs.readFile(path.join(outside,'external.xml'),'utf8'),passedXML);
  // Retain strict executor error; restore only own test corruption so genuine Stop can collect/remove.
  await fs.unlink(path.join(f.context(run.runId).input.artifactsDirectory,'linked'));await f.runner.stop(run.runId);
});

// AC-019 regression: aggregate counters are assertions about the subtree, not extra cases.
for (const level of ['root', 'nested'] as const) {
  for (const [attribute, wrong] of [['tests', '2'], ['failures', '1'], ['errors', '1'], ['skipped', '1']] as const) {
    test(`UNIT JUnit aggregate ${level} rejects contradictory ${attribute}`, async t => {
      const f = await fixture(t);
      const counters = { tests: '1', failures: '0', errors: '0', skipped: '0', [attribute]: wrong };
      const attrs = Object.entries(counters).map(([key, value]) => `${key}="${value}"`).join(' ');
      const leaf = '<testsuite tests="1" failures="0" errors="0" skipped="0"><testcase name="leaf"/></testsuite>';
      const xml = level === 'root' ? `<testsuites ${attrs}>${leaf}</testsuites>` :
        `<testsuites tests="1" failures="0" errors="0" skipped="0"><testsuite ${attrs}>${leaf}</testsuite></testsuites>`;
      assert.equal(parseJUnit(xml), null, 'contradictory aggregate must be unrecognized');
      const run = await f.start(testsProfile());
      const result = await f.finish(run,xml);
      assert.notEqual(result.testOutcome, 'PASSED', 'fresh contradictory report must never pass');
      assert.equal(result.testOutcome, 'UNKNOWN');
      assert.equal(result.testCount, null);
    });
  }
}

test('UNIT JUnit aggregate valid nested control counts leaves once and preserves distinct failure/error/skipped totals', async t => {
  const leaf = '<testsuite tests="1" failures="0" errors="0" skipped="0"><testcase name="pass"/></testsuite>';
  const passed = `<testsuites tests="2" failures="0" errors="0" skipped="0"><testsuite tests="2" failures="0" errors="0" skipped="0">${leaf}${leaf}</testsuite></testsuites>`;
  assert.deepEqual(parseJUnit(passed), { count: 2, failures: 0, skipped: 0 });
  const f = await fixture(t);
  const run = await f.start(testsProfile());
  const result = await f.finish(run,passed);
  assert.equal(result.testOutcome, 'PASSED'); assert.equal(result.testCount, 2);
  const outcomes = '<testsuite tests="3" failures="1" errors="1" skipped="1"><testcase><failure/></testcase><testcase><error/></testcase><testcase><skipped/></testcase></testsuite>';
  const mixed = `<testsuites tests="4" failures="1" errors="1" skipped="1"><testsuite tests="4" failures="1" errors="1" skipped="1">${leaf}${outcomes}</testsuite></testsuites>`;
  assert.deepEqual(parseJUnit(mixed), { count: 4, failures: 2, skipped: 1 });
  // Equal failure+error sum cannot hide a wrong individual declared counter.
  assert.equal(parseJUnit(mixed.replace('failures="1" errors="1"', 'failures="2" errors="0"')), null);
  assert.deepEqual(parseJUnit(`<testsuites><testsuite>${leaf}</testsuite></testsuites>`), { count: 1, failures: 0, skipped: 0 });
});

// Kept discoverable and executable; NOT_RUN in the current scoped UNIT invocation, never skip/todo.
for (const action of ['STOP','TIMEOUT'] as const) {
  test(`LIVE TEST-020 ${action}: real parent + child + grandchild tree ends; unrelated sentinel survives`, async t => {
    await liveTree(t,action);
  });
}
test('LIVE Runner strips provider/session credential environment rather than leaking keys to a task', async t => {
  const old=process.env.PAIRCOACH_TEST_API_KEY;process.env.PAIRCOACH_TEST_API_KEY='fixture-not-real-key';
  try {
    const f=await liveFixture(t,'console.log(process.env.PAIRCOACH_TEST_API_KEY === undefined ? "CREDENTIAL_NOT_INHERITED" : "LEAK")');
    const run=await f.start(),result=await f.finished(run);
    assert.match(result.outputTail,/CREDENTIAL_NOT_INHERITED/);
    assert.doesNotMatch(result.outputTail,/fixture-not-real-key|LEAK/);
  } finally {if(old===undefined)delete process.env.PAIRCOACH_TEST_API_KEY;else process.env.PAIRCOACH_TEST_API_KEY=old;}
});

test('LIVE Run streams real stdout/stderr with bounded tail, sequence, literal text, version change', async t=>{
  const f=await liveFixture(t,'setTimeout(()=>{process.stdout.write("x".repeat(70000));process.stderr.write(";echo NOT_A_SHELL");},100)');
  const run=await f.start();await assert.rejects(f.runner.start(f.admission()),/aktywne/);f.change();
  const result=await f.finished(run);
  assert.equal(result.status,'SUCCEEDED');assert.equal(result.exitCode,0);assert.equal(result.testOutcome,'NOT_APPLICABLE');
  assert.equal(result.outputTail.length,65536);assert.equal(result.outputTruncated,true);assert.equal(result.workspaceChangedDuringRun,true);
  const output=f.events.filter(e=>e.type==='RUN_OUTPUT').map(e=>e.payload);assert.ok(output.every(outputPayload));
  const typed=output.filter(outputPayload);assert.ok(typed.some(e=>e.stream==='STDERR'&&e.chunk.includes(';echo NOT_A_SHELL')));
  typed.forEach((e,i)=>{assert.equal(e.outputSeq,i+1);assert.ok(e.chunk.length<=16384);});
  result.outputTail='mutation';assert.notEqual(f.runner.get(run.runId).outputTail,'mutation');
});

// Required AC-105 adversarial controls in addition to every legacy oracle.
for(const [name,xml,exitCode,outcome,count] of [
  ['all skipped','<testsuite tests="1" skipped="1"><testcase><skipped/></testcase></testsuite>',0,'FAILED',1],
  ['nonzero despite green XML',passedXML,2,'FAILED',1],
] as const) {
  test(`UNIT AC-105 ${name} never PASSED`,async t=>{
    const f=await fixture(t),run=await f.start(testsProfile()),result=await f.finish(run,xml,exitCode);
    assert.notEqual(result.testOutcome,'PASSED');assert.equal(result.testOutcome,outcome);
    assert.equal(result.testCount,count);assert.equal(result.status,'FAILED');assert.equal(result.exitCode,exitCode);
  });
}
