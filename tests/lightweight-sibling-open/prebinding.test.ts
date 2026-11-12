/** Real loopback HTTP/WS and filesystem/default composition. Synthetic image metadata;
 * no Docker, prepare, actual Run or host toolchain is invoked. */
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import WebSocket from 'ws';
import { createPairCoachServer } from '../../src/server/http';
import { profile, image } from '../runtime-executor/fixtures';

function fixture(t: TestContext, unsafe: boolean) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'sibling-open-'));
  const project=path.join(root,'project'), other=path.join(root,'other');
  const settings={schemaVersion:2,taskFilePath:null,taskMode:'IMPLEMENTATION',reviewNotesPath:'review.md',runProfiles:[],aiConsent:false,contextPatterns:[]};
  for(const p of [project,other]) {
    fs.mkdirSync(path.join(p,'.paircoach'),{recursive:true,mode:0o700});
    fs.writeFileSync(path.join(p,'main.js'),'ORIGINAL\n');
    fs.writeFileSync(path.join(p,'.paircoach','settings.json'),JSON.stringify(settings));
  }
  const base=unsafe?project:root,config=path.join(base,'runtime.json');
  fs.writeFileSync(path.join(base,'catalog.json'),JSON.stringify({schemaVersion:1,profiles:[profile]}));
  fs.writeFileSync(path.join(base,'images.lock.json'),JSON.stringify({schemaVersion:1,images:[image]}));
  fs.writeFileSync(config,JSON.stringify({schemaVersion:1,activeProfile:profile.id,workspaceRoot:project,runtimeCatalog:'catalog.json',imageLock:'images.lock.json',languageFeatures:{completion:true,diagnostics:true},execution:{backend:'docker',pullPolicy:'never'}}));
  const token='sibling-open-test-only-token';
  const app=createPairCoachServer({port:0,token,enableExecution:true,runtimeEnvironment:{},runtimeArguments:['--runtime-config',config],dockerExecutable:path.join(root,'missing-docker')});
  t.after(async()=>{
    try {
      const closed=app.close();
      if(unsafe) {
        await assert.rejects(closed,{code:'RUN_RECOVERY_REQUIRED'});
        assert.equal(app.close(),closed,'same unconfirmed close is retained');
      } else await closed;
      assert.equal(app.server.listening,false);
    } finally {fs.rmSync(root,{recursive:true,force:true});}
  });
  const request=async(port:number,method:string,url:string,body?:unknown,auth=token)=>{
    const response=await fetch(`http://127.0.0.1:${port}${url}`,{method,signal:AbortSignal.timeout(5000),headers:{Authorization:`Bearer ${auth}`,...body?{'Content-Type':'application/json'}:{}},body:body?JSON.stringify(body):undefined});
    return {status:response.status,body:await response.json()};
  };
  const connect=async(port:number,sessionId:string)=>{
    const ws=new WebSocket(`ws://127.0.0.1:${port}/ws/session`);t.after(()=>ws.terminate());await once(ws,'open');
    const snapshot=once(ws,'message');ws.send(JSON.stringify({protocolVersion:'3.0',messageId:randomUUID(),clientId:'tab',sessionId,type:'HELLO',payload:{token,lastServerSeq:0}}));
    const message=JSON.parse((await snapshot)[0].toString());assert.equal(message.type,'SESSION_SNAPSHOT');return ws;
  };
  const open=()=>({requestId:randomUUID(),clientId:'tab',rootPath:other,settings});
  return {root,project,other,app,request,connect,open};
}

test('unsafe old runtime rejects sibling-open before next binding mkdir, preserving owner/sources/snapshots and finish/close uncertainty',async t=>{
  const f=fixture(t,true),port=await f.app.listen(),p=await f.request(port,'GET','/api/project');
  assert.equal(p.status,200);assert.equal(p.body.capabilities.execution.runtime.state,'CONFIG_ERROR');
  assert.equal(p.body.capabilities.execution.runtime.problem.code,'RUNTIME_STATE_UNAVAILABLE');
  const ws=await f.connect(port,p.body.sessionId);
  const core={workspace:f.app.workspace,session:f.app.session};
  const source=fs.readFileSync(path.join(f.project,'main.js')),settings=fs.readFileSync(path.join(f.project,'.paircoach','settings.json'));
  const snapshotDir=path.join(f.project,'.paircoach','snapshots-v1');
  const snapshots=()=>fs.existsSync(snapshotDir)?fs.readdirSync(snapshotDir).sort():[];
  const before=snapshots();
  const runtime=path.join(f.project,'.paircoach-runtime');assert.equal(fs.existsSync(runtime),false);
  const finished=await f.request(port,'POST','/api/session/finish',{requestId:randomUUID(),clientId:'tab',sessionId:p.body.sessionId,expectedWorkspaceVersion:p.body.workspaceVersion,reason:'COMPLETED'});
  assert.equal(finished.status,409);assert.equal(finished.body.code,'RUN_RECOVERY_REQUIRED');
  const request=f.open();
  const denied=await f.request(port,'POST','/api/project/open',request);
  assert.equal(denied.status,409);assert.equal(denied.body.code,'RUN_RECOVERY_REQUIRED');
  assert.equal(fs.existsSync(runtime),false,'rejected replacement must not mkdir runtime state inside old workspace');
  assert.equal(f.app.workspace,core.workspace);assert.equal(f.app.session,core.session);
  assert.equal(f.app.workspace.rootPath,f.project);assert.equal(f.app.session.state.sessionId,p.body.sessionId);assert.equal(f.app.session.state.lifecycle,'READY');
  assert.deepEqual(snapshots(),before);assert.deepEqual(fs.readFileSync(path.join(f.project,'main.js')),source);assert.deepEqual(fs.readFileSync(path.join(f.project,'.paircoach','settings.json')),settings);
  assert.equal(ws.readyState,WebSocket.OPEN,'refused replacement does not revoke old authenticated lease');
  const replay=await f.request(port,'POST','/api/project/open',request);assert.equal(replay.status,409);assert.equal(replay.body.code,'RUN_RECOVERY_REQUIRED');assert.equal(fs.existsSync(runtime),false);
  assert.equal((await f.request(port,'GET','/api/file?path=main.js')).status,200,'manual editor remains available');
});

test('safe accounted owner allows sibling replacement, but auth/lease guards still refuse unauthorized adoption',async t=>{
  const f=fixture(t,false),port=await f.app.listen(),p=await f.request(port,'GET','/api/project');assert.equal(p.status,200);
  const ws=await f.connect(port,p.body.sessionId);
  const unauthorized=await f.request(port,'POST','/api/project/open',f.open(),'wrong-token');assert.equal(unauthorized.status,401);
  const lease=await f.request(port,'POST','/api/project/open',{...f.open(),clientId:'foreign'});assert.equal(lease.status,409);assert.equal(lease.body.code,'LEASE_CONFLICT');assert.equal(f.app.workspace.rootPath,f.project);
  const closed=once(ws,'close'),opened=await f.request(port,'POST','/api/project/open',f.open());
  assert.equal(opened.status,201,JSON.stringify(opened));await closed;
  assert.equal(f.app.workspace.rootPath,f.other);assert.notEqual(opened.body.sessionId,p.body.sessionId);
  assert.equal(fs.readFileSync(path.join(f.project,'main.js'),'utf8'),'ORIGINAL\n');
  assert.equal(fs.existsSync(path.join(f.project,'.paircoach-runtime')),false);
  assert.equal((await f.request(port,'GET','/api/project')).body.projectId,opened.body.projectId);
});
