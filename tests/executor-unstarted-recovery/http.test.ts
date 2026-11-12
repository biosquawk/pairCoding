/** Actual default HTTP/startup/kernel/Run-admission/Runner/executor; real SIGKILL, UNIT injected Docker. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { once } from 'node:events';
import { fork } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { httpRunFixture,until } from '../backend-cutover/http-run-report-fixture';
import { validateRunV2,validateMutationOutcomeV2 } from '../../src/shared/validation-v2';
const command=(p:any)=>({requestId:randomUUID(),clientId:'tab',sessionId:p.sessionId});
for(const boundary of ['CREATED','REVOKED','EVIDENCE','REMOVED'])test('UNIT actual HTTP SIGKILL '+boundary+': original QUEUED unchanged, exact no-start cancellation across restart, no duplicate effect/terminal fiction',async t=>{
  const f=await httpRunFixture(t),marker=path.join(f.root,'unstarted-boundary'),daemonFile=path.join(f.root,'daemon.json');
  const child=fork(new URL('./http-child.ts',import.meta.url),[],{execArgv:['--import','tsx'],stdio:['ignore','ignore','pipe','ipc'],
    env:{...process.env,UNSTARTED_CHILD:JSON.stringify({project:f.project,config:f.config,prepared:f.prepared,token:f.token,boundary,marker,daemonFile})}});
  let stderr='';child.stderr!.on('data',b=>stderr+=b.toString());t.after(()=>{if(child.exitCode===null)child.kill('SIGKILL');});
  const ready=await Promise.race([once(child,'message').then(([m])=>m as {port:number}),once(child,'exit').then(()=>{throw Error('Child early exit '+stderr);}),new Promise<never>((_,reject)=>{const timer=setTimeout(()=>reject(Error('Child startup timeout '+stderr)),5000);timer.unref();})]);
  const old=(await f.http(ready.port,'GET','/api/project')).body;await f.connect(ready.port,old.sessionId);const request=f.runRequest(old,'RUN_TESTS');
  let pending:Promise<unknown>,accepted:any;
  if(boundary==='CREATED'){
    pending=f.http(ready.port,'POST','/api/run',request).catch(()=>null);await until(()=>fs.existsSync(marker));
    const names=fs.readdirSync(path.join(f.project,'.paircoach','runtime-mutations')).filter(n=>n.endsWith('.json'));
    accepted=JSON.parse(fs.readFileSync(path.join(f.project,'.paircoach','runtime-mutations',names[0]),'utf8')).body.runStage.result;
  } else {
    const response=await f.http(ready.port,'POST','/api/run',request);assert.equal(response.status,202,JSON.stringify(response));accepted=response.body;
    pending=f.http(ready.port,'POST','/api/run/'+accepted.runId+'/stop',command(old)).catch(()=>null);await until(()=>fs.existsSync(marker));
  }
  const exit=once(child,'exit');child.kill('SIGKILL');assert.equal((await exit)[1],'SIGKILL');await pending;
  const saved=JSON.parse(fs.readFileSync(daemonFile,'utf8'));f.fake.v=saved.v;
  assert.equal(saved.calls.filter((a:string[])=>a[0]==='start').length,0);assert.equal(saved.calls.filter((a:string[])=>a[0]==='create').length,1);
  const journal=path.join(f.state,'journal',accepted.runId+'.json'),record=JSON.parse(fs.readFileSync(journal,'utf8'));
  assert.equal(record.exit,null);assert.equal(record.collection,null);assert.equal(record.outcome,null);
  // Recovery cannot depend on today's configuration/settings/prepared-cache validity.
  fs.writeFileSync(f.config,'{broken');fs.writeFileSync(path.join(f.project,'.paircoach','settings.json'),'{broken');fs.renameSync(path.join(f.prepared,'receipt.json'),path.join(f.prepared,'preserved-receipt.json'));
  const app=f.app(),port=await app.listen(),p=(await f.http(port,'GET','/api/project')).body;await f.connect(port,p.sessionId);
  const current=await f.http(port,'GET','/api/run/'+accepted.runId);assert.equal(current.status,200,JSON.stringify(current));assert.ok(validateRunV2(current.body));assert.equal(f.fake.calls.length,0,'startup is read-only, never original effect replay');
  if(boundary!=='REMOVED'){
    assert.equal(current.body.status,'PROCESS_STOP_UNCONFIRMED');
    f.fake.daemon=false;
    const denied=await f.http(port,'POST','/api/session/finish',{...command(p),expectedWorkspaceVersion:p.workspaceVersion,reason:'COMPLETED'});assert.ok(denied.status>=400);assert.equal(app.session.state.lifecycle,'READY');assert.equal(f.ai.length,0);
    assert.equal(f.fake.calls.some(a=>a[0]==='rm'),false);f.fake.daemon=true;
    const other=path.join(f.root,'other-project');fs.mkdirSync(other);fs.writeFileSync(path.join(other,'main.js'),'// control');
    // Project replacement first performs the same genuine lifecycle reconciliation. Offline
    // daemon must preserve old project and cannot publish a final snapshot/report.
    f.fake.daemon=false;const refused=await f.http(port,'POST','/api/project/open',{requestId:randomUUID(),clientId:'tab',rootPath:other,settings:f.settings});assert.ok(refused.status>=400);assert.equal(app.workspace.rootPath,f.project);f.fake.daemon=true;
  }else assert.equal(current.body.status,'CANCELLED');
  const stopped=await f.http(port,'POST','/api/run/'+accepted.runId+'/stop',command(p));assert.equal(stopped.status,202,JSON.stringify(stopped));assert.ok(validateRunV2(stopped.body));
  assert.equal(stopped.body.status,'CANCELLED');assert.equal(stopped.body.startedAt,null);assert.equal(stopped.body.exitCode,null);assert.equal(stopped.body.testOutcome,'UNKNOWN');assert.equal(stopped.body.testCount,null);
  assert.equal(stopped.body.processProblem?.code,'RUN_CANCELLED_UNSTARTED');
  assert.equal(record.startDispatch,boundary==='CREATED'?'NOT_DISPATCHED':'REVOKED');assert.ok(stopped.body.finishedAt);
  const complete=JSON.parse(fs.readFileSync(journal,'utf8'));assert.equal(complete.phase,'REMOVED');assert.deepEqual(complete.plan,record.plan);assert.equal(complete.exit,null);assert.equal(complete.collection,null);assert.equal(complete.outcome,null);assert.equal(complete.unstartedCancellation.confirmedAt,stopped.body.finishedAt);
  assert.equal(f.fake.calls.filter(a=>a[0]==='rm').length,boundary==='REMOVED'?0:1);assert.equal(f.fake.calls.filter(a=>['create','start','stop','prune','ps','kill'].includes(a[0])).length,0,'no LSP/control mutation, duplicate dispatch or invented exit');
  const replay=await f.http(port,'POST','/api/runtime/mutation/reconcile',{mutation:{projectId:p.projectId,kind:'RUN',request}});assert.equal(replay.status,200,JSON.stringify(replay));assert.ok(validateMutationOutcomeV2(replay.body));assert.deepEqual(replay.body.result,accepted,'original QUEUED result not replaced by current cancellation');
  const done=await f.http(port,'POST','/api/session/finish',{...command(p),expectedWorkspaceVersion:p.workspaceVersion,reason:'COMPLETED'});assert.equal(done.status,202,JSON.stringify(done));
  await app.close();const next=f.app(),nextPort=await next.listen();assert.deepEqual((await f.http(nextPort,'GET','/api/run/'+accepted.runId)).body,stopped.body);
  if(boundary==='CREATED'){
    const nextProject=(await f.http(nextPort,'GET','/api/project')).body;await f.connect(nextPort,nextProject.sessionId);
    const other=path.join(f.root,'permitted-project');fs.mkdirSync(other);fs.writeFileSync(path.join(other,'main.js'),'// independent control');
    const opened=await f.http(nextPort,'POST','/api/project/open',{requestId:randomUUID(),clientId:'tab',rootPath:other,settings:f.settings});
    assert.equal(opened.status,201,JSON.stringify(opened));assert.equal(next.workspace.rootPath,other,'project adoption permitted only after original durable removal');
  }
});
