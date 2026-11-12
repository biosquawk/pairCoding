/** Real ephemeral HTTP/WS listener and adapter; injected decisions, no real model. */
import test, {type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {createPairCoachServer, type ServerOptions} from '../../src/server/http';
import {workspaceFiles, Peer, id, settings} from './helpers';
import type {CoachContext} from '../../src/server/coach/context';

const disabled={kind:'PROPOSE',proposalKind:'GENERATE_TESTS',questionText:'Wygenerować?',snapshotId:null,paths:['main.py'],resetTimer:false} as const;
async function fixture(t:TestContext,options:Partial<ServerOptions>) {
  const dirs=await workspaceFiles(t,{'main.py':'student work\n'}), token='ephemeral-'+id();
  const app=createPairCoachServer({...dirs,port:0,token,enableCoach:true,...options});
  app.workspace.updateSettings({...settings,aiConsent:true});
  const port=await app.listen(),baseURL=`http://127.0.0.1:${port}`;
  const f={...dirs,app,port,baseURL,token,clientId:id(),sessionId:app.session.getSession().sessionId,peers:new Set<{close():void}>()};
  t.after(async()=>{for(const p of f.peers)p.close();await app.close();await dirs.cleanup();});
  const peer=new Peer(f as any);await peer.connect();
  const response=await fetch(baseURL+'/api/session/start',{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},
    body:JSON.stringify({requestId:id(),clientId:f.clientId,sessionId:f.sessionId,limitMs:null,pauseOnHidden:false}),signal:AbortSignal.timeout(5000)});
  assert.equal(response.status,200);
  return {...f,peer};
}

test('public WS: capability/evidence/MUTE rejection yields safe ERROR, no hint/proposal/write/control, autosave still works',async t=>{
  const contexts:Readonly<CoachContext>[]=[];
  const f=await fixture(t,{coachProvider:{name:'injected',decide:async c=>{
    if(c.trigger?.reason!=='CHAT')return {kind:'SILENT',reason:'fixture'};
    contexts.push(c);
    const text=c.messages.find(m=>m.messageId===c.trigger!.messageId)!.text;
    if(text==='generate')return disabled;
    if(text==='mixed')return {kind:'HINT',severity:'NEUTRAL',text:'untrusted body should not appear',path:null,documentVersion:null,range:null,
      showPointer:false,evidenceIds:[c.trigger!.messageId,'PRIVATE_INVENTED_TOKEN']};
    return {kind:'MUTE',durationSeconds:60,sourceUserMessageId:c.trigger!.messageId};
  }}});
  const before=f.app.session.getSession(),version=f.app.workspace.workspaceVersion;
  for(const text of ['generate','mixed','„wycisz trenera”']) {
    const messageId=f.peer.send('CHAT_MESSAGE',{text,path:null,documentVersion:null,selection:null});
    assert.equal((await f.peer.ack(messageId)).payload.status,'OK');
    const error=(await f.peer.take(m=>m.type==='ERROR')).payload;
    assert.equal(error.code,'COACH_RESPONSE_REJECTED');assert.equal(error.retryable,false);
    assert.match(error.message,text==='generate'?/niedostępna/:text==='mixed'?/nieznany identyfikator/:/bezpośredniej prośby/);
    assert.doesNotMatch(JSON.stringify(error),/PRIVATE_INVENTED_TOKEN|untrusted body/);
    const state=f.app.session.getSession();
    assert.equal(state.controlEpoch,before.controlEpoch);assert.equal(state.writeOwner,'STUDENT');
    assert.notEqual(state.coachMode,'MUTED_MANUAL');assert.equal(f.app.workspace.workspaceVersion,version);
    assert.equal(await readFile(path.join(f.rootPath,'main.py'),'utf8'),'student work\n');
    assert.equal(f.peer.frames.some(m=>['COACH_HINT_BUBBLE','COACH_POINTER','ACTION_PROPOSAL','CONTROL_PREPARE','COACH_STEP_EDIT'].includes(m.type)),false);
  }
  assert.equal(contexts.length,3,'one provider call per accepted CHAT; no hidden retry');
  for(const c of contexts){
    assert.deepEqual(c.capabilities,{canGenerateTests:false});assert(c.allowedEvidenceIds!.includes(c.trigger!.messageId!));
  }
  const doc=f.app.workspace.getDocument('main.py');
  const ack=await f.peer.ack(f.peer.send('CODE_CHANGED',{path:'main.py',baseVersion:doc.version,controlEpoch:before.controlEpoch,
    content:'student continues\n',editKind:'TYPING'}));
  assert.equal(ack.payload.status,'OK');assert.equal(await readFile(path.join(f.rootPath,'main.py'),'utf8'),'student continues\n');
  f.peer.assertProtocol();
});

test('public WS defense: injected stale CoachService cannot publish GENERATE_TESTS through postProposal',async t=>{
  const f=await fixture(t,{coachFactory:c=>({trigger(reason){if(reason==='CHAT')c.onProposal({...disabled,paths:['main.py']});},
    controlReady(){},stepRendered(){},abort(){},close(){}})});
  const before=f.app.session.getSession();
  const messageId=f.peer.send('CHAT_MESSAGE',{text:'help',path:null,documentVersion:null,selection:null});
  assert.equal((await f.peer.ack(messageId)).payload.status,'OK');
  const error=(await f.peer.take(m=>m.type==='ERROR')).payload;
  assert.equal(error.code,'COACH_RESPONSE_REJECTED');assert.match(error.message,/Generowanie testów jest niedostępne/);
  assert.equal(f.peer.frames.some(m=>m.type==='ACTION_PROPOSAL'),false);
  assert.equal(f.app.session.getSession().controlEpoch,before.controlEpoch);
  assert.equal(f.app.session.getSession().writeOwner,'STUDENT');
  assert.equal(await readFile(path.join(f.rootPath,'main.py'),'utf8'),'student work\n');
  f.peer.assertProtocol();
});
