import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fork, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { fixture, open, code } from './helpers';
import { WorkspaceService } from '../../src/server/WorkspaceService';
import { SessionController } from '../../src/server/SessionController';
import { WriteGate } from '../../src/server/WriteGate';
const childFile = fileURLToPath(new URL('./snapshot-child.ts', import.meta.url));
const expectedWork = { 'a.ts': 'WORK A\n', 'b.ts': 'WORK B\n' };
const expectedSnapshot = { 'a.ts': 'SNAP A\n', 'b.ts': 'SNAP B\n' };

function seed(t: any) {
  const f = fixture(t), snapshot = f.workspace.createSnapshot('Before training');
  f.write('a.ts', expectedWork['a.ts']); f.write('b.ts', expectedWork['b.ts']); f.close();
  return { ...f, snapshot };
}
function files(f: ReturnType<typeof seed>): Record<string, string | null> {
  return Object.fromEntries(['a.ts', 'b.ts'].map(p => [p, fs.existsSync(f.file(p)) ? f.bytes(p).toString() : null]));
}
async function killAt(t: any, f: ReturnType<typeof seed>, action: string, phase: string, index = '*', whileAlive?: () => void) {
  const child = fork(childFile, [f.root, f.data, action, f.snapshot.snapshotId, phase, index], { execArgv: ['--import', 'tsx'], stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  let stdout = '', stderr = ''; child.stdout!.on('data', b => { stdout += b; }); child.stderr!.on('data', b => { stderr += b; });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  const point = await new Promise<any>((resolve, reject) => {
    const timeout = setTimeout(() => reject(Error(`Checkpoint timeout ${phase}: ${stdout}\n${stderr}`)), 20000);
    child.once('message', message => { clearTimeout(timeout); resolve(message); });
    child.once('error', e => { clearTimeout(timeout); reject(e); });
    child.once('exit', (exit, signal) => { clearTimeout(timeout); reject(Error(`Premature child exit ${exit}/${signal}: ${stdout}\n${stderr}`)); });
  });
  assert.equal(point.phase, phase);
  whileAlive?.();
  const exited = once(child, 'exit'); assert.equal(child.kill('SIGKILL'), true);
  const [exit, signal] = await exited;
  assert.ok(signal === 'SIGKILL' || process.platform === 'win32' && exit !== 0, 'actual hard process termination, not a thrown exception');
  console.log('REAL_CHILD_KILL ' + JSON.stringify({ action, phase, index: point.index, pid: point.pid, exit, signal, observedFiles: files(f), stdout, stderr }));
}
function restart(f: ReturnType<typeof seed>, expectedCode?: string) {
  const result = spawnSync(process.execPath, ['--import', 'tsx', childFile, f.root, f.data, 'recover', f.snapshot.snapshotId, 'NO_PAUSE', '*'], { encoding: 'utf8', timeout: 20000 });
  assert.equal(result.error, undefined);
  console.log('REAL_RESTART ' + JSON.stringify({ status: result.status, stdout: result.stdout, stderr: result.stderr, observedFiles: files(f) }));
  assert.equal(result.status, expectedCode ? 2 : 0, result.stdout + result.stderr);
  const raw = result.stdout.split('\n').find(s => s.startsWith('RESULT ')); assert.ok(raw);
  const parsed = JSON.parse(raw!.slice(7));
  if (expectedCode) assert.equal(parsed.code, expectedCode);
  else assert.equal(parsed.status, 'OK');
}

for (const phase of ['PREPARED', 'CAPTURED', 'BEFORE_PUBLICATION', 'PUBLISHED', 'FORWARD_LINKED', 'COMMITTED']) {
  test(`real crash ${phase}: rollback-only restart and idempotent second restart`, { timeout: 60000 }, async t => {
    const f = seed(t);
    await killAt(t, f, 'restore', phase, phase === 'CAPTURED' || phase === 'PUBLISHED' ? '0' : '*');
    restart(f); assert.deepEqual(files(f), phase === 'COMMITTED' ? expectedSnapshot : expectedWork);
    const materialBefore = journalFiles(f); restart(f);
    assert.deepEqual(files(f), phase === 'COMMITTED' ? expectedSnapshot : expectedWork);
    assert.deepEqual(journalFiles(f), materialBefore, 'second recovery is read-only after a durable terminal marker');
    const ready = open(f.root, f.data);
    try {
      assert.equal(ready.workspace.listSnapshots().length, 2, 'source and durable backup survive crash');
      const backup = ready.workspace.listSnapshots().find(s => s.snapshotId !== f.snapshot.snapshotId)!;
      assert.equal(Buffer.from(ready.workspace.readSnapshot(backup.snapshotId).files[0].rawBase64!, 'base64').toString(), expectedWork['a.ts']);
      ready.gate.write({ ...ready.auth(), path: 'a.ts', baseVersion: ready.workspace.getDocument('a.ts').version, content: 'NORMAL WRITE AFTER RECOVERY' });
      assert.equal(f.bytes('a.ts').toString(), 'NORMAL WRITE AFTER RECOVERY');
    } finally { ready.close(); }
  });
}
function journalFiles(f: ReturnType<typeof seed>): string[] {
  const walk = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(path.join(dir, e.name)) : [path.relative(f.root, path.join(dir, e.name)) + ':' + fs.statSync(path.join(dir, e.name)).size]).sort();
  return walk(f.file('.paircoach/snapshot-journal-v1'));
}

for (const phase of ['ROLLED_BACK_FILE', 'ROLLBACK_CAPTURED', 'ROLLBACK_LINKED']) test(`real recovery interrupted at ${phase} resumes without replaying old forward auth`, { timeout: 60000 }, async t => {
  const f = seed(t); await killAt(t, f, 'restore', 'PUBLISHED', '0');
  await killAt(t, f, 'recover', phase, phase === 'ROLLED_BACK_FILE' ? '1' : '0');
  restart(f); assert.deepEqual(files(f), expectedWork);
  restart(f); assert.deepEqual(files(f), expectedWork);
});

test('foreign public replacement between crash/restart is never overwritten/deleted; all gates remain fail-closed', { timeout: 60000 }, async t => {
  const f = seed(t); await killAt(t, f, 'restore', 'PUBLISHED', '0');
  fs.unlinkSync(f.file('a.ts')); fs.writeFileSync(f.file('a.ts'), 'FOREIGN LATEST');
  restart(f, 'RECOVERY_REQUIRED'); assert.equal(f.bytes('a.ts').toString(), 'FOREIGN LATEST');
  restart(f, 'RECOVERY_REQUIRED'); assert.equal(f.bytes('a.ts').toString(), 'FOREIGN LATEST');
  const w = new WorkspaceService(f.root, f.data), s = new SessionController(w);
  try {
    assert.throws(() => new WriteGate(w, s), code('RECOVERY_REQUIRED'));
    assert.throws(() => w._withMutation(() => assert.fail('must not run')), code('RECOVERY_REQUIRED'));
    assert.equal(w.listSnapshots().length, 2, 'recovery material remains readable');
  } finally { s.close(); w.close(); }
});

for (const tamper of ['manifest', 'captured', 'symlink-ancestor', 'atomic-lock']) test(`untrusted journal ${tamper}: restart refuses effects and preserves outside/current bytes`, { timeout: 60000 }, async t => {
  const f = seed(t); await killAt(t, f, 'restore', 'PUBLISHED', '0');
  const base = f.file('.paircoach/snapshot-journal-v1');
  const operation = path.join(base, fs.readdirSync(base).find(n => n.startsWith('transaction-'))!);
  const outside = path.join(f.parent, 'outside'); fs.mkdirSync(outside); fs.writeFileSync(path.join(outside, 'a.ts'), 'DO NOT TOUCH');
  if (tamper === 'manifest') {
    const file = path.join(operation, 'intent.json'), envelope = JSON.parse(fs.readFileSync(file, 'utf8'));
    const payload = JSON.parse(envelope.payload); payload.entries[0].path = '../outside/a.ts'; envelope.payload = JSON.stringify(payload); fs.writeFileSync(file, JSON.stringify(envelope));
  } else if (tamper === 'captured') fs.writeFileSync(path.join(operation, '1.captured'), 'FOREIGN CAPTURED BYTES');
  else if (tamper === 'atomic-lock') {
    const session = path.join(operation, fs.readdirSync(operation).find(n => /^\.atomic-[a-f0-9-]{36}$/.test(n))!);
    fs.renameSync(path.join(session, 'LOCK'), path.join(session, 'LOCK-ORIGINAL'));
    fs.writeFileSync(path.join(session, 'LOCK'), 'FOREIGN LOCK IDENTITY');
  }
  else { fs.renameSync(base, base + '-held'); fs.symlinkSync(outside, base, process.platform === 'win32' ? 'junction' : 'dir'); }
  const before = files(f);
  restart(f, 'RECOVERY_REQUIRED'); assert.deepEqual(files(f), before);
  restart(f, 'RECOVERY_REQUIRED'); assert.deepEqual(files(f), before);
  assert.equal(fs.readFileSync(path.join(outside, 'a.ts'), 'utf8'), 'DO NOT TOUCH');
});


test('startup never rolls back a journal owned by another still-live process', { timeout: 60000 }, async t => {
  const f = seed(t);
  await killAt(t, f, 'restore', 'PREPARED', '*', () => { restart(f, 'RECOVERY_REQUIRED'); assert.deepEqual(files(f), expectedWork); });
  restart(f); assert.deepEqual(files(f), expectedWork); restart(f);
});

test('a second backend never signals STOP to a still-live worker; recovery after actual owner kill succeeds', {timeout: 60000}, async t => {
  const f = seed(t);
  await killAt(t, f, 'restore', 'CAPTURE_MOVE_ARMED', '0', () => {
    restart(f, 'RECOVERY_REQUIRED');
    const base = f.file('.paircoach/snapshot-journal-v1');
    const directory = path.join(base, fs.readdirSync(base).find(n => n.startsWith('transaction-'))!);
    const session = path.join(directory, fs.readdirSync(directory).find(n => /^\.atomic-[a-f0-9-]{36}$/.test(n))!);
    assert.equal(fs.existsSync(path.join(session, 'STOP')), false, 'a live owner must not be interrupted by a second backend');
  });
  restart(f); assert.deepEqual(files(f), expectedWork); restart(f);
});

for (const action of ['restore', 'recover']) for (const boundary of ['ARMED', 'JOINED']) {
  test(`native helper ${action} ${boundary}: hard kill preserves material and never races uncertain worker`, {timeout: 60000}, async t => {
    const f = seed(t);
    if (action === 'recover') await killAt(t, f, 'restore', 'PUBLISHED', '0');
    const phase = `${action === 'restore' ? 'CAPTURE' : 'UNDO'}_MOVE_${boundary}`;
    await killAt(t, f, action, phase, '0');
    // ARMED (request not sent) and JOINED (effect completed) both have
    // deterministic metadata once STOP + lock barrier has quiesced the worker.
    restart(f); assert.deepEqual(files(f), expectedWork);
    restart(f); assert.deepEqual(files(f), expectedWork);
  });
}

test('live native helper survives parent hard kill: restart waits for real orphan then automatically restores all bytes', {timeout: 60000, skip: process.platform !== 'linux' && 'Linux real renameat2 orphan coordination; Windows separate native cases'}, async t => {
  const f = seed(t), marker = f.file('.paircoach/helper-live'); let helperPid = 0;
  await killAt(t, f, 'restore', 'HELPER_LIVE', '0', () => {
    const until = Date.now() + 10000;
    while (!fs.existsSync(marker) && Date.now() < until) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
    assert.ok(fs.existsSync(marker)); helperPid = Number(fs.readFileSync(marker, 'utf8'));
    assert.ok(helperPid > 0); assert.doesNotThrow(() => process.kill(helperPid, 0));
  });
  assert.doesNotThrow(() => process.kill(helperPid, 0), 'actual helper is still alive after parent SIGKILL');
  restart(f); // STOP+lock barrier waits for in-flight real syscall, THEN rollback
  assert.equal(fs.readFileSync(marker, 'utf8'), 'DONE', 'orphan really executed original atomic syscall');
  assert.deepEqual(files(f), expectedWork);
  const base = f.file('.paircoach/snapshot-journal-v1');
  const directory = path.join(base, fs.readdirSync(base).find(n => n.startsWith('transaction-'))!);
  assert.equal(fs.readFileSync(path.join(directory, '0.captured'), 'utf8'), expectedWork['a.ts']);
  restart(f); assert.deepEqual(files(f), expectedWork);
  const readOnly = new WorkspaceService(f.root, f.data);
  try {
    const backup = readOnly.listSnapshots().find(s => s.snapshotId !== f.snapshot.snapshotId)!;
    assert.equal(Buffer.from(readOnly.readSnapshot(backup.snapshotId).files[0].rawBase64!, 'base64').toString(), expectedWork['a.ts']);
  } finally { readOnly.close(); }
});
