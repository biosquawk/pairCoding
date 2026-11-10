// Standalone bounded real restore measurement, NOT auto-discovered in the regular test suite.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { open } from './helpers';
const count = Number(process.argv[2] ?? 100);
assert.ok(Number.isSafeInteger(count) && count > 0 && count <= 1000);
const bytesPerFile = Number(process.argv[3] ?? 8);
assert.ok(Number.isSafeInteger(bytesPerFile) && bytesPerFile >= 8 && bytesPerFile <= 1048576);
const sourceText = 'SNAPSHOT' + 'S'.repeat(bytesPerFile - 8), workText = 'WORK' + 'W'.repeat(bytesPerFile - 4);
const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'snapshot-scale-'));
const root = path.join(parent, 'project'), data = path.join(parent, 'data'); fs.mkdirSync(root);
const paths = Array.from({length: count}, (_, i) => `file${String(i).padStart(4, '0')}.ts`);
for (const p of paths) fs.writeFileSync(path.join(root, p), sourceText);
const f = open(root, data);
async function measured<T>(action: () => T | Promise<T>) {
  const scheduled = performance.now();
  let timerDelayMs = 0;
  const timer = new Promise<void>(resolve => setTimeout(() => { timerDelayMs = Math.max(0, performance.now() - scheduled - 1); resolve(); }, 1));
  let last = performance.now(), maxStallMs = 0, samples = 0;
  const probe = setInterval(() => { const now = performance.now(); maxStallMs = Math.max(maxStallMs, now - last - 1); last = now; samples++; }, 1);
  const start = performance.now();
  try {
    const result = await action(), elapsedMs = performance.now() - start;
    await timer;
    maxStallMs = Math.max(maxStallMs, performance.now() - last - 1);
    return {result, elapsedMs, timerDelayMs, maxStallMs, samples};
  } finally { clearInterval(probe); }
}
try {
  const capture = await measured(() => f.workspace.createSnapshotAsync('Scale'));
  const snapshot = capture.result, captureMs = capture.elapsedMs;
  for (const p of paths) fs.writeFileSync(path.join(root, p), workText);
  f.workspace.scanExternal();
  const restore = await measured(() => f.restore(snapshot.snapshotId, paths));
  const backup = restore.result, restoreMs = restore.elapsedMs;
  for (const p of paths) assert.equal(fs.readFileSync(path.join(root, p), 'utf8'), sourceText);
  assert.ok(f.workspace.readSnapshot(backup.snapshotId).files.every(file => Buffer.from(file.rawBase64!, 'base64').toString() === workText));
  console.log('SCALE_RESULT ' + JSON.stringify({platform: process.platform, node: process.version, revision: process.env.SNAPSHOT_REVISION, count, bytesPerFile, captureMs, restoreMs, maxCaptureStallMs:capture.maxStallMs, maxRestoreStallMs:restore.maxStallMs, captureSamples:capture.samples, restoreSamples:restore.samples, maxCaptureTimerDelayMs: capture.timerDelayMs, maxRestoreTimerDelayMs: restore.timerDelayMs, loadAverage: os.loadavg(), cpus: os.cpus().length, publicBytes: 'all SNAPSHOT', backupBytes: 'all WORK', clientTimeout: 'NOT_RUN (service measurement only)'}));
} finally { f.close(); fs.rmSync(parent, {recursive: true, force: true}); }
