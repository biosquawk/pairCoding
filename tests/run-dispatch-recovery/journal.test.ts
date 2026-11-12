/** Native lifetime lease + real original durable records; no storage mocks. Only fault injection/Docker UNIT. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {executionFixture,until} from '../backend-cutover/execution-composition-fixture';
import {DurableMutationJournal} from '../../src/server/runtime-coordinator/MutationJournal';
import {RuntimeRunMutation} from '../../src/server/runtime-coordinator/RuntimeRunMutation';
import {canonical,sha256} from '../../src/server/runtime-coordinator/storage';
async function fixture(t:test.TestContext){
 let journal:DurableMutationJournal; t.after(async()=>{await journal?.close();});
 const f=await executionFixture(t),directory=path.join(f.core.workspace.dataDir,'run-mutations');journal=new DurableMutationJournal(directory);
 return {...f,directory,get journal(){return journal;},mutations:new RuntimeRunMutation(f.core,journal,f.execution),
 async reopen(){await journal.close();journal=new DurableMutationJournal(directory);}};
}
test('UNIT actual create sees fsynced MAY in original admission before executor effect; active revoke and second native owner excluded',async t=>{
 const f=await fixture(t),run=f.fake.run.bind(f.fake);let checked=false;
 f.fake.run=async args=>{if(args[0]==='create'){
  const [{identity,stage,dispatch}]=f.journal.runAdmissions();assert.equal(dispatch,'MAY_HAVE_BEEN_DISPATCHED');assert.equal(f.journal.revokeRunDispatch(identity,stage),false);
  assert.throws(()=>new DurableMutationJournal(f.directory),/live kernel owner/);checked=true;
 }return run(args);};
 const accepted=await f.mutations.execute(f.request());assert.equal(accepted.state,'COMMITTED');assert.equal(checked,true);if(accepted.state!=='COMMITTED')throw Error('required');
 const [{identity,stage}]=f.journal.runAdmissions();assert.equal(f.journal.revokeRunDispatch(identity,stage),false);
 f.fake.finish();await until(()=>f.execution.runner.get(accepted.result.runId).status==='SUCCEEDED');
});
test('UNIT durable revoke is monotonic across reopen and cannot authorize late original callback even during another active effect',async t=>{
 const f=await fixture(t),stageRun=f.journal.stageRun.bind(f.journal);
 f.journal.stageRun=(...args)=>{stageRun(...args);throw Error('after actual admitted fsync before claim');};
 assert.deepEqual(await f.mutations.execute(f.request()),{state:'UNKNOWN',result:null});
 const [{identity,stage,dispatch}]=f.journal.runAdmissions();assert.equal(dispatch,'NOT_DISPATCHED');
 assert.equal(f.journal.revokeRunDispatch(identity,{...stage,policy:{...stage.policy,managedCacheRoot:'/foreign'}}),false);
 assert.equal(f.journal.revokeRunDispatch(identity,stage),true);assert.equal(f.journal.runAdmissions()[0].dispatch,'REVOKED');
 assert.deepEqual(await f.mutations.recover(f.request()),{state:'COMMITTED',result:stage.result});await f.reopen();
 assert.equal(f.journal.revokeRunDispatch(identity,stage),true);assert.deepEqual(f.journal.runAdmissions()[0].stage,stage);
 const other={...identity,requestId:'new-native-owner',payload:{...identity.payload as object,requestId:'new-native-owner'}};
 await f.journal.executeRun(other,async()=>{
  assert.equal(f.journal.revokeRunDispatch(identity,stage),true,'already revoked proof remains usable while unrelated NEW admission is active');
  assert.throws(()=>f.journal.claimRunDispatch(identity,stage),{code:'RUN_DISPATCH_UNPROVEN'});
  return {state:'DEFINITIVELY_ABORTED',result:null};
 });assert.equal(f.fake.calls.some(a=>a[0]==='create'||a[0]==='start'),false);
});
test('UNIT actual fsync EIO before dispatch claim prevents executor invocation, poisons owner, and never backfills MAY as no-dispatch',async t=>{
 const f=await fixture(t),claim=f.journal.claimRunDispatch.bind(f.journal);let failed=false;
 f.journal.claimRunDispatch=(...args)=>{
  const sync=fs.fsyncSync;fs.fsyncSync=()=>{failed=true;throw Object.assign(Error('claim fsync EIO'),{code:'EIO'});};
  try{claim(...args);}finally{fs.fsyncSync=sync;}
 };
 assert.deepEqual(await f.mutations.execute(f.request()),{state:'UNKNOWN',result:null});assert.equal(failed,true);
 assert.equal(f.fake.calls.some(a=>a[0]==='create'||a[0]==='start'),false);assert.throws(()=>f.journal.runAdmissions(),{code:'MUTATION_JOURNAL_UNAVAILABLE'});
 await f.reopen();const [{identity,stage,dispatch}]=f.journal.runAdmissions();assert.equal(dispatch,'NOT_DISPATCHED');assert.equal(f.journal.revokeRunDispatch(identity,stage),true);
});
test('UNIT visible REVOKED after lost directory fsync acknowledgement must reflush before positive authority can escape',async t=>{
 const f=await fixture(t),stageRun=f.journal.stageRun.bind(f.journal);f.journal.stageRun=(...args)=>{stageRun(...args);throw Error('pre-effect');};
 await f.mutations.execute(f.request());const [{identity,stage}]=f.journal.runAdmissions(),sync=fs.fsyncSync;let failures=0;
 fs.fsyncSync=fd=>{if(fs.fstatSync(fd).isDirectory() && fs.readlinkSync('/proc/self/fd/'+fd)===f.directory && ++failures===2)throw Error('revoked rename directory fsync EIO');return sync(fd);};
 try{assert.throws(()=>f.journal.revokeRunDispatch(identity,stage),/fsync EIO/);}finally{fs.fsyncSync=sync;}
 await f.reopen();assert.equal(f.journal.runAdmissions()[0].dispatch,'REVOKED');
 fs.fsyncSync=fd=>{if(fs.fstatSync(fd).isDirectory())throw Error('reflush EIO');return sync(fd);};
 try{assert.throws(()=>f.journal.revokeRunDispatch(identity,stage),/reflush EIO/);}finally{fs.fsyncSync=sync;}
 assert.equal(f.journal.revokeRunDispatch(identity,stage),true);assert.equal(f.fake.calls.some(a=>a[0]==='create'),false);
});
for(const defect of ['MISSING','CORRUPT'] as const)test('UNIT '+defect+' original dispatch authority after admission is not positive proof',async t=>{
 const f=await fixture(t),stageRun=f.journal.stageRun.bind(f.journal);f.journal.stageRun=(...args)=>{stageRun(...args);throw Error('pre-effect');};await f.mutations.execute(f.request());
 const [{identity,stage}]=f.journal.runAdmissions(),file=path.join(f.directory,sha256(canonical([identity.projectId,identity.sessionId,identity.clientId,identity.requestId]))+'.json');
 fs.renameSync(file,path.join(f.root,'preserved-original-admission.json'));if(defect==='CORRUPT')fs.writeFileSync(file,'{CORRUPT');
 assert.throws(()=>f.journal.revokeRunDispatch(identity,stage));assert.equal(f.fake.calls.some(a=>a[0]==='create'||a[0]==='start'),false);
});
