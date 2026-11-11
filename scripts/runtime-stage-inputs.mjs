/** Explicit reviewed operator download/stage. Node stdlib ONLY; no host language toolchain/install/Docker.
 * New owned output only; exact official URL+size+hash, safe regular-file npm extraction. */
import * as fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {gunzipSync} from 'node:zlib';
import {canonicalDirectory,readPrivate,receiptWriter} from './runtime-files.mjs';
const repo=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),sha=b=>createHash('sha256').update(b).digest('hex');
const octal=b=>{const s=b.toString('ascii').replace(/\0.*$/s,'').trim();if(!/^[0-7]+$/.test(s))throw new Error('Invalid tar octal');const n=parseInt(s,8);if(!Number.isSafeInteger(n))throw new Error('Tar integer');return n;};
const text=b=>new TextDecoder('utf8',{fatal:true}).decode(b.subarray(0,b.indexOf(0)<0?b.length:b.indexOf(0)));
export function npmFiles(compressed,expected) {
 const tar=gunzipSync(compressed,{maxOutputLength:128*1024*1024}),files=new Map();let offset=0;
 while(offset+512<=tar.length) {
  const header=tar.subarray(offset,offset+512);offset+=512;if(header.every(n=>n===0)){if(!tar.subarray(offset).every(n=>n===0))throw new Error('Trailing tar data');break;}
  const checksum=octal(header.subarray(148,156));let actual=0;for(let i=0;i<512;i++)actual+=i>=148&&i<156?32:header[i];if(checksum!==actual)throw new Error('Tar checksum');
  const prefix=text(header.subarray(345,500)),name=(prefix?prefix+'/':'')+text(header.subarray(0,100)),size=octal(header.subarray(124,136)),type=header[156];
  if(size>16*1024*1024 || offset+size>tar.length || !name.startsWith('package/') || name.startsWith('/') || /[\\\x00-\x1f]/.test(name) || name.split('/').some(p=>p==='..'||p==='.'))throw new Error('Unsafe npm archive entry');
  const rel=name.slice(8),bytes=tar.subarray(offset,offset+size);offset+=Math.ceil(size/512)*512;
  if(type===53)continue; // Directories do not create paths. Only reviewed regular-file inventory does.
  if(![0,48].includes(type) || !rel || rel.endsWith('/') || files.has(rel))throw new Error('Nonregular/duplicate npm archive entry');
  const approved=expected.find(f=>f.path===rel);if(!approved || sha(bytes)!==approved.sha256)throw new Error('Extracted inventory differs');files.set(rel,bytes);
 }
 if(offset>tar.length || files.size!==expected.length)throw new Error('Incomplete npm inventory');return files;
}
async function download(a,fetcher) {
 const u=new URL(a.url);if(u.protocol!=='https:' || !['registry.npmjs.org','files.pythonhosted.org','download.eclipse.org'].includes(u.hostname) || u.username || u.password || u.hash || u.search)throw new Error('Unapproved public artifact URL');
 if(!Number.isSafeInteger(a.bytes)||a.bytes<=0||a.bytes>128*1024*1024)throw new Error('Download budget');
 const response=await fetcher(a.url,{redirect:'error',signal:AbortSignal.timeout(45000)});
 if(!response.ok || response.url && new URL(response.url).hostname!==u.hostname)throw new Error('Download status/redirect');
 let length=0;const chunks=[];for await(const chunk of response.body){length+=chunk.length;if(length>a.bytes)throw new Error('Download exceeds declared bytes');chunks.push(Buffer.from(chunk));}
 const bytes=Buffer.concat(chunks);if(length!==a.bytes || sha(bytes)!==a.sha256)throw new Error('Artifact bytes/hash differ');return bytes;
}
export async function stageInputs(output,{lock=JSON.parse(readPrivate(path.join(repo,'runtimes/production-inputs.lock.json'),4*1024*1024).bytes),fetcher=fetch}={}) {
 const root=path.resolve(output);canonicalDirectory(path.dirname(root));fs.mkdirSync(root,{mode:0o700});canonicalDirectory(root);
 const make=d=>{canonicalDirectory(path.dirname(d));fs.mkdirSync(d,{mode:0o700});canonicalDirectory(d);};
 const put=(p,bytes)=>{canonicalDirectory(path.dirname(p));const fd=fs.openSync(p,'wx',0o600);try{fs.writeFileSync(fd,bytes);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}if(!readPrivate(p,128*1024*1024).bytes.equals(bytes))throw new Error('Staged readback differs');};
 const publish=receiptWriter(path.join(root,'download-journal')),receipt={status:'STARTED_NOT_PREPARED',scope:'Exact official downloads only; no Docker/tool execution',artifacts:[]};let publicationFailed=false;
 const save=()=>{try{return publish(receipt);}catch(e){publicationFailed=true;throw e;}};save();
 try {
  for(const sub of ['stage','stage/tools','stage/tools/node_modules','stage/wheels','stage/language'])make(path.join(root,sub));
  const seen=new Map();let total=0;
  for(const a of [...lock.artifacts,...lock.language.artifacts]) {
   if(seen.has(a.url)){if(seen.get(a.url)!==a.sha256)throw new Error('Conflicting duplicate URL');continue;}seen.set(a.url,a.sha256);
   if(total+a.bytes>192*1024*1024)throw new Error('Total artifact budget');const bytes=await download(a,fetcher);total+=bytes.length;
   if(a.kind==='npm') {
    if(!/^[a-z0-9-]+$/.test(a.name) || 'sha512-'+createHash('sha512').update(bytes).digest('base64')!==a.integrity)throw new Error('Npm name/integrity');
    const dest=path.join(root,'stage/tools/node_modules',a.name);make(dest);
    for(const [rel,data] of npmFiles(bytes,a.files)) {const parts=rel.split('/');if(parts.some(p=>!p||p==='.'||p==='..'))throw new Error('Unsafe npm path');let dir=dest;
     for(const part of parts.slice(0,-1)){dir=path.join(dir,part);if(!fs.existsSync(dir))make(dir);canonicalDirectory(dir);}put(path.join(dest,rel),data);
    }
   }else if(['wheel','language-wheel'].includes(a.kind)) {
    if(path.basename(a.filename)!==a.filename || !/^[A-Za-z0-9_.-]+\.whl$/.test(a.filename))throw new Error('Wheel path');put(path.join(root,'stage/wheels',a.filename),bytes);
   }else if(a.kind==='jdt'&&a.filename==='jdt.tar.gz')put(path.join(root,'stage/language/jdt.tar.gz'),bytes);
   else throw new Error('Unknown artifact');
   receipt.artifacts.push({name:a.name,sha256:a.sha256,bytes:bytes.length});save();
  }
  receipt.status='STAGED_NOT_PREPARED';save();return receipt;
 }catch(e){receipt.status='FAILED_NOT_PREPARED_RETAIN';receipt.error=e.message;if(!publicationFailed)save();throw e;}
}
if(process.argv[1]&&fileURLToPath(import.meta.url)===path.resolve(process.argv[1])) {
 try{if(process.argv.length!==3)throw new Error('Usage: node scripts/runtime-stage-inputs.mjs NEW_PRIVATE_OPERATOR_ROOT');await stageInputs(process.argv[2]);}
 catch(e){console.error(e.message);process.exitCode=1;}
}
