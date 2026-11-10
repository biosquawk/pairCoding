// Standalone bounded real restore measurement, NOT auto-discovered in the regular test suite.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { open } from './helpers';
const count = Number(process.argv[2] ?? 100);
assert.ok(Number.isSafeInteger(count) && count > 0 && count <= 1000);
const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'snapshot-scale-'));
const root = path.join(parent, 'project'), data = path.join(parent, 'data'); fs.mkdirSync(root);
const paths = Array.from({length: count}, (_, i) => `file${String(i).padStart(4, '0')}.ts`);
for (const p of paths) fs.writeFileSync(path.join(root, p), 'SNAPSHOT');
const f = open(root, data);
try {
  const capture = performance.now(), snapshot = f.workspace.createSnapshot('Scale');
  const captureMs = performance.now() - capture;
  for (const p of paths) fs.writeFileSync(path.join(root, p), 'WORK');
  f.workspace.scanExternal();
  const start = performance.now(), backup = f.restore(snapshot.snapshotId, paths);
  const restoreMs = performance.now() - start;
  for (const p of paths) assert.equal(fs.readFileSync(path.join(root, p), 'utf8'), 'SNAPSHOT');
  assert.ok(f.workspace.readSnapshot(backup.snapshotId).files.every(file => Buffer.from(file.rawBase64!, 'base64').toString() === 'WORK'));
  console.log('SCALE_RESULT ' + JSON.stringify({platform: process.platform, node: process.version, count, captureMs, restoreMs, publicBytes: 'all SNAPSHOT', backupBytes: 'all WORK', clientTimeout: 'NOT_RUN (service measurement only)'}));
} finally { f.close(); fs.rmSync(parent, {recursive: true, force: true}); }
