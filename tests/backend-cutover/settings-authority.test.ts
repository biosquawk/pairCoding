/** Filesystem/WriteGate/SettingsV2Store seams. No HTTP, Docker, native Windows or AI claim. */
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { WorkspaceService } from '../../src/server/WorkspaceService';
import { SessionController } from '../../src/server/SessionController';
import { WriteGate } from '../../src/server/WriteGate';
import { SettingsV2Store, type SettingsTransactionIdentity, type SettingsCheckpoint } from '../../src/server/settings-v2';
import { GateSettingsAuthority } from '../../src/server/runtime-coordinator/GateSettingsAuthority';
const sha = (v: string | Buffer) => createHash('sha256').update(v).digest('hex');
const clientId = 'd6d23782-812d-46b6-83bb-2f2fa3f9ecf1';
const settings = { schemaVersion: 2 as const, taskFilePath: 'challenge.md', taskMode: 'IMPLEMENTATION' as const, reviewNotesPath: 'review.md', runProfiles: [], aiConsent: false, contextPatterns: ['**/*.py'] };
function fixture(t: TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'settings-gate-'));
  fs.writeFileSync(path.join(root, 'main.py'), '\ufeffone\r\n');
  const opened: WorkspaceService[] = [], sessions: SessionController[] = [];
  const open = (checkpoint?: (phase: SettingsCheckpoint) => void) => {
    const workspace = new WorkspaceService(root, undefined, { durableVersions: true }); opened.push(workspace);
    const session = new SessionController(workspace); sessions.push(session); session.claimLease(clientId);
    const gate = new WriteGate(workspace, session), authority = new GateSettingsAuthority(workspace, gate);
    const settingsPath = path.join(workspace.dataDir, 'project.json');
    const store = new SettingsV2Store({ settingsPath, authority, checkpoint });
    const auth = () => ({ clientId, sessionId: session.state.sessionId, controlEpoch: session.state.controlEpoch, actor: 'STUDENT' as const });
    const input = (requestId = 'save1') => ({ request: { requestId, clientId, sessionId: session.state.sessionId,
      expectedWorkspaceVersion: workspace.workspaceVersion, settings: structuredClone(settings) }, humanConfirmed: true as const, expectedSourceSha256: store.read().sourceSha256 });
    return { workspace, session, gate, authority, store, auth, input, settingsPath, close() { session.close(); workspace.close(); } };
  };
  t.after(() => { for (const session of sessions) session.close(); for (const workspace of opened) workspace.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, open };
}
test('SEAM real store uses gate-owned durable versions, exact receipt, duplicate and collision fence', async t => {
  const f = fixture(t), a = f.open(), input = a.input();
  const old = a.workspace.getDocument('main.py');
  const receipt = await a.store.save(input);
  assert.equal(receipt.status, 'OK'); assert.equal(receipt.workspaceVersion, 1); assert.equal(a.workspace.workspaceVersion, 1);
  assert.equal(a.store.read().kind, 'V2'); assert.equal(a.workspace.getDocument('main.py').version, old.version);
  const bytes = fs.readFileSync(a.settingsPath);
  assert.deepEqual(await a.store.save(input), { ...receipt, status: 'DUPLICATE' });
  assert.deepEqual(fs.readFileSync(a.settingsPath), bytes); assert.equal(a.workspace.workspaceVersion, 1);
  await assert.rejects(a.store.save({ ...input, request: { ...input.request, settings: { ...settings, aiConsent: true } } }), { code: 'IDEMPOTENCY_CONFLICT' });
  a.close(); const b = f.open();
  assert.equal(b.workspace.workspaceVersion, receipt.workspaceVersion);
  assert.equal(b.workspace.getDocument('main.py').version, old.version);
  const identity: SettingsTransactionIdentity = { ...receipt }; delete (identity as any).status; delete (identity as any).workspaceVersion; delete (identity as any).sourceSha256; delete (identity as any).settingsSha256;
  const recovered = await b.authority.reconcile(identity, (outcome, lease) => { lease.assertCurrent(); return outcome; });
  assert.deepEqual(recovered, { state: 'COMMITTED', receipt });
  await assert.rejects(b.authority.transact(identity, () => { throw Error('must not run'); }), { code: 'SESSION_MISMATCH' });
});
test('SEAM gate rejects ephemeral authority; actual owner/session/version and cancellation fence effects', async t => {
  const f = fixture(t), a = f.open();
  const ephemeralRoot = path.join(f.root, 'legacy'); fs.mkdirSync(ephemeralRoot);
  const legacy = new WorkspaceService(ephemeralRoot), legacySession = new SessionController(legacy);
  try { assert.throws(() => new GateSettingsAuthority(legacy, new WriteGate(legacy, legacySession)), { code: 'DURABLE_VERSIONS_REQUIRED' }); }
  finally { legacySession.close(); legacy.close(); }
  const input = a.input(); input.request.clientId = 'no-lease';
  await assert.rejects(a.store.save(input), { code: 'LEASE_REQUIRED' }); assert.equal(fs.existsSync(a.settingsPath), false);
  const stale = a.input(); stale.request.expectedWorkspaceVersion = 50;
  await assert.rejects(a.store.save(stale), { code: 'WORKSPACE_VERSION_CONFLICT' });
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>(r => enter = r), wait = new Promise<void>(r => release = r);
  const hold = a.workspace._withQueuedMutation(async () => { enter(); await wait; }); await entered;
  const pending = a.store.save(a.input()); a.session.veto(); release(); await hold;
  await assert.rejects(pending, { code: 'STALE_EPOCH' }); assert.equal(fs.existsSync(a.settingsPath), false);
});
test('SEAM queued earlier edit invalidates settings expected version; no stale effect or settings version bump', async t => {
  const f = fixture(t), a = f.open(), input = a.input(), doc = a.workspace.getDocument('main.py');
  const edit = a.gate.writeAsync({ ...a.auth(), path: 'main.py', baseVersion: doc.version, content: 'two\n' });
  const save = a.store.save(input); await edit;
  await assert.rejects(save, { code: 'WORKSPACE_VERSION_CONFLICT' });
  assert.equal(a.workspace.workspaceVersion, 1); assert.equal(fs.existsSync(a.settingsPath), false);
});
test('SEAM failed real replacement rolls back original bytes and persists ABORTED without version bump', async t => {
  const f = fixture(t), a = f.open(phase => { if (phase === 'REPLACED') throw Error('controlled after replace'); });
  fs.writeFileSync(a.settingsPath, JSON.stringify(settings)); const original = fs.readFileSync(a.settingsPath), input = a.input();
  await assert.rejects(a.store.save(input), /controlled after replace/);
  assert.deepEqual(fs.readFileSync(a.settingsPath), original); assert.equal(a.workspace.workspaceVersion, 0);
  assert.equal(await a.store.recover(), 'NONE');
  await assert.rejects(a.store.save(input), { code: 'SETTINGS_RECOVERY_REQUIRED' });
  a.close(); const b = f.open(); assert.equal(b.workspace.workspaceVersion, 0); assert.deepEqual(fs.readFileSync(b.settingsPath), original);
});
test('SEAM durable document versions survive restart, offline edits and delete/recreate tombstones', async t => {
  const f = fixture(t), a = f.open(), old = a.workspace.getDocument('main.py');
  const written = a.gate.write({ ...a.auth(), path: 'main.py', baseVersion: old.version, content: 'new\n' });
  a.close(); const b = f.open(); assert.equal(b.workspace.getDocument('main.py').version, written.version); assert.equal(b.workspace.workspaceVersion, 1);
  b.gate.mutate({ ...b.auth(), operation: 'DELETE', path: 'main.py', baseVersion: written.version, content: null, newPath: null });
  b.close(); fs.writeFileSync(path.join(f.root, 'main.py'), 'offline\r\n');
  const c = f.open(); assert.equal(c.workspace.workspaceVersion, 3); assert.equal(c.workspace.getDocument('main.py').version, written.version + 2);
  c.close(); fs.writeFileSync(path.join(f.root, 'main.py'), 'another offline\n');
  const d = f.open(); assert.equal(d.workspace.workspaceVersion, 4); assert.equal(d.workspace.getDocument('main.py').version, written.version + 3);
});
test('SEAM exclusive durable owner and corrupt version state fail closed, never reset versions', async t => {
  const f = fixture(t), a = f.open();
  assert.throws(() => f.open(), /lease|own|busy/i);
  const state = path.join(a.workspace.dataDir, 'workspace-v2', 'versions.json'); a.close();
  const bytes = fs.readFileSync(state); fs.writeFileSync(state, '{}'); assert.throws(() => f.open()); assert.equal(fs.readFileSync(state, 'utf8'), '{}');
  fs.writeFileSync(state, bytes); const b = f.open(); assert.equal(b.workspace.workspaceVersion, 0);
});
for (const boundary of ['BACKUP_DURABLE', 'NEXT_DURABLE', 'REPLACED', 'COMMITTED'] as const) test('SEAM actual process death at ' + boundary + ' recovers original operation, no replay/version fabrication', async t => {
  const f = fixture(t), initial = f.open();
  fs.writeFileSync(initial.settingsPath, JSON.stringify(settings)); const original = fs.readFileSync(initial.settingsPath); initial.close();
  const child = spawn(process.execPath, ['--import', 'tsx', fileURLToPath(new URL('./settings-crash-child.ts', import.meta.url)), f.root, boundary], { env: { ...process.env, TSX_DISABLE_CACHE: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = ''; child.stdout.on('data', b => stdout += b); child.stderr.on('data', b => stderr += b);
  const result = await new Promise<{ code: number | null; signal: string | null }>((resolve, reject) => { child.on('error', reject); child.on('exit', (code, signal) => resolve({ code, signal })); });
  assert.equal(result.signal, 'SIGKILL', stderr); const request = JSON.parse(stdout.trim());
  const recovered = f.open(), expected = boundary === 'COMMITTED' ? 'COMMITTED' : 'ABORTED';
  assert.equal(await recovered.authority.recoverStore(recovered.store), expected); assert.equal(await recovered.store.recover(), 'NONE');
  assert.equal(recovered.workspace.workspaceVersion, boundary === 'COMMITTED' ? 1 : 0);
  assert.equal(recovered.workspace.getDocument('main.py').version, 1);
  if (boundary !== 'COMMITTED') assert.deepEqual(fs.readFileSync(recovered.settingsPath), original);
  else assert.equal(recovered.store.read().settings?.aiConsent, true);
  const identity = { requestId: request.requestId, clientId: request.clientId, sessionId: request.sessionId, expectedWorkspaceVersion: request.expectedWorkspaceVersion,
    payloadSha256: sha(JSON.stringify({ settings: request.settings, source: sha(original) })) };
  const outcome = await recovered.authority.reconcile(identity, o => o); assert.equal(outcome.state, expected);
});


test('SEAM absent original settings gets durable tombstone; delayed effect cannot run', async t => {
  const f = fixture(t), a = f.open();
  const identity = { requestId: 'absent', clientId, sessionId: a.session.state.sessionId, expectedWorkspaceVersion: 0, payloadSha256: 'a'.repeat(64) };
  assert.equal((await a.authority.reconcile(identity, o => o)).state, 'ABORTED');
  let effects = 0;
  await assert.rejects(a.authority.transact(identity, () => { effects++; return { sourceSha256: 'a'.repeat(64), settingsSha256: 'b'.repeat(64) }; }), { code: 'SETTINGS_RECOVERY_REQUIRED' });
  assert.equal(effects, 0); assert.equal(a.workspace.workspaceVersion, 0);
  await assert.rejects(a.authority.reconcile({ ...identity, payloadSha256: 'b'.repeat(64) }, o => o), { code: 'IDEMPOTENCY_CONFLICT' });
});

test('SEAM durable publication corruption fences reads/writes, other gate cannot authorize this workspace', async t => {
  const f = fixture(t), a = f.open(), otherRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'settings-other-'));
  const other = new WorkspaceService(otherRoot), session = new SessionController(other);
  try { assert.throws(() => new GateSettingsAuthority(a.workspace, new WriteGate(other, session)), { code: 'WORKSPACE_SCOPE_MISMATCH' }); }
  finally { session.close(); other.close(); fs.rmSync(otherRoot, { recursive: true, force: true }); }
  assert.throws(() => a.workspace.updateSettings(a.workspace.settings), { code: 'V2_SETTINGS_REQUIRED' });
  fs.writeFileSync(path.join(a.workspace.dataDir, 'workspace-v2', 'versions.json'), '{}');
  assert.throws(() => a.workspace.getDocument('main.py'));
  assert.throws(() => a.gate.write({ ...a.auth(), path: 'main.py', baseVersion: 1, content: 'no' }));
  assert.equal(fs.readFileSync(path.join(f.root, 'main.py'), 'utf8'), '\ufeffone\r\n');
});

test('SEAM missing prior durable version state cannot reset acknowledged versions on restart', async t => {
  const f = fixture(t), a = f.open();
  a.gate.write({ ...a.auth(), path: 'main.py', baseVersion: 1, content: 'acknowledged\n' });
  const state = path.join(a.workspace.dataDir, 'workspace-v2', 'versions.json'); a.close();
  fs.unlinkSync(state);
  assert.throws(() => f.open(), /Missing prior workspace versions/);
  assert.equal(fs.existsSync(state), false);
});
