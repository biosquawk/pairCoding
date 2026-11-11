import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { constants, fsyncSync, fstatSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DiskLanguageProcessJournal, assertRealDirectory, type LanguageProcessIntent } from '../../src/server/language/LanguageProcessJournal';
import { NodeLanguageJournalDurability, type JournalSyncIO, type LanguageJournalDurability } from '../../src/server/language/LanguageJournalDurability';

function fixture(t: TestContext) {const root=mkdtempSync(join(process.env.TMPDIR??tmpdir(),'journal-sync-'));t.after(()=>rmSync(root,{recursive:true,force:true}));return root;}
const failure = (code: string) => Object.assign(new Error(code),{code});
function fakeIO(fail: string, where: 'open'|'sync'='sync') {
  const events: string[]=[];const io: JournalSyncIO={open:(_path,flags)=>{events.push('open');assert.equal(flags,constants.O_RDONLY);if(where==='open')throw failure(fail);return 7;},
    sync:fd=>{events.push(`sync:${fd}`);if(where==='sync')throw failure(fail);},close:fd=>{events.push(`close:${fd}`);}};return {io,events};
}
test('Win32 seam tolerates ONLY unavailable DIRECTORY fsync and closes opened handles',t=>{
  const root=fixture(t);
  for(const code of ['EPERM','EACCES','EINVAL','EISDIR','EBADF'])for(const where of ['open','sync'] as const){const f=fakeIO(code,where),d=new NodeLanguageJournalDurability(assertRealDirectory,'win32',f.io);
    assert.equal(d.policy,'WIN32_FILE_FSYNC_RENAME_READBACK');d.directory(root);
    assert.deepEqual(f.events,where==='open'?['open']:['open','sync:7','close:7']);
  }
});
test('Win32 file flush propagates same EPERM that directory policy tolerates; no blanket ignore',()=>{
  for(const code of ['EPERM','EACCES','EINVAL','EISDIR','EBADF','EIO']){const f=fakeIO(code),d=new NodeLanguageJournalDurability(assertRealDirectory,'win32',f.io);
    assert.throws(()=>d.file(7),e=>(e as NodeJS.ErrnoException).code===code);assert.deepEqual(f.events,['sync:7']);
  }
});
test('POSIX directory failures and unknown Win32 failures always propagate (including close failure)',t=>{
  const root=fixture(t);
  for(const platform of ['linux','win32'] as const){const f=fakeIO(platform==='linux'?'EPERM':'EIO');assert.throws(()=>new NodeLanguageJournalDurability(assertRealDirectory,platform,f.io).directory(root));assert.equal(f.events.at(-1),'close:7');}
  const f=fakeIO('EPERM');f.io.close=()=>{throw failure('EIO');};assert.throws(()=>new NodeLanguageJournalDurability(assertRealDirectory,'win32',f.io).directory(root),/EIO/);
});
test('directory path ancestry/link validation precedes unsupported Win32 primitive tolerance',t=>{
  const root=fixture(t),real=join(root,'real'),link=join(root,'link');mkdirSync(real);symlinkSync(real,link);
  const f=fakeIO('EPERM'),d=new NodeLanguageJournalDurability(assertRealDirectory,'win32',f.io);assert.throws(()=>d.directory(link),/directory\/link/);assert.deepEqual(f.events,[]);
});
test('real journal initial and IDEMPOTENT records flush through writable regular-file handles, never read-only',t=>{
  const root=fixture(t),id=randomUUID();let files=0,dirs=0;
  const real=new NodeLanguageJournalDurability(assertRealDirectory);
  const durability:LanguageJournalDurability={policy:real.policy,file:fd=>{assert.ok(fstatSync(fd).isFile());
    // Zero-length write at position 0 cannot modify bytes, but EBADF catches O_RDONLY descriptors on POSIX.
    assert.equal(writeSync(fd,Buffer.alloc(0),0,0,0),0);fsyncSync(fd);files++;},directory:p=>{real.directory(p);dirs++;}};
  const j=new DiskLanguageProcessJournal(root,durability),intent={launchId:id,schemaVersion:1,name:'fixture-intent'} as LanguageProcessIntent;
  j.putIntent(intent);j.putIntent(intent);assert.equal(files,2);assert.ok(dirs>=4);assert.deepEqual(j.readIntent(id),intent);
  assert.equal(j.durabilityPolicy,real.policy);assert.deepEqual(JSON.parse(readFileSync(join(root,id,'intent.json'),'utf8')),intent);
});
test('journal new record flush error is not accepted; retry reconciles preserved state before progress',t=>{
  const root=fixture(t),id=randomUUID(),real=new NodeLanguageJournalDurability(assertRealDirectory);let fail=true;
  const d:LanguageJournalDurability={policy:'WIN32_FILE_FSYNC_RENAME_READBACK',file:fd=>{if(fail)throw failure('EPERM');real.file(fd);},directory:p=>real.directory(p)};
  const j=new DiskLanguageProcessJournal(root,d),intent={launchId:id,schemaVersion:1} as LanguageProcessIntent;
  assert.throws(()=>j.putIntent(intent),/EPERM/);assert.throws(()=>j.readIntent(id),/ENOENT/);fail=false;j.putIntent(intent);assert.deepEqual(j.readIntent(id),intent);
});
test('idempotent record flush and directory flush failures propagate rather than granting next Docker mutation',t=>{
  const root=fixture(t),id=randomUUID(),real=new NodeLanguageJournalDurability(assertRealDirectory);let which='none';
  const d:LanguageJournalDurability={policy:real.policy,file:fd=>{if(which==='file')throw failure('EPERM');real.file(fd);},directory:p=>{if(which==='dir')throw failure('EIO');real.directory(p);}};
  const j=new DiskLanguageProcessJournal(root,d),intent={launchId:id,schemaVersion:1} as LanguageProcessIntent;j.putIntent(intent);
  which='file';assert.throws(()=>j.putIntent(intent),/EPERM/);which='dir';assert.throws(()=>j.putIntent(intent),/EIO/);which='none';j.putIntent(intent);
});
test('tampered receipt bytes are preserved and conflict remains failure under portable durability policy',t=>{
  const root=fixture(t),id=randomUUID(),j=new DiskLanguageProcessJournal(root),intent={launchId:id,schemaVersion:1,name:'before'} as LanguageProcessIntent;
  j.putIntent(intent);assert.throws(()=>j.putIntent({...intent,name:'after!'}),/conflict/);assert.deepEqual(j.readIntent(id),intent);
  writeFileSync(join(root,id,'intent.json'),'tampered');assert.throws(()=>j.putIntent(intent));assert.equal(readFileSync(join(root,id,'intent.json'),'utf8'),'tampered');
});
