/** Standalone actual Executor UNIT; callback completion is never exit authority. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from '../runtime-executor/fixtures';

for(const kind of ['resolves-without-exit','rejects','aborted'] as const)test(`timeout delegation ${kind}: no invented exit, Stop, collection or removal`,async()=>{
  const f=await fixture();
  try{
    const handle=await f.executor.start(f.plan);f.advance(1001);let calls=0;
    const control=new AbortController();if(kind==='aborted')control.abort();
    await assert.rejects(f.executor.wait(handle,control.signal,async()=>{
      calls++;if(kind==='rejects')throw Error('durable intent unavailable');
    }),kind==='resolves-without-exit'?/exact retained exit/:kind==='rejects'?/durable intent unavailable/:/Wait cancelled/);
    assert.equal(calls,kind==='aborted'?0:1);
    const record=await f.journal.read(handle.runId);
    assert.equal(record.exit,null);assert.equal(record.collection,null);assert.equal(record.outcome,null);
    assert.ok(f.fake.v.State.Running);
    assert.ok(!f.fake.calls.some(c=>['stop','rm','kill','prune'].includes(c[0])));
  }finally{await f.cleanup();}
});
