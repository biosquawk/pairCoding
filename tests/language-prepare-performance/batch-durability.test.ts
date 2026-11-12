/** HOST filesystem regression only. No Docker/provider/backend semantic claim. */
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { LanguageShadowStore, type TrustedLanguageSnapshot } from '../../src/server/language/LanguageShadowStore';
import { NodeLanguageJournalDurability, type LanguageJournalDurability } from '../../src/server/language/LanguageJournalDurability';
import { assertRealDirectory, sha256 } from '../../src/server/language/LanguageProcessJournal';
import * as codec from '../../src/language/uriCodec';
function fixture(t: TestContext) {
  const root = fs.mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'language-batch-'));
  t.after(() => { const clear=(p:string):void=>{for(const e of fs.readdirSync(p,{withFileTypes:true})) {const f=join(p,e.name);if(e.isDirectory())clear(f);else if(e.isFile())fs.chmodSync(f,0o600);}}; clear(root);fs.rmSync(root,{recursive:true,force:true}); });
  const project=join(root,'project'), owned=join(root,'owned');
  for(const p of [project,owned])fs.mkdirSync(p,{mode:0o700});
  for(const p of ['nested','nested/empty'])fs.mkdirSync(join(project,p));
  const content='print("original")\n';for(const p of ['main.py','nested/a.py','nested/b.py'])fs.writeFileSync(join(project,p),content);
  const events:{kind:'file'|'directory';path:string}[]=[];
  let hook:(kind:'file'|'directory',path:string)=>void=()=>{};
  const real=new NodeLanguageJournalDurability(assertRealDirectory);
  const durability:LanguageJournalDurability={policy:real.policy,file(fd){real.file(fd);events.push({kind:'file',path:''});hook('file','');},directory(path){real.directory(path);events.push({kind:'directory',path});hook('directory',path);}};
  const store=new LanguageShadowStore(owned,codec,durability), disk=store.captureSource(project);
  const identity={projectId:'p',sessionId:'s',profileId:'python-3.13',configurationGeneration:'cfg',providerGeneration:'provider',shadowGeneration:'shadow',connectionGeneration:'conn',provider:'pylsp' as const,imageId:'sha256:'+'a'.repeat(64),toolchainSha256:'b'.repeat(64),dependencyManifestSha256:'c'.repeat(64),analysisSettingsSha256:'d'.repeat(64)};
  const snapshot:TrustedLanguageSnapshot={leaseId:'actual-host-fixture-lease',identity,projectRoot:project,files:disk.files,overlays:[],dependencies:null};
  let held=true;
  const frozen=structuredClone(snapshot);
  const authority={capture:()=>snapshot,isCurrent:(s:TrustedLanguageSnapshot)=>{assert.ok(held,'same held lease');disk.assertCurrent();return JSON.stringify(snapshot)===JSON.stringify(frozen)&&JSON.stringify(s)===JSON.stringify(snapshot);}};
  return {root,project,owned,store,snapshot,authority,events,hook:(f:typeof hook)=>{hook=f;},release:()=>{held=false;}};
}
test('fresh batch flushes every file and every mutated directory bottom-up before manifest publication',t=>{
  const f=fixture(t),shadow=f.store.materialize('completion',f.authority);
  const files=f.events.filter(e=>e.kind==='file');assert.equal(files.length,shadow.manifest.files.length+1,'every source + manifest file fsync retained');
  const dirs=f.events.filter(e=>e.kind==='directory').map(e=>relative(dirname(shadow.workspaceDirectory),e.path));
  assert.ok(dirs.indexOf('workspace/nested/empty')<dirs.indexOf('workspace/nested'));
  assert.ok(dirs.indexOf('workspace/nested')<dirs.indexOf('workspace'));
  for(const p of ['workspace/nested/empty','workspace/nested','workspace','boot','state'])assert.equal(dirs.filter(d=>d===p).length,1,p+' flushed once');
  assert.equal(f.events.at(-1)?.kind,'directory','manifest parent flush retained');
  const firstFlush=f.events.findIndex(e=>e.kind==='directory');assert.equal(firstFlush,shadow.manifest.files.length,'no file omitted or directory published early');
  f.store.assertIntegrity(shadow);
});
for(const effect of ['file-error','directory-error','source-change','lease-release','overlay-change','output-file-tamper','output-directory-replace'] as const) {
  test('unlaunched batch rejects '+effect+' without publishing manifest/handle',t=>{
    const f=fixture(t);let applied=false;
    f.hook((kind,path)=>{
      if(applied||kind!==(effect==='directory-error'||effect==='output-directory-replace'||effect==='output-file-tamper'?'directory':'file'))return;applied=true;
      if(effect==='file-error'||effect==='directory-error')throw Error('injected durable failure');
      if(effect==='source-change')fs.writeFileSync(join(f.project,'nested/b.py'),'externally changed');
      if(effect==='lease-release')f.release();
      if(effect==='overlay-change')f.snapshot.overlays=[{stamp:{...f.snapshot.identity,path:'main.py',modelLifetime:'life',localModelVersion:1,requestGeneration:1,controlEpoch:0,baseDocumentVersion:1,documentVersion:null,contentSha256:sha256('draft')},content:'draft'}];
      if(effect==='output-file-tamper') {
        const launch=fs.readdirSync(f.owned)[0],file=join(f.owned,launch,'workspace/main.py');
        assert.ok(fs.existsSync(file),'tamper the actual already-written copy');fs.chmodSync(file,0o600);fs.writeFileSync(file,'tamper');
      }
      if(effect==='output-directory-replace') {fs.renameSync(path,path+'-old');fs.mkdirSync(path);}
    });
    assert.throws(()=>f.store.materialize('completion',f.authority));assert.ok(applied);assert.deepEqual(fs.readdirSync(f.owned),[],'no unlaunched tree retained as authority');
  });
}
test('post-publication same-byte replacement, content tamper and new empty directory are each rejected',t=>{
  for(const change of ['replace','bytes','empty'] as const){
    const f=fixture(t),shadow=f.store.materialize('completion',f.authority),file=join(shadow.workspaceDirectory,'main.py');
    if(change==='replace'){fs.chmodSync(file,0o600);fs.unlinkSync(file);fs.symlinkSync(join(f.project,'main.py'),file);}
    if(change==='bytes'){fs.chmodSync(file,0o600);fs.writeFileSync(file,'changed');}
    if(change==='empty')fs.mkdirSync(join(shadow.workspaceDirectory,'new-empty'));
    assert.throws(()=>f.store.assertIntegrity(shadow));
  }
});
test('active completion refresh retains per-file directory durability, not the new-tree batching path',t=>{
  const f=fixture(t),shadow=f.store.materialize('completion',f.authority);
  const retained=join(shadow.workspaceDirectory,'nested/a.py'),before=fs.statSync(retained,{bigint:true}),bytes=fs.readFileSync(retained);
  const snapshot:TrustedLanguageSnapshot={...f.snapshot,overlays:[{stamp:{...f.snapshot.identity,path:'main.py',modelLifetime:'life',localModelVersion:1,requestGeneration:1,controlEpoch:0,baseDocumentVersion:1,documentVersion:null,contentSha256:sha256('draft')},content:'draft'}]};
  const expected=JSON.stringify(snapshot);
  const authority={capture:()=>snapshot,isCurrent:(s:TrustedLanguageSnapshot)=>f.authority.isCurrent(f.snapshot)&&JSON.stringify(s)===expected&&JSON.stringify(snapshot)===expected};
  f.events.length=0;
  const next=f.store.refreshCompletion(shadow,authority);
  assert.equal(f.events.filter(e=>e.kind==='file').length,2,'changed file + authoritative manifest, NOT all retained files');
  assert.equal(f.events.filter(e=>e.kind==='directory').length,2,'changed-file parent + manifest parent flushed');
  assert.deepEqual(fs.statSync(retained,{bigint:true}),before,'retained inode/mode/mtime unchanged');
  assert.deepEqual(fs.readFileSync(retained),bytes);f.store.assertIntegrity(next);
});
