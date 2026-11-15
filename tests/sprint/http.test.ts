/** TEST201 real HTTP/WS/WriteGate/store. Controlled Run publication is NOT Java/Docker proof. */
import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {once} from 'node:events';
import WebSocket from 'ws';
import {createPairCoachServer,type ServiceContext} from '../../src/server/http';
import {ReportService} from '../../src/server/ReportService';
import {DEFAULT_PACK_PATH} from '../../src/server/sprint/LearningPack';
import type {SprintCommand,SprintView} from '../../src/shared/sprint';
import {validateV2WireShape} from '../../src/shared/validation-v2';
import {currentAttempt} from '../../src/shared/sprint';
async function fixture(t:TestContext,defaultReports=false) {
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'sprint-http-')),P=path.join(root,'P'),pack=path.join(root,'pack');fs.mkdirSync(P);
 fs.cpSync(DEFAULT_PACK_PATH,pack,{recursive:true});const c=JSON.parse(fs.readFileSync(path.join(pack,'curriculum.json'),'utf8'));
 c.tasks.forEach((task:any)=>task.ready=true);fs.writeFileSync(path.join(pack,'curriculum.json'),JSON.stringify(c)); // synthetic eligibility only
 const reportCalls:any[]=[];
 let app:ReturnType<typeof createPairCoachServer>,port=0,ws:WebSocket|undefined,ctx:ServiceContext,metadata:any,view:SprintView,frames:any[]=[];
 const token='sprint-local-test',clientId='sprint-tab';
 const req=async(method:string,route:string,body?:unknown)=>{const r=await fetch('http://127.0.0.1:'+port+route,{method,headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});return {status:r.status,body:await r.json() as any};};
 const start=async()=>{
  app=createPairCoachServer({port:0,token,learningPackPath:pack,enableExecution:defaultReports,reportGenerate:async facts=>{reportCalls.push(facts);return "# Controlled summary";},executionFactory:defaultReports?undefined:context=>{
    ctx=context;return {runner:{setApprovedProfiles(){},start(){throw Error('No fake execution');},get(){throw Error('No fake execution');},stop(){throw Error('No fake execution');},async stopAll(){},list(){return[];}},
     reports:new ReportService({dataDir:context.workspace.dataDir,projectId:context.workspace.projectId,emit:context.emit})};
  }});port=await app.listen();
 };
 const refresh=async()=>{metadata=(await req('GET','/api/durable-project')).body;view=(await req('GET','/api/durable-project/sprint')).body;};
 const body=(action:SprintCommand['action'],extra:object={}):SprintCommand=>({requestId:randomUUID(),clientId,projectId:metadata.durableProject.id,sessionId:metadata.durableProject.exercisePath?app.session.state.sessionId:null,
  expectedSprintId:view.sprint?.sprintId??null,expectedAttemptId:view.sprint?.activeAttemptId??null,action,...extra});
 const command=async(action:SprintCommand['action'],extra:object={},status=200)=>{const b=body(action,extra),r=await req('POST','/api/durable-project/sprint',b);assert.equal(r.status,status,JSON.stringify(r.body));await refresh();return {b,r};};
 const connect=async()=>{
  ws?.terminate();frames=[];const sessionId=app.session.state.sessionId;ws=new WebSocket('ws://127.0.0.1:'+port+'/ws/session');
  ws.on('message',data=>frames.push(JSON.parse(String(data))));await once(ws,'open');ws.send(JSON.stringify({protocolVersion:'3.0',messageId:randomUUID(),sessionId,clientId,type:'HELLO',payload:{token,lastServerSeq:0}}));
  await wait(m=>m.type==='SESSION_SNAPSHOT');return sessionId;
 };
 const wait=async(check:(v:any)=>boolean)=>{const end=Date.now()+5000;while(!frames.some(check)){assert.ok(Date.now()<end,'Missing frame');await new Promise(r=>setTimeout(r,5));}return frames.find(check);};
 await start();await refresh();
 const created=await req('POST','/api/durable-project/create',{requestId:randomUUID(),clientId,projectId:null,sessionId:null,directory:P,name:'Sprint'});assert.equal(created.status,200,JSON.stringify(created.body));await refresh();
 t.after(async()=>{ws?.terminate();await app.close();fs.rmSync(root,{recursive:true,force:true});});
 return {root,P,pack,reportCalls,req,refresh,command,connect,wait,body,get app(){return app;},get ctx(){return ctx;},get view(){return view;},get metadata(){return metadata;},get frames(){return frames;},
 async edit(content:string){
  const p='src/main/java/demo/ApiApplication.java',doc=(await req('GET','/api/file?path='+p)).body,messageId=randomUUID();
  ws!.send(JSON.stringify({protocolVersion:'3.0',messageId,sessionId:app.session.state.sessionId,clientId,type:'CODE_CHANGED',
    payload:{path:p,baseVersion:doc.version,content,editKind:'TYPING',controlEpoch:app.session.state.controlEpoch}}));
  assert.equal((await wait(m=>m.type==='ACK'&&m.payload.replyTo===messageId)).payload.status,'OK');
 },
 async restart(){ws?.terminate();await app.close();await start();metadata=(await req('GET','/api/durable-project')).body;},
 async reopen(file:string){const r=await req('POST','/api/durable-project/open',{requestId:randomUUID(),clientId,projectId:null,sessionId:null,projectFile:file});assert.equal(r.status,200,JSON.stringify(r.body));await refresh();await connect();}
 };
}
test('TEST201 GET→POST→update(3), ACK bytes, no double next, stale action, durable restart, timer and no consent inheritance',async t=>{
 const f=await fixture(t);await f.command('start',{topics:['http'],level:1,budgetMinutes:60});await f.connect();
 assert.equal(currentAttempt(f.view.sprint!).taskId,'get-item');assert.equal(f.app.workspace.settings.aiConsent,false);
 await f.edit('package demo; // preserved student solution\n');const old=f.body('harder'),before=f.app.session.getSession().timer.elapsedMs;
 const moved=await f.req('POST','/api/durable-project/sprint',old);assert.equal(moved.status,200,JSON.stringify(moved.body));await f.refresh();await f.connect();
 assert.equal(currentAttempt(f.view.sprint!).taskId,'create-item');assert.equal(f.view.sprint!.attempts[0].outcome,'DECLARED_SKIP');
 const count=f.view.sprint!.attempts.length;
 const retry=await f.req('POST','/api/durable-project/sprint',old);assert.equal(retry.status,200);await f.refresh();assert.equal(f.view.sprint!.attempts.length,count);
 assert.equal((await f.req('POST','/api/durable-project/sprint',{...old,requestId:randomUUID(),sessionId:f.app.session.state.sessionId})).body.code,'SPRINT_STATE_CHANGED');
 await f.command('harder');await f.connect();assert.equal(currentAttempt(f.view.sprint!).taskId,'update-item');
 await f.command('easier');await f.connect();assert.equal(currentAttempt(f.view.sprint!).taskId,'create-item');
 await f.command('easier');await f.connect();assert.equal(currentAttempt(f.view.sprint!).taskId,'get-item');
 assert.equal(fs.readFileSync(path.join(f.app.workspace.rootPath,'src/main/java/demo/ApiApplication.java'),'utf8'),'package demo; // preserved student solution\n');
 assert.ok(f.app.session.getSession().timer.elapsedMs>=before);assert.equal(f.app.workspace.settings.aiConsent,false);
 const file=f.metadata.durableProject.projectFile,attempt=f.view.sprint!.activeAttemptId,history=f.view.sprint!.attempts.length;
 await f.restart();await f.reopen(file);assert.equal(f.view.sprint!.activeAttemptId,attempt);assert.equal(f.view.sprint!.attempts.length,history);assert.equal(f.view.sprint!.status,'ACTIVE');
});
test('TEST201 backend Run identities/dedup, stale version not passing, failure opening preserves attempt/source',async t=>{
 const f=await fixture(t);await f.command('start',{topics:['http'],level:1,budgetMinutes:60});await f.connect();
 const v=f.app.workspace.workspaceVersion,r={runId:randomUUID(),mode:'RUN_TESTS',status:'SUCCEEDED',exitCode:0,workspaceVersionAtStart:v,workspaceChangedDuringRun:false,testOutcome:'PASSED',testCount:1,outputTail:'',outputTruncated:false,startedAt:new Date().toISOString(),finishedAt:new Date().toISOString()};
 f.ctx.emit('RUN_STATE',r);f.ctx.emit('RUN_STATE',r);await f.refresh();assert.equal(currentAttempt(f.view.sprint!).runs.length,1);
 await f.command('selfAssess',{selfAssessment:5});await f.edit('package demo; // newer untested code\n');
 await f.command('selfAssess',{selfAssessment:5},409);assert.notEqual(f.view.sprint!.recommendation.reason,'HARDER');
 const s=f.view.sprint!,oldCtx=f.ctx,source=path.join(f.pack,'tasks/create-item/src/main/java/demo/ApiApplication.java');
 fs.unlinkSync(source);fs.symlinkSync(path.join(f.pack,'references/create-item/ApiApplication.java'),source);
 await f.command('harder',{},409);assert.equal(f.view.sprint!.activeAttemptId,s.activeAttemptId);assert.match(fs.readFileSync(path.join(f.app.workspace.rootPath,'src/main/java/demo/ApiApplication.java'),'utf8'),/newer untested/);
 fs.unlinkSync(source);fs.copyFileSync(path.join(f.pack,'references/create-item/ApiApplication.java'),source);
 await f.command('harder');await f.connect();oldCtx.emit('RUN_STATE',{...r,runId:randomUUID()});await f.refresh();assert.equal(currentAttempt(f.view.sprint!).runs.length,0);
 // WS sequence includes persisted state updates without preceding frames out of order.
 for(const m of f.frames)assert.ok(validateV2WireShape('ServerMessage',m),'Invalid wire '+m.type);
 const seq=f.frames.map(m=>m.seq);assert.deepEqual(seq,[...seq].sort((a,b)=>a-b));
});
test('TEST201 forged results/task IDs are rejected, old projects and unavailable material remain usable',async t=>{
 const f=await fixture(t);
 assert.equal((await f.req('POST','/api/durable-project/sprint',f.body('start',{topics:['http'],level:1,budgetMinutes:60,testOutcome:'PASSED'}))).status,400);
 assert.equal((await f.req('POST','/api/durable-project/sprint',f.body('next',{taskId:'foreign'}))).status,400);
 await f.command('start',{topics:['missing'],level:1,budgetMinutes:60},400);assert.equal(f.view.sprint,null);
 const curriculum=JSON.parse(fs.readFileSync(path.join(f.pack,'curriculum.json'),'utf8'));curriculum.tasks.forEach((task:any)=>task.ready=false);fs.writeFileSync(path.join(f.pack,'curriculum.json'),JSON.stringify(curriculum));
 // No fabricated exercise is opened.
 await f.command('start',{topics:['http'],level:1,budgetMinutes:60},409);assert.equal(f.metadata.durableProject.exercisePath,null);assert.equal(f.view.sprint,null);
});

test('TEST201 finish freezes history of earlier exercises; local report works without AI',async t=>{
 const f=await fixture(t,true);await f.command('start',{topics:['http'],level:1,budgetMinutes:60});await f.connect();
 await f.command('harder');await f.connect();
 const final=await f.req('POST','/api/session/finish',{requestId:randomUUID(),clientId:'sprint-tab',sessionId:f.app.session.state.sessionId,expectedWorkspaceVersion:f.app.workspace.workspaceVersion,reason:'COMPLETED'});
 assert.equal(final.status,202,JSON.stringify(final.body));
 let report:any;const until=Date.now()+4000;
 do {report=(await f.req('GET','/api/session/report?sessionId='+f.app.session.state.sessionId)).body;if(report.status!=='PENDING')break;await new Promise(r=>setTimeout(r,5));}while(Date.now()<until);
 assert.equal(report.status,'READY',JSON.stringify(report));assert.match(report.markdown,/Odczytaj zasób przez GET/);assert.match(report.markdown,/Utwórz zasób przez POST/);
 assert.match(report.markdown,/pominięcie zadeklarowane/);assert.equal(f.reportCalls.length,0);
 const facts=JSON.parse(fs.readFileSync(path.join(f.P,'.pairCoding/codex/reports',fs.readdirSync(path.join(f.P,'.pairCoding/codex/reports'))[0],'facts.json'),'utf8'));
 const frozen=JSON.parse(facts.serialized);assert.equal(frozen.sprint.sprint.attempts.length,2);
});

test('TEST201 report provider projection receives frozen previous attempts and material, not a live workspace history',async t=>{
 const f=await fixture(t,true);await f.command('start',{topics:['http'],level:1,budgetMinutes:60});await f.connect();
 await f.command('harder');await f.connect();
 const settings=JSON.parse(fs.readFileSync(path.join(f.app.workspace.rootPath,'.paircoach/settings.json'),'utf8'));settings.aiConsent=true;
 const saved=await f.req('PUT','/api/project/settings',{requestId:randomUUID(),clientId:'sprint-tab',sessionId:f.app.session.state.sessionId,expectedWorkspaceVersion:f.app.workspace.workspaceVersion,settings});
 assert.equal(saved.status,200,JSON.stringify(saved.body));
 const final=await f.req('POST','/api/session/finish',{requestId:randomUUID(),clientId:'sprint-tab',sessionId:f.app.session.state.sessionId,expectedWorkspaceVersion:f.app.workspace.workspaceVersion,reason:'COMPLETED'});
 assert.equal(final.status,202,JSON.stringify(final.body));
 const end=Date.now()+4000;while(!f.reportCalls.length){assert.ok(Date.now()<end);await new Promise(r=>setTimeout(r,5));}
 assert.equal(f.reportCalls[0].sprint.sprint.attempts.length,2);assert.equal(f.reportCalls[0].sprint.tasks.length,2);
 assert.equal(f.reportCalls[0].sprint.sources[0].id,'http-contract');
 assert.doesNotMatch(JSON.stringify(f.reportCalls[0].sprint),/references|ApiApplication.java|sourceCode/);
});

test('TEST201 explicit new on same folder keeps code, archives history, changes session and resets existing clock; extend and resume',async t=>{
 const f=await fixture(t);await f.command('start',{topics:['http'],level:1,budgetMinutes:10});await f.connect();await f.edit('package demo; // never reset starter\n');
 const oldSprint=f.view.sprint!.sprintId,oldSession=f.app.session.state.sessionId,oldAttempt=f.view.sprint!.activeAttemptId,oldPath=f.app.workspace.rootPath;
 await f.command('start',{topics:['http'],level:1,budgetMinutes:10});
 assert.equal(f.view.sprint!.sprintId,oldSprint);assert.equal(f.view.sprint!.activeAttemptId,oldAttempt);
 await f.command('new',{topics:['http'],level:1,budgetMinutes:60});await f.connect();
 assert.notEqual(f.view.sprint!.sprintId,oldSprint);assert.notEqual(f.app.session.state.sessionId,oldSession);
 assert.equal(f.app.workspace.rootPath,oldPath);assert.equal(f.view.sprint!.previous![0].sprintId,oldSprint);
 assert.equal(f.view.sprint!.attempts.length,1);
 const late={runId:randomUUID(),mode:'RUN_TESTS',status:'SUCCEEDED',exitCode:0,workspaceVersionAtStart:f.app.workspace.workspaceVersion,workspaceChangedDuringRun:false,testOutcome:'PASSED',testCount:1,outputTail:'',outputTruncated:false,startedAt:'2000-01-01T00:00:00.000Z',finishedAt:new Date().toISOString()};
 f.ctx.emit('RUN_STATE',late);await f.refresh();assert.equal(currentAttempt(f.view.sprint!).runs.length,0,'retired same-root Run is not new-attempt evidence');
 assert.match(fs.readFileSync(path.join(oldPath,'src/main/java/demo/ApiApplication.java'),'utf8'),/never reset starter/);
 await f.command('extend',{budgetMinutes:75});assert.equal(f.app.session.getSession().timer.limitMs,75*60000);
 const foreign=path.join(f.root,'foreign');fs.mkdirSync(foreign);fs.writeFileSync(path.join(foreign,'note.txt'),'unrelated');
 const settings={schemaVersion:2,taskFilePath:null,taskMode:'IMPLEMENTATION',reviewNotesPath:'review.md',aiConsent:false,contextPatterns:[],runProfiles:[]};
 fs.mkdirSync(path.join(foreign,'.paircoach'));fs.writeFileSync(path.join(foreign,'.paircoach/settings.json'),JSON.stringify(settings));
 const opened=await f.req('POST','/api/project/open',{requestId:randomUUID(),clientId:'sprint-tab',rootPath:foreign,settings});assert.equal(opened.status,201,JSON.stringify(opened.body));
 await f.refresh();await f.connect();assert.equal(f.view.sprint!.status,'SUSPENDED');assert.equal(currentAttempt(f.view.sprint!).outcome,'INTERRUPTED');
 await f.command('resume');await f.connect();assert.equal(f.view.sprint!.status,'ACTIVE');assert.equal(f.app.workspace.rootPath,oldPath);
});

test('TEST201 no easier feedback survives response, GET, retry and reopen; fresh Run/action and stale PASS still refresh',async t=>{
 const f=await fixture(t);await f.command('start',{topics:['http'],level:1,budgetMinutes:60});await f.connect();
 const attempt=f.view.sprint!.activeAttemptId,count=f.view.sprint!.attempts.length;
 const session=f.app.session.state.sessionId,source=fs.readFileSync(path.join(f.app.workspace.rootPath,'src/main/java/demo/ApiApplication.java'));
 const feedback:NonNullable<SprintView['sprint']>['recommendation']={taskId:null,reason:'NO_EASIER_HINT_AVAILABLE'};
 const {b,r}=await f.command('easier');
 assert.deepEqual(r.body.sprint.recommendation,feedback,'POST must retain the explicit no-easier result');
 assert.deepEqual(f.view.sprint!.recommendation,feedback,'GET must retain the same feedback');
 assert.equal(f.view.sprint!.activeAttemptId,attempt);assert.equal(f.view.sprint!.attempts.length,count);
 assert.equal(f.app.session.state.sessionId,session);assert.deepEqual(fs.readFileSync(path.join(f.app.workspace.rootPath,'src/main/java/demo/ApiApplication.java')),source);
 const repeated=await f.req('POST','/api/durable-project/sprint',b);assert.equal(repeated.status,200);
 assert.deepEqual(repeated.body.sprint.recommendation,feedback,'idempotent retry must not replace feedback');
 const file=f.metadata.durableProject.projectFile;
 await f.restart();await f.reopen(file);
 assert.deepEqual(f.view.sprint!.recommendation,feedback,'durable reopen must retain feedback');
 assert.equal(f.view.sprint!.activeAttemptId,attempt);assert.equal(f.view.sprint!.attempts.length,count);
 const pass={runId:randomUUID(),mode:'RUN_TESTS',status:'SUCCEEDED',exitCode:0,workspaceVersionAtStart:f.app.workspace.workspaceVersion,
  workspaceChangedDuringRun:false,testOutcome:'PASSED',testCount:1,outputTail:'',outputTruncated:false,startedAt:new Date().toISOString(),finishedAt:new Date().toISOString()};
 // Trusted backend Run publication only; this HTTP regression does not execute Java/Docker.
 f.ctx.emit('RUN_STATE',pass);await f.refresh();
 assert.deepEqual(f.view.sprint!.recommendation,{taskId:'create-item',reason:'PASSED_NEXT'},'fresh Run supersedes no-candidate feedback');
 assert.equal(f.view.sprint!.activeAttemptId,attempt);assert.equal(f.view.sprint!.attempts.length,count,'Run must not auto-switch tasks');
 await f.command('selfAssess',{selfAssessment:5});assert.equal(f.view.sprint!.recommendation.reason,'HARDER');
 await f.edit('package demo; // new untested version after the PASS\n');await f.refresh();
 assert.deepEqual(f.view.sprint!.recommendation,{taskId:'create-item',reason:'AVAILABLE_IN_SELECTED_TOPICS'},'editing invalidates stale PASS recommendation');
 await f.command('selfAssess',{selfAssessment:5},409);
 const again=await f.command('easier');assert.deepEqual(again.r.body.sprint.recommendation,feedback);
 f.ctx.emit('RUN_STATE',pass);await f.refresh();
 assert.deepEqual(f.view.sprint!.recommendation,feedback,'duplicate old Run is not a new result/action');
 await f.command('example');assert.notDeepEqual(f.view.sprint!.recommendation,feedback,'a new action refreshes the recommendation');
 assert.equal(currentAttempt(f.view.sprint!).help,true);
 await f.command('next');await f.connect();assert.equal(currentAttempt(f.view.sprint!).taskId,'create-item');
 assert.equal(f.view.sprint!.attempts[0].outcome,'INTERRUPTED','stale PASS cannot mark old code TESTED/ASSISTED');
});

test('TEST201 exhausted deeper feedback survives response, GET and reopen; fresh Run and normal next still work',async t=>{
 const f=await fixture(t);await f.command('start',{topics:['http','dto'],level:1,budgetMinutes:120});await f.connect();
 for(const id of ['create-item','update-item']){
  await f.command('deeper');await f.connect();assert.equal(currentAttempt(f.view.sprint!).taskId,id);
 }
 const attempt=f.view.sprint!.activeAttemptId,count=f.view.sprint!.attempts.length;
 const session=f.app.session.state.sessionId,source=fs.readFileSync(path.join(f.app.workspace.rootPath,'src/main/java/demo/ApiApplication.java'));
 const feedback:NonNullable<SprintView['sprint']>['recommendation']={taskId:null,reason:'NO_AVAILABLE_TASK'};
 const {r}=await f.command('deeper');assert.deepEqual(r.body.sprint.recommendation,feedback,'deeper must not advertise a task from a different topic');
 assert.deepEqual(f.view.sprint!.recommendation,feedback);assert.equal(f.view.sprint!.activeAttemptId,attempt);assert.equal(f.view.sprint!.attempts.length,count);
 assert.equal(f.app.session.state.sessionId,session);assert.deepEqual(fs.readFileSync(path.join(f.app.workspace.rootPath,'src/main/java/demo/ApiApplication.java')),source);
 const file=f.metadata.durableProject.projectFile;await f.restart();await f.reopen(file);
 assert.deepEqual(f.view.sprint!.recommendation,feedback);assert.equal(f.view.sprint!.activeAttemptId,attempt);
 f.ctx.emit('RUN_STATE',{runId:randomUUID(),mode:'RUN_TESTS',status:'FAILED',exitCode:1,workspaceVersionAtStart:f.app.workspace.workspaceVersion,
  workspaceChangedDuringRun:false,testOutcome:'FAILED',testCount:1,outputTail:'',outputTruncated:false,startedAt:new Date().toISOString(),finishedAt:new Date().toISOString()});
 await f.refresh();assert.deepEqual(f.view.sprint!.recommendation,{taskId:'validate-input',reason:'AVAILABLE_IN_SELECTED_TOPICS'},'new Run refreshes selection across selected topics');
 assert.equal(f.view.sprint!.activeAttemptId,attempt);assert.equal(f.view.sprint!.attempts.length,count,'Run must not auto-switch tasks');
 const exhausted=await f.command('deeper');assert.deepEqual(exhausted.r.body.sprint.recommendation,feedback);
 await f.command('next');await f.connect();assert.equal(currentAttempt(f.view.sprint!).taskId,'validate-input','normal next still opens an available task');
 assert.equal(f.view.sprint!.attempts.length,count+1);assert.equal(f.view.sprint!.attempts[count-1].outcome,'REVIEW');
});
