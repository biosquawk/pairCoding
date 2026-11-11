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

// New central contract cases: controlled authenticated transport, never backend commit proof.
import { validateV2WireShape } from '../../src/shared/validation-v2';
import { contentSha256 } from '../../src/language/uriCodec';
import type { ModelSnapshot } from '../../src/services/monacoLspBridge';
async function languageFixture(t:any) {
  const f=await fixture(t);(f.b as any).languageBootstrap={connectionGeneration:'server-connection',shadowGeneration:'server-shadow',provider:'remote'};
  assert.ok(validateV2WireShape('SessionBundle',f.b),'new fixture must satisfy actual frozen complete bundle schema');
  await f.snapshot();
  const binding=f.live.getEditorLanguageBinding()!;
  const model:ModelSnapshot={path:'main.txt',modelLifetime:'actual-lifetime',localModelVersion:1,content:'draft',contentSha256:contentSha256('draft')};
  const document=(reason:'OPEN'|'TYPING')=>{const authority=binding.readAuthority(model)!;assert.ok(authority);return {stamp:{...authority.stamp,path:model.path,modelLifetime:model.modelLifetime,localModelVersion:model.localModelVersion,contentSha256:model.contentSha256},content:model.content,reason};};
  binding.sendDocument('OPEN',document('OPEN'));
  const type=(text:string)=>{f.live.saveFileContent(model.path,text);model.content=text;model.contentSha256=contentSha256(text);model.localModelVersion++;binding.sendDocument('CHANGE',document('TYPING'));};
  t.mock.timers.enable({apis:['setTimeout']});
  const begin=()=>{type('typed');t.mock.timers.tick(150);const save=f.sent.filter(m=>m.type==='CODE_CHANGED').at(-1),source=f.sent.find(m=>m.messageId===save?.payload.languageDocumentMessageId);return {save,source};};
  const diagnostic=(source:any,receiptId='genuine-ack')=>({sourceStamp:source.payload.stamp,presentationStamp:document('TYPING').stamp,association:{saveReceiptId:receiptId},
    provenance:{kind:'IMMUTABLE_GENERATION' as const,launchId:'fixed-server-analysis',lspVersion:null,inputManifestSha256:contentSha256('server-whole-project-input')},items:[],truncated:false});
  const acknowledge=(save:any,status='OK',overrides:any={})=>f.receive('ACK',{replyTo:save.messageId,status,documentVersion:2,workspaceVersion:2,controlEpoch:0,error:null,...overrides},{messageId:'genuine-ack'});
  return {...f,binding,model,document,type,begin,diagnostic,acknowledge};
}
test('coherent server bootstrap enables actual LANGUAGE_OPEN; exact sent source -> sole save -> genuine envelope alias',async t=>{
  const f=await languageFixture(t),{save,source}=f.begin();assert.ok(source);assert.equal(source.type,'LANGUAGE_CHANGE');
  assert.equal(f.sent.filter(m=>m.type==='CODE_CHANGED').length,1);assert.equal(source.payload.content,save.payload.content);
  const before=f.sent.filter(m=>m.type==='LANGUAGE_CHANGE').length;
  f.acknowledge(save);assert.equal(f.live.getState().pendingPaths.length,0);
  const r=f.diagnostic(source),copy=structuredClone(r);assert.equal(f.binding.verifyDiagnostics(r,[f.model]),true);
  const events:any[]=[];f.binding.subscribe(e=>events.push(e));f.receive('DIAGNOSTICS',r);assert.equal(events.filter(e=>e.type==='DIAGNOSTICS').length,1);
  assert.deepEqual(r,copy,'source and server provenance remain untouched');
  assert.equal(f.sent.filter(m=>m.type==='LANGUAGE_CHANGE').length,before,'ACK is not didChange');
  assert.equal(f.binding.verifyDiagnostics(f.diagnostic(source,'forged-receipt'),[f.model]),false);
  assert.equal(f.sent.some(m=>m.type==='LANGUAGE_ACK'),false);
});
test('DUPLICATE exact original autosave ACK can alias, never another transaction or old disk version',async t=>{
  const f=await languageFixture(t),{save,source}=f.begin();f.acknowledge(save,'DUPLICATE');assert.equal(f.binding.verifyDiagnostics(f.diagnostic(source),[f.model]),true);
});
for(const mutation of ['ABA','new lifetime','inactive overlay','dependency','new draft','scope','foreign transaction','rejected','old disk','old workspace'] as const) {
  test(`ACK alias rejects ${mutation}, even same hash/receipt present`,async t=>{
    const f=await languageFixture(t);
    if(mutation==='inactive overlay')f.receive('EXTERNAL_FILE_SYNC',{operation:'CREATED',path:'other.txt',version:1,workspaceVersion:2,document:doc('other.txt','dependency')});
    const {save,source}=f.begin();assert.ok(source);
    if(mutation==='ABA'){f.type('other');f.type('typed');}
    if(mutation==='new lifetime'){f.model.modelLifetime='recreated-lifetime';f.binding.sendDocument('OPEN',f.document('OPEN'));}
    if(mutation==='inactive overlay')f.binding.readAuthority({path:'other.txt',modelLifetime:'inactive-new',localModelVersion:1,content:'dependency',contentSha256:contentSha256('dependency')});
    if(mutation==='dependency')f.receive('EXTERNAL_FILE_SYNC',{operation:'CREATED',path:'other.txt',version:1,workspaceVersion:2,document:doc('other.txt','dep')});
    if(mutation==='new draft')f.type('newer');
    if(mutation==='scope'){(f.b as any).languageBootstrap.connectionGeneration='new-server-connection';await f.snapshot();}
    f.acknowledge(save,mutation==='rejected'?'REJECTED':'OK',mutation==='foreign transaction'?{replyTo:'foreign'}:mutation==='old disk'?{documentVersion:1}:mutation==='old workspace'?{workspaceVersion:1}:{});
    const r=f.diagnostic(source);assert.equal(f.binding.verifyDiagnostics(r,[f.model]),false);
    assert.equal(f.sent.filter(m=>m.type==='CODE_CHANGED').length,1,'no second save invented by alias handling');
  });
}
test('missing, extra or incoherent bootstrap never synthesized from LANGUAGE_STATUS/diagnostic or client id',async t=>{
  const f=await fixture(t),binding=f.live.getEditorLanguageBinding()!;
  for(const bootstrap of [undefined,null,{connectionGeneration:'a',shadowGeneration:'s',provider:'remote',extra:true},{connectionGeneration:'a',shadowGeneration:'s',provider:'unknown'}]){
    (f.b as any).languageBootstrap=bootstrap;
    if(bootstrap!==null){assert.throws(()=>f.receive('SESSION_SNAPSHOT',f.b),/SESSION_SNAPSHOT V2/);}else await f.snapshot();
    assert.equal(binding.readAuthority({path:'main.txt',modelLifetime:'life',localModelVersion:1,content:'draft',contentSha256:contentSha256('draft')}),null);
  }
  (f.b as any).languageBootstrap={connectionGeneration:'a',shadowGeneration:'s',provider:'remote'};
  f.b.project.capabilities.language.configurationGeneration='foreign';await f.snapshot();assert.equal(f.live.getState().language?.autocomplete,'OFF');
});

test('strict reconcile uses exact retained authenticated full request and separate current snapshot; UNKNOWN keeps fence',async t=>{
  let answer:any;const f=await fixture(t,(path,body)=>{if(path==='/api/run')throw new Error('lost');assert.equal(path,'/api/runtime/mutation/reconcile');return answer(body.mutation);});
  await f.live.run(true);const original=f.http.find(v=>v.path==='/api/run').body;
  answer=(mutation:any)=>({mutation,state:'UNKNOWN',result:null,current:null});assert.equal(await f.live.reconcileRuntimeMutation(),false);assert.equal(f.live.getState().runtime?.reconciliationRequired,true);
  answer=(mutation:any)=>({mutation,state:'COMMITTED',result:run(),current:{project:f.b.project,run:run()}});
  assert.equal(await f.live.reconcileRuntimeMutation(),true);assert.equal(f.live.getState().runtime?.reconciliationRequired,false);assert.equal(f.live.getState().runtime?.run?.runId,'run1');
  const request=f.http.filter(v=>v.path==='/api/runtime/mutation/reconcile').at(-1);assert.equal(request.headers.Authorization,'Bearer authenticated');assert.deepEqual(request.body.mutation.request,original);
  assert.equal(f.http.filter(v=>v.path==='/api/run').length,1,'read never resends a mutation');
});
test('SAVE reconcile retains immutable original settings despite caller edits; applies current not retained admission result',async t=>{
  let original:any;const f=await fixture(t,(path,body)=>{
    if(path==='/api/project/settings'){original=structuredClone(body);throw new Error('lost save');}
    const result={...f.b.project,workspaceVersion:2,settings:original.settings},current={...f.b.project,workspaceVersion:3,settings:{...original.settings,contextPatterns:['new-current/**']}};
    return {mutation:body.mutation,state:'COMMITTED',result,current:{project:current,run:null}};
  });
  const next={...f.b.project.settings,contextPatterns:['original/**']};await f.live.saveRuntimeSettings(next,1);next.contextPatterns.push('forged-after-send/**');
  assert.equal(await f.live.reconcileRuntimeMutation(),true);assert.equal(f.live.getState().workspaceVersion,3);assert.deepEqual(f.live.getState().projectSettings.runtimeSettings?.contextPatterns,['new-current/**']);
  assert.deepEqual(f.http.find(v=>v.path==='/api/runtime/mutation/reconcile').body.mutation.request.settings.contextPatterns,['original/**']);
});
for(const invalid of ['different echo','foreign current','extra field','UNKNOWN current','unreadable','stale scope'] as const) {
  test(`reconcile ${invalid} cannot clear fence or dispatch another mutation`,async t=>{
    const f=await fixture(t,async(path,body)=>{
      if(path==='/api/run')throw new Error('lost');
      if(invalid==='unreadable')throw new Error('unavailable');
      if(invalid==='stale scope')await f.snapshot();
      const response:any={mutation:structuredClone(body.mutation),state:'DEFINITIVELY_ABORTED',result:null,current:{project:structuredClone(f.b.project),run:null}};
      if(invalid==='different echo')response.mutation.request.mode='RUN_MAIN';
      if(invalid==='foreign current')response.current.project.sessionId='foreign';
      if(invalid==='extra field')response.definitive=true;
      if(invalid==='UNKNOWN current')response.state='UNKNOWN';
      return response;
    });
    await f.live.run(true);assert.equal(await f.live.reconcileRuntimeMutation(),false);assert.equal(f.live.getState().runtime?.reconciliationRequired,true);
    await f.live.run(true);assert.equal(f.http.filter(v=>v.path==='/api/run').length,1);f.live.saveFileContent('main.txt','manual survives');assert.ok(f.live.getState().pendingPaths.includes('main.txt'));
  });
}

test('actual Monaco listener before React autosave mirror preserves exact source ID without receipt-time rebinding',async t=>{
  const f=await languageFixture(t);
  f.model.content='typed';f.model.contentSha256=contentSha256('typed');f.model.localModelVersion++;
  f.binding.sendDocument('CHANGE',f.document('TYPING'));
  const source=f.sent.filter(m=>m.type==='LANGUAGE_CHANGE').at(-1);
  f.live.saveFileContent('main.txt','typed');t.mock.timers.tick(150);
  const save=f.sent.find(m=>m.type==='CODE_CHANGED');assert.equal(save.payload.languageDocumentMessageId,source.messageId);
  f.acknowledge(save);assert.equal(f.binding.verifyDiagnostics(f.diagnostic(source),[f.model]),true);
});

test('FAILED authoritative provider status cancels old authority and survives ordinary state publication',async t=>{
  const f=await languageFixture(t);f.begin();
  const problem={code:'LANGUAGE_UNAVAILABLE',message:'Provider unavailable',recovery:'Reconnect provider',retryable:true};
  f.receive('LANGUAGE_STATUS',{...f.b.project.capabilities.language,state:'FAILED',autocomplete:'FAILED',problem});
  assert.equal(f.live.getState().language?.state,'FAILED');assert.equal(f.binding.readAuthority(f.model),null);
  f.live.saveFileContent('main.txt','manual after failure');assert.equal(f.live.getState().language?.state,'FAILED');assert.equal(f.live.getState().languageProblem,problem.message);
});

test('malformed ACK shape never grants a language alias while ordinary negative VIEW handling stays separate',async t=>{
  const f=await languageFixture(t),{save,source}=f.begin();
  f.acknowledge(save,'OK',{error:{code:'BAD',message:'incomplete legacy error',currentVersion:null}});
  assert.equal(f.binding.verifyDiagnostics(f.diagnostic(source),[f.model]),false);
});

test('actual LiveBackend wrapper resolves retained old-session exact original through fresh same-project current authority',async t=>{
  let unknown=true;
  const f=await fixture(t,(path,body)=>{
    if(path==='/api/run')throw Error('original s1 unknown');
    assert.equal(path,'/api/runtime/mutation/reconcile');assert.equal(body.mutation.request.sessionId,'s1');assert.equal(body.mutation.request.clientId,'c1');
    return unknown?{mutation:body.mutation,state:'UNKNOWN',result:null,current:null}:{mutation:body.mutation,state:'DEFINITIVELY_ABORTED',result:null,current:{project:f.b.project,run:null}};
  });
  await f.live.run(true);const original=f.http.find(v=>v.path==='/api/run').body;
  f.b.project={...f.b.project,sessionId:'s2'};f.b.session={...f.b.session,sessionId:'s2'};
  f.live.reconnect();f.socket.readyState=1;await f.live.connect();f.receive('SESSION_SNAPSHOT',f.b,{sessionId:'s2'});await setImmediate();
  assert.equal(f.live.getState().isOffline,false);assert.equal(f.live.getState().runtime?.project?.sessionId,'s2');assert.equal(f.live.getState().runtime?.reconciliationRequired,true);
  await f.live.run(true);assert.equal((await f.live.saveRuntimeSettings(f.b.project.settings,1)).ok,false);assert.equal(f.http.filter(v=>v.path==='/api/run').length,1);
  assert.equal(await f.live.reconcileRuntimeMutation(),false);assert.equal(f.live.getState().runtime?.reconciliationRequired,true);
  unknown=false;assert.equal(await f.live.reconcileRuntimeMutation(),true);assert.equal(f.live.getState().runtime?.project?.sessionId,'s2');assert.equal(f.live.getState().runtime?.reconciliationRequired,false);
  assert.deepEqual(f.http.filter(v=>v.path==='/api/runtime/mutation/reconcile').map(v=>v.body.mutation.request),[original,original]);
  assert.equal(f.http.filter(v=>v.path==='/api/run').length,1,'no automatic replay of the original mutation');
});
