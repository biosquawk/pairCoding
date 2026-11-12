/** Actual HTTP/kernel/native journals/Runner/report, actual SIGKILL. Docker/AI UNIT only. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fork} from 'node:child_process';
import {once} from 'node:events';
import {randomUUID} from 'node:crypto';
import {httpRunFixture,until,sha} from '../backend-cutover/http-run-report-fixture';
import {canonical} from '../../src/server/runtime-coordinator/storage';
import {validateRunV2} from '../../src/shared/validation-v2';
async function crash(t:test.TestContext,boundary='CREATED') {
 const f=await httpRunFixture(t),marker=path.join(f.root,'boundary'),daemonFile=path.join(f.root,'daemon.json');
 const child=fork(new URL('./child.ts',import.meta.url),[],{execArgv:['--import','tsx'],stdio:['ignore','ignore','pipe','ipc'],env:{...process.env,DISPATCH_CHILD:JSON.stringify({project:f.project,config:f.config,prepared:f.prepared,token:f.token,marker,daemonFile,boundary})}});
 let stderr='';child.stderr!.on('data',b=>stderr+=b);t.after(()=>{if(child.exitCode===null)child.kill('SIGKILL');});
 const ready=await Promise.race([once(child,'message').then(([m])=>m as {port:number}),once(child,'exit').then(()=>{throw Error('child failed '+stderr);}),new Promise<never>((_,reject)=>{const x=setTimeout(()=>reject(Error('child timeout '+stderr)),6000);x.unref();})]);
 const p=(await f.http(ready.port,'GET','/api/project')).body;await f.connect(ready.port,p.sessionId);
 const request=f.runRequest(p,'RUN_MAIN'),pending=f.http(ready.port,'POST','/api/run',request).catch(()=>null);await until(()=>fs.existsSync(marker));
 const exited=once(child,'exit');child.kill('SIGKILL');assert.equal((await exited)[1],'SIGKILL');await pending;
 const daemon=fs.existsSync(daemonFile)?JSON.parse(fs.readFileSync(daemonFile,'utf8')):{v:null,calls:[]};f.fake.v=daemon.v;
 assert.equal(daemon.calls.filter((a:string[])=>a[0]==='create').length,boundary==='CREATED'?1:0);assert.equal(daemon.calls.filter((a:string[])=>a[0]==='start').length,0);
 const directory=path.join(f.project,'.paircoach','runtime-mutations'),files=fs.readdirSync(directory).filter(n=>n.endsWith('.json'));assert.equal(files.length,1);
 const admission=path.join(directory,files[0]),stored=JSON.parse(fs.readFileSync(admission,'utf8')),stage=stored.body.runStage;
 assert.equal(stored.body.runDispatch,boundary==='ADMITTED'?'NOT_DISPATCHED':'MAY_HAVE_BEEN_DISPATCHED');assert.equal(stage.result.status,'QUEUED');
 assert.equal(fs.readdirSync(path.join(f.state,'run-state')).filter(n=>n.endsWith('.json')).length,0);
 if(boundary==='CREATED') {
  const journal=path.join(f.state,'journal',stage.result.runId+'.json'),record=JSON.parse(fs.readFileSync(journal,'utf8'));assert.equal(record.phase,'INTENT');
  fs.renameSync(journal,path.join(f.root,'preserved-original-executor-intent.json'));
 }
 return {...f,request,admission,stored,stage};
}
const finish=(p:any)=>({requestId:randomUUID(),clientId:'tab',sessionId:p.sessionId,expectedWorkspaceVersion:p.workspaceVersion,reason:'COMPLETED'});
for(const defect of ['LOST_EXECUTOR','CLAIMED_NO_EXECUTOR','LEGACY_ADMITTED','LEGACY_POSTCREATE'] as const)test('UNIT positive dispatch protocol fences '+defect+' before snapshot/report/project adoption',async t=>{
 const f=await crash(t,defect==='CLAIMED_NO_EXECUTOR'?'CLAIMED':defect==='LEGACY_ADMITTED'?'ADMITTED':'CREATED');
 if(defect.startsWith('LEGACY')) {
  delete f.stored.body.runDispatch;f.stored.sha256=sha(canonical(f.stored.body));fs.writeFileSync(f.admission,canonical(f.stored));
 }
 const before=fs.readFileSync(f.admission),snapshotDirectory=path.join(f.project,'.paircoach','snapshots-v1');
 const snapshots=()=>fs.existsSync(snapshotDirectory)?fs.readdirSync(snapshotDirectory).sort():[];
 const beforeSnapshots=snapshots(),app=f.app(),port=await app.listen(),p=(await f.http(port,'GET','/api/project')).body;await f.connect(port,p.sessionId);
 const current=(await f.http(port,'GET','/api/run/'+f.stage.result.runId)).body;
 assert.ok(validateRunV2(current));assert.equal(current.status,'PROCESS_STOP_UNCONFIRMED');assert.equal(current.finishedAt,null);assert.equal(current.startedAt,null);assert.equal(current.exitCode,null);assert.notEqual(current.processProblem?.code,'RUN_NOT_DISPATCHED');
 const finished=await f.http(port,'POST','/api/session/finish',finish(p));assert.equal(finished.status,409);assert.equal(finished.body.code,'RUN_RECOVERY_REQUIRED');
 assert.equal(app.session.state.lifecycle,'READY');assert.equal(f.ai.length,0);assert.deepEqual(snapshots(),beforeSnapshots);
 assert.equal((await f.http(port,'GET','/api/file?path=main.js')).status,200);
 const other=path.join(f.root,'other');fs.mkdirSync(other);fs.writeFileSync(path.join(other,'main.js'),'// unrelated');
 const opened=await f.http(port,'POST','/api/project/open',{requestId:randomUUID(),clientId:'tab',rootPath:other,settings:f.settings});assert.equal(opened.status,409);assert.equal(opened.body.code,'RUN_RECOVERY_REQUIRED');assert.equal(app.workspace.rootPath,f.project);
 const replay=await f.http(port,'POST','/api/runtime/mutation/reconcile',{mutation:{projectId:p.projectId,kind:'RUN',request:f.request}});assert.equal(replay.body.state,'COMMITTED');assert.deepEqual(replay.body.result,f.stage.result,'original QUEUED is unchanged, not a process-success claim');
 assert.equal(f.fake.calls.some(a=>['create','start','stop','rm'].includes(a[0])),false);
 if(defect==='LOST_EXECUTOR'||defect==='LEGACY_POSTCREATE')assert.ok(f.fake.v,'uncertain owned modeled created container is preserved, not claimed removed');
 const final=JSON.parse(fs.readFileSync(f.admission,'utf8'));assert.deepEqual(final.body.runStage,f.stage);assert.equal(final.body.runDispatch,f.stored.body.runDispatch);
 assert.ok(before.length>0);
 await assert.rejects(app.close(),{code:'RUN_RECOVERY_REQUIRED'});app.close=async()=>{};
});
test('UNIT genuine ADMITTED positively revokes durable authority; stable no-process cancellation and original QUEUED survive two reopens',async t=>{
 const f=await crash(t,'ADMITTED'),app=f.app(),port=await app.listen(),p=(await f.http(port,'GET','/api/project')).body;await f.connect(port,p.sessionId);
 const run=(await f.http(port,'GET','/api/run/'+f.stage.result.runId)).body;assert.ok(validateRunV2(run));assert.equal(run.status,'CANCELLED');assert.equal(run.processProblem?.code,'RUN_NOT_DISPATCHED');assert.equal(run.startedAt,null);assert.equal(run.exitCode,null);
 let record=JSON.parse(fs.readFileSync(f.admission,'utf8'));assert.equal(record.body.runDispatch,'REVOKED');assert.deepEqual(record.body.runStage,f.stage);
 assert.equal(f.fake.calls.some(a=>['create','start','stop','rm','logs'].includes(a[0])),false);
 assert.equal((await f.http(port,'POST','/api/session/finish',finish(p))).status,202);assert.equal(f.ai.length,1);
 await app.close();const next=f.app(),port2=await next.listen();assert.deepEqual((await f.http(port2,'GET','/api/run/'+f.stage.result.runId)).body,run);
 record=JSON.parse(fs.readFileSync(f.admission,'utf8'));assert.equal(record.body.runDispatch,'REVOKED');assert.deepEqual(record.body.outcome.result,f.stage.result);
 const current=(await f.http(port2,'GET','/api/project')).body;await f.connect(port2,current.sessionId);
 const fresh=await f.http(port2,'POST','/api/run',f.runRequest(current,'RUN_MAIN'));assert.equal(fresh.status,202,JSON.stringify(fresh));
 const stopped=await f.http(port2,'POST','/api/run/'+fresh.body.runId+'/stop',{requestId:randomUUID(),clientId:'tab',sessionId:current.sessionId});assert.equal(stopped.status,202);
});
