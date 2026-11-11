import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { WebSocket } from 'ws';
import { validateMessage } from '../../src/server/transport';
import { createPairCoachServer, type ServerOptions, type ServiceContext } from '../../src/server/http';

const token='p1-ledger-only-ephemeral-token';
function deferred<T>() {let resolve!:(value:T)=>void;const promise=new Promise<T>(yes=>resolve=yes);return {promise,resolve};}
class Frames {
  values:any[]=[];private listeners=new Set<()=>void>();
  add(value:any) {this.values.push(value);for(const check of this.listeners)check();}
  take(match:(frame:any)=>boolean):Promise<any> {return new Promise((resolve,reject)=>{
    const check=()=>{const i=this.values.findIndex(match);if(i>=0){clearTimeout(timer);this.listeners.delete(check);resolve(this.values.splice(i,1)[0]);}};
    const timer=setTimeout(()=>{this.listeners.delete(check);reject(new Error('Missing real WS frame'));},5000);
    this.listeners.add(check);check();
  });}
}
async function fixture(t:any, options:ServerOptions={}) {
  const temp=fs.mkdtempSync(path.join(os.tmpdir(),'p1-ledger-http-'));
  const roots=['a','b','c'].map(name=>{const root=path.join(temp,name);fs.mkdirSync(root);fs.writeFileSync(path.join(root,'challenge.md'),'# task');fs.writeFileSync(path.join(root,'solution.js'),'original\n');return root;});
  const tempRoot=path.join(temp,'receipts');fs.mkdirSync(tempRoot);
  const app=createPairCoachServer({port:0,token,rootPath:roots[0],dataDir:path.join(temp,'data'),...options,
    ledgerOptions:{tempRoot,...options.ledgerOptions},openLedgerOptions:{tempRoot,...options.openLedgerOptions}});
  const port=await app.listen(),base=`http://127.0.0.1:${port}`;
  const clients:WebSocket[]=[];
  t.after(async()=>{for(const ws of clients)ws.terminate();await app.close();assert.deepEqual(fs.readdirSync(tempRoot),[]);fs.rmSync(temp,{recursive:true,force:true});});
  async function request(target:string,body?:unknown) {
    const response=await fetch(base+target,{method:body?'POST':'GET',headers:{Authorization:`Bearer ${token}`,...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined});
    return {status:response.status,body:await response.json()};
  }
  const initial=(await request('/api/project')).body;
  async function peer(sessionId=initial.sessionId,clientId='p1-client') {
    const ws=new WebSocket(`ws://127.0.0.1:${port}/ws/session`);clients.push(ws);
    const frames=new Frames();ws.on('message',raw=>frames.add(JSON.parse(raw.toString())));
    await once(ws,'open');
    const send=(type:string,payload:unknown,messageId:string=randomUUID(),sid=sessionId)=>{
      const frame={protocolVersion:'3.0',messageId,sessionId:sid,clientId,type,payload};
      assert(validateMessage(frame),'fixture must send a real schema-valid message');
      ws.send(JSON.stringify(frame));return messageId;
    };
    const ack=(id:string)=>frames.take(frame=>frame.type==='ACK'&&frame.payload.replyTo===id);
    send('HELLO',{token,lastServerSeq:0});await frames.take(frame=>frame.type==='SESSION_SNAPSHOT');
    return {ws,frames,send,ack};
  }
  const open=(i:number,requestId:string=randomUUID())=>({requestId,clientId:'p1-client',rootPath:roots[i],settings:initial.settings});
  return {app,tempRoot,roots,request,initial,peer,open};
}
const view=(file:string)=>({path:file,documentVersion:null,cursor:null,selection:null});

test('P1 real HTTP/WS: PING no history, VIEW dedupe, truthful session reset, old open IDs never switch again',async t=>{
  const f=await fixture(t,{ledgerOptions:{maxEntries:2}}),client=await f.peer();
  for(let i=0;i<32;i++) assert.equal((await client.ack(client.send('PING',{lastAppliedSeq:0}))).payload.status,'OK');
  assert.deepEqual(fs.readdirSync(f.tempRoot),[],'heartbeat cannot allocate receipts');
  const a=client.send('VIEW_CHANGED',view('solution.js'));assert.equal((await client.ack(a)).payload.status,'OK');
  const b=client.send('VIEW_CHANGED',view('challenge.md'));assert.equal((await client.ack(b)).payload.status,'OK');
  client.send('VIEW_CHANGED',view('solution.js'),a);assert.equal((await client.ack(a)).payload.status,'DUPLICATE');
  assert.equal((await f.request('/api/session')).body.activeFilePath,'challenge.md');
  client.send('VIEW_CHANGED',view('challenge.md'),a);assert.equal((await client.ack(a)).payload.error.code,'IDEMPOTENCY_CONFLICT');
  const limited=await client.ack(client.send('VIEW_CHANGED',view('solution.js')));assert.equal(limited.payload.error.code,'COMMAND_LIMIT');
  const first=f.open(1),openedB=await f.request('/api/project/open',first);assert.equal(openedB.status,201);
  assert.notEqual(openedB.body.sessionId,f.initial.sessionId);
  const second=f.open(2),openedC=await f.request('/api/project/open',second);assert.equal(openedC.status,201);
  const replay=await f.request('/api/project/open',first);assert.deepEqual(replay,openedB);
  assert.equal((await f.request('/api/project')).body.sessionId,openedC.body.sessionId);
  assert.equal((await f.request('/api/project/open',{...first,rootPath:f.roots[2]})).body.code,'IDEMPOTENCY_CONFLICT');
  const stale=await f.request('/api/session/veto',{requestId:'old-session',clientId:'p1-client',sessionId:f.initial.sessionId,controlEpoch:0,activeInterventionId:null,lastAppliedSeq:0});
  assert.equal(stale.status,409);
  const current=await f.peer(openedC.body.sessionId);
  assert.equal((await current.ack(current.send('VIEW_CHANGED',view('solution.js')))).payload.status,'OK','new session actually has new budget');
});

test('P1 real HTTP: open ledger has its own truthful process budget and remembers failures/known retry after adoption',async t=>{
  const f=await fixture(t,{openLedgerOptions:{maxEntries:1}});
  const first=f.open(1);assert.equal((await f.request('/api/project/open',first)).status,201);
  const limited=await f.request('/api/project/open',f.open(2));assert.equal(limited.status,429);
  assert.equal(limited.body.code,'COMMAND_LIMIT');assert.match(limited.body.message,/serwer/);
  assert.equal((await f.request('/api/project/open',first)).status,201);
  assert.equal((await f.request('/api/project/open',{...first,rootPath:f.roots[2]})).status,409);
  assert.equal((await f.request('/api/project')).body.rootPath,f.roots[1]);
});

test('P1 real HTTP: deferred old stop settles to retired ledger; pending open cannot be superseded by another open',async t=>{
  const stopped=deferred<any>(),stopStarted=deferred<void>(),opening=deferred<void>(),openingStarted=deferred<void>();let initialRoot='';
  t.after(()=>{opening.resolve();stopped.resolve({runId:'cleanup'});});
  const f=await fixture(t,{executionFactory:context=>{
    initialRoot ||= context.workspace.rootPath;
    const isInitial=context.workspace.rootPath===initialRoot;
    return {runner:{setApprovedProfiles(){},start(){throw new Error('unused');},get(){throw new Error('unused');},list(){return [];},
      stop(){stopStarted.resolve();return stopped.promise;},stopAll(){if(isInitial){openingStarted.resolve();return opening.promise;}return Promise.resolve();}},
      reports:{finish(){throw new Error('unused');},get(){throw new Error('unused');},retry(){throw new Error('unused');},close(){}}};
  }});
  await f.peer();
  const stop=f.request('/api/run/old-run/stop',{requestId:'stop-old',clientId:'p1-client',sessionId:f.initial.sessionId});await stopStarted.promise;
  const first=f.open(1),open=f.request('/api/project/open',first);await openingStarted.promise;
  const competing=await f.request('/api/project/open',f.open(2));assert.equal(competing.status,409);assert.equal(competing.body.code,'SESSION_TRANSITION');
  assert.equal((await f.request('/api/project')).body.sessionId,f.initial.sessionId);
  opening.resolve();const adopted=await open;assert.equal(adopted.status,201);
  assert.equal(fs.readdirSync(f.tempRoot).length,2,'old stop receipt scope stays until pending settles; open scope remains');
  const current=(await f.request('/api/session')).body;
  stopped.resolve({runId:'old-run',status:'CANCELLED'});assert.equal((await stop).status,202);
  assert.equal(fs.readdirSync(f.tempRoot).length,1,'retired scope cleaned after terminal result');
  const after=(await f.request('/api/session')).body;
  // computeTimer intentionally stamps current wall time on every GET; all actual state stays equal.
  assert.equal(typeof after.timer.serverTime,'string');assert.equal(typeof current.timer.serverTime,'string');
  assert.deepEqual({...after,timer:{...after.timer,serverTime:null}},{...current,timer:{...current.timer,serverTime:null}},'late stop cannot touch adopted core');
  const oldAgain=await f.request('/api/run/old-run/stop',{requestId:'stop-old',clientId:'p1-client',sessionId:f.initial.sessionId});assert.equal(oldAgain.status,409);
  assert.equal((await f.request('/api/project/open',first)).body.sessionId,adopted.body.sessionId);
});

test('P1 real WS: VETO receipts survive new epochs and do not revoke a later coach intervention twice',async t=>{
  const f=await fixture(t),client=await f.peer();
  f.app.workspace.updateSettings({...f.initial.settings,aiConsent:true});
  f.app.session.start(null,false);f.app.session.setAiStatus('READY');
  const payload={controlEpoch:f.app.session.state.controlEpoch,activeInterventionId:null,lastAppliedSeq:0};
  const id=client.send('VETO_ESCAPE',payload);assert.equal((await client.ack(id)).payload.status,'OK');
  const epoch=f.app.session.state.controlEpoch;
  // SessionController.veto is intentionally a no-op during student cooldown.
  // A real new fact unlocks it; a new coach acquisition must survive the old duplicate.
  assert.equal((await client.ack(client.send('CHAT_MESSAGE',{text:'new task fact',path:null,documentVersion:null,selection:null}))).payload.status,'OK');
  const after=f.app.session.acquireCoach('new-intervention');assert(after>epoch);
  client.send('VETO_ESCAPE',payload,id);assert.equal((await client.ack(id)).payload.status,'DUPLICATE');assert.equal(f.app.session.state.controlEpoch,after);
  assert.equal(f.app.session.state.writeOwner,'COACH');assert.equal(f.app.session.state.interventionId,'new-intervention');
  client.send('VETO_ESCAPE',{...payload,lastAppliedSeq:1},id);assert.equal((await client.ack(id)).payload.error.code,'IDEMPOTENCY_CONFLICT');
});

test('P1 real WS: accepted concurrent proposal decisions restore once; changed decision conflicts; stable rejection replay',async t=>{
  let context:ServiceContext|undefined;
  const f=await fixture(t,{enableCoach:true,coachFactory:ctx=>{context=ctx;return {trigger(){},controlReady(){},stepRendered(){},abort(){},close(){}};}}),client=await f.peer();
  const snapshot=f.app.workspace.createSnapshot('before edit');
  const original=f.app.workspace.getDocument('solution.js');
  const edit=client.send('CODE_CHANGED',{path:'solution.js',baseVersion:original.version,controlEpoch:f.app.session.state.controlEpoch,content:'edited\n',editKind:'TYPING'});
  assert.equal((await client.ack(edit)).payload.status,'OK');
  const post=async(snapshotId:string)=>{context!.onProposal({kind:'PROPOSE',proposalKind:'RESTORE_SNAPSHOT',questionText:'restore?',snapshotId,paths:['solution.js'],resetTimer:false});return (await client.frames.take(frame=>frame.type==='ACTION_PROPOSAL')).payload;};
  const proposal=await post(snapshot.snapshotId),before=f.app.workspace.workspaceVersion;
  const payload={proposalId:proposal.proposalId,accepted:true,basedOnWorkspaceVersion:proposal.basedOnWorkspaceVersion};
  const a=client.send('PROPOSAL_RESPONSE',payload),b=client.send('PROPOSAL_RESPONSE',payload);
  const replies=await Promise.all([client.ack(a),client.ack(b)]);assert.deepEqual(replies.map(frame=>frame.payload.status).sort(),['DUPLICATE','OK']);
  assert.equal(f.app.workspace.getDocument('solution.js').content,'original\n');assert.equal(f.app.workspace.workspaceVersion,before+1);
  const replay=await client.ack(client.send('PROPOSAL_RESPONSE',payload));assert.equal(replay.payload.status,'DUPLICATE');assert.equal(f.app.workspace.workspaceVersion,before+1);
  const changed=await client.ack(client.send('PROPOSAL_RESPONSE',{...payload,accepted:false}));assert.equal(changed.payload.error.code,'IDEMPOTENCY_CONFLICT');
  const missing=await post('missing-snapshot');
  const reject={proposalId:missing.proposalId,accepted:true,basedOnWorkspaceVersion:missing.basedOnWorkspaceVersion};
  const failed=(await client.ack(client.send('PROPOSAL_RESPONSE',reject))).payload.error;
  assert(failed);assert.notEqual(failed.code,'STALE_PROPOSAL');
  const failedAgain=(await client.ack(client.send('PROPOSAL_RESPONSE',reject))).payload.error;
  assert.equal(failedAgain.code,failed.code);assert.equal(failedAgain.message,failed.message);assert.equal(failedAgain.currentVersion,failed.currentVersion);
});

test('P1 real HTTP: closing during deferred project adoption never installs a fresh unretired scope',async t=>{
  const release=deferred<void>(),started=deferred<void>();let initialRoot='';
  t.after(()=>release.resolve());
  const f=await fixture(t,{executionFactory:context=>{
    initialRoot ||= context.workspace.rootPath;
    return {runner:{setApprovedProfiles(){},start(){throw new Error('unused');},get(){throw new Error('unused');},list(){return [];},stop(){throw new Error('unused');},
      stopAll(){if(context.workspace.rootPath===initialRoot){started.resolve();return release.promise;}return Promise.resolve();}},
      reports:{finish(){throw new Error('unused');},get(){throw new Error('unused');},retry(){throw new Error('unused');},close(){}}};
  }});
  const pending=f.request('/api/project/open',f.open(1));await started.promise;
  const closing=f.app.close();release.resolve();
  const response=await pending;assert.equal(response.status,503);assert.equal(response.body.code,'SESSION_CLOSED');
  await closing;assert.equal(f.app.workspace.rootPath,f.roots[0]);assert.deepEqual(fs.readdirSync(f.tempRoot),[]);
});

test('P1 real HTTP: oversize after-effect warns publicly, identical retry stays failed without another effect',async t=>{
  let effects=0;
  const f=await fixture(t,{ledgerOptions:{maxOutcomeBytes:1024},executionFactory:()=>({
    runner:{setApprovedProfiles(){},start(){throw new Error('unused');},get(){throw new Error('unused');},list(){return [];},stopAll(){return Promise.resolve();},
      stop(){effects++;return Promise.resolve({runId:'large',outputTail:'x'.repeat(2048)} as any);}},
    reports:{finish(){throw new Error('unused');},get(){throw new Error('unused');},retry(){throw new Error('unused');},close(){}}
  })});
  await f.peer();
  const command={requestId:'oversize',clientId:'p1-client',sessionId:f.initial.sessionId};
  const first=await f.request('/api/run/large/stop',command),duplicate=await f.request('/api/run/large/stop',command);
  assert.equal(first.status,503);assert.equal(first.body.code,'COMMAND_RESULT_UNAVAILABLE');
  assert.match(first.body.message,/mogła zostać wykonana/);assert.match(first.body.message,/nie ponawiaj z nowym ID/);
  assert.deepEqual(duplicate,first);assert.equal(effects,1);
});
