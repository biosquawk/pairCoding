/** Real HTTP/WS/finish/gate; only the start of snapshot capture is held. No model. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { createPairCoachServer } from '../../src/server/http';
import { workspaceFiles, Peer, id } from '../qa/helpers';

test('finish transition preserves authenticated controls while source edits remain fenced', async t => {
  const dirs=await workspaceFiles(t,{'main.js':'ORIGINAL\n'}),token=id(),clientId=id();
  const app=createPairCoachServer({rootPath:dirs.rootPath,port:0,token,enableExecution:true,enableCoach:false});
  const port=await app.listen(),sessionId=app.session.state.sessionId,baseURL=`http://127.0.0.1:${port}`;
  const peers=new Set<{close():void}>(),peer=new Peer({port,sessionId,baseURL,token,clientId,peers} as any);
  let release!:()=>void,entered!:()=>void;
  const held=new Promise<void>(r=>release=r),arrived=new Promise<void>(r=>entered=r);
  t.after(async()=>{release();for(const p of peers)p.close();try{await app.close();}finally{await dirs.cleanup();}});
  await peer.connect();
  const start=await fetch(baseURL+'/api/session/start',{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify({requestId:id(),clientId,sessionId,limitMs:null,pauseOnHidden:true})});
  assert.equal(start.status,200);
  const capture=app.workspace.createSnapshotAsync.bind(app.workspace);
  t.mock.method(app.workspace,'createSnapshotAsync',async(...args:Parameters<typeof capture>)=>{entered();await held;return capture(...args);});
  const finish=fetch(baseURL+'/api/session/finish',{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},
    body:JSON.stringify({requestId:id(),clientId,sessionId,expectedWorkspaceVersion:app.workspace.workspaceVersion,reason:'COMPLETED'})});
  await arrived;
  const oldEpoch=app.session.state.controlEpoch;
  for(const [type,payload] of [
    ['PING',{lastAppliedSeq:0}],
    ['VETO_ESCAPE',{controlEpoch:oldEpoch,activeInterventionId:null,lastAppliedSeq:0}],
    ['WINDOW_STATE',{presence:'HIDDEN'}],
    ['TIMER_ACTION',{action:'PAUSE',pauseOnHidden:null}],
  ] as const){const ack=await peer.ack(peer.send(type,payload));assert.equal(ack.payload.status,'OK',JSON.stringify(ack.payload));}
  assert.ok(app.session.state.controlEpoch>oldEpoch);
  assert.equal(app.session.state.presence,'HIDDEN');
  const write=await peer.ack(peer.send('CODE_CHANGED',{path:'main.js',content:'FORBIDDEN\n',baseVersion:1,controlEpoch:app.session.state.controlEpoch,editKind:'TYPING'}));
  assert.equal(write.payload.status,'REJECTED');assert.equal(write.payload.error.code,'SESSION_TRANSITION');
  assert.equal(await readFile(path.join(dirs.rootPath,'main.js'),'utf8'),'ORIGINAL\n');
  release();assert.equal((await finish).status,202);
  peer.assertProtocol();
});
