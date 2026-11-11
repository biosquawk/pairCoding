import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SettingsV2Store, type SettingsTransactionAuthority } from '../../src/server/settings-v2';

// Real WSL files/links, stripping ONLY O_NOFOLLOW. This is NOT native Win32 proof.
const authority: SettingsTransactionAuthority = {
  async transact() { throw Error('Unexpected mutation'); },
  async reconcile() { throw Error('Unexpected recovery'); },
};
const original = JSON.stringify({ schemaVersion: 2, taskFilePath: null, taskMode: 'IMPLEMENTATION', reviewNotesPath: 'review.md', runProfiles: [], aiConsent: false, contextPatterns: [] });
function fixture(t: TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'settings-identity-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'settings.json'), retained = path.join(root, 'retained.json');
  fs.writeFileSync(file, original);
  return { file, retained, read: () => new SettingsV2Store({ settingsPath: file, authority }).read() };
}
function withoutNoFollow(t: TestContext, file: string, around?: (open: () => number) => number) {
  const open = fs.openSync;
  t.mock.method(fs, 'openSync', (p: fs.PathLike, flags: string | number, mode?: fs.Mode) => {
    const invoke = () => open(p, typeof flags === 'number' ? flags & ~(fs.constants.O_NOFOLLOW ?? 0) : flags, mode);
    return p === file && typeof flags === 'number' && (flags & (fs.constants.O_WRONLY | fs.constants.O_RDWR)) === 0 && around ? around(invoke) : invoke();
  });
}
function preserve(f: ReturnType<typeof fixture>) { assert.equal(fs.readFileSync(f.retained, 'utf8'), original); }

test('settings: regular reads and genuinely missing source work without O_NOFOLLOW', t => {
  const f = fixture(t); withoutNoFollow(t, f.file);
  assert.equal(f.read().kind, 'V2'); assert.equal(fs.readFileSync(f.file, 'utf8'), original);
  fs.unlinkSync(f.file); assert.equal(f.read().exists, false);
});
for (const dangling of [false, true]) test(`settings: reject ${dangling ? 'dangling' : 'real'} final symlink without O_NOFOLLOW`, t => {
  const f = fixture(t); fs.renameSync(f.file, f.retained); fs.symlinkSync(dangling ? f.retained + '-missing' : f.retained, f.file);
  withoutNoFollow(t, f.file); assert.throws(f.read); preserve(f);
});
for (const stage of ['before-open', 'after-open', 'during-read'] as const) {
  for (const replacement of ['regular', 'symlink'] as const) test(`settings: reject ${replacement} substitution ${stage} even with identical bytes`, t => {
    const f = fixture(t);
    const swap = () => { fs.renameSync(f.file, f.retained); if (replacement === 'symlink') fs.symlinkSync(f.retained, f.file); else fs.writeFileSync(f.file, original); };
    let fd: number | undefined;
    withoutNoFollow(t, f.file, open => { if (stage === 'before-open') swap(); fd = open(); if (stage === 'after-open') swap(); return fd; });
    if (stage === 'during-read') {
      const read = fs.readSync; let fired = false;
      t.mock.method(fs, 'readSync', (...args: Parameters<typeof fs.readSync>) => { const count = Reflect.apply(read, fs, args); if (args[0] === fd && !fired) { fired = true; swap(); } return count; });
      // Original1645 uses readFileSync(fd), which also traverses fs.readSync.
    }
    assert.throws(f.read); preserve(f);
  });
}
test('settings: disappearance at open is a race, not a missing-source result', t => {
  const f = fixture(t); withoutNoFollow(t, f.file, open => { fs.renameSync(f.file, f.retained); return open(); });
  assert.throws(f.read); preserve(f);
});
for (const field of ['dev', 'ino'] as const) for (const phase of ['opened', 'post-read'] as const) {
  test(`settings: exact adjacent bigint ${field} mismatch at ${phase} fails closed`, t => {
    const f = fixture(t); withoutNoFollow(t, f.file);
    const lstat = fs.lstatSync, fstat = fs.fstatSync; let calls = 0; const bigintOptions: boolean[] = [];
    const base = 2n ** 60n;
    t.mock.method(fs, 'lstatSync', (...args: Parameters<typeof fs.lstatSync>) => {
      const s = Reflect.apply(lstat, fs, args);
      if (args[0] === f.file) { bigintOptions.push((args[1] as { bigint?: boolean })?.bigint === true); return Object.assign(Object.create(s!), { [field]: base }); }
      return s;
    });
    t.mock.method(fs, 'fstatSync', (...args: Parameters<typeof fs.fstatSync>) => {
      const s = Reflect.apply(fstat, fs, args); bigintOptions.push((args[1] as { bigint?: boolean })?.bigint === true);
      calls++; return Object.assign(Object.create(s!), { [field]: base + (phase === 'opened' || calls > 1 ? 1n : 0n) });
    });
    assert.throws(f.read); assert.ok(bigintOptions.length >= 2 && bigintOptions.every(Boolean)); assert.equal(fs.readFileSync(f.file, 'utf8'), original);
  });
}
test('settings: non-regular and oversized input are rejected before reading bytes', t => {
  const f = fixture(t); withoutNoFollow(t, f.file);
  fs.unlinkSync(f.file); fs.mkdirSync(f.file); assert.throws(f.read);
  fs.rmdirSync(f.file); fs.writeFileSync(f.file, Buffer.alloc(4 * 1024 * 1024 + 1)); assert.throws(f.read);
});
test('settings: short regular reads still succeed without O_NOFOLLOW', t => {
  const f = fixture(t); let fd: number | undefined; withoutNoFollow(t, f.file, open => (fd = open()));
  const read = fs.readSync;
  t.mock.method(fs, 'readSync', (handle: number, buffer: Buffer, offset: number, length: number, position: number | null) => read(handle, buffer, offset, handle === fd ? Math.min(length, 7) : length, position));
  assert.equal(f.read().kind, 'V2');
});
test('settings: growth during read is rejected with IO bounded to observed size + one', t => {
  const f = fixture(t); let fd: number | undefined; withoutNoFollow(t, f.file, open => (fd = open()));
  const read = fs.readSync; let fired = false, requested = 0;
  t.mock.method(fs, 'readSync', (handle: number, buffer: Buffer, offset: number, length: number, position: number | null) => {
    if (handle === fd) { requested += length; if (!fired) { fired = true; fs.appendFileSync(f.file, ' '.repeat(4 * 1024 * 1024)); } }
    return read(handle, buffer, offset, length, position);
  });
  assert.throws(f.read); assert.equal(fired, true); assert.ok(requested <= Buffer.byteLength(original) + 1);
});
