/** Genuine neutral default consumer, controlled Docker/AI UNIT only. No legacy executionFactory. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { httpRunFixture, sha, until } from './http-run-report-fixture';
import { ReportService, type FrozenFacts } from '../../src/server/ReportService';
import { projectRunFacts } from '../../src/server/coach/runFacts';
import { validateRunV2, validateMutationOutcomeV2, validateV2WireShape } from '../../src/shared/validation-v2';
const command=(p:any)=>({requestId:randomUUID(),clientId:'tab',sessionId:p.sessionId});
const finish=(p:any)=>({...command(p),expectedWorkspaceVersion:p.workspaceVersion,reason:'COMPLETED'});

test('UNIT actual HTTP Run/results -> reconnect -> immutable Report/AI retains original identity and safe structural facts across restart',async t=>{
  const f=await httpRunFixture(t),a=f.app(),port=await a.listen(),p=(await f.http(port,'GET','/api/project')).body;
  assert.equal(p.capabilities.execution.modes.RUN_TESTS.canRun,true,JSON.stringify(p));
  await f.connect(port,p.sessionId);
  const request=f.runRequest(p),accepted=await f.http(port,'POST','/api/run',request);
  assert.equal(accepted.status,202,JSON.stringify(accepted));assert.ok(validateRunV2(accepted.body));
  const original=structuredClone(accepted.body),runId=original.runId;assert.equal(original.status,'QUEUED');assert.equal(original.workspaceVersionAtStart,0);
  // Actual frozen executor plan and actual fresh JUnit, not a fabricated terminal Run/factory.
  const journal=path.join(f.state,'journal',runId+'.json'),record=JSON.parse(fs.readFileSync(journal,'utf8'));
  assert.equal(record.phase,'RUNNING');assert.equal(record.plan.input.identity.runId,runId);assert.equal(record.plan.input.identity.workspaceVersion,0);
  fs.writeFileSync(path.join(record.plan.input.artifactsDirectory,'junit.xml'),'<testsuite tests="2" failures="0" errors="0" skipped="0"><testcase name="one"/><testcase name="two"/></testsuite>');
  const doc=a.workspace.getDocument('main.js');await a.gate.writeAsync({clientId:'tab',sessionId:p.sessionId,actor:'STUDENT',controlEpoch:a.session.state.controlEpoch,path:doc.path,baseVersion:doc.version,content:'LATER CODE\n'});
  // Wait for genuine executor output subscription, not event-derived state reconstruction.
  for(let i=0;;i++){const run=(await f.http(port,'GET','/api/run/'+runId)).body;if(run.outputTail.includes(f.output))break;assert.ok(i<150);await new Promise(r=>setTimeout(r,5));}
  f.fake.finish();await until(()=>JSON.parse(fs.readFileSync(journal,'utf8')).phase==='REMOVED');
  let terminal:any;for(let i=0;;i++){terminal=(await f.http(port,'GET','/api/run/'+runId)).body;if(terminal.status==='SUCCEEDED')break;assert.ok(i<150);await new Promise(r=>setTimeout(r,5));}
  assert.equal(terminal.testOutcome,'PASSED');assert.equal(terminal.testCount,2);assert.equal(terminal.exitCode,0);assert.equal(terminal.workspaceChangedDuringRun,true);assert.equal(terminal.workspaceVersionAtStart,0);
  assert.deepEqual((await f.http(port,'POST','/api/run',request)).body,original);assert.equal(f.fake.calls.filter(a=>a[0]==='create').length,1);
  const reconcile=await f.http(port,'POST','/api/runtime/mutation/reconcile',{mutation:{projectId:p.projectId,kind:'RUN',request}});
  assert.equal(reconcile.status,200,JSON.stringify(reconcile));assert.ok(validateMutationOutcomeV2(reconcile.body));assert.deepEqual(reconcile.body.result,original);assert.deepEqual(reconcile.body.current.run,terminal);assert.equal(reconcile.body.current.project.workspaceVersion,1);
  const reconnect=await f.connect(port,p.sessionId);assert.ok(validateV2WireShape('SessionBundle',reconnect.bundle));assert.deepEqual(reconnect.bundle.lastRun,terminal);
  // Simulate a future local lossless Run field at the real ReportService boundary; outbound
  // projection must reject it by structure, not redaction or today's DTO absence.
  const originalFinish=ReportService.prototype.finish;let captured:FrozenFacts|undefined;
  ReportService.prototype.finish=function(reason,facts){captured=structuredClone(facts);for(const r of facts.runs)Object.assign(r,{futureField:'FUTURE_RUN_SENTINEL',stdout:'FUTURE_STDOUT_SENTINEL'});return originalFinish.call(this,reason,facts);};
  let result;
  try {result=await f.http(port,'POST','/api/session/finish',finish({...p,workspaceVersion:1}));}
  finally {ReportService.prototype.finish=originalFinish;}
  assert.equal(result.status,202,JSON.stringify(result));assert.ok(captured);assert.deepEqual(captured.runs,[terminal]);assert.equal(captured.session.lifecycle,'FINISHED');assert.equal(captured.snapshot.workspaceVersion,1);
  const negative=new ReportService({dataDir:path.join(f.root,'negative-reports'),projectId:p.projectId,emit:()=>{}});t.after(()=>negative.close());
  for(const status of ['QUEUED','RUNNING','STOPPING','PROCESS_STOP_UNCONFIRMED'] as const){const uncertain=structuredClone(captured);uncertain.runs=[{...terminal,status,finishedAt:null}];assert.throws(()=>negative.finish('COMPLETED',uncertain),{code:'REPORT_FACTS_NOT_FINAL'});}
  assert.ok(result.body.evidenceIds.includes(runId));await until(()=>f.ai.length===1);
  const projected=f.ai[0];assert.deepEqual(projected.runs,[projectRunFacts(terminal)]);assert.equal(projected.runs[0].profileId,terminal.profileId);assert.equal(projected.runs[0].configurationGeneration,request.configurationGeneration);
  const text=JSON.stringify(projected);for(const sentinel of [f.output,f.token,'RUN_STDOUT_SENTINEL','RUN_STDERR_SENTINEL','FUTURE_RUN_SENTINEL','FUTURE_STDOUT_SENTINEL'])assert.equal(text.includes(sentinel),false,sentinel);
  assert.equal('outputTail' in projected.runs[0],false);assert.equal('processProblem' in projected.runs[0],false);assert.equal('serviceReadiness' in projected.runs[0],false);
  let ready:any;for(let i=0;;i++){ready=(await f.http(port,'GET','/api/session/report?sessionId='+p.sessionId)).body;if(ready.status==='READY')break;assert.ok(i<100);await new Promise(r=>setTimeout(r,5));}
  const factsFile=path.join(f.project,'.paircoach','reports',sha(p.sessionId),'facts.json'),before=fs.readFileSync(factsFile);
  assert.deepEqual((await f.http(port,'POST','/api/session/finish',finish({...p,workspaceVersion:1}))).body,ready);assert.deepEqual(fs.readFileSync(factsFile),before);assert.equal(f.ai.length,1);
  await a.close();fs.writeFileSync(f.config,'{BROKEN CURRENT CONFIG');const b=f.app(),newPort=await b.listen(),newProject=(await f.http(newPort,'GET','/api/project')).body;assert.notEqual(newProject.sessionId,p.sessionId);
  assert.deepEqual((await f.http(newPort,'GET','/api/session/report?sessionId='+p.sessionId)).body,ready);assert.deepEqual(fs.readFileSync(factsFile),before);
  const newConnection=await f.connect(newPort,newProject.sessionId);
  const oldOutcome=await f.http(newPort,'POST','/api/runtime/mutation/reconcile',{mutation:{projectId:p.projectId,kind:'RUN',request}});assert.equal(oldOutcome.status,200,JSON.stringify(oldOutcome));assert.ok(validateMutationOutcomeV2(oldOutcome.body));assert.equal(oldOutcome.body.state,'COMMITTED');assert.deepEqual(oldOutcome.body.result,original);assert.equal(oldOutcome.body.current.run,null);assert.equal(oldOutcome.body.current.project.sessionId,newProject.sessionId);
  assert.equal(newConnection.bundle.lastRun,null);assert.equal(newConnection.bundle.report,null);assert.equal(f.ai.length,1);
});

test('UNIT actual pending neutral Run/finish blocks admissions and analysis; freezes only post-Stop Run and preserves uncertainty until confirmed',async t=>{
  const f=await httpRunFixture(t),a=f.app(),port=await a.listen(),p=(await f.http(port,'GET','/api/project')).body,ws=await f.connect(port,p.sessionId);
  const presence=ws.send('WINDOW_STATE',{presence:'FOCUSED'});await until(()=>ws.frames.some(f=>f.type==='ACK'&&f.payload.replyTo===presence));
  assert.equal((await f.http(port,'POST','/api/session/start',{...command(p),limitMs:null,pauseOnHidden:true})).status,200);
  await until(()=>f.analyses.length>0);const request=f.runRequest(p,'RUN_MAIN'),accepted=await f.http(port,'POST','/api/run',request);assert.equal(accepted.status,202,JSON.stringify(accepted));
  const runId=accepted.body.runId,analyses=f.analyses.length;
  let enter!:()=>void,release!:()=>void;const entered=new Promise<void>(r=>enter=r),held=new Promise<void>(r=>release=r);f.fake.onStop=async()=>{enter();await held;};
  const pending=f.http(port,'POST','/api/session/finish',finish(p));await entered;
  try {
    assert.equal((await f.http(port,'GET','/api/run/'+runId)).body.status,'STOPPING');
    const denied=await f.http(port,'POST','/api/run',f.runRequest(p,'RUN_MAIN'));assert.equal(denied.status,409);assert.equal(denied.body.code,'PROJECT_STATE_CHANGED');
    const chat=ws.send('CHAT_MESSAGE',{text:'Do not start another analysis during finish.',path:null,documentVersion:null,selection:null});await until(()=>ws.frames.some(f=>f.type==='ACK'&&f.payload.replyTo===chat));assert.equal(ws.frames.find(f=>f.type==='ACK'&&f.payload.replyTo===chat).payload.status,'REJECTED');
    assert.equal(a.session.state.lifecycle,'RUNNING');assert.equal(f.ai.length,0);assert.equal(f.analyses.length,analyses);
  } finally {release();}
  const done=await pending;assert.equal(done.status,202,JSON.stringify(done));await until(()=>f.ai.length===1);assert.equal(f.analyses.length,analyses);
  const facts=JSON.parse(JSON.parse(fs.readFileSync(path.join(f.project,'.paircoach','reports',sha(p.sessionId),'facts.json'),'utf8')).serialized);
  assert.equal(facts.runs.length,1);assert.equal(facts.runs[0].runId,runId);assert.equal(facts.runs[0].status,'CANCELLED');assert.equal(facts.runs[0].exitCode,137);assert.ok(facts.runs[0].finishedAt);
  assert.equal(facts.runs[0].workspaceVersionAtStart,0);assert.equal(facts.runs[0].testOutcome,'NOT_APPLICABLE');assert.equal(facts.session.lifecycle,'FINISHED');assert.equal(f.fake.calls.filter(a=>a[0]==='create').length,1);
  const rejected=await f.http(port,'POST','/api/run',f.runRequest(p));assert.equal(rejected.status,503);assert.equal(rejected.body.code,'MUTATION_OUTCOME_UNKNOWN');
});

test('UNIT actual unconfirmed Stop is reconnect-visible and cannot freeze a false terminal report; retry same Stop only',async t=>{
  const f=await httpRunFixture(t),a=f.app(),port=await a.listen(),p=(await f.http(port,'GET','/api/project')).body;await f.connect(port,p.sessionId);
  const accepted=await f.http(port,'POST','/api/run',f.runRequest(p,'RUN_MAIN'));assert.equal(accepted.status,202,JSON.stringify(accepted));f.fake.stopRemainsRunning=true;
  const refused=await f.http(port,'POST','/api/session/finish',finish(p));assert.equal(refused.status>=400,true);assert.equal(a.session.state.lifecycle,'READY');assert.equal(f.ai.length,0);
  const reconnect=await f.connect(port,p.sessionId);assert.equal(reconnect.bundle.lastRun.runId,accepted.body.runId);assert.equal(reconnect.bundle.lastRun.status,'PROCESS_STOP_UNCONFIRMED');assert.equal(reconnect.bundle.lastRun.finishedAt,null);assert.ok(validateV2WireShape('SessionBundle',reconnect.bundle));
  assert.equal((await f.http(port,'GET','/api/session/report?sessionId='+p.sessionId)).status,404);assert.equal(f.fake.calls.filter(a=>a[0]==='rm').length,0);
  f.fake.stopRemainsRunning=false;const stop=await f.http(port,'POST','/api/run/'+accepted.body.runId+'/stop',command(p));assert.equal(stop.status,202,JSON.stringify(stop));assert.equal(stop.body.status,'CANCELLED');
  const result=await f.http(port,'POST','/api/session/finish',finish(p));assert.equal(result.status,202,JSON.stringify(result));assert.ok(result.body.evidenceIds.includes(accepted.body.runId));
});

test('UNIT actual lost exit observation remains a valid unconfirmed V2 Run across HTTP/reconcile/reconnect, never terminalized for typing',async t=>{
  const f=await httpRunFixture(t),a=f.app(),port=await a.listen(),p=(await f.http(port,'GET','/api/project')).body;await f.connect(port,p.sessionId);
  const request=f.runRequest(p,'RUN_MAIN'),accepted=await f.http(port,'POST','/api/run',request);assert.equal(accepted.status,202,JSON.stringify(accepted));f.fake.daemon=false;
  let current:any;for(let i=0;;i++){current=(await f.http(port,'GET','/api/run/'+accepted.body.runId)).body;if(current.status==='PROCESS_STOP_UNCONFIRMED')break;assert.ok(i<150);await new Promise(r=>setTimeout(r,5));}
  assert.ok(validateRunV2(current),'actual uncertainty must satisfy frozen V2 contract without relaxing it');assert.ok(current.processProblem);assert.equal(current.processProblem.code,'PROCESS_STOP_UNCONFIRMED');assert.match(current.processProblem.message,/RUN_EXIT_UNCONFIRMED/);assert.equal(current.finishedAt,null);
  const outcome=await f.http(port,'POST','/api/runtime/mutation/reconcile',{mutation:{projectId:p.projectId,kind:'RUN',request}});assert.equal(outcome.status,200,JSON.stringify(outcome));assert.ok(validateMutationOutcomeV2(outcome.body));assert.deepEqual(outcome.body.result,accepted.body);assert.ok(outcome.body.current);assert.deepEqual(outcome.body.current.run,current);
  const reconnect=await f.connect(port,p.sessionId);assert.ok(validateV2WireShape('SessionBundle',reconnect.bundle));assert.deepEqual(reconnect.bundle.lastRun,current);assert.equal(f.ai.length,0);assert.equal(f.fake.calls.filter(a=>a[0]==='rm').length,0);
  f.fake.daemon=true;const stop=await f.http(port,'POST','/api/run/'+accepted.body.runId+'/stop',command(p));assert.equal(stop.status,202,JSON.stringify(stop));assert.equal(stop.body.status,'CANCELLED');assert.equal(stop.body.runId,accepted.body.runId);assert.equal(f.fake.calls.filter(a=>a[0]==='create').length,1);
});
