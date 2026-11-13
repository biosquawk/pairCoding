/** REAL kernel/FS/child-process tests on the executing platform. Linux results do
 * not certify Win32. Run this exact selection in actual native Node for that proof. */
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { JournalLease } from '../../src/server/runtime-coordinator/JournalLease';
const childFile = fileURLToPath(new URL('./lease-child.ts', import.meta.url));
const id = (file: string) => { const s = fs.lstatSync(file, { bigint: true }); return [s.dev, s.ino, s.nlink, s.size].join(':'); };
async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  try { return await Promise.race([promise, new Promise<never>((_r, j) => { timer = setTimeout(() => j(Error('Owned child exceeded 10s bound')), 10000); })]); }
  finally { clearTimeout(timer!); }
}
function fixture(t: TestContext) {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'journal-lease-native-')));
  const cleanup: (() => unknown | Promise<unknown>)[] = [];
  t.after(async () => {
    try { for (const close of cleanup.reverse()) await close(); }
    finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
  return { root, file: path.join(root, 'lease.lock'), cleanup };
}
function start(f: ReturnType<typeof fixture>, mode: string, target = f.file) {
  const c = spawn(process.execPath, ['--import', 'tsx', childFile, mode, target], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  let stdout = '', stderr = '';
  c.stdout!.on('data', b => stdout += b); c.stderr!.on('data', b => stderr += b);
  const messages: any[] = [];
  const done = new Promise<{code: number | null; signal: string | null}>((resolve, reject) => {
    c.once('error', reject); c.once('close', (code, signal) => resolve({ code, signal }));
  });
  // Attach an error observer immediately, even before wait/exit checks.
  void done.catch(() => {});
  c.on('message', m => messages.push(m));
  const wait = async (event: string) => {
    let onMessage: ((m: any) => void) | undefined;
    try {
      return await bounded(Promise.race([
        new Promise<any>(resolve => {
          const seen = messages.find(m => m.event === event);
          if (seen) resolve(seen);
          else { onMessage = m => { if (m.event === event) resolve(m); }; c.on('message', onMessage); }
        }),
        done.then(exit => { throw Error('Child exited before ' + event + ': ' + JSON.stringify({ exit, stdout, stderr })); })
      ]));
    } finally { if (onMessage) c.off('message', onMessage); }
  };
  const stop = async () => {
    if (c.exitCode === null && c.signalCode === null) c.kill('SIGKILL');
    return bounded(done);
  };
  f.cleanup.push(stop);
  return { c, wait, done, stop, messages, output: () => ({ stdout, stderr }) };
}
async function once(f: ReturnType<typeof fixture>, expectedCode: number) {
  const child = start(f, 'once'), exit = await bounded(child.done);
  assert.equal(exit.code, expectedCode, JSON.stringify(child.output())); assert.equal(exit.signal, null);
  assert.ok(child.messages.some(m => m.event === (expectedCode === 0 ? 'OWNED' : 'REFUSED')), JSON.stringify(child.output()));
  return child;
}

test('real same-process ownership, refused contender never releases owner, double-close and persistent inode', () => {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'journal-lease-native-'))), file = path.join(root, 'lease.lock');
  let a: JournalLease | undefined, b: JournalLease | undefined;
  try {
    a = new JournalLease(file); const before = id(file);
    for (let i = 0; i < 2; i++) { assert.throws(() => new JournalLease(file), /kernel owner/); a.assertCurrent(); }
    assert.equal(id(file), before); a.close(); a.close(); assert.throws(() => a!.assertCurrent(), /closed/);
    b = new JournalLease(file); assert.equal(id(file), before); b.assertCurrent(); b.close(); b.close();
    assert.equal(id(file), before);
  } finally { a?.close(); b?.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('real child owner vs separate contender, normal release then separate restart retains inode', { timeout: 20000 }, async t => {
  const f = fixture(t), owner = start(f, 'hold'); await owner.wait('OWNED'); const before = id(f.file);
  await once(f, 2); assert.equal(id(f.file), before);
  owner.c.send('assert'); await owner.wait('CURRENT');
  owner.c.send('close'); await owner.wait('CLOSED');
  assert.equal((await bounded(owner.done)).code, 0);
  const next = await once(f, 0); assert.ok(next.messages.some(m => m.event === 'CLOSED'));
  assert.equal(id(f.file), before);
});

test('forced real owner death releases kernel lease; fresh process restart retains the never-unlinked inode', { timeout: 20000 }, async t => {
  const f = fixture(t), owner = start(f, 'hold'); await owner.wait('OWNED'); const before = id(f.file);
  await once(f, 2);
  const killed = await owner.stop(); assert.ok(killed.signal === 'SIGKILL' || (process.platform === 'win32' && killed.code !== 0));
  await once(f, 0); assert.equal(id(f.file), before);
});

for (const kind of ['nonempty', 'hardlink', 'directory', 'reparse'] as const) test('real unsafe ' + kind + ' refused without unlink/truncate; partial acquire cleans own handle', t => {
  const f = fixture(t), target = path.join(f.root, 'target');
  if (kind === 'nonempty') fs.writeFileSync(f.file, 'DO NOT TRUNCATE', { mode: 0o600 });
  if (kind === 'hardlink') { fs.writeFileSync(target, '', { mode: 0o600 }); fs.linkSync(target, f.file); }
  if (kind === 'directory') fs.mkdirSync(f.file);
  if (kind === 'reparse') {
    if (process.platform === 'win32') { fs.mkdirSync(target); fs.symlinkSync(target, f.file, 'junction'); }
    else { fs.writeFileSync(target, '', { mode: 0o600 }); fs.symlinkSync(target, f.file); }
  }
  const before = id(f.file), bytes = kind === 'nonempty' ? fs.readFileSync(f.file) : null;
  assert.throws(() => new JournalLease(f.file));
  assert.equal(id(f.file), before);
  if (bytes) assert.deepEqual(fs.readFileSync(f.file), bytes);
  // Rename after rejection also catches a leaked Windows share/no-delete HANDLE.
  fs.renameSync(f.file, path.join(f.root, 'retained-rejected'));
  const repaired = new JournalLease(f.file); repaired.assertCurrent(); repaired.close();
});

test('real ancestor symlink/junction is refused before any lease file creation', t => {
  const f = fixture(t), target = path.join(f.root, 'real'), link = path.join(f.root, 'link');
  fs.mkdirSync(target); fs.symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => new JournalLease(path.join(link, 'lease.lock')), /Unsafe state directory/);
  assert.equal(fs.existsSync(path.join(target, 'lease.lock')), false);
});

test('real locked file identity substitution is refused or prevented by Windows no-delete sharing', t => {
  const f = fixture(t), owned = new JournalLease(f.file), old = path.join(f.root, 'original-inode');
  f.cleanup.push(() => owned.close()); const before = id(f.file);
  if (process.platform === 'win32') {
    assert.throws(() => fs.renameSync(f.file, old)); assert.throws(() => fs.unlinkSync(f.file));
    assert.throws(() => fs.writeFileSync(f.file, 'MUST NOT TRUNCATE'));
    assert.equal(id(f.file), before); owned.assertCurrent(); owned.close();
  } else {
    fs.renameSync(f.file, old); fs.writeFileSync(f.file, '', { mode: 0o600 });
    assert.throws(() => owned.assertCurrent(), /identity changed/);
    assert.throws(() => owned.close(), /identity changed/); owned.close();
    const oldLease = new JournalLease(old), newLease = new JournalLease(f.file);
    try { assert.equal(id(old), before); oldLease.assertCurrent(); newLease.assertCurrent(); }
    finally { oldLease.close(); newLease.close(); }
  }
});

// Synchronization barrier only: the real fsync, filesystem and flock all run.
// This gap used to reset the class identity to a replacement path while the
// native lease kept a lock on the original inode. Both owners then looked valid.
test('real Linux constructor rejects replacement after locked-file flush and releases only its original inode',
  { skip: process.platform !== 'linux' && 'Linux fsync acquisition gap; Win32 denies deletion while owned' }, t => {
  const f = fixture(t), old = path.join(f.root, 'locked-original');
  const realSync = fs.fsyncSync;
  let armed = true, swapped = false, original: string | undefined;
  let first: JournalLease | undefined;
  fs.fsyncSync = ((fd: number) => {
    realSync(fd);
    if (armed && fs.fstatSync(fd).isFile()) {
      armed = false; original = id(f.file);
      fs.renameSync(f.file, old); fs.writeFileSync(f.file, '', { mode: 0o600 }); swapped = true;
    }
  }) as typeof fs.fsyncSync;
  try {
    assert.throws(() => { first = new JournalLease(f.file); }, /identity changed/);
  } finally {
    fs.fsyncSync = realSync;
    first?.close();
  }
  assert.equal(swapped, true, 'actual file-flush acquisition barrier reached');
  assert.equal(id(old), original, 'failed acquisition does not unlink or alter locked inode');
  assert.notEqual(id(old), id(f.file), 'replacement really is a different inode');
  const oldLease = new JournalLease(old), replacementLease = new JournalLease(f.file);
  try {
    oldLease.assertCurrent(); replacementLease.assertCurrent();
    assert.throws(() => new JournalLease(old), /kernel owner/);
    assert.throws(() => new JournalLease(f.file), /kernel owner/);
  } finally { oldLease.close(); replacementLease.close(); }
});

test('real Linux permissions guard remains enforced on acquisition/assert/close', { skip: process.platform !== 'linux' && 'POSIX mode bits are not Windows ACLs' }, t => {
  const f = fixture(t); fs.writeFileSync(f.file, '', { mode: 0o600 }); fs.chmodSync(f.file, 0o644);
  assert.throws(() => new JournalLease(f.file), /Unsafe/); fs.chmodSync(f.file, 0o600);
  const lease = new JournalLease(f.file); fs.chmodSync(f.file, 0o644);
  assert.throws(() => lease.assertCurrent(), /identity changed/); assert.throws(() => lease.close(), /identity changed/);
  lease.close(); fs.chmodSync(f.file, 0o600); const reopened = new JournalLease(f.file); reopened.close();
});

test('real HTTP import/factory/listen/close witness reaches canonical workspace lease and restarts', { timeout: 20000 }, async t => {
  const f = fixture(t), project = path.join(f.root, 'project'); fs.mkdirSync(project); fs.writeFileSync(path.join(project, 'source.ts'), '// ORIGINAL\n');
  let originalProjectId: string | undefined, before: string | undefined;
  for (let i = 0; i < 2; i++) {
    const child = start(f, 'factory', project); const exit = await bounded(child.done);
    assert.equal(exit.code, 0, JSON.stringify(child.output())); assert.equal(exit.signal, null);
    const events = child.messages.map(m => m.event);
    assert.deepEqual(events, ['NODE_STARTED', 'HTTP_IMPORTED', 'FACTORY_RETURNED', 'FACTORY_LISTENED', 'CLOSED']);
    const ready = child.messages.find(m => m.event === 'FACTORY_LISTENED');
    assert.ok(ready.port > 0); assert.equal(ready.workspaceVersion, 0);
    if (i === 0) { originalProjectId = ready.projectId; before = id(path.join(project, '.paircoach/workspace-v2/lease.lock')); }
    else { assert.equal(ready.projectId, originalProjectId); assert.equal(id(path.join(project, '.paircoach/workspace-v2/lease.lock')), before); }
    t.diagnostic(JSON.stringify({ iteration: i, ...child.output() }));
  }
  assert.equal(fs.readFileSync(path.join(project, 'source.ts'), 'utf8'), '// ORIGINAL\n');
});
