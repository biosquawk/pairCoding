import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, utimesSync, symlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Runner, parseJUnit } from '../../src/server/Runner';
import type { Run, RunProfile } from '../../src/shared/protocol';

async function until(predicate: () => boolean, limit = 10000): Promise<void> {
  const deadline = Date.now() + limit;
  while (!predicate()) { if (Date.now() > deadline) throw new Error('Condition timeout'); await new Promise(r => setTimeout(r, 15)); }
}
function fixture(t: any) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'paircoach runner '));
  let version = 1;
  const events: { type: string; payload: any }[] = [];
  const runner = new Runner({ rootPath: root, getWorkspaceVersion: () => version,
    emit: (type, payload) => events.push({ type, payload }) });
  t.after(async () => { await runner.stopAll(); rmSync(root, { recursive: true, force: true }); });
  return { root, runner, events, change: () => { version++; } };
}
function profile(code: string, overrides: Partial<RunProfile> = {}): RunProfile {
  return { kind: 'RUN_MAIN', executable: process.execPath, args: ['-e', code], cwd: '.',
    timeoutMs: 5000, testReportFormat: 'NONE', testReportGlob: null, ...overrides };
}
async function finished(runner: Runner, run: Run) {
  await until(() => !['RUNNING', 'QUEUED'].includes(runner.get(run.runId).status));
  return runner.get(run.runId);
}
function start(runner: Runner, p: RunProfile) { runner.setApprovedProfiles([p]); return runner.start(p); }

const passedXML = '<testsuite tests="1" failures="0" errors="0" skipped="0"><testcase name="real-case"/></testsuite>';

test('TEST-019 approved profiles deny by default; modified args and escaped cwd cannot run', async t => {
  const { runner } = fixture(t);
  const p = profile('console.log("ok")');
  assert.throws(() => runner.start(p), /zatwierdzony/);
  runner.setApprovedProfiles([p]);
  assert.throws(() => runner.start({ ...p, args: ['-e', 'throw Error()'] }), /zatwierdzony/);
  const escape = { ...p, cwd: '..' };
  runner.setApprovedProfiles([escape]);
  assert.throws(() => runner.start(escape), /należeć/);
  const invalid = { ...p, timeoutMs: 999 };
  assert.throws(() => runner.setApprovedProfiles([invalid]), /profil/);
});

test('Run streams real stdout/stderr with bounded tail, sequence, no shell interpolation, version change', async t => {
  const { runner, change, events } = fixture(t);
  const p = profile('setTimeout(()=>{ process.stdout.write("x".repeat(70000)); process.stderr.write(process.argv[1]); },100)',
    { args: ['-e', 'setTimeout(()=>{ process.stdout.write("x".repeat(70000)); process.stderr.write(process.argv[1]); },100)', ';echo NOT_A_SHELL'] });
  const run = start(runner, p);
  assert.throws(() => runner.start(p), /aktywne/);
  change();
  const result = await finished(runner, run);
  assert.equal(result.status, 'SUCCEEDED');
  assert.equal(result.exitCode, 0);
  assert.equal(result.testOutcome, 'NOT_APPLICABLE');
  assert.equal(result.outputTail.length, 65536);
  assert.equal(result.outputTruncated, true);
  assert.equal(result.workspaceChangedDuringRun, true);
  const output = events.filter(e => e.type === 'RUN_OUTPUT').map(e => e.payload);
  assert.ok(output.some(e => e.stream === 'STDERR' && e.chunk.includes(';echo NOT_A_SHELL')));
  output.forEach((e, i) => { assert.equal(e.outputSeq, i + 1); assert.ok(e.chunk.length <= 16384); });
  result.outputTail = 'mutation';
  assert.notEqual(runner.get(run.runId).outputTail, 'mutation');
});

test('TEST-019 exit zero without a report is UNKNOWN; missing executable is FAILED, not a pass', async t => {
  const { runner } = fixture(t);
  const run = start(runner, profile('', { kind: 'RUN_TESTS' }));
  assert.equal((await finished(runner, run)).testOutcome, 'UNKNOWN');
  const missing = start(runner, profile('', { executable: path.join(os.tmpdir(), 'nonexistent-paircoach-executable') }));
  const result = await finished(runner, missing);
  assert.equal(result.status, 'FAILED');
  assert.match(result.outputTail, /EXECUTABLE_NOT_FOUND/);
});

test('TEST-019 fresh runId JUnit is PASSED; old unchanged report cannot produce PASSED', async t => {
  const { root, runner } = fixture(t);
  const p = profile(`require('node:fs').writeFileSync('report-'+process.env.PAIRCOACH_RUN_ID+'.xml', ${JSON.stringify(passedXML)})`,
    { kind: 'RUN_TESTS', testReportFormat: 'JUNIT_XML', testReportGlob: 'report-{runId}.xml' });
  const run = start(runner, p);
  const result = await finished(runner, run);
  assert.equal(result.testOutcome, 'PASSED'); assert.equal(result.testCount, 1);
  assert.ok(existsSync(path.join(root, `report-${run.runId}.xml`)));
  const stale = path.join(root, 'old.xml');
  writeFileSync(stale, passedXML); utimesSync(stale, new Date(10000), new Date(10000));
  const second = start(runner, profile('', { kind: 'RUN_TESTS', testReportFormat: 'JUNIT_XML', testReportGlob: 'old.xml' }));
  assert.equal((await finished(runner, second)).testOutcome, 'UNKNOWN');
  assert.equal(readFileSync(stale, 'utf8'), passedXML);
});

test('TEST-019 zero cases NO_TESTS, malformed/DTD UNKNOWN, assertion failures FAILED even if exit=0', async t => {
  const { runner } = fixture(t);
  for (const [xml, outcome, status] of [
    ['<testsuite tests="0"/>', 'NO_TESTS', 'SUCCEEDED'],
    ['<testsuite tests="1"><testcase name="x"><failure/></testcase></testsuite>', 'UNKNOWN', 'SUCCEEDED'],
    ['<testsuite tests="1" failures="1"><testcase name="x"><failure/></testcase></testsuite>', 'FAILED', 'FAILED'],
    ['<testsuite tests="1"/>', 'UNKNOWN', 'SUCCEEDED'],
    ['<!DOCTYPE testsuite [<!ENTITY x "test">]><testsuite tests="0"/>', 'UNKNOWN', 'SUCCEEDED'],
  ] as const) {
    const run = start(runner, profile(`require('node:fs').writeFileSync(process.env.PAIRCOACH_RUN_ID+'.xml',${JSON.stringify(xml)})`,
      { kind: 'RUN_TESTS', testReportFormat: 'JUNIT_XML', testReportGlob: '{runId}.xml' }));
    const result = await finished(runner, run);
    assert.equal(result.testOutcome, outcome, xml); assert.equal(result.status, status, xml);
  }
});

test('JUnit XML parser rejects forged counters, nested aggregation double counting and malformed XML', () => {
  assert.equal(parseJUnit('<testsuite tests="1"><testcase/></testsuite>')?.count, 1);
  assert.equal(parseJUnit('<testsuite tests="99"><testcase/></testsuite>'), null);
  assert.equal(parseJUnit('<testsuite tests="1"><testcase>'), null);
  assert.deepEqual(parseJUnit('<testsuites tests="1"><testsuite tests="1"><testcase/></testsuite></testsuites>'), { count: 1, failures: 0, skipped: 0 });
});

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    if (process.platform === 'linux') {
      const state = readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1]?.[0];
      return state !== 'Z'; // an already-killed orphan can await init reaping
    }
    return true;
  } catch { return false; }
}

for (const action of ['STOP', 'TIMEOUT'] as const) {
  test(`TEST-020 ${action}: real parent + child + grandchild tree ends; unrelated sentinel survives`, async t => {
    const { root, runner } = fixture(t);
    const { spawn } = await import('node:child_process');
    const sentinel = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
    t.after(() => sentinel.kill('SIGKILL'));
    const childCode = `const g=require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});require('node:fs').writeFileSync('grandchild.pid',String(g.pid));setInterval(()=>{},1000)`;
    const code = `const c=require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(childCode)}],{stdio:'ignore'});require('node:fs').writeFileSync('child.pid',String(c.pid));setInterval(()=>{},1000)`;
    const run = start(runner, profile(code, { timeoutMs: action === 'TIMEOUT' ? 1000 : 5000 }));
    await until(() => existsSync(path.join(root, 'child.pid')));
    await until(() => existsSync(path.join(root, 'grandchild.pid')));
    const childPid = Number(readFileSync(path.join(root, 'child.pid'), 'utf8'));
    const grandchildPid = Number(readFileSync(path.join(root, 'grandchild.pid'), 'utf8'));
    assert.ok(alive(childPid)); assert.ok(alive(grandchildPid));
    if (action === 'STOP') await runner.stop(run.runId);
    const result = await finished(runner, run);
    assert.equal(result.status, action === 'STOP' ? 'CANCELLED' : 'TIMED_OUT');
    await until(() => !alive(childPid) && !alive(grandchildPid));
    assert.ok(alive(sentinel.pid!));
    assert.equal((await runner.stop(run.runId)).status, result.status);
  });
}

test('Runner strips provider/session credential environment rather than leaking keys to a task', async t => {
  const { runner } = fixture(t);
  const old = process.env.PAIRCOACH_TEST_API_KEY;
  process.env.PAIRCOACH_TEST_API_KEY = 'fixture-not-real-key';
  try {
    const run = start(runner, profile('console.log(process.env.PAIRCOACH_TEST_API_KEY === undefined ? "CREDENTIAL_NOT_INHERITED" : "LEAK")'));
    const result = await finished(runner, run);
    assert.match(result.outputTail, /CREDENTIAL_NOT_INHERITED/);
    assert.doesNotMatch(result.outputTail, /fixture-not-real-key|LEAK/);
  } finally {
    if (old === undefined) delete process.env.PAIRCOACH_TEST_API_KEY;
    else process.env.PAIRCOACH_TEST_API_KEY = old;
  }
});


test('Runner rejects symlink/junction cwd and never reads linked reports outside the task root', async t => {
  const { root, runner } = fixture(t);
  const outside = mkdtempSync(path.join(os.tmpdir(), 'paircoach-outside-'));
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  writeFileSync(path.join(outside, 'external.xml'), passedXML);
  symlinkSync(outside, path.join(root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  const p = profile('', { cwd: 'linked' });
  runner.setApprovedProfiles([p]);
  assert.throws(() => runner.start(p), /junctions/);
  const run = start(runner, profile('', { kind: 'RUN_TESTS', testReportFormat: 'JUNIT_XML', testReportGlob: 'linked/*.xml' }));
  assert.equal((await finished(runner, run)).testOutcome, 'UNKNOWN');
  assert.equal(readFileSync(path.join(outside, 'external.xml'), 'utf8'), passedXML);
});
