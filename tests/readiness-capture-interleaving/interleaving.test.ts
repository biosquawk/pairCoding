/** Real loopback HTTP/WS, workspace, FIFO, WriteGate and immutable inventory/copy.
 * Runtime display probes are controlled; no Docker, native or historical-trace claim.
 * All ordering uses explicit collaborator barriers and WS PING/ACK, never sleep/poll. */
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
import {copyAcknowledgedInput, readRunSourceInventory, verifyAcknowledgedInput} from '../../src/server/execution/ImmutableInput';

function latch<T=void>() {let resolve!:(value:T)=>void;const promise=new Promise<T>(r=>resolve=r);return {promise,resolve};}
function inbox<T>() {
  const values:T[]=[], waiters:{match:(v:T)=>boolean;resolve:(v:T)=>void}[]=[];
  return {values,push(value:T){values.push(value);for(const w of [...waiters])if(w.match(value)){waiters.splice(waiters.indexOf(w),1);w.resolve(value);}},
    wait(match:(v:T)=>boolean){const found=values.find(match);return found?Promise.resolve(found):new Promise<T>(resolve=>waiters.push({match,resolve}));}};
}
async function fixture(t:TestContext,secondFile=false) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'readiness-capture-')),workspace=path.join(root,'workspace');
  fs.mkdirSync(workspace);fs.mkdirSync(path.join(workspace,'.paircoach'));
  fs.writeFileSync(path.join(workspace,'source.java'),'class Original {}\n');
  if(secondFile)fs.writeFileSync(path.join(workspace,'z-other.java'),'class Other {}\n');
  const settings={schemaVersion:2,taskFilePath:'source.java',taskMode:'IMPLEMENTATION',reviewNotesPath:'review.md',aiConsent:false,contextPatterns:[],
    runProfiles:[{kind:'RUN_MAIN',timeoutMs:1000,task:{workingDirectory:'.',entry:{kind:'JAVA_MAIN',className:'Original'},tests:{paths:[],names:[]}}}]};
  const settingsPath=path.join(workspace,'.paircoach/settings.json');fs.writeFileSync(settingsPath,JSON.stringify(settings));
  const profile=catalog.profiles.find(p=>p.id==='java-maven-21')!;
  const write=(name:string,value:unknown)=>fs.writeFileSync(path.join(root,name),JSON.stringify(value));
  write('catalog.json',{schemaVersion:1,profiles:[profile]});
  write('images.json',{schemaVersion:1,images:[{key:profile.imageLockKey,image:'paircoach/runtime-java:unit',imageId:'sha256:'+'a'.repeat(64),digest:'sha256:'+'b'.repeat(64),tools:profile.expectedTools}]});
  write('runtime.json',{schemaVersion:1,activeProfile:profile.id,workspaceRoot:workspace,runtimeCatalog:'catalog.json',imageLock:'images.json',languageFeatures:{completion:true,diagnostics:false},execution:{backend:'docker',pullPolicy:'never'}});
  const measurements=inbox<{index:number;release:()=>void}>(),probeFinished=inbox<number>();let measureCount=0,transportCalls=0;
  const sockets:WebSocket[]=[],releases:(()=>void)[]=[];
  const app=createPairCoachServer({rootPath:workspace,port:0,token:'interleaving-token',enableExecution:true,enableCoach:false,
    runtimeEnvironment:{},runtimeArguments:['--runtime-config',path.join(root,'runtime.json')],
    runtimeTransport:{async run(){transportCalls++;throw Error('No Docker effect is permitted');}},
    runtimeReadiness:{timeoutMs:10000,execution:{async readiness(_profile,generation){const held=latch(),index=++measureCount;releases.push(()=>held.resolve());measurements.push({index,release:()=>held.resolve()});await held.promise;
      const mode={canRun:true,problem:null};return {configurationGeneration:generation,modes:{RUN_MAIN:mode,RUN_TESTS:mode}};}},
      probe:{async probe(){probeFinished.push(measureCount);return {canRun:true,problem:null};}}}});
  t.after(async()=>{for(const release of releases)release();for(const ws of sockets)ws.terminate();await app.close();
    const unlock=(p:string)=>{if(fs.lstatSync(p).isDirectory()){fs.chmodSync(p,0o700);for(const n of fs.readdirSync(p))unlock(path.join(p,n));}};unlock(root);fs.rmSync(root,{recursive:true,force:true});});
  const port=await app.listen(),sessionId=app.session.state.sessionId;
  const http=async(method:string,url:string,body?:unknown)=>{const response=await fetch(`http://127.0.0.1:${port}${url}`,{method,headers:{Authorization:'Bearer interleaving-token','Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});return {status:response.status,body:await response.json() as any};};
  const peer=async()=>{
    const ws=new WebSocket(`ws://127.0.0.1:${port}/ws/session`);sockets.push(ws);const frames=inbox<any>();ws.on('message',bytes=>frames.push(JSON.parse(bytes.toString())));await once(ws,'open');
    const send=(type:string,payload:unknown,messageId=randomUUID(),session=sessionId)=>{ws.send(JSON.stringify({protocolVersion:'3.0',messageId,sessionId:session,clientId:'tab',type,payload}));return messageId;};
    const ping=async()=>{const id=send('PING',{lastAppliedSeq:frames.values.at(-1)?.seq??0});await frames.wait(m=>m.type==='ACK'&&m.payload.replyTo===id);};
    return {ws,frames,send,ping};
  };
  const capture=async(generation:string)=>{
    const entered=latch(),held=latch();releases.push(()=>held.resolve());
    const result=app.gate.captureRun({actor:'STUDENT',clientId:'tab',sessionId,controlEpoch:app.session.state.controlEpoch,runId:randomUUID(),profileId:profile.id,
      configurationGeneration:generation,expectedWorkspaceVersion:app.workspace.workspaceVersion,runDirectory:path.join(root,randomUUID())},
      {inventory:readRunSourceInventory,copy:options=>copyAcknowledgedInput({...options,afterFileCopied:async file=>{if(file==='source.java'){entered.resolve();await held.promise;}}})});
    // Observe failures instead of leaving an unhandled capture promise on a fixture error.
    void result.catch(()=>{});await Promise.race([entered.promise,result.then(()=>{throw Error('Capture did not reach source barrier');})]);
    return {result,release:()=>held.resolve()};
  };
  return {root,workspace,settingsPath,settings,app,http,peer,capture,measurements,probeFinished,sessionId,get transportCalls(){return transportCalls;}};
}

test('deferred readiness crossing a real admitted immutable copy must not broadcast uncorrelated WORKSPACE_BUSY; capture, later edit and original ACK remain intact', {timeout:15000}, async t=>{
  const f=await fixture(t),p=await f.peer();p.send('HELLO',{token:'interleaving-token',lastServerSeq:0});
  const first=await p.frames.wait(m=>m.type==='SESSION_SNAPSHOT'),measurement=await f.measurements.wait(m=>m.index===1);
  const generation=first.payload.project.capabilities.execution.runtime.configurationGeneration;
  const copy=await f.capture(generation);
  assert.throws(()=>f.app.workspace.listFiles(),{code:'WORKSPACE_BUSY'},'Actual immutable capture owns the root; no weakened read guard');
  measurement.release();await f.probeFinished.wait(i=>i===1);await p.ping();
  const errors=p.frames.values.filter(m=>m.type==='ERROR');
  console.log('controlled refresh/capture errors:',JSON.stringify(errors.map(m=>m.payload)));
  try {
    assert.deepEqual(errors,[],'Readiness must not turn an ordinary capture exclusion into a session-wide ERROR');
  } finally {copy.release();await copy.result;}
  const input=await copy.result;await verifyAcknowledgedInput(input);
  assert.equal(fs.readFileSync(path.join(input.immutableDirectory,'source.java'),'utf8'),'class Original {}\n');
  const ready=await p.frames.wait(m=>m.type==='SESSION_SNAPSHOT'&&m.payload.project.capabilities.execution.modes.RUN_MAIN.canRun);
  assert.equal(ready.payload.activeDocument.content,'class Original {}\n');assert.equal(ready.payload.project.workspaceVersion,0);
  const id=p.send('CODE_CHANGED',{path:'source.java',baseVersion:1,content:'class Later {}\n',editKind:'TYPING',controlEpoch:0});
  const ack=await p.frames.wait(m=>m.type==='ACK'&&m.payload.replyTo===id);assert.equal(ack.payload.status,'OK');assert.equal(ack.payload.documentVersion,2);
  assert.equal(fs.readFileSync(path.join(input.immutableDirectory,'source.java'),'utf8'),'class Original {}\n');
  const payload={path:'source.java',baseVersion:1,content:'class Later {}\n',editKind:'TYPING',controlEpoch:0};p.send('CODE_CHANGED',payload,id);
  const replay=await p.frames.wait(m=>m.type==='ACK'&&m.payload.replyTo===id&&m.seq>ack.seq);assert.equal(replay.messageId,ack.messageId);assert.equal(replay.payload.status,'DUPLICATE');
  assert.equal(f.transportCalls,0);assert.equal(p.frames.values.some(m=>m.type==='ERROR'),false);
});

const hello=(p:Awaited<ReturnType<Awaited<ReturnType<typeof fixture>>['peer']>>)=>p.send('HELLO',{token:'interleaving-token',lastServerSeq:0});
const ready=(m:any)=>m.type==='SESSION_SNAPSHOT'&&m.payload.project.capabilities.execution.modes.RUN_MAIN.canRun;

test('source/sequence fence rejects old measured READY after real edit and preserves original ACK', {timeout:10000},async t=>{
  const f=await fixture(t),p=await f.peer();hello(p);await p.frames.wait(m=>m.type==='SESSION_SNAPSHOT');
  const old=await f.measurements.wait(m=>m.index===1);
  const id=p.send('CODE_CHANGED',{path:'source.java',baseVersion:1,content:'class Current {}\n',editKind:'TYPING',controlEpoch:0});
  const ack=await p.frames.wait(m=>m.type==='ACK'&&m.payload.replyTo===id);assert.equal(ack.payload.status,'OK');
  old.release();const fresh=await f.measurements.wait(m=>m.index===2);await p.ping();assert.equal(p.frames.values.some(ready),false);
  fresh.release();const actual=await p.frames.wait(ready);assert.equal(actual.payload.project.workspaceVersion,1);assert.equal(actual.payload.activeDocument.content,'class Current {}\n');
  assert.equal(actual.payload.activeDocument.version,ack.payload.documentVersion);assert.equal(f.transportCalls,0);
});

test('changed settings source yields the genuine migration problem, not stale READY', {timeout:10000},async t=>{
  const f=await fixture(t),p=await f.peer();hello(p);await p.frames.wait(m=>m.type==='SESSION_SNAPSHOT');const old=await f.measurements.wait(m=>m.index===1);
  const raw='{private malformed settings\n';fs.writeFileSync(f.settingsPath,raw);old.release();
  const actual=await p.frames.wait(m=>m.type==='SESSION_SNAPSHOT'&&m.payload.project.capabilities.execution.runtime.state==='CONFIG_ERROR');
  assert.equal(actual.payload.project.capabilities.execution.runtime.problem.code,'LEGACY_RUN_PROFILE_REQUIRES_MIGRATION');assert.equal(p.frames.values.some(ready),false);
  assert.equal(fs.readFileSync(f.settingsPath,'utf8'),raw);assert.equal(f.transportCalls,0);
});

test('renewed same-socket handshake generation cannot receive old measurement', {timeout:10000},async t=>{
  const f=await fixture(t),p=await f.peer();hello(p);const first=await p.frames.wait(m=>m.type==='SESSION_SNAPSHOT');const old=await f.measurements.wait(m=>m.index===1);
  hello(p);const next=await p.frames.wait(m=>m.type==='SESSION_SNAPSHOT'&&m.seq>first.seq);assert.notEqual(next.payload.languageBootstrap.connectionGeneration,first.payload.languageBootstrap.connectionGeneration);
  old.release();const fresh=await f.measurements.wait(m=>m.index===2);await p.ping();assert.equal(p.frames.values.some(ready),false);
  fresh.release();const actual=await p.frames.wait(ready);assert.equal(actual.payload.languageBootstrap.connectionGeneration,next.payload.languageBootstrap.connectionGeneration);assert.equal(f.transportCalls,0);
});

test('actual lease loss drops delayed projection and still rejects a stale-session mutation', {timeout:10000},async t=>{
  const f=await fixture(t),p=await f.peer();hello(p);await p.frames.wait(m=>m.type==='SESSION_SNAPSHOT');const old=await f.measurements.wait(m=>m.index===1);
  f.app.session.releaseLease('tab');old.release();await f.probeFinished.wait(i=>i===1);
  const id=p.send('CODE_CHANGED',{path:'source.java',baseVersion:1,content:'FORBIDDEN',editKind:'TYPING',controlEpoch:0});
  const rejected=await p.frames.wait(m=>m.type==='ACK'&&m.payload.replyTo===id);assert.equal(rejected.payload.error.code,'LEASE_REQUIRED');
  assert.equal(p.frames.values.some(ready),false);assert.equal(f.measurements.values.length,1);assert.equal(fs.readFileSync(path.join(f.workspace,'source.java'),'utf8'),'class Original {}\n');assert.equal(f.transportCalls,0);
});

test('project/session replacement cannot publish old readiness into the new binding', {timeout:10000},async t=>{
  const f=await fixture(t),p=await f.peer();hello(p);const first=await p.frames.wait(m=>m.type==='SESSION_SNAPSHOT');const old=await f.measurements.wait(m=>m.index===1);
  const other=path.join(f.root,'other');fs.mkdirSync(other);fs.writeFileSync(path.join(other,'source.java'),'class Other {}\n');
  const opened=await f.http('POST','/api/project/open',{requestId:randomUUID(),clientId:'tab',rootPath:other,settings:f.settings});assert.equal(opened.status,201);assert.notEqual(opened.body.sessionId,first.payload.session.sessionId);
  old.release();await f.probeFinished.wait(i=>i===1);
  // HTTP completes on the new real session; the old peer has already been revoked by adoption.
  const project=await f.http('GET','/api/project');assert.equal(project.status,200);assert.equal(project.body.sessionId,opened.body.sessionId);
  assert.equal(p.frames.values.some(ready),false);assert.equal(f.app.workspace.rootPath,other);assert.equal(f.transportCalls,0);
});

test('genuine durable-version authority closure stays an ERROR, never hidden as transient capture', {timeout:10000},async t=>{
  const f=await fixture(t),p=await f.peer();hello(p);await p.frames.wait(m=>m.type==='SESSION_SNAPSHOT');const old=await f.measurements.wait(m=>m.index===1);
  f.app.workspace.close();old.release();
  const error=await p.frames.wait(m=>m.type==='ERROR');assert.equal(error.payload.code,'WORKSPACE_VERSIONS_UNAVAILABLE');assert.equal(p.frames.values.some(ready),false);assert.equal(f.transportCalls,0);
});


test('activeDocument belongs to the current view, not the pre-probe selected path', {timeout:10000},async t=>{
  const f=await fixture(t,true),p=await f.peer();hello(p);const first=await p.frames.wait(m=>m.type==='SESSION_SNAPSHOT');assert.equal(first.payload.activeDocument.path,'source.java');
  const old=await f.measurements.wait(m=>m.index===1);
  const id=p.send('VIEW_CHANGED',{path:'z-other.java',documentVersion:1,cursor:null,selection:null});const ack=await p.frames.wait(m=>m.type==='ACK'&&m.payload.replyTo===id);assert.equal(ack.payload.status,'OK');
  old.release();
  // Current implementation may materialize after measurement; fixed implementation
  // discards its earlier view via the existing sequence fence and remeasures once.
  const next=await Promise.race([p.frames.wait(ready).then(frame=>({frame,measurement:null})),f.measurements.wait(m=>m.index===2).then(measurement=>({frame:null,measurement}))]);
  if(next.measurement)next.measurement.release();const actual=next.frame??await p.frames.wait(ready);
  assert.equal(actual.payload.session.activeFilePath,'z-other.java');assert.equal(actual.payload.activeDocument.path,'z-other.java');assert.equal(actual.payload.activeDocument.content,'class Other {}\n');
  assert.equal(p.frames.values.filter(ready).every(m=>m.payload.activeDocument.path==='z-other.java'),true);assert.equal(f.transportCalls,0);
});

test('SAME FIFO: real capture terminal precedes guarded synchronous read, which precedes later write', {timeout:10000},async t=>{
  const f=await fixture(t),p=await f.peer();hello(p);const first=await p.frames.wait(m=>m.type==='SESSION_SNAPSHOT');await f.measurements.wait(m=>m.index===1);
  const copy=await f.capture(first.payload.project.capabilities.execution.runtime.configurationGeneration),order:string[]=[];
  const read=f.app.workspace._withQueuedRead(()=>{
    order.push('read');
    assert.throws(()=>f.app.gate.write({actor:'STUDENT',clientId:'tab',sessionId:f.sessionId,controlEpoch:0,path:'source.java',baseVersion:1,content:'REENTRANT'}),{code:'WORKSPACE_BUSY'});
    return {files:f.app.workspace.listFiles(),document:f.app.workspace.getDocument('source.java'),version:f.app.workspace.workspaceVersion};
  });
  const write=f.app.gate.writeAsync({actor:'STUDENT',clientId:'tab',sessionId:f.sessionId,controlEpoch:0,path:'source.java',baseVersion:1,content:'class Later {}\n'},()=>{},()=>{order.push('write');});
  await p.ping();assert.deepEqual(order,[],'Admitted read cannot enter a held capture or leapfrog its terminal');
  copy.release();await copy.result;const materialized=await read;await write;
  assert.deepEqual(order,['read','write']);assert.equal(materialized.version,0);assert.equal(materialized.document.content,'class Original {}\n');assert.equal(materialized.files.find(f=>f.path==='source.java')?.version,1);
  assert.equal(f.app.workspace.getDocument('source.java').content,'class Later {}\n');
});

test('read callback throw and thenable rejection release root/counting; subsequent FIFO and sync mutation remain available', {timeout:10000},async t=>{
  const f=await fixture(t),p=await f.peer();hello(p);await p.frames.wait(m=>m.type==='SESSION_SNAPSHOT');await f.measurements.wait(m=>m.index===1);
  const sentinel=new Error('read callback failed');
  const failed=f.app.workspace._withQueuedRead(()=>{throw sentinel;});
  const next=f.app.workspace._withQueuedRead(()=>f.app.workspace.getDocument('source.java'));
  await assert.rejects(failed,error=>error===sentinel);assert.equal((await next).version,1);
  await assert.rejects(f.app.workspace._withQueuedRead(()=>Promise.resolve('not sync')),/must be synchronous/);
  const saved=f.app.gate.write({actor:'STUDENT',clientId:'tab',sessionId:f.sessionId,controlEpoch:0,path:'source.java',baseVersion:1,content:'class Available {}\n'});
  assert.equal(saved.version,2);assert.equal(f.app.workspace.getDocument('source.java').content,'class Available {}\n');
});

test('queued read never converts a genuine closed durable authority into a snapshot', {timeout:10000},async t=>{
  const f=await fixture(t);f.app.workspace.close();
  let invoked=false;await assert.rejects(f.app.workspace._withQueuedRead(()=>{invoked=true;return f.app.workspace.listFiles();}),{code:'WORKSPACE_VERSIONS_UNAVAILABLE'});assert.equal(invoked,false);
});

test('malformed-settings zero-port await uses admitted source materialization and waits for a subsequently admitted real capture', {timeout:10000},async t=>{
  const f=await fixture(t);fs.writeFileSync(f.settingsPath,'{malformed settings\n');
  const initial=await f.http('GET','/api/project');assert.equal(initial.status,200);assert.equal(initial.body.capabilities.execution.runtime.state,'CONFIG_ERROR');
  const admitted=latch();let first=true,capture!:ReturnType<typeof f.capture>;
  const actual=f.app.workspace._withQueuedRead.bind(f.app.workspace);
  // Test seam only orders real collaborators; neither frames, guards nor failures are forged.
  t.mock.method(f.app.workspace,'_withQueuedRead',<T>(read:()=>T)=>actual(()=>{
    const value=read();
    if(first){first=false;capture=f.capture(initial.body.capabilities.execution.runtime.configurationGeneration);admitted.resolve();}
    return value;
  }));
  const p=await f.peer();hello(p);await admitted.promise;const copy=await capture;
  const blocked=await f.http('GET','/api/project');assert.equal(blocked.status,409);assert.equal(blocked.body.code,'WORKSPACE_BUSY');
  assert.equal(p.frames.values.some(m=>m.type==='SESSION_SNAPSHOT'||m.type==='ERROR'),false,'Final snapshot waits for real capture terminal, not a microtask ordering assumption');
  copy.release();await copy.result;
  const snapshot=await p.frames.wait(m=>m.type==='SESSION_SNAPSHOT');assert.equal(snapshot.payload.project.capabilities.execution.runtime.problem.code,'LEGACY_RUN_PROFILE_REQUIRES_MIGRATION');
  assert.equal(snapshot.payload.activeDocument.content,'class Original {}\n');assert.equal(f.measurements.values.length,0);assert.equal(f.transportCalls,0);assert.equal(p.frames.values.some(m=>m.type==='ERROR'),false);
});
