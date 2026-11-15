import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import WebSocket from 'ws';
import {createPairCoachServer} from '../../src/server/http';
import {LiveBackend} from '../../src/services/LiveBackend';

async function fixture(t:TestContext){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'project-open-reconcile-'));
  const P=path.join(root,'P'),Q=path.join(root,'Q');fs.mkdirSync(P);fs.mkdirSync(Q);
  const token='project-open-reconcile-local-token';
  const app=createPairCoachServer({port:0,token,runtimeEnvironment:{}}),port=await app.listen();
  let posts=0,reads=0,readFault=false,ambiguous=false,conflict=false;
  const base={baseUrl:`http://127.0.0.1:${port}`,token,socket:(url:string)=>new WebSocket(url) as any};
  const stale=new LiveBackend({...base,clientId:'old-empty-tab',fetch:async(url,options)=>{
    const route=new URL(String(url)).pathname;
    if(route==='/api/durable-project/open'&&options?.method==='POST'){
      posts++;if(ambiguous)throw new TypeError('Connection lost; outcome unknown');
      if(conflict)return Response.json({code:'PROJECT_STATE_CHANGED',message:'Injected explicit conflict'},{status:409});
    }
    if(route==='/api/durable-project'&&options?.method==='GET'){
      reads++;if(readFault)throw new TypeError('Readback unavailable');
    }
    return fetch(url,options);
  }});
  const other=new LiveBackend({...base,clientId:'other-tab'});
  t.after(async()=>{stale.close();other.close();await app.close();fs.rmSync(root,{recursive:true,force:true});});
  await stale.connect();await other.connect();
  assert.equal(stale.getState().durableProject,null);
  assert.equal(await other.createDurableProject(P,'Existing'),true);
  const file=other.getState().durableProject!.projectFile;
  return {stale,other,file,Q,get posts(){return posts;},get reads(){return reads;},set readFault(v:boolean){readFault=v;},set ambiguous(v:boolean){ambiguous=v;},set conflict(v:boolean){conflict=v;}};
}

test('stale empty tab reconciles an already-open requested project by authenticated readback, without replaying POST',async t=>{
  const f=await fixture(t),reads=f.reads;
  assert.equal(await f.stale.openDurableProject(f.file),true);
  assert.equal(f.stale.getState().durableProject!.projectFile,f.file);
  assert.equal(f.stale.getState().projectError,null);
  assert.equal(f.posts,1);assert.ok(f.reads>reads);
});

test('stale open of a different project does not silently change the current project or replay the command',async t=>{
  const f=await fixture(t);
  assert.equal(await f.stale.openDurableProject(path.join(f.Q,'Other.paircoding.json')),false);
  assert.equal(f.stale.getState().durableProject,null);
  assert.equal(f.other.getState().durableProject!.projectFile,f.file);
  assert.match(f.stale.getState().projectError!,/PROJECT_STATE_CHANGED/);assert.equal(f.posts,1);
});

test('unavailable authoritative readback leaves the explicit rejection visible, without inventing success',async t=>{
  const f=await fixture(t);f.readFault=true;
  assert.equal(await f.stale.openDurableProject(f.file),false);
  assert.equal(f.stale.getState().durableProject,null);
  assert.match(f.stale.getState().projectError!,/PROJECT_STATE_CHANGED/);assert.equal(f.posts,1);
});

test('an unknown transport outcome never enters the explicit-rejection recovery path',async t=>{
  const f=await fixture(t),reads=f.reads;f.ambiguous=true;
  assert.equal(await f.stale.openDurableProject(f.file),false);
  assert.equal(f.stale.getState().durableProject,null);assert.equal(f.reads,reads);assert.equal(f.posts,1);
});

test('an existing local project is never discarded by empty-shell reconciliation',async t=>{
  const f=await fixture(t);
  assert.equal(await f.stale.openDurableProject(f.file),true);
  const current=f.stale.getState().durableProject,reads=f.reads;
  f.conflict=true;
  assert.equal(await f.stale.openDurableProject(f.file),false);
  assert.deepEqual(f.stale.getState().durableProject,current);
  assert.equal(f.reads,reads,'no adoption/readback for a client with an existing project');
  assert.match(f.stale.getState().projectError!,/PROJECT_STATE_CHANGED/);
});

test('reconciliation restores an exercise through real HELLO with this tab identity',async t=>{
  const f=await fixture(t),exercise=path.join(f.Q,'exercise');fs.mkdirSync(exercise);fs.writeFileSync(path.join(exercise,'challenge.md'),'# Existing exercise');
  assert.equal(await f.other.openProject(exercise),true);
  const until=Date.now()+10000;while(f.other.getState().isOffline){assert.ok(Date.now()<until);await delay(10);}
  f.other.close();await delay(30);
  assert.equal(await f.stale.openDurableProject(f.file),true);
  while(f.stale.getState().isOffline||f.stale.getState().writeOwner!=='STUDENT'){assert.ok(Date.now()<until);await delay(10);}
  assert.equal(f.stale.getState().writeOwner,'STUDENT');
  assert.equal(f.stale.getState().durableProject!.exercisePath,exercise);assert.equal(f.posts,1);
});
