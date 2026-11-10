import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { AtomicMoveSession, prepareAtomicSession } from '../../src/server/AtomicNoReplace';
import { fixture, code } from './helpers';

test('one transaction worker services 100 individual real no-replace requests, bounded nonce replies; occupied bytes preserved', t => {
  const f = fixture(t), directory = path.join(f.parent, 'session');
  const descriptor = prepareAtomicSession(directory, randomUUID()), session = new AtomicMoveSession(directory, descriptor);
  let workers = 0; const real = childProcess.spawn;
  t.mock.method(childProcess, 'spawn', (exe: any, args: any, options: any) => { workers++; return real(exe, args, options); }); syncBuiltinESMExports();
  const start = performance.now(); session.start();
  try {
    for (let i = 0; i < 100; i++) {
      const from = path.join(f.parent, `from-${i}`), to = path.join(f.parent, `to-${i}`);
      fs.writeFileSync(from, `UNIQUE-${i}`); session.move(from, to);
      assert.equal(fs.existsSync(from), false); assert.equal(fs.readFileSync(to, 'utf8'), `UNIQUE-${i}`);
    }
    const source = path.join(f.parent, 'from-0'), target = path.join(f.parent, 'to-0');
    fs.writeFileSync(source, 'FOREIGN SOURCE');
    assert.throws(() => session.move(source, target), code('EEXIST'));
    assert.equal(fs.readFileSync(source, 'utf8'), 'FOREIGN SOURCE'); assert.equal(fs.readFileSync(target, 'utf8'), 'UNIQUE-0');
  } finally { session.close(); }
  assert.equal(workers, 1); session.assertStopped();
  console.log('WORKER_100_REAL ' + JSON.stringify({platform: process.platform, workers, elapsedMs: performance.now() - start}));
});

test('STOP+OS barrier before worker launch prevents a genuinely delayed process from consuming an already published request', t => {
  const f = fixture(t), directory = path.join(f.parent, 'session');
  const descriptor = prepareAtomicSession(directory, randomUUID()), session = new AtomicMoveSession(directory, descriptor);
  const command = (session as any).command('serve'); // fixed production command, no substituted syscall
  const from = f.file('a.ts'), to = path.join(f.parent, 'late-destination');
  fs.writeFileSync(path.join(directory, 'request-1'), `${descriptor.nonce}\n1\n${Buffer.from(from).toString('base64')}\n${Buffer.from(to).toString('base64')}\n`);
  session.close();
  const late = childProcess.spawnSync(command.executable, command.args, {encoding: 'utf8', shell: false, timeout: 5000, maxBuffer: 4096});
  assert.equal(late.error, undefined); assert.equal(late.status, 0, late.stderr);
  assert.equal(f.bytes('a.ts').toString(), 'SNAP A\n'); assert.equal(fs.existsSync(to), false);
  assert.equal(fs.existsSync(path.join(directory, 'response-1')), false); session.assertStopped();
});

test('gate is reauthorized after ARMED checkpoint and before worker request; revoked lease never queues an effect', t => {
  const f = fixture(t), snapshot = f.workspace.createSnapshot('Original'); f.write('a.ts', 'WORK');
  f.workspace.on('snapshotCheckpoint', e => { if (e.phase === 'CAPTURE_MOVE_ARMED') f.session.releaseLease('tab'); });
  assert.throws(() => f.restore(snapshot.snapshotId, ['a.ts']), code('RESTORE_INCOMPLETE'));
  assert.equal(f.bytes('a.ts').toString(), 'WORK');
  const journal = f.file('.paircoach/snapshot-journal-v1');
  const transaction = path.join(journal, fs.readdirSync(journal).find(n => n.startsWith('transaction-'))!);
  const session = path.join(transaction, fs.readdirSync(transaction).find(n => /^\.atomic-[a-f0-9-]{36}$/.test(n))!);
  assert.equal(fs.existsSync(path.join(session, 'request-1')), false);
});

test('mismatched nonce after real move is unknown outcome: stop worker, inspect actual capture, rollback without replay', t => {
  const f = fixture(t), snapshot = f.workspace.createSnapshot('Original'); f.write('a.ts', 'WORK');
  const real = fs.lstatSync; let injected = false;
  t.mock.method(fs, 'lstatSync', (file: any, options: any) => {
    if (!injected && /[/\\]response-1$/.test(String(file))) {
      injected = true;
      const bytes = fs.readFileSync(file, 'utf8'); fs.writeFileSync(file, bytes.replace(/^[^\n]+/, randomUUID()));
    }
    return real(file, options);
  }); syncBuiltinESMExports();
  assert.throws(() => f.restore(snapshot.snapshotId, ['a.ts']), code('RESTORE_INCOMPLETE'));
  assert.equal(injected, true); assert.equal(f.bytes('a.ts').toString(), 'WORK');
});

test('project DTO uses the existing registry: NOT_INSTALLED plus approved profile flags', t => {
  const f = fixture(t);
  assert.deepEqual(f.workspace.getProject(f.session.state.sessionId).capabilities, {canRunMain: false, canRunTests: false, docs: 'NOT_INSTALLED', autocomplete: 'NOT_INSTALLED'});
  f.workspace.updateSettings({...f.workspace.settings, runProfiles: [{kind: 'RUN_TESTS', executable: 'node', args: ['--test'], cwd: '.', timeoutMs: 5000, testReportFormat: 'NONE', testReportGlob: null}]});
  assert.deepEqual(f.workspace.getProject(f.session.state.sessionId).capabilities, {canRunMain: false, canRunTests: true, docs: 'NOT_INSTALLED', autocomplete: 'NOT_INSTALLED'});
});
