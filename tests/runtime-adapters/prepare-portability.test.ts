import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import path from 'node:path';
import {receiptWriter,syncDirectory,readPrivate,sameIdentity,stamp} from '../../scripts/runtime-files.mjs';
const temp=()=>fs.mkdtempSync(path.join(process.env.TMPDIR!,'prepare-portable-'));
const error=(code:string)=>Object.assign(new Error(code),{code});
test('UNIT Win32 file-r EPERM simulation: writable handle publication and exact readback; file errors NEVER suppressed',()=>{
 const root=temp(),fds=new Map<number,number>(); let fileFlush=0;
 const io={...fs,openSync:(p:any,flags:any,mode:any)=>{const fd=fs.openSync(p,flags,mode);fds.set(fd,flags);return fd;},fsyncSync:(fd:number)=>{
   const st=fs.fstatSync(fd);if(st.isDirectory()) throw error('EPERM');
   if(!(fds.get(fd)!&fs.constants.O_WRONLY)) throw error('EPERM');fileFlush++;fs.fsyncSync(fd);
 }};
 const write=receiptWriter(path.join(root,'out'),io,'win32');write({status:'PLAN_ONLY_NOT_PREPARED',commands:[]});write({status:'SECOND',commands:[]});
 assert.equal(fileFlush,2);assert.equal(JSON.parse(readPrivate(path.join(root,'out','receipt.json'),4096).bytes.toString()).status,'SECOND');
 for(const code of ['EPERM','EIO']) { const fail={...fs,fsyncSync:()=>{throw error(code);}};const w=receiptWriter(path.join(root,code),fail,'win32');assert.throws(()=>w({status:'PLAN_ONLY_NOT_PREPARED'}),new RegExp(code)); }
});
test('directory unsupported cases ONLY actual policy-selected Win32 seam; POSIX/unexpected/close propagate',()=>{
 const root=temp();for(const code of ['EPERM','EACCES','EINVAL','EISDIR','EBADF']) {
   const io={...fs,fsyncSync:()=>{throw error(code);}};
   assert.equal(syncDirectory(root,io,'win32'),'UNAVAILABLE_WIN32');assert.throws(()=>syncDirectory(root,io,'linux'),new RegExp(code));
 }
 assert.throws(()=>syncDirectory(root,{...fs,fsyncSync:()=>{throw error('EIO');}},'win32'),/EIO/);
 assert.throws(()=>syncDirectory(root,{...fs,closeSync:(fd:number)=>{fs.closeSync(fd);throw error('EPERM');}},'win32'),/EPERM/);
});
test('real plan receipt rejects alias ancestry, hardlinks, observed replacement; never overwrite stale output',()=>{
 const root=temp(),dir=path.join(root,'real');fs.mkdirSync(dir);fs.symlinkSync(dir,path.join(root,'alias'));
 assert.throws(()=>receiptWriter(path.join(root,'alias','out')),/ancestry/);
 const output=path.join(dir,'out'),w=receiptWriter(output);w({status:'PLAN_ONLY_NOT_PREPARED',commands:[]});assert.throws(()=>receiptWriter(output));
 fs.linkSync(path.join(output,'receipt.json'),path.join(dir,'linked'));assert.throws(()=>w({status:'bad'}),/Unsafe/);
 fs.unlinkSync(path.join(dir,'linked'));fs.writeFileSync(path.join(output,'receipt.json'),'{}');assert.throws(()=>w({status:'bad'}),/changed/);
});
test('UNIT BigInt identities preserve adjacent 2^60 / 2^60+1 and bounded read detects growth',()=>{
 const a={dev:1n,ino:2n**60n,size:1n,mtimeNs:1n,ctimeNs:1n,mode:1n,nlink:1n},b={...a,ino:a.ino+1n};
 assert.equal(Number(a.ino),Number(b.ino));assert.equal(sameIdentity(a,b),false);assert.notEqual(stamp(a),stamp(b));
 const root=temp(),file=path.join(root,'receipt.json');fs.writeFileSync(file,'{}');assert.throws(()=>readPrivate(file,1),/Unsafe/);
 const io={...fs,readSync:(...args:any[])=>{const n=(fs.readSync as any)(...args);fs.appendFileSync(file,'x');return n;}};
 assert.throws(()=>readPrivate(file,64,io),/changed/);
});
