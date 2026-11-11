/** Coordinator-owned durable state. Trusted canonical private parent, not an ACL sandbox. */
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

export const sha256 = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex');
export function canonical(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object' && [Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + canonical((value as Record<string, unknown>)[k])).join(',') + '}';
  }
  throw Error('Coordinator storage accepts JSON only');
}
export function canonicalDirectory(directory: string): void {
  if (!path.isAbsolute(directory) || path.normalize(directory) !== directory) throw Error('Absolute canonical state directory required');
  let current = path.parse(directory).root;
  for (const component of path.relative(current, directory).split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    const s = fs.lstatSync(current, { bigint: true });
    if (!s.isDirectory() || s.isSymbolicLink() || fs.realpathSync.native(current) !== current) throw Error('Unsafe state directory');
  }
}
export function privateDirectory(directory: string): void {
  canonicalDirectory(path.dirname(directory));
  try { fs.mkdirSync(directory, { mode: 0o700 }); syncDirectory(path.dirname(directory)); }
  catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e; }
  canonicalDirectory(directory);
  // Win32 mode bits do not establish ACL privacy. Trust inherited ACL of configured parent;
  // never claim chmod is Windows access control. Actual native proof remains final QA.
  if (process.platform !== 'win32' && (fs.lstatSync(directory).mode & 0o077)) throw Error('State directory is not private');
}
export function syncDirectory(directory: string): void {
  canonicalDirectory(directory);
  let fd: number | undefined;
  try {
    fd = fs.openSync(directory, fs.constants.O_RDONLY | (fs.constants.O_DIRECTORY ?? 0) | (fs.constants.O_NOFOLLOW ?? 0));
    fs.fsyncSync(fd);
  } catch (e) {
    if (process.platform !== 'win32' || !['EPERM','EACCES','EINVAL','EISDIR','EBADF'].includes((e as NodeJS.ErrnoException).code ?? '')) throw e;
    // Only unsupported DIRECTORY metadata durability. Regular-file flush errors always propagate.
  } finally { if (fd !== undefined) fs.closeSync(fd); }
}
const metadata = (s: fs.BigIntStats): string => [s.dev,s.ino,s.size,s.nlink,s.mode,s.mtimeNs,s.ctimeNs].join(':');
export function readRecord(file: string, maxBytes: number, missing = false): Buffer | null {
  canonicalDirectory(path.dirname(file));
  let before: fs.BigIntStats;
  try { before = fs.lstatSync(file, { bigint: true }); }
  catch (e) { if (missing && (e as NodeJS.ErrnoException).code === 'ENOENT') return null; throw e; }
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || before.size < 0n || before.size > BigInt(maxBytes)) throw Error('Unsafe durable record');
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    if (metadata(before) !== metadata(fs.fstatSync(fd, { bigint: true }))) throw Error('Record changed while opening');
    const buffer = Buffer.alloc(Number(before.size) + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const n = fs.readSync(fd, buffer, offset, buffer.length - offset, null);
      if (!n) break;
      offset += n;
    }
    if (BigInt(offset) !== before.size || metadata(before) !== metadata(fs.fstatSync(fd, { bigint: true })) ||
        metadata(before) !== metadata(fs.lstatSync(file, { bigint: true }))) throw Error('Record changed while reading');
    return buffer.subarray(0, offset);
  } finally { fs.closeSync(fd); }
}
export function createRecord(file: string, bytes: Buffer): void {
  canonicalDirectory(path.dirname(file));
  const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW ?? 0), 0o600);
  try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  syncDirectory(path.dirname(file));
  if (!readRecord(file, bytes.length)!.equals(bytes)) throw Error('Durable record readback mismatch');
}
export function replaceRecord(file: string, bytes: Buffer): void {
  const temp = path.join(path.dirname(file), '.next-' + randomUUID());
  createRecord(temp, bytes);
  // Only caller holding the exclusive journal lease may replace its own fixed record.
  // A failed rename/flush/readback leaves the caller uncertain; it must not claim abort.
  fs.renameSync(temp, file);
  syncDirectory(path.dirname(file));
  if (!readRecord(file, bytes.length)!.equals(bytes)) throw Error('Durable replacement readback mismatch');
}

/** FIFO errors do not poison subsequent admission. Never used to imply durable admission. */
export class SerialQueue {
  private tail: Promise<void> = Promise.resolve();
  run<T>(operation: () => Promise<T> | T): Promise<T> {
    const result = this.tail.then(operation);
    this.tail = result.then(() => {}, () => {});
    return result;
  }
}
