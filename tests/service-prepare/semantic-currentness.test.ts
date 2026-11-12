/** Actual LiveBackend/ServicePreparation/RuntimeClient; transport/storage only are doubled.
 * HUMAN35aa: readiness/sequence is presentation, not maintenance authority.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {setImmediate} from 'node:timers/promises';
import {fixture,deferred,prepared,storageKey} from './fixture';
import {bundle,doc} from '../frontend-cutover/fixtures';
const ready=()=>{const p=bundle().project;p.capabilities.execution.modes={RUN_MAIN:{canRun:true,problem:null},RUN_TESTS:{canRun:true,problem:null}};return p;};
const entries=(f:any)=>JSON.parse(f.storage.getItem(storageKey)!).entries;
const options={timeout:5000};
for(const phase of ['POST','GET'] as const)for(const neutral of ['READY','PENDING','seq','presence'] as const)
test(`semantic ${phase}: neutral ${neutral} completes ONLY after original POST + fresh GET`,options,async t=>{
 const f=await fixture(t),post=deferred(),get=deferred();let reads=0;
 t.after(()=>{post.resolve(prepared());get.resolve(ready());});
 f.post=()=>post.promise;f.get=()=>{reads++;return get.promise;};
 const op=f.live.prepareRuntimeEnvironment();await setImmediate();const original=structuredClone(entries(f)[0].request);
 if(phase==='GET'){post.resolve(prepared());await setImmediate();assert.equal(reads,1);}
 if(neutral==='READY'||neutral==='PENDING'){
  f.b.project=ready();if(neutral==='PENDING'){
   const e=f.b.project.capabilities.execution,problem={code:'RUNTIME_READINESS_PENDING',message:'pending',recovery:'measure',retryable:true};
   e.runtime.state='PREPARE_REQUIRED';e.runtime.problem=problem;
   e.modes={RUN_MAIN:{canRun:false,problem},RUN_TESTS:{canRun:false,problem}};
  }await f.snapshot();
 }else f.receive('SESSION_STATE',{...structuredClone(f.b.session),...(neutral==='presence'?{presence:'HIDDEN',timer:{...f.b.session.timer,elapsedMs:1234}}:{})});
 assert.equal(f.maintenance().pending,true);assert.equal(f.maintenance().blocked,true);assert.deepEqual(entries(f)[0].request,original);
 if(phase==='POST'){assert.equal(reads,0);post.resolve(prepared());await setImmediate();}
 assert.equal(reads,1);assert.equal(f.maintenance().uncertain,true,'WS/receipt alone cannot finish');
 assert.equal(await f.live.prepareRuntimeEnvironment(),false,'no automatic/parallel second POST');
 get.resolve(ready());assert.equal(await op,true);assert.equal(reads,1);assert.equal(f.posts().length,1);
 assert.deepEqual(f.posts()[0].body,original);assert.deepEqual(entries(f),[]);
 assert.equal(f.maintenance().uncertain,false);assert.equal(f.maintenance().blocked,false);
 assert.match(f.maintenance().message!,/^Przygotowanie potwierdzone\. Odczytano bieżącą gotowość/);
 assert.equal(f.live.getState().runtime!.execution!.modes.RUN_MAIN.canRun,true);
});

const drifts=['source-ABA','files-ABA','settings-ABA','config-ABA','profile-ABA','workspace-ABA','ACK-workspace-ABA','epoch-ABA','owner-ABA','lifecycle-ABA','project-ABA','session-ABA','prepare-cleared-by-snapshot','veto-cleared-by-snapshot','draft-then-snapshot','connection','stopped','runtime-ABA','finish-ABA'] as const;
for(const phase of ['POST','GET'] as const)for(const drift of drifts)
test(`semantic ${phase}: real ${drift} retains exact original UNKNOWN`,options,async t=>{
 const f=await fixture(t),post=deferred(),get=deferred();let reads=0;
 t.after(()=>{post.resolve(prepared());get.resolve(ready());});
 f.post=()=>post.promise;f.get=()=>{reads++;return get.promise;};
 const op=f.live.prepareRuntimeEnvironment();await setImmediate();
 if(phase==='GET'){post.resolve(prepared());await setImmediate();assert.equal(reads,1);}
 const original=structuredClone(entries(f)[0]);
 const roundtrip=async(change:()=>void)=>{const before=structuredClone(f.b);change();await f.snapshot();Object.assign(f.b,before);await f.snapshot();};
 if(drift==='source-ABA'){
  f.receive('EXTERNAL_FILE_SYNC',{operation:'MODIFIED',path:'main.txt',version:2,workspaceVersion:2,document:doc('main.txt','changed',2)});
  f.receive('EXTERNAL_FILE_SYNC',{operation:'MODIFIED',path:'main.txt',version:1,workspaceVersion:1,document:doc()});
 }
 if(drift==='files-ABA')await roundtrip(()=>{f.b.project.files.push({path:'other.txt',kind:'FILE',version:1});});
 if(drift==='settings-ABA')await roundtrip(()=>{f.b.project.settings.runProfiles[0].timeoutMs++;});
 if(drift==='config-ABA')await roundtrip(()=>{f.b.project.capabilities.execution.runtime.configurationGeneration=f.b.project.capabilities.language.configurationGeneration='cfg2';});
 if(drift==='profile-ABA')await roundtrip(()=>{f.b.project.capabilities.execution.runtime.profileId=f.b.project.capabilities.language.profileId='profile2';});
 if(drift==='workspace-ABA')await roundtrip(()=>{f.b.project.workspaceVersion=f.b.session.workspaceVersion=2;});
 if(drift==='ACK-workspace-ABA'){f.receive('ACK',{replyTo:'view1',status:'APPLIED',workspaceVersion:2,documentVersion:1,controlEpoch:0});await f.snapshot();}
 if(drift==='project-ABA')await roundtrip(()=>{f.b.project.projectId=f.b.session.projectId=f.b.project.capabilities.language.projectId='p2';});
 // Direct authoritative publications avoid helper connect/bootstrap against our deferred GET.
 if(drift==='session-ABA'){f.receive('SESSION_STATE',{...structuredClone(f.b.session),sessionId:'s2'});(f.live as any).receive({protocolVersion:'3.0',messageId:'return',sessionId:'s2',seq:(f.live as any).lastSeq+1,type:'SESSION_STATE',payload:structuredClone(f.b.session)});}
 if(drift==='epoch-ABA'){f.receive('CONTROL_STATE',{controlEpoch:1,writeOwner:'STUDENT',coachMode:'UNAVAILABLE'});await f.snapshot();}
 if(drift==='owner-ABA'){f.receive('CONTROL_STATE',{controlEpoch:0,writeOwner:'COACH',coachMode:'UNAVAILABLE'});f.receive('CONTROL_STATE',{controlEpoch:0,writeOwner:'STUDENT',coachMode:'UNAVAILABLE'});}
 if(drift==='lifecycle-ABA'){f.receive('SESSION_STATE',{...structuredClone(f.b.session),lifecycle:'FINISHED'});f.receive('SESSION_STATE',structuredClone(f.b.session));}
 if(drift==='prepare-cleared-by-snapshot'){f.receive('CONTROL_PREPARE',{requestId:'control1',path:'main.txt'});await f.snapshot();}
 if(drift==='veto-cleared-by-snapshot'){f.live.triggerVeto();await f.snapshot();}
 if(drift==='draft-then-snapshot'){f.live.saveFileContent('main.txt','draft');await f.snapshot();}
 if(drift==='connection')f.socket.onclose?.();
 if(drift==='stopped')f.live.close();
 // Synchronous publication boundaries: no fake Run/finish dispatch, mutate only private
 // operation state and invoke the same real publish that their lifecycle uses.
 if(drift==='runtime-ABA'){const r=(f.live as any).wiring.runtime;r.state.pending='RUN';r.publish();r.state.pending=null;r.publish();}
 if(drift==='finish-ABA'){(f.live as any).finishStarting=true;(f.live as any).publish();(f.live as any).finishStarting=false;(f.live as any).publish();}
 const before=structuredClone(f.live.getState().runtime!.execution);
 post.resolve(prepared());get.resolve(ready());assert.equal(await op,false);
 assert.deepEqual(f.live.getState().runtime!.execution,before,'stale GET cannot overwrite late authority');
 assert.deepEqual(entries(f).find((e:any)=>e.projectId==='p1'),original);
 assert.equal(f.posts().length,1);assert.equal(reads,phase==='GET'?1:0);
});

for(const late of ['source','control'] as const)test(`synchronous late ${late} at validated GET publication still fences completion`,options,async t=>{
 const f=await fixture(t),get=deferred();let reads=0,fired=false;
 t.after(()=>get.resolve(ready()));f.get=()=>{reads++;return get.promise;};
 const op=f.live.prepareRuntimeEnvironment();await setImmediate();const original=structuredClone(entries(f)[0]);
 const unsubscribe=f.live.subscribe('state',state=>{
  if(fired||!state.runtime?.execution?.modes.RUN_MAIN.canRun)return;fired=true;
  if(late==='source')f.receive('EXTERNAL_FILE_SYNC',{operation:'MODIFIED',path:'main.txt',version:2,workspaceVersion:2,document:doc('main.txt','late source',2)});
  else f.receive('CONTROL_PREPARE',{requestId:'late-control',path:'main.txt'});
 });t.after(unsubscribe);
 get.resolve(ready());assert.equal(await op,false);assert.equal(fired,true);
 assert.deepEqual(entries(f)[0],original);assert.equal(reads,1);assert.equal(f.posts().length,1);
 if(late==='source'){
  assert.equal(f.live.getState().workspaceVersion,2);
  assert.equal(f.live.getState().files.find(file=>file.path==='main.txt')!.content,'late source','no stale project overwrite after reentrant publication');
 }else assert.equal((f.live as any).preparing,'late-control');
});

for(const change of ['settings','files','root'] as const)test(`fresh GET with unobserved ${change} drift is not installed`,options,async t=>{
 const f=await fixture(t),value=ready();
 if(change==='settings')value.settings.runProfiles[0].timeoutMs++;
 if(change==='files')value.files.push({path:'other.txt',kind:'FILE',version:1});
 if(change==='root')value.rootPath='/other';
 f.get=async()=>value;
 assert.equal(await f.live.prepareRuntimeEnvironment(),false);
 assert.deepEqual(entries(f)[0].request,f.posts()[0].body);assert.deepEqual(entries(f)[0].receipt,prepared());
 assert.equal(f.maintenance().uncertain,true);assert.equal(f.posts().length,1);
 assert.equal(f.live.getState().runtime!.execution!.modes.RUN_MAIN.canRun,false);
});
