/** HUMAN 289eb23f: synthetic HTTP boundary tests, NOT real backend integration. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {LiveBackend} from '../../src/services/LiveBackend';
import type * as Wire from '../../src/shared/protocol';
const turn=()=>new Promise<void>(r=>setImmediate(r));
async function drain(){for(let n=0;n<4;n++)await turn();}
type Failure='unreadable503'|'readable503'|'unreadable409';
async function fixture(failure:Failure){
  const project:Wire.Project={projectId:'project',sessionId:'session',rootPath:'synthetic',workspaceVersion:1,files:[],capabilities:{canRunMain:false,canRunTests:false,docs:'NOT_INSTALLED',autocomplete:'NOT_INSTALLED'},settings:{taskMode:'IMPLEMENTATION',taskFilePath:null,reviewNotesPath:'review.md',aiConsent:false,runProfiles:[],contextPatterns:[]}};
  const session:Wire.Session={sessionId:'session',projectId:'project',lifecycle:'READY',workspaceVersion:1,controlEpoch:1,writeOwner:'STUDENT',coachMode:'UNAVAILABLE',cooldownAfterVeto:false,presence:'FOCUSED',aiStatus:'OFF',timer:{status:'STOPPED',elapsedMs:0,limitMs:null,pauseOnHidden:true,manualPaused:false,serverTime:new Date().toISOString()},activeFilePath:null,interventionId:null,lastServerSeq:0};
  const requests:{method:string;path:string;body:any}[]=[],sockets:any[]=[];
  let seq=0,report:Wire.Report|null=null,jsonFailures=0;
  const client=new LiveBackend({baseUrl:'http://127.0.0.1:51234',token:'synthetic-token',clientId:'qa-unreadable-tab',
    socket:()=>{const ws:any={readyState:1,send(){},close(){ws.readyState=3;ws.onclose?.({});}};sockets.push(ws);return ws;},
    fetch:async(url,options)=>{
      assert.equal(new Headers(options?.headers).get('Authorization'),'Bearer synthetic-token');
      const path=new URL(String(url)).pathname,method=options?.method??'GET';
      requests.push({method,path,body:options?.body?JSON.parse(String(options.body)):null});
      if(path==='/api/session/finish'){
        const response=new Response(JSON.stringify({code:'SERVICE_UNAVAILABLE',message:'Jawne odrzucenie przed efektem.',retryable:true}),{status:failure==='unreadable409'?409:503});
        // fetch resolves with headers/status; only body consumption fails (not a fetch rejection).
        if(failure!=='readable503')Object.defineProperty(response,'json',{value:async()=>{jsonFailures++;throw new TypeError('body terminated');}});
        return response;
      }
      if(path==='/api/session/report')return new Response(JSON.stringify(report??{code:'REPORT_NOT_FOUND'}),{status:report?200:404});
      return new Response(JSON.stringify(path==='/api/project'?project:path==='/api/session'?session:[]));
    },
  });
  const receive=(type:string,payload:unknown)=>sockets.at(-1).onmessage?.({data:JSON.stringify({protocolVersion:'3.0',messageId:'frame-'+(++seq),sessionId:session.sessionId,seq,type,payload})});
  await client.connect();sockets.at(-1).onopen?.({});
  receive('SESSION_SNAPSHOT',{project,session,activeDocument:null,proposals:[],lastRun:null,report:null,chat:[]});await drain();
  return {client,session,requests,receive,posts:()=>requests.filter(r=>r.method==='POST'),jsonFailures:()=>jsonFailures,
    report:(value:Wire.Report)=>{report=value;receive('SESSION_REPORT',value);}};
}
test('UNIT unreadable503 critical control: next and opposite clicks never create a fresh-ID finishPOST',async t=>{
  const f=await fixture('unreadable503');t.after(()=>f.client.close());
  await f.client.finishSession('COMPLETED');await drain();
  assert.equal(f.jsonFailures(),1,'the failure is after received status503');
  await f.client.finishSession('ABANDONED');await f.client.finishSession('COMPLETED');await drain();
  assert.equal(f.posts().length,1,'unreadable503 cannot prove non-execution; preserve original command, never POST a new ID');
});
test('UNIT unreadable503: originalID UNKNOWN survives report404, reconciles read-only only with matching proof',async t=>{
  const f=await fixture('unreadable503');t.after(()=>f.client.close());
  await f.client.finishSession('COMPLETED');await drain();
  const original=f.posts()[0].body,notice=f.client.getState().connectionError!;
  assert.match(notice,/wynik.*nieznan/iu);assert(notice.includes(original.requestId),'unknown notice correlates the original requestID');
  assert(f.requests.some(r=>r.method==='GET'&&r.path==='/api/session/report'),'404 read-only reconciliation is attempted');
  await f.client.finishSession('COMPLETED');assert.equal(f.posts().length,1);
  const report:Wire.Report={reportId:'durable-report',sessionId:'session',status:'READY',reason:'COMPLETED',sourceWorkspaceVersion:1,snapshotId:'final',generatedAt:new Date().toISOString(),markdown:'durable',evidenceIds:[],error:null};
  f.report({...report,sourceWorkspaceVersion:2});await drain();
  assert.match(f.client.getState().connectionError!,/wynik.*nieznan/iu);
  await f.client.finishSession('ABANDONED');assert.equal(f.posts().length,1,'mismatched evidence cannot release the original command');
  f.session.lifecycle='FINISHED';f.report(report);await drain();
  assert.equal(f.client.getState().connectionError,null);assert.equal(f.client.getState().report?.status,'READY');
  await f.client.finishSession('COMPLETED');assert.equal(f.posts().length,1);
});
for(const failure of ['readable503','unreadable409'] as const)test(`UNIT negative control ${failure}: definite rejection permits an explicit corrected click`,async t=>{
  const f=await fixture(failure);t.after(()=>f.client.close());
  await f.client.finishSession('COMPLETED');await drain();
  assert(f.client.getState().connectionError);assert.doesNotMatch(f.client.getState().connectionError!,/wynik.*nieznan/iu);
  assert.equal(f.requests.filter(r=>r.path==='/api/session/report').length,0,'no ambiguous reconciliation for definite rejection');
  await f.client.finishSession('COMPLETED');assert.equal(f.posts().length,2);assert.notEqual(f.posts()[0].body.requestId,f.posts()[1].body.requestId);
  if(failure==='unreadable409')assert.equal(f.jsonFailures(),2);
});
