/** P6 transport contract: actual REST/WS, WriteGate, durable files, Runner and ReportService.
 * Only the AI boundary is injected; filesystem sabotage below is an explicit negative stimulus. */
import test, {type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {createPairCoachServer, type ServerOptions, type ReportAIFacts} from '../../src/server/http';
import {REPORT_SYSTEM_PROMPT, type FrozenFacts} from '../../src/server/ReportService';
import {WorkspaceService} from '../../src/server/WorkspaceService';
import {SessionController} from '../../src/server/SessionController';
import {Peer, workspaceFiles, id, settings} from '../qa/helpers';
import {liveNodeFixture,scriptProfile} from '../qa/live-node-fixture';
import {httpRunFixture} from '../backend-cutover/http-run-report-fixture';

async function fixture(t:TestContext, options:Partial<ServerOptions>={}, files:Record<string,string>={}) {
  const dirs=await workspaceFiles(t, {'main.py':'ORIGINAL\r\n',...files});
  const token='g3-test-sensitive-'+id();
  const app=createPairCoachServer({rootPath:dirs.rootPath,port:0,token,enableExecution:true,...options});
  const peers=new Set<{close():void}>();
  t.after(async()=>{for(const p of peers)p.close();await app.close();await dirs.cleanup();});
  const port=await app.listen(),baseURL=`http://127.0.0.1:${port}`;
  const sessionId=app.session.state.sessionId,clientId=id();
  const http=async(method:string,url:string,body?:unknown)=>{
    const response=await fetch(baseURL+url,{method,headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},
      body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(5000)});
    return {status:response.status,body:await response.json()};
  };
  const f={...dirs,app,token,peers,port,baseURL,sessionId,clientId,http};
  const peer=new Peer(f as any);await peer.connect();
  const command=()=>({requestId:id(),clientId,sessionId});
  const write=async(content:string)=>{
    const document=app.workspace.getDocument('main.py');
    const ack=await peer.ack(peer.send('CODE_CHANGED',{path:'main.py',content,baseVersion:document.version,
      controlEpoch:app.session.state.controlEpoch,editKind:'TYPING'}));assert.equal(ack.payload.status,'OK');return ack;
  };
  const proposal=async(snapshotId:string)=>{
    assert.equal((await peer.ack(peer.send('PROPOSAL_REQUEST',{kind:'RESTORE_SNAPSHOT',snapshotId}))).payload.status,'OK');
    return (await peer.take(m=>m.type==='ACTION_PROPOSAL')).payload;
  };
  const respond=(p:any,accepted=true,messageId=id())=>peer.ack(peer.send('PROPOSAL_RESPONSE',{
    proposalId:p.proposalId,accepted,basedOnWorkspaceVersion:p.basedOnWorkspaceVersion},messageId));
  const finish=()=>http('POST','/api/session/finish',{...command(),reason:'COMPLETED',expectedWorkspaceVersion:app.workspace.workspaceVersion});
  return {...f,peer,command,write,proposal,respond,finish};
}
async function until<T>(read:()=>T|Promise<T>,valid:(v:T)=>boolean,ms=5000):Promise<T> {
  const deadline=Date.now()+ms;let value:T;
  do {value=await read();if(valid(value))return value;await delay(10);}while(Date.now()<deadline);
  assert.fail('Expected state not reached: '+JSON.stringify(value));
}
function factsOnDisk(app:ReturnType<typeof createPairCoachServer>):FrozenFacts {
  const base=path.join(app.workspace.dataDir,'reports');
  const dir=fs.readdirSync(base).find(name=>fs.existsSync(path.join(base,name,'facts.json')))!;
  return JSON.parse(JSON.parse(fs.readFileSync(path.join(base,dir,'facts.json'),'utf8')).serialized);
}

test('G3 restore goes through gate once per proposalId with two distinct messageIds; backup and no timer reset',async t=>{
  const f=await fixture(t);
  const source=f.app.workspace.createSnapshot('Before work',['main.py']);
  await f.write('USER WORK\n');
  await f.http('POST','/api/session/start',{...f.command(),limitMs:60000,pauseOnHidden:true});await delay(25);
  const before=f.app.session.getSession().timer.elapsedMs;
  const p=await f.proposal(source.snapshotId);
  assert(Date.parse(p.expiresAt)>Date.now()+59000);assert.equal(p.resetTimer,false);
  const gateRestore=f.app.gate.restoreSnapshot.bind(f.app.gate);let calls=0;let based:number|undefined;
  t.mock.method(f.app.gate,'restoreSnapshot',(input:Parameters<typeof gateRestore>[0])=>{calls++;based=input.expectedWorkspaceVersion;return gateRestore(input);});
  const [a,b]=await Promise.all([f.respond(p),f.respond(p)]);
  assert.deepEqual([a.payload.status,b.payload.status].sort(),['DUPLICATE','OK']);assert.equal(calls,1);assert.equal(based,p.basedOnWorkspaceVersion);
  assert.equal(fs.readFileSync(path.join(f.rootPath,'main.py'),'utf8'),'ORIGINAL\r\n');
  const listed=await f.http('GET','/api/snapshots');assert.equal(listed.status,200);assert.equal(listed.body.length,2);
  const backup=listed.body.find((s:any)=>s.snapshotId!==source.snapshotId);
  assert.equal(Buffer.from(f.app.workspace.readSnapshot(backup.snapshotId).files[0].rawBase64!,'base64').toString(),'USER WORK\r\n');
  assert(f.app.session.getSession().timer.elapsedMs>=before);
  const bundle=(await f.peer.take(m=>m.type==='SESSION_SNAPSHOT'&&m.payload.proposals.length===0)).payload;
  assert.equal(bundle.proposals.length,0);
  assert.throws(()=>f.app.workspace.restoreSnapshot(source.snapshotId,['main.py'],{actor:'STUDENT',clientId:f.clientId,sessionId:f.sessionId,controlEpoch:f.app.session.state.controlEpoch}),{code:'WRITE_GATE_REQUIRED',status:403});
  const conflicting=await f.respond(p,false);assert.equal(conflicting.payload.error.code,'IDEMPOTENCY_CONFLICT');
  f.peer.assertProtocol();
});

test('G3 No closes proposal in authoritative snapshot, leaves disk/timer running and consumes the decision',async t=>{
  const f=await fixture(t);const s=f.app.workspace.createSnapshot('Source',['main.py']);await f.write('KEEP');
  await f.http('POST','/api/session/start',{...f.command(),limitMs:null,pauseOnHidden:true});await delay(25);
  const before=f.app.session.getSession().timer.elapsedMs,p=await f.proposal(s.snapshotId);
  assert.equal((await f.respond(p,false)).payload.status,'OK');
  await f.peer.take(m=>m.type==='SESSION_SNAPSHOT'&&m.payload.proposals.length===0);
  assert.equal((await f.respond(p,false)).payload.status,'DUPLICATE');
  assert.equal(fs.readFileSync(path.join(f.rootPath,'main.py'),'utf8'),'KEEP');
  assert.equal(f.app.workspace.listSnapshots().length,1);assert(f.app.session.getSession().timer.elapsedMs>=before);
});

test('G3 stale proposal and 60s expiry boundary (clock advanced) reject before backup/effect',async t=>{
  const f=await fixture(t);const s=f.app.workspace.createSnapshot('Source',['main.py']);
  let p=await f.proposal(s.snapshotId);await f.write('NEWER');
  assert.equal((await f.respond(p)).payload.error.code,'STALE_PROPOSAL');
  p=await f.proposal(s.snapshotId);
  const now=Date.now;const start=now();t.mock.method(Date,'now',()=>start+61000);
  assert.equal((await f.respond(p)).payload.error.code,'STALE_PROPOSAL');t.mock.restoreAll();
  assert.equal(fs.readFileSync(path.join(f.rootPath,'main.py'),'utf8'),'NEWER');assert.equal(f.app.workspace.listSnapshots().length,1);
});

test('G3 actual backup storage failure maps STALE_PROPOSAL without task-file effect',async t=>{
  const f=await fixture(t);const s=f.app.workspace.createSnapshot('Source',['main.py']);await f.write('PRESERVE');
  const p=await f.proposal(s.snapshotId),base=path.join(f.app.workspace.dataDir,'snapshots-v1'),held=base+'-held';let sabotaged=false;
  f.app.workspace.on('snapshotCheckpoint',e=>{if(e.phase==='SNAPSHOT_FILE_CAPTURED'&&!sabotaged){sabotaged=true;fs.renameSync(base,held);fs.writeFileSync(base,'blocked');}});
  const ack=await f.respond(p);assert(sabotaged);assert.equal(ack.payload.status,'REJECTED');assert.equal(ack.payload.error.code,'STALE_PROPOSAL');
  assert.equal(fs.readFileSync(path.join(f.rootPath,'main.py'),'utf8'),'PRESERVE');assert.equal(fs.existsSync(path.join(f.rootPath,'.paircoach/snapshot-journal-v1')),false);
  fs.unlinkSync(base);fs.renameSync(held,base);
});

test('G3 ambiguous failure after journal effect remains RECOVERY_REQUIRED, not stale',async t=>{
  const f=await fixture(t);const s=f.app.workspace.createSnapshot('Source',['main.py']);await f.write('RECOVERABLE');const p=await f.proposal(s.snapshotId);
  f.app.workspace.on('snapshotCheckpoint',e=>{if(e.phase==='BEFORE_PUBLICATION')fs.writeFileSync(path.join(f.rootPath,'main.py'),'FOREIGN',{flag:'wx'});});
  const ack=await f.respond(p);assert.equal(ack.payload.error.code,'RECOVERY_REQUIRED');assert.equal(fs.readFileSync(path.join(f.rootPath,'main.py'),'utf8'),'FOREIGN');
  assert(fs.existsSync(path.join(f.rootPath,'.paircoach/snapshot-journal-v1')));
});

test('G3 missing profile and fresh zero-test/green JUnit are honest; green never auto-finishes',async t=>{
  // Real neutral Runner and parser, controlled Docker artifacts; not native execution proof.
  const f=await httpRunFixture(t,{settings:{runProfiles:[]}}),app=f.app(),port=await app.listen();
  const http=(method:string,url:string,body?:unknown)=>f.http(port,method,url,body);
  let project=(await http('GET','/api/project?readiness=actual')).body;
  const peer=await f.connect(port,project.sessionId);
  assert.equal(project.capabilities.execution.modes.RUN_MAIN.canRun,false);
  assert.equal(project.capabilities.execution.modes.RUN_TESTS.canRun,false);
  const missing=f.runRequest(project),rejected=await http('POST','/api/run',missing);
  assert.equal(rejected.status,503);assert.equal(rejected.body.code,'MUTATION_OUTCOME_UNKNOWN');
  assert.equal(f.fake.calls.filter(a=>a[0]==='create').length,0,'Missing task cannot dispatch a container');
  const settled=await http('POST','/api/runtime/mutation/reconcile',{mutation:{projectId:project.projectId,kind:'RUN',request:missing}});
  assert.equal(settled.status,200);assert.equal(settled.body.state,'DEFINITIVELY_ABORTED');
  const command=()=>({requestId:id(),clientId:'tab',sessionId:project.sessionId});
  for(const count of [0,1]) {
    const update=await http('PUT','/api/project/settings',{...command(),expectedWorkspaceVersion:app.workspace.workspaceVersion,
      settings:{...f.settings,runProfiles:[{kind:'RUN_TESTS',timeoutMs:3000,task:{workingDirectory:'.',entry:{kind:'TESTS'},tests:{paths:['test.js'],names:[]}}}]}});
    assert.equal(update.status,200,JSON.stringify(update));
    project=(await http('GET','/api/project?readiness=actual')).body;
    assert.equal(project.capabilities.execution.modes.RUN_TESTS.canRun,true);
    f.fake.logs={stdout:`RUN_RESULT_${count}`,stderr:''};
    const start=await http('POST','/api/run',f.runRequest(project));assert.equal(start.status,202,JSON.stringify(start));
    const record=JSON.parse(fs.readFileSync(path.join(f.state,'journal',start.body.runId+'.json'),'utf8'));
    fs.writeFileSync(path.join(record.plan.input.artifactsDirectory,'result.xml'),`<testsuite tests="${count}" failures="0" errors="0" skipped="0">${count?'<testcase name="actual"/>':''}</testsuite>`);
    f.fake.finish(0);
    const end=await until(async()=>(await http('GET',`/api/run/${start.body.runId}`)).body,r=>r.finishedAt!==null);
    assert.equal(end.testOutcome,count?'PASSED':'NO_TESTS');assert.equal(end.testCount,count);assert.equal(end.status,count?'SUCCEEDED':'FAILED');assert.equal(end.exitCode,0);
    assert.equal(app.session.state.lifecycle,'READY');
    await until(()=>peer.frames.some(m=>m.type==='RUN_OUTPUT'&&m.payload.chunk.includes(`RUN_RESULT_${count}`)),Boolean);
  }
  assert.equal((await http('POST','/api/snapshots',command())).status,404,'no test-only create API');
});

const treeScript=`const fs=require('fs'),{spawn}=require('child_process');const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});fs.writeFileSync('pids.json',JSON.stringify([process.pid,child.pid]));console.log('TREE_READY');setInterval(()=>{},1000);`;
for(const mode of ['stop','timeout','finish'] as const) test(`G3 real parent/child ${mode}: REST responsive, tree ends, frozen finish ordering`,{timeout:120000},async t=>{
  const f=await liveNodeFixture(t,{'tree.cjs':treeScript},[scriptProfile('tree.cjs',mode==='timeout'?1000:5000)]);
  const run=await f.run();
  await f.peer.take(m=>m.type==='RUN_OUTPUT'&&m.payload.chunk.includes('TREE_READY'));
  const physical=await f.processes(run.runId);
  assert.equal((await f.http('GET','/api/session')).status,200);
  assert.equal(fs.existsSync(path.join(f.rootPath,'pids.json')),false,'Program writes stay in its container, never the pupil workspace');
  if(mode==='stop')assert.equal((await f.http('POST',`/api/run/${run.runId}/stop`,f.command())).status,202);
  if(mode==='finish') {
    const response=await f.http('POST','/api/session/finish',{...f.command(),reason:'COMPLETED',expectedWorkspaceVersion:f.app.workspace.workspaceVersion});
    assert.equal(response.status,202);assert.equal(response.body.status,'PENDING');
    const frozen=factsOnDisk(f.app);assert.equal(frozen.session.lifecycle,'FINISHED');assert.equal(frozen.runs[0].status,'CANCELLED');
    assert.equal(f.app.session.state.lifecycle,'FINISHED');assert.equal(frozen.snapshot.snapshotId,response.body.snapshotId);
  }
  const end=await until(async()=>(await f.http('GET',`/api/run/${run.runId}`)).body,r=>r.finishedAt!==null);
  assert.equal(end.status,mode==='timeout'?'TIMED_OUT':'CANCELLED');
  await f.absent(run.runId);
  t.diagnostic(JSON.stringify({scope:'PHYSICAL_DOCKER_NOT_HOST_FALLBACK',mode,runId:run.runId,...physical,status:end.status,containerAbsent:true}));
});

test('G3 frozen report facts/consent/AI attribution and allowlisted AI projection survive later live edits + FAILED/retry',async t=>{
  const received:ReportAIFacts[]=[];let fail=true;let release!:(v:string)=>void;
  const f=await fixture(t,{reportGenerate:async(facts,signal)=>{received.push(facts);assert.equal(signal.aborted,false);if(fail)throw new Error('synthetic failure');return new Promise(r=>{release=r;});}},
    {'hidden.txt':'EXCLUDED_CONTEXT','key.pem':'EXCLUDED_KEY','.env.fixture':'EXCLUDED_ENV'});
  await f.http('PUT','/api/project/settings',{...f.command(),expectedWorkspaceVersion:f.app.workspace.workspaceVersion,settings:{...settings,schemaVersion:2,aiConsent:true,contextPatterns:['**/*.py','**/*.pem','**/.env*']}});
  await f.write('FROZEN '+f.token+'\n');
  await f.peer.ack(f.peer.send('CHAT_MESSAGE',{text:'token '+f.token,path:null,documentVersion:null,selection:null}));
  // Real executed cutoff, including retransmission, not an invented fact.
  const vetoId=id(),payload={controlEpoch:f.app.session.state.controlEpoch,activeInterventionId:null,lastAppliedSeq:0};
  await f.peer.ack(f.peer.send('VETO_ESCAPE',payload,vetoId));await f.peer.ack(f.peer.send('VETO_ESCAPE',payload,vetoId));
  const finish=await f.finish();assert.equal(finish.status,202);assert.equal(finish.body.status,'PENDING');
  await until(async()=>(await f.http('GET',`/api/session/report?sessionId=${f.sessionId}`)).body,r=>r.status==='FAILED');
  const frozen=factsOnDisk(f.app);assert.equal(frozen.aiConsent,true);assert.equal((frozen.events as any[]).filter(e=>e.type==='VETO_EXECUTED').length,1);
  const original=JSON.stringify(frozen);
  await f.write('LATER LIVE EDIT\n');
  assert.equal(JSON.stringify(factsOnDisk(f.app)),original);
  fail=false;const retry=await f.http('POST','/api/session/report/retry',f.command());assert.equal(retry.status,202);assert.equal(retry.body.status,'PENDING');
  await until(()=>!!release,Boolean);release('# Fakty i granice\nPomoc AI jest oznaczona.');
  const ready=await until(async()=>(await f.http('GET',`/api/session/report?sessionId=${f.sessionId}`)).body,r=>r.status==='READY');
  assert.equal(ready.snapshotId,finish.body.snapshotId);assert.equal(ready.sourceWorkspaceVersion,finish.body.sourceWorkspaceVersion);
  assert.equal(received.length,2);assert.deepEqual(received[0],received[1]);const wire=JSON.stringify(received);
  for(const forbidden of ['rawBase64',f.token,'EXCLUDED_CONTEXT','EXCLUDED_KEY','EXCLUDED_ENV','LATER LIVE EDIT'])assert(!wire.includes(forbidden),forbidden);
  assert(wire.includes('FROZEN [REDACTED]'));assert.equal(received[0].systemPrompt,REPORT_SYSTEM_PROMPT);
});

test('G3 consent OFF never calls injected report AI; local facts retain real coach-step attribution',async t=>{
  let calls=0;
  const f=await fixture(t,{enableCoach:true,coachProvider:{name:'INJECTED',mode:'INJECTED',async decide(c){return c.messages.length?{
    kind:'EDIT',purpose:'Attribution fixture',path:'main.py',documentVersion:c.documents.find(d=>d.path==='main.py')!.version,workspaceVersion:c.workspaceVersion,
    steps:[{range:{startLine:1,startColumn:1,endLine:1,endColumn:1},textBlock:'# AI fragment\n'}]}:{kind:'SILENT',reason:'not yet'};}},reportGenerate:async()=>{calls++;return 'SHOULD NOT RUN';}});
  await f.http('PUT','/api/project/settings',{...f.command(),expectedWorkspaceVersion:f.app.workspace.workspaceVersion,settings:{...settings,schemaVersion:2,aiConsent:true}});
  await f.http('POST','/api/session/start',{...f.command(),limitMs:null,pauseOnHidden:true});
  await f.peer.ack(f.peer.send('CHAT_MESSAGE',{text:'Demonstrate',path:null,documentVersion:null,selection:null}));
  const prep=(await f.peer.take(m=>m.type==='CONTROL_PREPARE')).payload;
  await f.peer.ack(f.peer.send('CONTROL_READY',{requestId:prep.requestId,workspaceVersion:prep.basedOnWorkspaceVersion,ready:true}));
  const step=(await f.peer.take(m=>m.type==='COACH_STEP_EDIT')).payload;
  await f.peer.ack(f.peer.send('STEP_RENDERED',{stepId:step.stepId,interventionId:step.interventionId,documentVersion:step.version}));
  await f.http('PUT','/api/project/settings',{...f.command(),expectedWorkspaceVersion:f.app.workspace.workspaceVersion,settings:{...settings,schemaVersion:2,aiConsent:false}});
  assert.equal((await f.finish()).status,202);
  const r=await until(async()=>(await f.http('GET',`/api/session/report?sessionId=${f.sessionId}`)).body,r=>r.status==='READY');
  assert.equal(calls,0);assert(r.markdown.includes('kroki AI: 1'));assert(r.markdown.includes('main.py'));assert(r.markdown.includes('Nie przypisujemy ich uczniowi'));
  const frozen=factsOnDisk(f.app);assert.equal(frozen.aiConsent,false);assert((frozen.events as any[]).some(e=>e.type==='COACH_STEP_EDIT'&&e.payload.textBlock==='# AI fragment\n'));
});

test('G3 snapshot persistence failure cannot finish the session or mutate task files',async t=>{
  const f=await fixture(t);await f.http('POST','/api/session/start',{...f.command(),limitMs:null,pauseOnHidden:true});
  // Actual storage path obstruction (not a Report/Runner mock).
  f.app.workspace.createSnapshot('Storage fixture');
  const base=path.join(f.app.workspace.dataDir,'snapshots-v1');fs.renameSync(base,base+'-held');fs.writeFileSync(base,'blocked');
  const result=await f.finish();assert.notEqual(result.status,202);assert.equal(f.app.session.state.lifecycle,'RUNNING');
  assert.equal(fs.readFileSync(path.join(f.rootPath,'main.py'),'utf8'),'ORIGINAL\r\n');
  fs.unlinkSync(base);fs.renameSync(base+'-held',base);
  await f.write('Still editable');
});

test('G3 pending-root gate refusal cleans startup/open resources and retains the original live session',async t=>{
  const f=await fixture(t),blocked=path.join(f.base,'blocked');fs.mkdirSync(blocked);fs.writeFileSync(path.join(blocked,'main.py'),'PRESERVE');
  const journal=path.join(blocked,'.paircoach','snapshot-journal-v1');fs.mkdirSync(journal,{recursive:true});fs.writeFileSync(path.join(journal,'unknown-material'),'PRESERVE JOURNAL');
  let workspaceCloses=0,sessionCloses=0,settingsCalls=0;
  const wc=WorkspaceService.prototype.close,sc=SessionController.prototype.close,us=WorkspaceService.prototype.updateSettings;
  t.mock.method(WorkspaceService.prototype,'close',function(this:WorkspaceService){workspaceCloses++;return wc.call(this);});
  t.mock.method(SessionController.prototype,'close',function(this:SessionController){sessionCloses++;return sc.call(this);});
  t.mock.method(WorkspaceService.prototype,'updateSettings',function(this:WorkspaceService,s:Parameters<typeof us>[0]){settingsCalls++;return us.call(this,s);});
  const refused=createPairCoachServer({rootPath:blocked,port:0,enableExecution:false});
  await assert.rejects(refused.listen(),{code:'RECOVERY_REQUIRED'});await refused.close();
  assert.equal(workspaceCloses,0);assert.equal(sessionCloses,0);
  const blockedOpen=path.join(f.base,'blocked-open'),openJournal=path.join(blockedOpen,'.paircoach','snapshot-journal-v1');
  fs.mkdirSync(openJournal,{recursive:true});fs.writeFileSync(path.join(openJournal,'unknown-material'),'PRESERVE JOURNAL');
  const response=await f.http('POST','/api/project/open',{requestId:id(),clientId:f.clientId,rootPath:blockedOpen,settings:{...settings,schemaVersion:2}});
  assert.equal(response.body.code,'RECOVERY_REQUIRED');assert.equal(workspaceCloses,0);assert.equal(sessionCloses,0);assert.equal(settingsCalls,0,'settings not touched before gate recovery');
  const again=createPairCoachServer({rootPath:blocked,port:0,enableExecution:false});
  await assert.rejects(again.listen(),{message:'Missing prior workspace versions; retain state and recover'});await again.close();
  assert.equal(f.app.session.state.sessionId,f.sessionId);assert.equal(f.app.workspace.rootPath,f.rootPath);await f.write('Original session remains live');
  assert.equal(fs.readFileSync(path.join(journal,'unknown-material'),'utf8'),'PRESERVE JOURNAL');
  assert.equal(fs.readFileSync(path.join(openJournal,'unknown-material'),'utf8'),'PRESERVE JOURNAL');
});


test('G3 report facts storage failure also leaves lifecycle uncommitted and task bytes intact',async t=>{
  const f=await fixture(t);await f.http('POST','/api/session/start',{...f.command(),limitMs:null,pauseOnHidden:true});
  const base=path.join(f.app.workspace.dataDir,'reports');fs.renameSync(base,base+'-held');fs.writeFileSync(base,'blocked');
  const response=await f.finish();assert.notEqual(response.status,202);assert.equal(f.app.session.state.lifecycle,'RUNNING');
  assert.equal(fs.readFileSync(path.join(f.rootPath,'main.py'),'utf8'),'ORIGINAL\r\n');
  assert.equal(f.app.workspace.listSnapshots().length,1,'durable final snapshot is retained although report persistence failed');
  fs.unlinkSync(base);fs.renameSync(base+'-held',base);
});

test('G3 concurrent FINISH_EXERCISE acceptance deduplicates even while real Stop is pending',async t=>{
  let sendProposal=false;
  const f=await liveNodeFixture(t,{'tree.cjs':treeScript},[scriptProfile('tree.cjs',10000)],{enableCoach:true,coachProvider:{name:'INJECTED',mode:'INJECTED',async decide(){return sendProposal?{
    kind:'PROPOSE',proposalKind:'FINISH_EXERCISE',questionText:'Zakończyć?',snapshotId:null,paths:[],resetTimer:false
  }:{kind:'SILENT',reason:'wait'};}}},{aiConsent:true});
  await f.http('POST','/api/session/start',{...f.command(),limitMs:null,pauseOnHidden:true});
  const run=await f.run();
  await f.peer.take(m=>m.type==='RUN_OUTPUT'&&m.payload.chunk.includes('TREE_READY'));
  await f.processes(run.runId);
  const respond=(p:any)=>f.peer.ack(f.peer.send('PROPOSAL_RESPONSE',{proposalId:p.proposalId,accepted:true,basedOnWorkspaceVersion:p.basedOnWorkspaceVersion}));
  sendProposal=true;await f.peer.ack(f.peer.send('CHAT_MESSAGE',{text:'Finish?',path:null,documentVersion:null,selection:null}));
  const p=(await f.peer.take(m=>m.type==='ACTION_PROPOSAL')).payload;
  const [a,b]=await Promise.all([respond(p),respond(p)]);
  assert.deepEqual([a.payload.status,b.payload.status].sort(),['DUPLICATE','OK']);
  assert.equal(f.app.session.state.lifecycle,'FINISHED');assert.equal(f.app.workspace.listSnapshots().length,1);
  await f.absent(run.runId);
});
