/** Real HTTP/core/owner with nonremote profile. No image readiness/empty language-result claim. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {once} from 'node:events';
import {randomUUID} from 'node:crypto';
import WebSocket from 'ws';
import catalogData from '../../runtimes/catalog.json';
import {createPairCoachServer} from '../../src/server/http';
import {until} from './http-language-owner-fixture';
import {loadRuntimeConfiguration} from '../../src/server/runtime-config';

for(const provider of ['builtin','off'] as const)test(`HTTP LANG ${provider} owner without receipt supports ordinary save/nonACK without remote verification`,async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'nonremote-language-')),workspace=path.join(root,'project');
  fs.mkdirSync(workspace);fs.mkdirSync(path.join(workspace,'.paircoach'),{mode:0o700});fs.writeFileSync(path.join(workspace,'a.js'),'ORIGINAL\n');
  fs.writeFileSync(path.join(workspace,'.paircoach','settings.json'),JSON.stringify({schemaVersion:2,taskFilePath:null,taskMode:'IMPLEMENTATION',reviewNotesPath:'review.md',runProfiles:[],aiConsent:false,contextPatterns:[]}));
  const profile=structuredClone(catalogData.profiles[0]);profile.language.provider=provider;
  fs.writeFileSync(path.join(root,'catalog.json'),JSON.stringify({schemaVersion:1,profiles:[profile]}));
  fs.writeFileSync(path.join(root,'lock.json'),JSON.stringify({schemaVersion:1,images:[{key:profile.imageLockKey,image:'paircoach/runtime-node:unit',imageId:'sha256:'+'1'.repeat(64),digest:'sha256:'+'2'.repeat(64),tools:profile.expectedTools}]}));
  const config=path.join(root,'runtime.json');fs.writeFileSync(config,JSON.stringify({schemaVersion:1,activeProfile:profile.id,workspaceRoot:workspace,runtimeCatalog:'catalog.json',imageLock:'lock.json',languageFeatures:{completion:true,diagnostics:true},execution:{backend:'docker',pullPolicy:'never'}}));
  assert.ok(loadRuntimeConfiguration({configPath:config,environment:{}}).resolved);
  let calls=0;const app=createPairCoachServer({rootPath:workspace,port:0,token:'nonremote-unit-token',runtimeEnvironment:{},runtimeArguments:['--runtime-config',config],runtimeTransport:{run:async()=>{calls++;throw Error('No remote runtime in nonremote proof');}}});
  let ws:WebSocket|undefined;t.after(async()=>{ws?.terminate();await app.close();fs.rmSync(root,{recursive:true,force:true});});
  const port=await app.listen(),sessionId=app.session.state.sessionId,clientId='tab',frames:any[]=[];
  ws=new WebSocket(`ws://127.0.0.1:${port}/ws/session`);ws.on('message',b=>frames.push(JSON.parse(b.toString())));await once(ws,'open');
  const send=(type:string,payload:unknown,id=randomUUID())=>{ws!.send(JSON.stringify({protocolVersion:'3.0',messageId:id,clientId,sessionId,type,payload}));return id;};
  const wait=async(check:(m:any)=>boolean)=>{await until(()=>frames.some(check),'Nonremote actual HTTP frame');return frames.find(check);};
  send('HELLO',{token:'nonremote-unit-token',lastServerSeq:0});const first=await wait(m=>m.type==='SESSION_SNAPSHOT');
  assert.equal(first.payload.languageBootstrap.provider,provider);assert.equal(first.payload.project.capabilities.language.problem,null);
  const id=send('CODE_CHANGED',{path:'a.js',baseVersion:1,content:'ACTUAL ORDINARY SAVE\n',editKind:'TYPING',controlEpoch:0});
  const ack=await wait(m=>m.type==='ACK'&&m.payload.replyTo===id);assert.equal(ack.payload.status,'OK');assert.equal(ack.payload.documentVersion,2);
  // Genuine successful authorized Workspace file feed, not a fabricated helper operation.
  const response=await fetch(`http://127.0.0.1:${port}/api/file`,{method:'POST',headers:{Authorization:'Bearer nonremote-unit-token','Content-Type':'application/json'},body:JSON.stringify({requestId:randomUUID(),clientId,sessionId,controlEpoch:0,operation:'CREATE',path:'b.js',content:'B closed\n',newPath:null,baseVersion:null})});
  assert.equal(response.status,200,JSON.stringify(await response.json()));
  assert.equal(fs.readFileSync(path.join(workspace,'a.js'),'utf8'),'ACTUAL ORDINARY SAVE\n');assert.equal(fs.readFileSync(path.join(workspace,'b.js'),'utf8'),'B closed\n');
  assert.equal(fs.existsSync(path.join(root,'.paircoach-runtime')),false,'no owner-only runtime layout');
  assert.deepEqual(first.payload.languageBootstrap.features,provider==='builtin'?{completion:true,diagnostics:true}:{completion:false,diagnostics:false});
  assert.equal(first.payload.project.capabilities.language.state,'OFF','backend cannot attest browser readiness');
  assert.equal(calls,0);assert.equal(frames.some(m=>m.type==='COMPLETE_RESULT'||m.type==='DIAGNOSTICS'),false,'OFF/builtin never masquerades as a remote analysis');
});
