/** P6 corrective regressions: real storage/REST/WS/Run; only report AI callback is injected. */
import test, {type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {createPairCoachServer, type ServerOptions, type ReportAIFacts} from '../../src/server/http';
import {WorkspaceService} from '../../src/server/WorkspaceService';
import {SessionController} from '../../src/server/SessionController';
import {ReportService} from '../../src/server/ReportService';
import type {CoachContext} from '../../src/server/coach/context';
import {Peer, workspaceFiles, settings, id} from '../qa/helpers';
import {httpRunFixture} from '../backend-cutover/http-run-report-fixture';

async function fixture(t:TestContext,options:Partial<ServerOptions>={}) {
  const dirs=await workspaceFiles(t,{'main.py':'ORIGINAL\n'}),token='corrective-'+id();
  const app=createPairCoachServer({rootPath:dirs.rootPath,token,port:0,enableExecution:true,...options});
  const port=await app.listen(),baseURL=`http://127.0.0.1:${port}`,clientId=id(),sessionId=app.session.state.sessionId;
  const peers=new Set<{close():void}>();
  t.after(async()=>{for(const p of peers)p.close();try{await app.close();}finally{await dirs.cleanup();}});
  async function http(method:string,url:string,body?:unknown) {
    const r=await fetch(baseURL+url,{method,headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(5000)});
    return {status:r.status,body:await r.json()};
  }
  const f={...dirs,token,app,port,baseURL,clientId,sessionId,peers,http};
  const peer=new Peer(f as any);await peer.connect();
  return {...f,peer,command:()=>({requestId:id(),clientId,sessionId})};
}
async function until<T>(read:()=>Promise<T>,valid:(v:T)=>boolean) {
  for(let i=0;i<200;i++){const value=await read();if(valid(value))return value;await delay(10);}assert.fail('terminal state not observed');
}

for(const obstruction of ['report-store','coach-constructor'] as const)test(`G3 failed open (${obstruction}) preserves exact live core/lease/socket and closes prepared resources`,async t=>{
  let refuse=false;
  const f=await fixture(t,obstruction==='coach-constructor'?{enableCoach:true,coachFactory:()=>{
    if(refuse)throw new Error('explicit new coach construction failure');
    return {trigger(){},controlReady(){},stepRendered(){},abort(){},close(){}};
  }}:{});
  const old={workspace:f.app.workspace,session:f.app.session,gate:f.app.gate};
  const epoch=old.session.state.controlEpoch;
  const nextRoot=path.join(f.base,'next');fs.mkdirSync(nextRoot);fs.writeFileSync(path.join(nextRoot,'main.py'),'NEXT');
  const closedWorkspaces:WorkspaceService[]=[],closedSessions:SessionController[]=[],closedReports:ReportService[]=[];
  const wc=WorkspaceService.prototype.close,sc=SessionController.prototype.close,rc=ReportService.prototype.close;
  t.mock.method(WorkspaceService.prototype,'close',function(this:WorkspaceService){closedWorkspaces.push(this);return wc.call(this);});
  t.mock.method(SessionController.prototype,'close',function(this:SessionController){closedSessions.push(this);return sc.call(this);});
  t.mock.method(ReportService.prototype,'close',function(this:ReportService){closedReports.push(this);return rc.call(this);});
  if(obstruction==='report-store') {
    const data=path.join(nextRoot,'.paircoach');
    fs.mkdirSync(data,{recursive:true});fs.writeFileSync(path.join(data,'reports'),'OBSTRUCTION');
  }else refuse=true;
  const r=await f.http('POST','/api/project/open',{requestId:id(),clientId:f.clientId,rootPath:nextRoot,settings:{...settings,schemaVersion:2}});
  assert.equal(r.status,500);
  assert.equal(f.app.workspace,old.workspace);assert.equal(f.app.session,old.session);assert.equal(f.app.gate,old.gate);
  assert.equal(old.session.leaseClientId,f.clientId);assert.equal(old.session.state.controlEpoch,epoch);
  assert(closedWorkspaces.length>0&&closedWorkspaces.every(w=>w!==old.workspace));
  assert(closedSessions.length>0&&closedSessions.every(s=>s!==old.session));
  if(obstruction==='coach-constructor')assert.equal(closedReports.length,1,'execution prepared before coach failure must close');
  assert.equal(f.peer.socket.readyState,1);
  const document=old.workspace.getDocument('main.py');
  const ack=await f.peer.ack(f.peer.send('CODE_CHANGED',{path:'main.py',content:'STILL LIVE',baseVersion:document.version,controlEpoch:epoch,editKind:'TYPING'}));
  assert.equal(ack.payload.status,'OK');assert.equal(fs.readFileSync(path.join(f.rootPath,'main.py'),'utf8'),'STILL LIVE');
  assert.equal((await f.http('POST','/api/session/start',{...f.command(),limitMs:null,pauseOnHidden:true})).status,200);
  fs.writeFileSync(path.join(f.rootPath,'main.py'),'EXTERNAL AFTER FAILURE');old.workspace.scanExternal();
  await f.peer.take(m=>m.type==='EXTERNAL_FILE_SYNC'&&m.payload.document?.content==='EXTERNAL AFTER FAILURE');
  f.peer.assertProtocol();
});

test('G3 prepared successful open adopts new core once; new peer gate/external events use new binding',async t=>{
  const f=await fixture(t),oldWorkspace=f.app.workspace,oldSession=f.app.session;
  const nextRoot=path.join(f.base,'next');fs.mkdirSync(nextRoot);fs.writeFileSync(path.join(nextRoot,'main.py'),'NEXT');
  const body={requestId:id(),clientId:f.clientId,rootPath:nextRoot,settings:{...settings,schemaVersion:2}};
  const r=await f.http('POST','/api/project/open',body);assert.equal(r.status,201);assert.notEqual(r.body.sessionId,f.sessionId);
  const again=await f.http('POST','/api/project/open',body);assert.deepEqual(again,r);
  assert.equal(f.app.workspace.rootPath,nextRoot);assert.equal(oldSession.leaseClientId,null);
  assert.throws(()=>oldWorkspace.getDocument('main.py'),{code:'WORKSPACE_CLOSED'});
  const peer=new Peer({...f,sessionId:r.body.sessionId} as any);await peer.connect();
  const d=(await f.http('GET','/api/file?path=main.py')).body;
  const ack=await peer.ack(peer.send('CODE_CHANGED',{path:'main.py',content:'NEW BINDING WRITE',baseVersion:d.version,controlEpoch:f.app.session.state.controlEpoch,editKind:'TYPING'}));
  assert.equal(ack.payload.status,'OK');assert.equal(fs.readFileSync(path.join(nextRoot,'main.py'),'utf8'),'NEW BINDING WRITE');
  fs.writeFileSync(path.join(nextRoot,'main.py'),'NEW EXTERNAL');f.app.workspace.scanExternal();
  await peer.take(m=>m.type==='EXTERNAL_FILE_SYNC'&&m.payload.document?.content==='NEW EXTERNAL');peer.assertProtocol();
});

test('G3 both AI boundaries share structural Run allowlist; arbitrary stdout stays local in UI and frozen facts',async t=>{
  const apiToken='synthetic_gemini_'+id(),previous=process.env.GEMINI_API_KEY;
  process.env.GEMINI_API_KEY=apiToken;
  t.after(()=>{if(previous===undefined)delete process.env.GEMINI_API_KEY;else process.env.GEMINI_API_KEY=previous;});
  // Current neutral HTTP/Runner composition, modeled Docker stdout only. A Run
  // must not read the pupil's .env; untrusted process output enters at that port.
  const f=await httpRunFixture(t),opaque='opaque_private_'+id();
  fs.appendFileSync(path.join(f.project,'main.js'),'// '+apiToken+'\n');
  fs.writeFileSync(path.join(f.project,'.env.fixture'),opaque);
  f.fake.logs={stdout:opaque+'\n',stderr:''};
  const app=f.app(),port=await app.listen(),p=(await f.http(port,'GET','/api/project?readiness=actual')).body;
  const peer=await f.connect(port,p.sessionId),command=()=>({requestId:id(),clientId:'tab',sessionId:p.sessionId});
  assert.equal((await f.http(port,'POST','/api/session/start',{...command(),limitMs:null,pauseOnHidden:true})).status,200);
  const r=await f.http(port,'POST','/api/run',f.runRequest(p,'RUN_MAIN'));assert.equal(r.status,202,JSON.stringify(r));
  f.fake.finish();
  const run=await until(async()=>(await f.http(port,'GET',`/api/run/${r.body.runId}`)).body,v=>!!v.finishedAt);
  assert.equal(run.status,'SUCCEEDED');assert(run.outputTail.includes(opaque));
  await until(async()=>peer.frames.find(m=>m.type==='RUN_OUTPUT'&&m.payload.chunk.includes(opaque)),Boolean);
  const contexts=f.analyses as CoachContext[],received=f.ai;
  const runContext=await until(async()=>contexts.find(c=>c.lastRun?.runId===run.runId),Boolean);
  assert(runContext?.lastRun);assert.equal(JSON.stringify(contexts).includes(opaque),false);
  assert.equal(Object.hasOwn(runContext.lastRun,'outputTail'),false);assert.equal(runContext.lastRun.testOutcome,run.testOutcome);
  assert.equal(JSON.stringify(contexts).includes(apiToken),false,'configured Gemini token is sensitive at Coach boundary');
  assert.equal((await f.http(port,'POST','/api/session/finish',{...command(),reason:'COMPLETED',expectedWorkspaceVersion:app.workspace.workspaceVersion})).status,202);
  await until(async()=>(await f.http(port,'GET',`/api/session/report?sessionId=${p.sessionId}`)).body,v=>v.status==='READY');
  assert.equal(received.length,1);assert.equal(JSON.stringify(received).includes(opaque),false);
  assert.equal(JSON.stringify(received).includes(apiToken),false);assert.deepEqual(received[0].runs[0],runContext.lastRun);
  assert.deepEqual(Object.keys(received[0].runs[0]).sort(),['runId','mode','status','exitCode','workspaceVersionAtStart','workspaceChangedDuringRun','testOutcome','testCount','startedAt','finishedAt','profileId','configurationGeneration'].sort());
  assert.equal(received[0].runs[0].testOutcome,run.testOutcome);assert.equal(received[0].runs[0].runId,run.runId);
  const reportRoot=path.join(app.workspace.dataDir,'reports'),dir=fs.readdirSync(reportRoot).find(n=>fs.existsSync(path.join(reportRoot,n,'facts.json')))!;
  const frozen=JSON.parse(JSON.parse(fs.readFileSync(path.join(reportRoot,dir,'facts.json'),'utf8')).serialized);
  assert(frozen.runs[0].outputTail.includes(opaque));assert(frozen.events.some((e:any)=>e.type==='RUN'&&e.run.outputTail.includes(opaque)));

});

for(const revoked of [false,true])test(`G3 async seam awaits one gate promise before terminal ACK; ${revoked?'VETO revokes captured auth':'success deduplicates'}`,async t=>{
  const f=await fixture(t),source=f.app.workspace.createSnapshot('Source',['main.py']);
  let d=f.app.workspace.getDocument('main.py');
  assert.equal((await f.peer.ack(f.peer.send('CODE_CHANGED',{path:'main.py',baseVersion:d.version,content:'WORK',controlEpoch:f.app.session.state.controlEpoch,editKind:'TYPING'}))).payload.status,'OK');
  await f.peer.ack(f.peer.send('PROPOSAL_REQUEST',{kind:'RESTORE_SNAPSHOT',snapshotId:source.snapshotId}));
  const proposal=(await f.peer.take(m=>m.type==='ACTION_PROPOSAL')).payload;
  const realRestore=f.app.gate.restoreSnapshot.bind(f.app.gate);
  let release!:()=>void,calls=0;
  // Explicit simulation ONLY of an async seam, not evidence of P1 async I/O or native timing.
  t.mock.method(f.app.gate,'restoreSnapshot',async(input:Parameters<typeof realRestore>[0])=>{
    calls++;await new Promise<void>(r=>{release=r;});return realRestore(input);
  });
  const payload={proposalId:proposal.proposalId,accepted:true,basedOnWorkspaceVersion:proposal.basedOnWorkspaceVersion};
  const original=f.peer.send('PROPOSAL_RESPONSE',payload);
  await until(async()=>!!release,Boolean);
  f.peer.send('PROPOSAL_RESPONSE',payload,original);const duplicate=f.peer.send('PROPOSAL_RESPONSE',payload);
  assert.equal((await f.peer.ack(f.peer.send('PING',{lastAppliedSeq:0}))).payload.status,'OK');
  assert.equal(f.peer.frames.some(m=>m.type==='ACK'&&m.payload.replyTo===original),false,'no early success while gate pending');
  d=f.app.workspace.getDocument('main.py');
  const blocked=await f.peer.ack(f.peer.send('CODE_CHANGED',{path:'main.py',baseVersion:d.version,content:'MUST NOT WRITE',controlEpoch:f.app.session.state.controlEpoch,editKind:'TYPING'}));
  assert.equal(blocked.payload.error.code,'SESSION_TRANSITION');
  assert.equal((await f.peer.ack(f.peer.send('WINDOW_STATE',{presence:'HIDDEN'}))).payload.status,'OK');
  if(revoked)assert.equal((await f.peer.ack(f.peer.send('VETO_ESCAPE',{controlEpoch:f.app.session.state.controlEpoch,activeInterventionId:null,lastAppliedSeq:0}))).payload.status,'OK');
  release();
  const a=await f.peer.ack(original),b=await f.peer.ack(original),c=await f.peer.ack(duplicate);
  assert.equal(calls,1);
  if(revoked) {
    for(const ack of [a,b,c]){assert.equal(ack.payload.status,'REJECTED');assert.equal(ack.payload.error.code,'STALE_EPOCH');}
    assert.equal(fs.readFileSync(path.join(f.rootPath,'main.py'),'utf8'),'WORK');assert.equal(f.app.workspace.listSnapshots().length,1);
  }else {
    assert.deepEqual([a,b,c].map(m=>m.payload.status).sort(),['DUPLICATE','DUPLICATE','OK']);
    assert.equal(fs.readFileSync(path.join(f.rootPath,'main.py'),'utf8'),'ORIGINAL\n');assert.equal(f.app.workspace.listSnapshots().length,2);
  }
  // Transition must clear after both settlement paths; next student write is authorized normally.
  d=f.app.workspace.getDocument('main.py');
  const after=await f.peer.ack(f.peer.send('CODE_CHANGED',{path:'main.py',baseVersion:d.version,content:'AFTER SETTLEMENT',controlEpoch:f.app.session.state.controlEpoch,editKind:'TYPING'}));
  assert.equal(after.payload.status,'OK');
});

test('G3 finish awaits yieldable capture before persistence and FINISHED; identical HTTP request shares result',async t=>{
  const f=await fixture(t),capture=f.app.workspace.createSnapshotAsync.bind(f.app.workspace);
  let release!:()=>void,captures=0;
  // Promise seam simulation, not a scaled capture/performance proof.
  t.mock.method(f.app.workspace,'createSnapshotAsync',async(...args:Parameters<typeof capture>)=>{
    captures++;await new Promise<void>(r=>{release=r;});return capture(...args);
  });
  const body={...f.command(),reason:'COMPLETED',expectedWorkspaceVersion:f.app.workspace.workspaceVersion};
  const first=f.http('POST','/api/session/finish',body);await until(async()=>!!release,Boolean);
  assert.equal((await f.http('GET','/api/session')).body.lifecycle,'READY');
  assert.equal((await f.http('GET',`/api/session/report?sessionId=${f.sessionId}`)).status,404);
  assert.equal(f.peer.frames.some(m=>m.type==='SESSION_REPORT'),false);
  assert.equal((await f.peer.ack(f.peer.send('PING',{lastAppliedSeq:0}))).payload.status,'OK');
  assert.equal((await f.peer.ack(f.peer.send('VETO_ESCAPE',{controlEpoch:f.app.session.state.controlEpoch,activeInterventionId:null,lastAppliedSeq:0}))).payload.status,'OK');
  const second=f.http('POST','/api/session/finish',body);
  release();const [a,b]=await Promise.all([first,second]);assert.equal(a.status,202);assert.deepEqual(b,a);
  assert.equal(a.body.status,'PENDING');assert.equal(captures,1);assert.equal(f.app.workspace.listSnapshots().length,1);
  assert.equal((await f.http('GET','/api/session')).body.lifecycle,'FINISHED');
});
