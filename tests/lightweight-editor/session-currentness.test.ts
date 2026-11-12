/** Targeted structural regression for LIVE B: a view/timer-only SESSION_STATE is not a new editor authority.
 * Transport doubles here do NOT prove production WS or real Monaco. GUI harness is separate.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { LiveBackend } from '../../src/services/LiveBackend';
import { bundle,doc } from '../frontend-cutover/fixtures';

async function setup(t:any) {
  const b=bundle();
  (b as any).languageBootstrap={connectionGeneration:'server-local',shadowGeneration:'local-lifetime',provider:'builtin'};
  const socket:any={readyState:1,send(){},close(){this.readyState=3;}};
  const live=new LiveBackend({token:'unit-only',clientId:'c1',socket:()=>socket,fetch:(async(input)=>{
    const url=new URL(String(input));return Response.json(url.pathname==='/api/project'?b.project:url.pathname==='/api/session'?b.session:url.pathname==='/api/snapshots'?[]:doc(url.searchParams.get('path')??'main.txt'));
  }) as typeof fetch});t.after(()=>live.close());
  let seq=0;const receive=(type:string,payload:any)=>live.receive({protocolVersion:'3.0',messageId:`s${seq+1}`,sessionId:'s1',seq:++seq,type,payload} as any);
  await live.connect();receive('SESSION_SNAPSHOT',b);await setImmediate();assert.equal(live.getState().isOffline,false);
  const events:any[]=[];live.getEditorLanguageBinding()!.subscribe(e=>events.push(e));
  return {b,live,events,receive};
}

test('view/timer-only SESSION_STATE preserves the current local completion authority',async t=>{
  const f=await setup(t);
  f.receive('SESSION_STATE',{...structuredClone(f.b.session),activeFilePath:'other.txt',timer:{...f.b.session.timer,elapsedMs:1000,serverTime:'2026-11-12T12:00:00.000Z'}});
  assert.deepEqual(f.events,[],'cursor/view/timer publications must not dismiss a current local completion');
});
test('actual ownership/epoch change still invalidates completion; same-epoch PREPARE remains fenced',async t=>{
  const f=await setup(t);
  f.receive('CONTROL_PREPARE',{requestId:'prepare',purpose:'edit',path:'main.txt',basedOnWorkspaceVersion:1});
  assert.equal(f.events[0].type,'CONTROL_PREPARE');f.events.length=0;
  f.receive('SESSION_STATE',structuredClone(f.b.session));
  assert.equal(f.events.length,0,'same epoch is not a new grant after PREPARE');
  f.receive('SESSION_STATE',{...structuredClone(f.b.session),writeOwner:'COACH',controlEpoch:1});
  assert.ok(f.events.some(e=>e.type==='AUTHORITY_CHANGED'),'real changed authority must remain failclosed');
});
