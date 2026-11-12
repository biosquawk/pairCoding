/** Native Node22/tsx finite Store composition, not real Gate/Factory/Docker/performance proof. */
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import threads from 'node:worker_threads';
import { syncBuiltinESMExports } from 'node:module';
import { dirname, join, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { LanguageShadowStore, LANGUAGE_DEPENDENCY_DIRECTORY as DEPS, type TrustedLanguageSnapshot, type LanguageShadowAsyncIO } from '../../src/server/language/LanguageShadowStore';
import { NodeLanguageJournalDurability } from '../../src/server/language/LanguageJournalDurability';
import { assertRealDirectory, readRegular, sha256 } from '../../src/server/language/LanguageProcessJournal';
import * as codec from '../../src/language/uriCodec';
type Tree={files:{path:string;bytes:number;sha256:string}[];directories:string[];contents:Map<string,Buffer>};
export function fixture(t:TestContext) {
  const root=fs.mkdtempSync(join(process.env.TMPDIR??tmpdir(),'bounded-stage-')),project=join(root,'project'),deps=join(root,'deps'),owned=join(root,'owned');
  for(const path of [project,deps,owned])fs.mkdirSync(path,{mode:0o700});
  const put=(base:string,path:string,bytes:string|Buffer)=>{fs.mkdirSync(dirname(join(base,path)),{recursive:true});fs.writeFileSync(join(base,path),bytes);};
  for(const [p,b] of Object.entries({'main.py':'main\n','inactive.py':'inactive\n','zero.py':'','日本語/é.py':'unicode\n'}))put(project,p,b);
  put(project,'binary.dat',Buffer.from([0,255,128,1]));fs.mkdirSync(join(project,'empty'));
  put(project,'.env','secret');put(project,'target/skip.class','skip');put(project,'.git/config','private');
  put(deps,'lib/a.jar',Buffer.from([0,255,88]));put(deps,'target/included.bin','dependency target NOT excluded');fs.mkdirSync(join(deps,'empty'));
  t.after(()=>{const clear=(path:string):void=>{for(const e of fs.readdirSync(path,{withFileTypes:true})){const p=join(path,e.name);if(e.isDirectory())clear(p);else if(e.isFile())fs.chmodSync(p,0o600);}};clear(root);fs.rmSync(root,{recursive:true,force:true});});
  const durability=new NodeLanguageJournalDurability(assertRealDirectory),events:string[]=[];
  const store=new LanguageShadowStore(owned,codec,{policy:durability.policy,file(fd){durability.file(fd);events.push('file:'+fs.readlinkSync('/proc/self/fd/'+fd));},directory(p){durability.directory(p);events.push('dir:'+p);}});
  const scan=(root:string,dependencies=false)=> (store as unknown as {scan(root:string,dependencies:boolean):Tree}).scan(root,dependencies);
  const identity={projectId:'p',sessionId:'s',profileId:'python-3.13',configurationGeneration:'cfg',providerGeneration:'provider',shadowGeneration:'shadow',connectionGeneration:'conn',provider:'pylsp' as const,imageId:'sha256:'+'a'.repeat(64),toolchainSha256:'b'.repeat(64),dependencyManifestSha256:'c'.repeat(64),analysisSettingsSha256:'d'.repeat(64)};
  const snapshot:TrustedLanguageSnapshot={leaseId:'lease',identity,projectRoot:project,files:scan(project).files,dependencies:{root:deps,files:scan(deps,true).files},overlays:[]};
  const overlay=(path:string,content:string,version=1)=>{snapshot.overlays=[...snapshot.overlays.filter(o=>o.stamp.path!==path),{content,stamp:{...identity,path,modelLifetime:'life-'+path,localModelVersion:version,requestGeneration:version,controlEpoch:0,baseDocumentVersion:1,documentVersion:null,contentSha256:codec.contentSha256(content)}}];};
  overlay('main.py','main draft\n');overlay('inactive.py','inactive draft\n');
  let held=true,expected=structuredClone(snapshot),pBefore=scan(project),dBefore=scan(deps,true);let checks=0;
  const reset=()=>{snapshot.files=scan(project).files;snapshot.dependencies!.files=scan(deps,true).files;expected=structuredClone(snapshot);pBefore=scan(project);dBefore=scan(deps,true);};reset();
  const same=(a:Tree,b:Tree)=>assert.deepEqual({files:a.files,dirs:a.directories},{files:b.files,dirs:b.directories});
  const authority={capture:()=>snapshot,isCurrent:(lease:TrustedLanguageSnapshot)=>{checks++;same(scan(project),pBefore);same(scan(deps,true),dBefore);return held&&JSON.stringify(lease)===JSON.stringify(expected)&&JSON.stringify(snapshot)===JSON.stringify(expected);}};
  return {root,project,deps,owned,store,snapshot,authority,overlay,reset,scan,put,events,revoke:()=>{held=false;},checks:()=>checks};
}
export function fds(root:string) {return fs.readdirSync('/proc/self/fd').flatMap(fd=>{try{const path=fs.readlinkSync('/proc/self/fd/'+fd);return path.startsWith(root)?[path]:[];}catch{return [];}});}
export function treeWitness(root:string):unknown[] {return fs.readdirSync(root,{withFileTypes:true}).sort((a,b)=>a.name<b.name?-1:1).flatMap(e=>{const full=join(root,e.name),s=fs.lstatSync(full,{bigint:true});return e.isDirectory()?[{path:e.name,dev:String(s.dev),ino:String(s.ino),mode:String(s.mode)},...treeWitness(full).map(v=>({parent:e.name,entry:v}))]:[{path:e.name,dev:String(s.dev),ino:String(s.ino),mode:String(s.mode),mtime:String(s.mtimeNs),sha256:sha256(fs.readFileSync(full))}];});}
/** Native forwarding observer, NEVER a fake byte/worker/FD result. Hook only controls fixture races. */
export function observe(t:TestContext,f:{root:string},hook?:(phase:'dispatch'|'result'|'exit',path:string)=>void) {
  const Native=threads.Worker,events:{kind:string;path?:string;bytes?:number;sha256?:string}[]=[],jobs=new Map<number,string>();
  let active=0,max=0,created=0;
  class Observed extends Native {
    constructor(...args:ConstructorParameters<typeof Native>) {
      super(...args);active++;max=Math.max(max,active);created++;events.push({kind:'spawn'});
      this.on('message',m=>{const path=jobs.get(m.id)??'';events.push(m.error?{kind:'readerror',path}:{kind:'result',path,bytes:m.bytes,sha256:sha256(Buffer.from(m.data,0,m.bytes))});hook?.('result',path);});
      this.on('exit',()=>{active--;events.push({kind:'exit'});hook?.('exit','');});
    }
    postMessage(value:any,transfer?:readonly threads.TransferListItem[]) {
      if(value.type==='READ'){jobs.set(value.id,value.path);events.push({kind:'dispatch',path:value.path,bytes:value.limit});hook?.('dispatch',value.path);}
      return super.postMessage(value,transfer);
    }
  }
  threads.Worker=Observed;syncBuiltinESMExports();t.after(()=>{threads.Worker=Native;syncBuiltinESMExports();});
  return {events,active:()=>active,max:()=>max,created:()=>created,drained:()=>{assert.equal(active,0);assert.equal(events.filter(e=>e.kind==='exit').length,created);assert.deepEqual(fds(f.root),[]);}};
}
export function noStage(f:ReturnType<typeof fixture>){assert.deepEqual(fs.readdirSync(f.owned),[]);assert.deepEqual(fds(f.root),[]);}
export function canonical(manifest:unknown){const {launchId,...rest}=manifest as Record<string,unknown>;return rest;}

