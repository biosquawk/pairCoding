import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { atomicNoReplace, prepareAtomicNoReplace } from '../../src/server/AtomicNoReplace';
import { fixture, code } from './helpers';
const require = createRequire(import.meta.url);

for (const failure of ['library', 'symbol']) test(`unavailable native ${failure} fails closed without any fallback or public effects`, t => {
  const f = fixture(t), snapshot = f.workspace.createSnapshot('Original'), koffi = require('koffi'), target = path.join(f.parent, 'target');
  f.write('a.ts', 'WORK');
  t.mock.method(koffi, 'load', () => {
    if (failure === 'library') throw Error('native library unavailable');
    return {func: () => { throw Error('symbol unavailable'); }};
  });
  assert.throws(() => prepareAtomicNoReplace(), code('ATOMIC_MOVE_UNAVAILABLE'));
  assert.throws(() => atomicNoReplace(f.file('a.ts'), target), code('ATOMIC_MOVE_UNAVAILABLE'));
  assert.equal(f.bytes('a.ts').toString(), 'WORK'); assert.equal(fs.existsSync(target), false);
  assert.throws(() => f.restore(snapshot.snapshotId, ['a.ts']), code('ATOMIC_MOVE_UNAVAILABLE'));
  assert.equal(f.bytes('a.ts').toString(), 'WORK');
  assert.equal(fs.existsSync(f.file('.paircoach/snapshot-journal-v1')), false, 'unavailable runtime fails before journal/public effects');
});
