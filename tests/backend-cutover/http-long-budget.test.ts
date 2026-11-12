/** Real HTTP/WS/auth/GUI settings builder/save; no browser or task execution, runtime deliberately unavailable. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {once} from 'node:events';
import WebSocket from 'ws';
import {createPairCoachServer} from '../../src/server/http';
import {buildRuntimeSettingsV2,createRuntimeSettingsDraftV2} from '../../src/services/RuntimeClientV2';
import {profile,image} from '../runtime-executor/fixtures';

test('HTTP authenticated GUI-built 15min/1h save roundtrips exactly; legacy catalog unchanged and >1h fails without writes',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'http-long-budget-')), workspace=path.join(root,'project');
  fs.mkdirSync(path.join(workspace,'.paircoach'),{recursive:true,mode:0o700});fs.writeFileSync(path.join(workspace,'main.js'),'ORIGINAL\n');
  fs.writeFileSync(path.join(workspace,'.paircoach/settings.json'),JSON.stringify({schemaVersion:2,taskFilePath:null,taskMode:'IMPLEMENTATION',reviewNotesPath:'review.md',aiConsent:false,contextPatterns:[],
    runProfiles:[{kind:'RUN_MAIN',timeoutMs:120000,task:{workingDirectory:'.',entry:{kind:'SCRIPT',path:'main.js'},tests:{paths:[],names:[]}}}]}));
  const config=path.join(root,'runtime.json'), catalog=JSON.stringify({schemaVersion:1,profiles:[profile]});
  fs.writeFileSync(path.join(root,'catalog.json'),catalog);fs.writeFileSync(path.join(root,'images.json'),JSON.stringify({schemaVersion:1,images:[image]}));
  fs.writeFileSync(config,JSON.stringify({schemaVersion:1,activeProfile:profile.id,workspaceRoot:workspace,runtimeCatalog:'catalog.json',imageLock:'images.json',languageFeatures:{completion:true,diagnostics:true},execution:{backend:'docker',pullPolicy:'never'}}));
  const token='http-long-budget-unit-token', app=createPairCoachServer({port:0,token,enableExecution:false,runtimeEnvironment:{},runtimeArguments:['--runtime-config',config],
    runtimeReadiness:{execution:{readiness:async()=>{throw Error('UNIT execution intentionally unavailable');}},probe:{probe:async()=>{throw Error('Must not grant execution');}}}});
  let ws:WebSocket|undefined;
  t.after(async()=>{ws?.terminate();await app.close();fs.rmSync(root,{recursive:true,force:true});});
  const port=await app.listen();
  const http=async(method:string,url:string,body?:unknown)=>{const r=await fetch(`http://127.0.0.1:${port}${url}`,{method,headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});return {status:r.status,body:await r.json() as any};};
  let project=(await http('GET','/api/project')).body;assert.equal(project.settings.runProfiles[0].timeoutMs,120000);
  ws=new WebSocket(`ws://127.0.0.1:${port}/ws/session`);await once(ws,'open');
  const ready=once(ws,'message');ws.send(JSON.stringify({protocolVersion:'3.0',messageId:randomUUID(),clientId:'long-tab',sessionId:project.sessionId,type:'HELLO',payload:{token,lastServerSeq:0}}));
  assert.equal(JSON.parse((await ready)[0].toString()).type,'SESSION_SNAPSHOT');
  for(const budget of [900000,3600000]) {
    const draft=createRuntimeSettingsDraftV2(project.settings);draft.RUN_MAIN.fields.timeoutMs=String(budget);
    const settings=buildRuntimeSettingsV2(project.settings,draft,project.capabilities.execution.runtime.taskFields);
    const request={requestId:randomUUID(),clientId:'long-tab',sessionId:project.sessionId,expectedWorkspaceVersion:project.workspaceVersion,settings};
    const saved=await http('PUT','/api/project/settings',request);assert.equal(saved.status,200,JSON.stringify(saved.body));
    assert.equal(saved.body.settings.runProfiles[0].timeoutMs,budget);assert.equal(saved.body.capabilities.execution.modes.RUN_MAIN.canRun,false);
    const replay=await http('PUT','/api/project/settings',request);assert.equal(replay.status,200);assert.deepEqual(replay.body,saved.body);
    project=saved.body;
  }
  const before=fs.readFileSync(path.join(workspace,'.paircoach/settings.json'));
  const bad=structuredClone(project.settings);bad.runProfiles[0].timeoutMs=3600001;
  const rejected=await http('PUT','/api/project/settings',{requestId:randomUUID(),clientId:'long-tab',sessionId:project.sessionId,expectedWorkspaceVersion:project.workspaceVersion,settings:bad});
  assert.equal(rejected.status,400);assert.deepEqual(fs.readFileSync(path.join(workspace,'.paircoach/settings.json')),before);
  assert.equal(fs.readFileSync(path.join(root,'catalog.json'),'utf8'),catalog);assert.equal(fs.readFileSync(path.join(workspace,'main.js'),'utf8'),'ORIGINAL\n');
});
