/** Real WriteGate + accepted executor raw inventory/copy; no Docker/task process/native claim. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { coreFixture } from '../qa/helpers';
import { readRunSourceInventory, copyAcknowledgedInput, verifyAcknowledgedInput } from '../../src/server/execution/ImmutableInput';
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const auth = (f: Awaited<ReturnType<typeof coreFixture>>) => ({ clientId: f.clientId, sessionId: f.sessionId, controlEpoch: f.session.state.controlEpoch, actor: 'STUDENT' as const });
function runs(t: test.TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'actual-gate-copy-'));
  function unlock(p: string) { const s = fs.lstatSync(p); if (s.isDirectory()) { fs.chmodSync(p, 0o700); for (const f of fs.readdirSync(p)) unlock(path.join(p, f)); } }
  t.after(() => { unlock(root); fs.rmSync(root, { recursive: true, force: true }); }); return root;
}
const request = (f: Awaited<ReturnType<typeof coreFixture>>, root: string) => ({ ...auth(f), runId: 'actual-run', profileId: 'javascript-node', configurationGeneration: 'actual-config', expectedWorkspaceVersion: f.workspace.workspaceVersion, runDirectory: path.join(root, 'actual-run') });

test('SEAM actual source projection+gate-held copy preserve authoritative versions/raw BOM CRLF and later draft independence', async t => {
  const f = await coreFixture(t, { 'main.js': Buffer.from('\ufeffconsole.log(1);\r\n'), 'package.json': '{}\r\n', 'zażółć 😀.txt': 'source\r\n', '.env': 'TOKEN=never-copy' }), root = runs(t);
  fs.mkdirSync(path.join(f.rootPath, 'target')); fs.writeFileSync(path.join(f.rootPath, 'target', 'stale.xml'), 'old');
  const first = f.workspace.getDocument('main.js');
  const saved = await f.gate.writeAsync({ ...auth(f), path: 'main.js', baseVersion: first.version, content: 'console.log(2);\n' });
  const raw = fs.readFileSync(path.join(f.rootPath, 'main.js'));
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>(r => { enter = r; }), wait = new Promise<void>(r => { release = r; });
  const capture = f.gate.captureRun(request(f, root), { inventory: readRunSourceInventory, copy: options => copyAcknowledgedInput({ ...options, afterFileCopied: async p => { if (p === 'main.js') { enter(); await wait; } } }) });
  await Promise.race([entered, capture.then(() => { throw Error('copy finished before barrier'); })]);
  assert.throws(() => f.gate.write({ ...auth(f), path: 'main.js', baseVersion: saved.version, content: 'leapfrog' }), { code: 'WORKSPACE_BUSY' });
  const later = f.gate.writeAsync({ ...auth(f), path: 'main.js', baseVersion: saved.version, content: 'later draft\n' });
  release(); const input = await capture; await later;
  const main = input.files.find(f => f.path === 'main.js')!;
  assert.equal(main.documentVersion, saved.version); assert.equal(main.sha256, sha(raw)); assert.equal(main.bytes, raw.length);
  assert.notEqual(main.sha256, saved.contentHash);
  assert.deepEqual(fs.readFileSync(path.join(input.immutableDirectory, 'main.js')), raw);
  assert.equal(f.workspace.getDocument('main.js').content, 'later draft\n');
  assert.ok(!input.files.some(f => f.path === '.env' || f.path.startsWith('target/')));
  assert.deepEqual(fs.readdirSync(input.buildDirectory), []); assert.deepEqual(fs.readdirSync(input.artifactsDirectory), []);
  await verifyAcknowledgedInput(input);
});

test('SEAM actual raw inventory catches external dependency edit DURING copy and never publishes input manifest', async t => {
  const f = await coreFixture(t, { 'main.js': 'console.log(1);\n', 'package.json': '{}\r\n' }), root = runs(t);
  await assert.rejects(f.gate.captureRun(request(f, root), { inventory: readRunSourceInventory, copy: options => copyAcknowledgedInput({ ...options, afterFileCopied: async p => {
    if (p === 'main.js') fs.writeFileSync(path.join(f.rootPath, 'package.json'), '{"dependency":"changed"}\n');
  } }) }));
  assert.ok(!fs.existsSync(path.join(root, 'actual-run', 'input-manifest.json')));
  assert.equal(fs.readFileSync(path.join(f.rootPath, 'main.js'), 'utf8'), 'console.log(1);\n');
});

test('SEAM jointly excluded private dependency directory is never assigned fabricated documentVersion0', async t => {
  const f = await coreFixture(t, { 'main.js': 'x\n' }), root = runs(t);
  fs.mkdirSync(path.join(f.rootPath, '.venv')); fs.writeFileSync(path.join(f.rootPath, '.venv', 'x.py'), 'secret-ish');
  // .venv is excluded by BOTH actual policies, so it remains absent, not fabricated version0.
  const input = await f.gate.captureRun(request(f, root), { inventory: readRunSourceInventory, copy: copyAcknowledgedInput });
  assert.ok(input.files.every(file => file.documentVersion > 0 && !file.path.startsWith('.venv/')));
});
