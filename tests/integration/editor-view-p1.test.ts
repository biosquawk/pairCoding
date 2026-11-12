/** Real HTTP+WS+CoachAdapter; only the provider decision boundary is captured, NOT real AI. */
import test, {type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {writeFile,readFile,mkdir} from 'node:fs/promises';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {createPairCoachServer} from '../../src/server/http';
import type {CoachContext} from '../../src/server/coach/context';
import {workspaceFiles,Peer,id,settings} from '../qa/helpers';

async function fixture(t: TestContext) {
  const dirs=await workspaceFiles(t,{'main.py':'a😀b\nsecond\n','.env.fixture':'PRIVATE_EXCLUDED','hidden.txt':'PRIVATE_PATTERN'});
  const contexts:Readonly<CoachContext>[]=[];
  const token='sensitive-'+id(),app=createPairCoachServer({...dirs,port:0,token,enableCoach:true,
    coachProvider:{name:'VIEW_CAPTURE',mode:'INJECTED',async decide(c){contexts.push(c);return {kind:'REPLY',text:'captured'};}}});
  const port=await app.listen(),baseURL=`http://127.0.0.1:${port}`,clientId=id(),sessionId=app.session.getSession().sessionId;
  const peers=new Set<{close():void}>(),f={...dirs,app,port,baseURL,clientId,sessionId,token,peers};
  t.after(async()=>{for(const p of peers)p.close();await app.close();await dirs.cleanup();});
  const peer=new Peer(f as any);await peer.connect();
  const http=async(method:string,url:string,body?:unknown)=>{
    const r=await fetch(baseURL+url,{method,headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
    return {status:r.status,body:await r.json()};
  };
  const command=()=>({clientId,sessionId,requestId:id()});
  assert.equal((await http('POST','/api/session/start',{...command(),limitMs:null,pauseOnHidden:true})).status,200);
  assert.equal((await http('PUT','/api/project/settings',{...command(),expectedWorkspaceVersion:app.workspace.workspaceVersion,
    settings:{...settings,aiConsent:true,contextPatterns:['*.py','*.md','.env*']}})).status,200);
  const view=async(payload:unknown)=>(await peer.ack(peer.send('VIEW_CHANGED',payload))).payload;
  const chat=async()=>{
    // Bogus legacy CHAT selection is not authoritative. The validated view is.
    const msg=peer.send('CHAT_MESSAGE',{text:'explain selection '+id(),path:null,documentVersion:null,selection:null});
    assert.equal((await peer.ack(msg)).payload.status,'OK');await peer.take(m=>m.type==='CHAT_REPLY'&&m.payload.replyTo===msg);
    return contexts.at(-1)!;
  };
  return {...f,peer,http,command,contexts,view,chat};
}
const selection={startLine:1,startColumn:2,endLine:2,endColumn:4};
const valid={path:'main.py',documentVersion:1,cursor:{line:1,column:4},selection};

test('WS view -> next CHAT actual providercontext, motion has no AI/disk/epoch/Veto side effects',async t=>{
  const f=await fixture(t),state=f.app.session.getSession();
  assert.equal(f.contexts.length,0);
  for(let i=0;i<5;i++){const ack=await f.view({...valid,cursor:{line:2,column:1+i}});assert.equal(ack.status,'OK');assert.equal(ack.documentVersion,1);}
  await delay(60);assert.equal(f.contexts.length,0);
  assert.equal(await readFile(path.join(f.rootPath,'main.py'),'utf8'),'a😀b\nsecond\n');
  assert.equal(f.app.session.getSession().controlEpoch,state.controlEpoch);assert.equal(f.app.workspace.workspaceVersion,state.workspaceVersion);
  assert.deepEqual((await f.chat()).view,{projectId:f.app.workspace.projectId,path:'main.py',documentVersion:1,
    cursor:{line:2,column:5},selection,selectedText:'😀b\nsec',selectionTruncated:false});
  const veto=f.peer.send('VETO_ESCAPE',{controlEpoch:f.app.session.state.controlEpoch,activeInterventionId:null,lastAppliedSeq:f.app.session.state.lastServerSeq});
  assert.equal((await f.peer.ack(veto)).payload.status,'OK');
  const count=f.contexts.length;
  await f.view(valid);await delay(60);
  assert.equal(f.app.session.getSession().cooldownAfterVeto,true);assert.equal(f.contexts.length,count);
  f.peer.assertProtocol();
});

test('WS invalid version/range/path/session rejects without replacing accepted view; edits and reconnect clear it',async t=>{
  const f=await fixture(t);assert.equal((await f.view(valid)).status,'OK');
  const original=f.app.session.getEditorView();
  const acceptedId=f.peer.send('VIEW_CHANGED',valid);
  assert.equal((await f.peer.ack(acceptedId)).payload.documentVersion,1);
  const duplicate=f.peer.send('VIEW_CHANGED',valid,acceptedId), duplicateAck=(await f.peer.ack(duplicate)).payload;
  assert.equal(duplicateAck.status,'DUPLICATE');assert.equal(duplicateAck.documentVersion,1);
  for(const [bad,code] of [
    [{...valid,documentVersion:2},'DOCUMENT_VERSION_CONFLICT'],
    [{...valid,cursor:{line:1,column:3}},'INVALID_VIEW'],
    [{...valid,selection:{startLine:2,startColumn:2,endLine:1,endColumn:1}},'INVALID_VIEW'],
    [{...valid,cursor:{line:9,column:1}},'INVALID_VIEW'],
    [{...valid,path:'missing.py'},'FILE_NOT_FOUND'],
  ] as const){const ack=await f.view(bad);assert.equal(ack.status,'REJECTED');assert.equal(ack.error.code,code);assert.deepEqual(f.app.session.getEditorView(),original);assert.equal(ack.documentVersion,null);assert.equal(f.contexts.length,0);}
  const msg=id();f.peer.socket.send(JSON.stringify({protocolVersion:'3.0',messageId:msg,sessionId:'foreign-session',clientId:f.clientId,type:'VIEW_CHANGED',payload:valid}));
  assert.equal((await f.peer.ack(msg)).payload.error.code,'SESSION_MISMATCH');assert.deepEqual(f.app.session.getEditorView(),original);
  assert.deepEqual((await f.chat()).view?.selection,selection);
  const edit=f.peer.send('CODE_CHANGED',{path:'main.py',content:'changed\n',baseVersion:1,controlEpoch:f.app.session.state.controlEpoch,editKind:'TYPING'});
  assert.equal((await f.peer.ack(edit)).payload.status,'OK');assert.equal((await f.chat()).view,null);
  assert.equal((await f.view({...valid,documentVersion:2,cursor:null,selection:null})).status,'OK');
  assert.equal((await f.chat()).view?.selectedText,null);
  f.peer.close();await new Promise<void>(r=>f.peer.socket.once('close',()=>r()));
  const peer2=new Peer(f as any);await peer2.connect();assert.equal(f.app.session.getEditorView(),null);
});

test('WS policy/redaction and project switch: no secret or foreign view reaches next provider',async t=>{
  const f=await fixture(t);
  const content='safe '+f.token+' api_key="TOP_SECRET"';
  const edit=f.peer.send('CODE_CHANGED',{path:'main.py',content,baseVersion:1,controlEpoch:0,editKind:'TYPING'});
  assert.equal((await f.peer.ack(edit)).payload.status,'OK');
  assert.equal((await f.view({path:'main.py',documentVersion:2,cursor:null,selection:{startLine:1,startColumn:8,endLine:1,endColumn:15}})).status,'OK');
  const secret=await f.chat();assert.equal(secret.view?.selectedText,'[REDACTED]');assert.doesNotMatch(JSON.stringify(secret),new RegExp(f.token+'|TOP_SECRET'));
  for(const p of ['.env.fixture','hidden.txt']) {
    assert.equal((await f.view({path:p,documentVersion:1,cursor:null,selection:null})).status,'OK');
    assert.equal((await f.chat()).view,null);
  }
  const clear=await f.view({path:null,documentVersion:null,cursor:null,selection:null});assert.equal(clear.status,'OK');assert.equal(clear.documentVersion,null);
  assert.equal((await f.chat()).view,null);
  assert.equal((await f.view({path:'main.py',documentVersion:2,cursor:null,selection:null})).status,'OK');
  const other=path.join(f.base,'other-project');await mkdir(other);await writeFile(path.join(other,'main.py'),'foreign project');
  const open=await f.http('POST','/api/project/open',{requestId:id(),clientId:f.clientId,rootPath:other,settings:f.app.workspace.settings});
  assert.equal(open.status,201);assert.notEqual(f.app.workspace.projectId,secret.view?.projectId);assert.equal(f.app.session.getEditorView(),null);
  const sessionId=f.app.session.getSession().sessionId;
  const nextPeer=new Peer({...f,sessionId} as any);await nextPeer.connect();
  assert.equal((await f.http('POST','/api/session/start',{requestId:id(),clientId:f.clientId,sessionId,limitMs:null,pauseOnHidden:true})).status,200);
  await nextPeer.take(m=>m.type==='CHAT_REPLY');
  const next=f.contexts.at(-1)!;assert.equal(next.view,null);assert.equal(next.documents.find(d=>d.path==='main.py')?.content,'foreign project');
});
