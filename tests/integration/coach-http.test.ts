/** K integration tests: real listener/WS/adapter/WriteGate/disk; provider only is injected. */
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createPairCoachServer } from '../../src/server/http';
import { LocalFallbackProvider, type CoachProvider } from '../../src/server/coach/provider';
import type { CoachContext } from '../../src/server/coach/context';
import { workspaceFiles, Peer, id, settings } from '../qa/helpers';

const silent = {kind:'SILENT',reason:'Injected integration fixture only'};
const insertion = (textBlock:string) => ({range:{startLine:1,startColumn:1,endLine:1,endColumn:1},textBlock});
const edit = (c:Readonly<CoachContext>) => ({kind:'EDIT',purpose:'Injected two-step plan',path:'main.py',
  documentVersion:c.documents.find(d=>d.path==='main.py')!.version,workspaceVersion:c.workspaceVersion,
  steps:[insertion('a'),insertion('b')]});
const hint = (c:Readonly<CoachContext>) => ({kind:'HINT',severity:'NEUTRAL',text:'Injected integration hint',path:'main.py',
  documentVersion:c.documents.find(d=>d.path==='main.py')!.version,range:null,showPointer:true,evidenceIds:[]});

async function fixture(t:TestContext, provider:CoachProvider, consent=true) {
  const dirs=await workspaceFiles(t,{'main.py':'value = 0\n','.env.fixture':'SYNTHETIC_EXCLUDED_ONLY'});
  const token=`integration-sensitive-${id()}`;
  const app=createPairCoachServer({...dirs,port:0,token,enableCoach:true,coachProvider:provider});
  // These settings represent the user's approved input; provider cannot change them.
  app.workspace.updateSettings({...settings,aiConsent:consent,contextPatterns:['**/*']});
  const port=await app.listen(), baseURL=`http://127.0.0.1:${port}`;
  const clientId=id(),sessionId=app.session.getSession().sessionId;
  const peers=new Set<{close():void}>();
  t.after(async()=>{for(const p of peers)p.close();await app.close();await dirs.cleanup();});
  const http=async(method:string,url:string,body?:unknown)=>{
    const response=await fetch(baseURL+url,{method,headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},
      body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(5000)});
    return {status:response.status,body:await response.json()};
  };
  const f={...dirs,app,port,baseURL,clientId,sessionId,token,peers,http};
  const peer=new Peer(f as any);const initialSnapshot=await peer.connect();
  const command=()=>({requestId:id(),clientId,sessionId});
  const start=await http('POST','/api/session/start',{...command(),limitMs:null,pauseOnHidden:true});assert.equal(start.status,200);
  const chat=async(text:string)=>{const messageId=peer.send('CHAT_MESSAGE',{text,path:null,documentVersion:null,selection:null});
    assert.equal((await peer.ack(messageId)).payload.status,'OK');return messageId;};
  const write=async(content:string)=>{
    const doc=(await http('GET','/api/file?path=main.py')).body,state=(await http('GET','/api/session')).body;
    const ack=(await peer.ack(peer.send('CODE_CHANGED',{path:'main.py',content,baseVersion:doc.version,controlEpoch:state.controlEpoch,editKind:'TYPING'}))).payload;
    assert.equal(ack.status,'OK');assert.equal(await readFile(path.join(dirs.rootPath,'main.py'),'utf8'),content);return ack;
  };
  return {...f,peer,command,chat,write,initialSnapshot};
}

test('G2 real REST/WS: consent OFF means no provider call; enabling consent yields HINT without control',{timeout:12000},async t=>{
  const contexts:Readonly<CoachContext>[]=[];
  const f=await fixture(t,{name:'INJECTED',mode:'INJECTED',async decide(c){contexts.push(c);return hint(c);}},false);
  await f.chat('No consent');await f.write('manual without AI\n');await delay(400);assert.equal(contexts.length,0);
  const state=f.app.session.getSession();
  const reply=await f.http('PUT','/api/project/settings',{...f.command(),expectedWorkspaceVersion:state.workspaceVersion,
    settings:{...f.app.workspace.settings,aiConsent:true}});assert.equal(reply.status,200);
  await f.chat('Now consented');const bubble=await f.peer.take(m=>m.type==='COACH_HINT_BUBBLE');
  assert.equal(bubble.payload.text,'Injected integration hint');assert.equal(contexts.length,1);
  assert.equal(contexts[0].documents.some(d=>d.path==='.env.fixture'),false);
  assert.equal(f.app.session.getSession().writeOwner,'STUDENT');f.peer.assertProtocol();
});

test('G2 real coordinator: CONTROL_READY and matching STEP_RENDERED gate each actual disk step',{timeout:12000},async t=>{
  const f=await fixture(t,{name:'INJECTED',mode:'INJECTED',async decide(c){return c.messages.length?edit(c):silent;}});
  await f.chat('Demonstrate');const prepare=(await f.peer.take(m=>m.type==='CONTROL_PREPARE')).payload;
  assert.equal(await readFile(path.join(f.rootPath,'main.py'),'utf8'),'value = 0\n');
  const readyId=f.peer.send('CONTROL_READY',{requestId:prepare.requestId,workspaceVersion:prepare.basedOnWorkspaceVersion,ready:true});
  assert.equal((await f.peer.ack(readyId)).payload.status,'OK');
  const first=(await f.peer.take(m=>m.type==='COACH_STEP_EDIT')).payload;
  assert.equal(await readFile(path.join(f.rootPath,'main.py'),'utf8'),'avalue = 0\n');
  const wrong=f.peer.send('STEP_RENDERED',{stepId:id(),interventionId:first.interventionId,documentVersion:first.version});
  assert.equal((await f.peer.ack(wrong)).payload.status,'OK');await delay(40);
  assert.equal(await readFile(path.join(f.rootPath,'main.py'),'utf8'),'avalue = 0\n');
  const rendered=f.peer.send('STEP_RENDERED',{stepId:first.stepId,interventionId:first.interventionId,documentVersion:first.version});
  assert.equal((await f.peer.ack(rendered)).payload.status,'OK');
  const second=(await f.peer.take(m=>m.type==='COACH_STEP_EDIT')).payload;assert.equal(second.baseVersion,first.version);
  assert.equal(await readFile(path.join(f.rootPath,'main.py'),'utf8'),'bavalue = 0\n');
  await f.peer.ack(f.peer.send('STEP_RENDERED',{stepId:second.stepId,interventionId:second.interventionId,documentVersion:second.version}));
  await f.peer.take(m=>m.type==='CONTROL_STATE'&&m.payload.writeOwner==='STUDENT'&&m.payload.controlEpoch>first.controlEpoch);
  f.peer.assertProtocol();
});

test('G2 real veto: abort provider/coordinator, late STEP_RENDERED cannot commit second step',{timeout:12000},async t=>{
  let signal:AbortSignal|undefined;
  const f=await fixture(t,{name:'INJECTED',mode:'INJECTED',async decide(c,s){signal=s;return c.messages.length?edit(c):silent;}});
  await f.chat('Demo');const prepare=(await f.peer.take(m=>m.type==='CONTROL_PREPARE')).payload;
  await f.peer.ack(f.peer.send('CONTROL_READY',{requestId:prepare.requestId,workspaceVersion:prepare.basedOnWorkspaceVersion,ready:true}));
  const first=(await f.peer.take(m=>m.type==='COACH_STEP_EDIT')).payload;
  const payload={controlEpoch:first.controlEpoch,activeInterventionId:first.interventionId,lastAppliedSeq:f.app.session.getSession().lastServerSeq};
  const vetoId=f.peer.send('VETO_ESCAPE',payload);assert.equal((await f.peer.ack(vetoId)).payload.status,'OK');
  assert.equal(signal?.aborted,true);assert.equal(f.app.session.getSession().cooldownAfterVeto,true);
  const duplicate=await f.http('POST','/api/session/veto',{...f.command(),requestId:vetoId,...payload});assert.equal(duplicate.status,200);
  await f.peer.ack(f.peer.send('STEP_RENDERED',{stepId:first.stepId,interventionId:first.interventionId,documentVersion:first.version}));
  await delay(60);assert.equal(await readFile(path.join(f.rootPath,'main.py'),'utf8'),'avalue = 0\n');
  await f.write('student draft after veto\n');assert.equal(f.app.session.getSession().writeOwner,'STUDENT');f.peer.assertProtocol();
});

test('G2 analysis does not block real autosave; stale output never acquires control and latest CHAT uses current context',{timeout:12000},async t=>{
  let resolveOld!:(value:unknown)=>void;let oldSignal:AbortSignal|undefined;const contexts:Readonly<CoachContext>[]=[];
  const f=await fixture(t,{name:'INJECTED',mode:'INJECTED',async decide(c,s){
    if(!c.messages.length)return silent;contexts.push(c);if(contexts.length===1){oldSignal=s;return new Promise(r=>{resolveOld=r;});}
    return {kind:'REPLY',text:'Latest context only'};
  }});
  await f.chat('Analyze');while(!resolveOld)await delay(1);
  await f.write('new user work while analysis waits\n');assert.equal(oldSignal?.aborted,true);
  resolveOld(edit(contexts[0]));const reply=await f.peer.take(m=>m.type==='CHAT_REPLY'&&m.payload.text==='Latest context only');
  assert(reply.payload.replyTo);assert.equal(contexts.length,2);
  assert.equal(contexts[1].documents.find(d=>d.path==='main.py')!.content,'new user work while analysis waits\n');
  assert.equal(f.peer.frames.some(m=>m.type==='CONTROL_PREPARE'||m.type==='COACH_STEP_EDIT'),false);f.peer.assertProtocol();
});

test('G2 default factory exact token redaction and explicit local fallback preserve real editing',{timeout:12000},async t=>{
  const contexts:Readonly<CoachContext>[]=[];
  const f=await fixture(t,{name:'INJECTED',mode:'INJECTED',async decide(c){contexts.push(c);return silent;}});
  await f.chat(`Pasted sensitive value ${f.token}`);await delay(30);
  assert.equal(JSON.stringify(contexts).includes(f.token),false);assert(JSON.stringify(contexts).includes('[REDACTED]'));
  const fallback=await fixture(t,new LocalFallbackProvider());
  await fallback.chat('No AI configured');
  assert(fallback.initialSnapshot.payload.chat.some((entry:any)=>entry.text.includes('brak GEMINI_API_KEY')) ||
    fallback.peer.frames.some(m=>m.type==='CHAT_REPLY'&&m.payload.text.includes('brak GEMINI_API_KEY')),
    'Fallback reason is delivered as an actual WS event or retained initial session chat');
  assert.equal(fallback.app.session.getSession().aiStatus,'OFF');await fallback.write('manual work with fallback\n');
  f.peer.assertProtocol();fallback.peer.assertProtocol();
});
