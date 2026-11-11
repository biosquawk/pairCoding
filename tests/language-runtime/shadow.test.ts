import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { LanguageShadowStore, type LanguageShadowCodec, type ShadowFile, type ShadowIdentity, type TrustedLanguageSnapshot } from '../../src/server/language/LanguageShadowStore';
import { sha256 } from '../../src/server/language/LanguageProcessJournal';
import type { DocumentStamp } from '../../src/shared/language-v2';

function fixture(t: TestContext) {
  const root = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'shadow-unit-'));
  // Windows also forbids deleting read-only regular files: test cleanup explicitly clears ONLY own outputs.
  const clear = (path: string) => { for (const name of readdirSync(path)) { const p = join(path,name), s=lstatSync(p); if(s.isDirectory()) clear(p); else if(s.isFile()) chmodSync(p,0o644); } };
  t.after(() => { clear(root); rmSync(root, { recursive: true, force: true }); });
  const source = join(root,'source'), owned=join(root,'owned'), deps=join(root,'deps');
  [source,owned,deps].forEach(p=>mkdirSync(p));
  const identity: ShadowIdentity = { projectId:'project',sessionId:'session',profileId:'java21',configurationGeneration:'config',providerGeneration:'provider',
    shadowGeneration:'shadow',connectionGeneration:'connection',provider:'jdt',imageId:`sha256:${'a'.repeat(64)}`,
    toolchainSha256:'b'.repeat(64),dependencyManifestSha256:'c'.repeat(64),analysisSettingsSha256:'d'.repeat(64) };
  // Deliberately FAKE codec, not a production mapper/copy. Only fixture paths are accepted and URIs are NOT LSP URIs.
  // Integration must inject P2_2's frozen single central codec; no URI/normalization semantic PASS is claimed here.
  const allowed = new Set(['Main.java','Other.java','src','src/A.java','lib','lib/a.jar','.paircoach-dependencies','.paircoach-dependencies/lib','.paircoach-dependencies/lib/a.jar',
    'empty','new','new/X.java','MAIN.java','outside.java','.env','.git','node_modules','node_modules/a.js','Main.java/child','A.java','a.java', 'd','d/a.java','con.txt','trail.']);
  const normalizeContent = (s: string) => s === 'draft\r\n😀' ? 'draft\n😀' : s;
  const codec: LanguageShadowCodec = { assertRelativePath: p=>{if(!allowed.has(p)) throw new Error('Fixture codec rejected path');},
    toWorkspaceUri:p=>`fixture-only:${p}`,normalizeContent,contentSha256:s=>sha256(normalizeContent(s)) };
  const store = new LanguageShadowStore(owned,codec);
  const inventory = (files: Record<string,string>): ShadowFile[] => Object.entries(files).map(([path,content])=>({path,bytes:Buffer.byteLength(content),sha256:sha256(content)}));
  const files: Record<string,string> = {'Main.java':'disk main','Other.java':'disk other'};
  for(const [path,content] of Object.entries(files)) writeFileSync(join(source,path),content);
  let snapshot: TrustedLanguageSnapshot = {leaseId:'lease1',identity,projectRoot:source,files:inventory(files),overlays:[],dependencies:null};
  let current = true, calls = 0;
  let checkHook: ((call:number)=>void)|undefined;
  const authority = {capture:()=>snapshot,isCurrent:(s:TrustedLanguageSnapshot)=>{assert.equal(s,snapshot);calls++;checkHook?.(calls);return current;}};
  const stamp = (path='Main.java',content='draft\r\n😀',version=2): DocumentStamp => ({projectId:identity.projectId,sessionId:identity.sessionId,profileId:identity.profileId,configurationGeneration:identity.configurationGeneration,providerGeneration:identity.providerGeneration,shadowGeneration:identity.shadowGeneration,connectionGeneration:identity.connectionGeneration,path,modelLifetime:`model-${path}`,localModelVersion:version,
    baseDocumentVersion:1,documentVersion:null,contentSha256:codec.contentSha256(content),controlEpoch:1,requestGeneration:version});
  return {root,source,owned,deps,store,identity,inventory,codec,authority,stamp, get snapshot(){return snapshot;},set snapshot(s:TrustedLanguageSnapshot){snapshot=s;},
    setCurrent:(v:boolean)=>{current=v;}, hook:(h:(call:number)=>void)=>{checkHook=h;}, calls:()=>calls};
}

test('fresh immutable whole project includes inactive preACK overlays + copied deps; original and excluded secrets untouched',t=>{
  const f=fixture(t);mkdirSync(join(f.source,'empty'));mkdirSync(join(f.deps,'lib'));writeFileSync(join(f.deps,'lib/a.jar'),'pinned jar');
  writeFileSync(join(f.source,'.env'),'secret');mkdirSync(join(f.source,'.git'));mkdirSync(join(f.source,'node_modules'));
  f.snapshot={...f.snapshot,overlays:[{stamp:f.stamp(),content:'draft\r\n😀'},{stamp:f.stamp('Other.java','inactive draft'),content:'inactive draft'}],dependencies:{root:f.deps,files:f.inventory({'lib/a.jar':'pinned jar'})}};
  const a=f.store.materialize('diagnostics',f.authority), b=f.store.materialize('completion',f.authority);
  assert.notEqual(a.launchId,b.launchId);assert.notEqual(a.stateDirectory,b.stateDirectory);assert.notEqual(a.bootDirectory,b.bootDirectory);
  assert.equal(readFileSync(join(a.workspaceDirectory,'Main.java'),'utf8'),'draft\n😀');assert.equal(readFileSync(join(a.workspaceDirectory,'Other.java'),'utf8'),'inactive draft');
  assert.equal(readFileSync(join(a.workspaceDirectory,'.paircoach-dependencies/lib/a.jar'),'utf8'),'pinned jar');
  assert.equal(readFileSync(join(f.source,'Main.java'),'utf8'),'disk main');assert.equal(readFileSync(join(f.source,'.env'),'utf8'),'secret');
  assert.equal(existsSync(join(a.workspaceDirectory,'.env')),false);assert.equal(existsSync(join(a.workspaceDirectory,'node_modules')),false);
  assert.equal(a.manifest.overlays.length,2);assert.equal(a.manifest.overlays[0].documentVersion,null);assert.equal(a.manifest.files[0].origin,'dependency');
  assert.ok(a.manifest.directories.includes('empty'));assert.equal(a.inputManifestSha256,sha256(readFileSync(a.wholeProjectManifestPath)));
  assert.deepEqual(readdirSync(a.stateDirectory),[]);assert.deepEqual(readdirSync(a.bootDirectory),[]);
  assert.throws(()=>{(a.manifest.overlays[0] as any).localModelVersion=99;},TypeError);f.store.assertIntegrity(a);
});
test('mutable refresh keeps mounted root inode stable, replaces ALL overlays/files, invalidates old handle; diagnostic sibling never changes',t=>{
  const f=fixture(t);const a=f.store.materialize('completion',f.authority),d=f.store.materialize('diagnostics',f.authority),inode=lstatSync(a.workspaceDirectory,{bigint:true}).ino;
  rmSync(join(f.source,'Other.java'));mkdirSync(join(f.source,'new'));writeFileSync(join(f.source,'new/X.java'),'created');
  f.snapshot={...f.snapshot,leaseId:'lease2',files:f.inventory({'Main.java':'disk main','new/X.java':'created'}),overlays:[{stamp:f.stamp('Main.java','new draft',3),content:'new draft'}]};
  const b=f.store.refreshCompletion(a,f.authority);assert.equal(b.launchId,a.launchId);assert.equal(lstatSync(b.workspaceDirectory,{bigint:true}).ino,inode);
  assert.equal(existsSync(join(b.workspaceDirectory,'Other.java')),false);assert.equal(readFileSync(join(b.workspaceDirectory,'new/X.java'),'utf8'),'created');
  assert.equal(readFileSync(join(b.workspaceDirectory,'Main.java'),'utf8'),'new draft');assert.notEqual(a.inputManifestSha256,b.inputManifestSha256);
  assert.throws(()=>f.store.assertIntegrity(a),/stale/);f.store.assertIntegrity(b);f.store.assertIntegrity(d);
  assert.equal(readFileSync(join(d.workspaceDirectory,'Other.java'),'utf8'),'disk other');assert.equal(readFileSync(join(d.workspaceDirectory,'Main.java'),'utf8'),'disk main');
  assert.throws(()=>f.store.refreshCompletion(d,f.authority),/Immutable/);
});
test('source inventory missing, wrong hash/size or duplicate cannot publish a partial snapshot',t=>{
  for(const mutate of [(f:ReturnType<typeof fixture>)=>[],(f:ReturnType<typeof fixture>)=>[...f.snapshot.files,{...f.snapshot.files[0]}],
    (f:ReturnType<typeof fixture>)=>f.snapshot.files.map(x=>({...x,sha256:'f'.repeat(64)})),(f:ReturnType<typeof fixture>)=>f.snapshot.files.map(x=>({...x,bytes:x.bytes+1}))]){
    const f=fixture(t);f.snapshot={...f.snapshot,files:mutate(f)};assert.throws(()=>f.store.materialize('diagnostics',f.authority),/inventory\/manifest mismatch/);assert.deepEqual(readdirSync(f.owned),[]);
  }
});
test('external source edits, creates, deletes and empty directory changes during capture reject whole snapshot',t=>{
  for(const mutation of [(f:ReturnType<typeof fixture>)=>writeFileSync(join(f.source,'Main.java'),'changed'),
    (f:ReturnType<typeof fixture>)=>writeFileSync(join(f.source,'new/X.java'),'created'),
    (f:ReturnType<typeof fixture>)=>rmSync(join(f.source,'Other.java')),
    (f:ReturnType<typeof fixture>)=>mkdirSync(join(f.source,'empty'))]){
    const f=fixture(t);mkdirSync(join(f.source,'new'));f.hook(call=>{if(call===3)mutation(f);});
    assert.throws(()=>f.store.materialize('diagnostics',f.authority),/changed during capture/);assert.deepEqual(readdirSync(f.owned),[]);
  }
});
test('prepared dependency inventory is complete and revalidated; no original cache/index sharing',t=>{
  for(const stage of ['before','during'] as const){const f=fixture(t);mkdirSync(join(f.deps,'lib'));writeFileSync(join(f.deps,'lib/a.jar'),'old');
    f.snapshot={...f.snapshot,dependencies:{root:f.deps,files:f.inventory({'lib/a.jar':'old'})}};
    if(stage==='before')writeFileSync(join(f.deps,'lib/a.jar'),'new');else f.hook(call=>{if(call===3)writeFileSync(join(f.deps,'lib/a.jar'),'new');});
    assert.throws(()=>f.store.materialize('diagnostics',f.authority),stage==='before'?/manifest mismatch/:/dependencies changed/);assert.deepEqual(readdirSync(f.owned),[]);
  }
});
test('stale trusted authority rejects before copy and after copy (including newer inactive drafts)',t=>{
  for(const at of [1,2,3,4,5]){const f=fixture(t);f.hook(call=>{if(call===at)f.setCurrent(false);});
    assert.throws(()=>f.store.materialize('diagnostics',f.authority),/Stale/);assert.deepEqual(readdirSync(f.owned),[]);
  }
});
test('overlay content/hash/scope/version/path mismatches reject, never infer ACK or write disk',t=>{
  const cases=[(s:DocumentStamp)=>({...s,projectId:'foreign'}),(s:DocumentStamp)=>({...s,connectionGeneration:'old'}),
    (s:DocumentStamp)=>({...s,shadowGeneration:'old'}),(s:DocumentStamp)=>({...s,localModelVersion:0}),
    (s:DocumentStamp)=>({...s,documentVersion:0}),(s:DocumentStamp)=>({...s,contentSha256:'e'.repeat(64)}),
    (s:DocumentStamp)=>({...s,path:'outside.java'})];
  for(const change of cases){const f=fixture(t);f.snapshot={...f.snapshot,overlays:[{stamp:change(f.stamp()),content:'draft\r\n😀'}]};
    assert.throws(()=>f.store.materialize('diagnostics',f.authority),/Overlay|overlay/);assert.equal(readFileSync(join(f.source,'Main.java'),'utf8'),'disk main');assert.deepEqual(readdirSync(f.owned),[]);
  }
  const f=fixture(t);f.snapshot={...f.snapshot,overlays:[{stamp:f.stamp(),content:'draft\r\n😀'},{stamp:f.stamp(),content:'draft\r\n😀'}]};
  assert.throws(()=>f.store.materialize('completion',f.authority),/duplicate/);
});
test('real source/ancestor/dependency symlinks and hardlinks fail independently of trusted manifest',t=>{
  for(const kind of ['filelink','hardlink','ancestor','dependency'] as const){const f=fixture(t);
    if(kind==='filelink'){rmSync(join(f.source,'Main.java'));symlinkSync(join(f.source,'Other.java'),join(f.source,'Main.java'));}
    if(kind==='hardlink'){rmSync(join(f.source,'Main.java'));linkSync(join(f.source,'Other.java'),join(f.source,'Main.java'));}
    if(kind==='ancestor'){renameSync(f.source,`${f.source}-real`);symlinkSync(`${f.source}-real`,f.source);}
    if(kind==='dependency'){symlinkSync(join(f.source,'Main.java'),join(f.deps,'Main.java'));f.snapshot={...f.snapshot,dependencies:{root:f.deps,files:[]}};}
    assert.throws(()=>f.store.materialize('diagnostics',f.authority),/Unsafe|directory\/link/);assert.deepEqual(readdirSync(f.owned),[]);
  }
});
test('source case collisions and linked excluded directories are rejected rather than followed',t=>{
  const f=fixture(t);writeFileSync(join(f.source,'MAIN.java'),'collision');assert.throws(()=>f.store.materialize('diagnostics',f.authority),/collision/);
  rmSync(join(f.source,'MAIN.java'));symlinkSync(f.deps,join(f.source,'node_modules'));assert.throws(()=>f.store.materialize('diagnostics',f.authority),/link/);
});
test('URI codec is mandatory injected authority, unsafe paths are not opened and never second-decoded',t=>{
  const f=fixture(t);f.snapshot={...f.snapshot,files:[{path:'../outside',bytes:0,sha256:sha256('')}]};
  assert.throws(()=>f.store.materialize('diagnostics',f.authority),/Fixture codec/);assert.deepEqual(readdirSync(f.owned),[]);
});
test('manifest tampering, copy tampering/extra files and foreign handle are never diagnostic proof',t=>{
  for(const mutation of [(f:ReturnType<typeof fixture>,s:ReturnType<LanguageShadowStore['materialize']>)=>{chmodSync(s.wholeProjectManifestPath,0o644);writeFileSync(s.wholeProjectManifestPath,'{}');},
    (f:ReturnType<typeof fixture>,s:ReturnType<LanguageShadowStore['materialize']>)=>{const p=join(s.workspaceDirectory,'Main.java');chmodSync(p,0o644);writeFileSync(p,'tampered');},
    (f:ReturnType<typeof fixture>,s:ReturnType<LanguageShadowStore['materialize']>)=>writeFileSync(join(s.workspaceDirectory,'A.java'),'extra')]){
    const f=fixture(t),s=f.store.materialize('diagnostics',f.authority);assert.throws(()=>f.store.assertIntegrity({...s}),/Unknown/);mutation(f,s);
    assert.throws(()=>f.store.assertIntegrity(s),/mismatch/);assert.throws(()=>f.store.assertIntegrity(s),/poisoned/);
  }
});
test('refresh forbids scope/dependency identity changes and retains previous valid bytes',t=>{
  const f=fixture(t),s=f.store.materialize('completion',f.authority);f.snapshot={...f.snapshot,identity:{...f.identity,dependencyManifestSha256:'e'.repeat(64)}};
  assert.throws(()=>f.store.refreshCompletion(s,f.authority),/retire/);f.store.assertIntegrity(s);assert.equal(readFileSync(join(s.workspaceDirectory,'Main.java'),'utf8'),'disk main');
});
test('failed in-place mutable refresh poisons handle; no false new manifest and diagnostics remain untouched',t=>{
  const f=fixture(t),s=f.store.materialize('completion',f.authority),d=f.store.materialize('diagnostics',f.authority),start=f.calls();
  f.snapshot={...f.snapshot,leaseId:'next',overlays:[{stamp:f.stamp(),content:'draft\r\n😀'}]};
  f.hook(call=>{if(call===start+5)f.setCurrent(false);});
  assert.throws(()=>f.store.refreshCompletion(s,f.authority),/Stale/);assert.throws(()=>f.store.assertIntegrity(s),/poisoned/);f.store.assertIntegrity(d);
});
test('source/copy/dependency root overlaps rejected before creating a launch',t=>{
  for(const kind of ['source','deps'] as const){const f=fixture(t);f.snapshot=kind==='source'?{...f.snapshot,projectRoot:f.root}:{...f.snapshot,dependencies:{root:f.source,files:f.snapshot.files}};
    assert.throws(()=>f.store.materialize('diagnostics',f.authority),/isolated|separate/);assert.deepEqual(readdirSync(f.owned),[]);
  }
});


test('changed prepared dependency bytes cannot refresh old mutable index even with unchanged claimed dependency identity',t=>{
  const f=fixture(t);mkdirSync(join(f.deps,'lib'));writeFileSync(join(f.deps,'lib/a.jar'),'old');
  f.snapshot={...f.snapshot,dependencies:{root:f.deps,files:f.inventory({'lib/a.jar':'old'})}};
  const s=f.store.materialize('completion',f.authority);writeFileSync(join(f.deps,'lib/a.jar'),'new');
  f.snapshot={...f.snapshot,dependencies:{root:f.deps,files:f.inventory({'lib/a.jar':'new'})}};
  assert.throws(()=>f.store.refreshCompletion(s,f.authority),/dependency bytes changed/);f.store.assertIntegrity(s);
  assert.equal(readFileSync(join(s.workspaceDirectory,'.paircoach-dependencies/lib/a.jar'),'utf8'),'old');
});
test('target Windows device/trailing-dot names and oversized source rejected without opening/publishing unsafe output',t=>{
  for(const name of ['con.txt','trail.']){const f=fixture(t);writeFileSync(join(f.source,name),'x');assert.throws(()=>f.store.materialize('diagnostics',f.authority),/target filesystem/);assert.deepEqual(readdirSync(f.owned),[]);}
  const f=fixture(t);writeFileSync(join(f.source,'Main.java'),Buffer.alloc(4*1024*1024+1));assert.throws(()=>f.store.materialize('diagnostics',f.authority),/oversize/);assert.deepEqual(readdirSync(f.owned),[]);
});
