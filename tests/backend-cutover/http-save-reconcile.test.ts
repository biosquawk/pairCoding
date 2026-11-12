import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createPairCoachServer } from '../../src/server/http';
import { validateMutationOutcomeV2, validateV2WireShape } from '../../src/shared/validation-v2';
import type { SettingsV2 } from '../../src/shared/runtime-v2';
const settings:SettingsV2={schemaVersion:2,taskFilePath:null,taskMode:'IMPLEMENTATION',reviewNotesPath:'review.md',runProfiles:[],aiConsent:false,contextPatterns:[]};
function fixture(t:TestContext) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'http-save-reconcile-')),project=path.join(root,'project'),other=path.join(root,'other');
  for(const dir of [project,other]){fs.mkdirSync(dir);fs.writeFileSync(path.join(dir,'source.js'),'ORIGINAL\r\n');}
  const token='http-save-local-only-token', apps:ReturnType<typeof createPairCoachServer>[]=[];
  const app=()=>{const a=createPairCoachServer({rootPath:project,token,port:0,runtimeEnvironment:{},runtimeArguments:['--runtime-config',path.join(root,'missing.json')]});apps.push(a);return a;};
  const http=async(port:number,method:string,url:string,body?:unknown,headers:Record<string,string>={})=>{
    const r=await fetch(`http://127.0.0.1:${port}${url}`,{method,headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json',...headers},body:body===undefined?undefined:JSON.stringify(body)});
    return {status:r.status,body:await r.json()};
  };
  const bind=async(port:number,clientId='tab')=>{const r=await http(port,'POST','/api/project/open',{requestId:randomUUID(),clientId,rootPath:project,settings});assert.equal(r.status,201,JSON.stringify(r));return r.body;};
  t.after(async()=>{for(const a of apps)await a.close();fs.rmSync(root,{recursive:true,force:true});});
  return {root,project,other,token,app,http,bind};
}
const request=(project:any,settings:SettingsV2,clientId='tab')=>({requestId:randomUUID(),clientId,sessionId:project.sessionId,expectedWorkspaceVersion:project.workspaceVersion,settings});
const mutation=(project:any,r:any)=>({mutation:{projectId:project.projectId,kind:'SAVE',request:r}});

test('actual HTTP explicit SAVE commits original Project once, applies neutral policy at authority, and reconciles original separately from current',async t=>{
  const f=fixture(t),a=f.app(),port=await a.listen(),p=await f.bind(port),r=request(p,settings);
  const originalPublish=a.workspace._publishSettingsReceipt.bind(a.workspace);let seenConsent:boolean|undefined;
  a.workspace._publishSettingsReceipt=(receipt)=>{seenConsent=a.workspace.settings.aiConsent;return originalPublish(receipt);};
  const saved=await f.http(port,'PUT','/api/project/settings',r);assert.equal(saved.status,200,JSON.stringify(saved));assert.ok(validateV2WireShape('Project',saved.body));
  assert.equal(saved.body.workspaceVersion,1);assert.equal(saved.body.capabilities.language.state,'OFF');assert.equal(seenConsent,false);
  assert.equal(saved.body.capabilities.execution.runtime.problem.code,'RUNTIME_CONFIG_INVALID');
  const second=request(saved.body,{...settings,aiConsent:true,taskMode:'CODE_REVIEW'}),next=await f.http(port,'PUT','/api/project/settings',second);
  assert.equal(next.status,200,JSON.stringify(next));assert.equal(seenConsent,true);assert.equal(a.workspace.settings.aiConsent,true);assert.deepEqual(a.workspace.settings.runProfiles,[]);
  const replay=await f.http(port,'PUT','/api/project/settings',r);assert.equal(replay.status,200);assert.deepEqual(replay.body,saved.body);assert.equal(a.workspace.workspaceVersion,2);
  const result=await f.http(port,'POST','/api/runtime/mutation/reconcile',mutation(p,r));assert.equal(result.status,200,JSON.stringify(result));assert.ok(validateMutationOutcomeV2(result.body));
  assert.equal(result.body.state,'COMMITTED');assert.ok(result.body.current);assert.deepEqual(result.body.result,saved.body);assert.deepEqual(result.body.current.project,next.body);assert.equal(result.body.current.run,null);
  const collision=await f.http(port,'PUT','/api/project/settings',{...r,settings:{...settings,aiConsent:true}});assert.equal(collision.status,409);assert.equal(collision.body.code,'IDEMPOTENCY_CONFLICT');
  assert.equal(fs.readFileSync(path.join(f.project,'source.js'),'utf8'),'ORIGINAL\r\n');
});
test('actual HTTP absent durable tombstone fences delayed original, including restart; old-session reconciliation needs retained client linkage',async t=>{
  const f=fixture(t),a=f.app(),port=await a.listen(),p=await f.bind(port),r=request(p,settings);
  const absent=await f.http(port,'POST','/api/runtime/mutation/reconcile',mutation(p,r));assert.equal(absent.status,200);assert.equal(absent.body.state,'DEFINITIVELY_ABORTED');
  assert.equal((await f.http(port,'PUT','/api/project/settings',r)).body.code,'MUTATION_DEFINITIVELY_ABORTED');assert.equal(fs.existsSync(path.join(f.project,'.paircoach','settings.json')),false);
  await a.close();const b=f.app(),newPort=await b.listen(),current=await f.bind(newPort);assert.notEqual(current.sessionId,p.sessionId);
  const old=await f.http(newPort,'POST','/api/runtime/mutation/reconcile',mutation(p,r));assert.equal(old.status,200);assert.equal(old.body.state,'DEFINITIVELY_ABORTED');assert.equal(old.body.current.project.sessionId,current.sessionId);
  const invented=await f.http(newPort,'POST','/api/runtime/mutation/reconcile',mutation(p,{...r,sessionId:'never-authenticated'}));assert.equal(invented.status,403);
  const foreign=await f.http(newPort,'POST','/api/runtime/mutation/reconcile',{mutation:{...mutation(p,r).mutation,projectId:'foreign'}});assert.equal(foreign.status,403);
  const forgedClient=await f.http(newPort,'POST','/api/runtime/mutation/reconcile',mutation(p,{...r,clientId:'other-tab'}));assert.equal(forgedClient.status,403);assert.equal(forgedClient.body.code,'LEASE_REQUIRED');
});
test('actual HTTP live admitted SAVE remains UNKNOWN/current:null during SAME gate exclusion; Veto proves abort, never a late write',async t=>{
  const f=fixture(t),a=f.app(),port=await a.listen(),p=await f.bind(port),r=request(p,settings);
  let release!:()=>void,entered!:()=>void;const holding=new Promise<void>(r=>{entered=r;}),finish=new Promise<void>(r=>{release=r;});
  const held=a.gate._withLanguageSourceLease({clientId:'tab',sessionId:p.sessionId,controlEpoch:a.session.state.controlEpoch,actor:'STUDENT',expectedWorkspaceVersion:0},()=>{},async()=>{entered();await finish;}).catch(e=>e);await holding;
  const save=f.http(port,'PUT','/api/project/settings',r);
  // Wait on actual durable admission, not a guessed timeout or artificial journal record.
  const journal=path.join(f.project,'.paircoach','runtime-mutations');
  for(let i=0;!fs.readdirSync(journal).some(n=>n.endsWith('.json'));i++){assert.ok(i<200,'actual admission did not arrive');await new Promise(r=>setTimeout(r,5));}
  const pending=await f.http(port,'POST','/api/runtime/mutation/reconcile',mutation(p,r));assert.equal(pending.status,200,JSON.stringify(pending));assert.equal(pending.body.state,'UNKNOWN');assert.equal(pending.body.current,null);
  const veto=await f.http(port,'POST','/api/session/veto',{requestId:randomUUID(),clientId:'tab',sessionId:p.sessionId,controlEpoch:a.session.state.controlEpoch,activeInterventionId:null,lastAppliedSeq:0});assert.equal(veto.status,200);
  release();await held;
  const lost=await save;assert.equal(lost.status,503);assert.equal(lost.body.code,'MUTATION_OUTCOME_UNKNOWN');
  const final=await f.http(port,'POST','/api/runtime/mutation/reconcile',mutation(p,r));assert.equal(final.status,200,JSON.stringify(final));assert.equal(final.body.state,'DEFINITIVELY_ABORTED');
  assert.equal(fs.existsSync(path.join(f.project,'.paircoach','settings.json')),false);assert.equal(a.workspace.workspaceVersion,0);
});
test('actual HTTP source failure is recovered as abort without replacing malformed original; auth and strict reconcile schema remain enforced',async t=>{
  const f=fixture(t);fs.mkdirSync(path.join(f.project,'.paircoach'));fs.writeFileSync(path.join(f.project,'.paircoach','settings.json'),'{BROKEN\r\n');
  const a=f.app(),port=await a.listen(),p=await f.bind(port),r=request(p,settings);
  const save=await f.http(port,'PUT','/api/project/settings',r);assert.equal(save.status,503);
  const result=await f.http(port,'POST','/api/runtime/mutation/reconcile',mutation(p,r));assert.equal(result.status,200);assert.equal(result.body.state,'DEFINITIVELY_ABORTED');assert.equal(a.workspace.workspaceVersion,0);
  assert.equal(fs.readFileSync(path.join(f.project,'.paircoach','settings.json'),'utf8'),'{BROKEN\r\n');
  assert.equal((await f.http(port,'POST','/api/runtime/mutation/reconcile',mutation(p,r),{Authorization:'Bearer bad'})).status,401);
  assert.equal((await f.http(port,'POST','/api/runtime/mutation/reconcile',mutation(p,r),{Origin:'https://foreign.invalid'})).status,403);
  assert.equal((await f.http(port,'POST','/api/runtime/mutation/reconcile',{...mutation(p,r),requestId:'not-part-of-contract'})).status,400);
});
test('actual HTTP authority COMMITTED→SIGKILL before response recovers original Project in new session without effect replay/current-state inference',async t=>{
  const f=fixture(t),receipt=path.join(f.root,'original-request.json');
  const child=spawn(process.execPath,['--import','tsx',fileURLToPath(new URL('./http-save-child.ts',import.meta.url)),f.project,receipt],{env:{...process.env,TSX_DISABLE_CACHE:'1'},stdio:['ignore','pipe','pipe']});
  let output='';child.stdout.on('data',b=>output+=b);child.stderr.on('data',b=>output+=b);
  const exit=await new Promise<{code:number|null;signal:string|null}>((resolve,reject)=>{const timer=setTimeout(()=>{child.kill('SIGKILL');reject(Error('actual HTTP commit boundary not reached '+output));},10000);child.once('error',reject);child.once('exit',(code,signal)=>{clearTimeout(timer);resolve({code,signal});});});
  assert.equal(exit.signal,'SIGKILL',output);const original=JSON.parse(fs.readFileSync(receipt,'utf8'));
  const a=f.app(),port=await a.listen(),p=await f.bind(port);assert.notEqual(p.sessionId,original.mutation.request.sessionId);assert.equal(p.workspaceVersion,1);
  const result=await f.http(port,'POST','/api/runtime/mutation/reconcile',original);assert.equal(result.status,200,JSON.stringify(result));assert.ok(validateMutationOutcomeV2(result.body));assert.equal(result.body.state,'COMMITTED');
  assert.ok(result.body.result && 'settings' in result.body.result);assert.equal(result.body.result.sessionId,original.mutation.request.sessionId);assert.deepEqual(result.body.result.settings,original.mutation.request.settings);assert.equal(result.body.result.workspaceVersion,1);
  assert.equal(result.body.current.project.sessionId,p.sessionId);assert.equal(a.workspace.workspaceVersion,1);assert.equal(a.workspace.settings.aiConsent,true);
  assert.deepEqual((await f.http(port,'POST','/api/runtime/mutation/reconcile',original)).body,result.body);
});
test('actual project replacement drains old SAVE and retains its unknown reservation without applying old settings to either binding',async t=>{
  const f=fixture(t),a=f.app(),port=await a.listen(),p=await f.bind(port),r=request(p,{...settings,aiConsent:true});
  let release!:()=>void,entered!:()=>void;const holding=new Promise<void>(r=>{entered=r;}),finish=new Promise<void>(r=>{release=r;});
  const held=a.gate._withLanguageSourceLease({clientId:'tab',sessionId:p.sessionId,controlEpoch:a.session.state.controlEpoch,actor:'STUDENT',expectedWorkspaceVersion:0},()=>{},async()=>{entered();await finish;}).catch(e=>e);await holding;
  const save=f.http(port,'PUT','/api/project/settings',r),journal=path.join(f.project,'.paircoach','runtime-mutations');
  for(let i=0;!fs.readdirSync(journal).some(n=>n.endsWith('.json'));i++){assert.ok(i<200);await new Promise(r=>setTimeout(r,5));}
  const open=f.http(port,'POST','/api/project/open',{requestId:randomUUID(),clientId:'tab',rootPath:f.other,settings});
  for(let i=0;!fs.existsSync(path.join(f.other,'.paircoach','runtime-clients'));i++){assert.ok(i<200);await new Promise(r=>setTimeout(r,5));}
  release();await held;assert.equal((await save).status,503);const next=await open;assert.equal(next.status,201,JSON.stringify(next));
  assert.equal(a.workspace.rootPath,f.other);assert.equal(a.workspace.settings.aiConsent,false);assert.equal(fs.existsSync(path.join(f.project,'.paircoach','settings.json')),false);
  const wrong=await f.http(port,'POST','/api/runtime/mutation/reconcile',mutation(p,r));assert.equal(wrong.status,403);
  await f.bind(port);const reconciled=await f.http(port,'POST','/api/runtime/mutation/reconcile',mutation(p,r));assert.equal(reconciled.status,200);assert.equal(reconciled.body.state,'DEFINITIVELY_ABORTED');
  assert.equal(a.workspace.settings.aiConsent,false);assert.equal(a.workspace.workspaceVersion,0);
});
