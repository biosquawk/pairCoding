import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { atomicNoReplace } from '../../src/server/AtomicNoReplace';
import { fixture } from './helpers';

test('native atomic move: absent/occupied slots, spaces/Unicode, no shell path interpretation', t => {
  const f = fixture(t), from = path.join(f.parent, "source ż '&$.txt"), to = path.join(f.parent, "dest ą '&$.txt");
  fs.writeFileSync(from, 'ONE'); atomicNoReplace(from, to);
  assert.equal(fs.existsSync(from), false); assert.equal(fs.readFileSync(to, 'utf8'), 'ONE');
  fs.writeFileSync(from, 'TWO');
  assert.throws(() => atomicNoReplace(from, to), (e: any) => e.code === 'EEXIST');
  assert.equal(fs.readFileSync(from, 'utf8'), 'TWO'); assert.equal(fs.readFileSync(to, 'utf8'), 'ONE');
});

test('missing native runtime fails closed without a rename/copy fallback', t => {
  const f = fixture(t), to = path.join(f.parent, 'destination');
  const real = childProcess.spawnSync;
  t.mock.method(childProcess, 'spawnSync', (_exe: any, args: any, options: any) => real(path.join(f.parent, 'MISSING_EXECUTABLE'), args, options));
  syncBuiltinESMExports();
  assert.throws(() => atomicNoReplace(f.file('a.ts'), to), (e: any) => e.code === 'ATOMIC_MOVE_UNAVAILABLE');
  assert.equal(f.bytes('a.ts').toString(), 'SNAP A\n'); assert.equal(fs.existsSync(to), false);
});

test('already occupied capture slot before effect remains unchanged and blocks restore', t => {
  const f = fixture(t), snap = f.workspace.createSnapshot('Original'); f.write('a.ts', 'WORK'); let slot = '';
  f.workspace.on('snapshotCheckpoint', e => {
    if (e.phase === 'PREPARED') {
      const base = f.file('.paircoach/snapshot-journal-v1');
      const op = fs.readdirSync(base).find(p => p.startsWith('transaction-'))!;
      slot = path.join(base, op, '0.captured'); fs.writeFileSync(slot, 'FOREIGN PREEXISTING', {flag: 'wx'});
    }
  });
  assert.throws(() => f.restore(snap.snapshotId, ['a.ts']));
  assert.equal(fs.readFileSync(slot, 'utf8'), 'FOREIGN PREEXISTING'); assert.equal(f.bytes('a.ts').toString(), 'WORK');
});

test('real restore helper overhead is measured, not assumed Windows-equivalent', t => {
  const f = fixture(t), snap = f.workspace.createSnapshot('Original'); f.write('a.ts', 'WORK');
  let moves = 0; const real = childProcess.spawnSync;
  t.mock.method(childProcess, 'spawnSync', (exe: any, args: any, options: any) => { moves++; return real(exe, args, options); }); syncBuiltinESMExports();
  const start = performance.now(); f.restore(snap.snapshotId, ['a.ts']);
  console.log('NATIVE_RESTORE_OVERHEAD ' + JSON.stringify({platform: process.platform, files: 1, moves, elapsedMs: performance.now() - start}));
  assert.equal(moves, 1); assert.equal(f.bytes('a.ts').toString(), 'SNAP A\n');
});

test('native no-replace supports long absolute paths without losing occupied destination', t => {
  const f = fixture(t), directory = path.join(f.parent, ...['a', 'b', 'c', 'd'].map(c => c.repeat(200)));
  fs.mkdirSync(directory, {recursive: true});
  const from = path.join(directory, 'source.ts'), to = path.join(directory, 'destination.ts');
  fs.writeFileSync(from, 'LONG SOURCE'); atomicNoReplace(from, to);
  assert.equal(fs.readFileSync(to, 'utf8'), 'LONG SOURCE');
  fs.writeFileSync(from, 'LATE SOURCE');
  assert.throws(() => atomicNoReplace(from, to), (e: any) => e.code === 'EEXIST');
  assert.equal(fs.readFileSync(from, 'utf8'), 'LATE SOURCE'); assert.equal(fs.readFileSync(to, 'utf8'), 'LONG SOURCE');
});
