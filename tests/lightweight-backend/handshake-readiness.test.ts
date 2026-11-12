/** Actual loopback HTTP+WS/native workspace/WriteGate/ledger. Only read-only runtime
 * readiness is deliberately held/injected. No fake process/Run success or Docker proof. */
import test, {type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {once} from 'node:events';
import {randomUUID} from 'node:crypto';
import WebSocket from 'ws';
import catalog from '../../runtimes/catalog.json';
import {createPairCoachServer} from '../../src/server/http';
import {validateV2WireShape} from '../../src/shared/validation-v2';

const sleep=(ms:number)=>new Promise<void>(resolve=>setTimeout(resolve,ms));
function latch(){let release!:()=>void;const promise=new Promise<void>(r=>release=r);return {promise,release};}
async function fixture(t:TestContext,unavailable=false,aiConsent=false,realCoach=false){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'handshake-readiness-')),workspace=path.join(root,'workspace');
  fs.mkdirSync(workspace);fs.mkdirSync(path.join(workspace,'.paircoach'));fs.writeFileSync(path.join(workspace,'source.java'),'class Original {}\n');
  const settings={schemaVersion:2,taskFilePath:'source.java',taskMode:'IMPLEMENTATION',reviewNotesPath:'review.md',aiConsent,contextPatterns:[],runProfiles:[{kind:'RUN_MAIN',timeoutMs:1000,task:{workingDirectory:'.',entry:{kind:'JAVA_MAIN',className:'Original'},tests:{paths:[],names:[]}}}]};
  const settingsPath=path.join(workspace,'.paircoach/settings.json');fs.writeFileSync(settingsPath,JSON.stringify(settings));
  const profile=catalog.profiles.find(p=>p.id==='java-maven-21')!;
  const write=(name:string,value:unknown)=>fs.writeFileSync(path.join(root,name),JSON.stringify(value));
  write('catalog.json',{schemaVersion:1,profiles:[profile]});write('images.json',{schemaVersion:1,images:[{key:profile.imageLockKey,image:'paircoach/runtime-java:unit',imageId:'sha256:'+'a'.repeat(64),digest:'sha256:'+'b'.repeat(64),tools:profile.expectedTools}]});
  write('runtime.json',{schemaVersion:1,activeProfile:profile.id,workspaceRoot:workspace,runtimeCatalog:'catalog.json',imageLock:'images.json',languageFeatures:{completion:true,diagnostics:false},execution:{backend:'docker',pullPolicy:'never'}});
  const holds:ReturnType<typeof latch>[]=[],sockets:WebSocket[]=[];let transportCalls=0,probeCalls=0,configurationGeneration='';let controlEmit!:(type:string,payload:unknown)=>void;
  const app=createPairCoachServer({rootPath:workspace,port:0,token:'local-readiness-token',enableExecution:true,enableCoach:true,...(realCoach?{}:{coachFactory:context=>{controlEmit=context.emit;return {trigger(){},controlReady(){},stepRendered(){},abort(){},close(){}};}}),runtimeEnvironment:{},runtimeArguments:['--runtime-config',path.join(root,'runtime.json')],
    runtimeTransport:{async run(){transportCalls++;throw Error('No executor Docker side effect is allowed in this test');}},
    // Test-only longer bound permits a deliberate hold beyond the UNCHANGED 3000ms HELLO deadline.
    runtimeReadiness:{timeoutMs:10000,execution:{async readiness(_profile,generation){const held=latch();holds.push(held);await held.promise;
      const mode=unavailable?{canRun:false,problem:{code:'DAEMON_UNAVAILABLE',message:'Deliberately unavailable test daemon',recovery:'Repair Docker',retryable:true}}:{canRun:true,problem:null};
      return {configurationGeneration:generation,modes:{RUN_MAIN:mode,RUN_TESTS:mode}};}},probe:{async probe(){probeCalls++;return {canRun:true,problem:null};}}}});
  t.after(async()=>{for(const h of holds)h.release();for(const ws of sockets)ws.terminate();await app.close();fs.rmSync(root,{recursive:true,force:true});});
  const port=await app.listen(),sessionId=app.session.state.sessionId;
  const http=async(method:string,url:string,body?:unknown,token='local-readiness-token')=>{
    const response=await fetch(`http://127.0.0.1:${port}${url}`,{method,headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
    return {status:response.status,body:await response.json() as any};
  };
  const peer=async(clientId='tab')=>{
    const ws=new WebSocket(`ws://127.0.0.1:${port}/ws/session`);sockets.push(ws);const frames:any[]=[];
    ws.on('message',b=>{const m=JSON.parse(b.toString());frames.push(m);if(m.type==='SESSION_SNAPSHOT')configurationGeneration=m.payload.project.capabilities.execution.runtime.configurationGeneration;});await once(ws,'open');
    const send=(type:string,payload:unknown,messageId=randomUUID(),session=sessionId)=>{ws.send(JSON.stringify({protocolVersion:'3.0',messageId,sessionId:session,clientId,type,payload}));return messageId;};
    const wait=async(match:(m:any)=>boolean)=>{const end=Date.now()+2500;while(!frames.some(match)){assert.ok(Date.now()<end,'Frame missing: '+match+'; close='+ws.readyState);await sleep(5);}return frames.find(match);};
    return {ws,frames,send,wait,clientId};
  };
  const until=async(check:()=>boolean)=>{const end=Date.now()+2500;while(!check()){assert.ok(Date.now()<end,'Condition not reached');await sleep(5);}};
  const run=(clientId='tab',version=app.workspace.workspaceVersion)=>http('POST','/api/run',{requestId:randomUUID(),clientId,sessionId,mode:'RUN_MAIN',expectedWorkspaceVersion:version,configurationGeneration});
  return {root,workspace,settingsPath,settings,app,http,peer,until,run,holds,sessionId,controlEmit:(type:string,payload:unknown)=>controlEmit(type,payload),get transportCalls(){return transportCalls;},get probeCalls(){return probeCalls;}};
}
function pending(project:any){assert.ok(validateV2WireShape('Project',project));const e=project.capabilities.execution;assert.equal(e.runtime.state,'PREPARE_REQUIRED');assert.equal(e.runtime.problem.code,'RUNTIME_READINESS_PENDING');assert.equal(e.modes.RUN_MAIN.canRun,false);assert.equal(e.modes.RUN_TESTS.canRun,false);}
const hello=(p:Awaited<ReturnType<Awaited<ReturnType<typeof fixture>>['peer']>>,token='local-readiness-token')=>p.send('HELLO',{token,lastServerSeq:0});

test('delayed actual HTTP+WS: bootstrap/snapshot and original ACK precede probe release beyond HELLO deadline; truthful READY reaches supported snapshot, Run still uses real admission',async t=>{
  const f=await fixture(t);
  assert.equal((await f.http('GET','/api/project',undefined,'wrong')).status,401);assert.equal(f.holds.length,0);
  const initial=await Promise.race([f.http('GET','/api/project'),sleep(2500).then(()=>{throw Error('HTTP bootstrap waited for expensive readiness');})]);
  assert.equal(initial.status,200);pending(initial.body);assert.equal(f.holds.length,0,'No runtime probe before an authenticated editor peer');
  const p=await f.peer();hello(p);const first=await p.wait(m=>m.type==='SESSION_SNAPSHOT');pending(first.payload.project);assert.ok(validateV2WireShape('ServerMessage',first));
  await f.until(()=>f.holds.length===1);await sleep(3100);
  assert.equal(p.ws.readyState,WebSocket.OPEN,'Actual server deadline must not revoke a genuinely validated HELLO');
  const payload={path:'source.java',baseVersion:1,content:'class Current {}\n',editKind:'TYPING',controlEpoch:0};
  const id=p.send('CODE_CHANGED',payload),ack=await p.wait(m=>m.type==='ACK'&&m.payload.replyTo===id);
  assert.equal(ack.payload.status,'OK');assert.equal(ack.payload.documentVersion,2);assert.equal(ack.payload.workspaceVersion,1);assert.equal(f.probeCalls,0);
  const beforeRun=await f.run();assert.ok(beforeRun.status>=400);assert.equal(f.transportCalls,0,'A pending editor projection cannot authorize execution');
  f.holds[0].release();await f.until(()=>f.holds.length===2); // actual source changed: discard stale measured result, re-read
  assert.equal(p.frames.some(m=>m.type==='SESSION_SNAPSHOT'&&m.payload.project.capabilities.execution.runtime.state==='READY'),false);
  f.holds[1].release();const ready=await p.wait(m=>m.type==='SESSION_SNAPSHOT'&&m.payload.project.capabilities.execution.modes.RUN_MAIN.canRun);
  assert.ok(validateV2WireShape('ServerMessage',ready));assert.equal(ready.payload.project.workspaceVersion,1);assert.equal(ready.payload.activeDocument.content,'class Current {}\n');assert.equal(ready.payload.project.capabilities.execution.runtime.state,'READY');
  p.send('CODE_CHANGED',payload,id);const duplicate=await p.wait(m=>m.type==='ACK'&&m.payload.replyTo===id&&m.seq>ack.seq);
  assert.equal(duplicate.messageId,ack.messageId);assert.deepEqual(duplicate.payload,{...ack.payload,status:'DUPLICATE'});
  const denied=await f.run();assert.ok(denied.status>=400);assert.equal(f.transportCalls,0,'Injected display readiness does not bypass actual prepared-runtime/ownership admission');
  assert.deepEqual(p.frames.map(m=>m.seq),p.frames.map((_,i)=>i+1));
});

test('held readiness: wrong token/lease/stale session rejected, real FIFO and Veto/epoch/ACK guards survive, unavailable result is truthful and effect-free',async t=>{
  const f=await fixture(t,true),bad=await f.peer('unauthorized'),badClosed=once(bad.ws,'close');hello(bad,'wrong');assert.equal((await badClosed)[0],1008);assert.equal(bad.frames.length,0);assert.equal(f.holds.length,0);
  let release!:()=>void;const held=f.app.workspace._withQueuedMutation(async()=>{await new Promise<void>(r=>release=r);});await f.until(()=>!!release);
  const p=await f.peer();hello(p);await sleep(50);assert.equal(p.frames.length,0,'HELLO still waits for SAME real source FIFO');release();await held;
  await p.wait(m=>m.type==='SESSION_SNAPSHOT');await f.until(()=>f.holds.length===1);
  const other=await f.peer('other'),conflict=once(other.ws,'close');hello(other);assert.equal((await conflict)[0],1008);assert.equal(other.frames.length,0);
  const stale=p.send('CODE_CHANGED',{path:'source.java',baseVersion:1,content:'FORBIDDEN',editKind:'TYPING',controlEpoch:0},undefined,'stale-session');
  assert.equal((await p.wait(m=>m.type==='ACK'&&m.payload.replyTo===stale)).payload.status,'REJECTED');
  const veto=p.send('VETO_ESCAPE',{controlEpoch:0,activeInterventionId:null,lastAppliedSeq:p.frames.at(-1).seq});await p.wait(m=>m.type==='ACK'&&m.payload.replyTo===veto);
  const write=p.send('CODE_CHANGED',{path:'source.java',baseVersion:1,content:'FORBIDDEN',editKind:'TYPING',controlEpoch:0});
  assert.equal((await p.wait(m=>m.type==='ACK'&&m.payload.replyTo===write)).payload.error.code,'STALE_EPOCH');
  f.holds[0].release();await f.until(()=>f.holds.length===2);f.holds[1].release();
  const measured=await p.wait(m=>m.type==='SESSION_SNAPSHOT'&&m.payload.project.capabilities.execution.runtime.state==='DAEMON_OFF');assert.equal(measured.payload.session.controlEpoch,f.app.session.state.controlEpoch);
  const noLease=await f.run('other');assert.equal(noLease.status,403);assert.equal(noLease.body.code,'LEASE_REQUIRED');assert.ok((await f.run()).status>=400);assert.equal(f.transportCalls,0);assert.equal(fs.readFileSync(path.join(f.workspace,'source.java'),'utf8'),'class Original {}\n');
});

test('reconnect revokes old deferred publication and retains ordinary original ACK identity',async t=>{
  const f=await fixture(t),old=await f.peer();hello(old);const first=await old.wait(m=>m.type==='SESSION_SNAPSHOT');await f.until(()=>f.holds.length===1);
  const payload={path:'source.java',baseVersion:1,content:'class Reconnected {}\n',editKind:'TYPING',controlEpoch:0};const id=old.send('CODE_CHANGED',payload),ack=await old.wait(m=>m.type==='ACK'&&m.payload.replyTo===id);
  const closed=once(old.ws,'close'),fresh=await f.peer();hello(fresh);await closed;const snapshot=await fresh.wait(m=>m.type==='SESSION_SNAPSHOT');await f.until(()=>f.holds.length===2);
  assert.notEqual(snapshot.payload.languageBootstrap.connectionGeneration,first.payload.languageBootstrap.connectionGeneration);pending(snapshot.payload.project);
  f.holds[0].release();await sleep(80);assert.equal(f.holds.length,2,'Revoked peer cannot retry');assert.equal(fresh.frames.filter(m=>m.type==='SESSION_SNAPSHOT').length,1,'Old read must never publish into replacement peer');
  f.holds[1].release();await fresh.wait(m=>m.type==='SESSION_SNAPSHOT'&&m.payload.project.capabilities.execution.modes.RUN_MAIN.canRun);
  fresh.send('CODE_CHANGED',payload,id);const replay=await fresh.wait(m=>m.type==='ACK'&&m.payload.replyTo===id);assert.equal(replay.messageId,ack.messageId);assert.deepEqual(replay.payload,{...ack.payload,status:'DUPLICATE'});assert.equal(f.app.workspace.workspaceVersion,1);
});

test('settings source hash changed during delayed probe cannot publish stale READY; current migration problem is retained',async t=>{
  const f=await fixture(t),p=await f.peer();hello(p);await p.wait(m=>m.type==='SESSION_SNAPSHOT');await f.until(()=>f.holds.length===1);
  const raw='{malformed PRIVATE source\n';fs.writeFileSync(f.settingsPath,raw);f.holds[0].release();
  const current=await p.wait(m=>m.type==='SESSION_SNAPSHOT'&&m.payload.project.capabilities.execution.runtime.state==='CONFIG_ERROR');
  assert.equal(current.payload.project.capabilities.execution.modes.RUN_MAIN.canRun,false);assert.equal(current.payload.project.capabilities.execution.runtime.problem.code,'LEGACY_RUN_PROFILE_REQUIRES_MIGRATION');
  assert.equal(p.frames.some(m=>m.type==='SESSION_SNAPSHOT'&&m.payload.project.capabilities.execution.modes.RUN_MAIN.canRun),false);assert.equal(fs.readFileSync(f.settingsPath,'utf8'),raw);assert.equal(f.transportCalls,0);
});

test('project replacement while delayed readiness is held drops old publication without blocking new HTTP bootstrap',async t=>{
  const f=await fixture(t),p=await f.peer();hello(p);const old=await p.wait(m=>m.type==='SESSION_SNAPSHOT');await f.until(()=>f.holds.length===1);
  const other=path.join(f.root,'other');fs.mkdirSync(other);fs.writeFileSync(path.join(other,'source.java'),'class Other {}\n');
  const opened=await f.http('POST','/api/project/open',{requestId:randomUUID(),clientId:'tab',rootPath:other,settings:f.settings});assert.equal(opened.status,201);assert.notEqual(opened.body.sessionId,old.payload.session.sessionId);
  f.holds[0].release();await sleep(100);assert.equal(p.frames.some(m=>m.type==='SESSION_SNAPSHOT'&&m.payload.project.capabilities.execution.modes.RUN_MAIN.canRun),false);assert.equal(f.app.workspace.rootPath,other);assert.equal(f.transportCalls,0);
});

test('actual production LiveBackend consumes deferred READY, preserves newer local draft/ordinary ACK and can submit Run through the original guarded HTTP path',async t=>{
  const {LiveBackend}=await import('../../src/services/LiveBackend');
  const f=await fixture(t),stored=new Map<string,string>();let runRequests=0;
  // Real Node WebSocket + fetch. No routes/frames/readiness projection injected into the client.
  const client=new LiveBackend({baseUrl:`http://127.0.0.1:${f.app.server.address() && (f.app.server.address() as import('node:net').AddressInfo).port}`,token:'local-readiness-token',clientId:'tab',
    fetch:async(input,init)=>{if(String(input).endsWith('/api/run'))runRequests++;return fetch(input,init);},
    storage:{getItem:k=>stored.get(k)??null,setItem:(k,v)=>{stored.set(k,v);},removeItem:k=>{stored.delete(k);}}});
  t.after(()=>client.close());await client.connect();await f.until(()=>!client.getState().isOffline);await f.until(()=>f.holds.length===1);
  assert.equal(client.getState().capabilities.canRunMain,false);assert.equal(client.getState().runtime?.execution?.runtime.problem?.code,'RUNTIME_READINESS_PENDING');
  await client.selectFile('source.java');client.saveFileContent('source.java','class Saved {}\n');
  await f.until(()=>client.getState().pendingPaths.length===0&&fs.readFileSync(path.join(f.workspace,'source.java'),'utf8')==='class Saved {}\n');
  f.holds[0].release();await f.until(()=>f.holds.length===2);
  // A later local edit must not be overwritten by the asynchronous measured snapshot.
  client.saveFileContent('source.java','class LatestDraft {}\n');f.holds[1].release();
  await f.until(()=>client.getState().capabilities.canRunMain);
  assert.equal(client.getState().runtime?.execution?.runtime.state,'READY');assert.equal(client.getState().fileConflict,null);
  assert.equal(client.getState().files.find(f=>f.path==='source.java')?.content,'class LatestDraft {}\n');
  await f.until(()=>client.getState().pendingPaths.length===0&&fs.readFileSync(path.join(f.workspace,'source.java'),'utf8')==='class LatestDraft {}\n');
  assert.equal(client.getState().isOffline,false);await client.run(false);assert.equal(runRequests,1,'READY must not leave Run permanently disabled or bypass original HTTP');assert.equal(f.transportCalls,0,'Actual unavailable runtime refuses; UI readiness is not execution authority');
});


test('lease revoked while an authenticated peer waits: old measured result cannot publish or grant mutation',async t=>{
  const f=await fixture(t),p=await f.peer();hello(p);await p.wait(m=>m.type==='SESSION_SNAPSHOT');await f.until(()=>f.holds.length===1);
  f.app.session.releaseLease('tab');f.holds[0].release();await sleep(100);
  assert.equal(p.frames.filter(m=>m.type==='SESSION_SNAPSHOT').length,1);assert.equal(f.holds.length,1,'Lease loss must stop the deferred read, not spin/retry');
  const id=p.send('CODE_CHANGED',{path:'source.java',baseVersion:1,content:'FORBIDDEN',editKind:'TYPING',controlEpoch:0});
  assert.equal((await p.wait(m=>m.type==='ACK'&&m.payload.replyTo===id)).payload.error.code,'LEASE_REQUIRED');
  assert.equal(fs.readFileSync(path.join(f.workspace,'source.java'),'utf8'),'class Original {}\n');assert.equal(f.transportCalls,0);
});


test('deferred full snapshot cannot reset actual client CONTROL_PREPARE; readiness resumes after existing CONTROL_STATE',async t=>{
  const {LiveBackend}=await import('../../src/services/LiveBackend'),f=await fixture(t,false,true);
  const client=new LiveBackend({baseUrl:`http://127.0.0.1:${(f.app.server.address() as import('node:net').AddressInfo).port}`,token:'local-readiness-token',clientId:'tab'});
  t.after(()=>client.close());await client.connect();await f.until(()=>!client.getState().isOffline);await f.until(()=>f.holds.length===1);
  f.app.session.start(null,true);f.app.session.setAiStatus('READY');
  f.controlEmit('CONTROL_PREPARE',{requestId:randomUUID(),purpose:'test actual client prepare lock',path:'source.java',basedOnWorkspaceVersion:0});
  await f.until(()=>client.getState().writeOwner==='SYNCING');f.holds[0].release();await f.until(()=>f.probeCalls===1);await sleep(80);
  assert.equal(client.getState().writeOwner,'SYNCING','A full runtime snapshot must not erase PREPARE');assert.equal(client.getState().capabilities.canRunMain,false);
  client.saveFileContent('source.java','FORBIDDEN DURING PREPARE');assert.equal(client.getState().pendingPaths.length,0);
  const interventionId=randomUUID();f.app.session.acquireCoach(interventionId);
  f.controlEmit('CONTROL_STATE',{writeOwner:'COACH',controlEpoch:f.app.session.state.controlEpoch,coachMode:f.app.session.state.coachMode,interventionId,cooldownAfterVeto:false});
  await f.until(()=>client.getState().writeOwner==='COACH');await sleep(80);
  assert.equal(f.holds.length,1,'COACH must not start a resnapshot');client.saveFileContent('source.java','FORBIDDEN DURING COACH');assert.equal(client.getState().pendingPaths.length,0);
  assert.equal(fs.readFileSync(path.join(f.workspace,'source.java'),'utf8'),'class Original {}\n');
  f.app.session.releaseCoach();f.controlEmit('CONTROL_STATE',{writeOwner:'STUDENT',controlEpoch:f.app.session.state.controlEpoch,coachMode:f.app.session.state.coachMode,interventionId:null,cooldownAfterVeto:false});
  await f.until(()=>f.holds.length===2);f.holds[1].release();await f.until(()=>client.getState().capabilities.canRunMain);
  assert.equal(client.getState().writeOwner,'STUDENT');assert.equal(client.getState().runtime?.execution?.runtime.state,'READY');assert.equal(f.transportCalls,0);
});


test('explicit authenticated HTTP actual-readiness opt-in is measured, malformed queries fail closed, and held actual read never blocks default HELLO/save',async t=>{
  const f=await fixture(t);
  assert.equal((await f.http('GET','/api/project?readiness=actual',undefined,'wrong')).status,401);
  for(const query of ['readiness=','readiness=READY','readiness=actual&readiness=actual','readiness=actual&extra=1','other=actual'])assert.equal((await f.http('GET','/api/project?'+query)).status,400,query);
  assert.equal(f.holds.length,0);pending((await f.http('GET','/api/project')).body);
  const measured=f.http('GET','/api/project?readiness=actual');await f.until(()=>f.holds.length===1);
  const p=await f.peer();hello(p);pending((await p.wait(m=>m.type==='SESSION_SNAPSHOT')).payload.project);await f.until(()=>f.holds.length===2);
  const id=p.send('CODE_CHANGED',{path:'source.java',baseVersion:1,content:'class Changed {}\n',editKind:'TYPING',controlEpoch:0});assert.equal((await p.wait(m=>m.type==='ACK'&&m.payload.replyTo===id)).payload.status,'OK');
  f.holds[0].release();const stale=await measured;assert.equal(stale.status,409);assert.equal(stale.body.code,'PROJECT_STATE_CHANGED');
  f.holds[1].release();await f.until(()=>f.holds.length===3);f.holds[2].release();await p.wait(m=>m.type==='SESSION_SNAPSHOT'&&m.payload.project.capabilities.execution.modes.RUN_MAIN.canRun);
  const actual=f.http('GET','/api/project?readiness=actual');await f.until(()=>f.holds.length===4);f.holds[3].release();const result=await actual;
  assert.equal(result.status,200);assert.ok(validateV2WireShape('Project',result.body));assert.equal(result.body.workspaceVersion,1);assert.equal(result.body.capabilities.execution.runtime.state,'READY');assert.equal(result.body.capabilities.execution.modes.RUN_MAIN.canRun,true);assert.equal(f.transportCalls,0);
});


test('explicit measured HTTP unavailability stays false with actual problem, never fabricated READY',async t=>{
  const f=await fixture(t,true),actual=f.http('GET','/api/project?readiness=actual');await f.until(()=>f.holds.length===1);
  f.holds[0].release();const result=await actual;assert.equal(result.status,200);assert.ok(validateV2WireShape('Project',result.body));
  assert.equal(result.body.capabilities.execution.runtime.state,'DAEMON_OFF');assert.equal(result.body.capabilities.execution.runtime.problem.code,'DAEMON_UNAVAILABLE');assert.equal(result.body.capabilities.execution.modes.RUN_MAIN.canRun,false);assert.equal(f.transportCalls,0);
});


test('ordinary save with actual CoachAdapter disabled by consent must not schedule another expensive probe from its routine CONTROL_STATE',async t=>{
  const f=await fixture(t,false,false,true),p=await f.peer();hello(p);await p.wait(m=>m.type==='SESSION_SNAPSHOT');await f.until(()=>f.holds.length===1);
  f.holds[0].release();await p.wait(m=>m.type==='SESSION_SNAPSHOT'&&m.payload.project.capabilities.execution.modes.RUN_MAIN.canRun);
  const id=p.send('CODE_CHANGED',{path:'source.java',baseVersion:1,content:'class Ordinary {}\n',editKind:'TYPING',controlEpoch:0});const ack=await p.wait(m=>m.type==='ACK'&&m.payload.replyTo===id);assert.equal(ack.payload.status,'OK');
  await p.wait(m=>m.type==='CONTROL_STATE'&&m.seq>ack.seq);await sleep(80);
  assert.equal(f.holds.length,1,'Routine coach control publication must not create a per-edit readiness probe');assert.equal(f.transportCalls,0);assert.equal(fs.readFileSync(path.join(f.workspace,'source.java'),'utf8'),'class Ordinary {}\n');
});


test('same socket renewed HELLO while measurement is held cannot lose the new generation readiness',async t=>{
  const f=await fixture(t),p=await f.peer();hello(p);const first=await p.wait(m=>m.type==='SESSION_SNAPSHOT');await f.until(()=>f.holds.length===1);
  hello(p);const renewed=await p.wait(m=>m.type==='SESSION_SNAPSHOT'&&m.seq>first.seq);assert.notEqual(renewed.payload.languageBootstrap.connectionGeneration,first.payload.languageBootstrap.connectionGeneration);
  f.holds[0].release();await f.until(()=>f.holds.length===2);assert.equal(p.frames.some(m=>m.type==='SESSION_SNAPSHOT'&&m.payload.project.capabilities.execution.modes.RUN_MAIN.canRun),false);
  f.holds[1].release();const ready=await p.wait(m=>m.type==='SESSION_SNAPSHOT'&&m.payload.project.capabilities.execution.modes.RUN_MAIN.canRun);assert.equal(ready.payload.languageBootstrap.connectionGeneration,renewed.payload.languageBootstrap.connectionGeneration);assert.equal(f.transportCalls,0);
});
