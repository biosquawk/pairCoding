// Host-side fixture creation only; never apply modes to source or old outputs.
import {constants, mkdirSync, chmodSync, lstatSync, openSync, fstatSync, fchmodSync, writeFileSync, closeSync} from 'node:fs';
import {isAbsolute, resolve, dirname, join} from 'node:path';

function directory(path, mode) {
  const s=lstatSync(path);
  if(!s.isDirectory()||s.isSymbolicLink()||s.uid!==process.getuid())throw new Error(`Unsafe owned directory: ${path}`);
  if(mode!==undefined&&(s.mode&0o777)!==mode)throw new Error(`Unsafe directory mode: ${path}`);
  return s;
}
function noLinkedAncestors(path) {
  for(let p=path;;p=dirname(p)){
    const s=lstatSync(p);
    if(!s.isDirectory()||s.isSymbolicLink())throw new Error(`Linked/non-directory ancestor: ${p}`);
    if(p===dirname(p))break;
  }
}
export function assertPrivateOutput(path) {
  if(!isAbsolute(path)||resolve(path)!==path)throw new Error('Output must be canonical absolute path');
  noLinkedAncestors(path);
  return directory(path,0o700);
}
export function createPrivateOutput(path) {
  if(!isAbsolute(path)||resolve(path)!==path)throw new Error('Output must be canonical absolute path');
  noLinkedAncestors(dirname(path));
  mkdirSync(path,{mode:0o700}); // exclusive: existing outputs, including links, fail
  chmodSync(path,0o700); // only the directory just created, never its parent
  assertPrivateOutput(path);
}
export function createMutableShadow(out,kind) {
  const boundary=assertPrivateOutput(out);
  if(!/^(?:java27|java21|python)$/.test(kind))throw new Error('Invalid shadow case');
  const root=join(out,`shadow-${kind}`),created=new Map();
  const freshDirectory=path=>{
    mkdirSync(path,{mode:0o700});
    chmodSync(path,0o777); // only NEW generated bind/directories under private output
    created.set(path,directory(path,0o777));
  };
  const unchangedDirectory=path=>{
    const expected=created.get(path),actual=directory(path,0o777);
    if(!expected||actual.dev!==expected.dev||actual.ino!==expected.ino)throw new Error('Generated shadow directory replaced');
  };
  freshDirectory(root);
  return {root,write(path,text){
    const current=assertPrivateOutput(out);
    if(current.dev!==boundary.dev||current.ino!==boundary.ino)throw new Error('Private output replaced');
    if(typeof path!=='string'||!path||path.includes('\\')||path.includes('\0')||path.split('/').some(p=>!p||p==='.'||p==='..')||isAbsolute(path))throw new Error('Unsafe shadow relative path');
    const parts=path.split('/');let parent=root;
    unchangedDirectory(parent);
    for(const part of parts.slice(0,-1)){
      const dir=join(parent,part);
      if(created.has(dir))unchangedDirectory(dir);else freshDirectory(dir);
      parent=dir;
    }
    const file=join(parent,parts.at(-1));
    const fd=openSync(file,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
    try{
      const s=fstatSync(fd);
      if(!s.isFile()||s.nlink!==1||s.uid!==process.getuid())throw new Error('Unsafe generated file');
      writeFileSync(fd,text);
      fchmodSync(fd,0o666); // effective mode, NOT creation mode filtered by host umask
      if((fstatSync(fd).mode&0o777)!==0o666)throw new Error('Generated file mode not effective');
    }finally{closeSync(fd);}
    return file;
  }};
}
