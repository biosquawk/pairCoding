/** Real HTTP/client/WS with transport faults; no AI or Docker/LIVE claim. */
import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {createPairCoachServer} from '../../src/server/http';
import {LiveBackend} from '../../src/services/LiveBackend';
import WebSocket from 'ws';

async function until(predicate:()=>boolean) {
  const deadline=Date.now()+5000;
  while(!predicate()){assert.ok(Date.now()<deadline,'client did not settle');await delay(5);}
}
async function fixture(t:TestContext) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'durable-locale-client-'));
  const project=path.join(root,'P'),exercise=path.join(root,'A');
  fs.mkdirSync(project);fs.mkdirSync(exercise);
  fs.writeFileSync(path.join(exercise,'challenge.md'),'# Exercise');
  const app=createPairCoachServer({port:0,token:'locale-test',runtimeEnvironment:{}});
  const port=await app.listen();
  let fault:'none'|'reject'|'lost'|'unavailable'|'malformed'='none',posts=0,reads=0;
  let beforePost:(()=>Promise<void>)|undefined;
  const client=new LiveBackend({baseUrl:`http://127.0.0.1:${port}`,token:'locale-test',socket:url=>new WebSocket(url) as any,fetch:async(url,options)=>{
    const route=new URL(String(url)).pathname;
    if(route==='/api/durable-project/locale' && options?.method==='POST') {
      posts++;await beforePost?.();
      if(fault==='reject')return Response.json({code:'INVALID_LOCALE',message:'Rejected by test transport'},{status:400});
      const response=await fetch(url,options);
      if(fault==='lost'||fault==='unavailable'||fault==='malformed') {
        assert.equal(response.status,200,'server committed before response was lost');
        throw new TypeError('Connection lost after server commit');
      }
      return response;
    }
    if(route==='/api/durable-project') {
      reads++;
      if(fault==='unavailable')throw new TypeError('Readback unavailable');
      if(fault==='malformed')return Response.json({locale:'unknown',durableProject:null,projectError:null});
    }
    return fetch(url,options);
  }});
  t.after(async()=>{client.close();await app.close();fs.rmSync(root,{recursive:true,force:true});});
  await client.connect();assert.equal(await client.createDurableProject(project,'Learning'),true);
  assert.equal(await client.openProject(exercise),true);
  await until(()=>!client.getState().isOffline);
  return {client,app,get posts(){return posts;},get reads(){return reads;},set fault(value:typeof fault){fault=value;},set beforePost(value:typeof beforePost){beforePost=value;}};
}

test('explicit locale rejection reads back prior language instead of leaving the optimistic flag',async t=>{
  const f=await fixture(t),reads=f.reads;f.fault='reject';
  assert.equal(await f.client.setLocale('en'),false);
  assert.ok(f.reads>reads,'failure must read authoritative durable state');
  assert.equal(f.client.getState().locale,'pl');
  assert.match(f.client.getState().projectError!,/INVALID_LOCALE/);
  assert.equal(await f.client.sendChatMessage('Still Polish'),true,'confirmed prior locale releases chat');
});

test('lost POST response AFTER commit reads back committed language without replaying the mutation',async t=>{
  const f=await fixture(t),posts=f.posts;f.fault='lost';
  assert.equal(await f.client.setLocale('en'),false,'do not invent a successful POST receipt');
  assert.equal(f.client.getState().locale,'en','readback, not rollback, determines the flag');
  assert.equal(f.posts,posts+1,'no repeated locale mutation');
  assert.equal(await f.client.sendChatMessage('English now'),true);
  assert.equal(f.client.getState().chatEntries.at(-1)?.locale,'en');
});

for(const fault of ['unavailable','malformed'] as const)test(`unknown POST plus ${fault} readback keeps coach blocked until reconnect`,async t=>{
  const f=await fixture(t);f.fault=fault;
  assert.equal(await f.client.setLocale('en'),false);
  assert.match(f.client.getState().projectError!,/LOCALE_SYNC_REQUIRED/);
  const count=f.client.getState().chatEntries.length,posts=f.posts;
  assert.equal(await f.client.sendChatMessage('Must not send under unknown locale'),false);
  assert.equal(f.client.getState().chatEntries.length,count,'blocked chat is not appended');
  assert.equal(await f.client.setLocale('pl'),false,'no second mutation before sync');
  assert.equal(f.posts,posts);
  await f.client.startTimer();assert.equal(f.app.session.getSession().lifecycle,'READY');
  f.fault='none';f.client.reconnect();
  await until(()=>!f.client.getState().isOffline && f.client.getState().locale==='en');
  assert.equal(await f.client.sendChatMessage('Confirmed English'),true);
});

test('locale POST is single-flight; chat cannot start while its response is pending',async t=>{
  const f=await fixture(t),posts=f.posts;
  let release!:()=>void;
  f.beforePost=()=>new Promise<void>(resolve=>{release=resolve;});
  const first=f.client.setLocale('en');await until(()=>!!release);
  try {
    assert.equal(await f.client.setLocale('pl'),false);
    assert.equal(await f.client.sendChatMessage('Wait for the language ACK'),false);
    assert.equal(f.posts,posts+1);
  }finally {release();}
  assert.equal(await first,true);assert.equal(f.client.getState().locale,'en');
  assert.equal(await f.client.sendChatMessage('Language confirmed'),true);
});
