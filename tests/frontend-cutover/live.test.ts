/** UNIT transport doubles exercise actual LiveBackend/RuntimeClient receive and HTTP wiring.
 * No real server, LSP, Docker or Monaco acceptance claim. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { LiveBackend } from '../../src/services/LiveBackend';
import { project, run, hash } from '../client-v2/fixtures';
import { validateRunRequestV2, validateUpdateSettingsRequestV2 } from '../../src/shared/validation-v2';
import { bundle,doc } from './fixtures';
export async function fixture(t:any,command?:(path:string,body:any)=>unknown|Promise<unknown>) {
  const b=bundle(),sent:any[]=[],http:any[]=[];let seq=0;
  const socket:any={readyState:1,onopen:null,onmessage:null,onclose:null,onerror:null,send(raw:string){sent.push(JSON.parse(raw));},close(){this.readyState=3;}};
  const live=new LiveBackend({token:'authenticated',clientId:'c1',socket:()=>socket,fetch:(async(input,options)=>{
    const url=new URL(String(input)),body=options?.body?JSON.parse(String(options.body)):null;
    http.push({path:url.pathname,body,headers:options?.headers});
    if(body && command && url.pathname!=='/api/project/open') return Response.json(await command(url.pathname,body));
    return Response.json(url.pathname==='/api/project'?b.project:url.pathname==='/api/session'?b.session:url.pathname==='/api/snapshots'?[]:doc(url.searchParams.get('path')??'main.txt'));
  }) as typeof fetch});t.after(()=>live.close());
  const receive=(type:string,payload:any,overrides:any={})=>live.receive({protocolVersion:'3.0',messageId:`s${seq+1}`,sessionId:'s1',seq:++seq,type,payload,...overrides} as any);
  const snapshot=async()=>{receive('SESSION_SNAPSHOT',b);await setImmediate();assert.equal(live.getState().isOffline,false);};
  await live.connect();await snapshot();
  return {live,b,sent,http,receive,snapshot,socket};
}
test('same authenticated V2 Run/Stop HTTP bodies, current workspace and no second client',async t=>{
  const f=await fixture(t,(path,body)=>{if(path==='/api/run'){assert.ok(validateRunRequestV2(body));return run();}return {...run(),status:'CANCELLED',finishedAt:'2026-11-11T21:00:01.000Z'};});
  await f.live.run(true);assert.equal(f.live.getState().runtime?.run?.runId,'run1');
  const request=f.http.find(r=>r.path==='/api/run');assert.equal(request.headers.Authorization,'Bearer authenticated');assert.equal(request.body.configurationGeneration,'cfg1');
  await f.live.stopExecution();assert.equal(f.live.getState().runtime?.run?.status,'CANCELLED');assert.equal(f.http.filter(r=>r.path==='/api/run/run1/stop').length,1);
});
test('unknown Run blocks new Run AND Save; readiness/snapshot/reconnect cannot clear, manual draft available',async t=>{
  const f=await fixture(t,()=>{throw new Error('lost response after possible commit');});
  await f.live.run(true);assert.equal(f.live.getState().runtime?.reconciliationRequired,true);
  await f.snapshot();await f.live.run(true);
  const result=await f.live.saveRuntimeSettings(f.b.project.settings,1);assert.equal(result.ok,false);
  assert.equal(f.http.filter(r=>r.path==='/api/run').length,1);assert.equal(f.http.some(r=>r.path==='/api/project/settings'),false);
  f.live.saveFileContent('main.txt','manual still works');assert.equal(f.live.getState().files.find(v=>v.path==='main.txt')?.content,'manual still works');
});
test('unknown SAVE fences Run/save and retains exact metadata; confirmed V2 preserves consent/context/task',async t=>{
  const f=await fixture(t,(path,body)=>{assert.ok(validateUpdateSettingsRequestV2(body));assert.equal(path,'/api/project/settings');throw new Error('save unknown');});
  const next={...f.b.project.settings,aiConsent:true,contextPatterns:['other/**'],reviewNotesPath:'notes.md'};
  const first=await f.live.saveRuntimeSettings(next,1);assert.equal(first.ok,false);assert.equal(f.live.getState().runtime?.reconciliationRequired,true);
  assert.deepEqual(f.http.find(v=>v.path==='/api/project/settings').body.settings,next);
  await f.snapshot();await f.live.run(true);assert.equal(f.http.some(v=>v.path==='/api/run'),false);
  assert.equal(f.live.getState().projectSettings.runtimeSettings?.aiConsent,false,'unconfirmed settings never become current');
});
test('confirmed save uses V2 only, returns new project and retains non-runtime metadata',async t=>{
  const f=await fixture(t,(_path,body)=>{assert.ok(validateUpdateSettingsRequestV2(body));return {...f.b.project,settings:body.settings,workspaceVersion:2};});
  const next={...f.b.project.settings,aiConsent:true,contextPatterns:['more/**'],taskFilePath:null,reviewNotesPath:'notes.md'};
  const result=await f.live.saveRuntimeSettings(next,1);assert.equal(result.ok,true);assert.equal(f.live.getState().workspaceVersion,2);assert.deepEqual(f.live.getState().projectSettings.runtimeSettings,next);
});
test('PREPARE invalidates synchronously FIRST even denied; common sequence admits interleaved language once',async t=>{
  const f=await fixture(t);const binding=f.live.getEditorLanguageBinding()!,events:string[]=[];
  binding.subscribe(e=>events.push(e.type));const send=f.socket.send;f.socket.send=(raw:string)=>{events.push(JSON.parse(raw).type);send(raw);};
  f.live.saveFileContent('main.txt','new draft');
  // A rejected prepare (veto pending) still invalidates before CONTROL_READY false.
  f.live.triggerVeto();events.length=0;
  f.receive('CONTROL_PREPARE',{requestId:'prepare',purpose:'demo',path:'main.txt',basedOnWorkspaceVersion:1});
  assert.equal(events[0],'CONTROL_PREPARE');assert.equal(events[1],'CONTROL_READY');assert.equal(f.sent.at(-1).payload.ready,false);
  f.receive('CHAT_REPLY',{replyTo:null,text:'interleaved'});
  f.receive('LANGUAGE_STATUS',f.b.project.capabilities.language);
  f.receive('CHAT_REPLY',{replyTo:null,text:'after-language'});
  assert.equal(f.live.getState().chatEntries.at(-1)?.message,'after-language');assert.doesNotMatch(f.live.getState().connectionError??'',/Luka/);
  assert.throws(()=>f.receive('LANGUAGE_STATUS',f.b.project.capabilities.language,{sessionId:'foreign'}),/koperta/);
  assert.equal(f.sent.some(m=>m.type==='LANGUAGE_OPEN'),false,'missing server bootstrap never fabricated from incoming status');
});
test('PREPARE accepted path invalidates BEFORE sole autosave flush; offline and Veto before publication',async t=>{
  const f=await fixture(t),events:string[]=[];f.live.getEditorLanguageBinding()!.subscribe(e=>events.push(e.type));
  const send=f.socket.send;f.socket.send=(raw:string)=>{events.push(JSON.parse(raw).type);send(raw);};
  f.live.saveFileContent('main.txt','new draft');f.receive('CONTROL_PREPARE',{requestId:'p',purpose:'demo',path:'main.txt',basedOnWorkspaceVersion:1});
  assert.equal(events[0],'CONTROL_PREPARE');assert.ok(events.indexOf('CODE_CHANGED')>0);assert.equal(f.sent.filter(m=>m.type==='CODE_CHANGED').length,1);
  events.length=0;f.live.triggerVeto();assert.equal(events[0],'VETO');assert.ok(events.indexOf('VETO_ESCAPE')>0);
  events.length=0;f.live.reconnect();assert.equal(events[0],'DISCONNECTED');
});
test('legacy/mixed settings never dispatch host Run nor host settings retry; raw remains inspectable',async t=>{
  const f=await fixture(t);const legacy={...f.b.project.settings,schemaVersion:999,runProfiles:[{kind:'RUN_MAIN',executable:'host-tool',args:[]}]};
  (f.b.project as any).settings=legacy;await f.snapshot();await f.live.run(false);
  assert.equal(f.http.some(v=>v.path==='/api/run'),false);assert.equal(f.live.getState().runtime?.project,null);
  assert.deepEqual(f.live.getState().projectSettings.rawSettings,legacy);assert.equal(await f.live.updateProjectSettings(f.live.getState().projectSettings),false);
  assert.equal(f.http.some(v=>v.path==='/api/project/settings'),false);
});
test('verified autosave response updates disk base only; no LANGUAGE_ACK/change, rejected/stale keep draft',async t=>{
  const f=await fixture(t);t.mock.timers.enable({apis:['setTimeout']});
  f.live.saveFileContent('main.txt','typed');t.mock.timers.tick(150);const save=f.sent.find(m=>m.type==='CODE_CHANGED');assert.ok(save);
  f.receive('ACK',{replyTo:save.messageId,status:'OK',documentVersion:2,workspaceVersion:2,controlEpoch:0,error:null});
  assert.equal(f.live.getState().pendingPaths.length,0);assert.equal(f.live.getState().files[0].content,'typed');
  assert.equal(f.sent.some(m=>m.type.startsWith('LANGUAGE_')),false);
  f.live.saveFileContent('main.txt','newer');t.mock.timers.tick(150);const next=f.sent.filter(m=>m.type==='CODE_CHANGED').at(-1);
  f.receive('ACK',{replyTo:next.messageId,status:'DUPLICATE',documentVersion:2,workspaceVersion:2,controlEpoch:0,error:null});
  assert.ok(f.live.getState().pendingPaths.includes('main.txt'));assert.equal(f.live.getState().files[0].content,'newer');
});

test('known same-run Stop survives unknown save fence and COACH ownership without enabling new Run',async t=>{
  const f=await fixture(t,(path,body)=>{
    if(path==='/api/run')return run();
    if(path==='/api/project/settings')throw new Error('unknown save');
    return {...run(),status:'CANCELLED',finishedAt:'2026-11-11T21:00:01.000Z'};
  });
  await f.live.run(true);await f.live.saveRuntimeSettings(f.b.project.settings,1);assert.equal(f.live.getState().runtime?.reconciliationRequired,true);
  f.receive('CONTROL_STATE',{writeOwner:'COACH',controlEpoch:1,coachMode:'INTERVENING',cooldownAfterVeto:false,interventionId:'coach',purpose:'demo'});
  await f.live.stopExecution();assert.equal(f.live.getState().runtime?.run?.status,'CANCELLED');assert.equal(f.live.getState().runtime?.reconciliationRequired,true);
  await f.live.run(true);assert.equal(f.http.filter(v=>v.path==='/api/run').length,1);
});
