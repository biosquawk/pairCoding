/** UNIT composition: actual DockerExecutor -> RuntimeRunner, adapter, FS and durable journal.
 * Docker command transport (and poll sleep where controlled) injected; NOT real Docker/GUI. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { fixture } from '../runtime-executor/fixtures';
import { DockerExecutor, EXECUTOR_LIMITS } from '../../src/server/execution/DockerExecutor';
import { RuntimeRunner } from '../../src/server/runtime-coordinator/RuntimeRunner';
import { createTaskRuntimeAdapterRegistry, dependencyHash } from '../../src/server/runtime-adapters';
import type { ExecutionHandle, ExecutionOutput } from '../../src/server/execution/ports';
import type { RunProfileV2, RunV2 } from '../../src/shared/runtime-v2';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}
async function composition() {
  const f = await fixture();
  Object.assign(f.plan.caches[0], { dependencyHash: dependencyHash(f.input.files) });
  const sleeping = deferred<void>(), resume = deferred<void>(), firstOutput = deferred<void>(), terminal = deferred<RunV2>();
  const executor = new DockerExecutor({policy: f.policy, journal: f.journal, transport: f.fake,
    sleep: async () => { sleeping.resolve(); await resume.promise; }});
  const events: {type: string; payload: any}[] = [];
  const runner = new RuntimeRunner({execution: executor, newRunId: () => 'run1', getWorkspaceVersion: () => 3,
    persistTerminal: (h, o) => executor.persistTerminal(h, o), emit: (type, payload) => {
      events.push({type, payload});
      if (type === 'RUN_OUTPUT') firstOutput.resolve();
      if (type === 'RUN_STATE' && (payload as RunV2).finishedAt) terminal.resolve(payload as RunV2);
    }});
  const runProfile: RunProfileV2 = {kind: 'RUN_TESTS', task: {workingDirectory: '.', entry: {kind: 'TESTS'},
    tests: {paths: ['main.js'], names: []}}, timeoutMs: 10000};
  const adapter = createTaskRuntimeAdapterRegistry().get(f.plan.profile);
  const start = () => runner.start({projectId: 'project', request: {requestId: 'request', clientId: 'client', sessionId: 'session',
    expectedWorkspaceVersion: 3, mode: 'RUN_TESTS', configurationGeneration: 'config1'}, profile: f.plan.profile, runProfile, adapter,
    assertCurrent: () => {}, capture: async () => ({ownership: f.plan.ownership, input: f.input, profile: f.plan.profile,
      lockedImage: f.plan.lockedImage, caches: f.plan.caches})});
  const output = (stream: 'STDOUT'|'STDERR') => events.filter(e => e.type === 'RUN_OUTPUT' && e.payload.stream === stream).map(e => e.payload.chunk).join('');
  const settled = async () => {
    const result = await terminal.promise;
    assert.equal((await f.journal.read('run1')).phase, 'REMOVED');
    assert.equal(f.fake.v, null);
    return result;
  };
  return {f, executor, runner, events, start, settled, output, sleeping, resume, firstOutput};
}

for (const code of [0, 1]) test(`UNIT already exited in start: stdout/stderr visible before terminal exit${code}`, {timeout: 5000}, async t => {
  const c = await composition(); t.after(() => c.f.cleanup());
  c.f.fake.logs = {stdout: 'actual short stdout\n', stderr: "EACCES: permission denied, open '/input/pom.xml'\n"};
  c.f.fake.onStart = async () => c.f.fake.finish(code);
  await c.start();
  const terminal = await c.settled();
  // These assertions are intentionally unchanged across baseline/fix.
  assert.equal(c.output('STDOUT'), c.f.fake.logs.stdout);
  assert.equal(c.output('STDERR'), c.f.fake.logs.stderr);
  assert.equal(terminal.outputTail, c.f.fake.logs.stdout + c.f.fake.logs.stderr);
  assert.equal(terminal.exitCode, code);
  assert.equal(terminal.status, 'FAILED', 'no JUnit must not become a test success even at exit0');
  const lastOutput = c.events.map(e => e.type).lastIndexOf('RUN_OUTPUT');
  const finalState = c.events.findIndex(e => e.type === 'RUN_STATE' && e.payload.finishedAt);
  assert.ok(lastOutput >= 0 && lastOutput < finalState);
  assert.equal(c.f.fake.calls.filter(a => a[0] === 'logs').length, 1, 'reuse actual mandatory collection request');
  assert.equal(await fs.readFile((await c.f.journal.read('run1')).collection!.stderrPath, 'utf8'), c.f.fake.logs.stderr);
});

test('UNIT final collection appends only unseen suffix after last poll, repeated collection has no replay', {timeout: 5000}, async t => {
  const c = await composition(); t.after(() => c.f.cleanup());
  c.f.fake.logs = {stdout: 'prefix\n', stderr: 'warning\n'};
  await c.start(); await c.sleeping.promise;
  assert.equal(c.output('STDOUT'), 'prefix\n');
  c.f.fake.logs.stdout += 'final stdout\n'; c.f.fake.logs.stderr += 'final stderr\n';
  c.f.fake.finish(1);
  // Stop can race a sleeping wait; the real Runner still collects exactly once.
  await c.runner.stop('run1');
  const terminal = await c.settled();
  assert.equal(c.output('STDOUT'), c.f.fake.logs.stdout);
  assert.equal(c.output('STDERR'), c.f.fake.logs.stderr);
  assert.equal(terminal.status, 'CANCELLED'); assert.equal(terminal.exitCode, 1);
  const r = await c.f.journal.read('run1'), count = c.events.length;
  await c.executor.collect(r.handle, r.exit!);
  c.resume.resolve();
  assert.equal(c.events.length, count, 'retained collection must never replay or emit after disposal');
});

test('UNIT actual Stop produces late final stderr and emits exactly once before terminal release', {timeout: 5000}, async t => {
  const c = await composition(); t.after(() => c.f.cleanup());
  c.f.fake.logs = {stdout: 'running\n', stderr: ''};
  await c.start(); await c.sleeping.promise;
  c.f.fake.onStop = async () => { c.f.fake.logs.stderr = 'actual shutdown stderr\n'; };
  await c.runner.stop('run1');
  const terminal = await c.settled();
  assert.equal(c.output('STDOUT'), 'running\n'); assert.equal(c.output('STDERR'), 'actual shutdown stderr\n');
  assert.equal(terminal.outputTail, 'running\nactual shutdown stderr\n');
  assert.equal(terminal.status, 'CANCELLED'); assert.equal(terminal.exitCode, 137);
  assert.equal(c.f.fake.calls.filter(a => a[0] === 'stop').length, 1);
  c.resume.resolve();
});

test('UNIT final output preserves UTF8, <=16KiB chunks and <=64KiB truthful tail', {timeout: 5000}, async t => {
  const c = await composition(); t.after(() => c.f.cleanup());
  const text = 'x' + '😀'.repeat(20000) + 'END';
  c.f.fake.logs = {stdout: text, stderr: ''}; c.f.fake.onStart = async () => c.f.fake.finish(1);
  await c.start(); const terminal = await c.settled();
  assert.equal(c.output('STDOUT'), text);
  assert.ok(terminal.outputTruncated); assert.ok(Buffer.byteLength(terminal.outputTail) <= 65536);
  assert.ok(text.endsWith(terminal.outputTail)); assert.doesNotMatch(terminal.outputTail, /\ufffd/);
  c.events.filter(e => e.type === 'RUN_OUTPUT').forEach((e, i) => {
    assert.equal(e.payload.outputSeq, i + 1); assert.ok(Buffer.byteLength(e.payload.chunk) <= 16384);
    assert.doesNotMatch(e.payload.chunk, /\ufffd/);
  });
});

for (const fault of ['prefix', 'stderr-prefix', 'transport', 'bound'] as const) test(`UNIT ${fault} log failure is truthful, no forged delta/success`, {timeout: 5000}, async t => {
  const c = await composition(); t.after(() => c.f.cleanup());
  c.f.fake.logs = {stdout: 'prefix\n', stderr: ''};
  if (fault === 'stderr-prefix') c.f.fake.logs.stderr = 'known-stderr';
  await c.start(); await c.sleeping.promise;
  if (fault === 'stderr-prefix') c.f.fake.logs = {stdout: 'prefix\nforbidden suffix', stderr: 'rewritten'};
  if (fault === 'prefix') c.f.fake.logs = {stdout: 'rewritten\n', stderr: 'must not leak after invalid prefix'};
  if (fault === 'transport') c.f.fake.logsFail = true;
  if (fault === 'bound') c.f.fake.logs.stdout = 'x'.repeat(EXECUTOR_LIMITS.logBytes + 1);
  c.f.fake.finish(1);
  if (fault === 'prefix' || fault === 'stderr-prefix') {
    await c.runner.stop('run1'); const terminal = await c.settled();
    assert.equal(terminal.status, 'CANCELLED');
    assert.equal(c.output('STDOUT'), 'prefix\n');
    assert.match(c.output('STDERR'), /Docker output unavailable.*prefix changed/);
    assert.equal(await fs.readFile((await c.f.journal.read('run1')).collection!.stdoutPath, 'utf8'), fault === 'prefix' ? 'rewritten\n' : 'prefix\nforbidden suffix');
  } else {
    await assert.rejects(c.runner.stop('run1'));
    const run = c.runner.get('run1');
    assert.equal(run.status, 'PROCESS_STOP_UNCONFIRMED'); assert.equal(run.finishedAt, null);
    assert.equal(c.output('STDOUT'), 'prefix\n');
    assert.notEqual((await c.f.journal.read('run1')).phase, 'REMOVED');
  }
  c.resume.resolve();
});

test('UNIT handle isolation, observer failure and disposal do not replay/cross-deliver', async t => {
  const f = await fixture(); t.after(() => f.cleanup()); f.fake.onStart = async () => f.fake.finish(1);
  const h = await f.executor.start(f.plan), outputs: ExecutionOutput[] = [], foreign: ExecutionOutput[] = [];
  const wrong: ExecutionHandle = {...h, opaqueId: 'foreign'};
  const offWrong = f.executor.subscribe(wrong, o => foreign.push(o));
  const offBad = f.executor.subscribe(h, () => { throw Error('UI failed'); });
  const off = f.executor.subscribe(h, o => outputs.push(o));
  await assert.rejects(f.executor.wait(wrong), /Unknown execution handle/);
  const exit = await f.executor.wait(h), collection = await f.executor.collect(h, exit);
  await f.executor.collect(h, exit);
  assert.equal(outputs.map(o => o.text).join(''), f.fake.logs.stdout); assert.deepEqual(foreign, []);
  off(); offBad(); offWrong();
  await f.executor.cleanup(await f.executor.persistTerminal(h, {status: 'FAILED', testOutcome: 'UNKNOWN', testCount: null, skipped: null, failures: null, errors: null, problem: null}));
  assert.equal((await f.journal.read(h.runId)).phase, 'REMOVED');
  assert.deepEqual(await f.executor.collect(h, exit), collection);
  assert.equal(outputs.map(o => o.text).join(''), f.fake.logs.stdout);
});

test('UNIT failed poll then successful final collection preserves diagnostic and actual bytes', {timeout: 5000}, async t => {
  const c = await composition(); t.after(() => c.f.cleanup());
  c.f.fake.logsFail = true;
  c.f.fake.logs = {stdout: 'actual after transient failure\n', stderr: 'actual stderr\n'};
  await c.start(); await c.sleeping.promise;
  assert.match(c.output('STDERR'), /Docker output unavailable/);
  c.f.fake.logsFail = false;
  c.f.fake.finish(1); await c.runner.stop('run1');
  const terminal = await c.settled();
  assert.equal(c.output('STDOUT'), c.f.fake.logs.stdout);
  assert.ok(c.output('STDERR').endsWith(c.f.fake.logs.stderr));
  assert.equal(c.output('STDERR').match(/Docker output unavailable/g)?.length, 1);
  assert.ok(terminal.outputTail.endsWith(c.f.fake.logs.stdout + c.f.fake.logs.stderr));
  c.resume.resolve();
});

test('UNIT delayed poll cannot block Stop, replay final output or revive disposed state', {timeout: 5000}, async t => {
  const c = await composition(); t.after(() => c.f.cleanup());
  c.f.fake.logs = {stdout: 'prefix\n', stderr: ''};
  const requested = deferred<void>(), release = deferred<void>();
  const run = c.f.fake.run.bind(c.f.fake);
  let hold = true;
  c.f.fake.run = async args => {
    const reply = await run(args);
    if (args[0] === 'logs' && hold) { hold = false; requested.resolve(); await release.promise; }
    return reply;
  };
  await c.start(); await requested.promise;
  c.f.fake.onStop = async () => { c.f.fake.logs.stdout += 'final\n'; };
  const stopping = c.runner.stop('run1');
  await stopping;
  const terminal = await c.settled();
  assert.equal(c.output('STDOUT'), 'prefix\nfinal\n');
  assert.equal(c.output('STDERR'), ''); assert.equal(terminal.outputTail, 'prefix\nfinal\n');
  assert.deepEqual(c.events.filter(e => e.type === 'RUN_OUTPUT').map(e => e.payload.chunk), ['prefix\nfinal\n']);
  const count = c.events.length;
  release.resolve(); c.resume.resolve();
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(c.events.length, count, 'late poll after cleanup cannot recreate cursor/listener or emit diagnostics');
});
