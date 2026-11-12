/** Native error/Win32 ABI control simulations on WSL ONLY. No native Windows lock proof. */
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { fixture } from './fixtures';
const require = createRequire(import.meta.url), koffi = require('koffi');
function platform(value: string) {
  const old = Object.getOwnPropertyDescriptor(process, 'platform')!;
  Object.defineProperty(process, 'platform', { value, configurable: true });
  return () => Object.defineProperty(process, 'platform', old);
}
function restore() { mock.restoreAll(); syncBuiltinESMExports(); }
const fail = (code: string) => Object.assign(new Error(code), { code });

for (const failure of ['library', 'symbol', 'EIO', 'EAGAIN'] as const) test(`UNIT native ${failure}: no mutation/fallback; lease release permits later real native update`, async () => {
  const f = await fixture();
  try {
    await f.executor.start(f.plan);
    const record = await f.journal.read('run1'), before = structuredClone(record);
    const file = path.join(f.journal.directory, '.transaction-lock'), inode = await fs.lstat(file, { bigint: true });
    mock.method(koffi, 'load', () => {
      if (failure === 'library') throw Error('missing native library');
      return { func: () => { if (failure === 'symbol') throw Error('missing native symbol'); return () => -1; } };
    });
    if (failure === 'EIO' || failure === 'EAGAIN') mock.method(koffi, 'errno', () => koffi.os.errno[failure]);
    await assert.rejects(f.journal.update(record), { code: failure === 'EAGAIN' ? 'EEXIST' : failure === 'EIO' ? 'JOURNAL_LOCK_FAILED' : 'JOURNAL_LOCK_UNAVAILABLE' });
    assert.deepEqual(await f.journal.read('run1'), before);
    assert.equal((await fs.lstat(file, { bigint: true })).ino, inode.ino);
    restore();
    await f.journal.update(record);
    assert.equal((await f.journal.read('run1')).revision, before.revision + 1);
  } finally { restore(); await f.cleanup(); }
});

for (const kind of ['symlink', 'hardlink', 'directory', 'unknown-marker'] as const) test(`UNIT anchor ${kind}: refuse without deleting/adopting foreign identity`, async () => {
  const f = await fixture();
  try {
    await f.executor.start(f.plan);
    const record = await f.journal.read('run1');
    const file = path.join(f.journal.directory, '.transaction-lock'), other = path.join(f.root, 'foreign-marker');
    await fs.rename(file, other); // Test fixture only; product never unlinks/replaces its stable anchor.
    if (kind === 'symlink') await fs.symlink(other, file);
    if (kind === 'hardlink') await fs.link(other, file);
    if (kind === 'directory') await fs.mkdir(file);
    if (kind === 'unknown-marker') await fs.writeFile(file, 'UNKNOWN');
    const before = await fs.lstat(file, { bigint: true });
    await assert.rejects(f.journal.update(record));
    assert.equal((await fs.lstat(file, { bigint: true })).ino, before.ino);
    assert.deepEqual(await f.journal.read('run1'), record);
    assert.ok((await fs.readFile(other, 'utf8')).startsWith('PairCoach'));
  } finally { await f.cleanup(); }
});

test('UNIT unsupported platform: visible native-unavailable failure, no in-memory/filesentinel fallback', async () => {
  const f = await fixture(); let undo = () => {};
  try {
    await f.executor.start(f.plan);
    const row = await f.journal.read('run1');
    undo = platform('darwin');
    await assert.rejects(f.journal.update(row), { code: 'JOURNAL_LOCK_UNAVAILABLE' });
    assert.deepEqual(await f.journal.read('run1'), row);
  } finally { undo(); await f.cleanup(); }
});

for (const behavior of ['ok', 'busy', 'access-denied', 'readback-failed', 'close-failed'] as const) test(`UNIT Win32 CreateFileW ${behavior}: exact exclusive-writer flags, readback/close errors never forged success`, async () => {
  const f = await fixture(); let undo = () => {};
  const oldRoot = process.env.SystemRoot;
  try {
    await f.executor.start(f.plan);
    const row = await f.journal.read('run1'), initialRevision = row.revision;
    let opens = 0, closes = 0, acquired = false;
    const file = path.join(f.journal.directory, '.transaction-lock');
    mock.method(koffi, 'load', (library: string) => {
      assert.equal(library, path.join('/unit-systemroot', 'System32', 'kernel32.dll'));
      return { func: (abi: string, name: string, result: string, args: string[]) => {
        assert.equal(abi, '__stdcall');
        if (name === 'CreateFileW') {
          assert.equal(result, 'intptr_t'); assert.deepEqual(args, ['str16', 'uint32', 'uint32', 'void *', 'uint32', 'uint32', 'intptr_t']);
          return (...values: any[]) => {
            opens++;
            assert.deepEqual(values, [path.toNamespacedPath(file), 0xC0000000, 1, null, 3, 0x00200000, 0]);
            if (behavior === 'busy' || behavior === 'access-denied') return -1;
            acquired = true; return 101;
          };
        }
        if (name === 'CloseHandle') return (handle: any) => { assert.equal(handle, 101); closes++; acquired = false; return behavior === 'close-failed' ? 0 : 1; };
        if (name === 'GetLastError') return () => behavior === 'busy' ? 32 : 5;
        throw Error('Unexpected Win32 symbol ' + name);
      } };
    });
    const lstat = fs.lstat.bind(fs);
    if (behavior === 'readback-failed') mock.method(fs, 'lstat', async (name: any, ...args: any[]) => {
      if (name === file && acquired) throw fail('EIO');
      return (lstat as any)(name, ...args);
    });
    syncBuiltinESMExports();
    process.env.SystemRoot = '/unit-systemroot'; undo = platform('win32');
    if (behavior === 'ok') await f.journal.update(row);
    else await assert.rejects(f.journal.update(row), { code: behavior === 'busy' ? 'EEXIST' : behavior === 'access-denied' ? 'JOURNAL_LOCK_FAILED' : behavior === 'readback-failed' ? 'EIO' : 'JOURNAL_LOCK_RELEASE_FAILED' });
    assert.equal(opens, 1); assert.equal(closes, behavior === 'busy' || behavior === 'access-denied' ? 0 : 1);
    assert.equal((await f.journal.read('run1')).revision, initialRevision + (behavior === 'ok' || behavior === 'close-failed' ? 1 : 0), 'release failure preserves actual committed state, never auto-replays');
  } finally {
    undo(); restore();
    if (oldRoot === undefined) delete process.env.SystemRoot; else process.env.SystemRoot = oldRoot;
    await f.cleanup();
  }
});

test('UNIT native-lock opened inode adjacent above 2^60 is not aliased to the named marker; failure closes lease', async () => {
  const f = await fixture();
  try {
    await f.executor.start(f.plan);
    const row = await f.journal.read('run1'), file = path.join(f.journal.directory, '.transaction-lock');
    const open = fs.open.bind(fs), lstat = fs.lstat.bind(fs);
    const a = 2n ** 60n, b = a + 1n;
    assert.equal(Number(a), Number(b), 'metadata simulation, not native inode allocation');
    const inode = (st: any, ino: bigint) => Object.assign(Object.create(Object.getPrototypeOf(st)), st, { ino });
    mock.method(fs, 'lstat', async (name: any, options: any) => {
      const st = await lstat(name, options);
      return name === file && options?.bigint ? inode(st, a) : st;
    });
    mock.method(fs, 'open', async (name: any, ...args: any[]) => {
      const fd = await (open as any)(name, ...args);
      if (name === file) {
        const stat = fd.stat.bind(fd);
        mock.method(fd, 'stat', async (options: any) => inode(await stat(options), typeof args[0] === 'number' && (args[0] & 3) === 2 ? b : a));
      }
      return fd;
    });
    syncBuiltinESMExports();
    await assert.rejects(f.journal.update(row), /lock identity changed/);
    assert.deepEqual(await f.journal.read('run1'), row);
    restore();
    await f.journal.update(row);
  } finally { restore(); await f.cleanup(); }
});
