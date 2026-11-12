/** NEW controlled transport only; native journal/kernel/real filesystem are not mocked. */
import { fixture } from '../runtime-executor/fixtures';
import { ExecutionUncertainError, DockerExecutor } from '../../src/server/execution/DockerExecutor';
import { DurableRunJournal } from '../../src/server/execution/DurableRunJournal';
import assert from 'node:assert/strict';
export const zero='0001-01-01T00:00:00Z';
export async function createdFixture() {
  const f=await fixture(), original=f.fake.run.bind(f.fake);let created=false,readable=false;
  f.fake.run=async args=>{
    if(args[0]==='container'&&created&&!readable)throw Error('Lost create/readback response');
    const result=await original(args);
    if(args[0]==='create'){created=true;f.fake.v.State.StartedAt=zero;throw Error('Lost create response');}
    return result;
  };
  let handle:any;
  await assert.rejects(f.executor.start(f.plan),e=>{assert.ok(e instanceof ExecutionUncertainError);handle=e.handle;return true;});
  readable=true;
  assert.equal((await f.journal.read(handle.runId)).startDispatch,'NOT_DISPATCHED');
  assert.equal(f.fake.calls.some(a=>a[0]==='start'),false);
  const reopen=()=>new DockerExecutor({policy:f.policy,transport:f.fake,journal:new DurableRunJournal(f.journal.directory,'install')});
  return {...f,handle,reopen};
}
export function deferred(){let resolve!:()=>void;const promise=new Promise<void>(r=>resolve=r);return {promise,resolve};}
