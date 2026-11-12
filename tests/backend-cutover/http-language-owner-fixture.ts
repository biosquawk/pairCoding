/** Actual loopback HTTP/WS + canonical core/gate/source/owner/selected factory/registry/journal.
 * ONLY Docker/process/OCI/preparation observations are synthetic UNIT data (no Docker/native proof). */
import assert from 'node:assert/strict';
import type {TestContext} from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import {once} from 'node:events';
import {randomUUID} from 'node:crypto';
import WebSocket from 'ws';
import {fixture as assets} from '../runtime-language-binding/fixture';
import {loadRuntimeConfiguration} from '../../src/server/runtime-config';
import {createPairCoachServer} from '../../src/server/http';
import {validateV2WireShape} from '../../src/shared/validation-v2';
import type {OpenOrChange,LanguageClientMessage} from '../../src/shared/language-v2';
import * as codec from '../../src/language/uriCodec';
export async function until(check:()=>boolean,detail:string){const end=Date.now()+15000;while(!check()&&Date.now()<end)await new Promise(r=>setTimeout(r,10));assert.ok(check(),detail);}
export async function httpLanguage(t:TestContext,receipt=true) {
  let cleanup=async()=>{};t.after(()=>cleanup());
  const f=await assets(t,'java-maven'),runtime=f.lease().runtime,run=f.lease().run;
  f.driver.beforeCreate=null;
  fs.mkdirSync(path.join(f.workspace,'.paircoach'),{mode:0o700});
  fs.writeFileSync(path.join(f.workspace,'.paircoach','settings.json'),JSON.stringify({schemaVersion:2,taskFilePath:null,taskMode:'IMPLEMENTATION',reviewNotesPath:'review.md',runProfiles:[run],aiConsent:false,contextPatterns:[]}));
  fs.writeFileSync(path.join(f.root,'catalog.json'),JSON.stringify({...runtime.catalog,profiles:runtime.catalog.profiles.filter(p=>p.adapterFamily==='java-maven')}));
  fs.writeFileSync(path.join(f.root,'lock.json'),JSON.stringify({schemaVersion:1,images:[...runtime.imageLock.images,...runtime.catalog.profiles.filter(p=>p.adapterFamily==='java-maven'&&p.id!==runtime.profile.id).map(p=>({...runtime.image,key:p.imageLockKey,image:'paircoach/runtime-'+p.id+':stage09',tools:p.expectedTools}))]}));
  fs.writeFileSync(runtime.configPath,JSON.stringify(runtime.config));
  const loaded=loadRuntimeConfiguration({configPath:runtime.configPath,environment:{}});assert.ok(loaded.resolved,JSON.stringify(loaded));
  const languageReceiptPath=f.options.selected.languageReceiptPath;assert.ok(languageReceiptPath);
  const token='local-language-unit-token',clientId='tab';
  const app=createPairCoachServer({rootPath:f.workspace,port:0,token,runtimeEnvironment:{},runtimeTransport:f.options.selected.transport,
    runtimeLanguageDriver:f.driver,
    runtimeArguments:['--runtime-config',runtime.configPath,'--prepared-runtime',f.options.selected.preparedOutputRoots[0],
      ...(receipt?['--language-receipt',languageReceiptPath]:[])]});
  const sockets:WebSocket[]=[];
  cleanup=async()=>{f.driver.unreachable=false;for(const ws of sockets)ws.terminate();await app.close();};
  const port=await app.listen(),sessionId=app.session.state.sessionId;
  async function connect(){
    const ws=new WebSocket(`ws://127.0.0.1:${port}/ws/session`);sockets.push(ws);
    const frames:any[]=[];ws.on('message',b=>frames.push(JSON.parse(b.toString())));await once(ws,'open');
    const send=(type:string,payload:unknown,id=randomUUID())=>{ws.send(JSON.stringify({protocolVersion:'3.0',messageId:id,clientId,sessionId,type,payload}));return id;};
    const wait=async(check:(m:any)=>boolean)=>{await until(()=>frames.some(check),'Expected HTTP language frame: '+check);return frames.find(check);};
    send('HELLO',{token,lastServerSeq:0});const snapshot=await wait(m=>m.type==='SESSION_SNAPSHOT');
    assert.ok(validateV2WireShape('ServerMessage',snapshot),JSON.stringify(snapshot));
    return {ws,frames,send,wait,snapshot};
  }
  const peer=await connect();
  function document(peer:Awaited<ReturnType<typeof connect>>,content=codec.normalizeContent(f.document.content),localVersion=3):OpenOrChange {
    const {project,session,languageBootstrap:b}=peer.snapshot.payload;
    assert.ok(b,'Real authenticated HELLO bootstrapped the owner');
    return {content,reason:'OPEN',stamp:{...f.document.stamp,projectId:project.projectId,sessionId,
      configurationGeneration:project.capabilities.language.configurationGeneration,providerGeneration:project.capabilities.language.providerGeneration,
      connectionGeneration:b.connectionGeneration,shadowGeneration:b.shadowGeneration,baseDocumentVersion:1,documentVersion:null,
      localModelVersion:localVersion,requestGeneration:localVersion,controlEpoch:app.session.state.controlEpoch,contentSha256:codec.contentSha256(content)}};
  }
  const http=async(url:string,method='GET',body?:unknown)=>{
    const response=await fetch(`http://127.0.0.1:${port}${url}`,{method,headers:{Authorization:'Bearer '+token,...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined});
    return {status:response.status,value:await response.json()};
  };
  return {...f,app,port,sessionId,clientId,peer,connect,document,http};
}
