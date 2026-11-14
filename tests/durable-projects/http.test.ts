/** Real HTTP/WS/WriteGate/files; injected AI and no Docker, NOT real-native/LIVE proof. */
import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {once} from 'node:events';
import {randomUUID} from 'node:crypto';
import WebSocket from 'ws';
import {createPairCoachServer} from '../../src/server/http';
import type {CoachProvider} from '../../src/server/CoachAdapter';
import {validateV2WireShape} from '../../src/shared/validation-v2';
const settings={schemaVersion:2,taskFilePath:'challenge.md',taskMode:'IMPLEMENTATION',reviewNotesPath:'review.md',aiConsent:true,contextPatterns:['**/*.js','**/*.md'],runProfiles:[]};
const delay=(ms:number)=>new Promise(r=>setTimeout(r,ms));
async function fixture(t:TestContext,provider?:CoachProvider) {
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'durable-http-')),P=path.join(root,'P'),Q=path.join(root,'Q'),A=path.join(root,'A'),B=path.join(root,'B');
 for(const d of [P,Q,A,B])fs.mkdirSync(d,{mode:0o700});
 for(const [d,value] of [[A,'A'],[B,'B']]){fs.mkdirSync(path.join(d,'.paircoach'),{mode:0o700});fs.writeFileSync(path.join(d,'.paircoach','settings.json'),JSON.stringify(settings));fs.writeFileSync(path.join(d,'main.js'),`const identity = '${value}';\n`);fs.writeFileSync(path.join(d,'other.js'),`const other = '${value}';\n`);fs.writeFileSync(path.join(d,'challenge.md'),'# Exercise '+value);}
 let app:ReturnType<typeof createPairCoachServer>,port=0,ws:WebSocket|undefined,metadata:any,sessionId:string|null=null;const clientId='durable-tab',token='durable-local-token';let frames:any[]=[];
 const start=async()=>{app=createPairCoachServer({port:0,token,enableCoach:!!provider,coachProvider:provider,runtimeEnvironment:{PAIRCOACH_WORKSPACE_DIR:A}});port=await app.listen();metadata=(await request('GET','/api/durable-project')).body;sessionId=null;};
 const request=async(method:string,url:string,body?:unknown,auth=true)=>{const r=await fetch(`http://127.0.0.1:${port}${url}`,{method,headers:{'Content-Type':'application/json',...(auth?{Authorization:'Bearer '+token}:{})},...(body?{body:JSON.stringify(body)}:{})});return {status:r.status,body:await r.json() as any};};
 const command=async(action:string,extra:object={},expected=200)=>{const r=await request('POST','/api/durable-project/'+action,{requestId:randomUUID(),clientId,projectId:metadata.durableProject?.id??null,sessionId,...extra});assert.equal(r.status,expected,JSON.stringify(r.body));if(expected===200){metadata=r.body;if(!metadata.durableProject?.exercisePath)sessionId=null;}return r.body;};
 const wait=async(predicate:(m:any)=>boolean)=>{const until=Date.now()+4000;while(!frames.some(predicate)){assert.ok(Date.now()<until,'missing expected WS frame');await delay(5);}return frames.find(predicate);};
 const send=(type:string,payload:unknown)=>{const messageId=randomUUID();ws!.send(JSON.stringify({protocolVersion:'3.0',messageId,sessionId,clientId,type,payload}));return messageId;};
 const connect=async()=>{ws?.terminate();frames=[];const s=await request('GET','/api/session');assert.equal(s.status,200,JSON.stringify(s.body));sessionId=s.body.sessionId;ws=new WebSocket(`ws://127.0.0.1:${port}/ws/session`);ws.on('message',raw=>frames.push(JSON.parse(String(raw))));await once(ws,'open');send('HELLO',{token,lastServerSeq:0});return wait(m=>m.type==='SESSION_SNAPSHOT');};
 const exercise=async(rootPath:string)=>{const r=await request('POST','/api/project/open',{requestId:randomUUID(),clientId,rootPath,settings});assert.equal(r.status,201,JSON.stringify(r.body));metadata=(await request('GET','/api/durable-project')).body;return connect();};
 const chat=async(text:string)=>{const id=send('CHAT_MESSAGE',{text,path:null,documentVersion:null,selection:null});const ack=await wait(m=>m.type==='ACK'&&m.payload.replyTo===id);assert.equal(ack.payload.status,'OK',JSON.stringify(ack));return id;};
 await start();
 t.after(async()=>{ws?.terminate();await app.close();fs.rmSync(root,{recursive:true,force:true});});
 return {root,P,Q,A,B,request,command,connect,exercise,send,wait,chat,start,get app(){return app;},get state(){return metadata;},get frames(){return frames;},async restart(){ws?.terminate();await app.close();await start();}};
}

test('cold authenticated shell ignores configured/env exercise; create→A ACK→B tabs→close→reopen→backend restart, then Q isolation',async t=>{
 const f=await fixture(t);
 assert.equal((await f.request('GET','/api/project')).body.code,'PROJECT_OPEN_REQUIRED');assert.equal(f.state.durableProject,null);
 assert.equal((await f.request('GET','/api/folders?path='+encodeURIComponent(f.root),undefined,false)).status,401);
 await f.command('create',{directory:f.P,name:'Training',locale:'en'});const file=f.state.durableProject.projectFile,id=f.state.durableProject.id;
 assert.equal(f.state.durableProject.exercisePath,null);assert.equal((await f.request('GET','/api/project')).status,409);
 let snapshot=await f.exercise(f.A);assert.ok(validateV2WireShape('ServerMessage',snapshot));
 await f.chat('/rule Use vanilla Java without streams.');
 const doc=(await f.request('GET','/api/file?path=main.js')).body;
 const write=f.send('CODE_CHANGED',{path:'main.js',baseVersion:doc.version,content:'const preserved = "A-edited";\n',editKind:'TYPING',controlEpoch:snapshot.payload.session.controlEpoch});
 assert.equal((await f.wait(m=>m.type==='ACK'&&m.payload.replyTo===write)).payload.status,'OK');
 snapshot=await f.exercise(f.B);
 assert.match((await f.request('GET','/api/file?path=main.js')).body.content,/'B'/);
 const editorViews={'main.js':{position:{lineNumber:1,column:2},selection:{startLineNumber:1,startColumn:1,endLineNumber:1,endColumn:2},scrollTop:12,scrollLeft:0}};
 await f.command('workspace',{workspace:{openTabs:['main.js','other.js'],activePath:'main.js',sidebarTab:'chat',bottomTab:'console',editorViews}});
 await f.command('open',{projectFile:path.join(f.root,'missing.paircoding.json')},400);
 assert.equal(f.state.durableProject.id,id,'failed open leaves current project unchanged');
 await f.command('close');assert.equal(f.state.durableProject,null);assert.equal((await f.request('GET','/api/project')).status,409);
 await f.command('open',{projectFile:file});snapshot=await f.connect();
 assert.equal(f.state.durableProject.id,id);assert.equal(f.state.durableProject.exercisePath,f.B);assert.deepEqual(f.state.durableProject.workspace.openTabs,['main.js','other.js']);assert.deepEqual(f.state.durableProject.workspace.editorViews,editorViews);
 assert.match(snapshot.payload.chat[0].text,/vanilla Java/);const timestamp=snapshot.payload.chat[0].createdAt;
 await f.restart();assert.equal(f.state.durableProject,null,'backend cold start never auto-opens a project');
 await f.command('open',{projectFile:file});snapshot=await f.connect();assert.equal(snapshot.payload.chat[0].createdAt,timestamp);assert.equal(f.state.locale,'en');
 assert.equal(fs.readFileSync(path.join(f.A,'main.js'),'utf8'),'const preserved = "A-edited";\n');
 await f.command('close');await f.command('create',{directory:f.Q,name:'Other'});await f.exercise(f.A);
 assert.deepEqual(f.frames.find(m=>m.type==='SESSION_SNAPSHOT').payload.chat,[],'same exercise does not import P history into Q');
 await f.command('close');await f.command('open',{projectFile:file});snapshot=await f.connect();assert.match(snapshot.payload.chat[0].text,/vanilla Java/);
 assert.equal(snapshot.payload.project.rootPath,f.B);
});

test('locale change aborts/invalidate ignored-abort AI; only new-language reply appears, then restored rules/history reach next exercise',async t=>{
 let resolveFirst!:(value:unknown)=>void;const calls:any[]=[];
 const provider:CoachProvider={name:'controlled',mode:'INJECTED',decide(context,signal){calls.push({context,signal});if(calls.length===1)return new Promise(resolve=>{resolveFirst=resolve;});return Promise.resolve({kind:'REPLY',text:context.locale==='en'?'English reply':'Polska odpowiedź'});}};
 const f=await fixture(t,provider);await f.command('create',{directory:f.P,name:'Learning',locale:'pl'});await f.exercise(f.A);
 await f.chat('/rule Use Java 21.');const until=Date.now()+3000;while(calls.length<1){assert.ok(Date.now()<until);await delay(5);}
 await f.command('locale',{locale:'en'});assert.equal(calls[0].signal.aborted,true);
 resolveFirst({kind:'REPLY',text:'STALE POLISH REPLY'});await delay(30);assert.equal(f.frames.some(m=>m.type==='CHAT_REPLY'&&m.payload.text==='STALE POLISH REPLY'),false);
 await f.chat('Please explain the next step.');await f.wait(m=>m.type==='CHAT_REPLY'&&m.payload.text==='English reply');
 const output=f.frames.find(m=>m.type==='CHAT_REPLY'&&m.payload.text==='English reply');assert.equal(output.payload.locale,'en');assert.ok(validateV2WireShape('ServerMessage',output));
 assert.equal(calls.at(-1).context.locale,'en');assert.ok(calls.at(-1).context.durableProject.rules.includes('Use Java 21.'));
 await f.exercise(f.B);await f.chat('What project rule remains?');await f.wait(m=>m.type==='CHAT_REPLY'&&m.payload.text==='English reply');
 assert.equal(calls.at(-1).context.durableProject.transitions.length,2);assert.ok(calls.at(-1).context.messages.some((m:any)=>m.text.includes('Use Java 21')));
});
