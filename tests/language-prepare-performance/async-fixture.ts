/** Host filesystem only: real native callback IO. Lease is an explicit test authority, NOT backend FIFO. */
import { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { isDeepStrictEqual as same, promisify } from 'node:util';
import { LanguageShadowStore, type LanguageShadowAsyncIO, type TrustedLanguageSnapshot } from '../../src/server/language/LanguageShadowStore';
import { NodeLanguageJournalDurability } from '../../src/server/language/LanguageJournalDurability';
import { assertRealDirectory, sha256 } from '../../src/server/language/LanguageProcessJournal';
import * as codec from '../../src/language/uriCodec';
export function deferred() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return {promise,resolve}; }
export function fixture(t: TestContext, count = 10) {
 const root=fs.mkdtempSync(join(process.env.TMPDIR ?? tmpdir(),'async-stage-'));
 const clear=(p:string):void=>{for(const e of fs.readdirSync(p,{withFileTypes:true})){const f=join(p,e.name);if(e.isDirectory())clear(f);else if(e.isFile())fs.chmodSync(f,0o600);}};
 t.after(()=>{clear(root);fs.rmSync(root,{recursive:true,force:true});});
 const project=join(root,'project'),owned=join(root,'owned');for(const p of [project,owned])fs.mkdirSync(p,{mode:0o700});
 fs.mkdirSync(join(project,'nested'));fs.mkdirSync(join(project,'nested/empty'));
 for(let i=0;i<count;i++)fs.writeFileSync(join(project,i<5?`a${i}.py`:`nested/a${i}.py`),'print("original")\n');
 const events:{op:string;path:string;fd?:number}[]=[],fds=new Map<number,string>();let max=0;
 let hook:(op:string,fd:number,path:string)=>void|Promise<void>=()=>{};
 const io:LanguageShadowAsyncIO={
  async open(path,flags,mode){const fd=await promisify(fs.open)(path,flags,mode);fds.set(fd,path);max=Math.max(max,fds.size);events.push({op:'open',fd,path});await hook('open',fd,path);return fd;},
  async writeFile(fd,bytes){await promisify(fs.writeFile)(fd,bytes);events.push({op:'write',fd,path:fds.get(fd)!});await hook('write',fd,fds.get(fd)!);},
  async chmod(fd,mode){await promisify(fs.fchmod)(fd,mode);events.push({op:'chmod',fd,path:fds.get(fd)!});await hook('chmod',fd,fds.get(fd)!);},
  async sync(fd){await promisify(fs.fsync)(fd);events.push({op:'sync',fd,path:fds.get(fd)!});await hook('sync',fd,fds.get(fd)!);},
  async close(fd){const path=fds.get(fd)!;await promisify(fs.close)(fd);fds.delete(fd);events.push({op:'close',fd,path});await hook('close',fd,path);}
 };
 const native=new NodeLanguageJournalDurability(assertRealDirectory);
 const store=new LanguageShadowStore(owned,codec,{policy:native.policy,file(fd){native.file(fd);events.push({op:'manifest-file',path:''});},directory(path){native.directory(path);events.push({op:'directory',path});}},io);
 const disk=store.captureSource(project),identity={projectId:'p',sessionId:'s',profileId:'python-3.13',configurationGeneration:'cfg',providerGeneration:'provider',shadowGeneration:'shadow',connectionGeneration:'conn',provider:'pylsp' as const,imageId:'sha256:'+'a'.repeat(64),toolchainSha256:'b'.repeat(64),dependencyManifestSha256:'c'.repeat(64),analysisSettingsSha256:'d'.repeat(64)};
 const overlays=(count>1?['a0.py','a1.py']:['a0.py']).map(path=>({stamp:{...identity,path,modelLifetime:path,localModelVersion:1,requestGeneration:1,controlEpoch:0,baseDocumentVersion:1,documentVersion:null,contentSha256:codec.contentSha256('draft\n')},content:'draft\n'}));
 const snapshot:TrustedLanguageSnapshot={leaseId:'held-lease',identity,projectRoot:project,files:disk.files,overlays,dependencies:null};
 const expected=structuredClone(snapshot);let held=true,current=true;
 const authority={capture:()=>snapshot,isCurrent(s:TrustedLanguageSnapshot){assert.ok(held,'held FIFO required');disk.assertCurrent();return current&&same(snapshot,expected)&&same(s,snapshot);}};
 return {root,project,owned,store,snapshot,authority,events,fds,get max(){return max;},hook(f:typeof hook){hook=f;},release(){held=false;},veto(){current=false;},sha256,dirname};
}
