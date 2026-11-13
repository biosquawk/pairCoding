/** OFFLINE source-bound LiveBackend -> RuntimeWiring -> MonacoLspBridge.
 * Controlled HTTP/socket/provider and structural DOM/model ports. No LIVE result attribution. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {setImmediate as tick} from 'node:timers/promises';
import {LiveBackend} from '../../src/services/LiveBackend';
import {MonacoLspBridge,toModelUri} from '../../src/services/monacoLspBridge';
import {URI} from 'monaco-editor/esm/vs/base/common/uri.js';
import {harness,Model} from '../../tests/editor-language/harness';
import {bundle,doc} from '../../tests/frontend-cutover/fixtures';
import {result} from '../../tests/editor-language/fixtures';
import {run} from '../../tests/client-v2/fixtures';
import {validateV2WireShape} from '../../src/shared/validation-v2';

async function fixture(t:any,open=false) {
 const b=bundle();b.activeDocument=doc('main.txt','base');
 (b as any).languageBootstrap={connectionGeneration:'fixture-connection',shadowGeneration:'fixture-lifetime',provider:'builtin',features:{completion:true,diagnostics:true}};
 assert.ok(validateV2WireShape('SessionBundle',b));
 const sent:any[]=[],events:any[]=[],calls:any[]=[];let seq=0;
 const socket:any={readyState:1,send(s:string){sent.push(JSON.parse(s));},close(){this.readyState=3;}};
 const live=new LiveBackend({token:'offline-fixture-token',clientId:'c1',socket:()=>socket,fetch:(async(input:any)=>{const u=new URL(String(input));return Response.json(u.pathname==='/api/project'?b.project:u.pathname==='/api/session'?b.session:u.pathname==='/api/snapshots'?[]:doc(u.searchParams.get('path')??'main.txt','base'));}) as any});
 t.after(()=>live.close());
 const receive=(type:string,payload:any)=>live.receive({protocolVersion:'3.0',messageId:'offline-'+(++seq),sessionId:'s1',seq,type,payload} as any);
 await live.connect();if(open)socket.onopen();receive('SESSION_SNAPSHOT',b);await tick();
 live.setBuiltinLanguageProvider(Object.assign((_m:any,r:any,signal:AbortSignal)=>new Promise(resolve=>calls.push({request:r,signal,resolve,abortObserved:false}) ).then(v=>v),{ready:async()=>true,hasDiagnostics:()=>false}) as any);
 const ports=harness();ports.bridge.dispose();const model=new Model('main.txt','obj.');model.uri=URI.parse(toModelUri('p1','main.txt'));ports.models.splice(0,ports.models.length,model);ports.switch(model);
 const binding=live.getEditorLanguageBinding()!;binding.subscribe(e=>events.push(e));
 const bridge=new MonacoLspBridge(ports.monaco,ports.editor,binding);t.after(()=>bridge.dispose());
 const shown=()=>ports.widgets[0].getDomNode().children.length;
 const request=()=>bridge.requestCompletion(null);
 const resolve=(i=0)=>calls[i].resolve(result(calls[i].request.stamp,calls[i].request.requestId));
 const sameControl={writeOwner:'STUDENT',controlEpoch:0,coachMode:'UNAVAILABLE',cooldownAfterVeto:false,interventionId:null,purpose:null};
 return {live,b,receive,sent,events,calls,model,bridge,request,resolve,shown,sameControl,socket};
}


async function dirty(f:any) {
 f.live.saveFileContent('main.txt','obj.');
 await new Promise(r=>setTimeout(r,170));
 const save=f.sent.find((v:any)=>v.type==='CODE_CHANGED');assert.ok(save);return save;
}
function ack(f:any,save:any) {f.receive('ACK',{replyTo:save.messageId,status:'OK',documentVersion:2,workspaceVersion:2,controlEpoch:0,error:null});}
function currentBundle(f:any) {
 const b=structuredClone(f.b);b.project.workspaceVersion=2;b.project.files[0].version=2;
 b.session.workspaceVersion=2;b.activeDocument=doc('main.txt','obj.',2);return b;
}
for(const publications of [['CONTROL_STATE'],['SESSION_SNAPSHOT'],['CONTROL_STATE','SESSION_SNAPSHOT']]) {
 test(`neutral ${publications.join('+')} preserves original dirty intent until genuine ACK refresh`,async t=>{
  const f=await fixture(t),save=await dirty(f),pending=f.request();assert.equal(f.calls.length,1);
  for(const type of publications){f.receive(type,type==='CONTROL_STATE'?f.sameControl:structuredClone(f.b));await tick();}
  assert.equal(f.calls[0].signal.aborted,false,'neutral publication must preserve original request');
  assert.equal(f.calls.length,1,'no publication-driven replacement');
  f.resolve();await pending;assert.equal(f.shown(),1,'original local response renders before ACK');
  ack(f,save);assert.equal(f.calls.length,2,'genuine ACK alone renews still-open same-buffer intent');
  // Resolved flights no longer own an AbortController; the pending-late case below checks cancellation.
  f.receive('SESSION_SNAPSHOT',currentBundle(f));await tick();
  assert.equal(f.calls[1].signal.aborted,false,'matching own-ACK files metadata must not retire renewed request');
  f.resolve(1);await tick();assert.equal(f.shown(),1);assert.equal(f.model.content,'obj.');
  assert.equal(f.live.getState().pendingPaths.length,0);assert.equal(f.sent.filter((v:any)=>v.type==='CODE_CHANGED').length,1);
 });
}
test('original response arriving after ACK is rejected; only genuine ACK replacement renders',async t=>{
 const f=await fixture(t),save=await dirty(f),pending=f.request();f.receive('CONTROL_STATE',f.sameControl);
 ack(f,save);assert.equal(f.calls.length,2);f.resolve(0);await pending;assert.equal(f.shown(),0);
 f.resolve(1);await tick();assert.equal(f.shown(),1);
});

for(const [name,mutate] of Object.entries({
 'source file version before ACK':(b:any)=>{b.project.workspaceVersion=2;b.session.workspaceVersion=2;b.project.files[0].version=2;b.activeDocument=doc('main.txt','obj.',2);},
 'active source bytes':(b:any)=>{b.activeDocument=doc('main.txt','foreign');},
 'readOnly':(b:any)=>{b.activeDocument.readOnly=true;},
 'document language':(b:any)=>{b.activeDocument.languageId='typescript';},
 'document EOL':(b:any)=>{b.activeDocument.eol='CRLF';},
 'document BOM':(b:any)=>{b.activeDocument.utf8Bom=true;},
 'session lifecycle':(b:any)=>{b.session.lifecycle='FINISHED';},
 'active path':(b:any)=>{b.session.activeFilePath=null;},
 'provider OFF':(b:any)=>{b.languageBootstrap.provider='off';b.languageBootstrap.features={completion:false,diagnostics:false};},
 'root':(b:any)=>{b.project.rootPath='/other';},
 'project':(b:any)=>{b.project.projectId='p2';b.session.projectId='p2';b.project.capabilities.language.projectId='p2';},
 'settings':(b:any)=>{b.project.settings.aiConsent=true;},
 'configuration':(b:any)=>{b.project.capabilities.language.configurationGeneration='cfg2';b.project.capabilities.execution.runtime.configurationGeneration='cfg2';},
 'profile':(b:any)=>{b.project.capabilities.language.profileId='profile2';b.project.capabilities.execution.runtime.profileId='profile2';},
 'provider generation':(b:any)=>{b.project.capabilities.language.providerGeneration='provider2';},
 'local connection generation':(b:any)=>{b.languageBootstrap.connectionGeneration='other-connection';},
 'local lifetime':(b:any)=>{b.languageBootstrap.shadowGeneration='other-lifetime';},
 'features':(b:any)=>{b.languageBootstrap.features.completion=false;},
 'file deleted':(b:any)=>{b.project.files=[];b.activeDocument=null;},
 'file renamed':(b:any)=>{b.project.files=[{path:'renamed.txt',kind:'FILE',version:1}];b.activeDocument=doc('renamed.txt','base');b.session.activeFilePath='renamed.txt';},
 'workspace version':(b:any)=>{b.project.workspaceVersion=2;b.session.workspaceVersion=2;},
 'control epoch':(b:any)=>{b.session.controlEpoch=1;},
 'COACH ownership':(b:any)=>{b.session.controlEpoch=1;b.session.writeOwner='COACH';b.session.coachMode='INTERVENING';b.session.interventionId='coach1';},
})) {
 test(`snapshot real drift ${name} retires original request; no replacement from later own ACK`,async t=>{
  const f=await fixture(t),save=await dirty(f),pending=f.request();const b=structuredClone(f.b);mutate(b);
  assert.ok(validateV2WireShape('SessionBundle',b),'adverse fixture is original wire-shaped');
  f.receive('SESSION_SNAPSHOT',b);await tick();assert.equal(f.calls[0].signal.aborted,true);
  ack(f,save);f.resolve();await pending;assert.equal(f.shown(),0);assert.equal(f.calls.length,1);
 });
}
for(const [name,state] of Object.entries({
 'COACH':{writeOwner:'COACH',controlEpoch:1,coachMode:'INTERVENING',interventionId:'coach1'},
 'epoch':{controlEpoch:1},
 'intervention':{interventionId:'new-intervention'},
 'cooldown':{cooldownAfterVeto:true},
}))test(`CONTROL_STATE real ${name} cancels original flight`,async t=>{
 const f=await fixture(t),pending=f.request();f.receive('CONTROL_STATE',{...f.sameControl,...state});
 assert.equal(f.calls[0].signal.aborted,true);f.resolve();await pending;assert.equal(f.shown(),0);
});

test('stale epoch publication does not restore or invalidate current newer request',async t=>{
 const f=await fixture(t);f.receive('CONTROL_STATE',{...f.sameControl,controlEpoch:2});const pending=f.request();
 f.receive('CONTROL_STATE',{...f.sameControl,controlEpoch:1,writeOwner:'COACH'});
 assert.equal(f.calls[0].signal.aborted,false);f.resolve();await pending;assert.equal(f.shown(),1);assert.equal(f.live.getState().controlEpoch,2);
});

test('pending PREPARE followed by same control/snapshot cannot renew dirty local intent',async t=>{
 const f=await fixture(t),save=await dirty(f),pending=f.request();
 f.receive('CONTROL_PREPARE',{requestId:'prepare1',path:'main.txt'});assert.equal(f.calls[0].signal.aborted,true);
 assert.equal(f.sent.filter((v:any)=>v.type==='CONTROL_READY'&&v.payload.ready).length,0,'save has no original ACK yet');
 f.receive('CONTROL_STATE',f.sameControl);f.receive('SESSION_SNAPSHOT',structuredClone(f.b));await tick();
 ack(f,save);f.resolve();await pending;await f.request();assert.equal(f.shown(),0);assert.equal(f.calls.length,1);
});

test('denied PREPARE (conflict) plus same control/snapshot keeps fail-closed request',async t=>{
 const f=await fixture(t);await dirty(f);
 f.receive('EXTERNAL_FILE_SYNC',{operation:'UPDATED',path:'main.txt',version:2,workspaceVersion:2,document:doc('main.txt','external',2)});
 const count=f.calls.length;await f.request();assert.equal(f.calls.length,count);
 f.receive('CONTROL_PREPARE',{requestId:'denied',path:'main.txt'});
 const ready=f.sent.find((v:any)=>v.type==='CONTROL_READY'&&v.payload.requestId==='denied');assert.equal(ready?.payload.ready,false);
 f.receive('CONTROL_STATE',f.sameControl);await f.request();assert.equal(f.calls.length,count);assert.equal(f.shown(),0);
});

test('Veto cutoff cancels late response; neutral control/snapshot cannot revive it',async t=>{
 const f=await fixture(t),pending=f.request();f.live.triggerVeto();
 assert.equal(f.calls[0].signal.aborted,true);
 f.receive('CONTROL_STATE',f.sameControl);f.receive('SESSION_SNAPSHOT',structuredClone(f.b));await tick();
 f.resolve();await pending;assert.equal(f.shown(),0);assert.equal(f.calls.length,1);
});

test('disconnect and stop retire scope and reject original result without provider replacement',async t=>{
 for(const kind of ['disconnect','stop']){
  const f=await fixture(t),pending=f.request();if(kind==='stop')f.live.close();else f.socket.onclose();
  // Existing binding retirement can reject a late result without signalling the old provider.
  f.resolve();await pending;assert.equal(f.shown(),0);assert.equal(f.calls.length,1);await f.request();assert.equal(f.calls.length,1);
 }
});

test('foreign/malformed ACK never refreshes pending original request',async t=>{
 for(const kind of ['foreign','stale','rejected']){
  const f=await fixture(t),save=await dirty(f),pending=f.request();f.receive('CONTROL_STATE',f.sameControl);
  f.receive('ACK',{replyTo:kind==='foreign'?'foreign-save':save.messageId,status:kind==='rejected'?'REJECTED':'OK',documentVersion:kind==='stale'?1:2,workspaceVersion:2,controlEpoch:0,error:kind==='rejected'?{code:'SAVE_REJECTED',message:'No',retryable:false}:null});
  assert.equal(f.calls.length,1);f.resolve();await pending;
  if(kind!=='foreign')assert.equal(f.shown(),0);
 }
});


test('real HELLO is consumed once; later neutral broadcast retains original local response',async t=>{
 const f=await fixture(t,true),pending=f.request();
 assert.equal(f.sent.filter((v:any)=>v.type==='HELLO').length,1);
 f.receive('SESSION_SNAPSHOT',structuredClone(f.b));await tick();
 assert.equal(f.calls[0].signal.aborted,false);f.resolve();await pending;assert.equal(f.shown(),1);
});

test('disconnect followed by same-source HELLO never revives the old binding or request',async t=>{
 const f=await fixture(t,true),pending=f.request();f.socket.onclose();
 await f.live.connect();f.socket.readyState=1;f.socket.onopen();
 f.receive('SESSION_SNAPSHOT',structuredClone(f.b));await tick();
 f.resolve();await pending;assert.equal(f.shown(),0);assert.equal(f.calls.length,1);
 await f.request();assert.equal(f.calls.length,1);
});


test('neutral snapshot still projects timer/chat/runtime readiness and run while retaining original request',async t=>{
 const f=await fixture(t),pending=f.request(),b=structuredClone(f.b);
 b.session.timer.elapsedMs=750;b.session.presence='HIDDEN';b.session.aiStatus='READY';
 b.project.capabilities.execution.modes.RUN_TESTS={canRun:false,problem:{code:'TASK_CONFIG_INVALID',message:'Tests unavailable.',recovery:'Review tests.',retryable:false}};
 b.chat=[{messageId:'chat1',author:'STUDENT',text:'Still here.',createdAt:'2026-11-11T21:00:01.000Z'}] as any;
 b.lastRun=run() as any;
 assert.ok(validateV2WireShape('SessionBundle',b));
 f.receive('SESSION_SNAPSHOT',b);await tick();const state=f.live.getState();
 assert.equal(state.elapsedMs,750);assert.equal(state.windowPresence,'HIDDEN');assert.equal(state.aiStatus,'READY');
 assert.equal(state.chatEntries[0].message,'Still here.');assert.equal(state.capabilities.canRunTests,false);
 assert.equal(state.activeRun?.runId,'run1');assert.equal(f.calls[0].signal.aborted,false);assert.equal(f.calls.length,1);
 f.resolve();await pending;assert.equal(f.shown(),1);
});
