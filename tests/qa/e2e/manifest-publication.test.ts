import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import vm from 'node:vm';
import { randomUUID } from 'node:crypto';
import { Worker } from 'node:worker_threads';

// Exercise the actual fixture function without starting its HTTP server.
const source = fs.readFileSync('tests/qa/e2e/launch.ts', 'utf8').replace(/\r\n/g, '\n');
const declaration = 'const saveManifest = ';
assert.equal(source.split(declaration).length, 2);
const start = source.indexOf(declaration) + declaration.length;
const end = source.indexOf('\nsaveManifest();', start);
assert.ok(end > start);
const writerSource = source.slice(start, end).trim().replace(/;$/, '');
assert.ok(writerSource);

test('published JSON remains complete at the actual filesystem truncate boundary', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'paircoach-manifest-boundary-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const manifestPath = path.join(directory, 'manifest.json');
  fs.writeFileSync(manifestPath, JSON.stringify({ counter: 0 }));
  let observed: unknown;
  const instrumented = {
    ...fs,
    writeFileSync(file: string, data: string, options?: fs.WriteFileOptions) {
      // A concurrent reader can run after the writer opens/truncates its target.
      const descriptor = fs.openSync(file, options && typeof options === 'object' ? options.flag ?? 'w' : 'w');
      try {
        observed = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        fs.writeFileSync(descriptor, data);
      } finally {
        fs.closeSync(descriptor);
      }
    },
  };
  const write = new vm.Script(`(${writerSource})`).runInNewContext({
    fs: instrumented, manifestPath, manifest: { counter: 1 }, randomUUID, process,
  });
  write();
  assert.deepEqual(observed, { counter: 0 });
  assert.deepEqual(JSON.parse(fs.readFileSync(manifestPath, 'utf8')), { counter: 1 });
  assert.deepEqual(fs.readdirSync(directory), ['manifest.json']);
});

test('independent concurrent readers observe complete JSON throughout 500 actual publications', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'paircoach-manifest-concurrent-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const manifestPath = path.join(directory, 'manifest.json');
  fs.writeFileSync(manifestPath, JSON.stringify({ counter: -1, payload: 'x'.repeat(4096) }));
  const shared = new SharedArrayBuffer(4);
  const control = new Int32Array(shared);
  const worker = new Worker(`
    const fs = require('node:fs');
    const vm = require('node:vm');
    const { randomUUID } = require('node:crypto');
    const { parentPort, workerData } = require('node:worker_threads');
    const control = new Int32Array(workerData.shared);
    const manifest = { counter: 0, payload: 'x'.repeat(4096) };
    const write = new vm.Script('(' + workerData.writerSource + ')').runInNewContext({
      fs, randomUUID, manifest, manifestPath: workerData.manifestPath, process,
    });
    parentPort.postMessage('ready');
    Atomics.wait(control, 0, 0);
    try {
      for (let counter = 0; counter < 500; counter++) { manifest.counter = counter; write(); }
    } finally { Atomics.store(control, 0, 2); }
  `, { eval: true, workerData: { shared, writerSource, manifestPath } });
  const exited = new Promise<number>(resolve => worker.once('exit', resolve));
  let workerError: Error | undefined;
  worker.on('error', error => { workerError = error; Atomics.store(control, 0, 2); });
  await new Promise<void>((resolve, reject) => {
    worker.once('message', () => resolve());
    worker.once('error', reject);
  });
  Atomics.store(control, 0, 1);
  Atomics.notify(control, 0);
  let reads = 0, incomplete = 0;
  const deadline = Date.now() + 10000;
  while (Atomics.load(control, 0) !== 2 && Date.now() < deadline) {
    try {
      const value = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      assert.equal(value.payload.length, 4096);
    } catch { incomplete++; }
    reads++;
  }
  if (Atomics.load(control, 0) !== 2) await worker.terminate();
  const exitCode = await exited;
  assert.ifError(workerError);
  assert.equal(exitCode, 0);
  assert.ok(reads > 0);
  assert.equal(incomplete, 0);
  assert.equal(JSON.parse(fs.readFileSync(manifestPath, 'utf8')).counter, 499);
  t.diagnostic(`${reads} concurrent reads, ${incomplete} incomplete observations`);
});

for (const code of ['EPERM', 'EIO']) {
  test(`actual publisher handles ${code} with bounded Windows sharing recovery`, t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'paircoach-manifest-sharing-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const manifestPath = path.join(directory, 'manifest.json');
    fs.writeFileSync(manifestPath, JSON.stringify({ counter: 0 }));
    let attempts = 0;
    const failure = Object.assign(new Error('Injected filesystem boundary'), { code });
    const instrumented = {
      ...fs,
      renameSync(from: string, to: string) {
        attempts++;
        if (attempts <= 2) throw failure;
        fs.renameSync(from, to);
      },
    };
    const write = new vm.Script(`(${writerSource})`).runInNewContext({
      fs: instrumented, manifestPath, manifest: { counter: 1 }, randomUUID, process: { platform: 'win32' },
    });
    if (code === 'EPERM') {
      write();
      assert.equal(attempts, 3);
      assert.equal(JSON.parse(fs.readFileSync(manifestPath, 'utf8')).counter, 1);
    } else {
      assert.throws(write, error => error === failure);
      assert.equal(attempts, 1);
      assert.equal(JSON.parse(fs.readFileSync(manifestPath, 'utf8')).counter, 0);
    }
  });
}
