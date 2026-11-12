import test from 'node:test';
import assert from 'node:assert/strict';
import {composed,barrier,chat,tick,until} from './fixture';
import type {CoachOptions} from '../../src/server/CoachAdapter';
const controls=(f:Awaited<ReturnType<typeof composed>>)=>f.events.filter(e=>e.type==='CONTROL_STATE').length;

test('NEW immediate START during real owner source capture waits SAME FIFO, then full current context exactly once',async t=>{
  const f=await composed(t);f.start();
  assert.equal(f.signals.length,1,'Singleflight is claimed before async context admission');
  assert.equal(f.core.session.state.aiStatus,'THINKING');
  f.adapter.trigger('RUN');f.adapter.trigger('OVERTIME');await tick();
  assert.equal(f.signals.length,1,'Other triggers do not create parallel context reads');
  assert.equal(f.reads,0);assert.equal(f.contexts.length,0);
  await f.release();await until(()=>controls(f)>0,'START settles');
  assert.equal(f.contexts.length,1,'Pending same-fact triggers remain deduplicated');
  const c=f.contexts[0];assert.equal(c.trigger?.reason,'START');
  assert.equal(c.controlEpoch,f.core.session.state.controlEpoch);
  assert.equal(c.workspaceVersion,f.core.workspace.workspaceVersion);
  assert.equal(c.documents.find(d=>d.path===f.f.path)?.content,'prior disk\n');
  assert.equal(c.taskMode,'IMPLEMENTATION');assert.ok(c.timer);assert.equal(c.lastRun,null);
  assert.deepEqual(c.messages,[]);assert.deepEqual(c.previousInterventions,[]);assert.equal(c.view,null);
  assert.equal(f.events.some(e=>e.type==='ERROR'),false);
});

test('NEW second CHAT while capture waits aborts old read, retains only latest, no early provider/fingerprint resurrection',async t=>{
  const f=await composed(t);f.start();
  f.adapter.trigger('CHAT',chat('older'));f.adapter.trigger('CHAT',chat('latest'));
  assert.equal(f.signals[0].aborted,true);await tick();
  assert.equal(f.signals.length,1);assert.equal(f.reads,0);assert.equal(f.contexts.length,0);
  await f.release();await until(()=>f.contexts.length===1&&controls(f)>=2,'Only latest CHAT settles');
  assert.equal(f.signals.length,2);assert.equal(f.reads,1);
  assert.deepEqual(f.contexts[0].trigger,{reason:'CHAT',messageId:'latest'});
  assert.deepEqual(f.contexts[0].messages.map(m=>m.messageId),['older','latest']);
  assert.equal(f.events.some(e=>e.type==='ERROR'),false);
});

for(const action of ['abort','veto','finish','close','binding'] as const)test(`NEW ${action} during actual capture cannot call provider after late release`,async t=>{
  const f=await composed(t);f.start();
  if(action==='abort')f.adapter.abort();
  if(action==='veto')f.core.session.veto();
  if(action==='finish')f.core.session.finish();
  if(action==='close')f.adapter.close();
  if(action==='binding')f.revokeBinding();
  if(action!=='binding')assert.equal(f.signals[0].aborted,true,'Revocation is immediate, not delayed by FIFO');
  await f.release();await tick();assert.equal(f.reads,0);assert.equal(f.contexts.length,0);
  assert.equal(f.events.some(e=>e.type==='COACH_STEP_EDIT'||e.type==='CONTROL_PREPARE'||e.type==='ERROR'),false);
});

test('NEW context admission failure is handled FAILED with safe error, no retry, and an explicit later request can recover',async t=>{
  let fail=true;let project!:CoachOptions['readContext'];
  const f=await composed(t,{readContext:async(read,signal)=>{if(fail)throw Error('PRIVATE_RAW_BODY token=SECRET');return project!(read,signal);}});project=f.project;
  f.start();await until(()=>f.events.some(e=>e.type==='ERROR'),'Handled context failure');
  assert.equal(f.core.session.state.aiStatus,'FAILED');assert.equal(f.contexts.length,0);
  assert.equal(f.events.filter(e=>e.type==='ERROR').length,1);
  assert.equal(f.events.find(e=>e.type==='ERROR')!.payload.code,'COACH_CONTEXT_UNAVAILABLE');
  assert.equal(JSON.stringify(f.events).includes('PRIVATE_RAW_BODY'),false);
  assert.equal(JSON.stringify(f.events).includes('SECRET'),false);
  await f.release();await tick();assert.equal(f.contexts.length,0,'No blind retry after capture release');
  await f.owner.readProjection(async()=>{
    const d=f.core.workspace.getDocument(f.f.path);
    const written=f.core.gate.write({clientId:'tab',sessionId:f.core.session.state.sessionId,controlEpoch:f.core.session.state.controlEpoch,actor:'STUDENT',path:f.f.path,baseVersion:d.version,content:'EDITABLE\n'});
    assert.equal(written.version,d.version+1,'Unrelated editor/gate remains usable');
  });
  fail=false;f.adapter.trigger('CHAT',chat('recover'));
  await until(()=>f.contexts.length===1,'New explicit request is not poisoned by failed fingerprint');
  assert.equal(f.contexts[0].documents.find(d=>d.path===f.f.path)?.content,'EDITABLE\n');
});

test('NEW legacy omitted hook catches actual WORKSPACE_BUSY inside lifecycle, never unhandled; retry is explicit',async t=>{
  const f=await composed(t,{legacy:true});f.start();
  await until(()=>f.events.some(e=>e.type==='ERROR'),'Legacy capture failure is handled');
  assert.equal(f.core.session.state.aiStatus,'FAILED');assert.equal(f.contexts.length,0);
  await f.release();await tick();assert.equal(f.contexts.length,0);
  await f.owner.readProjection(async()=>{f.adapter.trigger('START');});await until(()=>f.contexts.length===1,'Ordinary legacy call still works after explicit trigger');
});

test('NEW 30s bound includes async context admission; ignored cancellation cannot unlock a parallel request',async t=>{
  const f=await composed(t);
  t.mock.timers.enable({apis:['setTimeout']});
  f.start();t.mock.timers.tick(30000);
  assert.equal(f.signals[0].aborted,true);assert.equal(f.core.session.state.aiStatus,'FAILED');
  assert.equal(f.events.filter(e=>e.type==='ERROR'&&e.payload.code==='COACH_ANALYSIS_TIMEOUT').length,1);
  f.adapter.trigger('CHAT',chat('after-timeout'));
  assert.equal(f.signals.length,1,'Timed-out capture still owns singleflight until settlement');
  t.mock.timers.reset();await f.release();
  await until(()=>f.contexts.length===1,'Only latest posttimeout CHAT admitted');
  assert.equal(f.contexts[0].trigger?.messageId,'after-timeout');
});

test('NEW revoked result after callback but before async return never reaches provider',async t=>{
  const captured=barrier(),returnResult=barrier();let project!:CoachOptions['readContext'];let first=true;
  const f=await composed(t,{readContext:async(read,signal)=>{const result=await project!(read,signal);if(first){first=false;captured.resolve();await returnResult.promise;}return result;}});project=f.project;
  f.start();await f.release();await captured.promise;f.adapter.trigger('CHAT',chat('current'));
  assert.equal(f.contexts.length,0);returnResult.resolve();
  await until(()=>f.contexts.length===1,'Postawait freshness admits only new request');
  assert.equal(f.contexts[0].trigger?.messageId,'current');
});

test('NEW provider ignoring abort retains singleflight and latest CHAT priority until actual settlement',async t=>{
  const firstDone=barrier();let calls=0,inflight=0,max=0;const ids:(string|null|undefined)[]=[];
  const f=await composed(t,{provider:{name:'UNIT_IGNORE_ABORT',mode:'INJECTED',async decide(c){calls++;inflight++;max=Math.max(max,inflight);ids.push(c.trigger?.messageId);if(calls===1)await firstDone.promise;inflight--;return {kind:'REPLY',text:'bounded reply'};}}});
  f.start();await f.release();await until(()=>calls===1,'Provider actually invoked');
  f.adapter.trigger('CHAT',chat('discard'));f.adapter.trigger('CHAT',chat('latest'));f.adapter.trigger('RUN');await tick();assert.equal(calls,1);
  firstDone.resolve();await until(()=>calls===2&&controls(f)>=2,'Actual first settle unlocks only latest');
  assert.equal(max,1);assert.deepEqual(ids,[null,'latest']);
  assert.equal(f.events.filter(e=>e.type==='CHAT_REPLY').length,1,'Old ignored-abort reply is not emitted');
});

test('NEW postdecision remember waits actual gate language lease via same owner projection and preserves dedup',async t=>{
  let f!:Awaited<ReturnType<typeof composed>>,held:Promise<void>|undefined;const entered=barrier(),resume=barrier();let proposals=0,calls=0;
  t.after(()=>resume.resolve());
  f=await composed(t,{provider:{name:'UNIT_PROPOSAL',mode:'INJECTED',async decide(){calls++;return {kind:'PROPOSE',proposalKind:'FINISH_EXERCISE',questionText:'Finish?',snapshotId:null,resetTimer:false,paths:[]};}},onProposal(){
    proposals++;held=f.core.gate._withLanguageSourceLease({clientId:'tab',sessionId:f.core.session.state.sessionId,controlEpoch:f.core.session.state.controlEpoch,actor:'STUDENT',expectedWorkspaceVersion:f.core.workspace.workspaceVersion},()=>{},async lease=>{lease.assertCurrent();entered.resolve();await resume.promise;lease.assertCurrent();});
  }});
  f.start();await f.release();await until(()=>proposals===1,'Actual valid proposal emitted');await entered.promise;await tick();
  assert.throws(()=>f.core.workspace.listFiles(),{code:'WORKSPACE_BUSY'});
  assert.equal(f.signals.length,2,'Remember uses admission hook too');assert.equal(f.reads,1);
  assert.equal(controls(f),0,'Coordinator retains singleflight through optional read');
  resume.resolve();await held;await until(()=>controls(f)===1,'Postdecision read released');
  assert.equal(f.reads,2);assert.equal(proposals,1);
  f.adapter.trigger('START');await until(()=>controls(f)===2,'Deduplicated trigger settles');
  assert.equal(calls,1,'Own recorded intervention is not a new fact');assert.equal(f.events.some(e=>e.type==='ERROR'),false);
});

test('NEW unavailable optional remember skips only dedup, without retroactive failure or unguarded read',async t=>{
  let project!:CoachOptions['readContext'],hooks=0,proposals=0;
  const f=await composed(t,{readContext:async(read,signal)=>{if(++hooks===2)throw Error('PRIVATE optional error');return project!(read,signal);},provider:{name:'UNIT_PROPOSAL',async decide(){return {kind:'PROPOSE',proposalKind:'FINISH_EXERCISE',questionText:'Finish?',snapshotId:null,resetTimer:false,paths:[]};}},onProposal(){proposals++;}});project=f.project;
  f.start();await f.release();await until(()=>controls(f)===1,'Optional failure settles');
  assert.equal(hooks,2);assert.equal(f.reads,1);assert.equal(proposals,1);assert.equal(f.core.session.state.aiStatus,'READY');
  assert.equal(f.events.some(e=>e.type==='ERROR'),false);
  f.adapter.trigger('CHAT',chat('next'));await until(()=>controls(f)===2,'Singleflight released after optional failure');assert.equal(proposals,2);
});
