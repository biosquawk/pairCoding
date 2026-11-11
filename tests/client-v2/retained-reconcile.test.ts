/** UNIT local client contract; callback doubles are NOT durable authenticated backend settlement. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { RuntimeClientV2, type RuntimeAuthorityV2, type RuntimeUnconfirmedMutationV2 } from '../../src/services/RuntimeClientV2';
import { project, run, settings } from './fixtures';
function fixture() {
  const a:RuntimeAuthorityV2={projectId:'p1',sessionId:'s1',clientId:'c1',connectionGeneration:'conn1',workspaceVersion:1,configurationGeneration:'cfg1',connected:true,canExecute:true,canSaveSettings:true};
  let n=0;const calls:string[]=[];const f={failure:true,gate:null as Promise<unknown>|null};
  const client=new RuntimeClientV2({current:()=>a,requestId:()=>`request${++n}`,http:{
    run:async()=>{calls.push('RUN');if(f.gate)return f.gate;if(f.failure)throw Error('lost run');return run();},
    saveSettings:async()=>{calls.push('SAVE');throw Error('lost save');},
    stop:async()=>{calls.push('STOP');return {...run(),status:'CANCELLED',finishedAt:'2026-11-11T22:00:00.000Z'};},
  }});
  const current=()=>{const p=project();return {...p,projectId:a.projectId,sessionId:a.sessionId,capabilities:{...p.capabilities,language:{...p.capabilities.language,projectId:a.projectId}}};};
  const enter=(changes:Partial<RuntimeAuthorityV2>={},activeRun:unknown=null)=>{client.invalidate();Object.assign(a,changes);assert.equal(client.applyProject(current(),activeRun),true);};
  enter();return {a,client,calls,f,current,enter};
}
test('retained SAME project/client fences new-session Run and Save; generic reconcile remains current-session only',async()=>{
  const f=fixture();await f.client.run('RUN_TESTS');f.enter({sessionId:'s2'});
  assert.equal(f.client.snapshot().reconciliationRequired,true);
  assert.equal(await f.client.run('RUN_TESTS'),false);assert.equal((await f.client.saveSettings(settings(),1)).ok,false);assert.deepEqual(f.calls,['RUN']);
  let reads=0;assert.equal(await f.client.reconcile(async()=>{reads++;return {project:f.current(),run:null};}),false);assert.equal(reads,0);
  const [selected]=f.client.retainedMutations();assert.equal(selected.sessionId,'s1');
  assert.equal(await f.client.reconcileRetained(selected,async(original,signal)=>{reads++;assert.deepEqual(original,selected);assert.equal(signal.aborted,false);assert.equal(original.sessionId,'s1');assert.equal(f.a.sessionId,'s2');return {project:f.current(),run:null};}),true);
  assert.equal(reads,1);assert.equal(f.client.snapshot().reconciliationRequired,false);assert.deepEqual(f.client.retainedMutations(),[]);
  f.f.failure=false;assert.equal(await f.client.run('RUN_TESTS'),true);assert.deepEqual(f.calls,['RUN','RUN']);
});
test('known Stop is preserved while old-session unknown fences only NEW mutations',async()=>{
  const f=fixture();await f.client.run('RUN_TESTS');f.enter({sessionId:'s2'},run());
  assert.equal(await f.client.stop(),true);assert.equal(f.client.snapshot().run?.status,'CANCELLED');assert.equal(f.client.snapshot().reconciliationRequired,true);assert.deepEqual(f.calls,['RUN','STOP']);
});
test('explicit selection must exactly match immutable retained metadata, same project AND client',async()=>{
  const f=fixture();await f.client.run('RUN_TESTS');const [original]=f.client.retainedMutations();f.enter({sessionId:'s2'});
  let reads=0;
  for(const change of [{projectId:'foreign'},{clientId:'foreign'},{sessionId:'foreign'},{requestId:'forged'},{kind:'SAVE'},{expectedWorkspaceVersion:99},{extra:true}]){
    assert.equal(await f.client.reconcileRetained({...original,...change} as RuntimeUnconfirmedMutationV2,async()=>{reads++;return {project:f.current(),run:null};}),false);
  }
  (original as RuntimeUnconfirmedMutationV2).requestId='mutated-copy';assert.notEqual(f.client.retainedMutations()[0].requestId,original.requestId);assert.equal(reads,0);assert.equal(f.client.snapshot().reconciliationRequired,true);
});
test('in-flight original must drain, even after invalidate/new session; no read or overwrite',async()=>{
  const f=fixture();let resolve!:(v:unknown)=>void;f.f.gate=new Promise(r=>resolve=r);const pending=f.client.run('RUN_TESTS');
  const selected:RuntimeUnconfirmedMutationV2={projectId:'p1',sessionId:'s1',clientId:'c1',kind:'RUN',requestId:'request1',expectedWorkspaceVersion:1};f.enter({sessionId:'s2'});
  let reads=0;assert.deepEqual(f.client.retainedMutations(),[]);assert.equal(await f.client.reconcileRetained(selected,async()=>{reads++;return {project:f.current(),run:null};}),false);
  assert.equal(await f.client.run('RUN_TESTS'),false);resolve(run());assert.equal(await pending,false);assert.equal(reads,0);assert.deepEqual(f.client.retainedMutations(),[selected]);
});
for(const change of ['connection','session','project','client','snapshot','invalidate','offline'] as const){
  test(`late retained settlement after ${change} cannot clear original; fresh explicit read required`,async()=>{
    const f=fixture();await f.client.run('RUN_TESTS');const [selected]=f.client.retainedMutations();f.enter({sessionId:'s2'});
    let resolve!:(v:{project:unknown;run:unknown})=>void;const gate=new Promise<{project:unknown;run:unknown}>(r=>resolve=r);
    const reading=f.client.reconcileRetained(selected,async()=>gate);
    if(change==='snapshot')f.client.applyProject(f.current());else if(change==='invalidate')f.client.invalidate();else if(change==='offline')f.a.connected=false;
    else f.a[({connection:'connectionGeneration',session:'sessionId',project:'projectId',client:'clientId'} as const)[change]]='new';
    resolve({project:f.current(),run:null});assert.equal(await reading,false);
    f.enter({projectId:'p1',sessionId:'s2',clientId:'c1',connectionGeneration:'fresh',connected:true});
    assert.equal(f.client.snapshot().reconciliationRequired,true);assert.equal(await f.client.reconcileRetained(selected,async()=>({project:f.current(),run:null})),true);
  });
}
test('malformed/stale-current/throw cannot settle; selected entry only is removed, foreign project ownership retained',async()=>{
  const f=fixture();await f.client.run('RUN_TESTS');const [selected]=f.client.retainedMutations();
  f.enter({projectId:'p2',sessionId:'s2'});await f.client.run('RUN_TESTS');f.enter({projectId:'p1',sessionId:'s3'});
  for(const read of [async()=>{throw Error('unknown');},async()=>({project:project(),run:null}),async()=>({project:f.current(),run:{...run(),profileId:'foreign'}})]){
    assert.equal(await f.client.reconcileRetained(selected,read),false);assert.equal(f.client.snapshot().reconciliationRequired,true);
  }
  assert.equal(await f.client.reconcileRetained(selected,async()=>({project:f.current(),run:null})),true);f.enter({projectId:'p2',sessionId:'s4'});assert.equal(f.client.snapshot().reconciliationRequired,true);assert.equal(f.client.retainedMutations()[0].sessionId,'s2');
});
test('different client in same project/session cannot overwrite old client entry or settle it',async()=>{
  const f=fixture();await f.client.run('RUN_TESTS');const [c1]=f.client.retainedMutations();f.enter({clientId:'c2'});await f.client.run('RUN_TESTS');
  let reads=0;assert.equal(await f.client.reconcileRetained(c1,async()=>{reads++;return {project:f.current(),run:null};}),false);assert.equal(reads,0);
  const [c2]=f.client.retainedMutations();assert.equal(c2.clientId,'c2');f.enter({clientId:'c1',sessionId:'s2'});assert.equal(f.client.retainedMutations()[0].requestId,c1.requestId);
  assert.equal(await f.client.reconcileRetained(c1,async()=>({project:f.current(),run:null})),true);f.enter({clientId:'c2'});assert.equal(f.client.retainedMutations()[0].requestId,c2.requestId);
});
