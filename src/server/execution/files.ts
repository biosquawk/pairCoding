import {
  constants
} from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {
  createHash, randomUUID
} from 'node:crypto';
export const sha256 = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
export function requireThat(ok: unknown, message: string): asserts ok {
  if (!ok) throw new Error(message);
}
export const safeId = (s: unknown): s is string => typeof s === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(s);
export const safeRelative = (s: string) => typeof s === 'string' && s.length <= 1024 && !/[\\:\x00-\x1f\x7f]/.test(s) && !s.startsWith('/') && s.split('/').every(p => p && p !== '.' && p !== '..' && !/[. ]$/.test(p) && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(p));
export function inside(root: string, file: string) {
  const rel = path.relative(root,file);
  return rel !== '' && !rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel);
}
/** Require a canonical, non-symlink path. No resolution of an attacker-selected link into an approved path. */
export async function canonicalDirectory(directory: string) {
  requireThat(path.isAbsolute(directory) && await fs.realpath(directory) === directory, 'Noncanonical directory');
  const st = await fs.lstat(directory);
  requireThat(st.isDirectory() && !st.isSymbolicLink(), 'Not a directory');
}
export async function readRegular(file: string, maxBytes: number) {
  const fd = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const a = await fd.stat();
    requireThat(a.isFile() && a.nlink === 1 && a.size <= maxBytes, 'Unsafe or oversized file');
    const data = Buffer.alloc(a.size);
    let offset=0;
    while(offset<data.length) {
      const r=await fd.read(data,offset,data.length-offset,offset);
      requireThat(r.bytesRead>0,'File changed');
      offset+=r.bytesRead;
    }
    const b=await fd.stat();
    const named=await fs.lstat(file);
    requireThat(a.ino===b.ino && a.dev===b.dev && a.size===b.size && a.mtimeMs===b.mtimeMs && a.ctimeMs===b.ctimeMs && named.ino===b.ino && named.dev===b.dev && !named.isSymbolicLink(), 'File changed');
    return data;
  } finally {
    await fd.close();
  }
}
export async function fsyncDirectory(dir: string) {
  const fd=await fs.open(dir,constants.O_RDONLY);
  try {
    await fd.sync();
  }finally{
    await fd.close();
  }
}
/** Atomic durable publication. Existing records are replaced only by this single-owner journal. */
export async function durableWrite(file: string, bytes: string) {
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
/** Stable identities are independent of object insertion order; only bounded plain JSON data is admitted. */
export function canonicalJson(value:unknown):string {
  let nodes=0;
  function normalize(v:unknown,depth:number):unknown {
    requireThat(++nodes<=100000&&depth<=64,'JSON structure limit');
    if(v===null||typeof v==='string'||typeof v==='boolean')return v;
    if(typeof v==='number'){
      requireThat(Number.isFinite(v),'Nonfinite JSON number');
      return v;
    }
    requireThat(typeof v==='object'&&v!==null,'Non-JSON value');
    if(Array.isArray(v))return v.map(x=>normalize(x,depth+1));
    requireThat(Object.getPrototypeOf(v)===Object.prototype||Object.getPrototypeOf(v)===null,'Nonplain JSON data');
    return Object.fromEntries(Object.keys(v).sort().map(k=>[k,normalize((v as Record<string,unknown>)[k],depth+1)]));
  }
  return JSON.stringify(normalize(value,0));
}
