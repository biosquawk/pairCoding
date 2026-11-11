/** Filesystem/actual Store/actual WriteGate/SIGKILL original-result seams, not public HTTP or Docker. */
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { sha256 } from '../../src/server/runtime-coordinator/storage';
import { open, clientId } from './save-stage-fixture';
const committed = <T>(result: T) => ({ state: 'COMMITTED' as const, result });
const aborted = { state: 'DEFINITIVELY_ABORTED' as const, result: null };
function fixture(t: TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'original-save-'));
  fs.writeFileSync(path.join(root, 'source.py'), 'ORIGINAL\n');
  const opened: Awaited<ReturnType<typeof open>>[] = [];
  t.after(async () => { for (const f of opened) await f.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, async open() { const f = await open(root); opened.push(f); return f; } };
}
test('SAVE stage genuine Store receipt returns exact original Project; later edit/save/restart cannot replace result', async t => {
  const fixtureRoot = fixture(t), f = await fixtureRoot.open(), input = f.input(), original = f.project(input);
  let calls = 0;
  assert.deepEqual(await f.mutations.execute(input, lease => { lease.assertCurrent(); calls++; return original; }), committed(original));
  assert.equal(calls, 1); assert.equal(f.core.workspace.workspaceVersion, original.workspaceVersion);
  assert.deepEqual(f.core.readSettings().settings, input.request.settings);
  // Mutating the caller's projection after successful publication cannot affect retained result.
  const retained = structuredClone(original); original.capabilities.execution.runtime.label = 'MUTATED CALLER';
  const doc = f.core.workspace.getDocument('source.py');
  f.core.gate.write({ actor: 'STUDENT', clientId, sessionId: f.core.session.state.sessionId, controlEpoch: f.core.session.state.controlEpoch,
    path: doc.path, baseVersion: doc.version, content: 'NEWER\n' });
  const next = f.input('next-save'); next.request.settings.aiConsent = true;
  assert.equal((await f.mutations.execute(next, (_lease, files) => f.project(next, files))).state, 'COMMITTED');
  assert.deepEqual(await f.mutations.execute(input, () => assert.fail('No original replay')), committed(retained));
  await assert.rejects(f.mutations.execute({ ...input, request: { ...input.request, settings: { ...input.request.settings, aiConsent: true } } }, () => assert.fail('No collision effect')), { code: 'IDEMPOTENCY_CONFLICT' });
  await f.close(); const reopened = await fixtureRoot.open();
  assert.ok(reopened.core.workspace.workspaceVersion > retained.workspaceVersion);
  assert.deepEqual(await reopened.mutations.recover(input.request), committed(retained));
});
test('SAVE reservation-to-authority Veto race cancels before stage; original abort readback fences delayed replay', async t => {
  const fixtureRoot = fixture(t), f = await fixtureRoot.open(), input = f.input();
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>(r => enter = r), held = new Promise<void>(r => release = r);
  const blocked = f.core.workspace._withQueuedMutation(async () => { enter(); await held; }); await entered;
  let projections = 0;
  const pending = f.mutations.execute(input, () => { projections++; return f.project(input); });
  f.core.session.veto(); release(); await blocked;
  assert.deepEqual(await pending, { state: 'UNKNOWN', result: null }); assert.equal(projections, 0);
  assert.equal(f.core.readSettings().exists, false); assert.equal(f.core.workspace.workspaceVersion, 0);
  assert.deepEqual(await f.mutations.recover(input.request), aborted);
  assert.deepEqual(await f.mutations.execute(input, () => assert.fail('No late effect')), aborted);
});
test('SAVE false original Project/settings/files never stages or modifies real Store', async t => {
  const fixtureRoot = fixture(t), f = await fixtureRoot.open();
  for (const kind of ['version','settings','files','session','root'] as const) {
    const input = f.input('invalid-' + kind), original = f.project(input);
    if (kind === 'version') original.workspaceVersion++;
    if (kind === 'settings') original.settings.aiConsent = !original.settings.aiConsent;
    if (kind === 'files') original.files = [];
    if (kind === 'session') original.sessionId = 'foreign-session';
    if (kind === 'root') original.rootPath = path.dirname(original.rootPath);
    assert.deepEqual(await f.mutations.execute(input, () => original), { state: 'UNKNOWN', result: null });
    assert.equal(f.core.readSettings().exists, false); assert.equal(f.core.workspace.workspaceVersion, 0);
    assert.deepEqual(await f.mutations.recover(input.request), aborted);
  }
});
for (const boundary of ['STAGED','REPLACED','COMMITTED'] as const) test('SAVE actual SIGKILL ' + boundary + ' recovers original result via durable Store identity, no current-snapshot inference', async t => {
  const fixtureRoot = fixture(t);
  const child = spawn(process.execPath, ['--import','tsx',fileURLToPath(new URL('./save-stage-crash-child.ts', import.meta.url)), fixtureRoot.root, boundary],
    { env: { ...process.env, TSX_DISABLE_CACHE: '1' }, stdio: ['ignore','pipe','pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', b => stdout += b); child.stderr.on('data', b => stderr += b);
  const killTimer = setTimeout(() => child.kill('SIGKILL'), 10000);
  let timedOut = false; const observeTimer = setTimeout(() => timedOut = true, 9900);
  const exit = await new Promise<{code:number|null;signal:string|null}>((resolve,reject) => { child.once('error',reject); child.once('exit',(code,signal) => resolve({code,signal})); });
  clearTimeout(killTimer); clearTimeout(observeTimer);
  assert.equal(timedOut, false, 'Crash harness exceeded deadline'); assert.equal(exit.signal, 'SIGKILL', stderr);
  const { input, originalProject } = JSON.parse(stdout.trim()), f = await fixtureRoot.open();
  assert.equal(f.core.workspace.workspaceVersion, boundary === 'COMMITTED' ? 1 : 0);
  const identity = { projectId: f.core.workspace.projectId, sessionId: input.request.sessionId, clientId, requestId: input.request.requestId, kind: 'SAVE' as const, payload: input.request };
  assert.deepEqual(await f.journal.reconcile(identity), { state: 'UNKNOWN', result: null });
  const staged = f.journal.readSettingsStage(identity); assert.ok(staged); assert.deepEqual(staged.result, originalProject);
  // Durable Store identity has payload hash of ORIGINAL insertion order. The journal canonicalizes
  // request JSON on disk, so rehashing its reordered request must not substitute for this identity.
  assert.match(staged.identity.payloadSha256, /^[a-f0-9]{64}$/);
  const journalFile = fs.readdirSync(f.journal.directory).find(name => /^[a-f0-9]{64}\.json$/.test(name))!;
  const disk = JSON.parse(fs.readFileSync(path.join(f.journal.directory, journalFile), 'utf8'));
  assert.notEqual(sha256(JSON.stringify({ settings: disk.body.identity.payload.settings, source: input.expectedSourceSha256 })), staged.identity.payloadSha256,
    'Reordered journal payload is not the authentic original Store transaction identity');
  if (boundary === 'COMMITTED') {
    const doc = f.core.workspace.getDocument('source.py');
    f.core.gate.write({ actor: 'STUDENT', clientId, sessionId: f.core.session.state.sessionId, controlEpoch: f.core.session.state.controlEpoch,
      path: doc.path, baseVersion: doc.version, content: 'AFTER CRASH\n' });
    assert.ok(f.core.workspace.workspaceVersion > originalProject.workspaceVersion);
  }
  const result = boundary === 'COMMITTED' ? committed(originalProject) : aborted;
  assert.deepEqual(await f.mutations.recover(input.request), result);
  assert.deepEqual(await f.mutations.execute(input, () => assert.fail('No crash replay')), result);
  await f.close(); const reopened = await fixtureRoot.open();
  assert.deepEqual(await reopened.mutations.recover(input.request), result);
});
test('SAVE live admitted effect cannot be proved aborted or stage replaced while FIFO waiting', async t => {
  const fixtureRoot = fixture(t), f = await fixtureRoot.open(), input = f.input();
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>(r => enter = r), held = new Promise<void>(r => release = r);
  const blocked = f.core.workspace._withQueuedMutation(async () => { enter(); await held; }); await entered;
  const pending = f.mutations.execute(input, (_lease, files) => f.project(input, files));
  await new Promise(r => setImmediate(r));
  assert.deepEqual(await f.mutations.recover(input.request), { state: 'UNKNOWN', result: null });
  const other = f.input('other-save'); await assert.rejects(f.mutations.execute(other, () => assert.fail('Fenced')), { code: 'MUTATION_PENDING' });
  release(); await blocked; assert.equal((await pending).state, 'COMMITTED');
});
test('SAVE direct preexisting Store receipt cannot be misreported as unstaged public abort', async t => {
  const fixtureRoot = fixture(t), f = await fixtureRoot.open(), input = f.input();
  const actualReceipt = await f.core.settingsStore.save(input);
  assert.equal(actualReceipt.status, 'OK');
  assert.deepEqual(await f.mutations.execute(input, () => assert.fail('Duplicate must not project a new original result')), { state: 'UNKNOWN', result: null });
  assert.deepEqual(await f.mutations.recover(input.request), { state: 'UNKNOWN', result: null });
  assert.equal(f.core.workspace.workspaceVersion, 1);
  await assert.rejects(f.mutations.execute(f.input('another-request'), () => assert.fail('Unknown fences new effects')), { code: 'MUTATION_PENDING' });
});
test('SAVE source change after durable stage aborts actual Store without overwriting external bytes', async t => {
  const fixtureRoot = fixture(t), f = await fixtureRoot.open(), input = f.input(), project = f.project(input);
  const actual = f.journal.stageSettings.bind(f.journal);
  f.journal.stageSettings = (...args) => { actual(...args); fs.writeFileSync(f.core.settingsStore.settingsPath, '{"external":"retained"}\n'); };
  assert.deepEqual(await f.mutations.execute(input, () => project), { state: 'UNKNOWN', result: null });
  assert.equal(fs.readFileSync(f.core.settingsStore.settingsPath,'utf8'), '{"external":"retained"}\n');
  assert.equal(f.core.workspace.workspaceVersion, 0);
  assert.deepEqual(await f.mutations.recover(input.request), aborted);
});
test('SAVE stage publication failure prevents Store intent/effect and exact recovery proves abort', async t => {
  const fixtureRoot = fixture(t), f = await fixtureRoot.open(), input = f.input(), project = f.project(input);
  f.journal.stageSettings = () => { throw Error('Controlled stage publication refusal before fsync'); };
  assert.deepEqual(await f.mutations.execute(input, () => project), { state: 'UNKNOWN', result: null });
  assert.equal(f.core.readSettings().exists, false); assert.equal(f.core.workspace.workspaceVersion, 0);
  assert.equal(fs.existsSync(f.core.settingsStore.stateDirectory), false);
  assert.deepEqual(await f.mutations.recover(input.request), aborted);
});
test('SAVE public BUSY read barriers remain intact; internal file projection requires actual held lease', async t => {
  const fixtureRoot = fixture(t), f = await fixtureRoot.open(), input = f.input();
  assert.throws(() => f.core.workspace._settingsFileProjection({ assertCurrent() {} }), /held settings mutation/);
  assert.deepEqual(await f.mutations.execute(input, (lease, files) => {
    assert.throws(() => f.core.workspace.listFiles(), { code: 'WORKSPACE_BUSY' });
    assert.deepEqual(f.core.workspace._settingsFileProjection(lease), files);
    return f.project(input, files);
  }), committed(f.project(input)));
});
