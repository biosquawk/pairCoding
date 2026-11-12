import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { join } from 'node:path';
import { fixture, observe, noStage, treeWitness } from './store-fixture';
import { LanguageShadowStore } from '../../src/server/language/LanguageShadowStore';
import * as codec from '../../src/language/uriCodec';
for(const mode of ['reuse','foreign-authority','foreign-store','discard','mismatch','early-failure'] as const)test('one-use store read-vector: '+mode+' never falls back',async t=>{
 const f=fixture(t),shadow=f.store.materialize('completion',f.authority),before=treeWitness(f.owned),o=observe(t,f),token=await f.store.stageRead(f.authority);o.drained();assert.deepEqual(treeWitness(f.owned),before,'READ-only stage has no private mutations');
 if(mode==='reuse'){const next=f.store.refreshCompletion(shadow,f.authority,token);assert.throws(()=>f.store.refreshCompletion(next,f.authority,token),/Foreign\/used/);}
 if(mode==='foreign-authority')assert.throws(()=>f.store.refreshCompletion(shadow,{...f.authority},token),/Foreign\/used/);
 if(mode==='foreign-store'){const other=new LanguageShadowStore(f.owned,codec);assert.throws(()=>other.refreshCompletion(shadow,f.authority,token),/Foreign\/used/);f.store.discardReadStage(token);}
 if(mode==='discard'){f.store.discardReadStage(token);assert.throws(()=>f.store.refreshCompletion(shadow,f.authority,token),/Foreign\/used/);}
 if(mode==='mismatch'){f.overlay('inactive.py','changed',2);assert.throws(()=>f.store.refreshCompletion(shadow,f.authority,token));}
 if(mode==='early-failure'){const p=join(shadow.workspaceDirectory,'main.py');fs.chmodSync(p,0o600);fs.writeFileSync(p,'bad');assert.throws(()=>f.store.refreshCompletion(shadow,f.authority,token));}
 if(mode!=='foreign-store')assert.throws(()=>f.store.refreshCompletion(shadow,f.authority,token),/Foreign\/used/);
});
test('ordinary overlay read-stage refresh retains unchanged dependency witnesses and diagnostic sibling; absent token remains sync-compatible',async t=>{
 const f=fixture(t),completion=f.store.materialize('completion',f.authority),diagnostic=f.store.materialize('diagnostics',f.authority),db=treeWitness(diagnostic.workspaceDirectory),dep=treeWitness(join(completion.workspaceDirectory,'.paircoach-dependencies')),o=observe(t,f);
 f.overlay('main.py','new main',2);f.reset();const token=await f.store.stageRead(f.authority);o.drained();const next=f.store.refreshCompletion(completion,f.authority,token);
 assert.deepEqual(treeWitness(join(next.workspaceDirectory,'.paircoach-dependencies')),dep);assert.deepEqual(treeWitness(diagnostic.workspaceDirectory),db);assert.equal(fs.readFileSync(join(next.workspaceDirectory,'main.py'),'utf8'),'new main');
 const workers=o.created();f.store.refreshCompletion(next,f.authority);assert.equal(o.created(),workers,'legacy absence never calls async reader');
});
test('prepared read-vector cannot escape a partial native delta failure as an unpoisoned handle',async t=>{
 const f=fixture(t),shadow=f.store.materialize('completion',f.authority);f.overlay('main.py','changed',2);f.reset();const token=await f.store.stageRead(f.authority);
 const internal=f.store as unknown as {durability:{file(fd:number):void}};const native=internal.durability.file;internal.durability.file=fd=>{native(fd);throw Error('NEW real fsync postcompletion fault');};
 assert.throws(()=>f.store.refreshCompletion(shadow,f.authority,token),/postcompletion fault/);assert.throws(()=>f.store.assertIntegrity(shadow),/poisoned/);assert.throws(()=>f.store.refreshCompletion(shadow,f.authority,token),/Foreign\/used/);
});
test('combined 256MiB reservation rejected before dispatch even with each individual tree in bounds',async t=>{
 const f=fixture(t);fs.rmSync(f.project,{recursive:true});fs.mkdirSync(f.project);const fake=(root:string,count:number,size:number)=>{const files=[];for(let i=0;i<count;i++){const path='s'+i,fd=fs.openSync(join(root,path),'w');fs.ftruncateSync(fd,size);fs.closeSync(fd);files.push({path,bytes:size,sha256:'0'.repeat(64)});}return files;};
 f.snapshot.files=fake(f.project,16,4*1024*1024);f.snapshot.overlays=[];f.snapshot.dependencies!.files=[...f.snapshot.dependencies!.files,...fake(f.deps,3,64*1024*1024)];const o=observe(t,f);
 await assert.rejects(f.store.stageRead({capture:()=>f.snapshot,isCurrent:()=>true}),/requested budgets exceeded/);assert.equal(o.created(),0);o.drained();noStage(f);
});
