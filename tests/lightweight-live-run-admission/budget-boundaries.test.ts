/** Deterministic client timer boundaries; transport doubles, not server/runtime proof. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { LiveBackend } from '../../src/services/LiveBackend';
import { bundle,doc } from '../frontend-cutover/fixtures';
async function fixture(t:test.TestContext,timeoutMs:number,kind:'RUN'|'SAVE'='RUN'){
  const b=bundle();b.project.settings.runProfiles[0].timeoutMs=timeoutMs;
  const calls:{path:string;body:any;signal:AbortSignal}[]=[];
  const socket:any={readyState:1,onopen:null,onmessage:null,onclose:null,onerror:null,send(){},close(){this.readyState=3;}};
  const live=new LiveBackend({token:'unit',clientId:'c1',socket:()=>socket,fetch:(async(input,init)=>{
    const url=new URL(String(input));
    if(init?.body && url.pathname===(kind==='RUN'?'/api/run':'/api/project/settings')){
      calls.push({path:url.pathname,body:JSON.parse(String(init.body)),signal:init.signal!});
      return new Promise<Response>((_resolve,reject)=>{
        const fail=()=>reject(new DOMException('Local wait aborted','AbortError'));
        if(init.signal!.aborted)fail();else init.signal!.addEventListener('abort',fail,{once:true});
      });
    }
    return Response.json(url.pathname==='/api/project'?b.project:url.pathname==='/api/session'?b.session:url.pathname==='/api/snapshots'?[]:doc(url.searchParams.get('path')??'main.txt'));
  }) as typeof fetch});
  t.after(()=>live.close());await live.connect();
  live.receive({protocolVersion:'3.0',messageId:'snapshot',sessionId:'s1',seq:1,type:'SESSION_SNAPSHOT',payload:b} as any);await setImmediate();
  return {live,b,calls};
}
for(const timeoutMs of [1000,120000,900000,3600000])test(`RUN uses selected ${timeoutMs}ms budget with 30s floor and retains unknown at its real deadline`,async t=>{
  const f=await fixture(t,timeoutMs);t.mock.timers.enable({apis:['setTimeout']});
  const pending=f.live.run(true);await setImmediate();assert.equal(f.calls.length,1);
  const original=structuredClone(f.calls[0].body),budget=Math.max(30000,timeoutMs);
  t.mock.timers.tick(budget-1);await setImmediate();assert.equal(f.calls[0].signal.aborted,false);
  await f.live.run(true);assert.equal(f.calls.length,1);
  t.mock.timers.tick(1);await pending;
  assert.equal(f.calls[0].signal.aborted,true);
  assert.equal(f.live.getState().runtime?.reconciliationRequired,true);
  assert.match(f.live.getState().runtime?.error??'',new RegExp(`\\(${budget/1000} s\\)`));
  await f.live.run(true);assert.equal(f.calls.length,1);assert.deepEqual(f.calls[0].body,original);
  assert.equal((await f.live.saveRuntimeSettings(f.b.project.settings,1)).ok,false);
});
test('ordinary SAVE keeps its unchanged 5s bound and uncertainty fence',async t=>{
  const f=await fixture(t,900000,'SAVE');t.mock.timers.enable({apis:['setTimeout']});
  const pending=f.live.saveRuntimeSettings(f.b.project.settings,1);await setImmediate();assert.equal(f.calls.length,1);
  t.mock.timers.tick(4999);assert.equal(f.calls[0].signal.aborted,false);
  t.mock.timers.tick(1);assert.equal((await pending).ok,false);
  assert.equal(f.calls[0].signal.aborted,true);assert.equal(f.live.getState().runtime?.reconciliationRequired,true);
  assert.match(f.live.getState().runtime?.error??'',/\(5 s\)/);
});
