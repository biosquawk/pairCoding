/** Real loopback HTTP/WS + production composition/LiveBackend. Docker/AI are controlled;
 * no live daemon, real toolchain, browser or C acceptance claim. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import WebSocket from 'ws';
import { LiveBackend } from '../../src/services/LiveBackend';
import { httpNetworkFixture, until } from '../backend-cutover/http-network-fixture';

test('valid production admission beyond 5s keeps the active original HTTP request, then commits once', async t => {
  const f = await httpNetworkFixture(t), app = f.app(), port = await app.listen();
  const calls: { body: any; signal: AbortSignal }[] = [];
  const live = new LiveBackend({baseUrl:`http://127.0.0.1:${port}`, token:f.token, clientId:'tab',
    socket:url => new WebSocket(url) as any, fetch:(async (input, init) => {
      if(new URL(String(input)).pathname === '/api/run') calls.push({body:JSON.parse(String(init!.body)),signal:init!.signal!});
      return fetch(input,init);
    }) as typeof fetch});
  t.after(()=>live.close());
  await live.connect();
  await until(()=>live.getState().runtime?.project?.capabilities.execution.modes.RUN_MAIN.canRun === true);
  let entered = false, release!:()=>void;
  const held = new Promise<void>(r=>release=r), original = f.fake.run.bind(f.fake);
  f.fake.beforeCreate = async () => { entered=true; await held; };
  // Start the real client while fake time is enabled, but keep socket I/O and Date real.
  const nativeTimeout = globalThis.setTimeout;
  t.mock.timers.enable({apis:['setTimeout']});
  const pending = live.run(false);
  try {
    for(let i=0; !entered && i<2000; i++) await new Promise<void>(r=>nativeTimeout(r,5));
    assert.equal(entered,true,'actual execution must reach the held valid port');
    assert.equal(calls.length,1);
    t.mock.timers.tick(5001);
    await setImmediate();
    assert.equal(calls[0].signal.aborted,false,'legal RUN admission must not inherit the ordinary 5s HTTP deadline');
    assert.equal(live.getState().runtime?.pending,'RUN');
    await live.run(false);
    assert.equal(calls.length,1,'pending operation is singleflight with one immutable request');
  } finally { release(); t.mock.timers.reset(); await pending; }
  assert.equal(live.getState().runtime?.reconciliationRequired,false);
  assert.ok(live.getState().runtime?.run?.runId);
  assert.equal(calls.length,1);
  assert.equal(f.fake.calls.filter(args=>args[0]==='create').length,1);
  assert.equal(f.fake.calls.filter(args=>args[0]==='start').length,1);
  await live.stopExecution();
  assert.equal(live.getState().runtime?.run?.status,'CANCELLED');
});

test('real same-run Stop during capture keeps the original unknown until supported exact reconcile, without dispatch', async t => {
  const f=await httpNetworkFixture(t),app=f.app(),port=await app.listen(),requests:{path:string;body:any}[]=[];
  const live=new LiveBackend({baseUrl:`http://127.0.0.1:${port}`,token:f.token,clientId:'tab',socket:url=>new WebSocket(url) as any,
    fetch:(async(input,init)=>{if(init?.body)requests.push({path:new URL(String(input)).pathname,body:JSON.parse(String(init.body))});return fetch(input,init);}) as typeof fetch});
  t.after(()=>live.close());await live.connect();
  await until(()=>live.getState().runtime?.project?.capabilities.execution.modes.RUN_MAIN.canRun===true);
  let release!:()=>void,captured=false;
  const held=new Promise<void>(r=>release=r),capture=app.gate.captureRun.bind(app.gate);
  app.gate.captureRun=async(...args)=>{const result=await capture(...args);captured=true;await held;return result;};
  const pending=live.run(false);
  try{
    await until(()=>captured);
    const run=live.getState().runtime!.run!;assert.ok(run);assert.equal(run.status,'QUEUED');
    await live.stopExecution();
    await pending;
    assert.equal(requests.filter(r=>r.path===`/api/run/${run.runId}/stop`).length,1);
    assert.match(live.getState().runtime?.error??'',/RUN_ADMISSION_PENDING/);
    assert.equal(live.getState().runtime?.reconciliationRequired,true);
    await live.run(false);assert.equal(requests.filter(r=>r.path==='/api/run').length,1);
    release();
    let missing=false;
    for(let i=0;!missing&&i<200;i++){
      missing=(await f.http(port,'GET','/api/run/'+run.runId)).status===404;
      if(!missing)await new Promise<void>(r=>setTimeout(r,5));
    }
    assert.equal(missing,true,'cancelled pre-start admission removes the volatile job, not the original mutation');
    assert.equal(await live.reconcileRuntimeMutation(),true);
    const original=requests.find(r=>r.path==='/api/run')!.body;
    assert.deepEqual(requests.find(r=>r.path==='/api/runtime/mutation/reconcile')!.body.mutation.request,original);
    assert.equal(live.getState().runtime?.reconciliationRequired,false);
    assert.equal(live.getState().runtime?.run,null);
    assert.equal(f.fake.calls.some(args=>args[0]==='create'||args[0]==='start'),false);
  }finally{release();await pending;}
});
