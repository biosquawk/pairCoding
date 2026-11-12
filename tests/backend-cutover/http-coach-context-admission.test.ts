/** NEW real HTTP/WS START, canonical language owner/source/gate/context/CoachAdapter.
 * Docker/OCI/process and provider response are synthetic UNIT seams, not LIVE evidence. */
import test from 'node:test';
import type {TestContext} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {once} from 'node:events';
import {randomUUID} from 'node:crypto';
import WebSocket from 'ws';
import {fixture} from '../runtime-language-binding/fixture';
import {createPairCoachServer} from '../../src/server/http';
import {CoachAdapter} from '../../src/server/CoachAdapter';
import type {CoachContext} from '../../src/server/coach/context';
import {until} from './http-language-owner-fixture';
const barrier=()=>{let release!:()=>void;return {promise:new Promise<void>(r=>{release=r;}),release:()=>release()};};

async function heldInitialCapture(t:TestContext) {
  const held=barrier(),entered=barrier();let cleanup=async()=>{};t.after(async()=>{held.release();await cleanup();});
  const f=await fixture(t,'java-maven'),runtime=f.lease().runtime;
  f.driver.beforeCreate=null;
  fs.mkdirSync(path.join(f.workspace,'.paircoach'),{mode:0o700});
  fs.writeFileSync(path.join(f.workspace,'.paircoach','settings.json'),JSON.stringify({schemaVersion:2,taskFilePath:null,taskMode:'IMPLEMENTATION',reviewNotesPath:'review.md',runProfiles:[f.lease().run],aiConsent:true,contextPatterns:['**/*']}));
  fs.writeFileSync(path.join(f.root,'catalog.json'),JSON.stringify({...runtime.catalog,profiles:runtime.catalog.profiles.filter(p=>p.adapterFamily==='java-maven')}));
  fs.writeFileSync(path.join(f.root,'lock.json'),JSON.stringify({schemaVersion:1,images:[...runtime.imageLock.images,...runtime.catalog.profiles.filter(p=>p.adapterFamily==='java-maven'&&p.id!==runtime.profile.id).map(p=>({...runtime.image,key:p.imageLockKey,image:'paircoach/runtime-'+p.id+':stage09',tools:p.expectedTools}))]}));
  fs.writeFileSync(runtime.configPath,JSON.stringify(runtime.config));
  let intercepted=false,reads=0;const admissions:AbortSignal[]=[],contexts:CoachContext[]=[];
  f.hook(async args=>{if(!intercepted&&args[0]==='info'){intercepted=true;entered.release();await held.promise;}});
  const token='context-admission-unit-token',clientId='tab';
  const app=createPairCoachServer({rootPath:f.workspace,port:0,token,runtimeEnvironment:{},runtimeTransport:f.options.selected.transport,runtimeLanguageDriver:f.driver,
    runtimeArguments:['--runtime-config',runtime.configPath,'--prepared-runtime',f.options.selected.preparedOutputRoots[0],'--language-receipt',f.options.selected.languageReceiptPath!],enableCoach:true,
    coachFactory:context=>{
      assert.equal(typeof context.readContext,'function','Actual bound ServiceContext supplies admission, not an alternate test queue');
      return new CoachAdapter({...context,readContext:async<T>(read:()=>T,signal:AbortSignal):Promise<T>=>{
        admissions.push(signal);return context.readContext!(()=>{reads++;return read();},signal);
      },provider:{name:'UNIT_CONTEXT_ADMISSION',mode:'INJECTED',async decide(c){contexts.push(c);return {kind:'SILENT',reason:'UNIT observation only'};}}});
    }});
  let ws:WebSocket|undefined;cleanup=async()=>{f.driver.unreachable=false;ws?.terminate();await app.close();};
  const port=await app.listen(),sessionId=app.session.state.sessionId,frames:any[]=[];
  ws=new WebSocket(`ws://127.0.0.1:${port}/ws/session`);ws.on('message',b=>frames.push(JSON.parse(b.toString())));await once(ws,'open');
  const send=(type:string,payload:unknown)=>{const id=randomUUID();ws!.send(JSON.stringify({protocolVersion:'3.0',messageId:id,clientId,sessionId,type,payload}));return id;};
  const wait=async(check:(m:any)=>boolean)=>{await until(()=>frames.some(check),'Actual coach admission frame '+check);return frames.find(check);};
  send('HELLO',{token,lastServerSeq:0});const snapshot=await wait(m=>m.type==='SESSION_SNAPSHOT');await entered.promise;
  assert.ok(snapshot.payload.languageBootstrap);assert.throws(()=>app.workspace.listFiles(),{code:'WORKSPACE_BUSY'},'The actual initial language capture owns the SAME FIFO');
  const start=async()=>{
    const response=await fetch(`http://127.0.0.1:${port}/api/session/start`,{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify({requestId:randomUUID(),clientId,sessionId,limitMs:null,pauseOnHidden:true})});
    assert.equal(response.status,200,JSON.stringify(await response.json()));
    await until(()=>admissions.length===1,'Immediate START enters actual bound context admission');
    assert.equal(reads,0);assert.equal(contexts.length,0);assert.equal(app.workspace.workspaceVersion,0);
    assert.equal(f.driver.frames.some(m=>m.method==='initialized'),false,'No fixture initialization wait substitutes for concurrent START');
  };
  return {...f,app,held,admissions,contexts,start,send,wait,frames,sessionId,get reads(){return reads;}};
}

test('HTTP immediate START waits real initial language source capture; after release reads current context once with no provider call/write before admission',async t=>{
  const f=await heldInitialCapture(t);await f.start();f.held.release();
  await until(()=>f.contexts.length===1,'One actual provider invocation after real capture release');
  assert.equal(f.reads,1);assert.equal(f.admissions.length,1);assert.equal(f.contexts[0].trigger?.reason,'START');
  assert.equal(f.contexts[0].workspaceVersion,0);assert.equal(f.app.workspace.workspaceVersion,0);
  assert.equal(fs.readFileSync(path.join(f.workspace,f.path),'utf8'),'prior disk\r\n');
  assert.equal(f.frames.some(m=>m.type==='ERROR'&&m.payload.code==='COACH_RESPONSE_REJECTED'),false);
});

test('HTTP latest CHAT revokes pending START read at SAME peer/epoch; release cannot call stale provider, only latest explicit request',async t=>{
  const f=await heldInitialCapture(t);await f.start();const epoch=f.app.session.state.controlEpoch;
  const first=f.send('CHAT_MESSAGE',{text:'first pending request'});await f.wait(m=>m.type==='ACK'&&m.payload.replyTo===first);
  const latest=f.send('CHAT_MESSAGE',{text:'latest pending request'});await f.wait(m=>m.type==='ACK'&&m.payload.replyTo===latest);
  assert.equal(f.admissions[0].aborted,true);assert.equal(f.admissions.length,1,'Waiting read keeps singleflight until settlement');
  assert.equal(f.reads,0);assert.equal(f.contexts.length,0);assert.equal(f.app.session.state.controlEpoch,epoch);
  f.held.release();await until(()=>f.contexts.length===1,'Only latest queued request reaches provider');
  assert.equal(f.contexts[0].trigger?.messageId,latest);assert.equal(f.contexts[0].trigger?.reason,'CHAT');
  assert.equal(f.reads,1,'Aborted original callback never reads context');assert.equal(f.admissions.length,2);
  assert.equal(f.app.session.state.controlEpoch,epoch);assert.equal(f.app.workspace.workspaceVersion,0);
  assert.equal(f.contexts.some(c=>c.trigger?.messageId===first||c.trigger?.reason==='START'),false);
});
