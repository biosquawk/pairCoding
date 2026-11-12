import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { fork } from 'node:child_process';
import { httpNetworkFixture } from './http-network-fixture';
const route='/api/runtime/service-network/prepare';
const request=(p:any,epoch=0)=>({requestId:randomUUID(),clientId:'tab',sessionId:p.sessionId,expectedWorkspaceVersion:p.workspaceVersion,
  configurationGeneration:p.capabilities.execution.runtime.configurationGeneration,controlEpoch:epoch});

test('UNIT actual authenticated HTTP explicit prepare joins same factory identity, exact receipt readiness, immutable original and restart readback; no implicit prepare',async t=>{
  const f=await httpNetworkFixture(t,true),a=f.app(),port=await a.listen();
  const p=(await f.http(port,'GET','/api/project')).body;
  assert.equal(p.capabilities.execution.modes.RUN_MAIN.canRun,false);assert.equal(p.capabilities.execution.modes.RUN_MAIN.problem.code,'SERVICE_NETWORK_PREPARE_REQUIRED');
  assert.equal(p.capabilities.execution.modes.RUN_TESTS.canRun,true,JSON.stringify(p));
  await f.connect(port,p.sessionId);await f.http(port,'GET','/api/project');
  assert.equal(f.networkCalls.filter(a=>a[1]==='create').length,0);
  const original=request(p),r=await f.http(port,'POST',route,original);assert.equal(r.status,200,JSON.stringify(r));
  const identity=JSON.parse(fs.readFileSync(path.join(f.state,'installation.json'),'utf8'));
  assert.equal(r.body.installationId,identity.installationId);assert.equal(r.body.projectId,p.projectId);assert.equal(r.body.engineId,f.fake.engineId);
  assert.equal(r.body.name,`paircoach-${identity.installationId}-service`);assert.equal(r.body.networkId,f.getNetwork()!.Id);
  const stored=JSON.parse(fs.readFileSync(path.join(f.state,'service-network','receipt.json'),'utf8'));assert.equal(stored.networkId,r.body.networkId);
  const directory=path.join(f.project,'.paircoach','runtime-network-maintenance'),file=fs.readdirSync(directory).find(n=>n.endsWith('.json'))!;
  const bytes=fs.readFileSync(path.join(directory,file));assert.deepEqual(JSON.parse(bytes.toString()).body.request,original);
  assert.equal((await f.http(port,'GET','/api/project')).body.capabilities.execution.modes.RUN_MAIN.canRun,true);
  assert.deepEqual((await f.http(port,'POST',route,original)).body,r.body);assert.deepEqual(fs.readFileSync(path.join(directory,file)),bytes);
  assert.equal(f.networkCalls.filter(a=>a[1]==='create').length,1);
  const conflicting=await f.http(port,'POST',route,{...original,expectedWorkspaceVersion:123});assert.equal(conflicting.status,409);assert.equal(conflicting.body.code,'IDEMPOTENCY_CONFLICT');
  await a.close();const b=f.app(),port2=await b.listen(),p2=(await f.http(port2,'GET','/api/project')).body;await f.connect(port2,p2.sessionId);
  assert.notEqual(p2.sessionId,original.sessionId);assert.deepEqual((await f.http(port2,'POST',route,original)).body,r.body);
  assert.deepEqual(fs.readFileSync(path.join(directory,file)),bytes);assert.equal(f.networkCalls.filter(a=>a[1]==='create').length,1);
  // A same-name external/replaced bridge cannot inherit readiness from an old public response.
  f.setNetwork({...f.getNetwork()!,Id:'1'.repeat(64)});
  const changed=(await f.http(port2,'GET','/api/project')).body;assert.equal(changed.capabilities.execution.modes.RUN_MAIN.canRun,false);
  assert.equal(changed.capabilities.execution.modes.RUN_MAIN.problem.code,'SERVICE_NETWORK_PREPARE_REQUIRED');assert.equal(changed.capabilities.execution.modes.RUN_TESTS.canRun,true);
  assert.equal((await f.http(port2,'POST',route,original)).status,503);assert.equal(f.networkCalls.filter(a=>a[1]==='create').length,1);
});

test('UNIT exact HTTP maintenance schema/auth/student scope rejects all caller-selected Docker surfaces without creating a request or network',async t=>{
  const f=await httpNetworkFixture(t),a=f.app(),port=await a.listen(),p=(await f.http(port,'GET','/api/project')).body;await f.connect(port,p.sessionId);
  const original=request(p);
  assert.equal((await f.http(port,'POST',route,original,'wrong_token')).status,401);
  for(const field of ['network','path','engineId','installationId','flags','transport','rootPath','assertCurrent']) {
    const r=await f.http(port,'POST',route,{...original,[field]:'untrusted'});assert.equal(r.status,400,field);assert.equal(r.body.code,'VALIDATION_ERROR');
  }
  for(const delta of [{controlEpoch:1},{configurationGeneration:'stale'},{expectedWorkspaceVersion:5},{clientId:'foreign'},{sessionId:'foreign'}])assert.ok((await f.http(port,'POST',route,{...original,...delta})).status>=400);
  assert.equal(f.networkCalls.filter(a=>a[1]==='create').length,0);
  assert.equal(fs.readdirSync(path.join(f.project,'.paircoach','runtime-network-maintenance')).filter(n=>n.endsWith('.json')).length,0);
  assert.equal((await f.http(port,'GET','/api/file?path=main.js')).status,200);
});

test('UNIT actual lost network create reply persists complete original; same HTTP request after restart reconciles actual helper intent, never second create',async t=>{
  const f=await httpNetworkFixture(t),a=f.app(),port=await a.listen(),p=(await f.http(port,'GET','/api/project')).body;await f.connect(port,p.sessionId);f.loseCreate();
  const original=request(p),r=await f.http(port,'POST',route,original);assert.equal(r.status,503,JSON.stringify(r));assert.equal(r.body.code,'SERVICE_NETWORK_OUTCOME_UNKNOWN');
  const directory=path.join(f.project,'.paircoach','runtime-network-maintenance'),file=fs.readdirSync(directory).find(n=>n.endsWith('.json'))!;
  const pending=JSON.parse(fs.readFileSync(path.join(directory,file),'utf8'));assert.deepEqual(pending.body.request,original);assert.equal(pending.body.result,null);
  assert.equal((await f.http(port,'POST',route,request(p))).status,409);assert.equal(f.networkCalls.filter(a=>a[1]==='create').length,1);
  await a.close();f.restoreReadback();const b=f.app(),port2=await b.listen(),p2=(await f.http(port2,'GET','/api/project')).body;await f.connect(port2,p2.sessionId);
  const recovered=await f.http(port2,'POST',route,original);assert.equal(recovered.status,200,JSON.stringify(recovered));assert.equal(recovered.body.networkId,f.getNetwork()!.Id);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(directory,file),'utf8')).body.request,original);assert.equal(f.networkCalls.filter(a=>a[1]==='create').length,1);
  f.setWrongEngine(true);assert.equal((await f.http(port2,'POST',route,original)).status,503);assert.equal(f.networkCalls.filter(a=>a[1]==='create').length,1);f.setWrongEngine(false);
});

test('UNIT actual active Run excludes maintenance; network-none Run and manual editing never implicitly prepare',async t=>{
  const f=await httpNetworkFixture(t),a=f.app(),port=await a.listen(),p=(await f.http(port,'GET','/api/project')).body;await f.connect(port,p.sessionId);
  const accepted=await f.http(port,'POST','/api/run',f.runRequest(p,'RUN_MAIN'));assert.equal(accepted.status,202,JSON.stringify(accepted));
  const refused=await f.http(port,'POST',route,request(p));assert.equal(refused.status,409,JSON.stringify(refused));assert.equal(refused.body.code,'RUN_IN_PROGRESS');assert.equal(f.networkCalls.filter(a=>a[1]==='create').length,0);
  assert.equal(f.fake.calls.find(a=>a[0]==='create')!.includes('none'),true);
  assert.equal((await f.http(port,'GET','/api/file?path=main.js')).status,200);
  await f.http(port,'POST','/api/run/'+accepted.body.runId+'/stop',{requestId:randomUUID(),clientId:'tab',sessionId:p.sessionId});
});

test('UNIT genuine SIGKILL durable Run orphan fences network maintenance after real restart with empty Runner RAM; no Docker create replay',async t=>{
  const f=await httpNetworkFixture(t);
  const child=fork(new URL('./http-network-orphan-child.ts',import.meta.url),[],{execArgv:['--import','tsx'],stdio:['ignore','ignore','pipe','ipc'],
    env:{...process.env,NETWORK_CHILD:JSON.stringify({project:f.project,config:f.config,prepared:f.prepared,token:f.token})}});
  let stderr='';child.stderr!.on('data',b=>stderr+=b.toString());t.after(()=>{if(child.exitCode===null)child.kill('SIGKILL');});
  const ready=await Promise.race([once(child,'message').then(([m])=>m as {port:number}),once(child,'exit').then(()=>{throw Error('Child exited before ready: '+stderr);}),new Promise<never>((_,reject)=>{const timer=setTimeout(()=>reject(Error('Child timeout: '+stderr)),5000);timer.unref();})]);
  const p=(await f.http(ready.port,'GET','/api/project')).body;await f.connect(ready.port,p.sessionId);
  const accepted=await f.http(ready.port,'POST','/api/run',f.runRequest(p,'RUN_MAIN'));assert.equal(accepted.status,202,JSON.stringify(accepted));
  const journal=path.join(f.state,'journal',accepted.body.runId+'.json'),before=fs.readFileSync(journal);assert.equal(JSON.parse(before.toString()).phase,'RUNNING');
  const exited=once(child,'exit');child.kill('SIGKILL');await exited;
  const app=f.app(),port=await app.listen(),p2=(await f.http(port,'GET','/api/project')).body;await f.connect(port,p2.sessionId);
  // No reconstructed runner yet: the durable journal, not RAM, is the fence exercised here.
  assert.equal((await f.http(port,'GET','/api/run/'+accepted.body.runId)).status,404);
  const denied=await f.http(port,'POST',route,request(p2));assert.equal(denied.status,409,JSON.stringify(denied));
  assert.equal(denied.body.code,'SERVICE_NETWORK_NOT_DISPATCHED');assert.equal(f.networkCalls.filter(a=>a[1]==='create').length,0);
  assert.deepEqual(fs.readFileSync(journal),before);assert.equal(f.fake.calls.filter(a=>a[0]==='create').length,0);
  assert.equal((await f.http(port,'GET','/api/file?path=main.js')).status,200);
});

test('UNIT actual maintenance holds SAME source FIFO; Veto during lost effect preserves UNKNOWN ownership and exact original, no implicit retry',async t=>{
  const f=await httpNetworkFixture(t),app=f.app(),port=await app.listen(),p=(await f.http(port,'GET','/api/project')).body;await f.connect(port,p.sessionId);
  let enter!:()=>void,release!:()=>void;const entered=new Promise<void>(r=>enter=r),held=new Promise<void>(r=>release=r);
  const doc=app.workspace.getDocument('main.js');
  f.holdCreate(async()=>{enter();await held;});const original=request(p),pending=f.http(port,'POST',route,original);await entered;
  let wrote=false;
  const write=app.gate.writeAsync({clientId:'tab',sessionId:p.sessionId,actor:'STUDENT',controlEpoch:0,path:'main.js',baseVersion:doc.version,content:'QUEUED HUMAN EDIT\n'}).then(()=>{wrote=true;});
  const refusedWrite=assert.rejects(write,{code:'STALE_EPOCH'});
  try {await new Promise(r=>setTimeout(r,15));assert.equal(wrote,false);app.session.veto();} finally {release();}
  const unknown=await pending;assert.equal(unknown.status,503,JSON.stringify(unknown));assert.equal(unknown.body.code,'SERVICE_NETWORK_OUTCOME_UNKNOWN');
  await refusedWrite;assert.equal(f.networkCalls.filter(a=>a[1]==='create').length,1);
  assert.equal(fs.existsSync(path.join(f.state,'service-network','receipt.json')),false,'late Veto cannot mint a successful receipt');
  const directory=path.join(f.project,'.paircoach','runtime-network-maintenance'),file=fs.readdirSync(directory).find(n=>n.endsWith('.json'))!;
  const e=JSON.parse(fs.readFileSync(path.join(directory,file),'utf8'));assert.deepEqual(e.body.request,original);assert.equal(e.body.result,null);assert.ok(e.body.context);
});

test('UNIT unknown create requires fresh durable absence reconciliation; same original never recreates, only separately explicit NEW request may prepare',async t=>{
  const f=await httpNetworkFixture(t),app=f.app(),port=await app.listen(),p=(await f.http(port,'GET','/api/project')).body;await f.connect(port,p.sessionId);
  f.failCreateBeforeEffect();const original=request(p),unknown=await f.http(port,'POST',route,original);
  assert.equal(unknown.status,503,JSON.stringify(unknown));assert.equal(f.getNetwork(),null);assert.equal(f.networkCalls.filter(a=>a[1]==='create').length,1);
  assert.equal((await f.http(port,'POST',route,request(p))).status,409);f.restoreReadback();f.allowCreate();
  const absent=await f.http(port,'POST',route,original);assert.equal(absent.status,409,JSON.stringify(absent));assert.equal(absent.body.code,'SERVICE_NETWORK_ABSENCE_CONFIRMED');
  assert.equal(f.networkCalls.filter(a=>a[1]==='create').length,1);
  const dir=path.join(f.project,'.paircoach','runtime-network-maintenance'),oldFile=fs.readdirSync(dir).find(n=>n.endsWith('.json'))!,oldBytes=fs.readFileSync(path.join(dir,oldFile));
  assert.equal(JSON.parse(oldBytes.toString()).body.state,'ABSENCE_CONFIRMED');assert.ok(fs.existsSync(path.join(f.state,'service-network','absence-001.json')));
  assert.equal((await f.http(port,'POST',route,original)).status,409);assert.equal(f.networkCalls.filter(a=>a[1]==='create').length,1);
  const fresh=await f.http(port,'POST',route,request(p));assert.equal(fresh.status,200,JSON.stringify(fresh));assert.equal(f.networkCalls.filter(a=>a[1]==='create').length,2);
  assert.deepEqual(fs.readFileSync(path.join(dir,oldFile)),oldBytes);assert.equal((await f.http(port,'POST',route,original)).body.code,'SERVICE_NETWORK_ABSENCE_CONFIRMED');
});
