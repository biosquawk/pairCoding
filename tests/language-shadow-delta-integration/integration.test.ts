/** Native Linux/WSL synthetic disk+durability integration, NOT actualGate/Docker/backend proof. */
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { dirname, join, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { LanguageShadowStore, LANGUAGE_DEPENDENCY_DIRECTORY as DEPS, type TrustedLanguageSnapshot } from '../../src/server/language/LanguageShadowStore';
import { NodeLanguageJournalDurability, type LanguageJournalDurability } from '../../src/server/language/LanguageJournalDurability';
import { assertRealDirectory, sha256 } from '../../src/server/language/LanguageProcessJournal';
import * as codec from '../../src/language/uriCodec';
type Event={kind:string;path:string;sha256?:string};
function fixture(t:TestContext) {
  const root=fs.mkdtempSync(join(process.env.TMPDIR??tmpdir(),'delta-integration-'));
  const project=join(root,'project'),owned=join(root,'owned'),deps=join(root,'deps');
  for(const p of [project,owned,deps])fs.mkdirSync(p,{mode:0o700});
  for(const d of ['nested','nested/empty'])fs.mkdirSync(join(project,d));
  for(const [p,b] of Object.entries({'main.py':'main\n','inactive.py':'inactive\n','stable.py':'stable\n','nested/keep.py':'keep\n'}))fs.writeFileSync(join(project,p),b);
  fs.mkdirSync(join(deps,'lib'));fs.writeFileSync(join(deps,'lib/a.jar'),'dependency bytes');
  t.after(()=>{const clear=(p:string):void=>{for(const e of fs.readdirSync(p,{withFileTypes:true})){const f=join(p,e.name);if(e.isDirectory())clear(f);else if(e.isFile())fs.chmodSync(f,0o600);}};clear(root);fs.rmSync(root,{recursive:true,force:true});});
  const events:Event[]=[];let hook:(e:Event)=>void=()=>{};
  const real=new NodeLanguageJournalDurability(assertRealDirectory);
  const event=(e:Event):void=>{events.push(e);hook(e);};
  const durability:LanguageJournalDurability={policy:real.policy,file(fd){real.file(fd);event({kind:'fileflush',path:fs.readlinkSync('/proc/self/fd/'+fd)});},directory(path){real.directory(path);event({kind:'dirflush',path});}};
  const store=new LanguageShadowStore(owned,codec,durability);
  const identity={projectId:'p',sessionId:'s',profileId:'python-3.13',configurationGeneration:'cfg',providerGeneration:'provider',shadowGeneration:'shadow',connectionGeneration:'conn',provider:'pylsp' as const,imageId:'sha256:'+'a'.repeat(64),toolchainSha256:'b'.repeat(64),dependencyManifestSha256:'c'.repeat(64),analysisSettingsSha256:'d'.repeat(64)};
  const snapshot:TrustedLanguageSnapshot={leaseId:'lease-1',identity,projectRoot:project,files:[],overlays:[],dependencies:{root:deps,files:[]}};
  let held=true,expected='',source=store.captureSource(project),dependencies=store.captureSource(deps),checks=0;
  const reset=()=>{source=store.captureSource(project);dependencies=store.captureSource(deps);snapshot.files=source.files;snapshot.dependencies={root:deps,files:dependencies.files};expected=JSON.stringify(snapshot);};reset();
  const authority={capture:()=>snapshot,isCurrent:(s:TrustedLanguageSnapshot)=>{checks++;source.assertCurrent();dependencies.assertCurrent();return held&&JSON.stringify(s)===expected&&JSON.stringify(snapshot)===expected;}};
  const overlay=(path:string,content:string,version=1)=>{snapshot.overlays=[...snapshot.overlays.filter(o=>o.stamp.path!==path),{content,stamp:{...identity,path,modelLifetime:'life-'+path,localModelVersion:version,requestGeneration:version,controlEpoch:0,baseDocumentVersion:1,documentVersion:null,contentSha256:codec.contentSha256(content)}}];};
  const shadow=store.materialize('completion',authority);events.length=0;
  return {root,project,owned,deps,store,snapshot,shadow,authority,events,reset,overlay,checks:()=>checks,release:()=>{held=false;},hook:(h:typeof hook)=>{hook=h;},event};
}
function witness(path:string) {const s=fs.lstatSync(path,{bigint:true});return {dev:s.dev.toString(),ino:s.ino.toString(),mode:s.mode.toString(),mtimeNs:s.mtimeNs.toString(),bytes:fs.readFileSync(path).toString('base64'),sha256:sha256(fs.readFileSync(path))};}
function dirWitness(path:string) {const s=fs.lstatSync(path,{bigint:true});return {dev:s.dev.toString(),ino:s.ino.toString()};}
/** Explicit fixture seam, all successful calls forward actual native primitives. Restored per test. */
function nativeObserver(t:TestContext,event:(e:Event)=>void,fail?:'write'|'rename') {
  const write=fs.writeFileSync,rename=fs.renameSync,chmod=fs.chmodSync,unlink=fs.unlinkSync,rmdir=fs.rmdirSync,mkdir=fs.mkdirSync;
  fs.writeFileSync=((...args:Parameters<typeof fs.writeFileSync>)=>{const path=typeof args[0]==='number'?fs.readlinkSync('/proc/self/fd/'+args[0]):String(args[0]);if(fail==='write')throw Error('injected write');write(...args);event({kind:'write',path,sha256:sha256(Buffer.isBuffer(args[1])?args[1]:String(args[1]))});}) as typeof fs.writeFileSync;
  fs.renameSync=((a,b)=>{if(fail==='rename')throw Error('injected rename');rename(a,b);event({kind:'rename',path:String(b)});}) as typeof fs.renameSync;
  fs.chmodSync=((p,m)=>{chmod(p,m);event({kind:'chmod',path:String(p)});}) as typeof fs.chmodSync;
  fs.unlinkSync=((p)=>{unlink(p);event({kind:'unlink',path:String(p)});}) as typeof fs.unlinkSync;
  fs.rmdirSync=((p,...args)=>{rmdir(p,...args);event({kind:'rmdir',path:String(p)});}) as typeof fs.rmdirSync;
  fs.mkdirSync=((p,...args)=>{const result=mkdir(p,...args);event({kind:'mkdir',path:String(p)});return result;}) as typeof fs.mkdirSync;
  syncBuiltinESMExports();t.after(()=>{fs.writeFileSync=write;fs.renameSync=rename;fs.chmodSync=chmod;fs.unlinkSync=unlink;fs.rmdirSync=rmdir;fs.mkdirSync=mkdir;syncBuiltinESMExports();});
}
function poisoned(f:ReturnType<typeof fixture>) {assert.throws(()=>f.store.assertIntegrity(f.shadow),/poisoned|stale/);assert.throws(()=>f.store.refreshCompletion(f.shadow,f.authority),/poisoned|stale/);}
test('one overlay delta retains complete unchanged source/dependency entry witnesses and flushes only changed file + manifest',t=>{
  const f=fixture(t),ws=f.shadow.workspaceDirectory;
  const keep=['stable.py','inactive.py','nested/keep.py',DEPS+'/lib/a.jar'];
  const before=keep.map(p=>witness(join(ws,p))),dirs=['','nested','nested/empty',DEPS,DEPS+'/lib'];
  const directoryBefore=dirs.map(p=>dirWitness(join(ws,p)));
  f.overlay('main.py','draft\n');f.reset();nativeObserver(t,f.event);
  const next=f.store.refreshCompletion(f.shadow,f.authority);
  assert.deepEqual(keep.map(p=>witness(join(ws,p))),before);
  assert.deepEqual(dirs.map(p=>dirWitness(join(ws,p))),directoryBefore);
  assert.equal(fs.readFileSync(join(ws,'main.py'),'utf8'),'draft\n');
  assert.deepEqual(f.events.filter(e=>e.kind==='rename').map(e=>e.path),[join(ws,'main.py'),next.wholeProjectManifestPath]);
  assert.ok(keep.every(p=>!f.events.some(e=>e.path===join(ws,p))),'NO retained-path mutation, even no-op chmod');
  assert.equal(f.events.filter(e=>e.kind==='write').length,2);assert.equal(f.events.filter(e=>e.kind==='fileflush').length,2);
  assert.deepEqual(f.events.filter(e=>e.kind==='dirflush').map(e=>e.path),[ws,dirname(ws)]);
  assert.ok(f.events.every(e=>!e.path.startsWith(f.project)&&!e.path.startsWith(f.deps)),'no original writes/flushes');
  for(const target of [join(ws,'main.py'),next.wholeProjectManifestPath]) {const ri=f.events.findIndex(e=>e.kind==='rename'&&e.path===target);assert.equal(f.events[ri-1].kind,'fileflush');assert.deepEqual(f.events[ri+1],{kind:'dirflush',path:dirname(target)});}
  console.log('DELTA_WITNESS '+JSON.stringify({before,after:keep.map(p=>witness(join(ws,p))),events:f.events,manifestHash:next.inputManifestSha256}));
  f.store.assertIntegrity(next);assert.throws(()=>f.store.assertIntegrity(f.shadow),/stale/);
});
test('metadata-only refresh mutates no content but publishes NEW durable manifest and rechecks full authority',t=>{
  const f=fixture(t),ws=f.shadow.workspaceDirectory,before=f.shadow.manifest.files.map(p=>witness(join(ws,p.path)));
  f.overlay('main.py','main\n',2);f.snapshot.leaseId='lease-2';f.reset();const checks=f.checks();nativeObserver(t,f.event);
  const next=f.store.refreshCompletion(f.shadow,f.authority);
  assert.notEqual(next.inputManifestSha256,f.shadow.inputManifestSha256);assert.equal(next.manifest.overlays[0].localModelVersion,2);
  assert.deepEqual(next.manifest.files.map(p=>witness(join(ws,p.path))),before);
  assert.deepEqual(f.events.filter(e=>e.kind==='rename').map(e=>e.path),[next.wholeProjectManifestPath]);
  assert.ok(!f.events.some(e=>['chmod','unlink','rmdir','mkdir'].includes(e.kind)),'metadata-only never touches content entries');
  assert.equal(f.events.filter(e=>e.kind==='fileflush').length,1);assert.deepEqual(f.events.filter(e=>e.kind==='dirflush').map(e=>e.path),[dirname(ws)]);
  assert.ok(f.checks()-checks>=5,'full held authority rechecked even without physical delta');f.store.assertIntegrity(next);
});
test('add/remove/inactive disk edit/new empty directory and both file-directory transitions are ordered durably',t=>{
  const f=fixture(t),ws=f.shadow.workspaceDirectory,stable=witness(join(ws,'stable.py')),root=dirWitness(ws),nested=dirWitness(join(ws,'nested'));
  // main.py file -> directory; nested/empty directory -> file; remove nested/keep.py and add a new subtree.
  fs.unlinkSync(join(f.project,'main.py'));fs.mkdirSync(join(f.project,'main.py'));fs.mkdirSync(join(f.project,'main.py/empty'));
  fs.rmdirSync(join(f.project,'nested/empty'));fs.writeFileSync(join(f.project,'nested/empty'),'was a dir');
  fs.unlinkSync(join(f.project,'nested/keep.py'));fs.writeFileSync(join(f.project,'inactive.py'),'inactive edited');
  fs.mkdirSync(join(f.project,'new'));fs.mkdirSync(join(f.project,'new/empty'));fs.writeFileSync(join(f.project,'new/added.py'),'added');
  f.reset();nativeObserver(t,f.event);const next=f.store.refreshCompletion(f.shadow,f.authority);
  assert.equal(fs.readFileSync(join(ws,'inactive.py'),'utf8'),'inactive edited');assert.ok(fs.statSync(join(ws,'main.py/empty')).isDirectory());
  assert.equal(fs.readFileSync(join(ws,'nested/empty'),'utf8'),'was a dir');assert.ok(!fs.existsSync(join(ws,'nested/keep.py')));
  assert.deepEqual(witness(join(ws,'stable.py')),stable);assert.deepEqual(dirWitness(ws),root);assert.deepEqual(dirWitness(join(ws,'nested')),nested);
  const flushes=f.events.filter(e=>e.kind==='dirflush').map(e=>relative(ws,e.path));
  for(const p of ['','nested','main.py','main.py/empty','new','new/empty','..'])assert.ok(flushes.includes(p),'flushed '+p);
  assert.equal(f.events.filter(e=>e.kind==='fileflush').length,4,'3 changed files + manifest');
  assert.ok(flushes.indexOf('main.py')<flushes.indexOf('main.py/empty'),'create parents first');
  for(const [i,e] of f.events.entries()) {
    if(['unlink','rmdir','rename'].includes(e.kind))assert.deepEqual(f.events[i+1],{kind:'dirflush',path:dirname(e.path)},'EVERY removed/replaced directory entry is flushed');
    if(e.kind==='mkdir'){assert.deepEqual(f.events[i+1],{kind:'dirflush',path:e.path});assert.deepEqual(f.events[i+2],{kind:'dirflush',path:dirname(e.path)});}
  }
  f.store.assertIntegrity(next);
});
for(const effect of ['retained-bytes','empty-dir','dependency-bytes','source-empty-dir','symlink'] as const) test('preproof rejects '+effect+' including empty physical delta',t=>{
  const f=fixture(t),ws=f.shadow.workspaceDirectory;
  if(effect==='retained-bytes'){fs.chmodSync(join(ws,'stable.py'),0o600);fs.writeFileSync(join(ws,'stable.py'),'BAD!!!');}
  if(effect==='empty-dir')fs.mkdirSync(join(ws,'unexpected'));
  if(effect==='dependency-bytes'){fs.writeFileSync(join(f.deps,'lib/a.jar'),'changed');f.reset();}
  if(effect==='source-empty-dir')fs.mkdirSync(join(f.project,'new-empty'));
  if(effect==='symlink'){fs.unlinkSync(join(ws,'stable.py'));fs.symlinkSync(join(f.project,'stable.py'),join(ws,'stable.py'));}
  nativeObserver(t,f.event);assert.throws(()=>f.store.refreshCompletion(f.shadow,f.authority));assert.equal(f.events.length,0,'no mutation before complete proof');
});
for(const effect of ['retained-bytes','empty-dir','source','dependency','inactive-overlay','lease','parent-replace','root-replace'] as const) test('postmutation '+effect+' rejects successful return and poisons SAME handle',t=>{
  const f=fixture(t),ws=f.shadow.workspaceDirectory;f.overlay('main.py','draft');f.overlay('inactive.py','inactive draft');f.reset();let applied=false;
  f.hook(e=>{if(applied||e.kind!=='fileflush')return;applied=true;
    if(effect==='retained-bytes'){fs.chmodSync(join(ws,'stable.py'),0o600);fs.writeFileSync(join(ws,'stable.py'),'tamper');}
    if(effect==='empty-dir')fs.mkdirSync(join(ws,'unexpected'));
    if(effect==='source')fs.writeFileSync(join(f.project,'stable.py'),'source changed');
    if(effect==='dependency')fs.writeFileSync(join(f.deps,'lib/a.jar'),'dependency changed');
    if(effect==='inactive-overlay')f.overlay('inactive.py','raced overlay',2);
    if(effect==='lease')f.release();
    if(effect==='parent-replace'){fs.renameSync(join(ws,'nested'),join(ws,'nested-old'));fs.mkdirSync(join(ws,'nested'));}
    if(effect==='root-replace'){fs.renameSync(ws,ws+'-old');fs.mkdirSync(ws);}
  });
  assert.throws(()=>f.store.refreshCompletion(f.shadow,f.authority));assert.ok(applied);poisoned(f);
});
for(const effect of ['write','rename','fileflush','dirflush','manifest','manifest-dirflush','partial-sequence'] as const) test('native fault '+effect+' fails closed without valid publication',t=>{
  const f=fixture(t);f.overlay('main.py','changed');f.overlay('inactive.py','changed inactive');f.reset();
  let applied=false,files=0,renames=0;
  nativeObserver(t,f.event,effect==='write'||effect==='rename'?effect:undefined);
  f.hook(e=>{
    if(e.kind==='fileflush')files++;if(e.kind==='rename')renames++;
    if(effect==='fileflush'&&e.kind==='fileflush'||effect==='dirflush'&&e.kind==='dirflush'||effect==='manifest'&&e.kind==='fileflush'&&files===3||effect==='manifest-dirflush'&&e.kind==='dirflush'&&e.path===dirname(f.shadow.workspaceDirectory)||effect==='partial-sequence'&&e.kind==='fileflush'&&files===2){applied=true;throw Error('injected '+effect);}
  });
  assert.throws(()=>f.store.refreshCompletion(f.shadow,f.authority),/injected/);if(effect!=='write'&&effect!=='rename')assert.ok(applied);
  if(effect==='partial-sequence')assert.equal(renames,1,'actual prior native replacement occurred');
  poisoned(f);
});
test('directory removal and empty-directory creation flush errors poison before any manifest replacement',t=>{
  for(const mode of ['remove','new-empty'] as const){const f=fixture(t);
    if(mode==='remove')fs.rmdirSync(join(f.project,'nested/empty'));else fs.mkdirSync(join(f.project,'new-empty'));f.reset();let applied=false;
    f.hook(e=>{if(e.kind==='dirflush'&&(mode==='remove'?e.path===join(f.shadow.workspaceDirectory,'nested'):e.path===join(f.shadow.workspaceDirectory,'new-empty'))){applied=true;throw Error('injected directory entry flush');}});
    assert.throws(()=>f.store.refreshCompletion(f.shadow,f.authority),/injected/);assert.ok(applied);assert.equal(f.events.filter(e=>e.kind==='fileflush').length,0);poisoned(f);
  }
});

test('obsolete subtree removes deepest-first without recursively deleting a retained sibling',t=>{
  const f=fixture(t),ws=f.shadow.workspaceDirectory,before=witness(join(ws,'stable.py'));
  fs.unlinkSync(join(f.project,'nested/keep.py'));fs.rmdirSync(join(f.project,'nested/empty'));fs.rmdirSync(join(f.project,'nested'));f.reset();nativeObserver(t,f.event);
  const next=f.store.refreshCompletion(f.shadow,f.authority);
  assert.deepEqual(f.events.filter(e=>e.kind==='rmdir').map(e=>e.path),[join(ws,'nested/empty'),join(ws,'nested')]);
  for(const [i,e] of f.events.entries())if(['unlink','rmdir'].includes(e.kind))assert.deepEqual(f.events[i+1],{kind:'dirflush',path:dirname(e.path)});
  assert.deepEqual(witness(join(ws,'stable.py')),before);assert.ok(!fs.existsSync(join(ws,'nested')));f.store.assertIntegrity(next);
});
for(const effect of ['source','dependency','inactive-raw-stamp','lease'] as const)test('metadata-only manifest phase still fences '+effect,t=>{
  const f=fixture(t);f.overlay('inactive.py','inactive\n',1);f.reset();let applied=false;
  f.hook(e=>{if(applied||e.kind!=='fileflush')return;applied=true;
    if(effect==='source')fs.mkdirSync(join(f.project,'empty-race'));
    if(effect==='dependency')fs.writeFileSync(join(f.deps,'lib/a.jar'),'changed dependency');
    if(effect==='inactive-raw-stamp')f.overlay('inactive.py','inactive\n',2);
    if(effect==='lease')f.release();
  });
  assert.throws(()=>f.store.refreshCompletion(f.shadow,f.authority));assert.ok(applied);poisoned(f);
});
