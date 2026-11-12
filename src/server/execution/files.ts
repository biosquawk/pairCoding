import {
  constants
} from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {
  randomUUID
} from 'node:crypto';
export { canonicalJson, sha256 } from '../runtimeIdentity';
export function requireThat(ok: unknown, message: string): asserts ok {
  if (!ok) throw new Error(message);
}
export const safeId = (s: unknown): s is string => typeof s === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(s);
export const safeRelative = (s: string) => typeof s === 'string' && s.length <= 1024 && !/[\\:\x00-\x1f\x7f]/.test(s) && !s.startsWith('/') && s.split('/').every(p => p && p !== '.' && p !== '..' && !/[. ]$/.test(p) && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(p));
export function inside(root: string, file: string) {
  const rel = path.relative(root,file);
  return rel !== '' && !rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel);
}
/** Absolute, component-by-component canonical ancestry; never follow a symlink/junction alias. */
export async function canonicalDirectory(directory: string) {
  requireThat(path.isAbsolute(directory) && path.resolve(directory) === directory, 'Noncanonical directory');
  let current = path.parse(directory).root;
  for (const part of ['', ...directory.slice(current.length).split(path.sep).filter(Boolean)]) {
    if (part) current = path.join(current, part);
    const st = await fs.lstat(current, { bigint: true });
    requireThat(st.isDirectory() && !st.isSymbolicLink() && await fs.realpath(current) === current,
      'Noncanonical directory ancestry');
  }
}
export async function readRegular(file: string, maxBytes: number) {
  requireThat(Number.isSafeInteger(maxBytes) && maxBytes >= 0, 'Invalid read bound');
  await canonicalDirectory(path.dirname(file));
  const initial = await fs.lstat(file, { bigint: true });
  const safe = (st: typeof initial) => st.isFile() && !st.isSymbolicLink() && st.nlink === 1n && st.size >= 0n && st.size <= BigInt(maxBytes);
  const stamp = (st: typeof initial) => [st.dev, st.ino, st.size, st.mtimeNs, st.ctimeNs, st.mode, st.nlink].join(':');
  requireThat(safe(initial), 'Unsafe or oversized file');
  const fd = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await fd.stat({ bigint: true });
    requireThat(safe(opened) && stamp(initial) === stamp(opened), 'File changed while opening');
    // One extra byte detects growth, including an initially empty file. Never read unbounded data.
    const size = Number(initial.size), data = Buffer.alloc(size + 1);
    let offset = 0;
    while (offset < data.length) {
      const r = await fd.read(data, offset, data.length - offset, offset);
      if (r.bytesRead === 0) break;
      offset += r.bytesRead;
    }
    const after = await fd.stat({ bigint: true });
    await canonicalDirectory(path.dirname(file));
    const named = await fs.lstat(file, { bigint: true });
    requireThat(offset === size && safe(after) && safe(named) &&
      stamp(initial) === stamp(after) && stamp(initial) === stamp(named), 'File changed while reading');
    return data.subarray(0, offset);
  } finally {
    await fd.close();
  }
}
/** Win32 lacks directory flush support in Node; file flush errors are NEVER suppressed.
 * Only the documented unsupported-directory codes are tolerated, after canonical ancestry.
 * This is reduced metadata durability, not POSIX-equivalent crash durability. */
export async function fsyncDirectory(dir: string) {
  await canonicalDirectory(dir);
  let fd: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    fd = await fs.open(dir, constants.O_RDONLY);
    await fd.sync();
  } catch (error) {
    if (process.platform !== 'win32' || !['EPERM', 'EACCES', 'EINVAL', 'EISDIR', 'EBADF'].includes(
      (error as NodeJS.ErrnoException).code ?? '')) throw error;
  } finally {
    // Close is deliberately outside the scoped unsupported-open/sync catch.
    if (fd) await fd.close();
  }
}
/** Atomic durable publication. Existing records are replaced only by this single-owner journal. */
export async function durableWrite(file: string, bytes: string) {
  await canonicalDirectory(path.dirname(file));
  const tmp=file+'.'+randomUUID()+'.tmp';
  const fd=await fs.open(tmp,'wx',0o600);
  try {
    await fd.writeFile(bytes);
    await fd.sync();
  }finally{
    await fd.close();
  }
  try {
    await fs.rename(tmp,file);
    await fsyncDirectory(path.dirname(file));
  }catch(e){
    await fs.rm(tmp,{
      force:true
    });
    throw e;
  }
  requireThat((await readRegular(file,Math.max(4*1024*1024,Buffer.byteLength(bytes)))).equals(Buffer.from(bytes)), 'Durable readback mismatch');
}
