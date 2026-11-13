import test from 'node:test';
import assert from 'node:assert/strict';
import { RuntimeClientV2, type RuntimeAuthorityV2 } from '../../src/services/RuntimeClientV2';
import type { RunKind, RunV2 } from '../../src/shared/runtime-v2';
import { project, run } from './fixtures';

const problem = { code:'PREPARE_REQUIRED', message:'Tests probe pending', recovery:'Prepare explicitly', retryable:true };
function fixture(mode: RunKind) {
  const p=project();
  p.settings.runProfiles.unshift({kind:'RUN_MAIN',timeoutMs:1000,task:{workingDirectory:'.',entry:{kind:'SCRIPT',path:'main.txt'},tests:{paths:[],names:[]}}});
  p.capabilities.execution.modes.RUN_MAIN={canRun:true,problem:null};
  const a:RuntimeAuthorityV2={projectId:p.projectId,sessionId:p.sessionId,clientId:'c1',connectionGeneration:'conn1',workspaceVersion:1,configurationGeneration:'cfg1',controlEpoch:0,connected:true,canExecute:true,canSaveSettings:true};
  let resolve!:(v:unknown)=>void,reject!:(e:Error)=>void,calls=0;
  const held=new Promise((yes,no)=>{resolve=yes;reject=no;});
  const client=new RuntimeClientV2({current:()=>a,requestId:()=>`original-${++calls}`,http:{
    run:async()=>held,stop:async()=>{throw Error('Unexpected Stop');},saveSettings:async()=>{throw Error('Unexpected Save');}
  }});
  assert.equal(client.applyProject(p),true);
  const accepted:RunV2={...run(),mode,status:'QUEUED',startedAt:null,testOutcome:mode==='RUN_MAIN'?'NOT_APPLICABLE':'UNKNOWN'};
  const changed=structuredClone(p);changed.capabilities.execution.modes.RUN_TESTS={canRun:false,problem};
  return {client,p,a,accepted,changed,resolve,reject,get calls(){return calls;}};
}

for(const mode of ['RUN_MAIN','RUN_TESTS'] as const) {
  for(const status of ['QUEUED','RUNNING','SUCCEEDED','FAILED'] as const) {
    test(`${mode}: own transient TESTS readiness preserves original response after ${status}`,async t=>{
      const f=fixture(mode);t.after(()=>f.client.dispose());const pending=f.client.run(mode);
      const observed={...f.accepted,status,startedAt:status==='QUEUED'?null:run().startedAt,
        finishedAt:['SUCCEEDED','FAILED'].includes(status)?'2026-11-13T10:00:00Z':null,
        exitCode:status==='SUCCEEDED'?0:status==='FAILED'?1:null};
      assert.equal(f.client.applyProject(f.changed,observed),true);
      assert.equal(f.client.snapshot().reconciliationRequired,true,'readiness alone cannot settle original dispatch');
      f.resolve(f.accepted);assert.equal(await pending,true);
      assert.equal(f.client.snapshot().reconciliationRequired,false);
      assert.deepEqual(f.client.snapshot().run,observed,'do not rewind newer lifecycle to HTTP QUEUED');
      assert.equal(f.calls,1);
      if(mode==='RUN_TESTS') {
        assert.equal(await f.client.run(mode),false,'a NEW Run still requires current measured readiness');
        assert.equal(f.calls,1);
      }
    });
  }
  for(const restore of [false,true])test(`${mode}: genuine workspace change${restore?' followed by ABA':''} remains poisoned`,async t=>{
    const f=fixture(mode);t.after(()=>f.client.dispose());const pending=f.client.run(mode);
    const drift=structuredClone(f.changed);drift.workspaceVersion=f.a.workspaceVersion=2;
    assert.equal(f.client.applyProject(drift,f.accepted),true);
    if(restore){f.a.workspaceVersion=1;f.client.applyProject(f.changed,f.accepted);}
    f.resolve(f.accepted);assert.equal(await pending,false);assert.equal(f.client.snapshot().reconciliationRequired,true);
    assert.equal(f.calls,1);
  });
  test(`${mode}: lost original response keeps UNKNOWN despite own terminal and readiness`,async t=>{
    const f=fixture(mode);t.after(()=>f.client.dispose());const pending=f.client.run(mode);
    f.client.applyProject(f.changed,{...f.accepted,status:'FAILED',startedAt:run().startedAt,finishedAt:'2026-11-13T10:00:00Z',exitCode:1});
    f.reject(Error('Original response lost'));assert.equal(await pending,false);
    f.client.applyProject(f.p,f.accepted);assert.equal(f.client.snapshot().reconciliationRequired,true);
    assert.equal(await f.client.run(mode),false);assert.equal(f.calls,1);
  });
}
