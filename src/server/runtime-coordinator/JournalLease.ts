/** Kernel-owned crash-releasing lease. The lock inode is persistent and is NEVER unlinked. */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { canonicalDirectory, syncDirectory } from './storage';
const require = createRequire(import.meta.url);
export class JournalLease {
  private fd: number;
  private unlock: () => void;
  private readonly identity: string;
  constructor(private readonly file: string) {
    canonicalDirectory(path.dirname(file));
    let created = false;
    try { this.fd = fs.openSync(file, fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW ?? 0), 0o600); created = true; }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e; this.fd = fs.openSync(file, fs.constants.O_RDWR | (fs.constants.O_NOFOLLOW ?? 0)); }
    try {
      const before = fs.lstatSync(file, { bigint: true }), opened = fs.fstatSync(this.fd, { bigint: true });
      if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || before.size !== 0n ||
          before.dev !== opened.dev || before.ino !== opened.ino || (process.platform !== 'win32' && (before.mode & 0o077n))) throw Error('Unsafe journal lease file');
      this.identity = [before.dev,before.ino].join(':');
      const koffi = require('koffi');
      if (process.platform === 'linux') {
        const flock = koffi.load('libc.so.6').func('int flock(int fd, int operation)');
        if (flock(this.fd, 2 | 4) !== 0) throw Error('Mutation journal already has a live kernel owner');
        this.unlock = () => { if (flock(this.fd, 8) !== 0) throw Error('Journal lease unlock failed'); };
      } else if (process.platform === 'win32') {
        // Node/libuv fs descriptors are CRT descriptors, not Win32 HANDLE values.
        const system = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32');
        const crt = koffi.load(path.join(system, 'ucrtbase.dll'));
        const getHandle = crt.func('intptr_t _get_osfhandle(int fd)');
        const kernel = koffi.load(path.join(system, 'kernel32.dll'));
        const lock = kernel.func('int __stdcall LockFileEx(intptr_t h, uint32_t flags, uint32_t reserved, uint32_t low, uint32_t high, void *overlapped)');
        const unlock = kernel.func('int __stdcall UnlockFileEx(intptr_t h, uint32_t reserved, uint32_t low, uint32_t high, void *overlapped)');
        // OVERLAPPED: two pointer-sized fields, two DWORD offsets, HANDLE event.
        const overlapped = Buffer.alloc(process.arch === 'ia32' ? 20 : 32);
        const handle = getHandle(this.fd);
        if (lock(handle, 3, 0, 1, 0, overlapped) === 0) throw Error('Mutation journal already has a live kernel owner');
        this.unlock = () => { if (unlock(handle, 0, 1, 0, overlapped) === 0) throw Error('Journal lease unlock failed'); };
      } else throw Error('No reviewed kernel journal lease for this platform');
      if (created) { fs.fsyncSync(this.fd); syncDirectory(path.dirname(file)); }
      this.assertCurrent();
    } catch (e) { fs.closeSync(this.fd); throw e; }
  }
  assertCurrent(): void {
    if (this.fd === -1) throw Error('Journal lease is closed');
    canonicalDirectory(path.dirname(this.file));
    const current = fs.lstatSync(this.file, { bigint: true }), opened = fs.fstatSync(this.fd, { bigint: true });
    if (!current.isFile() || current.isSymbolicLink() || current.nlink !== 1n || current.size !== 0n ||
        [current.dev,current.ino].join(':') !== this.identity || [opened.dev,opened.ino].join(':') !== this.identity) throw Error('Journal lease identity changed');
  }
  close(): void {
    if (this.fd === -1) return;
    try { this.assertCurrent(); this.unlock(); } finally { fs.closeSync(this.fd); this.fd = -1; }
  }
}
