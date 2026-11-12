/** Same cb17 causal fixture: production HTTP/WS/FS/WriteGate/journal and real 5s client.
 * Controlled read-only readiness only; no browser, Docker, provider call or retained host. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {pathToFileURL, fileURLToPath} from 'node:url';
import WebSocket from 'ws';
const repo=process.env.PAIRCOACH_SOURCE??path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
assert.ok(repo);
const {createPairCoachServer}=await import(pathToFileURL(path.join(repo,'src/server/http.ts')).href);
const {LiveBackend}=await import(pathToFileURL(path.join(repo,'src/services/LiveBackend.ts')).href);
const {profile,image}=await import(pathToFileURL(path.join(repo,'tests/runtime-executor/fixtures.ts')).href);
const out=process.env.SAVE_PROOF_OUTPUT;
const record=(name:string,value:unknown)=>{if(out){fs.mkdirSync(out,{recursive:true});fs.writeFileSync(path.join(out,name),JSON.stringify(value,null,2));}};
function latch(){let release!:()=>void;const promise=new Promise<void>(r=>release=r);return {promise,release};}
function stateWhen(live:any,predicate:()=>boolean){
  if(predicate())return Promise.resolve();
  return new Promise<void>((resolve,reject)=>{
    const timer=setTimeout(()=>{off();reject(Error('diagnostic state condition not reached'));},3000);
    const off=live.subscribe('state',()=>{if(predicate()){clearTimeout(timer);off();resolve();}});
  });
}
async function fixture(t:any,coach=false,waitOwnVersion=false){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'save-causal-')),workspace=path.join(root,'workspace');
  fs.mkdirSync(path.join(workspace,'.paircoach'),{recursive:true});fs.writeFileSync(path.join(workspace,'main.js'),'ORIGINAL\n');
  const settings={schemaVersion:2,taskFilePath:null,taskMode:'IMPLEMENTATION',reviewNotesPath:'review.md',aiConsent:false,contextPatterns:[],runProfiles:[{kind:'RUN_MAIN',timeoutMs:1000,task:{workingDirectory:'.',entry:{kind:'SCRIPT',path:'main.js'},tests:{paths:[],names:[]}}}]};
  const write=(name:string,value:any)=>fs.writeFileSync(path.join(root,name),JSON.stringify(value));
  fs.writeFileSync(path.join(workspace,'.paircoach/settings.json'),JSON.stringify(settings));
  write('catalog.json',{schemaVersion:1,profiles:[profile]});write('images.json',{schemaVersion:1,images:[image]});
  write('runtime.json',{schemaVersion:1,activeProfile:profile.id,workspaceRoot:workspace,runtimeCatalog:'catalog.json',imageLock:'images.json',languageFeatures:{completion:true,diagnostics:true},execution:{backend:'docker',pullPolicy:'never'}});
  const start=performance.now(),events:any[]=[],mark=(name:string,detail:any={})=>{const event={ms:+(performance.now()-start).toFixed(3),name,...detail};events.push(event);};
  let hold=false,providerCalls=0,readyCalls=0,probeCalls=0;
  const entered=latch(),release=latch(),finished=latch();
  const token='synthetic-local-fixture-not-host-auth',app=createPairCoachServer({port:0,rootPath:workspace,token,enableCoach:coach,enableExecution:false,runtimeEnvironment:{},runtimeArguments:['--runtime-config',path.join(root,'runtime.json')],
    coachProvider:{name:'NEVER_INVOKED_DIAGNOSTIC',mode:'INJECTED',async decide(){providerCalls++;throw Error('No provider call permitted');}},
    runtimeReadiness:{execution:{async readiness(_p:any,generation:string){
      readyCalls++;if(hold){mark('SAVE_READINESS_ENTER');entered.release();await release.promise;mark('SAVE_READINESS_RELEASE');}
      return {configurationGeneration:generation,modes:{RUN_MAIN:{canRun:true,problem:null},RUN_TESTS:{canRun:true,problem:null}}};
    }},probe:{async probe(){probeCalls++;return {canRun:true,problem:null};}}}});
  app.server.on('request',(req:any,res:any)=>{if(req.method==='PUT'&&req.url==='/api/project/settings'){
    mark('SERVER_PUT_ENTER');res.on('close',()=>mark('SERVER_RESPONSE_CLOSE',{writableFinished:res.writableFinished}));res.on('finish',()=>mark('SERVER_RESPONSE_FINISH',{status:res.statusCode}));
    // An already-aborted socket need not emit finish: observe the real respond/end attempt.
    const end=res.end.bind(res);res.end=(...args:any[])=>{mark('SERVER_RESPONSE_END_ATTEMPT',{status:res.statusCode,destroyed:res.destroyed});const value=end(...args);finished.release();return value;};
  }});
  const port=await app.listen(),base=`http://127.0.0.1:${port}`,calls:any[]=[];
  const original=app.workspace._publishSettingsReceipt.bind(app.workspace);
  app.workspace._publishSettingsReceipt=(receipt:any)=>{mark('DURABLE_COMMIT_BEFORE_PUBLISH',{workspaceVersion:receipt.workspaceVersion});return original(receipt);};
  let beforeSaveReturn:(()=>Promise<void>)|undefined;
  let socket!:WebSocket;
  const live=new LiveBackend({baseUrl:base,token,clientId:'fixture-original-tab',socket:(url:string)=>(socket=new WebSocket(url)) as any,
    fetch:async(input:any,init:any)=>{
      const isSave=new URL(String(input)).pathname==='/api/project/settings';
      if(isSave){const body=JSON.parse(init.body);calls.push(body);mark('CLIENT_SAVE_DISPATCH',{requestId:body.requestId});init.signal.addEventListener('abort',()=>mark('CLIENT_HTTP_ABORT'),{once:true});}
      try{const response=await fetch(input,init);if(isSave){mark('CLIENT_HTTP_HEADERS',{status:response.status});if(waitOwnVersion)await stateWhen(live,()=>live.getState().workspaceVersion===1);await beforeSaveReturn?.();}return response;}
      catch(e){if(isSave)mark('CLIENT_FETCH_REJECTED',{name:(e as Error).name});throw e;}
    }});
  await live.connect();await stateWhen(live,()=>live.getState().runtime?.project?.capabilities.execution.modes.RUN_MAIN.canRun===true);
  live.subscribe('state',()=>{const s=live.getState();if(s.workspaceVersion===1&&!events.some(x=>x.name==='CLIENT_OBSERVED_WS1'))mark('CLIENT_OBSERVED_WS1');});
  const journal=()=>fs.readdirSync(path.join(workspace,'.paircoach/runtime-mutations')).filter((n:string)=>n.endsWith('.json')).map((n:string)=>JSON.parse(fs.readFileSync(path.join(workspace,'.paircoach/runtime-mutations',n),'utf8')).body);
  const http=async(method:string,url:string,body:any)=>{const r=await fetch(base+url,{method,headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify(body)});return {status:r.status,body:await r.json() as any};};
  t.after(async()=>{release.release();live.close();await app.close();assert.equal(providerCalls,0);assert.equal(fs.readFileSync(path.join(workspace,'main.js'),'utf8'),'ORIGINAL\n');fs.rmSync(root,{recursive:true,force:true});});
  return {beforeSaveReturn:(callback:()=>Promise<void>)=>{beforeSaveReturn=callback;},app,live,socket,settings,calls,events,mark,entered,release,finished,journal,http,hold:()=>{hold=true;},counts:()=>({providerCalls,readyCalls,probeCalls}),save:()=>live.saveRuntimeSettings({...settings,aiConsent:true},0)};
}
test('CONTROL: fast real HTTP SAVE confirms once and clears only its own uncertainty',async t=>{
  const f=await fixture(t),result=await f.save();
  assert.equal(result.ok,true);assert.equal(f.calls.length,1);assert.equal(f.journal()[0].outcome.state,'COMMITTED');
  assert.equal(f.live.getState().runtime.reconciliationRequired,false);
  record('fast-control.json',{result,events:f.events,counts:f.counts()});
});
test('SAVE confirms the original HTTP while postcommit read-only readiness remains held beyond the unchanged 5s deadline',async t=>{
  const f=await fixture(t);f.hold();
  const result=await f.save();f.mark('CLIENT_SAVE_RETURN',{ok:result.ok});
  assert.equal(result.ok,true,'readiness must not abort original SAVE before staging');
  await f.entered.promise;
  const original=structuredClone(f.journal()[0]);
  assert.equal(original.outcome.state,'COMMITTED');assert.equal(original.outcome.result.workspaceVersion,1);
  assert.equal(original.outcome.result.capabilities.execution.runtime.problem.code,'RUNTIME_READINESS_PENDING');
  assert.equal(original.outcome.result.capabilities.execution.modes.RUN_MAIN.canRun,false);
  assert.equal(original.outcome.result.capabilities.execution.modes.RUN_TESTS.canRun,false);
  assert.equal(original.outcome.result.capabilities.execution.modes.RUN_TESTS.problem.code,'TASK_CONFIG_INVALID');
  assert.equal(f.live.getState().runtime.reconciliationRequired,false);
  // This bound exercises the real unchanged client deadline, not a mocked timer or budget bump.
  await delay(5200);f.mark('READINESS_HELD_OVER_5S');
  assert.equal(f.events.some(x=>x.name==='CLIENT_HTTP_ABORT'),false);assert.equal(f.calls.length,1);
  assert.equal(f.app.workspace.workspaceVersion,1);assert.deepEqual(f.journal()[0],original);
  f.release.release();await stateWhen(f.live,()=>f.live.getState().runtime.project.capabilities.execution.modes.RUN_MAIN.canRun===true);
  assert.deepEqual(f.journal()[0],original,'current readiness never rewrites immutable original receipt');
  const mutation={projectId:f.app.workspace.projectId,kind:'SAVE',request:f.calls[0]};
  const recovered=await f.http('POST','/api/runtime/mutation/reconcile',{mutation});
  assert.equal(recovered.status,200);assert.deepEqual(recovered.body.result,original.outcome.result);
  assert.equal(recovered.body.current.project.capabilities.execution.modes.RUN_MAIN.canRun,true);
  record('delayed-readiness.json',{result,events:f.events,counts:f.counts(),original});
});
test('own genuine WS version publication before original fast HTTP200 confirms exact SAVE, never a snapshot-only success',async t=>{
  const f=await fixture(t,true,true),result=await f.save();f.mark('CLIENT_SAVE_RETURN',{ok:result.ok});
  assert.equal(f.journal()[0].outcome.state,'COMMITTED');assert.equal(f.calls.length,1);
  assert.equal(result.ok,true);assert.equal(f.live.getState().runtime.reconciliationRequired,false);
  assert.ok(f.events.find(x=>x.name==='CLIENT_HTTP_HEADERS'&&x.status===200));
  assert.ok(f.events.find(x=>x.name==='CLIENT_OBSERVED_WS1'));assert.equal(f.events.some(x=>x.name==='CLIENT_HTTP_ABORT'),false);
  record('own-publication.json',{result,events:f.events,counts:f.counts()});
});
test('genuine postcommit Veto epoch before original HTTP200 remains fail-closed even after student control returns',async t=>{
  const f=await fixture(t,true,true);
  f.beforeSaveReturn(async()=>{
    const epoch=f.app.session.state.controlEpoch;
    const veto=await f.http('POST','/api/session/veto',{requestId:'negative-veto',clientId:'fixture-original-tab',
      sessionId:f.app.session.state.sessionId,controlEpoch:epoch,activeInterventionId:null,lastAppliedSeq:0});
    assert.equal(veto.status,200);await stateWhen(f.live,()=>f.live.getState().controlEpoch>epoch);
    assert.equal(f.app.session.state.writeOwner,'STUDENT');
  });
  const result=await f.save();assert.equal(result.ok,false);assert.equal(f.calls.length,1);
  assert.equal(f.journal()[0].outcome.state,'COMMITTED');assert.equal(f.live.getState().runtime.reconciliationRequired,true);
  record('postcommit-veto.json',{result,events:f.events,counts:f.counts()});
});
