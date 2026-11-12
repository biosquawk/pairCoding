/** Real gate/capture/Runner/journal; synthetic prepared cache and controlled Docker. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { executionFixture } from '../backend-cutover/execution-composition-fixture';
import { DurableMutationJournal } from '../../src/server/runtime-coordinator/MutationJournal';
import { RuntimeRunMutation } from '../../src/server/runtime-coordinator/RuntimeRunMutation';

test('Stop before capture returns explains RUN_CANCELLED_BEFORE_START, never dispatches or forges original outcome',async t=>{
  let journal:DurableMutationJournal|undefined;
  t.after(async()=>{await journal?.close();});
  const f=await executionFixture(t);
  journal=new DurableMutationJournal(path.join(f.core.workspace.dataDir,'original-mutations'));
  let release!:()=>void, captured=false, calls=0, originalError:any;
  const held=new Promise<void>(r=>release=r), resolve=f.prepared.resolveCache.bind(f.prepared);
  f.prepared.resolveCache=async(...args)=>{
    const result=await resolve(...args);
    if(++calls===2){captured=true;await held;}
    return result;
  };
  const mutation=new RuntimeRunMutation(f.core,journal,{start:async(...args)=>{
    try{return await f.execution.start(...args);}catch(error){originalError=error;throw error;}
  }});
  const request=f.request(), original=fs.readFileSync(path.join(f.workspace,'main.js'));
  const pending=mutation.execute(request);
  try{
    for(let i=0;!captured&&i<1000;i++)await new Promise<void>(r=>setTimeout(r,5));
    assert.equal(captured,true);
    const run=f.execution.runner.list()[0];
    assert.equal(run.status,'QUEUED');
    assert.ok(fs.existsSync(path.join(f.layout.runRoot,run.runId,'input-manifest.json')));
    await assert.rejects(f.execution.runner.stop(run.runId),{code:'RUN_ADMISSION_PENDING'});
  }finally{release();await pending;}
  assert.deepEqual(await pending,{state:'UNKNOWN',result:null});
  assert.equal(originalError.code,'RUN_CANCELLED_BEFORE_START');
  assert.match(originalError.stack,/RuntimeRunner.start/);
  console.info('CONTROLLED_STOP_DURING_CAPTURE_THROW\n'+originalError.stack);
  assert.equal(f.execution.runner.list().length,0);
  assert.equal(journal.runAdmissions().length,0);
  assert.deepEqual(await mutation.execute(request),{state:'UNKNOWN',result:null});
  await assert.rejects(mutation.execute({...request,requestId:'new-before-reconcile'}),{code:'MUTATION_PENDING'});
  assert.deepEqual(await mutation.recover(request),{state:'DEFINITIVELY_ABORTED',result:null});
  assert.deepEqual(await mutation.execute(request),{state:'DEFINITIVELY_ABORTED',result:null});
  assert.equal(f.fake.calls.some(args=>args[0]==='create'||args[0]==='start'),false);
  assert.deepEqual(fs.readFileSync(path.join(f.workspace,'main.js')),original);
});
