import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { SettingsV2Store, type SettingsTransactionAuthority, type SettingsTransactionIdentity, type SettingsTransactionOutcome, type SettingsSaveReceipt, type SettingsWriteLease, type SettingsMutation, type SaveSettingsInput, type SettingsCheckpoint } from '../../src/server/settings-v2';
import type { SettingsV2 } from '../../src/shared/runtime-v2';
const hash = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');
const settings = (): SettingsV2 => ({ schemaVersion: 2, taskFilePath: 'custom-task.md', taskMode: 'CODE_REVIEW', reviewNotesPath: 'notes.md', aiConsent: true, contextPatterns: ['src/**/*.js','docs/**'],
  runProfiles: [{ kind: 'RUN_MAIN', timeoutMs: 1234, task: { workingDirectory: 'module', entry: { kind: 'SCRIPT', path: 'different.js' }, tests: { paths: [], names: [] } } }] });
/** Deterministic transaction test authority, NOT actual integrated WriteGate proof. */
class Authority implements SettingsTransactionAuthority {
  version = 0; authorized = true; cancelled = false; calls = 0; effects = 0;
  outcomes = new Map<string, SettingsTransactionOutcome>(); unknown = false; loseReply = false; lock = false;
  lease = (): SettingsWriteLease => ({ assertCurrent: () => { if (!this.authorized) throw Error('DENIED'); if (this.cancelled) throw Error('CANCELLED'); } });
  key(i: SettingsTransactionIdentity) { return i.sessionId + '/' + i.clientId + '/' + i.requestId; }
  async transact(i: SettingsTransactionIdentity, effect: (l: SettingsWriteLease) => SettingsMutation): Promise<SettingsSaveReceipt> {
    this.calls++;
    if (this.lock) throw Error('BUSY'); this.lock = true;
    try {
      this.lease().assertCurrent();
      const previous = this.outcomes.get(this.key(i));
      if (previous?.state === 'COMMITTED') {
        if (previous.receipt.payloadSha256 !== i.payloadSha256) throw Error('IDEMPOTENCY_CONFLICT');
        return { ...previous.receipt, status: 'DUPLICATE' };
      }
      if (this.version !== i.expectedWorkspaceVersion) throw Error('VERSION_CONFLICT');
      try {
        this.effects++; const mutation = effect(this.lease());
        const receipt: SettingsSaveReceipt = { ...i, ...mutation, workspaceVersion: ++this.version, status: 'OK' };
        this.outcomes.set(this.key(i), { state: 'COMMITTED', receipt });
        if (this.loseReply) throw Error('REPLY_LOST');
        return receipt;
      } catch (error) {
        if (!this.outcomes.has(this.key(i))) this.outcomes.set(this.key(i), { state: 'ABORTED' });
        throw error;
      }
    } finally { this.lock = false; }
  }
  async reconcile<T>(i: SettingsTransactionIdentity, effect: (o: SettingsTransactionOutcome, l: SettingsWriteLease) => T): Promise<T> {
    if (this.lock) throw Error('BUSY'); this.lock = true;
    try { return effect(this.unknown ? { state: 'UNKNOWN' } : this.outcomes.get(this.key(i)) ?? { state: 'ABORTED' }, this.lease()); }
    finally { this.lock = false; }
  }
}
function fixture(t: TestContext, bytes?: string | Buffer) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'settings-v2-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const settingsPath = path.join(root, 'settings.json'); if (bytes !== undefined) fs.writeFileSync(settingsPath, bytes);
  const authority = new Authority();
  const store = (checkpoint?: (p: SettingsCheckpoint) => void) => new SettingsV2Store({ settingsPath, authority, checkpoint });
  const input = (id = 'request-1'): SaveSettingsInput => ({ humanConfirmed: true, expectedSourceSha256: hash(fs.existsSync(settingsPath) ? fs.readFileSync(settingsPath) : ''), request: {
    requestId: id, clientId: 'client-1', sessionId: 'session-1', expectedWorkspaceVersion: authority.version, settings: settings() } });
  return { root, settingsPath, authority, store, input };
}
const original = '{\r\n "taskFilePath":"custom-task.md", "taskMode":"CODE_REVIEW", "aiConsent":true, "reviewNotesPath":"notes.md", "contextPatterns":["src/**/*.js","docs/**"],\r\n "runProfiles":[{"kind":"RUN_MAIN","executable":"DO-NOT-INFER","args":["--x"]}], "draft":{"text":"Zażółć 😀"}, "coachContext":{"mode":"keep"}\r\n}\r\n';

test('read legacy/mixed/unknown/invalid preserves ORIGINAL bytes and marks migration required', t => {
  for (const bytes of [original, '{"schemaVersion":3,"newField":true}', '{"schemaVersion":2,"runProfiles":[{"executable":"node"}]}', '{', '\ufeff{}', '[]']) {
    const f = fixture(t, bytes), result = f.store().read();
    assert.equal(result.kind, 'MIGRATION_REQUIRED'); assert.equal(result.problem?.code, 'LEGACY_RUN_PROFILE_REQUIRES_MIGRATION'); assert.equal(result.sourceSha256, hash(bytes));
    assert.deepEqual(fs.readFileSync(f.settingsPath), Buffer.from(bytes)); assert.deepEqual(fs.readdirSync(f.root), ['settings.json']);
  }
});
test('explicit migration saves real V2, source-hash backup and unrelated consent/context/task/draft', async t => {
  const f = fixture(t, original), store = f.store(), input = f.input(), receipt = await store.save(input);
  assert.equal(receipt.status, 'OK'); assert.equal(receipt.workspaceVersion, 1);
  assert.equal(f.authority.effects, 1); assert.equal(store.read().kind, 'V2');
  const after = JSON.parse(fs.readFileSync(f.settingsPath, 'utf8')), before = JSON.parse(original);
  for (const key of ['taskFilePath','taskMode','reviewNotesPath','aiConsent','contextPatterns','draft','coachContext']) assert.deepEqual(after[key], before[key]);
  assert.deepEqual(after.runProfiles, input.request.settings.runProfiles); assert.ok(!JSON.stringify(after).includes('DO-NOT-INFER'));
  assert.deepEqual(fs.readFileSync(path.join(store.stateDirectory, 'backup-' + hash(original) + '.json')), Buffer.from(original));
  assert.equal(fs.statSync(f.settingsPath).mode & 0o777, 0o600);
  assert.equal(fs.readdirSync(store.stateDirectory).filter(p => p.startsWith('backup-')).length, 1);
  assert.ok(!fs.existsSync(path.join(store.stateDirectory, 'pending.json')));
});
test('backup is once per exact original source hash, never overwritten', async t => {
  const f = fixture(t, original), store = f.store(); await store.save(f.input());
  const backup = path.join(store.stateDirectory, 'backup-' + hash(original) + '.json'), inode = fs.statSync(backup).ino;
  fs.writeFileSync(f.settingsPath, original); await store.save(f.input('request-2'));
  assert.equal(fs.statSync(backup).ino, inode); assert.deepEqual(fs.readFileSync(backup), Buffer.from(original));
  assert.equal(fs.readdirSync(store.stateDirectory).filter(p => p.startsWith('backup-')).length, 1);
});
test('duplicate actual authority receipt does not reapply after a newer settings save', async t => {
  const f = fixture(t, original), store = f.store(), first = f.input(); await store.save(first);
  const second = f.input('request-2'); second.request.settings.aiConsent = false; await store.save(second);
  const bytes = fs.readFileSync(f.settingsPath), duplicate = await store.save(first);
  assert.equal(duplicate.status, 'DUPLICATE'); assert.equal(duplicate.workspaceVersion, 1); assert.equal(f.authority.version, 2); assert.equal(f.authority.effects, 2); assert.deepEqual(fs.readFileSync(f.settingsPath), bytes);
  first.request.settings.aiConsent = false; await assert.rejects(store.save(first), /IDEMPOTENCY_CONFLICT/);
});
test('auth/version conflict/cancel and missing human confirmation leave source and UI input untouched', async t => {
  for (const failure of ['auth','version','cancel','confirmation'] as const) {
    const f = fixture(t, original), input = f.input(), beforeInput = structuredClone(input);
    if (failure === 'auth') f.authority.authorized = false;
    if (failure === 'version') f.authority.version = 4;
    if (failure === 'cancel') f.authority.cancelled = true;
    if (failure === 'confirmation') (input as any).humanConfirmed = false;
    const submitted = structuredClone(input);
    await assert.rejects(f.store().save(input)); assert.deepEqual(fs.readFileSync(f.settingsPath), Buffer.from(original)); assert.deepEqual(input, submitted);
    assert.deepEqual(fs.readdirSync(f.root), ['settings.json']); assert.equal(f.authority.effects, 0);
    assert.equal(beforeInput.request.settings.runProfiles[0].task.entry.kind, 'SCRIPT');
  }
});
test('source hash conflict and malformed/future versions cannot be silently merged/downgraded', async t => {
  const f = fixture(t, original), input = f.input(); fs.writeFileSync(f.settingsPath, original + ' ');
  await assert.rejects(f.store().save(input), { code: 'SETTINGS_SOURCE_CONFLICT' }); assert.equal(fs.readFileSync(f.settingsPath, 'utf8'), original + ' ');
  for (const bytes of ['{','[]','{"schemaVersion":99,"future":{"keep":true}}']) {
    const g = fixture(t, bytes); await assert.rejects(g.store().save(g.input())); assert.equal(fs.readFileSync(g.settingsPath, 'utf8'), bytes); assert.deepEqual(fs.readdirSync(g.root), ['settings.json']);
  }
});
test('migration cannot reset unrelated consent/context/task fields to UI defaults', async t => {
  for (const key of ['aiConsent','contextPatterns','taskFilePath','taskMode','reviewNotesPath'] as const) {
    const f = fixture(t, original), input = f.input();
    (input.request.settings as any)[key] = { aiConsent: false, contextPatterns: [], taskFilePath: null, taskMode: 'IMPLEMENTATION', reviewNotesPath: 'review.md' }[key];
    await assert.rejects(f.store().save(input), { code: 'UNRELATED_SETTINGS_CONFLICT' });
    assert.deepEqual(fs.readFileSync(f.settingsPath), Buffer.from(original)); assert.equal(f.authority.version, 0);
  }
});
test('authority is mandatory and save/recovery cannot overlap on the same store', async t => {
  const f = fixture(t, original);
  assert.throws(() => new SettingsV2Store({ settingsPath: f.settingsPath, authority: undefined as any }), { code: 'AUTHORITY_REQUIRED' });
  let release!: () => void;
  const previous = f.authority.transact.bind(f.authority);
  f.authority.transact = async (identity, effect) => { await new Promise<void>(resolve => { release = resolve; }); return previous(identity, effect); };
  const store = f.store(), pending = store.save(f.input());
  await assert.rejects(store.save(f.input('request-2')), { code: 'SETTINGS_BUSY' });
  await assert.rejects(store.recover(), { code: 'SETTINGS_BUSY' });
  release(); await pending; assert.equal(f.authority.version, 1);
});
test('captured input is stable if caller mutates its modal object while authority is awaiting', async t => {
  const f = fixture(t, original), input = f.input(); let release!: () => void;
  const previous = f.authority.transact.bind(f.authority);
  f.authority.transact = async (identity, effect) => { await new Promise<void>(resolve => { release = resolve; }); return previous(identity, effect); };
  const pending = f.store().save(input); input.expectedSourceSha256 = 'f'.repeat(64); input.request.settings.aiConsent = false;
  release(); await pending; assert.equal(f.store().read().settings?.aiConsent, true);
});
test('missing file can be explicitly created, reads return defensive copies', async t => {
  const f = fixture(t), store = f.store(); assert.equal(store.read().exists, false); await store.save(f.input());
  const a = store.read(); assert.equal(a.kind, 'V2'); a.settings!.contextPatterns.push('mutated'); assert.deepEqual(store.read().settings?.contextPatterns, settings().contextPatterns);
  assert.ok(!fs.readdirSync(store.stateDirectory).some(p => p.startsWith('backup-')));
});
for (const phase of ['BACKUP_DURABLE','NEXT_DURABLE','JOURNAL_DURABLE','BEFORE_REPLACE','REPLACED','DIRECTORY_SYNCED'] as const) {
  test('injected IO failure at ' + phase + ' restores/preserves exact original and no version advancement', async t => {
    const f = fixture(t, original), input = f.input(); let fired = false;
    const store = f.store(p => { if (p === phase && !fired) { fired = true; throw Error('INJECTED_IO_FAILURE'); } });
    await assert.rejects(store.save(input), /INJECTED_IO_FAILURE/); assert.equal(fired, true);
    assert.deepEqual(fs.readFileSync(f.settingsPath), Buffer.from(original)); assert.equal(f.authority.version, 0); assert.equal(store.read().kind, 'MIGRATION_REQUIRED');
  });
}
test('cancel at last authority check preserves original and modal data, pending intent is retained until authorized recovery', async t => {
  const f = fixture(t, original), input = f.input(), submitted = structuredClone(input);
  const store = f.store(p => { if (p === 'BEFORE_REPLACE') f.authority.cancelled = true; });
  await assert.rejects(store.save(input), { code: 'RECOVERY_REQUIRED' }); assert.deepEqual(fs.readFileSync(f.settingsPath), Buffer.from(original)); assert.deepEqual(input, submitted);
  f.authority.cancelled = false; assert.equal(await store.recover(), 'ABORTED'); assert.equal(f.authority.version, 0);
});
test('external writer during staging/after replacement is NEVER overwritten by rollback or recovery', async t => {
  for (const phase of ['BEFORE_REPLACE','REPLACED'] as const) {
    const f = fixture(t, original), store = f.store(p => { if (p === phase) fs.writeFileSync(f.settingsPath, '{"external":"keep"}'); });
    await assert.rejects(store.save(f.input()), { code: 'RECOVERY_REQUIRED' }); assert.equal(fs.readFileSync(f.settingsPath, 'utf8'), '{"external":"keep"}');
    await assert.rejects(store.recover(), { code: 'SETTINGS_SOURCE_CONFLICT' }); assert.equal(fs.readFileSync(f.settingsPath, 'utf8'), '{"external":"keep"}');
  }
});
test('lost authority reply reconciles committed receipt by read, never replays mutation', async t => {
  const f = fixture(t, original), store = f.store(), input = f.input(); f.authority.loseReply = true;
  await assert.rejects(store.save(input), /REPLY_LOST/); assert.equal(store.read().kind, 'V2'); assert.equal(f.authority.version, 1); assert.equal(f.authority.effects, 1);
  f.authority.loseReply = false; assert.equal((await store.save(input)).status, 'DUPLICATE'); assert.equal(f.authority.effects, 1);
});
test('uncertain outcome retains handle, blocks a new save; restart committed recovery does not transact', async t => {
  const f = fixture(t, original), store = f.store(), input = f.input(); f.authority.loseReply = true; f.authority.unknown = true;
  await assert.rejects(store.save(input), { code: 'RECOVERY_REQUIRED' }); assert.throws(() => store.read(), { code: 'RECOVERY_REQUIRED' });
  await assert.rejects(store.save(f.input('request-2')), { code: 'RECOVERY_REQUIRED' }); assert.equal(f.authority.calls, 1);
  const reopened = f.store(); f.authority.unknown = false; assert.equal(await reopened.recover(), 'COMMITTED'); assert.equal(reopened.read().kind, 'V2'); assert.equal(f.authority.calls, 1); assert.equal(f.authority.version, 1);
});
test('committed recovery restores retained next bytes without replaying authority transaction', async t => {
  const f = fixture(t, original), store = f.store(); f.authority.loseReply = true; f.authority.unknown = true;
  await assert.rejects(store.save(f.input()), { code: 'RECOVERY_REQUIRED' });
  fs.writeFileSync(f.settingsPath, original); f.authority.unknown = false;
  assert.equal(await f.store().recover(), 'COMMITTED'); assert.equal(f.store().read().kind, 'V2'); assert.equal(f.authority.calls, 1);
});
test('corrupted backup cannot be overwritten or used for mutation', async t => {
  const f = fixture(t, original), store = f.store(); fs.mkdirSync(store.stateDirectory, { mode: 0o700 });
  fs.writeFileSync(path.join(store.stateDirectory, 'backup-' + hash(original) + '.json'), 'corrupted');
  await assert.rejects(store.save(f.input()), { code: 'BACKUP_CONFLICT' }); assert.equal(fs.readFileSync(f.settingsPath, 'utf8'), original);
});
test('source/state symlinks, hardlinked source and unsafe ancestors are rejected', async t => {
  const f = fixture(t, original), target = path.join(f.root, 'target.json'); fs.renameSync(f.settingsPath, target); fs.symlinkSync(target, f.settingsPath);
  assert.throws(() => f.store().read()); await assert.rejects(f.store().save(f.input())); assert.equal(fs.readFileSync(target, 'utf8'), original);
  fs.unlinkSync(f.settingsPath); fs.linkSync(target, f.settingsPath); assert.throws(() => f.store().read()); fs.unlinkSync(f.settingsPath);
  fs.writeFileSync(f.settingsPath, original); fs.symlinkSync(path.join(f.root, 'other-state'), f.store().stateDirectory); assert.throws(() => f.store().read());
  const linked = path.join(f.root, 'linked'); fs.symlinkSync(f.root, linked); assert.throws(() => new SettingsV2Store({ settingsPath: path.join(linked, 'settings.json'), authority: f.authority }), { code: 'UNSAFE_SETTINGS_PATH' });
});
test('malicious or delayed authority cannot invoke effect twice or after returning duplicate', async t => {
  const f = fixture(t, original), real = f.authority.transact.bind(f.authority); let later: (() => unknown) | undefined;
  f.authority.transact = async (identity, effect) => {
    const receipt = await real(identity, lease => { const result = effect(lease); later = () => effect(lease); return result; }); return receipt;
  };
  await f.store().save(f.input()); const bytes = fs.readFileSync(f.settingsPath);
  assert.throws(() => later!(), { code: 'AUTHORITY_PROTOCOL' }); assert.deepEqual(fs.readFileSync(f.settingsPath), bytes);
});

// Actual process termination exercises durable journal recovery, not just in-process exception paths.
for (const phase of ['JOURNAL_DURABLE','REPLACED'] as const) {
  test('real child crash at ' + phase + ' is recoverable from disk with actual outcome readback', async t => {
    const f = fixture(t, original), store = f.store();
    const child = spawnSync(process.execPath, ['--import','tsx', path.resolve('tests/settings-v2/crash-fixture.ts'), f.settingsPath, phase, JSON.stringify(f.input())], { encoding: 'utf8', env: { ...process.env }, timeout: 10000 });
    assert.equal(child.status, 73, child.stderr); assert.throws(() => store.read(), { code: 'RECOVERY_REQUIRED' });
    assert.equal(await store.recover(), 'ABORTED'); assert.deepEqual(fs.readFileSync(f.settingsPath), Buffer.from(original)); assert.equal(f.authority.calls, 0);
  });
}
