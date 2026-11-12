/** Actual TCP HTTP + production LiveBackend/RuntimeClient. Bootstrap WS is a controlled
 * seam; Stop completion is a server fixture, NOT Docker/GUI/physical cleanup proof. */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { setImmediate, setTimeout as sleep } from 'node:timers/promises';
import { LiveBackend } from '../../src/services/LiveBackend';
import { bundle, doc } from '../frontend-cutover/fixtures';
import { run } from '../client-v2/fixtures';
import type { RunV2 } from '../../src/shared/runtime-v2';

const cancelled = (): RunV2 => ({...run(),status:'CANCELLED',exitCode:137,finishedAt:'2026-11-12T22:00:00.000Z'});
type Stop = (request:http.IncomingMessage,response:http.ServerResponse,body:any) => void | Promise<void>;
async function fixture(t:any, stop:Stop, timeoutMs=1000) {
  const b={...bundle(),lastRun:run()}; b.project.settings.runProfiles[0].timeoutMs=timeoutMs;
  const requests:{path:string;body:any;authorization:string|undefined;at:number}[]=[];
  const server=http.createServer(async(req,res)=>{
    try {
      const path=new URL(req.url!,'http://local.test').pathname;
      let raw=''; for await (const c of req) raw+=c;
      const body=raw?JSON.parse(raw):null;
      requests.push({path,body,authorization:req.headers.authorization,at:performance.now()});
      if(path.endsWith('/stop')) { await stop(req,res,body); return; }
      res.setHeader('Content-Type','application/json');
      res.end(JSON.stringify(path==='/api/project'?b.project:path==='/api/session'?b.session:path==='/api/snapshots'?[]:doc()));
    } catch(error) { res.destroy(error as Error); }
  });
  server.listen(0,'127.0.0.1'); await once(server,'listening');
  const baseUrl=`http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}`;
  const socket:any={readyState:1,onopen:null,onmessage:null,onclose:null,onerror:null,send(){},close(){this.readyState=3;}};
  const live=new LiveBackend({baseUrl,token:'local-stop-test-token',clientId:'c1',socket:()=>socket});
  t.after(async()=>{live.close();server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));});
  await live.connect();
  live.receive({protocolVersion:'3.0',messageId:'snapshot1',sessionId:'s1',seq:1,type:'SESSION_SNAPSHOT',payload:b} as any);
  await setImmediate(); assert.equal(live.getState().isOffline,false);assert.equal(live.getState().runtime?.run?.status,'RUNNING');
  return {live,requests,b,stops:()=>requests.filter(r=>r.path==='/api/run/run1/stop')};
}
function reply(res:http.ServerResponse,value:unknown,status=202) {res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(value));}
function oneOriginal(f:Awaited<ReturnType<typeof fixture>>) {
  assert.equal(f.stops().length,1,'No resend/new operation after an uncertain or pending Stop');
  const r=f.stops()[0];assert.equal(r.authorization,'Bearer local-stop-test-token');
  assert.deepEqual(Object.keys(r.body).sort(),['clientId','requestId','sessionId']);
  assert.equal(r.body.clientId,'c1');assert.equal(r.body.sessionId,'s1');assert.equal(typeof r.body.requestId,'string');assert.ok(r.body.requestId.length>0);
}

test('original Stop waits beyond 5s for the sole HTTP202 confirmation, no premature success or duplicate dispatch',async t=>{
  let entered!:()=>void;const dispatched=new Promise<void>(r=>entered=r);
  let responded=false,elapsed=0;
  const f=await fixture(t,async(_req,res)=>{const start=performance.now();entered();await sleep(5500);elapsed=performance.now()-start;responded=true;reply(res,cancelled());});
  const start=performance.now(),operation=f.live.stopExecution();await dispatched;
  assert.equal(f.live.getState().runtime?.pending,'STOP');assert.equal(f.live.getState().runtime?.run?.status,'RUNNING');
  await f.live.stopExecution();oneOriginal(f); // singleflight while original HTTP is pending
  await operation;
  t.diagnostic(JSON.stringify({elapsedMs:performance.now()-start,serverDelayMs:elapsed,responded,requests:f.stops().length,status:f.live.getState().runtime?.run?.status,error:f.live.getState().runtime?.error}));
  assert.equal(responded,true,'Client must not finish before delayed physical-confirmation fixture');
  assert.ok(elapsed>=5500);assert.equal(f.live.getState().runtime?.run?.status,'CANCELLED');
  assert.equal(f.live.getState().runtime?.pending,null);assert.equal(f.live.getState().runtime?.error,null);oneOriginal(f);
});

test('real transport loss after dispatch stays unconfirmed and never replays Stop',async t=>{
  const f=await fixture(t,req=>{req.socket.destroy();});
  await f.live.stopExecution();await setImmediate();
  assert.equal(f.live.getState().runtime?.run?.status,'RUNNING');assert.equal(f.live.getState().runtime?.pending,null);
  assert.ok(f.live.getState().runtime?.error);oneOriginal(f);
});

test('HTTP503 physical Stop uncertainty is not a successful cancellation and is not retried',async t=>{
  const f=await fixture(t,(_req,res)=>reply(res,{code:'PROCESS_STOP_UNCONFIRMED',message:'No physical exit/absence proof.'},503));
  await f.live.stopExecution();
  assert.equal(f.live.getState().runtime?.run?.status,'RUNNING');assert.match(f.live.getState().runtime?.error??'',/PROCESS_STOP_UNCONFIRMED/);oneOriginal(f);
});

test('foreign run response cannot replace the original active run',async t=>{
  const f=await fixture(t,(_req,res)=>reply(res,{...cancelled(),runId:'foreign-run'}));await f.live.stopExecution();
  assert.equal(f.live.getState().runtime?.run?.runId,'run1');assert.equal(f.live.getState().runtime?.run?.status,'RUNNING');assert.ok(f.live.getState().runtime?.error);oneOriginal(f);
});

test('closing caller aborts the HTTP wait; a late success does not revive a disposed scope or resend',async t=>{
  let entered!:()=>void,release!:()=>void;const dispatched=new Promise<void>(r=>entered=r),gate=new Promise<void>(r=>release=r);
  const f=await fixture(t,async(_req,res)=>{entered();await gate;reply(res,cancelled());});
  const operation=f.live.stopExecution();await dispatched;f.live.close();release();await operation;await setImmediate();
  assert.notEqual(f.live.getState().runtime?.run?.status,'CANCELLED');oneOriginal(f);
});

test('Stop-specific budget follows physical settlement bounds, not the 15-minute Run budget',async t=>{
  const f=await fixture(t,(_req,res)=>reply(res,cancelled()),900000);
  // Observe real scheduled deadlines without replacing timers or HTTP/fetch.
  const deadlines:number[]=[],original=globalThis.setTimeout;
  globalThis.setTimeout=((callback:any,delay?:number,...args:any[])=>{deadlines.push(delay??0);return original(callback,delay,...args);}) as typeof setTimeout;
  try {await f.live.stopExecution();} finally {globalThis.setTimeout=original;}
  assert.ok(deadlines.includes(150500));assert.ok(!deadlines.includes(900000),'Run timeout is not a Stop deadline');oneOriginal(f);
});

test('short run configuration cannot reinstate the ordinary 5s Stop deadline',async t=>{
  const f=await fixture(t,(_req,res)=>reply(res,cancelled()),1000);
  const deadlines:number[]=[],original=globalThis.setTimeout;
  globalThis.setTimeout=((callback:any,delay?:number,...args:any[])=>{deadlines.push(delay??0);return original(callback,delay,...args);}) as typeof setTimeout;
  try {await f.live.stopExecution();} finally {globalThis.setTimeout=original;}
  assert.ok(deadlines.includes(150500));oneOriginal(f);
});

test('an unrelated ordinary HTTP call retains its original real 5s transport deadline',async t=>{
  const server=http.createServer(()=>{});server.listen(0,'127.0.0.1');await once(server,'listening');
  const live=new LiveBackend({baseUrl:`http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}`,token:'local-stop-test-token'});
  t.after(async()=>{live.close();server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));});
  const start=performance.now();await live.connect();const elapsed=performance.now()-start;
  t.diagnostic(JSON.stringify({ordinaryDeadlineElapsedMs:elapsed,error:live.getState().connectionError}));
  assert.ok(elapsed>=4900&&elapsed<8000);assert.match(live.getState().connectionError??'',/5 s/);
});

test('actual HTTP held beyond the Stop-specific deadline stays UNKNOWN with one original request (controlled clock)',async t=>{
  let entered!:()=>void,release!:()=>void;const dispatched=new Promise<void>(r=>entered=r),gate=new Promise<void>(r=>release=r);
  const f=await fixture(t,async(_req,res)=>{entered();await gate;reply(res,cancelled());});
  t.mock.timers.enable({apis:['setTimeout']});
  try {
    const operation=f.live.stopExecution();await dispatched;
    t.mock.timers.tick(150499);assert.equal(f.live.getState().runtime?.pending,'STOP');
    assert.equal(f.live.getState().runtime?.run?.status,'RUNNING');
    t.mock.timers.tick(1);await operation;
    assert.equal(f.live.getState().runtime?.run?.status,'RUNNING');
    assert.match(f.live.getState().runtime?.error??'',/150\.5 s.*nieznany/);oneOriginal(f);
  } finally {release();t.mock.timers.reset();}
});
