/** Actual HTTP/default composition/WS/manual editor, synthetic config+image metadata; NO Docker. */
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import WebSocket from 'ws';
import { createPairCoachServer } from '../../src/server/http';
import { profile, image } from '../runtime-executor/fixtures';
function fixture(t: TestContext, overlap=false) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'http-execution-defaults-')), project=path.join(root,'project');fs.mkdirSync(project);fs.mkdirSync(path.join(project,'.paircoach'),{mode:0o700});
  fs.writeFileSync(path.join(project,'main.js'),'ORIGINAL\n');fs.writeFileSync(path.join(project,'.paircoach','settings.json'),JSON.stringify({schemaVersion:2,taskFilePath:null,taskMode:'IMPLEMENTATION',reviewNotesPath:'review.md',runProfiles:[],aiConsent:false,contextPatterns:[]}));
  const base=overlap?project:root,config=path.join(base,'paircoach.runtime.json');
  fs.writeFileSync(path.join(base,'catalog.json'),JSON.stringify({schemaVersion:1,profiles:[profile]}));fs.writeFileSync(path.join(base,'images.lock.json'),JSON.stringify({schemaVersion:1,images:[image]}));
  fs.writeFileSync(config,JSON.stringify({schemaVersion:1,activeProfile:profile.id,workspaceRoot:project,runtimeCatalog:'catalog.json',imageLock:'images.lock.json',languageFeatures:{completion:true,diagnostics:true},execution:{backend:'docker',pullPolicy:'never'}}));
  const token='http-test-only-valid-length',a=createPairCoachServer({port:0,token,enableExecution:true,runtimeEnvironment:{},runtimeArguments:['--runtime-config',config],dockerExecutable:path.join(root,'missing-approved-docker')});
  t.after(async()=>{await a.close();fs.rmSync(root,{recursive:true,force:true});});
  const request=async(port:number,method:string,url:string,body?:unknown)=>{const r=await fetch(`http://127.0.0.1:${port}${url}`,{method,signal:AbortSignal.timeout(5000),headers:{Authorization:`Bearer ${token}`,...body?{'Content-Type':'application/json'}:{}},body:body?JSON.stringify(body):undefined});return {status:r.status,body:await r.json()};};
  return {root,project,config,a,request,token};
}
test('HTTP actual default path constructs SAME durable private identity/public neutral Runner without Docker or host fallback',async t=>{
  const f=fixture(t),port=await f.a.listen(),p=await f.request(port,'GET','/api/project?readiness=actual');assert.equal(p.status,200);
  assert.equal(p.body.capabilities.execution.runtime.problem,null);assert.equal(p.body.capabilities.execution.modes.RUN_MAIN.canRun,false);assert.equal(p.body.capabilities.execution.modes.RUN_MAIN.problem.code,'TASK_CONFIG_INVALID');
  const state=path.join(f.root,'.paircoach-runtime','projects',createHash('sha256').update(f.project).digest('hex')),file=path.join(state,'installation.json'),record=JSON.parse(fs.readFileSync(file,'utf8'));
  assert.equal(record.projectId,p.body.projectId);assert.equal(record.workspaceRoot,f.project);assert.ok(record.installationId);
  assert.deepEqual(fs.readdirSync(path.join(state,'docker-config')),[]);assert.deepEqual(fs.readdirSync(path.join(state,'journal')),[]);assert.deepEqual(fs.readdirSync(path.join(state,'runs')),[]);
  const original=fs.readFileSync(file);await f.request(port,'GET','/api/project');assert.deepEqual(fs.readFileSync(file),original);
  assert.equal(fs.existsSync(path.join(f.project,'.paircoach-runtime')),false);assert.equal(fs.readFileSync(path.join(f.project,'main.js'),'utf8'),'ORIGINAL\n');
});
test('HTTP unsafe config-parent overlap blocks ONLY execution with CONFIG_ERROR, real WS/editor remain available and no runtime mkdir',async t=>{
  const f=fixture(t,true),port=await f.a.listen(),p=await f.request(port,'GET','/api/project');assert.equal(p.status,200);
  assert.equal(p.body.capabilities.execution.runtime.state,'CONFIG_ERROR');assert.equal(p.body.capabilities.execution.runtime.problem.code,'RUNTIME_STATE_UNAVAILABLE');assert.equal(fs.existsSync(path.join(f.project,'.paircoach-runtime')),false);
  const ws=new WebSocket(`ws://127.0.0.1:${port}/ws/session`);t.after(()=>ws.terminate());await once(ws,'open');
  const snapshot=Promise.race([once(ws,'message'), once(ws,'close').then(()=>{throw Error('WS closed before snapshot');}), new Promise<never>((_,reject)=>{const timer=setTimeout(()=>reject(Error('snapshot deadline')),3000);timer.unref();})]);ws.send(JSON.stringify({protocolVersion:'3.0',messageId:randomUUID(),clientId:'tab',sessionId:p.body.sessionId,type:'HELLO',payload:{token:f.token,lastServerSeq:0}}));
  const message=JSON.parse((await snapshot)[0].toString());assert.equal(message.type,'SESSION_SNAPSHOT');
  const changed=await f.request(port,'POST','/api/file',{requestId:randomUUID(),clientId:'tab',sessionId:p.body.sessionId,controlEpoch:f.a.session.state.controlEpoch,operation:'CREATE',path:'manual.js',newPath:null,content:'EDITABLE\n',baseVersion:null});
  assert.equal(changed.status,200);assert.equal(fs.readFileSync(path.join(f.project,'manual.js'),'utf8'),'EDITABLE\n');assert.equal(fs.existsSync(path.join(f.project,'.paircoach-runtime')),false);
});
test('HTTP actual UNBOUND never creates managed runtime state even with execution enabled',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'http-execution-unbound-')),config=path.join(root,'absent.json');
  const a=createPairCoachServer({port:0,enableExecution:true,runtimeEnvironment:{},runtimeArguments:['--runtime-config',config]});
  t.after(async()=>{await a.close();fs.rmSync(root,{recursive:true,force:true});});await a.listen();
  assert.throws(()=>a.workspace,{code:'PROJECT_OPEN_REQUIRED'});assert.deepEqual(fs.readdirSync(root),[]);
});
