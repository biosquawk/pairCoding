/** Controlled UNIT metadata/platform simulations on Linux. NOT native Win32/Docker proof. */
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import * as path from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import { canonicalDirectory, durableWrite, fsyncDirectory, readRegular } from '../../src/server/execution/files';
import { DurableRunJournal } from '../../src/server/execution/DurableRunJournal';
import { validateApprovedCaches } from '../../src/server/execution/PlanPolicy';
import { verifyAcknowledgedInput } from '../../src/server/execution/ImmutableInput';
import { fixture } from './fixtures';

const error = (code: string) => Object.assign(new Error(code), { code });
function platform(value: string) {
  const original = Object.getOwnPropertyDescriptor(process, 'platform')!;
  Object.defineProperty(process, 'platform', { value, configurable: true });
  return () => Object.defineProperty(process, 'platform', original);
}
function restore() { mock.restoreAll(); syncBuiltinESMExports(); }
function metadata(st: any, options: any, changes: Record<string, bigint>) {
  const result: any = { ...st, ...changes,
    isFile: () => st.isFile(), isDirectory: () => st.isDirectory(), isSymbolicLink: () => st.isSymbolicLink() };
  if (!options?.bigint) for (const key of Object.keys(result)) if (typeof result[key] === 'bigint') result[key] = Number(result[key]);
  return result;
}

test('UNIT Win32 policy: Journal + cache + sealed copy use canonical private ancestry, not synthetic POSIX bits', async () => {
  const f = await fixture();
  const undo = platform('win32');
  const lstat = fs.lstat.bind(fs), stat = fs.stat.bind(fs);
  mock.method(fs, 'lstat', async (file: any, options: any) => {
    const st = await lstat(file, { bigint: true });
    return metadata(st, options, { mode: st.isDirectory() ? 0o40666n : st.mode });
  });
  mock.method(fs, 'stat', async (file: any, options: any) => {
    const st = await stat(file, { bigint: true });
    return metadata(st, options, { mode: st.isDirectory() ? 0o40666n : st.mode });
  });
  syncBuiltinESMExports();
  try {
    await new DurableRunJournal(path.join(f.root, 'win-journal'), 'unit').initialize();
    await validateApprovedCaches(f.policy, f.policy.runtimes[0]);
    await verifyAcknowledgedInput(f.input);
    const copy = await f.copy('win-copy'); // Actual independent FS bytes; platform/stat behavior controlled only.
    await verifyAcknowledgedInput(copy);
    const copiedFile = path.join(copy.immutableDirectory, 'main.js');
    await fs.chmod(copiedFile, 0o600);
    await fs.writeFile(copiedFile, 'tampered');
    await assert.rejects(verifyAcknowledgedInput(copy), /Immutable input changed/);
  } finally { restore(); undo(); await f.cleanup(); }
});

test('UNIT POSIX: writable journal/cache and unsealed input remain rejected', async () => {
  const f = await fixture();
  try {
    const journal = path.join(f.root, 'public-journal');
    await fs.mkdir(journal, { mode: 0o755 });
    await fs.chmod(journal, 0o755); // Explicit despite restrictive worker umask.
    await assert.rejects(new DurableRunJournal(journal, 'unit').initialize(), /private/);
    await fs.chmod(f.policy.managedCacheRoot!, 0o755);
    await assert.rejects(validateApprovedCaches(f.policy, f.policy.runtimes[0]), /private/);
    await fs.chmod(f.input.immutableDirectory, 0o755);
    await assert.rejects(verifyAcknowledgedInput(f.input), /sealed/);
  } finally { await f.cleanup(); }
});

test('UNIT ancestry: reject observed symlink component even if final realpath claims canonical; no child created', async () => {
  const f = await fixture();
  const link = path.join(f.root, 'alias');
  const realpath = fs.realpath.bind(fs);
  try {
    await fs.mkdir(path.join(f.runs, 'legit'));
    await fs.symlink(f.runs, link, 'dir');
    mock.method(fs, 'realpath', async (file: any) => String(file).startsWith(link) ? file : realpath(file));
    syncBuiltinESMExports();
    await assert.rejects(canonicalDirectory(path.join(link, 'legit')), /directory|ancestry|canonical/i);
    await assert.rejects(new DurableRunJournal(path.join(link, 'legit', 'child'), 'unit').initialize());
    await assert.rejects(fs.lstat(path.join(f.runs, 'legit', 'child')), { code: 'ENOENT' });
  } finally { restore(); await f.cleanup(); }
});

for (const code of ['EPERM', 'EACCES', 'EINVAL', 'EISDIR', 'EBADF', 'EIO']) {
  for (const where of ['open', 'sync'] as const) {
    test(`UNIT directory ${where} ${code}: only Win32 documented unsupported codes tolerated`, async () => {
      const f = await fixture();
      const open = fs.open.bind(fs);
      let closes = 0;
      mock.method(fs, 'open', async (file: any, ...args: any[]) => {
        if (file !== f.root) return (open as any)(file, ...args);
        if (where === 'open') throw error(code);
        return { sync: async () => { throw error(code); }, close: async () => { closes++; } };
      });
      syncBuiltinESMExports();
      const undoWin = platform('win32');
      try {
        if (code === 'EIO') await assert.rejects(fsyncDirectory(f.root), { code });
        else await fsyncDirectory(f.root);
      } finally { undoWin(); }
      const undoPosix = platform('linux');
      try { await assert.rejects(fsyncDirectory(f.root), { code }); }
      finally { undoPosix(); restore(); await f.cleanup(); }
      assert.equal(closes, where === 'sync' ? 2 : 0);
    });
  }
}

test('UNIT directory close EPERM is NOT suppressed on Win32', async () => {
  const f = await fixture(), undo = platform('win32');
  const open = fs.open.bind(fs);
  mock.method(fs, 'open', async (file: any, ...args: any[]) => file === f.root
    ? { sync: async () => {}, close: async () => { throw error('EPERM'); } }
    : (open as any)(file, ...args));
  syncBuiltinESMExports();
  try { await assert.rejects(fsyncDirectory(f.root), { code: 'EPERM' }); }
  finally { restore(); undo(); await f.cleanup(); }
});

for (const phase of ['sync', 'close', 'rename', 'readback'] as const) test(`UNIT regular publication ${phase} EPERM propagates on Win32`, async () => {
  const f = await fixture(), undo = platform('win32');
  const target = path.join(f.root, 'receipt.json'), open = fs.open.bind(fs);
  if (phase === 'rename') mock.method(fs, 'rename', async () => { throw error('EPERM'); });
  else if (phase === 'readback') {
    const lstat = fs.lstat.bind(fs);
    mock.method(fs, 'lstat', async (file: any, ...args: any[]) => {
      if (file === target) throw error('EPERM');
      return (lstat as any)(file, ...args);
    });
  } else mock.method(fs, 'open', async (file: any, ...args: any[]) => {
    const fd = await (open as any)(file, ...args);
    if (String(file).startsWith(target + '.')) {
      if (phase === 'sync') mock.method(fd, 'sync', async () => { throw error('EPERM'); });
      else { const close = fd.close.bind(fd); mock.method(fd, 'close', async () => { await close(); throw error('EPERM'); }); }
    }
    return fd;
  });
  syncBuiltinESMExports();
  try { await assert.rejects(durableWrite(target, 'retained'), { code: 'EPERM' }); }
  finally { restore(); undo(); await f.cleanup(); }
});

for (const field of ['ino', 'dev', 'mtimeNs', 'ctimeNs']) {
  for (const stage of ['open', 'post-read', 'final-name']) test(`UNIT BigInt ${field} adjacent 2^60 identities: ${stage} swap rejected`, async () => {
    const f = await fixture(), file = path.join(f.workspace, 'main.js');
    const lstat = fs.lstat.bind(fs), open = fs.open.bind(fs);
    let stats = 0;
    const a = 2n ** 60n, b = a + 1n;
    assert.equal(Number(a), Number(b), 'controlled metadata explicitly aliases as Number, not native allocation');
    mock.method(fs, 'lstat', async (name: any, options: any) => {
      const st = await lstat(name, { bigint: true });
      if (name !== file) return options?.bigint ? st : lstat(name);
      return metadata(st, options, { [field]: stage === 'final-name' && stats > 0 ? b : a });
    });
    mock.method(fs, 'open', async (name: any, ...args: any[]) => {
      const fd = await (open as any)(name, ...args);
      if (name === file) {
        const stat = fd.stat.bind(fd);
        mock.method(fd, 'stat', async (options: any) => {
          const st = await stat({ bigint: true });
          stats++;
          return metadata(st, options, { [field]: stage === 'open' || stage === 'post-read' && stats > 1 ? b : a });
        });
      }
      return fd;
    });
    syncBuiltinESMExports();
    try { await assert.rejects(readRegular(file, 1024), /changed/i); }
    finally { restore(); await f.cleanup(); }
  });
}

for (const field of ['ino', 'dev', 'mtimeNs', 'ctimeNs']) test(`UNIT input inventory: adjacent BigInt directory ${field} mutation invalidates copy`, async () => {
  const f = await fixture(), lstat = fs.lstat.bind(fs), readdir = fs.readdir.bind(fs);
  let changed = false;
  mock.method(fs, 'lstat', async (name: any, options: any) => {
    const st = await lstat(name, { bigint: true });
    if (name !== f.workspace) return options?.bigint ? st : lstat(name);
    return metadata(st, options, { [field]: 2n ** 60n + (changed ? 1n : 0n) });
  });
  mock.method(fs, 'readdir', async (name: any, ...args: any[]) => {
    const entries = await (readdir as any)(name, ...args);
    if (name === f.workspace) changed = true;
    return entries;
  });
  syncBuiltinESMExports();
  try { await assert.rejects(f.copy('inventory-race'), /Input directory changed/); }
  finally { restore(); await f.cleanup(); }
});

test('UNIT bounded read: detect growth beyond initial size even with controlled unchanged metadata', async () => {
  const f = await fixture(), file = path.join(f.workspace, 'main.js'), open = fs.open.bind(fs);
  mock.method(fs, 'open', async (name: any, ...args: any[]) => {
    const fd = await (open as any)(name, ...args);
    if (name === file) {
      const read = fd.read.bind(fd);
      mock.method(fd, 'read', async (buffer: Buffer, offset: number, length: number, position: number) => {
        const r = await read(buffer, offset, length, position);
        if (r.bytesRead === 0 && length > 0) { buffer[offset] = 120; return { bytesRead: 1, buffer }; }
        return r;
      });
    }
    return fd;
  });
  syncBuiltinESMExports();
  try { await assert.rejects(readRegular(file, 1024), /changed|oversized/i); }
  finally { restore(); await f.cleanup(); }
});


test('UNIT unchanged exact large BigInt identity succeeds; initial symlink never opened', async () => {
  const f = await fixture(), file = path.join(f.workspace, 'main.js');
  const lstat = fs.lstat.bind(fs), open = fs.open.bind(fs);
  let opened = 0;
  const changes = { dev: 2n ** 60n, ino: 2n ** 60n + 1n };
  mock.method(fs, 'lstat', async (name: any, options: any) => {
    const st = await lstat(name, { bigint: true });
    return name === file ? metadata(st, options, changes) : options?.bigint ? st : lstat(name);
  });
  mock.method(fs, 'open', async (name: any, ...args: any[]) => {
    const fd = await (open as any)(name, ...args);
    if (name === file) {
      opened++;
      const stat = fd.stat.bind(fd);
      mock.method(fd, 'stat', async (options: any) => metadata(await stat({ bigint: true }), options, changes));
    }
    return fd;
  });
  syncBuiltinESMExports();
  try {
    assert.equal((await readRegular(file, 1024)).toString(), 'console.log("ACK")\n');
    assert.equal(opened, 1);
    restore();
    await fs.symlink(file, path.join(f.workspace, 'link'));
    let linkOpens = 0;
    mock.method(fs, 'open', async (name: any, ...args: any[]) => {
      if (name === path.join(f.workspace, 'link')) linkOpens++;
      return (open as any)(name, ...args);
    });
    syncBuiltinESMExports();
    await assert.rejects(readRegular(path.join(f.workspace, 'link'), 1024));
    assert.equal(linkOpens, 0, 'initial symlink rejected before any open, even without O_NOFOLLOW');
  } finally { restore(); await f.cleanup(); }
});

test('UNIT canonical ancestry failure is not swallowed by Win32 directory fallback', async () => {
  const f = await fixture(), undo = platform('win32');
  const open = fs.open.bind(fs), link = path.join(f.root, 'flush-link');
  try {
    await fs.symlink(f.runs, link, 'dir');
    mock.method(fs, 'open', async (name: any, ...args: any[]) => {
      if (name === link) throw error('EPERM');
      return (open as any)(name, ...args);
    });
    syncBuiltinESMExports();
    await assert.rejects(fsyncDirectory(link), /ancestry|canonical/i);
  } finally { restore(); undo(); await f.cleanup(); }
});
