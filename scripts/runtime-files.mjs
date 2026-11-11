// Private operator receipt storage. No shared/runtime DTO imports.
import * as fs from 'node:fs';
import path from 'node:path';
export const stamp = s => [s.dev,s.ino,s.size,s.mtimeNs,s.ctimeNs,s.mode,s.nlink].join(':');
export const sameIdentity = (a,b) => a.dev===b.dev && a.ino===b.ino;
export function canonicalDirectory(directory, io=fs) {
  const absolute=path.resolve(directory); let current=path.parse(absolute).root;
  for(const part of absolute.slice(current.length).split(path.sep).filter(Boolean)) {
    current=path.join(current,part); const s=io.lstatSync(current,{bigint:true});
    if(!s.isDirectory() || s.isSymbolicLink() || io.realpathSync.native(current)!==current) throw new Error('Unsafe prepare directory ancestry');
  }
  return absolute;
}
export function syncDirectory(directory,io=fs,platform=process.platform) {
  canonicalDirectory(directory,io); let fd;
  try { fd=io.openSync(directory,io.constants.O_RDONLY); io.fsyncSync(fd); }
  catch(e) {
    if(platform!=='win32' || !['EPERM','EACCES','EINVAL','EISDIR','EBADF'].includes(e.code)) throw e;
    return 'UNAVAILABLE_WIN32';
  } finally { if(fd!==undefined) io.closeSync(fd); }
  return 'FLUSHED';
}
export function readPrivate(file,limit,io=fs) {
  canonicalDirectory(path.dirname(file),io); const initial=io.lstatSync(file,{bigint:true});
  if(!initial.isFile() || initial.isSymbolicLink() || initial.nlink!==1n || initial.size>BigInt(limit)) throw new Error('Unsafe prepare receipt file');
  const fd=io.openSync(file,io.constants.O_RDONLY|(io.constants.O_NOFOLLOW??0));
  try {
    if(stamp(initial)!==stamp(io.fstatSync(fd,{bigint:true}))) throw new Error('Prepare receipt changed on open');
    const data=Buffer.alloc(Number(initial.size)+1); let count=0;
    while(count<data.length) { const n=io.readSync(fd,data,count,data.length-count,null); if(!n) break; count+=n; }
    if(count>limit || stamp(initial)!==stamp(io.fstatSync(fd,{bigint:true})) || stamp(initial)!==stamp(io.lstatSync(file,{bigint:true}))) throw new Error('Prepare receipt changed on read');
    return {bytes:Buffer.from(data.subarray(0,count)),stat:initial};
  } finally { io.closeSync(fd); }
}
/** New explicit output only. On Win32 confidentiality trusts inherited ACLs of operator's private parent;
 * POSIX mode is not an ACL assertion. No malicious same-user host process guarantee. */
export function receiptWriter(output,io=fs,platform=process.platform) {
  canonicalDirectory(path.dirname(output),io); io.mkdirSync(output,{mode:0o700});
  canonicalDirectory(output,io); const root=io.lstatSync(output,{bigint:true});
  if(platform!=='win32' && (root.mode&0o077n)!==0n) throw new Error('Prepare output must be private');
  const file=path.join(output,'receipt.json'),tmp=path.join(output,'receipt.tmp'); let previous=null;
  return receipt=>{
    canonicalDirectory(output,io);
    if(!sameIdentity(root,io.lstatSync(output,{bigint:true}))) throw new Error('Prepare output identity changed');
    if(previous && stamp(readPrivate(file,16*1024*1024,io).stat)!==stamp(previous)) throw new Error('Prepare receipt publication changed');
    const bytes=Buffer.from(JSON.stringify(receipt,null,2)); if(bytes.length>16*1024*1024) throw new Error('Prepare receipt limit');
    const fd=io.openSync(tmp,io.constants.O_WRONLY|io.constants.O_CREAT|io.constants.O_EXCL|(io.constants.O_NOFOLLOW??0),0o600); let written;
    try {
      io.writeFileSync(fd,bytes); io.fsyncSync(fd); // All regular-file failures propagate, including Win32 EPERM.
      written=io.fstatSync(fd,{bigint:true});
      if(!written.isFile() || written.nlink!==1n || written.size!==BigInt(bytes.length)) throw new Error('Prepare write changed');
    } finally { io.closeSync(fd); }
    const before=readPrivate(tmp,16*1024*1024,io);
    if(stamp(written)!==stamp(before.stat) || !before.bytes.equals(bytes)) throw new Error('Prepare write readback differs');
    io.renameSync(tmp,file);
    const final=readPrivate(file,16*1024*1024,io);
    if(!sameIdentity(written,final.stat) || !final.bytes.equals(bytes)) throw new Error('Prepare rename readback differs');
    previous=final.stat; return syncDirectory(output,io,platform);
  };
}
