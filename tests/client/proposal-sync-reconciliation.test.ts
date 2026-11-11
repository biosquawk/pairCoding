/** Additional regressions for P5's overlapping snapshot and exhausted reconnect findings. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {LiveBackend} from '../../src/services/LiveBackend';
import type * as Wire from '../../src/shared/protocol';
const turn=()=>new Promise<void>(resolve=>setImmediate(resolve));
async function fixture(){
  const bundle:Wire.SessionBundle={
    project:{projectId:'p',sessionId:'s',rootPath:'fixture',workspaceVersion:1,files:[],capabilities:{canRunMain:false,canRunTests:false,docs:'NOT_INSTALLED',autocomplete:'NOT_INSTALLED'},settings:{taskMode:'IMPLEMENTATION',taskFilePath:null,reviewNotesPath:'review.md',aiConsent:false,runProfiles:[],contextPatterns:[]}},
    session:{sessionId:'s',projectId:'p',lifecycle:'READY',controlEpoch:1,workspaceVersion:1,writeOwner:'STUDENT',coachMode:'UNAVAILABLE',aiStatus:'OFF',presence:'FOCUSED',activeFilePath:null,cooldownAfterVeto:false,interventionId:null,lastServerSeq:0,timer:{status:'STOPPED',elapsedMs:0,limitMs:null,pauseOnHidden:true,manualPaused:false,serverTime:new Date().toISOString()}},
    proposals:[{proposalId:'p1',kind:'RESTORE_SNAPSHOT',basedOnWorkspaceVersion:1,questionText:'Restore?',yesLabel:'Y',noLabel:'N',expiresAt:new Date(Date.now()+60000).toISOString(),paths:[],snapshotId:'snap',resetTimer:false}],activeDocument:null,report:null,lastRun:null,chat:[]};
  const sockets:any[]=[],pending:((r:Response)=>void)[]=[],storage=new Map<string,string>();let defer=false,seq=0;
  const client=new LiveBackend({token:'synthetic',clientId:'tab',storage:{getItem:k=>storage.get(k)??null,setItem:(k,v)=>{storage.set(k,v);},removeItem:k=>{storage.delete(k);}},socket:()=>{const s:any={readyState:1,sent:[],send(raw:string){this.sent.push(raw);},close(){this.readyState=3;this.onclose?.({});}};sockets.push(s);return s;},fetch:async(url)=>{
    const route=new URL(String(url)).pathname;
    if(route==='/api/file'&&defer)return new Promise<Response>(resolve=>pending.push(resolve));
    return Response.json(route==='/api/project'?bundle.project:route==='/api/session'?bundle.session:[]);
  }});
  const frame=(type:string,payload:any)=>sockets.at(-1).onmessage({data:JSON.stringify({protocolVersion:'3.0',messageId:'f'+(++seq),seq,sessionId:bundle.session.sessionId,type,payload})});
  const hello=async()=>{await client.connect();sockets.at(-1).onopen({});frame('SESSION_SNAPSHOT',structuredClone(bundle));await turn();};
  const responses=()=>sockets.flatMap(s=>s.sent).filter(raw=>JSON.parse(raw).type==='PROPOSAL_RESPONSE');
  const doc=():Wire.Document=>({path:'task.md',content:'# task',version:1,languageId:'markdown',contentHash:'0'.repeat(64),readOnly:false,eol:'LF',utf8Bom:false});
  await hello();return {client,bundle,sockets,pending,frame,hello,responses,defer:()=>{defer=true;},doc};
}
test('latest overlapping snapshot consumes fresh HELLO once, stale IO/broadcast/reconnect never sends a third copy',async t=>{
  const f=await fixture();t.after(()=>f.client.close());void f.client.respondToProposal('p1',true);const raw=f.responses()[0];
  f.sockets[0].close();f.bundle.proposals=[];f.bundle.project.settings.taskFilePath='task.md';f.defer();await f.hello();
  f.frame('SESSION_SNAPSHOT',structuredClone(f.bundle));await turn();assert.equal(f.pending.length,2);
  f.pending[1](Response.json(f.doc()));await turn();await turn();
  assert.equal(f.client.getState().isOffline,false);assert.deepEqual(f.responses(),[raw,raw]);
  f.pending[0](Response.json(f.doc()));await turn();f.frame('SESSION_SNAPSHOT',structuredClone(f.bundle));await turn();f.pending[2](Response.json(f.doc()));await turn();
  f.sockets.at(-1).close();await f.hello();f.pending[3](Response.json(f.doc()));await turn();
  assert.deepEqual(f.responses(),[raw,raw],'superseded installation, broadcast and reconnect cannot repeat ledger read');
  f.frame('ACK',{replyTo:JSON.parse(raw).messageId,status:'REJECTED',documentVersion:null,workspaceVersion:1,controlEpoch:1,error:{code:'RECOVERY_REQUIRED',message:'retained',retryable:false,requestId:null,currentVersion:null}});
  assert.match(f.client.getState().connectionError!,/RECOVERY_REQUIRED/);
});
test('latest overlapping snapshot with proposal still present does not replay; a later broadcast has no HELLO eligibility',async t=>{
  const f=await fixture();t.after(()=>f.client.close());void f.client.respondToProposal('p1',true);f.sockets[0].close();
  f.bundle.project.settings.taskFilePath='task.md';f.defer();await f.hello();f.frame('SESSION_SNAPSHOT',structuredClone(f.bundle));await turn();
  f.pending[1](Response.json(f.doc()));f.pending[0](Response.json(f.doc()));await turn();await turn();assert.equal(f.responses().length,1);
  f.bundle.proposals=[];f.frame('SESSION_SNAPSHOT',structuredClone(f.bundle));await turn();f.pending[2](Response.json(f.doc()));await turn();
  assert.equal(f.responses().length,1,'absence in ordinary broadcast is not new authorization');assert.match(f.client.getState().connectionError!,/wynik nieznany/i);
});
test('exhausted reconnects retain explicit UNKNOWN, offline/write lock and original envelope',async t=>{
  const f=await fixture();t.after(()=>f.client.close());void f.client.respondToProposal('p1',true);const raw=f.responses()[0];
  for(let i=0;i<4;i++){f.sockets.at(-1).close();if(i<3)await f.client.connect();}
  assert.equal(f.client.getState().isOffline,true);assert.equal(f.client.getState().writeOwner,'SYNCING');assert.match(f.client.getState().connectionError!,/wynik nieznany/i);assert.deepEqual(f.responses(),[raw]);
});
