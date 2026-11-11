/** Actual V2 construction seams. No HTTP/bootstrap/Run/language/Docker/native Windows claim. */
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { createRuntimeWorkspace, type RuntimeWorkspace } from '../../src/server/runtime-coordinator/RuntimeWorkspace';
import { JournalLease } from '../../src/server/runtime-coordinator/JournalLease';
const settings = { schemaVersion: 2 as const, taskFilePath: 'task.md', taskMode: 'CODE_REVIEW' as const, reviewNotesPath: 'notes.md',
  runProfiles: [], aiConsent: false, contextPatterns: ['**/*.ts'] };
const sha = (v: string | Buffer) => createHash('sha256').update(v).digest('hex');
function fixture(t: TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-startup-')), cores: RuntimeWorkspace[] = [];
  fs.writeFileSync(path.join(root, 'a.ts'), '\ufeffSNAP A\r\n'); fs.writeFileSync(path.join(root, 'b.ts'), 'SNAP B\n');
  const open = async () => { const core = await createRuntimeWorkspace({ rootPath: root }); cores.push(core); return core; };
  t.after(() => { for (const core of cores) core.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, open, file: (p: string) => path.join(root, p) };
}
function auth(core: RuntimeWorkspace) {
  core.session.claimLease('startup-tab');
  return { clientId: 'startup-tab', sessionId: core.session.state.sessionId, actor: 'STUDENT' as const, controlEpoch: core.session.state.controlEpoch };
}
async function save(core: RuntimeWorkspace) {
  const a = auth(core);
  return core.settingsStore.save({ request: { requestId: 'first-save', clientId: a.clientId, sessionId: a.sessionId,
    expectedWorkspaceVersion: core.workspace.workspaceVersion, settings }, humanConfirmed: true, expectedSourceSha256: core.readSettings().sourceSha256 });
}
async function crash(root: string, action: string, boundary: string, snapshotId = '') {
  const child = spawn(process.execPath, ['--import', 'tsx', fileURLToPath(new URL('./workspace-startup-child.ts', import.meta.url)), root, action, boundary, snapshotId],
    { env: { ...process.env, TSX_DISABLE_CACHE: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', b => stdout += b); child.stderr.on('data', b => stderr += b);
  const result = await new Promise<{ code: number | null; signal: string | null }>((resolve, reject) => {
    const timeout = setTimeout(() => { child.kill('SIGKILL'); reject(Error('Crash seam timed out: ' + stderr)); }, 15000);
    child.once('error', e => { clearTimeout(timeout); reject(e); });
    child.once('exit', (code, signal) => { clearTimeout(timeout); resolve({ code, signal }); });
  });
  assert.equal(result.signal, 'SIGKILL', stderr + stdout);
  return stdout;
}
test('SEAM canonical factory keeps missing/malformed settings nonexecutable and editing available without rewriting', async t => {
  const f = fixture(t), a = await f.open();
  assert.equal(a.settingsStore.settingsPath, f.file('.paircoach/settings.json'));
  assert.equal(a.settingsRecovery, 'NONE'); assert.equal(a.readSettings().kind, 'MIGRATION_REQUIRED');
  assert.equal(fs.existsSync(a.settingsStore.settingsPath), false);
  a.gate.write({ ...auth(a), path: 'a.ts', baseVersion: 1, content: 'student\n' });
  assert.equal(a.workspace.workspaceVersion, 1); a.close();
  fs.writeFileSync(f.file('.paircoach/settings.json'), '{malformed original');
  const b = await f.open();
  assert.equal(b.readSettings().kind, 'MIGRATION_REQUIRED'); assert.equal(b.workspace.settings.runProfiles.length, 0);
  assert.equal(b.workspace.getDocument('a.ts').content, 'student\n');
  assert.equal(fs.readFileSync(b.settingsStore.settingsPath, 'utf8'), '{malformed original');
});
test('SEAM canonical real settings authority retains exact versions/settings across fresh factory and refuses concurrent owner', async t => {
  const f = fixture(t), a = await f.open();
  const receipt = await save(a); assert.equal(receipt.workspaceVersion, 1);
  await assert.rejects(f.open(), /own|busy|lease/i);
  a.close(); const b = await f.open();
  assert.equal(b.workspace.workspaceVersion, 1); assert.deepEqual(b.readSettings().settings, settings);
  assert.equal(b.workspace.settings.taskMode, 'CODE_REVIEW'); assert.equal(b.workspace.settings.reviewNotesPath, 'notes.md');
  assert.deepEqual(b.workspace.settings.runProfiles, []);
  assert.equal(b.workspace.getDocument('a.ts').version, 1);
});
test('SEAM failed canonical settings construction releases actual owner; linked settings never followed', async t => {
  const f = fixture(t), a = await f.open(); a.close();
  const outside = f.file('not-settings.txt'); fs.writeFileSync(outside, 'DO NOT CHANGE');
  fs.symlinkSync(outside, f.file('.paircoach/settings.json'));
  await assert.rejects(f.open());
  assert.equal(fs.readFileSync(outside, 'utf8'), 'DO NOT CHANGE');
  fs.unlinkSync(f.file('.paircoach/settings.json'));
  const b = await f.open(); assert.equal(b.workspace.workspaceVersion, 1); // new ordinary outside file is observed once
  b.close();
  fs.mkdirSync(f.file('.paircoach/settings.json.v2-state'), { mode: 0o700 });
  fs.writeFileSync(f.file('.paircoach/settings.json.v2-state/pending.json'), 'corrupt');
  await assert.rejects(f.open());
  const lease = new JournalLease(f.file('.paircoach/workspace-v2/lease.lock')); lease.close();
  assert.equal(fs.readFileSync(f.file('.paircoach/settings.json.v2-state/pending.json'), 'utf8'), 'corrupt');
});
for (const boundary of ['REPLACED', 'COMMITTED']) test('SEAM real factory recovers canonical settings death at ' + boundary + ' BEFORE returning its core', async t => {
  const f = fixture(t), initial = await f.open(); await save(initial);
  const original = fs.readFileSync(initial.settingsStore.settingsPath); initial.close();
  const raw = await crash(f.root, 'settings', boundary), input = JSON.parse(raw.trim());
  const recovered = await f.open(), expected = boundary === 'COMMITTED' ? 'COMMITTED' : 'ABORTED';
  assert.equal(recovered.settingsRecovery, expected);
  assert.equal(recovered.readSettings().settings?.aiConsent, boundary === 'COMMITTED');
  assert.equal(recovered.workspace.workspaceVersion, boundary === 'COMMITTED' ? 2 : 1);
  if (boundary === 'REPLACED') assert.deepEqual(fs.readFileSync(recovered.settingsStore.settingsPath), original);
  const identity = { requestId: input.request.requestId, clientId: input.request.clientId, sessionId: input.request.sessionId,
    expectedWorkspaceVersion: input.request.expectedWorkspaceVersion, payloadSha256: sha(JSON.stringify({ settings: input.request.settings, source: input.expectedSourceSha256 })) };
  assert.equal((await recovered.settingsAuthority.reconcile(identity, o => o)).state, expected);
  recovered.close(); const again = await f.open(); assert.equal(again.settingsRecovery, 'NONE');
  assert.equal(again.workspace.workspaceVersion, boundary === 'COMMITTED' ? 2 : 1);
});
for (const boundary of ['PUBLISHED', 'COMMITTED']) test('SEAM real snapshot death ' + boundary + ' is recovered under durable ownership BEFORE source version reconciliation', async t => {
  const f = fixture(t), a = await f.open(), snapshot = a.workspace.createSnapshot('source');
  for (const p of ['a.ts', 'b.ts']) a.gate.write({ ...auth(a), path: p, baseVersion: 1, content: 'WORK ' + p + '\n' });
  const priorVersion = a.workspace.getDocument('a.ts').version, priorWorkspace = a.workspace.workspaceVersion;
  a.close(); await crash(f.root, 'snapshot', boundary, snapshot.snapshotId);
  const b = await f.open();
  assert.equal(b.workspace.getDocument('a.ts').content, boundary === 'COMMITTED' ? 'SNAP A\n' : 'WORK a.ts\n');
  assert.equal(b.workspace.getDocument('b.ts').content, boundary === 'COMMITTED' ? 'SNAP B\n' : 'WORK b.ts\n');
  assert.ok(b.workspace.getDocument('a.ts').version > priorVersion); assert.ok(b.workspace.workspaceVersion > priorWorkspace);
  const version = b.workspace.getDocument('a.ts').version, workspaceVersion = b.workspace.workspaceVersion;
  b.close(); const c = await f.open();
  assert.equal(c.workspace.getDocument('a.ts').version, version); assert.equal(c.workspace.workspaceVersion, workspaceVersion);
});
test('SEAM unsafe snapshot recovery fails before scanning/incrementing versions and releases root ownership', async t => {
  const f = fixture(t), a = await f.open(), snapshot = a.workspace.createSnapshot('source');
  for (const p of ['a.ts', 'b.ts']) a.gate.write({ ...auth(a), path: p, baseVersion: 1, content: 'WORK\n' });
  a.close(); await crash(f.root, 'snapshot', 'PUBLISHED', snapshot.snapshotId);
  fs.unlinkSync(f.file('a.ts')); fs.writeFileSync(f.file('a.ts'), 'FOREIGN CURRENT');
  const versions = fs.readFileSync(f.file('.paircoach/workspace-v2/versions.json'));
  await assert.rejects(f.open(), { code: 'RECOVERY_REQUIRED' });
  assert.equal(fs.readFileSync(f.file('a.ts'), 'utf8'), 'FOREIGN CURRENT');
  assert.deepEqual(fs.readFileSync(f.file('.paircoach/workspace-v2/versions.json')), versions);
  const lease = new JournalLease(f.file('.paircoach/workspace-v2/lease.lock')); lease.close();
});
test('SEAM canonical dataDir refuses an alternate factory ledger before ANY initialization, even while canonical owner is live', async t => {
  const f = fixture(t), outside = path.join(f.root, 'alternate-session-store');
  const before = fs.readdirSync(f.root).sort();
  await assert.rejects(createRuntimeWorkspace({ rootPath: f.root, dataDir: outside }), { code: 'INVALID_V2_DATA_DIR' });
  assert.deepEqual(fs.readdirSync(f.root).sort(), before); assert.equal(fs.existsSync(outside), false);
  const a = await f.open(); const versions = fs.readFileSync(f.file('.paircoach/workspace-v2/versions.json'));
  await assert.rejects(createRuntimeWorkspace({ rootPath: f.root, dataDir: outside }), { code: 'INVALID_V2_DATA_DIR' });
  assert.equal(fs.existsSync(outside), false); assert.deepEqual(fs.readFileSync(f.file('.paircoach/workspace-v2/versions.json')), versions);
  a.close();
});
test('SEAM canonical dataDir explicit SAME directory shares durable history, never a second kernel bypass', async t => {
  const f = fixture(t), a = await f.open(); await save(a);
  await assert.rejects(createRuntimeWorkspace({ rootPath: f.root, dataDir: f.file('.paircoach') }), /own|busy|lease/i);
  a.close();
  const b = await createRuntimeWorkspace({ rootPath: f.root, dataDir: f.file('.paircoach') });
  try { assert.equal(b.workspace.workspaceVersion, 1); assert.deepEqual(b.readSettings().settings, settings); }
  finally { b.close(); }
});
test('SEAM prior canonical history missing versions or prior settings material never grants replacement version zero', async t => {
  const f = fixture(t), a = await f.open(); await save(a); a.close();
  fs.unlinkSync(f.file('.paircoach/workspace-v2/versions.json'));
  const statePath = f.file('.paircoach/settings.json.v2-state'), stateFiles = fs.readdirSync(statePath).sort();
  await assert.rejects(f.open(), { code: 'WORKSPACE_RECOVERY_REQUIRED' });
  assert.equal(fs.existsSync(f.file('.paircoach/workspace-v2/versions.json')), false);
  assert.deepEqual(fs.readdirSync(statePath).sort(), stateFiles);
  const fresh = fs.mkdtempSync(path.join(os.tmpdir(), 'prior-settings-'));
  try {
    fs.mkdirSync(path.join(fresh, '.paircoach'), { mode: 0o700 }); fs.mkdirSync(path.join(fresh, '.paircoach/settings.json.v2-state'), { mode: 0o700 });
    fs.writeFileSync(path.join(fresh, '.paircoach/settings.json.v2-state/retained-original'), 'prior durable evidence');
    await assert.rejects(createRuntimeWorkspace({ rootPath: fresh }), { code: 'WORKSPACE_RECOVERY_REQUIRED' });
    assert.equal(fs.existsSync(path.join(fresh, '.paircoach/workspace-v2')), false);
    assert.equal(fs.readFileSync(path.join(fresh, '.paircoach/settings.json.v2-state/retained-original'), 'utf8'), 'prior durable evidence');
  } finally { fs.rmSync(fresh, { recursive: true, force: true }); }
});
