/** Local currentness controls supplement (not replace) the real HTTP/WS regression. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { RuntimeClientV2, type RuntimeAuthorityV2 } from '../../src/services/RuntimeClientV2';
import { project, run } from '../client-v2/fixtures';
function fixture() {
  const before=project(),settings={...structuredClone(before.settings),aiConsent:true};
  const response={...structuredClone(before),settings,workspaceVersion:before.workspaceVersion+1};
  let a:RuntimeAuthorityV2={projectId:before.projectId,sessionId:before.sessionId,clientId:'tab',connectionGeneration:'conn',workspaceVersion:before.workspaceVersion,
    configurationGeneration:'cfg1',controlEpoch:4,connected:true,canExecute:true,canSaveSettings:true};
  let resolve!:(value:unknown)=>void,reject!:(error:Error)=>void,signal!:AbortSignal,calls=0;const confirmed:unknown[]=[];
  const gate=new Promise<unknown>((yes,no)=>{resolve=yes;reject=no;});
  const client=new RuntimeClientV2({current:()=>a,requestId:()=> 'original-save',confirmedMutation:m=>confirmed.push(m),http:{
    saveSettings:async(body,s)=>{calls++;signal=s;assert.deepEqual(body.settings,settings);return gate;},run:async()=>{throw Error('no Run');},stop:async()=>{throw Error('no Stop');}}});
  assert.equal(client.applyProject(before),true);
  return {client,before,settings,response,resolve,reject,confirmed,get signal(){return signal;},get calls(){return calls;},get a(){return a;},set a(v:RuntimeAuthorityV2){a=v;},
    save:()=>client.saveSettings(settings,before.workspaceVersion)};
}
test('original exact HTTP is required even after a matching postcommit project; measured readiness is not rolled back',async()=>{
  const f=fixture(),pending=f.save();f.a.workspaceVersion++;
  const measured=structuredClone(f.response);measured.capabilities.execution.runtime.label='newly measured';
  assert.equal(f.client.applyProject(measured),true);
  assert.equal(f.client.snapshot().pending,'SAVE');assert.equal(f.client.snapshot().reconciliationRequired,true);assert.equal(f.confirmed.length,0);
  assert.equal((await f.save()).ok,false);assert.equal(f.calls,1);
  f.resolve(f.response);const result=await pending;assert.equal(result.ok,true);
  assert.deepEqual(f.client.snapshot().project,measured);assert.equal(f.client.snapshot().reconciliationRequired,false);
  assert.deepEqual(f.confirmed,[{kind:'SAVE',requestId:'original-save',projectId:'p1',sessionId:'s1',clientId:'tab',expectedWorkspaceVersion:1}]);
});
test('version-only own SESSION_STATE publication confirms through original exact HTTP, not from the event',async()=>{
  const f=fixture(),pending=f.save();f.a.workspaceVersion++;assert.equal(f.client.snapshot().reconciliationRequired,true);
  f.resolve(f.response);assert.equal((await pending).ok,true);assert.equal(f.confirmed.length,1);
});
for(const [name,change] of Object.entries({
  project:(a:RuntimeAuthorityV2):unknown=>a.projectId='foreign',session:(a:RuntimeAuthorityV2):unknown=>a.sessionId='new',client:(a:RuntimeAuthorityV2):unknown=>a.clientId='foreign',
  reconnect:(a:RuntimeAuthorityV2):unknown=>a.connectionGeneration='new',configuration:(a:RuntimeAuthorityV2):unknown=>a.configurationGeneration='new',
  vetoEpoch:(a:RuntimeAuthorityV2):unknown=>a.controlEpoch!++,offline:(a:RuntimeAuthorityV2):unknown=>a.connected=false,ownerOrVeto:(a:RuntimeAuthorityV2):unknown=>a.canSaveSettings=false,executionPermission:(a:RuntimeAuthorityV2):unknown=>a.canExecute=false,
  laterVersion:(a:RuntimeAuthorityV2):unknown=>a.workspaceVersion+=2,olderVersion:(a:RuntimeAuthorityV2):unknown=>a.workspaceVersion--,
}))test(`own SAVE exception rejects changed authority: ${name}`,async()=>{
  const f=fixture(),pending=f.save();change(f.a);f.resolve(f.response);assert.equal((await pending).ok,false);assert.equal(f.confirmed.length,0);
  assert.deepEqual(f.client.snapshot().project,f.before);
  // An unrelated current scope cannot see the old scope's fence, but the exact original remains retained.
  f.a={...f.a,projectId:'p1',sessionId:'s1',clientId:'tab'};assert.equal(f.client.snapshot().reconciliationRequired,true);
});
for(const [name,change] of Object.entries({
  wrongProject:(p:any):unknown=>p.projectId='foreign',wrongSession:(p:any):unknown=>p.sessionId='new',stale:(p:any):unknown=>p.workspaceVersion--,newer:(p:any):unknown=>p.workspaceVersion++,
  wrongSettings:(p:any):unknown=>p.settings.aiConsent=false,wrongConfig:(p:any):unknown=>{p.capabilities.execution.runtime.configurationGeneration='new';p.capabilities.language.configurationGeneration='new';return undefined;},
  wrongRoot:(p:any):unknown=>p.rootPath='/foreign',foreignFile:(p:any):unknown=>p.files=[{path:'foreign.txt',kind:'FILE',version:1}],
  wrongProfile:(p:any):unknown=>{p.capabilities.execution.runtime.profileId='other';p.capabilities.language.profileId='other';return undefined;},
  wrongProvider:(p:any):unknown=>p.capabilities.language.providerGeneration='other',
}))test(`own +1 SAVE rejects stale/foreign original HTTP: ${name}`,async()=>{
  const f=fixture(),pending=f.save();f.a.workspaceVersion++;const bad=structuredClone(f.response);change(bad);f.resolve(bad);
  assert.equal((await pending).ok,false);assert.equal(f.confirmed.length,0);assert.equal(f.client.snapshot().reconciliationRequired,true);
});
test('an intervening foreign observation poisons SAVE; later matching publication cannot heal it',async()=>{
  const f=fixture(),pending=f.save();f.a.workspaceVersion++;
  const foreign=structuredClone(f.response);foreign.settings.aiConsent=false;
  assert.equal(f.client.applyProject(foreign),true);assert.equal(f.client.applyProject(f.response),true);
  f.resolve(f.response);assert.equal((await pending).ok,false);assert.equal(f.confirmed.length,0);assert.equal(f.client.snapshot().reconciliationRequired,true);
});
test('intervening new Run remains authoritative; late SAVE cannot erase it',async()=>{
  const f=fixture(),pending=f.save();f.a.workspaceVersion++;assert.equal(f.client.applyProject(f.response,run()),true);
  f.resolve(f.response);assert.equal((await pending).ok,false);assert.equal(f.client.snapshot().run?.runId,'run1');assert.equal(f.confirmed.length,0);
});
test('invalidate cancels the exact in-flight signal; a late matching HTTP cannot replace the new binding or clear UNKNOWN',async()=>{
  const f=fixture(),pending=f.save();f.client.invalidate();assert.equal(f.signal.aborted,true);
  f.a={...f.a,workspaceVersion:2,connectionGeneration:'new'};assert.equal(f.client.applyProject(f.response),true);
  f.resolve(f.response);assert.equal((await pending).ok,false);assert.equal(f.confirmed.length,0);assert.equal(f.client.snapshot().reconciliationRequired,true);
});
test('matching snapshot then rejected original HTTP retains UNKNOWN, never retries automatically',async()=>{
  const f=fixture(),pending=f.save();f.a.workspaceVersion++;assert.equal(f.client.applyProject(f.response),true);f.reject(Error('transport lost'));
  assert.equal((await pending).ok,false);assert.equal(f.client.snapshot().reconciliationRequired,true);assert.equal(f.confirmed.length,0);
  assert.equal((await f.save()).ok,false);assert.equal(f.calls,1);
});
test('caller without control epoch retains original strict currentness; +1 alone cannot grant the exception',async()=>{
  const f=fixture();delete f.a.controlEpoch;const pending=f.save();f.a.workspaceVersion++;f.resolve(f.response);
  assert.equal((await pending).ok,false);assert.equal(f.confirmed.length,0);assert.equal(f.client.snapshot().reconciliationRequired,true);
});
