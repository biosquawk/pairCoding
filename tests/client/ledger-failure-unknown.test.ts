/** Synthetic transport UNIT evidence, not real REST/WS integration. Never invokes private methods. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {LiveBackend} from '../../src/services/LiveBackend';
import type * as Wire from '../../src/shared/protocol';
import {assertAmbiguousMessage} from '../qa/ledger-failure-oracle';
const turn=()=>new Promise<void>(r=>setImmediate(r));
const warning='Operacja mogła się wykonać; wynik jest nieznany. Zsynchronizuj stan; nie ponawiaj z nowym ID.';
function bundle():Wire.SessionBundle {
  return {project:{projectId:'project',sessionId:'session',rootPath:'synthetic',workspaceVersion:1,files:[],capabilities:{canRunMain:false,canRunTests:false,docs:'NOT_INSTALLED',autocomplete:'NOT_INSTALLED'},settings:{taskMode:'IMPLEMENTATION',taskFilePath:null,reviewNotesPath:'review.md',aiConsent:false,runProfiles:[],contextPatterns:[]}},
    session:{sessionId:'session',projectId:'project',lifecycle:'READY',workspaceVersion:1,controlEpoch:1,writeOwner:'STUDENT',coachMode:'UNAVAILABLE',cooldownAfterVeto:false,presence:'FOCUSED',aiStatus:'OFF',timer:{status:'STOPPED',elapsedMs:0,limitMs:null,pauseOnHidden:true,manualPaused:false,serverTime:new Date().toISOString()},activeFilePath:null,interventionId:null,lastServerSeq:0},activeDocument:null,proposals:[],lastRun:null,report:null,chat:[]};
}
async function fixture(code:string,status:number) {
  const state=bundle(),requests:{method:string;path:string;body:any}[]=[],sockets:any[]=[];
  let seq=0,durable:Wire.Report|null=null;
  const client=new LiveBackend({baseUrl:'http://127.0.0.1:51234',token:'synthetic-token',clientId:'qa-tab',
    socket:()=>{const ws:any={readyState:1,send(){},close(){ws.readyState=3;ws.onclose?.({});}};sockets.push(ws);return ws;},
    fetch:(async(url,options)=>{
      assert.equal(new Headers(options?.headers).get('Authorization'),'Bearer synthetic-token');
      const target=new URL(String(url)),method=options?.method??'GET';
      requests.push({method,path:target.pathname,body:options?.body?JSON.parse(String(options.body)):null});
      if(target.pathname==='/api/session/finish')return new Response(JSON.stringify({code,message:status===503?warning:'Jawny konflikt.',retryable:false,requestId:requests.at(-1)!.body.requestId,currentVersion:null}),{status});
      if(target.pathname==='/api/session/report')return new Response(JSON.stringify(durable??{code:'REPORT_NOT_FOUND'}),{status:durable?200:404});
      return new Response(JSON.stringify(target.pathname==='/api/project'?state.project:target.pathname==='/api/session'?state.session:[]));
    }) as typeof fetch,
  });
  const receive=(type:string,payload:unknown)=>sockets.at(-1).onmessage?.({data:JSON.stringify({protocolVersion:'3.0',messageId:'frame-'+(++seq),sessionId:state.session.sessionId,seq,type,payload})});
  await client.connect();sockets.at(-1).onopen?.({});receive('SESSION_SNAPSHOT',structuredClone(state));await turn();
  return {client,state,requests,receive,posts:()=>requests.filter(r=>r.method==='POST'),report:(r:Wire.Report)=>{durable=r;receive('SESSION_REPORT',r);}};
}
for(const code of ['COMMAND_RESULT_UNAVAILABLE','COMMAND_STORAGE_UNAVAILABLE'])test(`UNIT finish ${code}: UNKNOWN survives404 and repeated/opposite clicks, only matching durable proof settles`,async t=>{
  const f=await fixture(code,503);t.after(()=>f.client.close());
  await f.client.finishSession('COMPLETED');await turn();await turn();
  const original=f.posts()[0].body;
  assert.equal(f.posts().length,1);assertAmbiguousMessage(f.client.getState().connectionError!);
  assert(f.client.getState().connectionError!.includes(original.requestId),'UNKNOWN identifies the original command');
  // The report GET404 is absence of proof, not permission for another finish mutation.
  for(const reason of ['ABANDONED','COMPLETED'] as const){await f.client.finishSession(reason);await turn();}
  assert.equal(f.posts().length,1,'neither the same nor another reason grants a fresh ID/POST');
  assert(f.requests.some(r=>r.method==='GET'&&r.path==='/api/session/report'),'authenticated read-only reconciliation is attempted');
  const report:Wire.Report={reportId:'report',sessionId:'session',status:'READY',reason:'COMPLETED',sourceWorkspaceVersion:1,snapshotId:'final',generatedAt:new Date().toISOString(),markdown:'frozen',evidenceIds:[],error:null};
  f.report({...report,sourceWorkspaceVersion:2});await turn();await turn();
  assertAmbiguousMessage(f.client.getState().connectionError!);assert.equal(f.posts().length,1,'mismatched report does not release unknown command');
  f.state.session.lifecycle='FINISHED';f.report(report);await turn();await turn();await turn();
  assert.equal(f.client.getState().connectionError,null);assert.equal(f.client.getState().report?.status,'READY');
  await f.client.finishSession('COMPLETED');assert.equal(f.posts().length,1,'settled FINISHED still cannot issue another mutation');
});
test('UNIT finish negative control: explicit409 remains a definite rejection, corrected explicit click may use a freshID',async t=>{
  const f=await fixture('VERSION_CONFLICT',409);t.after(()=>f.client.close());
  await f.client.finishSession('COMPLETED');assert.match(f.client.getState().connectionError!,/VERSION_CONFLICT/);
  assert.equal(f.requests.filter(r=>r.path==='/api/session/report').length,0);
  await f.client.finishSession('COMPLETED');assert.equal(f.posts().length,2);assert.notEqual(f.posts()[0].body.requestId,f.posts()[1].body.requestId);
});
for(const code of ['COMMAND_RESULT_UNAVAILABLE','COMMAND_STORAGE_UNAVAILABLE'])test(`UNIT critical control ${code}: an explicit503 must not release finish permission for a fresh-IDPOST`,async t=>{
  const f=await fixture(code,503);t.after(()=>f.client.close());
  await f.client.finishSession('COMPLETED');await f.client.finishSession('ABANDONED');await f.client.finishSession('COMPLETED');
  assert.equal(f.posts().length,1,'503 ambiguous is not definite rejection: three clicks must create only one HTTP mutation');
});
