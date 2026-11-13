/** Real HTTP/WS START, ordinary workspace FIFO, bound context/gate/CoachAdapter.
 * Provider response is a synthetic UNIT seam, not real AI/Docker/native evidence. */
import test from 'node:test';
import type {TestContext} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {once} from 'node:events';
import {randomUUID} from 'node:crypto';
import WebSocket from 'ws';
import catalog from '../../runtimes/catalog.json';
import {createPairCoachServer} from '../../src/server/http';
import {CoachAdapter} from '../../src/server/CoachAdapter';
import type {CoachContext} from '../../src/server/coach/context';
import {validateV2WireShape} from '../../src/shared/validation-v2';
// Same existing 15000 ms observation/cleanup budget; no LSP fixture activation.
async function until(check:()=>boolean,detail:string){const end=Date.now()+15000;while(!check()&&Date.now()<end)await new Promise(r=>setTimeout(r,10));assert.ok(check(),detail);}
async function bounded<T>(operation:Promise<T>,detail:string):Promise<T>{
  let timer:ReturnType<typeof setTimeout>|undefined;
  try{return await Promise.race([operation,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(Error(detail)),15000);})]);}
  finally{clearTimeout(timer);}
}
const barrier=()=>{let release!:()=>void;return {promise:new Promise<void>(r=>{release=r;}),release:()=>release()};};

async function heldOrdinaryFifo(t:TestContext) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'http-coach-context-')),workspace=path.join(root,'workspace'),sourcePath='Kod źródła.java';
  const held=barrier();let entered=false,heldMutation:Promise<void>|undefined,cleanup=async()=>{};
  t.after(async()=>{
    held.release();
    try{if(heldMutation)await bounded(heldMutation,'Held workspace FIFO cleanup');}
    finally{try{await cleanup();}finally{fs.rmSync(root,{recursive:true,force:true});}}
  });
  fs.mkdirSync(workspace,{mode:0o700});
  fs.writeFileSync(path.join(workspace,sourcePath),'prior disk\r\n');
  fs.writeFileSync(path.join(workspace,'inactive.txt'),'untouched');
  fs.writeFileSync(path.join(workspace,'pom.xml'),'<project/>\r\n');
  fs.mkdirSync(path.join(workspace,'.paircoach'),{mode:0o700});
  fs.writeFileSync(path.join(workspace,'.paircoach','settings.json'),JSON.stringify({schemaVersion:2,taskFilePath:null,taskMode:'IMPLEMENTATION',reviewNotesPath:'review.md',runProfiles:[],aiConsent:true,contextPatterns:['**/*']}));
  // Authentic local builtin configuration; no prepared image, remote receipt or Docker fixture.
  fs.writeFileSync(path.join(root,'catalog.json'),JSON.stringify({schemaVersion:1,profiles:catalog.profiles.filter(p=>p.id==='java-maven-21')}));
  fs.writeFileSync(path.join(root,'images.json'),JSON.stringify({schemaVersion:1,images:[]}));
  const configPath=path.join(root,'runtime.json');
  fs.writeFileSync(configPath,JSON.stringify({schemaVersion:1,activeProfile:'java-maven-21',workspaceRoot:workspace,runtimeCatalog:'catalog.json',imageLock:'images.json',languageFeatures:{completion:true,diagnostics:false},execution:{backend:'docker',pullPolicy:'never'}}));
  let reads=0,settled=0;const admissions:AbortSignal[]=[],contexts:CoachContext[]=[];
  const token='context-admission-unit-token',clientId='tab';
  const app=createPairCoachServer({rootPath:workspace,port:0,token,runtimeEnvironment:{},
    runtimeArguments:['--runtime-config',configPath],enableCoach:true,
    coachFactory:context=>{
      assert.equal(typeof context.readContext,'function','Actual bound ServiceContext supplies admission, not an alternate test queue');
      return new CoachAdapter({...context,readContext:async<T>(read:()=>T,signal:AbortSignal):Promise<T>=>{
        admissions.push(signal);try{return await context.readContext!(()=>{reads++;return read();},signal);}finally{settled++;}
      },provider:{name:'UNIT_CONTEXT_ADMISSION',mode:'INJECTED',async decide(c){contexts.push(c);return {kind:'SILENT',reason:'UNIT observation only'};}}});
    }});
  let ws:WebSocket|undefined;cleanup=async()=>{
    try{if(ws&&ws.readyState!==WebSocket.CLOSED){const closed=once(ws,'close');ws.terminate();await bounded(closed,'Owned WebSocket cleanup');}}
    finally{await bounded(app.close(),'Owned HTTP server cleanup');}
  };
  const port=await app.listen(),sessionId=app.session.state.sessionId,frames:any[]=[];
  ws=new WebSocket(`ws://127.0.0.1:${port}/ws/session`);ws.on('message',b=>frames.push(JSON.parse(b.toString())));await once(ws,'open');
  const send=(type:string,payload:unknown)=>{const id=randomUUID(),message={protocolVersion:'3.0',messageId:id,clientId,sessionId,type,payload};assert.ok(validateV2WireShape('ClientMessage',message),JSON.stringify(message));ws!.send(JSON.stringify(message));return id;};
  const wait=async(check:(m:any)=>boolean)=>{await until(()=>frames.some(check),'Actual coach admission frame '+check);return frames.find(check);};
  send('HELLO',{token,lastServerSeq:0});const snapshot=await wait(m=>m.type==='SESSION_SNAPSHOT');
  assert.ok(snapshot.payload.languageBootstrap);assert.equal(snapshot.payload.languageBootstrap.provider,'builtin');
  heldMutation=app.workspace._withQueuedMutation(async()=>{entered=true;await held.promise;});
  await until(()=>entered,'Ordinary mutation entered the SAME workspace FIFO before START');
  assert.throws(()=>app.workspace.listFiles(),{code:'WORKSPACE_BUSY'},'The actual ordinary mutation owns the SAME FIFO');
  const start=async()=>{
    const response=await fetch(`http://127.0.0.1:${port}/api/session/start`,{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify({requestId:randomUUID(),clientId,sessionId,limitMs:null,pauseOnHidden:true})});
    assert.equal(response.status,200,JSON.stringify(await response.json()));
    await until(()=>admissions.length===1,'Immediate START enters actual bound context admission');
    assert.equal(reads,0);assert.equal(contexts.length,0);assert.equal(app.workspace.workspaceVersion,0);
  };
  return {workspace,path:sourcePath,app,held,admissions,contexts,start,send,wait,frames,sessionId,get reads(){return reads;},get settled(){return settled;}};
}

test('HTTP immediate START waits real ordinary workspace FIFO; after release reads current context once with no provider call/write before admission',async t=>{
  const f=await heldOrdinaryFifo(t);await f.start();f.held.release();
  await until(()=>f.contexts.length===1,'One actual provider invocation after ordinary FIFO release');
  assert.equal(f.reads,1);assert.equal(f.admissions.length,1);assert.equal(f.contexts[0].trigger?.reason,'START');
  assert.equal(f.contexts[0].workspaceVersion,0);assert.equal(f.app.workspace.workspaceVersion,0);
  assert.equal(fs.readFileSync(path.join(f.workspace,f.path),'utf8'),'prior disk\r\n');
  assert.equal(f.frames.some(m=>m.type==='ERROR'&&m.payload.code==='COACH_RESPONSE_REJECTED'),false);
});

test('HTTP latest CHAT revokes pending START read at SAME peer/epoch; release cannot call stale provider, only latest explicit request',async t=>{
  const f=await heldOrdinaryFifo(t);await f.start();const epoch=f.app.session.state.controlEpoch;
  const first=f.send('CHAT_MESSAGE',{text:'first pending request',path:null,documentVersion:null,selection:null});assert.equal((await f.wait(m=>m.type==='ACK'&&m.payload.replyTo===first)).payload.status,'OK');
  const latest=f.send('CHAT_MESSAGE',{text:'latest pending request',path:null,documentVersion:null,selection:null});assert.equal((await f.wait(m=>m.type==='ACK'&&m.payload.replyTo===latest)).payload.status,'OK');
  assert.equal(f.admissions[0].aborted,true);assert.equal(f.admissions.length,1,'Waiting read keeps singleflight until settlement');
  assert.equal(f.reads,0);assert.equal(f.contexts.length,0);assert.equal(f.app.session.state.controlEpoch,epoch);
  f.held.release();await until(()=>f.contexts.length===1,'Only latest queued request reaches provider');
  assert.equal(f.contexts[0].trigger?.messageId,latest);assert.equal(f.contexts[0].trigger?.reason,'CHAT');
  assert.equal(f.reads,1,'Aborted original callback never reads context');assert.equal(f.admissions.length,2);
  assert.equal(f.app.session.state.controlEpoch,epoch);assert.equal(f.app.workspace.workspaceVersion,0);
  assert.equal(f.contexts.some(c=>c.trigger?.messageId===first||c.trigger?.reason==='START'),false);
});

test('HTTP real peer VETO revokes pending START read; ordinary FIFO release cannot call stale context/provider or write',async t=>{
  const f=await heldOrdinaryFifo(t);await f.start();const epoch=f.app.session.state.controlEpoch;
  const veto=f.send('VETO_ESCAPE',{controlEpoch:epoch,activeInterventionId:null,lastAppliedSeq:f.frames.at(-1).seq});
  const ack=await f.wait(m=>m.type==='ACK'&&m.payload.replyTo===veto);
  assert.equal(ack.payload.status,'OK');assert.ok(ack.payload.controlEpoch>epoch);
  assert.equal(f.admissions[0].aborted,true);assert.equal(f.admissions.length,1);
  assert.equal(f.reads,0);assert.equal(f.contexts.length,0);assert.equal(f.settled,0,'Real context admission remains held until FIFO release');
  f.held.release();
  await until(()=>f.settled===1,'Revoked bound admission actually settles after release');
  await f.wait(m=>m.type==='CONTROL_STATE'&&m.seq>ack.seq&&m.payload.controlEpoch===ack.payload.controlEpoch);
  assert.equal(f.reads,0,'Aborted START callback never reads context');assert.equal(f.contexts.length,0,'No stale provider call after release');
  assert.equal(f.admissions.length,1,'Veto cannot enqueue replacement work');
  assert.equal(f.app.session.state.controlEpoch,ack.payload.controlEpoch);assert.equal(f.app.session.state.writeOwner,'STUDENT');
  assert.equal(f.app.workspace.workspaceVersion,0);assert.equal(f.app.workspace.getDocument(f.path).version,1);
  assert.equal(fs.readFileSync(path.join(f.workspace,f.path),'utf8'),'prior disk\r\n');
  assert.equal(f.frames.some(m=>m.type==='ERROR'&&m.payload.code==='COACH_RESPONSE_REJECTED'),false);
});
