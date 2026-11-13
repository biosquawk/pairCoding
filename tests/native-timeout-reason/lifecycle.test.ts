/** UNIT: genuine Runner/NodeAdapter/immutable FS/DockerExecutor/journal/receipt; injected Docker+clock only. */
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { RuntimeRunState } from '../../src/server/runtime-coordinator/RuntimeRunState';
import { Runner } from '../../src/server/Runner';
import { DockerExecutor } from '../../src/server/execution/DockerExecutor';
import { fixture, profile } from '../runner-fixture-migration/fixture';
import type { ExecutionPort, ExecutionPlan, ExecutionHandle, DurableTerminalReceipt } from '../../src/server/execution/ports';

// Compile the EXACT neutral wait forwarder from the actual production composition.
// Only retained(handle) is bound to this test's genuine executor, not a substitute port.
const runtimeSource=fs.readFileSync(new URL('../../src/server/runtime-coordinator/RuntimeExecution.ts',import.meta.url),'utf8');
const waitRoute=runtimeSource.split('    wait: ')[1]?.split(', stop: ')[0];
assert.ok(waitRoute);
const bindWait=new Function('retained',`return (${waitRoute});`) as (retained:(h:ExecutionHandle)=>ExecutionPort)=>ExecutionPort['wait'];

const tick=()=>new Promise<void>(resolve=>setImmediate(resolve));
async function until(predicate:()=>boolean) {
  const deadline=Date.now()+10000;
  while(!predicate()){assert.ok(Date.now()<deadline,'bounded UNIT interleaving');await tick();}
}
async function composition(t:TestContext,expired=false,stopExit=137,routed=true) {
  t.mock.timers.enable({apis:['setTimeout']});
  let clock=1000000, stopFails=false, persistFails=false, waitBlocked=false, stopBlocked=false;
  let runner!:Runner;let receipt:DurableTerminalReceipt|undefined;
  t.after(async()=>{stopFails=false;persistFails=false;waitBlocked=false;stopBlocked=false;await runner?.stopAll();});
  const f=await fixture(t), trace:string[]=[],states=new RuntimeRunState(path.join(f.root,'states'));
  let dispatchedPlan:ExecutionPlan|undefined;
  let collect=0,cleanup=0;
  const original=f.unit.run.bind(f.unit);
  f.unit.run=async args=>{
    if(args[0]==='stop'){trace.push('physical-stop');if(stopFails)throw Error('UNIT daemon failure; still running');while(stopBlocked)await tick();}
    if(args[0]==='rm')trace.push('physical-rm');
    const reply=await original(args);
    if(args[0]==='stop')f.unit.container!.State.ExitCode=stopExit;
    return reply;
  };
  const executor=new DockerExecutor({policy:f.policy,journal:f.journal,transport:f.unit,now:()=>clock,
    sleep:async()=>{while(waitBlocked)await tick();await tick();}});
  const stop=executor.stop.bind(executor);
  executor.stop=async(h,reason)=>{trace.push('stop:'+reason);return stop(h,reason);};
  const execution:ExecutionPort=new Proxy(executor,{get(target,key){
    if(key==='wait')return (...args:Parameters<ExecutionPort['wait']>)=>(routed?bindWait(()=>target):target.wait.bind(target))(args[0],args[1],args[2]?async()=>{trace.push('timeout-callback');await args[2]!();}:undefined);
    if(key==='start')return async(plan:ExecutionPlan)=>{dispatchedPlan=plan;const handle=await target.start(plan);if(expired)clock+=1001;return handle;};
    if(key==='collect')return async(...args:Parameters<ExecutionPort['collect']>)=>{collect++;trace.push('collect');return target.collect(...args);};
    if(key==='cleanup')return async(...args:Parameters<ExecutionPort['cleanup']>)=>{cleanup++;trace.push('cleanup');return target.cleanup(...args);};
    const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;
  }});
  const retained:('USER'|'TIMEOUT'|null)[]=[];
  runner=new Runner({execution,getWorkspaceVersion:()=>1,emit:()=>{},persistTerminal:async(h,outcome)=>{
    trace.push('persist-terminal');receipt=await executor.persistTerminal(h,outcome);return receipt;
  },retainState:(plan,run,reason)=>{trace.push('intent:'+reason);if(reason==='TIMEOUT'&&persistFails)throw Error('UNIT retain failed');states.retain(plan,run,reason);retained.push(reason);}});
  async function terminal(runId:string) {
    await until(()=>!['QUEUED','RUNNING','STOPPING'].includes(runner.get(runId).status));
    return runner.get(runId);
  }
  async function physical(runId:string) {
    const record=await f.journal.read(runId);
    assert.deepEqual(states.read(dispatchedPlan!)?.run,runner.get(runId));
    assert.equal(record.phase,'REMOVED');assert.ok(record.exit);assert.ok(record.collection);assert.ok(record.outcome);
    assert.ok(receipt,'genuine durable receipt captured at actual production persistTerminal');
    assert.deepEqual(receipt.exit,record.exit);assert.equal(receipt.collectionSha256,record.collection!.collectionSha256);
    assert.equal(collect,1);assert.equal(cleanup,1);
    assert.equal(f.unit.calls.filter(c=>c[0]==='stop').length,1);
    assert.equal(f.unit.calls.filter(c=>c[0]==='rm').length,1);
    assert.equal(f.unit.calls.filter(c=>c[0]==='create').length,1);
    assert.ok(!f.unit.calls.some(c=>['kill','prune','ps'].includes(c[0])));
  }
  return {...f,executor,runner,trace,retained,terminal,physical,start:()=>runner.start(f.admission(profile({timeoutMs:1000}))),
    expire:()=>{clock+=1001;},stopFails:(value:boolean)=>{stopFails=value;},persistFails:(value:boolean)=>{persistFails=value;},
    blockWait:(value:boolean)=>{waitBlocked=value;},blockStop:(value:boolean)=>{stopBlocked=value;},counts:()=>({collect,cleanup})};
}

test('executor-first deadline: genuine composition retains TIMEOUT before physical Stop, not FAILED',async t=>{
  const f=await composition(t,true),run=await f.start();
  const result=await f.terminal(run.runId);
  assert.equal(result.status,'TIMED_OUT');assert.equal(result.exitCode,137);
  assert.equal(result.testOutcome,'NOT_APPLICABLE');assert.equal(result.testCount,null);
  assert.ok(f.trace.indexOf('intent:TIMEOUT')<f.trace.indexOf('physical-stop'));
  await f.physical(run.runId);assert.equal((await f.runner.stop(run.runId)).status,'TIMED_OUT');
});

test('runner-first deadline joins same reason/Stop/collection/removal',async t=>{
  const f=await composition(t),run=await f.start();
  t.mock.timers.tick(1000);
  assert.equal((await f.terminal(run.runId)).status,'TIMED_OUT');
  await f.physical(run.runId);
});

test('user Stop wins before executor deadline; later expiry cannot rewrite it to TIMEOUT',async t=>{
  const f=await composition(t),run=await f.start();f.blockStop(true);
  const stopped=f.runner.stop(run.runId);await until(()=>f.trace.includes('physical-stop'));
  f.expire();await until(()=>f.trace.includes('timeout-callback'));t.mock.timers.tick(1000);
  f.blockStop(false);assert.equal((await stopped).status,'CANCELLED');
  assert.equal(f.retained.filter(Boolean)[0],'USER');
  assert.ok(!f.retained.includes('TIMEOUT'));await f.physical(run.runId);
});

for(const exitCode of [0,128])test(`natural exit ${exitCode} at expired clock is not inferred TIMEOUT`,async t=>{
  const f=await composition(t),run=await f.start();
  // Hold the next poll while the modeled process exits, without changing production code.
  f.unit.finish(exitCode);f.expire();
  const result=await f.terminal(run.runId);
  assert.equal(result.status,exitCode===0?'SUCCEEDED':'FAILED');assert.equal(result.exitCode,exitCode);
  assert.ok(!f.retained.some(Boolean));assert.equal(f.unit.calls.filter(c=>c[0]==='stop').length,0);
  assert.deepEqual(f.counts(),{collect:1,cleanup:1});
});

test('executor-first Stop failure stays unconfirmed, blocks new Run, retry preserves TIMEOUT',async t=>{
  const f=await composition(t,true);f.stopFails(true);
  const run=await f.start(),result=await f.terminal(run.runId);
  assert.equal(result.status,'PROCESS_STOP_UNCONFIRMED');assert.equal(result.finishedAt,null);assert.equal(result.exitCode,null);
  assert.deepEqual(f.counts(),{collect:0,cleanup:0});assert.ok(f.unit.container!.State.Running);
  assert.equal(f.unit.calls.filter(c=>c[0]==='rm').length,0);
  await assert.rejects(f.start(),{code:'RUN_IN_PROGRESS'});
  f.stopFails(false);assert.equal((await f.runner.stop(run.runId)).status,'TIMED_OUT');
  assert.equal(f.unit.calls.filter(c=>c[0]==='create').length,1);assert.equal(f.unit.calls.filter(c=>c[0]==='rm').length,1);
});

test('stale opaque handle never authorizes timeout Stop or collection',async t=>{
  const f=await composition(t),run=await f.start(),record=await f.journal.read(run.runId);
  const stale:ExecutionHandle={...record.handle,opaqueId:'foreign'};
  await assert.rejects(f.executor.wait(stale,undefined,async()=>{assert.fail('stale handle cannot delegate Stop');}));
  assert.equal(f.unit.calls.filter(c=>c[0]==='stop').length,0);assert.deepEqual(f.counts(),{collect:0,cleanup:0});
  assert.equal((await f.runner.stop(run.runId)).status,'CANCELLED');
});


test('overlapping executor deadline and runner timer join one in-flight physical Stop without deadlock',async t=>{
  const f=await composition(t,true);f.blockStop(true);const run=await f.start();
  await until(()=>f.trace.includes('physical-stop'));
  t.mock.timers.tick(1000);await tick();
  assert.equal(f.trace.filter(v=>v==='stop:TIMEOUT').length,1);assert.deepEqual(f.counts(),{collect:0,cleanup:0});
  f.blockStop(false);assert.equal((await f.terminal(run.runId)).status,'TIMED_OUT');
  await f.physical(run.runId);
});

test('failed durable timeout intent prevents physical Stop/collection/removal, retains uncertainty fence',async t=>{
  const f=await composition(t,true);f.persistFails(true);const run=await f.start();
  const result=await f.terminal(run.runId);
  assert.equal(result.status,'PROCESS_STOP_UNCONFIRMED');assert.equal(result.finishedAt,null);
  assert.equal(f.unit.calls.filter(c=>c[0]==='stop').length,0);assert.equal(f.unit.calls.filter(c=>c[0]==='rm').length,0);
  assert.deepEqual(f.counts(),{collect:0,cleanup:0});assert.ok(f.unit.container!.State.Running);
  await assert.rejects(f.start(),{code:'RUN_IN_PROGRESS'});
  f.persistFails(false);assert.equal((await f.runner.stop(run.runId)).status,'CANCELLED');
});


test('executor-first native exit128: truthful adapter FAILED differs from retained public TIMED_OUT',async t=>{
  const f=await composition(t,true,128),run=await f.start();
  const result=await f.terminal(run.runId);assert.equal(result.status,'TIMED_OUT');assert.equal(result.exitCode,128);
  const record=await f.journal.read(run.runId);assert.equal(record.outcome!.status,'FAILED');assert.equal(record.exit!.exitCode,128);
  assert.equal(f.retained.at(-1),'TIMEOUT');await f.physical(run.runId);
});


test('production wait-route: executor-first timeout reaches genuine durable app intent and TIMED_OUT',async t=>{
  const f=await composition(t,true,128,true),run=await f.start();
  assert.equal((await f.terminal(run.runId)).status,'TIMED_OUT');
  assert.equal(f.retained.at(-1),'TIMEOUT');await f.physical(run.runId);
});
