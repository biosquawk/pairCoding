/** The original WS ERROR has requestId:null. Temporal Run success is not correlation.
 * Transport doubles verify that a TS-only fix does not hide this OPEN problem. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { LiveBackend } from '../../src/services/LiveBackend';
import { bundle,doc } from '../frontend-cutover/fixtures';
import { run } from '../client-v2/fixtures';
async function setup(t:any) {
  const b=bundle(),socket:any={readyState:1,send(){},close(){this.readyState=3;}};
  const live=new LiveBackend({token:'unit-only',clientId:'c1',socket:()=>socket,fetch:(async input=>{
    const url=new URL(String(input));return Response.json(url.pathname==='/api/project'?b.project:url.pathname==='/api/session'?b.session:url.pathname==='/api/snapshots'?[]:doc(url.searchParams.get('path')??'main.txt'));
  }) as typeof fetch});t.after(()=>live.close());
  let seq=0;const receive=(type:string,payload:any)=>live.receive({protocolVersion:'3.0',messageId:`s${seq+1}`,sessionId:'s1',seq:++seq,type,payload} as any);
  await live.connect();receive('SESSION_SNAPSHOT',b);await setImmediate();assert.equal(live.getState().isOffline,false);
  const error=(code:string,requestId:string|null=null)=>receive('ERROR',{code,message:'Original failure remains visible.',retryable:false,requestId,currentVersion:null});
  return {live,receive,error};
}
test('uncorrelated current WORKSPACE_BUSY is NOT cleared by later RUNNING/SUCCEEDED or another file read',async t=>{
  const f=await setup(t);f.error('WORKSPACE_BUSY');const original=f.live.getState().connectionError;
  f.receive('RUN_STATE',run());f.receive('RUN_STATE',{...run(),status:'SUCCEEDED',exitCode:0,finishedAt:'2026-11-11T21:01:00.000Z'});
  await f.live.selectFile('other.txt');assert.equal(f.live.getState().connectionError,original);
});
test('later uncorrelated error, auth failure and correlated rejection are never blanket-cleared by Run success',async t=>{
  for(const [code,requestId] of [['WORKSPACE_BUSY',null],['AUTH_REQUIRED',null],['DECISION_REJECTED','original-request']] as const) {
    const f=await setup(t);f.error('WORKSPACE_BUSY');f.error(code,requestId);
    const notice=f.live.getState().connectionError;f.receive('RUN_STATE',{...run(),status:'SUCCEEDED',exitCode:0,finishedAt:'2026-11-11T21:01:00.000Z'});
    assert.equal(f.live.getState().connectionError,notice);
  }
});
