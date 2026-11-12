/** Actual LiveBackend/RuntimeClient; controlled authenticated transport, NOT durable backend proof. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { LiveBackend } from '../../src/services/LiveBackend';
import { bundle, doc } from './fixtures';
import { run } from '../client-v2/fixtures';
import type { MutationIdentity } from '../../src/shared/runtime-mutation-v2';

async function fixture(t:any, command:(path:string,body:any)=>unknown|Promise<unknown>) {
  const b=bundle(),http:{path:string;body:any}[]=[];let seq=0;
  const socket:any={readyState:1,onopen:null,onmessage:null,onclose:null,onerror:null,send(){},close(){this.readyState=3;}};
  const live=new LiveBackend({token:'controlled-auth',clientId:'c1',socket:()=>socket,fetch:async(input,options)=>{
    const url=new URL(String(input)),body=options?.body?JSON.parse(String(options.body)):null;
    http.push({path:url.pathname,body});
    if(body)return Response.json(await command(url.pathname,body));
    return Response.json(url.pathname==='/api/project'?b.project:url.pathname==='/api/session'?b.session:url.pathname==='/api/snapshots'?[]:doc());
  }});t.after(()=>live.close());
  const enter=async(projectId=b.project.projectId,sessionId=b.session.sessionId)=>{
    b.project={...b.project,projectId,sessionId,capabilities:{...b.project.capabilities,language:{...b.project.capabilities.language,projectId}}};
    b.session={...b.session,projectId,sessionId};
    live.reconnect();socket.readyState=1;await live.connect();
    live.receive({protocolVersion:'3.0',messageId:`snapshot${++seq}`,sessionId,seq,type:'SESSION_SNAPSHOT',payload:b} as any);
    await setImmediate();assert.equal(live.getState().isOffline,false);
  };
  const originals=()=>[...(live as unknown as {runtimeMutations:Map<string,MutationIdentity>}).runtimeMutations.values()];
  await enter();return {live,b,http,enter,originals};
}
const completed=(body:any)=>({...run(),workspaceVersionAtStart:body.expectedWorkspaceVersion,status:'CANCELLED',finishedAt:'2026-11-11T22:00:00.000Z'});

test('eight definitively validated SAVE successes release their full originals immediately',async t=>{
  const f=await fixture(t,(_path,body)=>({...f.b.project,settings:body.settings,workspaceVersion:body.expectedWorkspaceVersion+1}));
  for(let i=0;i<8;i++){
    const next={...f.live.getState().projectSettings.runtimeSettings!,reviewNotesPath:`notes-${i}.md`};
    assert.equal((await f.live.saveRuntimeSettings(next,f.live.getState().workspaceVersion)).ok,true);
    assert.equal(f.live.getState().runtime?.reconciliationRequired,false);assert.deepEqual(f.originals(),[]);
  }
  assert.equal(f.http.filter(v=>v.path==='/api/project/settings').length,8);
});
test('eight definitively validated RUN successes release their full originals immediately',async t=>{
  const f=await fixture(t,(_path,body)=>completed(body));
  for(let i=0;i<8;i++){
    await f.live.run(true);assert.equal(f.live.getState().runtime?.run?.status,'CANCELLED');
    assert.equal(f.live.getState().runtime?.reconciliationRequired,false);assert.deepEqual(f.originals(),[]);
  }
  assert.equal(f.http.filter(v=>v.path==='/api/run').length,8);
});
for(const kind of ['SAVE','RUN'] as const){
  test(`${kind} full original remains while pending, releases only after validated acceptance`,async t=>{
    let resolve!:(v:unknown)=>void;const gate=new Promise(r=>resolve=r);
    const f=await fixture(t,()=>gate);
    const pending=kind==='SAVE'?f.live.saveRuntimeSettings(f.b.project.settings,1):f.live.run(true);
    await setImmediate();assert.equal(f.originals().length,1);assert.equal(f.originals()[0].kind,kind);
    assert.equal(f.live.getState().runtime?.pending,kind);
    const body=f.originals()[0].request;
    resolve(kind==='SAVE'?{...f.b.project,settings:f.b.project.settings,workspaceVersion:2}:completed(body));
    await pending;assert.equal(f.live.getState().runtime?.reconciliationRequired,false);assert.deepEqual(f.originals(),[]);
  });
  for(const failure of ['unreadable','malformed','stale session'] as const){
    test(`${kind} ${failure} response retains immutable original and fence across new-session snapshot`,async t=>{
      let resolve!:(v:unknown)=>void;const gate=new Promise(r=>resolve=r);
      const f=await fixture(t,async()=>{if(failure==='unreadable')throw Error('lost response');return gate;});
      const next={...f.b.project.settings,contextPatterns:['original/**']};
      const pending=kind==='SAVE'?f.live.saveRuntimeSettings(next,1):f.live.run(true);
      await setImmediate();const original=structuredClone(f.originals());assert.equal(original.length,1);
      next.contextPatterns.push('caller-edited/**');
      if(failure==='stale session')await f.enter('p1','s2');
      resolve(failure==='malformed'?{ok:true}:kind==='SAVE'?{...f.b.project,sessionId:'s1',settings:(original[0].request as any).settings,workspaceVersion:2}:completed(original[0].request));
      await pending;assert.deepEqual(f.originals(),original);assert.equal(f.live.getState().runtime?.reconciliationRequired,true);
      await f.enter('p1','s3');assert.deepEqual(f.originals(),original);assert.equal(f.live.getState().runtime?.reconciliationRequired,true);
      const count=f.http.filter(v=>v.body).length;await f.live.run(true);assert.equal((await f.live.saveRuntimeSettings(f.b.project.settings,1)).ok,false);
      assert.equal(f.http.filter(v=>v.body).length,count,'no retry or new mutation bypass');
    });
  }
}
for(const kind of ['SAVE','RUN'] as const){
  test(`confirmed foreign-project ${kind} releases only its own payload, never old-session UNKNOWN`,async t=>{
    let definitive=false;
    const f=await fixture(t,(path,body)=>{
      if(path==='/api/runtime/mutation/reconcile')return definitive?{mutation:body.mutation,state:'DEFINITIVELY_ABORTED',result:null,current:{project:f.b.project,run:null}}:{mutation:body.mutation,state:'UNKNOWN',result:null,current:null};
      if(f.b.project.projectId==='p1')throw Error('unknown original');
      return path==='/api/run'?completed(body):{...f.b.project,settings:body.settings,workspaceVersion:body.expectedWorkspaceVersion+1};
    });
    await f.live.saveRuntimeSettings(f.b.project.settings,1);const original=structuredClone(f.originals());assert.equal(original.length,1);
    await f.enter('p2','foreign-session');assert.equal(f.live.getState().runtime?.reconciliationRequired,false);
    if(kind==='RUN')await f.live.run(true);else assert.equal((await f.live.saveRuntimeSettings(f.b.project.settings,1)).ok,true);
    assert.equal(f.live.getState().runtime?.reconciliationRequired,false);assert.deepEqual(f.originals(),original,'success must not clear foreign-project unknown');
    await f.enter('p1','s2');assert.equal(f.live.getState().runtime?.reconciliationRequired,true);
    assert.equal(await f.live.reconcileRuntimeMutation(),false);assert.deepEqual(f.originals(),original);
    definitive=true;assert.equal(await f.live.reconcileRuntimeMutation(),true);assert.deepEqual(f.originals(),[]);assert.equal(f.live.getState().runtime?.reconciliationRequired,false);
    const reads=f.http.filter(v=>v.path==='/api/runtime/mutation/reconcile');assert.deepEqual(reads.map(v=>v.body.mutation),[original[0],original[0]]);
  });
}

// LOCAL notification fault/reentrancy control, not a server-outcome attestation API.
import { RuntimeClientV2, type RuntimeAuthorityV2, type RuntimeUnconfirmedMutationV2 } from '../../src/services/RuntimeClientV2';
import { project } from '../client-v2/fixtures';
test('cleanup callback receives detached frozen exact metadata, cannot throw success into UNKNOWN or bypass singleflight',async()=>{
 const a:RuntimeAuthorityV2={projectId:'p1',sessionId:'s1',clientId:'c1',connectionGeneration:'conn',workspaceVersion:1,configurationGeneration:'cfg1',connected:true,canExecute:true,canSaveSettings:true};
 const confirmed:RuntimeUnconfirmedMutationV2[]=[],reentrant:Promise<boolean>[]=[],frozen:boolean[]=[],mutationRejected:boolean[]=[];let calls=0,id=0;
 const client=new RuntimeClientV2({current:()=>a,requestId:()=>`req${++id}`,confirmedMutation:m=>{
   frozen.push(Object.isFrozen(m));confirmed.push(structuredClone(m));
   try {(m as RuntimeUnconfirmedMutationV2).requestId='forged';mutationRejected.push(false);}catch{mutationRejected.push(true);}
   reentrant.push(client.run('RUN_TESTS'));throw Error('cleanup failure must not recategorize confirmed operation');
 },http:{run:async body=>{calls++;return completed(body);},stop:async()=>null,saveSettings:async body=>{calls++;return {...project(),settings:body.settings,workspaceVersion:2};}}});
 assert.equal(client.applyProject(project()),true);assert.equal(await client.run('RUN_TESTS'),true);
 assert.equal((await client.saveSettings(project().settings,1)).ok,true);assert.deepEqual(await Promise.all(reentrant),[false,false]);
 assert.deepEqual(frozen,[true,true]);assert.deepEqual(mutationRejected,[true,true]);assert.equal(calls,2);assert.deepEqual(confirmed,[{kind:'RUN',requestId:'req1',projectId:'p1',sessionId:'s1',clientId:'c1',expectedWorkspaceVersion:1},{kind:'SAVE',requestId:'req2',projectId:'p1',sessionId:'s1',clientId:'c1',expectedWorkspaceVersion:1}]);
 assert.equal(client.snapshot().reconciliationRequired,false);assert.deepEqual(client.retainedMutations(),[]);client.dispose();
});
