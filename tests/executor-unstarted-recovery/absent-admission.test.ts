/** UNIT full persisted original COMMITTED/MAY admission + native executor INTENT/NOT_DISPATCHED.
 * Real composition/Runner/mutation journal/kernel/FS. Synthetic prepared + Docker only; NO HTTP/runtime.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs/promises';
import { executionFixture } from '../backend-cutover/execution-composition-fixture';
import { DurableMutationJournal } from '../../src/server/runtime-coordinator/MutationJournal';
import { RuntimeRunMutation } from '../../src/server/runtime-coordinator/RuntimeRunMutation';
import { createRuntimeExecution } from '../../src/server/runtime-coordinator/RuntimeExecution';
import captured from './docker29-named-absence.json';

test('REGRESSION COMMITTED original QUEUED/MAY plus INTENT/NOT: supported same-run cancellation survives composition reload; never ABORTED, no original replay',async t=>{
  let journal:DurableMutationJournal;t.after(async()=>{await journal?.close();});
  const f=await executionFixture(t);journal=new DurableMutationJournal(path.join(f.core.workspace.dataDir,'run-mutations'));
  const mutations=new RuntimeRunMutation(f.core,journal,f.execution),request=f.request(),original=f.fake.run.bind(f.fake);
  let uncertain=true;
  f.fake.run=async args=>{const r=await original(args);if(args[0]==='container'&&!f.fake.v){
    if(uncertain)throw Error('Original uncertain observation, no create/start');
    return {...captured.reply,stderr:captured.reply.stderr.replace(captured.target,args[2])};
  }return r;};
  const accepted=await mutations.execute(request);assert.equal(accepted.state,'COMMITTED');if(accepted.state!=='COMMITTED')throw Error('narrow');
  assert.equal(accepted.result.status,'QUEUED');assert.equal(f.execution.runner.get(accepted.result.runId).status,'PROCESS_STOP_UNCONFIRMED');
  const [{identity,stage,dispatch}]=journal.runAdmissions();assert.equal(dispatch,'MAY_HAVE_BEEN_DISPATCHED');
  const record=await f.execution.journal.read(accepted.result.runId);assert.equal(record.phase,'INTENT');assert.equal(record.startDispatch,'NOT_DISPATCHED');assert.equal(record.containerId,null);
  const directory=journal.directory,files=await fs.readdir(directory),before=await Promise.all(files.filter(n=>n.endsWith('.json')).map(async n=>[n,await fs.readFile(path.join(directory,n),'utf8')]));
  uncertain=false;
  const reload=()=>createRuntimeExecution({core:f.core,configuration:{configurationGeneration:'cfg',resolved:f.runtime,problem:null},prepared:f.prepared,layout:f.layout,
    transport:{run:async args=>f.fake.run(args)},serviceNetwork:null,assertCurrent:()=>{},emit:()=>{}});
  const restored=reload();await restored.recover(journal.runAdmissions(),(id,s)=>mutations.validate(id.payload as typeof request,s),(id,s)=>journal.revokeRunDispatch(id,s));
  await assert.rejects(restored.assertAccounted(true),{code:'PROCESS_STOP_UNCONFIRMED'});
  const current=await restored.runner.stop(accepted.result.runId);
  assert.equal(current.status,'CANCELLED');assert.equal(current.startedAt,null);assert.equal(current.exitCode,null);assert.equal(current.testOutcome,'NOT_APPLICABLE');
  assert.equal(current.processProblem?.code,'RUN_CANCELLED_UNSTARTED');await restored.assertAccounted(true);
  assert.deepEqual(await mutations.recover(request),accepted);assert.deepEqual(journal.runAdmissions()[0],{identity,stage,dispatch});
  for(const [name,bytes] of before)assert.equal(await fs.readFile(path.join(directory,name),'utf8'),bytes,'original admission bytes remain immutable');
  const commands=f.fake.calls.length,next=reload();await next.recover(journal.runAdmissions(),(id,s)=>mutations.validate(id.payload as typeof request,s),(id,s)=>journal.revokeRunDispatch(id,s));
  await next.assertAccounted(true);assert.deepEqual(next.runner.get(accepted.result.runId),current);assert.equal(f.fake.calls.length,commands,'read-only recovery and gate check perform no Docker operations');
  assert.equal(f.fake.calls.some(a=>['create','start','stop','rm','logs'].includes(a[0])),false);
});
