/** Default real HTTP/startup/kernel/admission/Runner/executor/adapter/report with real SIGKILL.
 * Fake Docker is retained independently across the two application processes. No real Docker. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { once } from 'node:events';
import { fork } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { httpRunFixture,until,sha } from './http-run-report-fixture';
import { validateRunV2,validateMutationOutcomeV2 } from '../../src/shared/validation-v2';
const command=(p:any)=>({requestId:randomUUID(),clientId:'tab',sessionId:p.sessionId});
const finish=(p:any)=>({...command(p),expectedWorkspaceVersion:p.workspaceVersion,reason:'COMPLETED'});
async function crashed(t:any,boundary:string) {
  const f=await httpRunFixture(t),marker=path.join(f.root,'boundary'),daemonFile=path.join(f.root,'fake-daemon.json');
  const child=fork(new URL('./http-run-recovery-child.ts',import.meta.url),[],{execArgv:['--import','tsx'],stdio:['ignore','ignore','pipe','ipc'],
    env:{...process.env,RUN_RECOVERY_CHILD:JSON.stringify({project:f.project,config:f.config,prepared:f.prepared,token:f.token,boundary,marker,daemonFile})}});
  let stderr='';child.stderr!.on('data',b=>stderr+=b.toString());t.after(()=>{if(child.exitCode===null)child.kill('SIGKILL');});
  const ready=await Promise.race([once(child,'message').then(([m])=>m as {port:number}),once(child,'exit').then(()=>{throw Error('Child exited before ready: '+stderr);}),new Promise<never>((_,reject)=>{const timer=setTimeout(()=>reject(Error('Child timeout: '+stderr)),5000);timer.unref();})]);
  const p=(await f.http(ready.port,'GET','/api/project')).body;await f.connect(ready.port,p.sessionId);
  const request=f.runRequest(p,'RUN_MAIN');
  let accepted:any, pending:Promise<any>|undefined;
  if(boundary==='ADMITTED') {
    pending=f.http(ready.port,'POST','/api/run',request).catch(()=>null);await until(()=>fs.existsSync(marker));
    const mutations=fs.readdirSync(path.join(f.project,'.paircoach','runtime-mutations')).filter(n=>n.endsWith('.json'));
    const stored=JSON.parse(fs.readFileSync(path.join(f.project,'.paircoach','runtime-mutations',mutations[0]),'utf8'));
    accepted=stored.body.runStage.result;
  } else {
    const response=await f.http(ready.port,'POST','/api/run',request);assert.equal(response.status,202,JSON.stringify(response));accepted=response.body;
    if(boundary!=='RUNNING') {
      pending=f.http(ready.port,'POST','/api/run/'+accepted.runId+'/stop',command(p)).catch(()=>null);
      await until(()=>fs.existsSync(marker));
    }
  }
  const exit=once(child,'exit');child.kill('SIGKILL');const [,signal]=await exit;assert.equal(signal,'SIGKILL');await pending;
  if(fs.existsSync(daemonFile))f.fake.v=JSON.parse(fs.readFileSync(daemonFile,'utf8')).v;
  const before=fs.existsSync(daemonFile)?JSON.parse(fs.readFileSync(daemonFile,'utf8')).calls:[];
  return {...f,oldProject:p,request,accepted,before};
}

test('UNIT SIGKILL RUNNING -> original executor recovered with broken current config/no prepare -> exact Stop/collection/receipt/removal; old session never leaks into new report',async t=>{
  const f=await crashed(t,'RUNNING'),runId=f.accepted.runId,journal=path.join(f.state,'journal',runId+'.json'),before=fs.readFileSync(journal);
  const originalRecord=JSON.parse(before.toString());assert.equal(originalRecord.phase,'RUNNING');
  // Today's runtime, settings and selected prepare are deliberately unusable. Recovery
  // must use the retained original plan/cache policy, not revalidate current settings.
  const anchor=path.join(f.project,'.paircoach','runtime-execution-layout.json'),oldAnchor=fs.readFileSync(anchor);
  fs.renameSync(anchor,path.join(f.root,'preserved-preupgrade-anchor.json'));
  fs.writeFileSync(f.config,'{BROKEN');fs.writeFileSync(path.join(f.project,'.paircoach','settings.json'),'{BROKEN');
  fs.renameSync(path.join(f.prepared,'receipt.json'),path.join(f.prepared,'old-receipt.json'));
  const app=f.app(),port=await app.listen(),p=(await f.http(port,'GET','/api/project')).body;
  assert.notEqual(p.sessionId,f.oldProject.sessionId);assert.deepEqual(fs.readFileSync(anchor),oldAnchor,'original plan independently recovers pre-anchor private layout');await f.connect(port,p.sessionId);
  const current=await f.http(port,'GET','/api/run/'+runId);assert.equal(current.status,200,JSON.stringify(current));assert.ok(validateRunV2(current.body));
  assert.equal(current.body.status,'PROCESS_STOP_UNCONFIRMED');assert.equal(current.body.profileId,f.accepted.profileId);assert.equal(current.body.configurationGeneration,f.accepted.configurationGeneration);
  assert.deepEqual(fs.readFileSync(journal),before);assert.equal(f.fake.calls.length,0,'startup/getProject does not dispatch original effects with broken config');
  const reconnect=await f.connect(port,p.sessionId);assert.equal(reconnect.bundle.lastRun,null);assert.equal(reconnect.bundle.report,null);
  f.fake.daemon=false;const denied=await f.http(port,'POST','/api/session/finish',finish(p));assert.ok(denied.status>=400);assert.equal(f.ai.length,0);
  assert.equal(app.session.state.lifecycle,'READY');assert.equal((await f.http(port,'GET','/api/file?path=main.js')).status,200);assert.equal(f.fake.calls.some(a=>a[0]==='rm'),false);
  f.fake.daemon=true;const stop=await f.http(port,'POST','/api/run/'+runId+'/stop',command(p));assert.equal(stop.status,202,JSON.stringify(stop));assert.equal(stop.body.status,'CANCELLED');assert.equal(stop.body.exitCode,137);
  const record=JSON.parse(fs.readFileSync(journal,'utf8'));assert.equal(record.phase,'REMOVED');assert.deepEqual(record.plan,originalRecord.plan);assert.ok(record.collection);assert.ok(record.outcome);
  assert.equal(f.fake.calls.filter(a=>a[0]==='stop').length,1);assert.equal(f.fake.calls.filter(a=>a[0]==='create'||a[0]==='start').length,0);
  assert.ok(f.fake.calls.findIndex(a=>a[0]==='logs')<f.fake.calls.findIndex(a=>a[0]==='rm'));
  assert.equal(reconnect.frames.some(m=>['RUN_STATE','RUN_OUTPUT'].includes(m.type)),false,'old Run does not enter current session stream/coach');
  const reconcile=await f.http(port,'POST','/api/runtime/mutation/reconcile',{mutation:{projectId:p.projectId,kind:'RUN',request:f.request}});
  assert.equal(reconcile.status,200,JSON.stringify(reconcile));assert.ok(validateMutationOutcomeV2(reconcile.body));assert.deepEqual(reconcile.body.result,f.accepted);assert.ok(reconcile.body.current);assert.equal(reconcile.body.current.run,null);
  const done=await f.http(port,'POST','/api/session/finish',finish(p));assert.equal(done.status,202,JSON.stringify(done));
  const facts=JSON.parse(JSON.parse(fs.readFileSync(path.join(f.project,'.paircoach','reports',sha(p.sessionId),'facts.json'),'utf8')).serialized);
  assert.deepEqual(facts.runs,[]);assert.equal(done.body.evidenceIds.includes(runId),false);
  await app.close();const restarted=f.app(),port2=await restarted.listen();assert.deepEqual((await f.http(port2,'GET','/api/run/'+runId)).body,stop.body);
});

for(const boundary of ['ADMITTED','STOPPED','COLLECTED','TERMINAL','REMOVED','FINAL'])test('UNIT genuine SIGKILL '+boundary+' restores original owner/Stop intent without create/start or premature cleanup',async t=>{
  const f=await crashed(t,boundary),app=f.app(),port=await app.listen(),p=(await f.http(port,'GET','/api/project')).body;await f.connect(port,p.sessionId);
  const id=f.accepted.runId,current=await f.http(port,'GET','/api/run/'+id);assert.equal(current.status,200,JSON.stringify(current));assert.ok(validateRunV2(current.body));
  assert.equal(f.fake.calls.filter(a=>['create','start','stop','rm'].includes(a[0])).length,0,'startup must not mutate original process');
  const r=await f.http(port,'POST','/api/run/'+id+'/stop',command(p));assert.equal(r.status,202,JSON.stringify(r));assert.equal(r.body.status,'CANCELLED');assert.ok(validateRunV2(r.body));
  assert.equal(f.fake.calls.filter(a=>a[0]==='create'||a[0]==='start').length,0);
  assert.deepEqual((await f.http(port,'POST','/api/runtime/mutation/reconcile',{mutation:{projectId:p.projectId,kind:'RUN',request:f.request}})).body.result,f.accepted);
  if(boundary==='ADMITTED') {
    assert.equal(r.body.exitCode,null);assert.equal(r.body.startedAt,null);assert.ok(r.body.processProblem);assert.equal(r.body.processProblem.code,'RUN_NOT_DISPATCHED');assert.equal(f.fake.calls.filter(a=>['create','start','stop','rm','logs'].includes(a[0])).length,0);
    assert.deepEqual(fs.readdirSync(path.join(f.state,'journal')).filter(n=>n.endsWith('.json')),[]);
  } else {
    assert.equal(r.body.exitCode,137);const record=JSON.parse(fs.readFileSync(path.join(f.state,'journal',id+'.json'),'utf8'));assert.equal(record.phase,'REMOVED');assert.ok(record.collection&&record.outcome&&record.exit);
    assert.equal(f.fake.calls.filter(a=>a[0]==='stop').length,0,'original Stop already exited; fresh exact read, no duplicate Stop');
  }
  await app.close();const next=f.app(),port2=await next.listen();assert.deepEqual((await f.http(port2,'GET','/api/run/'+id)).body,r.body);
});

for(const defect of ['MISSING_ADMISSION','PLAN_MISMATCH','COLLECTION_CHANGED'])test('UNIT retained '+defect+' fences finish/project replacement BEFORE final snapshot; manual editor still available',async t=>{
  const f=await crashed(t,defect==='COLLECTION_CHANGED'?'COLLECTED':'RUNNING');
  const mutationDirectory=path.join(f.project,'.paircoach','runtime-mutations');
  if(defect==='MISSING_ADMISSION') {
    const name=fs.readdirSync(mutationDirectory).find(n=>n.endsWith('.json'))!;
    fs.renameSync(path.join(mutationDirectory,name),path.join(f.root,'preserved-admission.json'));
  } else {
    const file=path.join(f.state,'journal',f.accepted.runId+'.json'),record=JSON.parse(fs.readFileSync(file,'utf8'));
    if(defect==='PLAN_MISMATCH'){record.plan.timeoutMs=1000;fs.writeFileSync(file,JSON.stringify(record));}
    else fs.writeFileSync(record.collection.stdoutPath,'TAMPERED COLLECTION');
  }
  const snapshotNames=()=>{const directory=path.join(f.project,'.paircoach','snapshots-v1');return fs.existsSync(directory)?fs.readdirSync(directory).sort():[];};
  const before=snapshotNames();
  const app=f.app(),port=await app.listen(),p=(await f.http(port,'GET','/api/project')).body;await f.connect(port,p.sessionId);
  assert.equal((await f.http(port,'GET','/api/file?path=main.js')).status,200);
  const refused=await f.http(port,'POST','/api/session/finish',finish(p));assert.equal(refused.status,409,JSON.stringify(refused));assert.equal(refused.body.code,'RUN_RECOVERY_REQUIRED');
  assert.equal(app.session.state.lifecycle,'READY');assert.equal(f.ai.length,0);
  assert.deepEqual(snapshotNames(),before,'no false final snapshot/report');
  const other=path.join(f.root,'other');fs.mkdirSync(other);fs.writeFileSync(path.join(other,'main.js'),'// unrelated');
  const replacement=await f.http(port,'POST','/api/project/open',{requestId:randomUUID(),clientId:'tab',rootPath:other,settings:f.settings});assert.equal(replacement.status,409,JSON.stringify(replacement));assert.equal(replacement.body.code,'RUN_RECOVERY_REQUIRED');
  assert.equal(app.workspace.rootPath,f.project);assert.equal(f.fake.calls.filter(a=>['create','start','stop','rm'].includes(a[0])).length,0);
  await assert.rejects(app.close(),{code:'RUN_RECOVERY_REQUIRED'});
  // close's finally has released this server/core; do not replay its cached expected
  // rejection inside the existing fixture's ordinary temp/socket teardown.
  app.close=async()=>{};
});
