import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { SnapshotStorage } from '../../src/server/SnapshotStorage';
import { fixture, open, code } from './helpers';

// Exactly the public count/path budget on real files; no filesystem path-limit bypass.
function longPaths(length: number) {
  return Array.from({length: 1000}, (_, i) => `${'a'.repeat(200)}/${'b'.repeat(200)}/${'c'.repeat(200)}/${'d'.repeat(200)}/${String(i).padStart(4, '0')}${'e'.repeat(length - 808)}`);
}
for (const length of [985, 992, 1024]) test(`signed material round-trip at 1000 paths / ${length} characters, including backup and journal`, async t => {
  const f = fixture(t, {}), paths = longPaths(length);
  assert.ok(paths.every(p => p.length === length));
  fs.mkdirSync(path.dirname(f.file(paths[0])), {recursive: true});
  for (const p of paths) fs.writeFileSync(f.file(p), 'x');
  f.workspace.scanExternal();
  const snapshot = f.workspace.createSnapshot('Boundary', paths);
  assert.deepEqual(f.workspace.readSnapshot(snapshot.snapshotId).snapshot.paths, paths);
  const backup = await f.restore(snapshot.snapshotId, paths);
  assert.deepEqual(f.workspace.readSnapshot(backup.snapshotId).snapshot.paths, paths);
  assert.equal(f.workspace.listSnapshots().length, 2);
  f.close(); const again = open(f.root, f.data);
  try { assert.equal(again.workspace.listSnapshots().length, 2); } finally { again.close(); }
});

test('signed write/read share an exact byte budget; overflow creates no file', t => {
  const f = fixture(t), store = new SnapshotStorage(f.root, f.data, (p, m) => f.workspace._safePath(p, m));
  // Establish the normal lazy identity first.
  f.workspace.createSnapshot('Identity');
  const envelopeBytes = (value: unknown) => Buffer.byteLength(JSON.stringify({payload: JSON.stringify(value), mac: '0'.repeat(64)}));
  const value = {text: 'ą'.repeat(100)}, limit = envelopeBytes(value);
  const file = path.join(f.parent, 'exact.json');
  store.writeSigned(file, value, limit);
  assert.equal(fs.statSync(file).size, limit);
  assert.deepEqual(store.readSigned(file, limit), value);
  const oversized = path.join(f.parent, 'over.json');
  assert.throws(() => store.writeSigned(oversized, {text: value.text + 'x'}, limit), code('SNAPSHOT_MANIFEST_TOO_LARGE'));
  assert.equal(fs.existsSync(oversized), false);
  assert.throws(() => store.readSigned(file, limit - 1), code('RECOVERY_REQUIRED'));
});
