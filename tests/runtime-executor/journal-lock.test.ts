/** Real FS/process death and native Linux flock. Fake Docker ONLY. No native Windows/Docker claim. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { DurableRunJournal, type JournalRecord } from '../../src/server/execution/DurableRunJournal';
import { DockerExecutor } from '../../src/server/execution/DockerExecutor';
import { fixture } from './fixtures';

type Fixture = Awaited<ReturnType<typeof fixture>>;
function intent(f: Fixture): JournalRecord {
  return { version: 1, createdAt: Date.now(), revision: 0,
    handle: { runId: 'run1', opaqueId: randomUUID() }, ownership: f.plan.ownership, plan: f.plan,
    phase: 'INTENT', containerId: null, exit: null, collection: null, outcome: null };
}
async function holder(t: any, f: Fixture, operation: 'reserve' | 'update', record: JournalRecord, where: 'before' | 'after' = 'before') {
  const request = path.join(f.root, 'child-' + randomUUID() + '.request');
  await fs.writeFile(request, JSON.stringify({ directory: f.journal.directory, installationId: 'install', operation, record, where }));
  const child = spawn(process.execPath, ['--import', 'tsx', fileURLToPath(new URL('./journal-lock-child.ts', import.meta.url)), request],
    { cwd: process.cwd(), env: process.env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  let stderr = '';
  child.stderr!.on('data', b => stderr += b);
  child.stdout!.resume();
  const closed = new Promise<any>(resolve => child.once('close', (code, signal) => resolve({ code, signal })));
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await closed; });
  // No sleep/age/PID liveness heuristic. This handshake occurs inside reserve/list or update/read.
  const ready = once(child, 'message');
  const result = await Promise.race([ready.then(([message]) => message), closed.then(exit => ({ event: 'EXIT', exit, stderr }))]);
  assert.equal(result.event, 'HELD', JSON.stringify(result));
  assert.equal(result.pid, child.pid);
  return { child, closed, kill: async () => { child.kill('SIGKILL'); assert.equal((await closed).signal, 'SIGKILL'); } };
}

for (const operation of ['reserve', 'update'] as const) {
  test(`real child ${operation}: live cross-process exclusion, death releases, revisions stay fenced`, { timeout: 15000 }, async t => {
    const f = await fixture();
    // Register cleanup before the child finalizer: test finalizers are ordered, so explicitly kill before cleanup below.
    let held: Awaited<ReturnType<typeof holder>> | undefined;
    try {
      await f.journal.initialize();
      const record = intent(f);
      if (operation === 'update') await f.journal.reserve(record);
      held = await holder(t, f, operation, record);
      const competitor = new DurableRunJournal(f.journal.directory, 'install');
      // The live child has really entered its critical section. initialize must never unlink its lock.
      await competitor.initialize();
      const before = await fs.readdir(f.journal.directory);
      await assert.rejects(operation === 'reserve' ? competitor.reserve(record) : competitor.update(structuredClone(record)));
      assert.deepEqual(await fs.readdir(f.journal.directory), before);
      if (operation === 'reserve') await assert.rejects(f.journal.read('run1'), { code: 'ENOENT' });
      else assert.equal((await f.journal.read('run1')).revision, 0);
      await held.kill(); held = undefined;
      if (operation === 'reserve') await competitor.reserve(record);
      else { record.phase = 'STOP_UNCONFIRMED'; await competitor.update(record); }
      const after = await competitor.read('run1');
      assert.equal(after.revision, operation === 'reserve' ? 0 : 1);
      await assert.rejects(competitor.reserve(intent(f)), /Unreconciled/);
      const stale = { ...after, revision: after.revision - 1 };
      await assert.rejects(competitor.update(stale), /revision/);
      const foreign = new DurableRunJournal(f.journal.directory, 'foreign');
      await assert.rejects(foreign.update(after), /foreign/);
      assert.deepEqual(await competitor.read('run1'), after);
    } finally { if (held) await held.kill(); await f.cleanup(); }
  });
}

test('real child update crash: restarted exact same run Stop→collect→terminal→cleanup; unknown stays fenced', { timeout: 15000 }, async t => {
  const f = await fixture();
  let held: Awaited<ReturnType<typeof holder>> | undefined;
  try {
    const handle = await f.executor.start(f.plan);
    const record = await f.journal.read(handle.runId);
    record.phase = 'STOP_UNCONFIRMED';
    held = await holder(t, f, 'update', record);
    await held.kill(); held = undefined;
    const journal = new DurableRunJournal(f.journal.directory, 'install');
    const restarted = new DockerExecutor({ policy: f.policy, journal, transport: f.fake });
    const orphans = await restarted.inspectOwnedOrphans('install');
    assert.equal(orphans.length, 1);
    assert.deepEqual(orphans[0].handle, handle);
    assert.equal(orphans[0].state, 'RUNNING');
    // Unknown Docker state is not proof of termination or a terminal receipt.
    f.fake.daemon = false;
    const unknown = await restarted.stop(handle, 'RECOVERY');
    assert.equal(unknown.confirmed, false);
    assert.equal((await journal.read(handle.runId)).phase, 'STOP_UNCONFIRMED');
    await assert.rejects(restarted.persistTerminal(handle, { status: 'FAILED', testOutcome: 'UNKNOWN', testCount: 0, skipped: 0, failures: 0, errors: 0, problem: null }));
    assert.equal(f.fake.calls.filter(a => a[0] === 'rm').length, 0);
    f.fake.daemon = true;
    const stopped = await restarted.stop(handle, 'RECOVERY');
    assert.equal(stopped.confirmed, true);
    if (!stopped.confirmed) throw Error('No confirmed exit');
    assert.equal(stopped.exit.exitCode, 137);
    const collection = await restarted.collect(handle, stopped.exit);
    assert.equal(collection.handle.runId, handle.runId);
    const receipt = await restarted.persistTerminal(handle, { status: 'FAILED', testOutcome: 'UNKNOWN', testCount: 0, skipped: 0, failures: 0, errors: 0, problem: null });
    assert.equal((await journal.read(handle.runId)).phase, 'TERMINAL');
    assert.equal(f.fake.calls.filter(a => a[0] === 'rm').length, 0);
    await restarted.cleanup(receipt);
    assert.equal((await journal.read(handle.runId)).phase, 'REMOVED');
    assert.deepEqual(f.fake.calls.filter(a => a[0] === 'stop'), [['stop', '--time', '2', 'c'.repeat(64)]]);
    assert.deepEqual(f.fake.calls.filter(a => a[0] === 'rm'), [['rm', 'c'.repeat(64)]]);
    assert.deepEqual(await restarted.inspectOwnedOrphans('install'), []);
  } finally { if (held) await held.kill(); await f.cleanup(); }
});

test('same-process independent Journal instances also exclude; released lease never bypasses optimistic revision', async () => {
  const f = await fixture();
  try {
    await f.journal.initialize();
    const record = intent(f); await f.journal.reserve(record);
    let enter!: () => void, release!: () => void;
    const entered = new Promise<void>(r => enter = r), gate = new Promise<void>(r => release = r);
    const original = f.journal.read.bind(f.journal);
    f.journal.read = async id => { const row = await original(id); enter(); await gate; return row; };
    const transaction = f.journal.update(record);
    await entered;
    const second = new DurableRunJournal(f.journal.directory, 'install');
    const stale = await second.read('run1');
    try { await assert.rejects(second.update(stale)); } finally { release(); }
    await transaction;
    await assert.rejects(second.update(stale), /revision/);
    assert.equal((await second.read('run1')).revision, 1);
  } finally { await f.cleanup(); }
});

test('legacy empty wx sentinel is not guessed dead, unlinked, or adopted as native lease', async () => {
  const f = await fixture();
  try {
    await f.journal.initialize();
    const file = path.join(f.journal.directory, '.transaction-lock');
    const fd = await fs.open(file, 'wx', 0o600); await fd.close();
    const before = await fs.lstat(file, { bigint: true });
    await assert.rejects(f.journal.reserve(intent(f)));
    const after = await fs.lstat(file, { bigint: true });
    assert.equal(after.ino, before.ino); assert.equal(after.size, 0n);
    await assert.rejects(f.journal.read('run1'), { code: 'ENOENT' });
  } finally { await f.cleanup(); }
});

for (const operation of ['reserve', 'update'] as const) test(`real child ${operation} crash AFTER record publication preserves exact committed row/revision`, { timeout: 15000 }, async t => {
  const f = await fixture();
  let held: Awaited<ReturnType<typeof holder>> | undefined;
  try {
    await f.journal.initialize();
    const record = intent(f);
    if (operation === 'update') { await f.journal.reserve(record); record.phase = 'STOP_UNCONFIRMED'; }
    held = await holder(t, f, operation, record, 'after');
    const fresh = new DurableRunJournal(f.journal.directory, 'install');
    const published = await fresh.read('run1');
    assert.equal(published.revision, operation === 'reserve' ? 0 : 1);
    assert.equal(published.phase, record.phase);
    await assert.rejects(fresh.update(structuredClone(published)));
    await held.kill(); held = undefined;
    assert.deepEqual(await fresh.read('run1'), published);
    await fresh.update(published);
    assert.equal((await fresh.read('run1')).revision, operation === 'reserve' ? 1 : 2);
  } finally { if (held) await held.kill(); await f.cleanup(); }
});

test('concurrent first publishers have one stable anchor, one reservation, no unlink on successful release', async () => {
  const f = await fixture();
  try {
    await f.journal.initialize();
    const other = new DurableRunJournal(f.journal.directory, 'install');
    const results = await Promise.allSettled([f.journal.reserve(intent(f)), other.reserve(intent(f))]);
    assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
    assert.equal(results.filter(r => r.status === 'rejected').length, 1);
    assert.equal((await f.journal.list()).length, 1);
    const file = path.join(f.journal.directory, '.transaction-lock');
    const before = await fs.lstat(file, { bigint: true });
    const row = await other.read('run1'); await other.update(row);
    const after = await fs.lstat(file, { bigint: true });
    assert.equal(before.ino, after.ino); assert.equal(before.dev, after.dev);
    assert.equal(before.nlink, 1n); assert.equal(after.nlink, 1n);
  } finally { await f.cleanup(); }
});
