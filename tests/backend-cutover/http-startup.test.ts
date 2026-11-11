import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import WebSocket from 'ws';
import { createPairCoachServer, type ServerOptions } from '../../src/server/http';
import { validateV2WireShape } from '../../src/shared/validation-v2';
import type { SettingsV2 } from '../../src/shared/runtime-v2';

const settings:SettingsV2={schemaVersion:2,taskFilePath:'task.md',taskMode:'IMPLEMENTATION',reviewNotesPath:'review.md',runProfiles:[],aiConsent:false,contextPatterns:[]};
function fixture(t:TestContext) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'backend-http-startup-')), project=path.join(root,'project'), other=path.join(root,'other');
  for(const p of [project,other]){fs.mkdirSync(p);fs.writeFileSync(path.join(p,'source.js'),'\ufeffORIGINAL\r\n');fs.writeFileSync(path.join(p,'task.md'),'TASK\n');}
  const config=path.join(root,'missing-runtime.json'), apps:ReturnType<typeof createPairCoachServer>[]=[], token='local-only-test-token';
  const app=(options:ServerOptions={})=>{
    const a=createPairCoachServer({port:0,token,devBootstrap:true,runtimeEnvironment:{},runtimeArguments:['--runtime-config',config],...options});apps.push(a);return a;
  };
  const http=async(port:number,method:string,url:string,body?:unknown,headers:Record<string,string>={})=>{
    const r=await fetch(`http://127.0.0.1:${port}${url}`,{method,headers:{Authorization:`Bearer ${token}`,...body!==undefined?{'Content-Type':'application/json'}:{},...headers},body:body===undefined?undefined:JSON.stringify(body)});
    return {status:r.status,body:await r.json()};
  };
  t.after(async()=>{for(const a of apps)await a.close();fs.rmSync(root,{recursive:true,force:true});});
  return {root,project,other,config,app,http,token};
}
function peer(t:TestContext,port:number) {
  const ws=new WebSocket(`ws://127.0.0.1:${port}/ws/session`), frames:any[]=[], waiters=new Set<()=>void>();
  ws.on('message',data=>{frames.push(JSON.parse(data.toString()));for(const wake of waiters)wake();});
  const wait=(match:(frame:any)=>boolean)=>new Promise<any>((resolve,reject)=>{
    const deadline=setTimeout(()=>{waiters.delete(check);reject(Error('Expected ordered frame '+match.toString()+' not received; socket='+ws.readyState+'; received='+JSON.stringify(frames.map(f=>({type:f.type,replyTo:f.payload?.replyTo,status:f.payload?.status,code:f.payload?.error?.code})))));},3000);
    const check=()=>{const found=frames.find(match);if(found){clearTimeout(deadline);waiters.delete(check);resolve(found);}};
    waiters.add(check);check();
  });
  t.after(()=>ws.terminate());
  return {ws,frames,wait,open:()=>once(ws,'open'),send:(sessionId:string,clientId:string,type:string,payload:unknown,messageId=randomUUID())=>{
    ws.send(JSON.stringify({protocolVersion:'3.0',sessionId,clientId,type,payload,messageId}));return messageId;
  }};
}
const openBody=(rootPath:string,clientId='tab')=>({requestId:randomUUID(),clientId,rootPath,settings});

test('HTTP actual UNBOUND preserves auth/CSRF and has no project/session/file/bootstrap fiction or temp workspace',async t=>{
  const f=fixture(t), before=fs.readdirSync(os.tmpdir()).filter(x=>x.startsWith('paircoach-workspace-')).sort(), a=f.app(), port=await a.listen();
  assert.throws(()=>a.workspace,{code:'PROJECT_OPEN_REQUIRED',status:409});
  assert.equal((await f.http(port,'GET','/api/project',undefined,{Authorization:'Bearer bad'})).status,401);
  assert.equal((await f.http(port,'GET','/api/project',undefined,{Origin:'https://foreign.invalid'})).status,403);
  for(const route of ['/api/project','/api/session','/api/file?path=source.js','/api/snapshots']){
    const r=await f.http(port,'GET',route);assert.equal(r.status,409);assert.equal(r.body.code,'PROJECT_OPEN_REQUIRED');assert.equal(r.body.sessionId,undefined);
  }
  const b=await f.http(port,'GET','/dev/bootstrap');assert.equal(b.status,200);assert.deepEqual(b.body,{token:f.token});
  const p=peer(t,port);await p.open();const closed=once(p.ws,'close');p.send('invented-session','tab','HELLO',{token:f.token,lastServerSeq:0});await closed;
  assert.equal(p.frames.some(x=>x.type==='SESSION_SNAPSHOT'),false);
  assert.equal(fs.existsSync(path.join(f.project,'.paircoach')),false);
  assert.deepEqual(fs.readdirSync(os.tmpdir()).filter(x=>x.startsWith('paircoach-workspace-')).sort(),before);
});
test('HTTP explicit open awaits real canonical V2 authority and ignores form defaults as SAVE',async t=>{
  const f=fixture(t), a=f.app(), port=await a.listen();
  const body={...openBody(f.project),settings:{...settings,aiConsent:true,taskMode:'CODE_REVIEW'}};
  const r=await f.http(port,'POST','/api/project/open',body);assert.equal(r.status,201);assert.ok(validateV2WireShape('Project',r.body));
  assert.equal(r.body.settings.aiConsent,false);assert.equal(r.body.settings.taskMode,'IMPLEMENTATION');
  assert.equal(r.body.capabilities.execution.runtime.problem.code,'LEGACY_RUN_PROFILE_REQUIRES_MIGRATION');
  assert.equal(r.body.capabilities.execution.modes.RUN_MAIN.canRun,false);assert.equal(r.body.capabilities.language.state,'OFF');
  assert.equal(a.workspace.rootPath,f.project);assert.equal(a.workspace.dataDir,path.join(f.project,'.paircoach'));
  assert.equal(fs.existsSync(path.join(f.project,'.paircoach','settings.json')),false);assert.equal(a.workspace.workspaceVersion,0);
  const p=peer(t,port);await p.open();p.send(r.body.sessionId,'tab','HELLO',{token:f.token,lastServerSeq:0});
  const snap=await p.wait(x=>x.type==='SESSION_SNAPSHOT');assert.ok(validateV2WireShape('ServerMessage',snap));assert.equal(snap.payload.languageBootstrap,null);
  const before=await f.http(port,'GET','/api/file?path=source.js');
  const id=p.send(r.body.sessionId,'tab','CODE_CHANGED',{path:'source.js',baseVersion:before.body.version,controlEpoch:snap.payload.session.controlEpoch,content:'STUDENT\n',editKind:'TYPING'});
  const ack=await p.wait(x=>x.type==='ACK'&&x.payload.replyTo===id);assert.equal(ack.payload.status,'OK');
  assert.equal(fs.readFileSync(path.join(f.project,'source.js'),'utf8'),'\ufeffSTUDENT\r\n');assert.equal(ack.payload.workspaceVersion,1);
  assert.equal(fs.existsSync(path.join(f.project,'.paircoach','settings.json')),false);
});
test('HTTP bound invalid runtime/malformed settings retain actual bytes, safe metadata, editor and V2 schema',async t=>{
  const f=fixture(t), dir=path.join(f.project,'.paircoach');fs.mkdirSync(dir);const raw='{malformed PRIVATE original\r\n';fs.writeFileSync(path.join(dir,'settings.json'),raw);
  const a=f.app({rootPath:f.project,enableExecution:true}), port=await a.listen(), r=await f.http(port,'GET','/api/project');
  assert.equal(r.status,200);assert.ok(validateV2WireShape('Project',r.body));assert.equal(r.body.capabilities.execution.runtime.state,'CONFIG_ERROR');assert.equal(r.body.settings.runProfiles.length,0);
  assert.equal(fs.readFileSync(path.join(dir,'settings.json'),'utf8'),raw);assert.equal(a.workspace.settings.runProfiles.length,0);
  const p=peer(t,port);await p.open();p.send(r.body.sessionId,'tab','HELLO',{token:f.token,lastServerSeq:0});const snap=await p.wait(x=>x.type==='SESSION_SNAPSHOT');
  const run=await f.http(port,'POST','/api/run',{requestId:randomUUID(),clientId:'tab',sessionId:r.body.sessionId,mode:'RUN_MAIN',expectedWorkspaceVersion:0,configurationGeneration:r.body.capabilities.execution.runtime.configurationGeneration});
  assert.equal(run.status,503);assert.equal(run.body.code,'RUNTIME_MUTATION_NOT_COMPOSED');
  const file=await f.http(port,'POST','/api/file',{requestId:randomUUID(),clientId:'tab',sessionId:r.body.sessionId,controlEpoch:snap.payload.session.controlEpoch,operation:'CREATE',path:'new.js',content:'MANUAL\n',newPath:null,baseVersion:null});
  assert.equal(file.status,200);assert.ok(validateV2WireShape('Project',file.body));assert.equal(fs.readFileSync(path.join(f.project,'new.js'),'utf8'),'MANUAL\n');
  assert.equal(fs.readFileSync(path.join(dir,'settings.json'),'utf8'),raw);
});
test('HTTP invalid root/schema and fallible preparation never replace current canonical binding or leak new owner',async t=>{
  const f=fixture(t);let calls=0;const a=f.app({rootPath:f.project,enableCoach:true,coachFactory:()=>{
    if(++calls>1)throw Error('NEW binding preparation failed');return {trigger(){},controlReady(){},stepRendered(){},abort(){},close(){}};
  }}),port=await a.listen(), original=(await f.http(port,'GET','/api/project')).body;
  assert.equal((await f.http(port,'POST','/api/project/open',{...openBody(f.other),extra:true})).status,400);
  const failure=await f.http(port,'POST','/api/project/open',openBody(f.other));assert.equal(failure.status,500);
  const after=(await f.http(port,'GET','/api/project')).body;assert.equal(after.sessionId,original.sessionId);assert.equal(after.rootPath,f.project);
  const b=f.app({rootPath:f.other});await b.listen();assert.equal(b.workspace.rootPath,f.other,'failed prepared core released its kernel ownership');
});
test('HTTP startup failure and close-before-listen release real recovery owner and leave no listener',async t=>{
  const f=fixture(t), bad=f.app({rootPath:f.project,enableCoach:true,coachFactory:()=>{throw Error('actual factory failure');}});
  await assert.rejects(bad.listen(),/actual factory failure/);assert.equal(bad.server.listening,false);await bad.close();
  const a=f.app({rootPath:f.project});await a.close();assert.equal(a.server.listening,false);await assert.rejects(a.listen(),{code:'SESSION_CLOSED'});
  const reopened=f.app({rootPath:f.project});await reopened.listen();assert.equal(reopened.workspace.rootPath,f.project);
});
test('HTTP invalid startup arguments/noncanonical data storage refuse; repeated close is safe and canonical owner can reopen',async t=>{
  const f=fixture(t), invalid=f.app({runtimeArguments:['--runtime-config','relative-private']});await assert.rejects(invalid.listen(),{code:'INVALID_STARTUP_ARGUMENTS'});await invalid.close();
  assert.equal(fs.existsSync(path.join(f.project,'.paircoach')),false);
  const bad=f.app({rootPath:f.project,dataDir:path.join(f.root,'alternative')});await assert.rejects(bad.listen(),{code:'INVALID_V2_DATA_DIR'});await Promise.all([bad.close(),bad.close()]);
  assert.equal(fs.existsSync(path.join(f.root,'alternative')),false);assert.equal(fs.existsSync(path.join(f.project,'.paircoach')),false,'noncanonical dataDir refuses before initialization');
  const a=f.app({rootPath:f.project});await a.listen();assert.equal(a.workspace.workspaceVersion,0);
});
test('HTTP concurrent listen shares one startup/core/listener and close racing startup cannot create a late listener',async t=>{
  const f=fixture(t), a=f.app({rootPath:f.project});const [p1,p2]=await Promise.all([a.listen(),a.listen()]);assert.equal(p1,p2);assert.equal(await a.listen(),p1);
  await Promise.all([a.close(),a.close()]);assert.equal(a.server.listening,false);
  const b=f.app({rootPath:f.project}), listening=b.listen();const closed=b.close();await assert.rejects(listening,{code:'SESSION_CLOSED'});await closed;assert.equal(b.server.listening,false);
  const c=f.app({rootPath:f.project});await c.listen();
});
test('HTTP project adoption resets project context but keeps global sequence and old peer cannot mutate',async t=>{
  const f=fixture(t), a=f.app({rootPath:f.project}), port=await a.listen(), initial=(await f.http(port,'GET','/api/project')).body;
  const p=peer(t,port);await p.open();p.send(initial.sessionId,'tab','HELLO',{token:f.token,lastServerSeq:0});const before=await p.wait(x=>x.type==='SESSION_SNAPSHOT');
  const same=await f.http(port,'POST','/api/project/open',openBody(f.project));assert.equal(same.status,201);assert.equal(same.body.sessionId,initial.sessionId);
  const closed=once(p.ws,'close'), next=await f.http(port,'POST','/api/project/open',openBody(f.other));assert.equal(next.status,201);await closed;
  assert.notEqual(next.body.sessionId,initial.sessionId);assert.equal(a.workspace.rootPath,f.other);
  const q=peer(t,port);await q.open();q.send(next.body.sessionId,'tab','HELLO',{token:f.token,lastServerSeq:before.seq});const after=await q.wait(x=>x.type==='SESSION_SNAPSHOT');
  assert.ok(after.seq>before.seq);assert.deepEqual(after.payload.chat,[]);assert.deepEqual(after.payload.proposals,[]);assert.equal(after.payload.lastRun,null);
});
test('HTTP async HELLO is ordered before pipelined CODE_CHANGED; old same-client queued write is revoked under actual gate',async t=>{
  const f=fixture(t), a=f.app({rootPath:f.project}), port=await a.listen(), r=(await f.http(port,'GET','/api/project')).body;
  const p=peer(t,port);await p.open();const epoch=a.session.state.controlEpoch;
  p.send(r.sessionId,'tab','HELLO',{token:f.token,lastServerSeq:0});const id=p.send(r.sessionId,'tab','CODE_CHANGED',{path:'source.js',baseVersion:1,controlEpoch:epoch,content:'FIRST\n',editKind:'TYPING'});
  const first=await p.wait(x=>x.type==='ACK'&&x.payload.replyTo===id);assert.equal(first.payload.status,'OK');
  let release!:()=>void, entered!:()=>void;const held=new Promise<void>(resolve=>{entered=resolve;}), finish=new Promise<void>(resolve=>{release=resolve;});
  const lease=a.gate._withLanguageSourceLease({clientId:'tab',sessionId:r.sessionId,controlEpoch:a.session.state.controlEpoch,actor:'STUDENT',expectedWorkspaceVersion:a.workspace.workspaceVersion},()=>{},async()=>{entered();await finish;});
  await held;
  p.send(r.sessionId,'tab','CODE_CHANGED',{path:'source.js',baseVersion:2,controlEpoch:a.session.state.controlEpoch,content:'REVOKED\n',editKind:'TYPING'});
  const closed=once(p.ws,'close'), q=peer(t,port);await q.open();q.send(r.sessionId,'tab','HELLO',{token:f.token,lastServerSeq:first.seq});await closed;
  release();await lease;await q.wait(x=>x.type==='SESSION_SNAPSHOT');const ping=q.send(r.sessionId,'tab','PING',{lastAppliedSeq:first.seq});await q.wait(x=>x.type==='ACK'&&x.payload.replyTo===ping);
  assert.equal(a.workspace.getDocument('source.js').content,'FIRST\n');assert.equal(a.workspace.workspaceVersion,1);
});
test('HTTP immediate Veto bypasses async peer FIFO and revokes queued write before root lease release',async t=>{
  const f=fixture(t), a=f.app({rootPath:f.project}), port=await a.listen(), r=(await f.http(port,'GET','/api/project')).body;
  const p=peer(t,port);await p.open();p.send(r.sessionId,'tab','HELLO',{token:f.token,lastServerSeq:0});const snap=await p.wait(x=>x.type==='SESSION_SNAPSHOT');
  let release!:()=>void, entered!:()=>void;const enteredPromise=new Promise<void>(r=>{entered=r;}), finish=new Promise<void>(r=>{release=r;});
  const epoch=a.session.state.controlEpoch, lease=a.gate._withLanguageSourceLease({clientId:'tab',sessionId:r.sessionId,controlEpoch:epoch,actor:'STUDENT',expectedWorkspaceVersion:0},()=>{},async()=>{entered();await finish;}).catch(e=>e);
  await enteredPromise;
  const id=p.send(r.sessionId,'tab','CODE_CHANGED',{path:'source.js',baseVersion:1,controlEpoch:epoch,content:'OLD\n',editKind:'TYPING'});
  const veto=p.send(r.sessionId,'tab','VETO_ESCAPE',{controlEpoch:epoch,activeInterventionId:null,lastAppliedSeq:snap.seq});
  assert.equal((await p.wait(x=>x.type==='ACK'&&x.payload.replyTo===veto)).payload.status,'OK');
  release();await lease;assert.equal((await p.wait(x=>x.type==='ACK'&&x.payload.replyTo===id)).payload.status,'REJECTED');assert.equal(a.workspace.getDocument('source.js').content,'ORIGINAL\n');
});
test('HTTP disconnected pending HELLO releases its actual claim without revoking a replacement or stranding another client',async t=>{
  const f=fixture(t), a=f.app({rootPath:f.project}),port=await a.listen(),r=(await f.http(port,'GET','/api/project')).body;
  const p=peer(t,port);await p.open();p.send(r.sessionId,'tab','HELLO',{token:f.token,lastServerSeq:0});await p.wait(x=>x.type==='SESSION_SNAPSHOT');
  let release!:()=>void,entered!:()=>void;const held=new Promise<void>(resolve=>{entered=resolve;}),finish=new Promise<void>(resolve=>{release=resolve;});
  const lease=a.gate._withLanguageSourceLease({clientId:'tab',sessionId:r.sessionId,controlEpoch:a.session.state.controlEpoch,actor:'STUDENT',expectedWorkspaceVersion:0},()=>{},async()=>{entered();await finish;}).catch(e=>e);await held;
  const oldClosed=once(p.ws,'close'),q=peer(t,port);await q.open();q.send(r.sessionId,'tab','HELLO',{token:f.token,lastServerSeq:0});await oldClosed;
  const pendingClosed=once(q.ws,'close');q.ws.close();await pendingClosed;
  release();await lease;
  const next=peer(t,port);await next.open();next.send(r.sessionId,'different-tab','HELLO',{token:f.token,lastServerSeq:0});await next.wait(x=>x.type==='SESSION_SNAPSHOT');
  assert.equal(a.session.leaseClientId,'different-tab');
});

test('HTTP actual socket listen rejection closes recovered core/watchers and permits fresh same-root owner',async t=>{
  const f=fixture(t), blocker=http.createServer();await new Promise<void>(resolve=>blocker.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise<void>((resolve,reject)=>blocker.close(e=>e?reject(e):resolve())));
  const address=blocker.address();assert.ok(address && typeof address==='object');
  const a=f.app({rootPath:f.project,port:address.port});await assert.rejects(a.listen(),{code:'EADDRINUSE'});
  assert.equal(a.server.listening,false);assert.throws(()=>a.workspace,{code:'SESSION_CLOSED'});
  const b=f.app({rootPath:f.project});await b.listen();assert.equal(b.workspace.rootPath,f.project);
});

for(const boundary of ['REPLACED','COMMITTED']) test('HTTP listen exposes ONLY recovered canonical settings after actual child death '+boundary,async t=>{
  const f=fixture(t),directory=path.join(f.project,'.paircoach');fs.mkdirSync(directory);const original=JSON.stringify(settings);fs.writeFileSync(path.join(directory,'settings.json'),original);
  const child=spawn(process.execPath,['--import','tsx',fileURLToPath(new URL('./workspace-startup-child.ts',import.meta.url)),f.project,'settings',boundary],{env:{...process.env,TSX_DISABLE_CACHE:'1'},stdio:['ignore','pipe','pipe']});
  let output='',error='';child.stdout.on('data',b=>output+=b);child.stderr.on('data',b=>error+=b);
  const killed=await new Promise<{code:number|null;signal:string|null}>((resolve,reject)=>{
    const deadline=setTimeout(()=>{child.kill('SIGKILL');reject(Error('Real crash boundary not reached: '+error));},15000);
    child.once('error',e=>{clearTimeout(deadline);reject(e);});child.once('exit',(code,signal)=>{clearTimeout(deadline);resolve({code,signal});});
  });assert.equal(killed.signal,'SIGKILL',error+output);
  const a=f.app({rootPath:f.project}),port=await a.listen(),project=await f.http(port,'GET','/api/project');
  assert.equal(project.status,200);assert.equal(project.body.settings.aiConsent,boundary==='COMMITTED');assert.equal(project.body.workspaceVersion,boundary==='COMMITTED'?1:0);
  assert.equal(fs.existsSync(path.join(directory,'settings.json.v2-state','pending.json')),false);
  if(boundary==='REPLACED')assert.equal(fs.readFileSync(path.join(directory,'settings.json'),'utf8'),original);
  const stable=project.body.workspaceVersion;await a.close();const reopened=f.app({rootPath:f.project}),newPort=await reopened.listen();
  const again=await f.http(newPort,'GET','/api/project');assert.equal(again.body.workspaceVersion,stable);assert.deepEqual(again.body.settings,project.body.settings);
});
test('HTTP real reports remain independent of unavailable Run and canonical old-session identity survives restart',async t=>{
  const f=fixture(t),a=f.app({rootPath:f.project,enableExecution:true}),port=await a.listen(),project=(await f.http(port,'GET','/api/project')).body;
  const p=peer(t,port);await p.open();p.send(project.sessionId,'tab','HELLO',{token:f.token,lastServerSeq:0});await p.wait(x=>x.type==='SESSION_SNAPSHOT');
  const auth={requestId:randomUUID(),sessionId:project.sessionId,clientId:'tab'};
  const start=await f.http(port,'POST','/api/session/start',{...auth,limitMs:null,pauseOnHidden:true});assert.equal(start.status,200);
  const finish=await f.http(port,'POST','/api/session/finish',{...auth,requestId:randomUUID(),expectedWorkspaceVersion:0,reason:'COMPLETED'});
  assert.equal(finish.status,202);assert.equal(finish.body.sessionId,project.sessionId);
  const reportId=finish.body.reportId,reportRoot=path.join(f.project,'.paircoach','reports'),sessionDirectory=fs.readdirSync(reportRoot)[0],facts=fs.readFileSync(path.join(reportRoot,sessionDirectory,'facts.json'));
  await a.close();const b=f.app({rootPath:f.project,enableExecution:true}),newPort=await b.listen(),next=(await f.http(newPort,'GET','/api/session')).body;
  assert.notEqual(next.sessionId,project.sessionId);
  const old=await f.http(newPort,'GET','/api/session/report?sessionId='+encodeURIComponent(project.sessionId));assert.equal(old.status,200);assert.equal(old.body.reportId,reportId);assert.equal(old.body.sessionId,project.sessionId);
  assert.deepEqual(fs.readFileSync(path.join(reportRoot,sessionDirectory,'facts.json')),facts);
  assert.equal((await f.http(newPort,'GET','/api/session')).body.sessionId,next.sessionId);
});
