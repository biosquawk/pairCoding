/** Controlled transport is NOT live Spring/D proof. Real FE classes; two tests also use
 * real loopback HTTP/WS/core/private FS with synthetic prepared evidence + fake Docker. */
import test, {type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {setImmediate} from 'node:timers/promises';
import {once} from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {LiveBackend, type LiveOptions} from '../../src/services/LiveBackend';
import {bundle,doc} from '../frontend-cutover/fixtures';
import {MemoryStorage,prepared,storageKey} from './fixture';
import {httpNetworkFixture,until} from '../backend-cutover/http-network-fixture';

// Existing producer limits: max16 roots, initial engine +3 reads/root at3s;
// max10 service helper commands at10s; response margin5s. Not a Run budget.
const postDeadline=(1+3*16)*3000+10*10000+5000;
function deferred<T>() {let resolve!:(value:T)=>void;let reject!:(error:unknown)=>void;const promise=new Promise<T>((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};}
async function fixture(t:TestContext) {
  const b=bundle(),storage=new MemoryStorage(),calls:{path:string;raw:string;method:string;signal:AbortSignal;auth:string|null}[]=[];
  let seq=0,post:(signal:AbortSignal)=>Promise<unknown>=async()=>prepared();
  const socket:any={readyState:1,onopen:null,onmessage:null,onclose:null,onerror:null,send(){},close(){this.readyState=3;}};
  const live=new LiveBackend({token:'controlled-private',clientId:'c1',storage,socket:()=>socket,fetch:async(input,init)=>{
    const u=new URL(String(input)),p=u.pathname+u.search,signal=init!.signal!,raw=String(init?.body??'');
    calls.push({path:p,raw,method:init?.method??'GET',signal,auth:new Headers(init?.headers).get('Authorization')});
    let value:unknown;
    if(p==='/api/runtime/service-network/prepare') {
      assert.deepEqual(JSON.parse(storage.getItem(storageKey)!).entries[0].request,JSON.parse(raw),'full original durable BEFORE dispatch');
      value=await post(signal);
    } else if(u.pathname==='/api/project')value=structuredClone(b.project);
    else if(p==='/api/session')value=structuredClone(b.session);
    else if(p==='/api/snapshots')value=[];
    else if(u.pathname==='/api/file')value=doc(u.searchParams.get('path')??'main.txt');
    else throw Error('Unexpected effect '+p);
    return value instanceof Response?value:Response.json(value);
  }} as LiveOptions);t.after(()=>live.close());
  const receive=(type:string,payload:unknown)=>live.receive({protocolVersion:'3.0',messageId:`e${++seq}`,seq,sessionId:b.session.sessionId,type,payload} as any);
  const snapshot=async()=>{if((live as any).session?.sessionId!==b.session.sessionId){socket.readyState=1;await live.connect();socket.onopen?.();}receive('SESSION_SNAPSHOT',structuredClone(b));await setImmediate();};
  await live.connect();socket.onopen?.();await snapshot();assert.equal(live.getState().isOffline,false);
  return {live,b,storage,calls,snapshot,receive,
    posts:()=>calls.filter(c=>c.path==='/api/runtime/service-network/prepare'),
    reads:()=>calls.filter(c=>c.path==='/api/project?readiness=actual'),
    state:()=>live.getState().runtime!.maintenance!,original:()=>JSON.parse(storage.getItem(storageKey)!).entries[0],
    set post(v:typeof post){post=v;}};
}
function waitForAbort(signal:AbortSignal) {return new Promise<never>((_,reject)=>signal.addEventListener('abort',()=>reject(Error('controlled transport aborted')),{once:true}));}

test('legitimate authenticated POST response beyond5s and near producer budget succeeds, without changing original body (fakeclock)',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});const f=await fixture(t),gate=deferred<unknown>();
  f.post=signal=>Promise.race([gate.promise,waitForAbort(signal)]);
  const pending=f.live.prepareRuntimeEnvironment();await setImmediate();const original=structuredClone(f.original());
  assert.equal(f.posts()[0].auth,'Bearer controlled-private');assert.equal(f.posts()[0].method,'POST');
  t.mock.timers.tick(5001);await setImmediate();assert.equal(f.posts()[0].signal.aborted,false);assert.equal(f.state().pending,true);
  assert.equal(await f.live.prepareRuntimeEnvironment(),false);assert.equal(f.posts().length,1);assert.equal(f.reads().length,0);
  t.mock.timers.tick(postDeadline-5002);await setImmediate();assert.equal(f.posts()[0].signal.aborted,false);assert.deepEqual(f.original(),original);
  gate.resolve(prepared());assert.equal(await pending,true);assert.equal(f.posts().length,1);assert.equal(f.reads().length,1);
  assert.deepEqual(JSON.parse(f.storage.getItem(storageKey)!).entries,[]);assert.equal(f.state().blocked,false);
});

test('actual POST deadline retains SAME UNKNOWN original and never retries/releases; explicit original recovery unchanged (fakeclock)',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});const f=await fixture(t);f.post=waitForAbort;
  const pending=f.live.prepareRuntimeEnvironment();await setImmediate();const raw=f.storage.getItem(storageKey),wire=f.posts()[0].raw;
  t.mock.timers.tick(postDeadline-1);assert.equal(f.posts()[0].signal.aborted,false);
  t.mock.timers.tick(1);assert.equal(await pending,false);assert.equal(f.posts()[0].signal.aborted,true);
  assert.equal(f.storage.getItem(storageKey),raw);assert.equal(f.original().receipt,null);assert.equal(f.state().uncertain,true);assert.equal(f.state().blocked,true);
  assert.equal(f.reads().length,0);assert.equal(await f.live.prepareRuntimeEnvironment(),false);await setImmediate();assert.equal(f.posts().length,1);
  await f.snapshot();assert.equal(f.posts().length,1);assert.equal(f.storage.getItem(storageKey),raw,'reconnect snapshot cannot rewrite the original');
  f.post=async()=>prepared();assert.equal(await f.live.prepareRuntimeEnvironment(true),true);assert.equal(f.posts().length,2);
  assert.equal(f.posts()[1].raw,wire);assert.equal(f.reads().length,1);assert.equal(f.state().uncertain,false);
});
for(const failure of ['lost','unreadable','unknown503','unauthorized'] as const)test(`POST ${failure} retains full original without refresh/automatic resend`,async t=>{
  const f=await fixture(t);f.post=async()=>{
    if(failure==='lost')throw Error('response lost after effect');
    if(failure==='unreadable')return new Response('broken');
    return Response.json({code:failure==='unknown503'?'SERVICE_NETWORK_OUTCOME_UNKNOWN':'UNAUTHORIZED'},{status:failure==='unknown503'?503:401});
  };
  assert.equal(await f.live.prepareRuntimeEnvironment(),false);const raw=f.storage.getItem(storageKey);
  assert.equal(f.state().uncertain,true);assert.equal(f.state().blocked,true);assert.equal(f.original().receipt,null);assert.equal(f.reads().length,0);
  assert.deepEqual(f.original().request,JSON.parse(f.posts()[0].raw));assert.equal(await f.live.prepareRuntimeEnvironment(),false);
  await setImmediate();assert.equal(f.posts().length,1);assert.equal(f.storage.getItem(storageKey),raw);
});
for(const drift of ['session','workspace','config','control','closed'] as const)test(`late POST receipt after ${drift} cannot refresh/install or release original`,async t=>{
  const f=await fixture(t),gate=deferred<unknown>();f.post=()=>gate.promise;
  const pending=f.live.prepareRuntimeEnvironment();const raw=f.storage.getItem(storageKey);
  if(drift==='session')f.b.project.sessionId=f.b.session.sessionId='other';
  if(drift==='workspace')f.b.project.workspaceVersion=f.b.session.workspaceVersion=2;
  if(drift==='config')f.b.project.capabilities.execution.runtime.configurationGeneration=f.b.project.capabilities.language.configurationGeneration='cfg2';
  if(drift==='control')f.receive('CONTROL_PREPARE',{requestId:'prepare',purpose:'demo',path:'main.txt',basedOnWorkspaceVersion:1});
  else if(drift==='closed')f.live.close();else await f.snapshot();
  const before=structuredClone(f.live.getState().runtime!.execution);gate.resolve(prepared());assert.equal(await pending,false);
  assert.equal(f.storage.getItem(storageKey),raw);assert.equal(f.reads().length,0);assert.equal(f.posts().length,1);assert.deepEqual(f.live.getState().runtime!.execution,before);
});
test('ordinary editor HTTP remains bounded at5000ms (fakeclock)',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});const f=await fixture(t);
  (f.live as any).fetcher=async(_input:unknown,init:RequestInit)=>waitForAbort(init.signal!);
  const check=assert.rejects((f.live as any).http('/api/file?path=main.txt'),/5 s/);
  t.mock.timers.tick(4999);await setImmediate();t.mock.timers.tick(1);await check;assert.equal(f.posts().length,0);
});

for(const disconnect of [false,true])test(`UNIT actual HTTP abort after durable CONFIRMED_ID; WS disconnect=${disconnect}; supported exact-original read-first resolution, no second create`,{timeout:15000},async t=>{
  const f=await httpNetworkFixture(t),app=f.app(),port=await app.listen(),p=(await f.http(port,'GET','/api/project')).body,peer=await f.connect(port,p.sessionId);
  const original={requestId:randomUUID(),clientId:'tab',sessionId:p.sessionId,expectedWorkspaceVersion:p.workspaceVersion,
    configurationGeneration:p.capabilities.execution.runtime.configurationGeneration,controlEpoch:app.session.state.controlEpoch};
  const responseFile=path.join(f.state,'service-network','response-001.json'),receiptFile=path.join(f.state,'service-network','receipt.json');
  const gate=deferred<void>(),entered=deferred<void>(),run=f.fake.run.bind(f.fake);let held=false;
  f.fake.run=async(args)=>{
    // Actual helper persists response before starting post-create observe(). Hold its first info.
    if(!held&&args[0]==='info'&&fs.existsSync(responseFile)){held=true;entered.resolve();await gate.promise;}
    return run(args);
  };
  t.after(()=>gate.resolve());const controller=new AbortController();
  const pending=fetch(`http://127.0.0.1:${port}/api/runtime/service-network/prepare`,{method:'POST',signal:controller.signal,
    headers:{Authorization:`Bearer ${f.token}`,'Content-Type':'application/json'},body:JSON.stringify(original)});
  const aborted=assert.rejects(pending,{name:'AbortError'});await entered.promise;
  const responseBytes=fs.readFileSync(responseFile);assert.equal(JSON.parse(responseBytes.toString()).outcome,'CONFIRMED_ID');
  assert.equal(fs.existsSync(receiptFile),false);controller.abort();await aborted;
  if(disconnect){const closed=once(peer.ws,'close');peer.ws.close();await closed;await until(()=>app.session.state.controlEpoch!==original.controlEpoch);}
  gate.resolve();
  const directory=path.join(f.project,'.paircoach','runtime-network-maintenance');
  const records=()=>fs.readdirSync(directory).filter(n=>n.endsWith('.json'));
  await until(()=>records().length===1);const file=path.join(directory,records()[0]);
  if(disconnect) {
    // A queued read-only GET waits behind the source FIFO, so original perform has settled.
    assert.equal((await f.http(port,'GET','/api/file?path=main.js')).status,200);
    const retained=JSON.parse(fs.readFileSync(file,'utf8'));assert.equal(retained.body.state,'PENDING');assert.equal(retained.body.result,null);
    assert.equal(fs.existsSync(receiptFile),false,'revoked lease cannot mint receipt');assert.deepEqual(retained.body.request,original);
    await f.connect(port,p.sessionId);
  } else await until(()=>JSON.parse(fs.readFileSync(file,'utf8')).body.state==='PREPARED');
  const wire=JSON.stringify(original),recovered=await f.http(port,'POST','/api/runtime/service-network/prepare',JSON.parse(wire));
  assert.equal(recovered.status,200,JSON.stringify(recovered));assert.equal(recovered.body.networkId,f.getNetwork()!.Id);
  assert.equal(f.networkCalls.filter(a=>a[1]==='create').length,1);assert.deepEqual(fs.readFileSync(responseFile),responseBytes);
  const terminal=JSON.parse(fs.readFileSync(file,'utf8'));assert.equal(terminal.body.state,'PREPARED');assert.deepEqual(terminal.body.request,original);
  assert.equal(JSON.parse(fs.readFileSync(receiptFile,'utf8')).networkId,recovered.body.networkId);
  assert.ok(f.networkCalls.every(a=>['ls','inspect','create'].includes(a[1])),'no delete/connect/new network');
});
