// Pure local construction/validation tests, explicitly NOT Docker/LIVE evidence.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { validateLock, createArgs, assertOwned, assertStopped, inputFiles, commandFor, snapshot, markerName, WORK } from './runtime-spike.mjs';
const lock = JSON.parse(readFileSync(new URL('./images.lock.json', import.meta.url)));
const nonce = '11111111-1111-1111-1111-111111111111', imageId = 'sha256:' + 'a'.repeat(64);
const spec = { name: `paircoach-spike-p1-runtime-${nonce}-java21`, nonce, imageId, input: '/own/Zażółć space 😀/input', output: '/own/out', command: commandFor('java21') };
const copy = x => structuredClone(x);
test('real lock requires each fixed profile and immutable official digest', () => {
  assert.equal(validateLock(copy(lock)).profiles.length, 3);
  for (const value of ['latest', 'eclipse-temurin:27-jdk', 'attacker@sha256:' + 'a'.repeat(64)]) {
    const invalid = copy(lock); invalid.profiles[0].ref = value; assert.throws(() => validateLock(invalid));
  }
  const wrong = copy(lock); wrong.profiles[1].expectedVersion = 21; assert.throws(() => validateLock(wrong));
});
test('runtime flags are pinned, nonroot, offline, readonly input and bounded', () => {
  const args = createArgs(spec), joined = args.join(' ');
  for (const required of ['--pull=never', '--user', '10001:10001', '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges', '--memory=512m', '--cpus=1', '--pids-limit=96', '--network=none', '--log-opt=max-size=10m', '--log-opt=max-file=1']) assert(args.includes(required));
  assert(args.includes('type=bind,src=/own/Zażółć space 😀/input,dst=/input,readonly'));
  assert(!/--privileged|docker.sock|\.m2|--rm|--env-file/.test(joined));
  assert(args.includes('paircoach.work=' + WORK)); assert(args.includes('paircoach.nonce=' + nonce));
  assert(args.includes(imageId));
});
test('mount option injection and arbitrary identity rejected; native drive path preserved', () => {
  for (const input of ['/own/a,readonly=false', '/own/a\n--privileged']) assert.throws(() => createArgs({ ...spec, input }));
  assert.throws(() => createArgs({ ...spec, name: 'unrelated-container' }));
  assert.throws(() => createArgs({ ...spec, imageId: 'python:latest' }));
  assert(createArgs({ ...spec, input: 'C:\\own space\\Zażółć 😀\\input' }).includes('type=bind,src=C:\\own space\\Zażółć 😀\\input,dst=/input,readonly'));
});
test('Stop evidence must independently confirm Docker stopped state', () => {
  assertStopped({ State: { Running: false, Status: 'exited' } });
  for (const State of [{ Running: true, Status: 'running' }, { Running: false, Status: 'created' }]) assert.throws(() => assertStopped({ State }));
});
test('ownership requires exact ID/name/image plus work AND nonce labels', () => {
  const rec = { id: 'b'.repeat(64), name: spec.name, imageId };
  const info = { Id: rec.id, Name: '/' + rec.name, Image: imageId, Config: { Labels: { 'paircoach.work': WORK, 'paircoach.nonce': nonce } } };
  assertOwned(info, rec, nonce);
  for (const key of ['Id', 'Name', 'Image']) { const bad = copy(info); bad[key] += 'wrong'; assert.throws(() => assertOwned(bad, rec, nonce)); }
  for (const key of ['paircoach.work', 'paircoach.nonce']) { const bad = copy(info); delete bad.Config.Labels[key]; assert.throws(() => assertOwned(bad, rec, nonce)); }
});
test('release/API probes have both positive and older-release rejection branches', () => {
  assert.match(inputFiles('java21')['Main.java'], /SequencedCollection/);
  assert.match(inputFiles('java27')['Main.java'], /ScopedValue/);
  assert.match(commandFor('java21').join(' '), /--release 17.*--release 21/s);
  assert.match(commandFor('java27').join(' '), /--release 21.*--release 27/s);
  for (const id of ['java21', 'java27', 'python313']) assert(Object.hasOwn(inputFiles(id), markerName));
  assert.match(inputFiles('python313')['main.py'], /\(3,13\)/);
});
test('input hashing detects mutation and refuses symlinks', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'paircoach-spike-selftest-'));
  try {
    writeFileSync(path.join(dir, markerName), 'before'); const before = snapshot(dir);
    writeFileSync(path.join(dir, markerName), 'after'); assert.notDeepEqual(snapshot(dir), before);
    // This local test is for Unix harness verification; native symlink permissions differ.
    if (process.platform !== 'win32') { symlinkSync('/not-read', path.join(dir, 'link')); assert.throws(() => snapshot(dir)); }
  } finally { rmSync(dir, { recursive: true }); } // only mkdtemp-owned synthetic data
});
test('collection and persisted state precede rm; SIGTERM-ignoring Stop requires137', () => {
  const src = readFileSync(new URL('./runtime-spike.mjs', import.meta.url), 'utf8');
  assert.match(src, /assert\(rec.artifactsCollected && rec.stateDurableAt/);
  assert.match(src, /signal\.SIGTERM,signal\.SIG_IGN/);
  assert.match(src, /ExitCode, 137/);
  assert(!src.includes("['rm', '-f'"));
});
