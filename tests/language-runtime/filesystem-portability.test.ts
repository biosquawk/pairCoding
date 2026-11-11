import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { constants, chmodSync, fstatSync, lstatSync, mkdirSync, mkdtempSync, openSync, readSync, closeSync, realpathSync, rmSync, writeFileSync, writeSync, type BigIntStats } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { assertRealDirectory, DiskLanguageProcessJournal, readRegular, sha256, type LanguageProcessIntent, type LanguageReadIO } from '../../src/server/language/LanguageProcessJournal';
import { LanguageShadowStore, type LanguageShadowCodec } from '../../src/server/language/LanguageShadowStore';
import { NodeLanguageJournalDurability, type LanguageJournalDurability } from '../../src/server/language/LanguageJournalDurability';
function fixture(t: TestContext) { const root=mkdtempSync(join(process.env.TMPDIR??tmpdir(),'language-fs-'));t.after(()=>rmSync(root,{recursive:true,force:true}));return root; }
function io(): LanguageReadIO { return {lstat:p=>lstatSync(p,{bigint:true}),realpath:p=>realpathSync.native(p),open:openSync,stat:fd=>fstatSync(fd,{bigint:true}),read:readSync,close:closeSync}; }
function file(t:TestContext) {const root=fixture(t),path=join(root,'f');writeFileSync(path,'abc');return {root,path};}
const patched=(s:BigIntStats, changes:Partial<BigIntStats>):BigIntStats=>Object.assign(Object.create(Object.getPrototypeOf(s)),s,changes);
const error=()=>Object.assign(new Error('file flush EPERM'),{code:'EPERM'});
// Controlled metadata only. These are not actual NTFS allocations/native Win32 executions.
test('UNIT adjacent 2^60 identities remain exact: different opened inode and dev rejected',t=>{
  for(const key of ['ino','dev'] as const){const {path}=file(t),r=io(),base=1n<<60n,ls=r.lstat,fs=r.stat;
    r.lstat=p=>{const s=ls(p);return s.isFile()?patched(s,{[key]:base}):s;};r.stat=fd=>patched(fs(fd),{[key]:base+1n});
    assert.throws(()=>readRegular(path,3,r),/changed/);
  }
});
test('UNIT final path swap rejected even without O_NOFOLLOW: FD remains original',t=>{
  const {path}=file(t),r=io(),ls=r.lstat;let files=0;
  r.lstat=p=>{const s=ls(p);if(p===path&&++files>1)return patched(s,{ino:s.ino+1n});return s;};
  assert.throws(()=>readRegular(path,3,r),/changed/);
});
test('UNIT post-read fstat identity change rejected independently of equal bytes/size/time',t=>{
  const {path}=file(t),r=io(),fs=r.stat;let calls=0;r.stat=fd=>{const s=fs(fd);return ++calls>1?patched(s,{dev:s.dev+1n}):s;};
  assert.throws(()=>readRegular(path,3,r),/changed/);
});
test('UNIT changed opening timestamp/mode cannot become a new accepted baseline',t=>{
  for(const key of ['mtimeNs','ctimeNs','mode'] as const){const {path}=file(t),r=io(),fs=r.stat;r.stat=fd=>{const s=fs(fd);return patched(s,{[key]:s[key]+1n});};assert.throws(()=>readRegular(path,3,r),/changed/);}
});
test('UNIT canonical realpath alias rejected before any file open or directory flush',t=>{
  const root=fixture(t),r=io();r.realpath=p=>`${p}-alias`;assert.throws(()=>assertRealDirectory(root,r),/canonical|alias/);
});
test('bounded regular read rejects post-open growth and invalid budgets, closes failed handle',t=>{
  const {path}=file(t),r=io(),read=r.read,close=r.close;let closed=0;
  r.read=(fd,b,o,l,p)=>{const n=read(fd,b,o,l,p);if(n===3){b[o+3]=120;return 4;}return n;};r.close=fd=>{closed++;close(fd);};
  assert.throws(()=>readRegular(path,3,r),/changed|oversize/);assert.equal(closed,1);
  for(const n of [-1,NaN,1.5,Infinity,1024*1024*1024])assert.throws(()=>readRegular(path,n),/budget|limit/);
});
test('actual platform private journal policy: POSIX broad launch access rejected; Windows mode is not an ACL',t=>{
  const root=fixture(t),id=randomUUID(),dir=join(root,id);mkdirSync(dir,{mode:0o777});chmodSync(dir,0o777);
  const j=new DiskLanguageProcessJournal(root);
  if(process.platform==='win32') {j.putIntent({launchId:id} as LanguageProcessIntent);assert.equal(j.readIntent(id).launchId,id);}
  else {assert.throws(()=>j.putIntent({launchId:id} as LanguageProcessIntent),/private/);assert.equal(lstatSync(dir).mode&0o777,0o777);}
});
test('shadow copied regular files flush with writable handle; file failure fails capture with original untouched',t=>{
  const root=fixture(t),owned=join(root,'owned'),source=join(root,'source');mkdirSync(owned);mkdirSync(source);writeFileSync(join(source,'f'),'abc');
  const codec:LanguageShadowCodec={assertRelativePath:p=>{assert.equal(p,'f');},toWorkspaceUri:()=> 'fixture-only:f',normalizeContent:s=>s,contentSha256:sha256};
  const real=new NodeLanguageJournalDurability(assertRealDirectory);let files=0;
  const d:LanguageJournalDurability={policy:real.policy,file:fd=>{files++;assert.equal(fstatSync(fd).isFile(),true);assert.equal(writeSync(fd,Buffer.alloc(0),0,0,0),0);throw error();},directory:p=>real.directory(p)};
  const store=new LanguageShadowStore(owned,codec,d);
  const snapshot={leaseId:'lease',identity:{projectId:'p',sessionId:'s',profileId:'profile',configurationGeneration:'c',providerGeneration:'p',shadowGeneration:'sh',connectionGeneration:'cn',provider:'pylsp' as const,imageId:`sha256:${'a'.repeat(64)}`,toolchainSha256:'b'.repeat(64),dependencyManifestSha256:'c'.repeat(64),analysisSettingsSha256:'d'.repeat(64)},projectRoot:source,files:[{path:'f',bytes:3,sha256:sha256('abc')}],overlays:[],dependencies:null};
  assert.throws(()=>store.materialize('diagnostics',{capture:()=>snapshot,isCurrent:()=>true}),/file flush EPERM/);assert.equal(files,1);assert.equal(readRegular(join(source,'f'),3).toString(),'abc');
});
