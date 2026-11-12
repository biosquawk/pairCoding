/** UNIT: real default HTTP/WS/core/Store/gate/Runner/executor/adapter/ReportService.
 * NEW explicit maintenance/service fixture. Synthetic Docker engine/image/cache/prepare evidence; controlled AI, never runtime/native proof.
 * Producer-owned identity is calculated by the actual installed pinned metadata helper, not copied.
 */
import fs from 'node:fs';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { randomUUID, createHash } from 'node:crypto';
import { once } from 'node:events';
import type { TestContext } from 'node:test';
import WebSocket from 'ws';
import { createPairCoachServer, type ReportAIFacts } from '../../src/server/http';
import { readRunSourceInventory } from '../../src/server/execution/ImmutableInput';
import { dependencyHash } from '../../src/server/runtime-adapters';
import { resolvePreparedToolchainIdentity } from '../../scripts/runtime-prepare.mjs';
import { FakeDocker } from '../runtime-executor/fixtures';
import type { RuntimeProfile, SettingsV2, RunRequestV2 } from '../../src/shared/runtime-v2';
export const sha=(b:string|Buffer)=>createHash('sha256').update(b).digest('hex');
export async function httpNetworkFixture(t:TestContext,service=false) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'http-network-maintenance-')), project=path.join(root,'project'), prepared=path.join(root,'prepared');
  fs.mkdirSync(project);fs.mkdirSync(path.join(project,'.paircoach'),{mode:0o700});fs.mkdirSync(prepared,{mode:0o700});
  fs.writeFileSync(path.join(project,'main.js'),'console.log("ORIGINAL");\r\n');fs.writeFileSync(path.join(project,'test.js'),'// original test\r\n');fs.writeFileSync(path.join(project,'package.json'),'{}\r\n');
  const settings:SettingsV2={schemaVersion:2,taskFilePath:null,taskMode:'IMPLEMENTATION',reviewNotesPath:'review.md',runProfiles:[
    {kind:'RUN_MAIN',task:{workingDirectory:'.',entry:{kind:'SCRIPT',path:'main.js'},tests:{paths:[],names:[]}},timeoutMs:300000},
    {kind:'RUN_TESTS',task:{workingDirectory:'.',entry:{kind:'TESTS'},tests:{paths:['test.js'],names:[]}},timeoutMs:300000}],aiConsent:true,contextPatterns:['**/*.js']};
  if(service) {
    settings.runProfiles[0].task.entry={kind:'SPRING_BOOT',containerPort:8080,healthPath:'/health'};
    settings.runProfiles[1].task.tests={paths:[],names:['MainTest']};
    fs.writeFileSync(path.join(project,'pom.xml'),'<project><modelVersion>4.0.0</modelVersion><groupId>unit</groupId><artifactId>unit</artifactId><version>1</version></project>');
  }
  fs.writeFileSync(path.join(project,'.paircoach','settings.json'),JSON.stringify(settings));
  const catalog=JSON.parse(fs.readFileSync(new URL('../../runtimes/catalog.json',import.meta.url),'utf8'));
  const profile:RuntimeProfile=catalog.profiles.find((p:RuntimeProfile)=>service?p.adapterFamily==='java-maven'&&p.compilerRelease===21:p.adapterFamily==='node');
  const image={key:profile.imageLockKey,image:'paircoach/runtime-node:unit',imageId:'sha256:'+'a'.repeat(64),digest:'sha256:'+'b'.repeat(64),tools:profile.expectedTools};
  const lock=JSON.parse(fs.readFileSync(new URL('../../runtimes/production-inputs.lock.json',import.meta.url),'utf8'));
  const files=await readRunSourceInventory(project), dependency=dependencyHash(files), fake=new FakeDocker();
  const request={schemaVersion:1,workingDirectory:'.',installationId:'prepare-unit',family:profile.adapterFamily,key:profile.id,imageTag:image.image,
    baseImage:lock.images[service?'java21':'node'].reference,nodeImage:lock.images.node.reference,expectedTools:profile.expectedTools,dependencySha256:dependency,outputRoot:prepared,
    tools:{root:path.join(root,'synthetic-tool-provenance'),files:lock.artifacts.filter((a:any)=>a.kind==='npm').flatMap((a:any)=>a.files.map((f:any)=>({path:'node_modules/'+a.name+'/'+f.path,sha256:f.sha256})))},
    project:{root:project,files:files.map(({path,sha256})=>({path,sha256}))}};
  const identity=resolvePreparedToolchainIdentity(request), cache=path.join(prepared,'cache',profile.adapterFamily,identity.toolchainHash,dependency);fs.mkdirSync(cache,{recursive:true});
  const engine={ID:fake.engineId,ServerVersion:'29.7.2',OSType:'linux',Architecture:'amd64'};
  const inspected={Id:image.imageId,Os:'linux',Architecture:'amd64',RepoDigests:['paircoach/runtime-node@'+image.digest],Config:{User:'10001:10001',Entrypoint:null}};
  const tools=profile.expectedTools.map(x=>({...x,raw:x.version+'\n'})), marker={family:profile.adapterFamily,workingDirectory:'.',dependencySha256:dependency,tools,preparedAt:'2026-11-12T01:00:00.000Z'};
  fs.writeFileSync(path.join(cache,'tools.json'),JSON.stringify(tools));fs.writeFileSync(path.join(cache,'dependencies-prepared.json'),JSON.stringify(marker));
  fs.writeFileSync(path.join(prepared,'receipt.json'),JSON.stringify({schemaVersion:1,status:'PREPARED_REQUIRES_OFFLINE_AND_TOOL_VALIDATION',request,engine,...identity,imageId:image.imageId,imageInspect:inspected,
    observedImage:{Id:inspected.Id,RepoDigests:inspected.RepoDigests,Descriptor:null},container:{Id:'e'.repeat(64),State:{Running:false,ExitCode:0},Config:{Image:image.imageId,Labels:{'paircoach.installation':'prepare-unit','paircoach.role':'prepare'}}},
    cacheEvidence:{root:cache,tools:{path:'tools.json',sha256:sha(JSON.stringify(tools)),actual:tools},dependencies:{path:'dependencies-prepared.json',sha256:sha(JSON.stringify(marker)),actual:marker}}}));
  const config=path.join(root,'paircoach.runtime.json');
  fs.writeFileSync(path.join(root,'catalog.json'),JSON.stringify({schemaVersion:1,profiles:[profile]}));fs.writeFileSync(path.join(root,'images.lock.json'),JSON.stringify({schemaVersion:1,images:[image,...(profile.language.imageLockKey?[{...image,key:profile.language.imageLockKey,imageId:'sha256:'+'d'.repeat(64)}]:[])]}));
  fs.writeFileSync(config,JSON.stringify({schemaVersion:1,activeProfile:profile.id,workspaceRoot:project,runtimeCatalog:'catalog.json',imageLock:'images.lock.json',languageFeatures:{completion:true,diagnostics:true},execution:{backend:'docker',pullPolicy:'never'}}));
  const token='UNIT_HTTP_TOKEN_secret_sentinel_12345',output='RUN_STDOUT_SENTINEL '+token, ai:ReportAIFacts[]=[], analyses:unknown[]=[];
  fake.logs={stdout:output,stderr:'RUN_STDERR_SENTINEL'};
  const networkCalls:string[][]=[];
  let network:Record<string,any>|null=null, noCreate=false, lostCreate=false, failReadback=false, wrongEngine=false;
  let beforeCreate:(()=>Promise<void>)|undefined;
  const transport={run:async(args:readonly string[])=>{
    if(args[0]==='network') {
      networkCalls.push([...args]);
      if(args[1]==='create') {
        await beforeCreate?.();
        // Observe the real immutable original command durably on disk BEFORE the effect.
        const requests=fs.readdirSync(path.join(project,'.paircoach','runtime-network-maintenance')).filter(n=>n.endsWith('.json'));
        if(!requests.length)throw Error('No original request persisted');
        const labels:Record<string,string>={};for(let i=0;i<args.length;i++)if(args[i]==='--label'){const [k,...v]=args[i+1].split('=');labels[k]=v.join('=');}
        if(noCreate){failReadback=true;throw Error('UNIT create failed before effect, reply untrusted');}
        network={Name:args.at(-1),Id:'f'.repeat(64),Internal:args.includes('--internal'),Driver:'bridge',Scope:'local',Labels:labels};
        if(lostCreate){failReadback=true;throw Error('UNIT lost create reply');}
        return {exitCode:0,stdout:network.Id,stderr:''};
      }
      if(failReadback)throw Error('UNIT readback unavailable');
      if(args[1]==='ls')return {exitCode:0,stdout:network?JSON.stringify({Name:network.Name,ID:network.Id}):'',stderr:''};
      if(args[1]==='inspect')return {exitCode:network?0:1,stdout:JSON.stringify(network?[network]:[]),stderr:''};
      throw Error('Unapproved network operation');
    }
    if(args[0]==='info' && wrongEngine)return {exitCode:0,stdout:args[2]==='{{json .}}'?JSON.stringify({...engine,ID:'foreign-engine'}):JSON.stringify('foreign-engine'),stderr:''};
    if(args[0]==='image')return {exitCode:0,stdout:JSON.stringify([inspected]),stderr:''};
    if(args[0]==='info' && args[2]==='{{json .}}')return {exitCode:0,stdout:JSON.stringify(engine),stderr:''};
    return fake.run(args);
  }};
  let expectedUnconfirmedClose=false;
  const apps:ReturnType<typeof createPairCoachServer>[]=[], sockets:WebSocket[]=[];
  const app=()=>{const a=createPairCoachServer({port:0,rootPath:project,token,enableExecution:true,enableCoach:true,runtimeEnvironment:{},runtimeArguments:['--runtime-config',config,'--prepared-runtime',prepared],runtimeTransport:transport,
    coachProvider:{name:'UNIT',mode:'INJECTED',decide:async context=>{analyses.push(structuredClone(context));return {kind:'SILENT',reason:'UNIT controlled provider'};}},
    reportGenerate:async facts=>{ai.push(structuredClone(facts));return '# UNIT structural facts\nControlled AI provider, not real AI.';}});apps.push(a);return a;};
  const http=async(port:number,method:string,url:string,body?:unknown,authorization=token)=>{
    const r=await fetch(`http://127.0.0.1:${port}${url}`,{method,headers:{Authorization:`Bearer ${authorization}`,'Content-Type':'application/json'},signal:AbortSignal.timeout(8000),body:body===undefined?undefined:JSON.stringify(body)});
    return {status:r.status,body:await r.json()};
  };
  const connect=async(port:number,sessionId:string)=>{
    const ws=new WebSocket(`ws://127.0.0.1:${port}/ws/session`);sockets.push(ws);const frames:any[]=[];ws.on('message',data=>frames.push(JSON.parse(data.toString())));await once(ws,'open');
    ws.send(JSON.stringify({protocolVersion:'3.0',messageId:randomUUID(),clientId:'tab',sessionId,type:'HELLO',payload:{token,lastServerSeq:0}}));
    await until(()=>frames.some(f=>f.type==='SESSION_SNAPSHOT'));
    return {ws,frames,bundle:frames.find(f=>f.type==='SESSION_SNAPSHOT').payload,send:(type:string,payload:unknown)=>{const messageId=randomUUID();ws.send(JSON.stringify({protocolVersion:'3.0',messageId,clientId:'tab',sessionId,type,payload}));return messageId;}};
  };
  const runRequest=(p:any,mode:'RUN_MAIN'|'RUN_TESTS'='RUN_TESTS'):RunRequestV2=>({requestId:randomUUID(),clientId:'tab',sessionId:p.sessionId,expectedWorkspaceVersion:p.workspaceVersion,configurationGeneration:p.capabilities.execution.runtime.configurationGeneration,mode});
  const state=path.join(root,'.paircoach-runtime','projects',sha(project));
  t.after(async()=>{fake.daemon=true;fake.stopRemainsRunning=false;for(const a of apps){if(expectedUnconfirmedClose)await assert.rejects(a.close(),{code:'PROCESS_STOP_UNCONFIRMED'});else await a.close();}for(const s of sockets)s.terminate();
    function unlock(p:string){if(fs.lstatSync(p).isDirectory()){fs.chmodSync(p,0o700);for(const n of fs.readdirSync(p))unlock(path.join(p,n));}}unlock(root);fs.rmSync(root,{recursive:true,force:true});});
  return {root,project,prepared,config,settings,fake,app,http,connect,runRequest,state,ai,analyses,token,output,networkCalls,
    expectUnconfirmedClose:()=>{expectedUnconfirmedClose=true;},getNetwork:()=>network,setNetwork:(v:Record<string,any>)=>{network=v;},
    loseCreate:()=>{lostCreate=true;},failCreateBeforeEffect:()=>{noCreate=true;},allowCreate:()=>{noCreate=false;},restoreReadback:()=>{failReadback=false;},setWrongEngine:(v:boolean)=>{wrongEngine=v;},
    holdCreate:(v:()=>Promise<void>)=>{beforeCreate=v;}};
}
export async function until(predicate:()=>boolean){const until=Date.now()+4000;while(!predicate()){if(Date.now()>until)throw Error('Expected actual HTTP/WS transition not observed');await new Promise(r=>setTimeout(r,5));}}
