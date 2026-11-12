import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { performance } from 'node:perf_hooks';
import { fixture, code, open } from '../snapshots/helpers';
import type { WorkspaceService, ExternalSync } from '../../src/server/WorkspaceService';

type Internals = {
  watchScan(): void;
  collectSteps(): Generator<void, { files: string[]; dirs: string[] }, void>;
  disk: (file: string) => unknown;
  records: Map<string, { stamp: string; document: { content: string; version: number } | null }>;
  backgroundScan?: object | null;
};
const internal = (w: WorkspaceService) => w as unknown as Internals;
const turn = () => new Promise<void>(resolve => setImmediate(resolve));
async function until(predicate: () => boolean) {
  const end = performance.now() + 5000;
  while (!predicate() && performance.now() < end) await turn();
  assert.ok(predicate(), 'background operation did not reach the expected boundary');
}
function events(w: WorkspaceService) {
  const observed: ExternalSync[] = [];
  w.on('external', e => observed.push(e));
  w.on('watcherError', e => assert.fail(`Unexpected watcher error: ${e.code ?? e}`));
  return observed;
}
function afterFirstRead(w: WorkspaceService, action: () => void) {
  const i = internal(w), original = i.disk.bind(w);
  let scheduled = false, finished = false;
  i.disk = file => {
    const result = original(file);
    if (!scheduled) {
      scheduled = true;
      setImmediate(() => { action(); finished = true; });
    }
    return result;
  };
  i.watchScan();
  return async () => { await until(() => finished && !i.backgroundScan); };
}

test('explicit scanExternal remains synchronous; background observes external create/update/delete', async t => {
  const f = fixture(t), observed = events(f.workspace);
  fs.writeFileSync(f.file('a.ts'), 'SYNC');
  f.workspace.scanExternal();
  assert.equal(observed.length, 1);
  assert.equal(observed[0].document?.content, 'SYNC');
  observed.length = 0;
  fs.writeFileSync(f.file('a.ts'), 'WATCHED');
  fs.writeFileSync(f.file('new.ts'), 'CREATED');
  fs.unlinkSync(f.file('b.ts'));
  // Real native watcher/poll, not a direct call to scanExternal or watchScan.
  await until(() => observed.length === 3);
  await until(() => !internal(f.workspace).backgroundScan);
  assert.deepEqual(observed.map(e => [e.path, e.operation, e.document?.content ?? null]).sort(),
    [['a.ts', 'UPDATED', 'WATCHED'], ['b.ts', 'DELETED', null], ['new.ts', 'CREATED', 'CREATED']]);
});

test('real active polling of 100 files yields to heartbeat and an immediate observer between every file', async t => {
  const files = Object.fromEntries(Array.from({ length: 100 }, (_, i) => [i ? `f${i}.txt` : 'main.ts', i ? 'fixture\n' : 'x'.repeat(100 * 1024)]));
  const f = fixture(t, files), i = internal(f.workspace);
  const original = i.disk.bind(f.workspace);
  let reads = 0, maxBatch = 0, previous = 0, beatsDuringScan = 0, observe = true;
  i.disk = file => { reads++; return original(file); };
  const heartbeat = setInterval(() => { if (reads > 0 && i.backgroundScan) beatsDuringScan++; }, 1);
  const start = performance.now();
  const observer = () => {
    maxBatch = Math.max(maxBatch, reads - previous); previous = reads;
    if (observe) setImmediate(observer);
  };
  setImmediate(observer);
  try {
    // No direct scan invocation: wait for the production 500ms poll, with watchers enabled.
    await until(() => reads >= 100 && !i.backgroundScan);
    assert.equal(reads, 100, 'one complete production background cycle must actually read every file');
    assert.equal(maxBatch, 1, 'negative oracle: synchronous draining monopolizes all 100 reads');
    assert.ok(beatsDuringScan > 0, 'a real timer must run while the scan is active');
    console.log('COOPERATIVE_POLL ' + JSON.stringify({ platform: process.platform, node: process.version,
      files: 100, reads, maxReadsBetweenImmediateObservations: maxBatch, beatsDuringScan, elapsedMs: performance.now() - start }));
  } finally { observe = false; clearInterval(heartbeat); }
});

test('write between yields keeps fresh traversal; own bytes/version/stamp are not republished', async t => {
  const f = fixture(t), observed = events(f.workspace);
  let committed: ReturnType<typeof f.write>;
  const done = afterFirstRead(f.workspace, () => { committed = f.write('a.ts', 'STUDENT'); });
  await done();
  const version = f.workspace.workspaceVersion, stamp = internal(f.workspace).records.get('a.ts')!.stamp;
  internal(f.workspace).watchScan(); await until(() => !internal(f.workspace).backgroundScan);
  assert.equal(f.workspace.workspaceVersion, version);
  assert.equal(internal(f.workspace).records.get('a.ts')!.stamp, stamp);
  assert.equal(internal(f.workspace).records.get('a.ts')!.document?.content, 'STUDENT');
  assert.equal(internal(f.workspace).records.get('a.ts')!.document?.version, committed!.version);
  assert.deepEqual(observed, [], 'own write must not cause a false EXTERNAL update');
  assert.equal(f.bytes('a.ts').toString(), 'STUDENT');
});

for (const operation of ['CREATE', 'DELETE', 'RENAME'] as const) {
  test(`${operation} between yields cannot resurrect a deleted name or erase a new path/directory`, async t => {
    const f = fixture(t), observed = events(f.workspace);
    const done = afterFirstRead(f.workspace, () => {
      f.gate.mutate({ ...f.auth(), operation, path: operation === 'CREATE' ? 'nested/new.ts' : 'a.ts',
        newPath: operation === 'RENAME' ? 'renamed.ts' : null,
        content: operation === 'CREATE' ? 'NEW' : null,
        baseVersion: operation === 'CREATE' ? null : f.workspace.getDocument('a.ts').version });
    });
    await done();
    const version = f.workspace.workspaceVersion;
    internal(f.workspace).watchScan(); await until(() => !internal(f.workspace).backgroundScan);
    assert.equal(f.workspace.workspaceVersion, version);
    assert.deepEqual(observed, []);
    const listed = f.workspace.listFiles().map(e => e.path);
    assert.equal(listed.includes('a.ts'), operation === 'CREATE');
    if (operation === 'CREATE') { assert.ok(listed.includes('nested')); assert.ok(listed.includes('nested/new.ts')); }
    if (operation === 'RENAME') assert.ok(listed.includes('renamed.ts'));
  });
}

test('external replacement and metadata-only edits between yields use fresh disk stamps, never an old frozen scan', async t => {
  const f = fixture(t), i = internal(f.workspace), observed = events(f.workspace);
  const done = afterFirstRead(f.workspace, () => {
    fs.writeFileSync(f.file('replacement'), 'LATEST');
    fs.renameSync(f.file('replacement'), f.file('b.ts'));
    const stat = fs.statSync(f.file('a.ts'));
    fs.utimesSync(f.file('a.ts'), stat.atime, new Date(stat.mtimeMs + 2000));
    f.workspace.getDocument('a.ts'); // reconcile immediately, before the suspended traversal resumes
  });
  await done();
  assert.equal(i.records.get('b.ts')!.document?.content, 'LATEST');
  assert.deepEqual(observed.map(e => [e.path, e.document?.content]).sort(), [['a.ts', 'SNAP A\n'], ['b.ts', 'LATEST']]);
  const version = f.workspace.workspaceVersion;
  f.workspace.scanExternal();
  assert.equal(f.workspace.workspaceVersion, version, 'no delayed old stamp may produce a second spurious update');
});

test('restore across yields cancels background and prevents publication of partial restore or pre-restore bytes', async t => {
  const f = fixture(t), source = f.workspace.createSnapshot('Source');
  f.write('a.ts', 'WORK A'); f.write('b.ts', 'WORK B');
  const observed = events(f.workspace);
  let restored: Promise<unknown> | undefined, inJournal = false;
  f.workspace.on('snapshotCheckpoint', e => {
    if (e.phase === 'PUBLISHED') inJournal = true;
    if (e.phase === 'COMMITTED') inJournal = false;
    if (inJournal) assert.equal(internal(f.workspace).backgroundScan, null, 'background must stay canceled for the entire async journal');
  });
  const done = afterFirstRead(f.workspace, () => { restored = f.restore(source.snapshotId, ['a.ts', 'b.ts']); });
  await done(); await restored;
  assert.equal(f.bytes('a.ts').toString(), 'SNAP A\n');
  assert.equal(f.bytes('b.ts').toString(), 'SNAP B\n');
  assert.deepEqual(observed.map(e => [e.path, e.document?.content]).sort(), [['a.ts', 'SNAP A\n'], ['b.ts', 'SNAP B\n']]);
  const version = f.workspace.workspaceVersion;
  internal(f.workspace).watchScan(); await until(() => !internal(f.workspace).backgroundScan);
  assert.equal(f.workspace.workspaceVersion, version);
});

test('close at a yield cancels pending I/O and events; explicit full scan cancels a suspended scan', async t => {
  const f = fixture(t), i = internal(f.workspace), observed = events(f.workspace);
  let reads = 0;
  const original = i.disk.bind(f.workspace);
  i.disk = file => { reads++; return original(file); };
  i.watchScan();
  f.workspace.scanExternal();
  const fullReads = reads;
  await turn(); await turn();
  assert.equal(reads, fullReads, 'explicit synchronous rescan invalidates the queued traversal');
  const done = afterFirstRead(f.workspace, () => f.workspace.close());
  await done();
  const closedReads = reads;
  fs.writeFileSync(f.file('b.ts'), 'AFTER CLOSE');
  await turn(); await turn();
  assert.equal(reads, closedReads, 'negative oracle: a canceled scan must perform no post-close disk read');
  assert.deepEqual(observed, []);
  assert.throws(() => f.workspace.getDocument('b.ts'), code('WORKSPACE_CLOSED'));
});

test('background preserves hardlink/symlink exclusions and remains usable after guarded file errors', async t => {
  const f = fixture(t), observed = events(f.workspace);
  fs.linkSync(f.file('a.ts'), f.file('linked.ts'));
  fs.symlinkSync(f.file('b.ts'), f.file('symlink.ts'));
  internal(f.workspace).watchScan(); await until(() => !internal(f.workspace).backgroundScan);
  assert.ok(!f.workspace.listFiles().some(e => e.path === 'symlink.ts'));
  assert.throws(() => f.workspace.getDocument('a.ts'), code('UNSAFE_PATH'));
  assert.throws(() => f.workspace.getDocument('linked.ts'), code('UNSAFE_PATH'));
  assert.ok(observed.every(e => e.path !== 'symlink.ts'));
  fs.unlinkSync(f.file('linked.ts'));
  internal(f.workspace).watchScan(); await until(() => !internal(f.workspace).backgroundScan);
  assert.equal(f.workspace.getDocument('a.ts').content, 'SNAP A\n');
});


test('continuous sync autosave does not starve the tail of an active background traversal', async t => {
  const files = Object.fromEntries(Array.from({ length: 12 }, (_, n) => [`f${String(n).padStart(2, '0')}.ts`, 'BASE']));
  const f = fixture(t, files), i = internal(f.workspace), observed = events(f.workspace);
  fs.writeFileSync(f.file('f11.ts'), 'TAIL EXTERNAL');
  i.watchScan();
  const scan = i.backgroundScan;
  let writes = 0;
  while (i.backgroundScan && writes < 100) {
    await turn();
    if (!i.backgroundScan) break;
    f.write('f00.ts', `AUTOSAVE ${++writes}`);
    assert.equal(i.backgroundScan, scan, 'ordinary writes must not keep restarting the scan');
  }
  assert.ok(writes > 1, 'exercise repeated writes, not a quiet gap');
  assert.equal(i.backgroundScan, null, 'the same scan must finish while autosave is still ongoing');
  assert.equal(observed.length, 1);
  assert.equal(observed[0].path, 'f11.ts');
  assert.equal(observed[0].document?.content, 'TAIL EXTERNAL');
  assert.equal(i.records.get('f00.ts')!.document?.content, `AUTOSAVE ${writes}`);
});

test('a write-refresh cannot replace a newer directory list with one collected before the yield', async t => {
  const f = fixture(t), i = internal(f.workspace);
  const done = afterFirstRead(f.workspace, () => {
    fs.mkdirSync(f.file('external-directory'));
    f.write('a.ts', 'SAVED'); // existing synchronous directory refresh sees the new external directory
  });
  await done();
  assert.ok(f.workspace.listFiles().some(e => e.path === 'external-directory' && e.kind === 'DIRECTORY'));
});

test('structural mutation from another instance cancels a scan during collection, including stale directories', async t => {
  const f = fixture(t, { 'a.ts': 'A', 'old/file.ts': 'OLD' }), i = internal(f.workspace);
  const other = open(f.root, f.data); t.after(() => other.close());
  const original = i.collectSteps.bind(f.workspace);
  let scheduled = false, finished = false, mutationError: unknown;
  i.collectSteps = function* () {
    const steps = original();
    let next = steps.next();
    while (!next.done) {
      if (!scheduled) {
        scheduled = true;
        setImmediate(() => {
          try {
          other.gate.mutate({ ...other.auth(), operation: 'CREATE', path: 'new/file.ts', newPath: null, content: 'NEW', baseVersion: null });
          other.gate.mutate({ ...other.auth(), operation: 'DELETE', path: 'old/file.ts', newPath: null, content: null,
            baseVersion: other.workspace.getDocument('old/file.ts').version });
          fs.rmdirSync(f.file('old'));
          assert.equal(i.backgroundScan, null, 'a completed structural mutation must invalidate suspended scans in every instance');
          } catch (error) { mutationError = error; }
          finally { finished = true; }
        });
      }
      yield;
      next = steps.next();
    }
    return next.value;
  };
  i.watchScan();
  await until(() => finished);
  assert.ifError(mutationError);
  await until(() => !i.backgroundScan);
  i.watchScan(); await until(() => !i.backgroundScan);
  const paths = f.workspace.listFiles().map(e => e.path);
  assert.ok(paths.includes('new')); assert.ok(paths.includes('new/file.ts'));
  assert.ok(!paths.includes('old')); assert.ok(!paths.includes('old/file.ts'));
});

test('async restore on another instance cancels the suspended scan and never exposes a partial journal', async t => {
  const f = fixture(t), source = f.workspace.createSnapshot('Source');
  const other = open(f.root, f.data); t.after(() => other.close());
  other.gate.write({ ...other.auth(), path: 'a.ts', baseVersion: other.workspace.getDocument('a.ts').version, content: 'WORK' });
  f.workspace.scanExternal();
  const i = internal(f.workspace), observed = events(f.workspace);
  let restored: Promise<unknown> | undefined;
  other.workspace.on('snapshotCheckpoint', () => assert.equal(i.backgroundScan, null));
  const done = afterFirstRead(f.workspace, () => { restored = other.restore(source.snapshotId, ['a.ts']); });
  await done(); await restored;
  i.watchScan(); await until(() => !i.backgroundScan);
  assert.deepEqual(observed.map(e => [e.path, e.document?.content]), [['a.ts', 'SNAP A\n']]);
});


test('duplicate watch requests share one job; synchronous external listener may close during next()', async t => {
  const f = fixture(t), i = internal(f.workspace);
  let reads = 0, emitted = 0;
  const original = i.disk.bind(f.workspace);
  i.disk = file => { reads++; return original(file); };
  fs.writeFileSync(f.file('a.ts'), 'EXTERNAL');
  f.workspace.on('external', () => { emitted++; f.workspace.close(); });
  i.watchScan();
  const job = i.backgroundScan;
  assert.ok(job);
  i.watchScan(); i.watchScan();
  assert.equal(i.backgroundScan, job);
  await until(() => !i.backgroundScan);
  await turn(); await turn();
  assert.equal(reads, 1, 'no second path read or rescheduled job after reentrant close');
  assert.equal(emitted, 1);
});
