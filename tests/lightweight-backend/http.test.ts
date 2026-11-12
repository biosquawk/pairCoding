/** Real loopback HTTP/WS, actual core/native storage/WriteGate, deliberately unavailable
 * per-instance Docker executable. No simulated Run success, browser/host Docker acceptance. */
import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {once} from 'node:events';
import {randomUUID,createHash} from 'node:crypto';
import workers from 'node:worker_threads';
import {syncBuiltinESMExports} from 'node:module';
import WebSocket from 'ws';
import catalog from '../../runtimes/catalog.json';
import {createPairCoachServer} from '../../src/server/http';
import {validateV2WireShape} from '../../src/shared/validation-v2';

async function fixture(t:TestContext,profileId='java-maven-21',features={completion:true,diagnostics:false},badConfig=false){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'light-http-')),workspace=path.join(root,'workspace');
  fs.mkdirSync(workspace,{mode:0o700});fs.mkdirSync(path.join(workspace,'.paircoach'),{mode:0o700});
  fs.writeFileSync(path.join(workspace,'source.java'),'class Original {}\n');
  const runProfile={kind:'RUN_MAIN',timeoutMs:1000,task:{workingDirectory:'.',entry:profileId==='python-3.13'?{kind:'SCRIPT',path:'source.java'}:{kind:'JAVA_MAIN',className:'Original'},tests:{paths:[],names:[]}}};
  fs.writeFileSync(path.join(workspace,'.paircoach/settings.json'),JSON.stringify({schemaVersion:2,taskFilePath:null,taskMode:'IMPLEMENTATION',reviewNotesPath:'review.md',aiConsent:false,contextPatterns:[],runProfiles:[runProfile]}));
  const selected=catalog.profiles.find(p=>p.id===profileId)!;
  fs.writeFileSync(path.join(root,'catalog.json'),JSON.stringify({schemaVersion:1,profiles:[selected]}));
  fs.writeFileSync(path.join(root,'images.json'),JSON.stringify({schemaVersion:1,images:[{key:selected.imageLockKey,image:'paircoach/runtime-'+selected.id+':unit',imageId:'sha256:'+'a'.repeat(64),digest:'sha256:'+'b'.repeat(64),tools:selected.expectedTools}]}));
  const config=path.join(root,'runtime.json');fs.writeFileSync(config,JSON.stringify({schemaVersion:1,activeProfile:badConfig?'missing-profile':profileId,workspaceRoot:workspace,runtimeCatalog:'catalog.json',imageLock:'images.json',languageFeatures:features,execution:{backend:'docker',pullPolicy:'never'}}));
  let driverCalls=0,workerCalls=0,coachEdits=0;
  const OriginalWorker=workers.Worker;
  workers.Worker=function(){workerCalls++;throw Error('No worker may activate during ordinary edit/save');} as unknown as typeof OriginalWorker;
  syncBuiltinESMExports();
  const app=createPairCoachServer({rootPath:workspace,port:0,token:'light-local-token',enableExecution:true,enableCoach:true,runtimeEnvironment:{},
    runtimeArguments:['--runtime-config',config],dockerExecutable:path.join(root,'deliberately-unavailable-docker'),
    runtimeLanguageDriver:new Proxy({} as any,{get(){driverCalls++;throw Error('Retired remote driver accessed');}}),
    coachFactory:context=>({trigger(reason){if(reason==='EDIT'){coachEdits++;context.emit('CHAT_REPLY',{replyTo:null,text:'ordinary edit observed'});}},controlReady(){},stepRendered(){},abort(){},close(){}})});
  let ws:WebSocket|undefined;
  t.after(async()=>{ws?.terminate();await app.close();workers.Worker=OriginalWorker;syncBuiltinESMExports();fs.rmSync(root,{recursive:true,force:true});});
  const port=await app.listen(),sessionId=app.session.state.sessionId,clientId='tab',frames:any[]=[];
  const wait=async(match:(m:any)=>boolean)=>{
    const deadline=Date.now()+3000;
    while(!frames.some(match)){assert.ok(Date.now()<deadline,'Expected frame '+match);await new Promise(r=>setTimeout(r,5));}
    return frames.find(match);
  };
  const connect=async()=>{
    ws=new WebSocket(`ws://127.0.0.1:${port}/ws/session`);ws.on('message',b=>frames.push(JSON.parse(b.toString())));await once(ws,'open');
    const previous=frames.length;send('HELLO',{token:'light-local-token',lastServerSeq:0});
    await wait(m=>m.type==='SESSION_SNAPSHOT'&&frames.indexOf(m)>=previous);return frames.filter(m=>m.type==='SESSION_SNAPSHOT').at(-1);
  };
  const send=(type:string,payload:unknown,id=randomUUID(),scope={clientId,sessionId})=>{ws!.send(JSON.stringify({protocolVersion:'3.0',messageId:id,...scope,type,payload}));return id;};
  const http=async(method:string,url:string,body?:unknown,auth=true)=>{
    const response=await fetch(`http://127.0.0.1:${port}${url}`,{method,headers:{...(auth?{Authorization:'Bearer light-local-token'}:{}),'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
    return {status:response.status,body:await response.json() as any};
  };
  const first=await connect();
  const noInfrastructure=()=>{
    assert.equal(driverCalls,0);assert.equal(workerCalls,0);
    const paths=fs.readdirSync(root,{recursive:true}).map(String);
    assert.equal(paths.some(p=>/(?:^|[/\\])(?:language[^/\\]*|shadow[^/\\]*|bounded[^/\\]*|ack-ledger)(?:[/\\]|$)/i.test(p)),false,paths.join('\n'));
    assert.equal(frames.some(m=>['COMPLETE_RESULT','DIAGNOSTICS','LANGUAGE_STATUS'].includes(m.type)),false);
  };
  return {app,root,workspace,sessionId,clientId,first,frames,send,wait,http,connect,noInfrastructure,get edits(){return coachEdits;}};
}

for(const [profile,features] of [['java-maven-21',{completion:true,diagnostics:false}],['python-3.13',{completion:false,diagnostics:true}]] as const)
  test(`LIGHT actual HTTP/WS ${profile}: local config/bootstrap, ordinary original ACK/duplicate/reject/legacy denial, zero owner FS/worker`,async t=>{
    const f=await fixture(t,profile,features);
    assert.ok(validateV2WireShape('ServerMessage',f.first));assert.deepEqual(f.first.payload.languageBootstrap.features,features);
    assert.equal(f.first.payload.languageBootstrap.provider,'builtin');assert.equal(f.first.payload.project.capabilities.language.state,'OFF');
    assert.equal(f.first.payload.project.capabilities.language.autocomplete,'OFF','server cannot attest browser worker');
    const unauth=await f.http('GET','/api/project',undefined,false);assert.equal(unauth.status,401);
    const payload={path:'source.java',baseVersion:1,content:'class Current {}\n',editKind:'TYPING',controlEpoch:0};
    const id=f.send('CODE_CHANGED',payload),ack=await f.wait(m=>m.type==='ACK'&&m.payload.replyTo===id);
    assert.equal(ack.payload.status,'OK');assert.equal(ack.payload.documentVersion,2);assert.equal(ack.payload.workspaceVersion,1);
    assert.equal(f.frames.some(m=>m.type==='CHAT_REPLY'&&m.seq<ack.seq),false);
    const second=f.send('CODE_CHANGED',{...payload,baseVersion:2,content:'class Newer {}\n'});await f.wait(m=>m.type==='ACK'&&m.payload.replyTo===second);
    const veto=f.send('VETO_ESCAPE',{controlEpoch:0,activeInterventionId:null,lastAppliedSeq:f.frames.at(-1).seq});await f.wait(m=>m.type==='ACK'&&m.payload.replyTo===veto);
    f.send('CODE_CHANGED',payload,id);const duplicate=await f.wait(m=>m.type==='ACK'&&m.payload.replyTo===id&&m.seq>ack.seq);
    assert.equal(duplicate.messageId,ack.messageId);assert.deepEqual(duplicate.payload,{...ack.payload,status:'DUPLICATE'});assert.equal(f.edits,2);
    const stale=f.send('CODE_CHANGED',{...payload,content:'REJECT stale epoch'});assert.equal((await f.wait(m=>m.type==='ACK'&&m.payload.replyTo===stale)).payload.error.code,'STALE_EPOCH');
    const conflict=f.send('CODE_CHANGED',{...payload,content:'ID collision'},id);assert.equal((await f.wait(m=>m.type==='ACK'&&m.payload.replyTo===conflict&&m.payload.status==='REJECTED')).payload.error.code,'IDEMPOTENCY_CONFLICT');
    const b=f.first.payload,bootstrap=b.languageBootstrap;
    const stamp={projectId:b.project.projectId,sessionId:f.sessionId,path:'source.java',profileId:profile,connectionGeneration:bootstrap.connectionGeneration,
      configurationGeneration:b.project.capabilities.execution.runtime.configurationGeneration,providerGeneration:b.project.capabilities.language.providerGeneration,
      shadowGeneration:bootstrap.shadowGeneration,modelLifetime:'current-model',localModelVersion:1,baseDocumentVersion:3,documentVersion:null,
      contentSha256:createHash('sha256').update('class Newer {}\n').digest('hex'),controlEpoch:f.app.session.state.controlEpoch,requestGeneration:1};
    for(const [type,payload] of [['LANGUAGE_OPEN',{stamp,content:'class Newer {}\n',reason:'OPEN'}],['LANGUAGE_CHANGE',{stamp,content:'class Newer {}\n',reason:'TYPING'}],['LANGUAGE_CLOSE',{stamp}],['LANGUAGE_COMPLETE',{stamp,requestId:'complete',position:{line:1,column:1},trigger:null}],['LANGUAGE_CANCEL',{stamp,requestId:'complete'}]] as const){
      const id=f.send(type,payload),denied=await f.wait(m=>m.type==='ACK'&&m.payload.replyTo===id);assert.equal(denied.payload.status,'REJECTED');assert.equal(denied.payload.error.code,'REMOTE_LANGUAGE_DISABLED');
    }
    const ping=f.send('PING',{lastAppliedSeq:f.frames.at(-1).seq});assert.equal((await f.wait(m=>m.type==='ACK'&&m.payload.replyTo===ping)).payload.status,'OK');
    const current=await f.http('GET','/api/project');assert.equal(current.status,200);
    const run=await f.http('POST','/api/run',{requestId:randomUUID(),clientId:f.clientId,sessionId:f.sessionId,mode:'RUN_MAIN',expectedWorkspaceVersion:2,configurationGeneration:current.body.capabilities.execution.runtime.configurationGeneration});
    assert.ok(run.status>=400);assert.ok(run.body.code,JSON.stringify(run.body));assert.equal(fs.readFileSync(path.join(f.workspace,'source.java'),'utf8'),'class Newer {}\n');
    f.noInfrastructure();
    const fresh=await f.connect();assert.notEqual(fresh.payload.languageBootstrap.connectionGeneration,bootstrap.connectionGeneration);assert.notEqual(fresh.payload.languageBootstrap.shadowGeneration,bootstrap.shadowGeneration);
    assert.equal(fresh.payload.project.workspaceVersion,2);
    const beforeReplay=f.frames.at(-1).seq;
    f.send('CODE_CHANGED',payload,id);
    const reconnectedReplay=await f.wait(m=>m.type==='ACK'&&m.payload.replyTo===id&&m.seq>beforeReplay);
    assert.equal(reconnectedReplay.messageId,ack.messageId);
    assert.deepEqual(reconnectedReplay.payload,{...ack.payload,status:'DUPLICATE'});
    assert.equal(f.app.workspace.workspaceVersion,2);assert.equal(f.edits,2);
    assert.equal(fs.readFileSync(path.join(f.workspace,'source.java'),'utf8'),'class Newer {}\n');f.noInfrastructure();
  });

test('LIGHT invalid runtime config still starts actual HTTP/WS and preserves authorized ordinary save',async t=>{
  const f=await fixture(t,'java-maven-21',{completion:false,diagnostics:false},true);
  assert.equal(f.first.payload.languageBootstrap,null);assert.equal(f.first.payload.project.capabilities.execution.runtime.state,'CONFIG_ERROR');
  const id=f.send('CODE_CHANGED',{path:'source.java',baseVersion:1,content:'class SafeDraft {}\n',editKind:'TYPING',controlEpoch:0});
  assert.equal((await f.wait(m=>m.type==='ACK'&&m.payload.replyTo===id)).payload.status,'OK');assert.equal((await f.http('GET','/api/project')).status,200);f.noInfrastructure();
});
