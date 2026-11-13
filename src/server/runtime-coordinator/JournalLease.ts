/** Kernel-owned crash-releasing lease. The lock inode is persistent and is NEVER unlinked. */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { canonicalDirectory, syncDirectory } from './storage';
const require = createRequire(import.meta.url);
interface NativeLease {
  assertCurrent(): void;
  release(): void;
}
const identity = (s: fs.BigIntStats): string => [s.dev, s.ino].join(':');
function safeFile(s: fs.BigIntStats): boolean {
  return s.isFile() && !s.isSymbolicLink() && s.nlink === 1n && s.size === 0n &&
    (process.platform === 'win32' || (s.mode & 0o077n) === 0n);
}
function linuxLease(file: string, koffi: any): NativeLease {
  let created = false, fd: number;
  try { fd = fs.openSync(file, fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW ?? 0), 0o600); created = true; }
  catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e; fd = fs.openSync(file, fs.constants.O_RDWR | (fs.constants.O_NOFOLLOW ?? 0)); }
  try {
    const before = fs.lstatSync(file, { bigint: true }), opened = fs.fstatSync(fd, { bigint: true });
    if (!safeFile(before) || !safeFile(opened) || identity(before) !== identity(opened)) throw Error('Unsafe journal lease file');
    const flock = koffi.load('libc.so.6').func('int flock(int fd, int operation)');
    if (flock(fd, 2 | 4) !== 0) throw Error('Mutation journal already has a live kernel owner');
    if (created) { fs.fsyncSync(fd); syncDirectory(path.dirname(file)); }
    return {
      assertCurrent() {
        // Bridge the native/class boundary: a safe fresh class snapshot alone
        // must not rebase ownership onto a replacement inode after acquisition.
        const current = fs.fstatSync(fd, { bigint: true }), named = fs.lstatSync(file, { bigint: true });
        if (!safeFile(current) || !safeFile(named) || identity(current) !== identity(opened) ||
            identity(named) !== identity(opened)) throw Error('Journal lease identity changed');
      },
      release() {
        try { if (flock(fd, 8) !== 0) throw Error('Journal lease unlock failed'); }
        finally { fs.closeSync(fd); }
      }
    };
  } catch (e) { fs.closeSync(fd); throw e; }
}
function windowsLease(file: string, koffi: any): NativeLease {
  if (!process.env.SystemRoot || !path.isAbsolute(process.env.SystemRoot)) throw Error('Missing trusted SystemRoot');
  const kernel = koffi.load(path.join(process.env.SystemRoot, 'System32', 'kernel32.dll'));
  // intptr_t is pointer-width and signed: INVALID_HANDLE_VALUE is -1, not a truncated DWORD.
  const create = kernel.func('__stdcall', 'CreateFileW', 'intptr_t', ['str16', 'uint32', 'uint32', 'void *', 'uint32', 'uint32', 'intptr_t']);
  const close = kernel.func('__stdcall', 'CloseHandle', 'int', ['intptr_t']);
  const error = kernel.func('__stdcall', 'GetLastError', 'uint32', []);
  const info = kernel.func('__stdcall', 'GetFileInformationByHandle', 'int', ['intptr_t', 'void *']);
  const type = kernel.func('__stdcall', 'GetFileType', 'uint32', ['intptr_t']);
  const flags = kernel.func('__stdcall', 'GetHandleInformation', 'int', ['intptr_t', 'void *']);
  const flush = kernel.func('__stdcall', 'FlushFileBuffers', 'int', ['intptr_t']);
  const lock = kernel.func('__stdcall', 'LockFileEx', 'int', ['intptr_t', 'uint32', 'uint32', 'uint32', 'uint32', 'void *']);
  const unlock = kernel.func('__stdcall', 'UnlockFileEx', 'int', ['intptr_t', 'uint32', 'uint32', 'uint32', 'void *']);
  const invalid = (h: number | bigint) => h === -1 || h === -1n || h === 0 || h === 0n;
  const fail = (what: string) => Error(what + ' (Win32 ' + error() + ')');
  const closeHandle = (h: number | bigint) => { if (!close(h)) throw fail('Journal lease CloseHandle failed'); };
  const inspect = (h: number | bigint): string => {
    // BY_HANDLE_FILE_INFORMATION consists of 13 DWORDs on both Win32 and Win64.
    const data = Buffer.alloc(52), handleFlags = Buffer.alloc(4);
    if (!info(h, data) || !flags(h, handleFlags)) throw fail('Journal lease handle inspection failed');
    if (type(h) !== 1 || (handleFlags.readUInt32LE(0) & 1) || // FILE_TYPE_DISK, not inheritable
        (data.readUInt32LE(0) & (0x10 | 0x400)) || // no directory or reparse point
        data.readUInt32LE(32) !== 0 || data.readUInt32LE(36) !== 0 || data.readUInt32LE(40) !== 1) throw Error('Unsafe journal lease handle');
    return [data.readUInt32LE(28), data.readUInt32LE(44), data.readUInt32LE(48)].join(':');
  };
  const name = path.toNamespacedPath(file);
  // Allocate before owning a handle, including on partial acquisition failure.
  const overlapped = Buffer.alloc(process.arch === 'ia32' ? 20 : 32);
  // CREATE_NEW, then OPEN_EXISTING only: never truncate. NULL security attributes
  // give a noninheritable handle. SHARE_READ only denies writers and deletion,
  // while permitting readonly identity inspection. OPEN_REPARSE_POINT never follows a link.
  let created = true;
  let handle = create(name, 0xC0000000, 1, null, 1, 0x00200000, 0);
  if (invalid(handle)) {
    const code = error();
    if (code !== 80 && code !== 183) throw Error('Mutation journal live kernel owner or handle refused (Win32 ' + code + ')');
    created = false;
    handle = create(name, 0xC0000000, 1, null, 3, 0x00200000, 0);
    if (invalid(handle)) throw fail('Mutation journal live kernel owner or handle refused');
  }
  // OVERLAPPED has two pointer-sized fields, two DWORD offsets, HANDLE event.
  let locked = false;
  const release = () => {
    try { if (locked && !unlock(handle, 0, 1, 0, overlapped)) throw fail('Journal lease unlock failed'); }
    finally { closeHandle(handle); }
  };
  try {
    const ownedIdentity = inspect(handle);
    // LOCKFILE_EXCLUSIVE_LOCK | LOCKFILE_FAIL_IMMEDIATELY; actual kernel ownership.
    if (!lock(handle, 3, 0, 1, 0, overlapped)) throw fail('Mutation journal already has a live kernel owner');
    locked = true;
    if (created) { if (!flush(handle)) throw fail('Journal lease flush failed'); syncDirectory(path.dirname(file)); }
    return {
      assertCurrent() {
        if (inspect(handle) !== ownedIdentity) throw Error('Journal lease identity changed');
        // Compare the ACTUAL locked HANDLE to a fresh no-follow path HANDLE, not
        // an unrelated Node/CRT fd. This inspection handle shares the owner's write access.
        const named = create(name, 0x80000000, 3, null, 3, 0x00200000, 0);
        if (invalid(named)) throw fail('Journal lease current path refused');
        try { if (inspect(named) !== ownedIdentity) throw Error('Journal lease identity changed'); }
        finally { closeHandle(named); }
      },
      release
    };
  } catch (e) { release(); throw e; }
}
export class JournalLease {
  private lease: NativeLease | undefined;
  private readonly identity: string;
  constructor(private readonly file: string) {
    canonicalDirectory(path.dirname(file));
    const koffi = require('koffi');
    if (process.platform === 'linux') this.lease = linuxLease(file, koffi);
    else if (process.platform === 'win32') this.lease = windowsLease(file, koffi);
    else throw Error('No reviewed kernel journal lease for this platform');
    try {
      const before = fs.lstatSync(file, { bigint: true });
      if (!safeFile(before)) throw Error('Unsafe journal lease file');
      this.identity = identity(before);
      this.assertCurrent();
    } catch (e) { const lease = this.lease; this.lease = undefined; lease.release(); throw e; }
  }
  assertCurrent(): void {
    if (!this.lease) throw Error('Journal lease is closed');
    canonicalDirectory(path.dirname(this.file));
    const current = fs.lstatSync(this.file, { bigint: true });
    if (!safeFile(current) || identity(current) !== this.identity) throw Error('Journal lease identity changed');
    this.lease.assertCurrent();
  }
  close(): void {
    if (!this.lease) return;
    const lease = this.lease;
    try { this.assertCurrent(); }
    finally { this.lease = undefined; lease.release(); }
  }
}
