/** Actual loopback HTTP/WS + real kernel-held workspace/WriteGate/CommandLedger.
 * No Docker/process/provider readiness claim. Existing test sources remain unchanged. */
import test, {type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {once} from 'node:events';
import {randomUUID} from 'node:crypto';
import WebSocket from 'ws';
import {createPairCoachServer} from '../../src/server/http';
import {validateV2WireShape} from '../../src/shared/validation-v2';

async function fixture(t:TestContext,throwingCoach=false) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'http-code-ack-')),workspace=path.join(root,'project');
  fs.mkdirSync(workspace);fs.writeFileSync(path.join(workspace,'source.js'),'\ufeffORIGINAL\r\n');
  const token='unit-local-token';let edits=0;
  const app=createPairCoachServer({rootPath:workspace,port:0,token,runtimeEnvironment:{},
    runtimeArguments:['--runtime-config',path.join(root,'absent.json')],enableCoach:true,
    coachFactory:context=>({trigger(reason){if(reason==='EDIT'){edits++;if(throwingCoach)throw Error('unit coach failed');
      context.emit('CHAT_REPLY',{replyTo:null,text:'Observed committed edit'});}},controlReady(){},stepRendered(){},abort(){},close(){}})});
  let ws:WebSocket|undefined;
  t.after(async()=>{ws?.terminate();await app.close();fs.rmSync(root,{recursive:true,force:true});});
  const port=await app.listen(),sessionId=app.session.state.sessionId,clientId='tab';
  ws=new WebSocket(`ws://127.0.0.1:${port}/ws/session`);
  const frames:any[]=[],waiters=new Set<()=>void>();
  ws.on('message',data=>{frames.push(JSON.parse(data.toString()));for(const wake of waiters)wake();});
  const wait=(match:(f:any)=>boolean)=>new Promise<any>((resolve,reject)=>{
    const timer=setTimeout(()=>{waiters.delete(check);reject(Error('Expected frame not received: '+match));},3000);
    const check=()=>{const f=frames.find(match);if(f){clearTimeout(timer);waiters.delete(check);resolve(f);}};waiters.add(check);check();
  });
  await once(ws,'open');
  const send=(type:string,payload:unknown,messageId=randomUUID())=>{ws!.send(JSON.stringify({protocolVersion:'3.0',messageId,sessionId,clientId,type,payload}));return messageId;};
  send('HELLO',{token,lastServerSeq:0});await wait(f=>f.type==='SESSION_SNAPSHOT');
  const save=(content:string,baseVersion:number,id=randomUUID())=>{
    const payload={path:'source.js',baseVersion,content,editKind:'TYPING',controlEpoch:app.session.state.controlEpoch};
    send('CODE_CHANGED',payload,id);return {id,payload};
  };
  return {app,root,workspace,frames,wait,send,save,get edits(){return edits;}};
}

test('ACK original real committed envelope broadcasts before coach observer frames; seq is globally contiguous',async t=>{
  const f=await fixture(t),save=f.save('STUDENT\n',1);
  const ack=await f.wait(m=>m.type==='ACK'&&m.payload.replyTo===save.id);
  const coach=await f.wait(m=>m.type==='CHAT_REPLY');
  assert.ok(validateV2WireShape('ServerMessage',ack));assert.equal(ack.payload.status,'OK');
  assert.equal(ack.payload.documentVersion,2);assert.equal(ack.payload.workspaceVersion,1);
  assert.ok(ack.seq<coach.seq,'Original ACK must precede postcommit observers/associations');
  assert.deepEqual(f.frames.map(m=>m.seq),f.frames.map((_,i)=>i+1));
  assert.equal(fs.readFileSync(path.join(f.workspace,'source.js'),'utf8'),'\ufeffSTUDENT\r\n');
});

test('ACK duplicate reuses genuine original receipt/result after later disk+epoch change, not current versions',async t=>{
  const f=await fixture(t),first=f.save('FIRST\n',1),a=await f.wait(m=>m.type==='ACK'&&m.payload.replyTo===first.id);
  const second=f.save('SECOND\n',2);await f.wait(m=>m.type==='ACK'&&m.payload.replyTo===second.id);
  const veto=f.send('VETO_ESCAPE',{controlEpoch:f.app.session.state.controlEpoch,activeInterventionId:null,lastAppliedSeq:f.frames.at(-1).seq});await f.wait(m=>m.type==='ACK'&&m.payload.replyTo===veto);
  assert.notEqual(f.app.session.state.controlEpoch,a.payload.controlEpoch);
  f.send('CODE_CHANGED',first.payload,first.id);
  const replay=await f.wait(m=>m.type==='ACK'&&m.payload.replyTo===first.id&&m.seq>a.seq);
  assert.equal(replay.messageId,a.messageId,'Same original transaction receipt, not a new unbound identity');
  assert.deepEqual(replay.payload,{...a.payload,status:'DUPLICATE'});
  assert.ok(replay.seq>a.seq);assert.equal(f.app.workspace.workspaceVersion,2);assert.equal(f.edits,2);
  assert.equal(fs.readFileSync(path.join(f.workspace,'source.js'),'utf8'),'\ufeffSECOND\r\n');
  f.send('CODE_CHANGED',{...first.payload,content:'COLLISION\n'},first.id);
  const conflict=await f.wait(m=>m.type==='ACK'&&m.payload.replyTo===first.id&&m.payload.status==='REJECTED');
  assert.equal(conflict.payload.error.code,'IDEMPOTENCY_CONFLICT');assert.equal(f.app.workspace.workspaceVersion,2);
});

test('ACK save queued behind actual FIFO allocates seq only at publication; rejected writes never emit OK',async t=>{
  const f=await fixture(t);let release!:()=>void,entered!:()=>void;
  const waiting=new Promise<void>(r=>release=r),inside=new Promise<void>(r=>entered=r);
  const held=f.app.workspace._withQueuedMutation(async()=>{entered();await waiting;});await inside;
  let save:{id:string;payload:unknown};
  try {
    save=f.save('QUEUED\n',1);await new Promise<void>(r=>setImmediate(r));
    f.app.session.setPresence('HIDDEN');const state=await f.wait(m=>m.type==='SESSION_STATE'&&m.payload.presence==='HIDDEN');
    assert.equal(f.frames.some(m=>m.type==='ACK'&&m.payload.replyTo===save.id),false);
    release();await held;const ack=await f.wait(m=>m.type==='ACK'&&m.payload.replyTo===save.id);
    assert.ok(ack.seq>state.seq);assert.deepEqual(f.frames.map(m=>m.seq),f.frames.map((_,i)=>i+1));
  } finally {release();await held;}
  const stale=f.save('NO EFFECT\n',1);const rejection=await f.wait(m=>m.type==='ACK'&&m.payload.replyTo===stale.id);
  assert.equal(rejection.payload.status,'REJECTED');assert.equal(f.app.workspace.workspaceVersion,1);
  assert.equal(f.frames.filter(m=>m.type==='ACK'&&m.payload.replyTo===stale.id&&m.payload.status==='OK').length,0);
});

test('ACK throwing coach observer cannot downgrade original successful transaction or reexecute its replay',async t=>{
  const f=await fixture(t,true),save=f.save('COMMITTED\n',1),ack=await f.wait(m=>m.type==='ACK'&&m.payload.replyTo===save.id);
  assert.equal(ack.payload.status,'OK');await f.wait(m=>m.type==='ERROR');
  f.send('CODE_CHANGED',save.payload,save.id);const replay=await f.wait(m=>m.type==='ACK'&&m.payload.replyTo===save.id&&m.seq>ack.seq);
  assert.equal(replay.payload.status,'DUPLICATE');assert.equal(replay.messageId,ack.messageId);
  assert.equal(f.edits,1);assert.equal(f.app.workspace.workspaceVersion,1);
  assert.equal(f.frames.some(m=>m.type==='ACK'&&m.payload.replyTo===save.id&&m.payload.status==='REJECTED'),false);
});
