/** Finish reconciliation is read-only; unit clocks are not performance evidence. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import {LiveBackend} from '../../src/services/LiveBackend';
import type * as Wire from '../../src/shared/protocol';
const turn=()=>new Promise<void>(resolve=>setImmediate(resolve));
const report=(sessionId='finish-session'):Wire.Report=>({reportId:'finish-report',sessionId,status:'PENDING',reason:'COMPLETED',sourceWorkspaceVersion:1,snapshotId:'final-snapshot',generatedAt:null,markdown:null,evidenceIds:[],error:null});
function bundle():Wire.SessionBundle {
  return {project:{projectId:'project',sessionId:'finish-session',rootPath:'unit',workspaceVersion:1,files:[],capabilities:{canRunMain:false,canRunTests:false,docs:'NOT_INSTALLED',autocomplete:'NOT_INSTALLED'},settings:{taskMode:'IMPLEMENTATION',taskFilePath:null,reviewNotesPath:'review.md',aiConsent:false,runProfiles:[],contextPatterns:[]}},
    session:{sessionId:'finish-session',projectId:'project',lifecycle:'READY',workspaceVersion:1,controlEpoch:1,writeOwner:'STUDENT',coachMode:'UNAVAILABLE',cooldownAfterVeto:false,presence:'FOCUSED',aiStatus:'OFF',timer:{status:'STOPPED',elapsedMs:0,limitMs:null,pauseOnHidden:true,manualPaused:false,serverTime:new Date().toISOString()},activeFilePath:null,interventionId:null,lastServerSeq:0},activeDocument:null,proposals:[],lastRun:null,report:null,chat:[]};
}
class Socket {
  readyState:0|1|2|3=1; onopen:any;onmessage:any;onerror:any;onclose:any;sent:string[]=[];
  send(raw:string){this.sent.push(raw);}close(){this.readyState=3;this.onclose?.({});}
}
async function unit(){
  const b=bundle(),sockets:Socket[]=[],requests:{path:string;method:string;body:any;auth:string|null}[]=[];
  let getReport:Wire.Report|null=null, seq=0,holdSession:(()=>Promise<Response>)|null=null;
  const client=new LiveBackend({token:'unit-token',clientId:'unit-tab',socket:()=>{const s=new Socket();sockets.push(s);return s;},fetch:(async(url,opts)=>{
    const u=new URL(String(url)),method=opts?.method??'GET';
    requests.push({path:u.pathname+u.search,method,body:opts?.body?JSON.parse(String(opts.body)):null,auth:new Headers(opts?.headers).get('Authorization')});
    if(u.pathname==='/api/session/finish')return new Promise((_resolve,reject)=>opts!.signal!.addEventListener('abort',()=>reject(new Error('aborted')),{once:true}));
    if(u.pathname==='/api/session/report')return new Response(JSON.stringify(getReport??{code:'REPORT_NOT_FOUND',message:'not durable yet'}),{status:getReport?200:404});
    if(u.pathname==='/api/session'&&holdSession)return holdSession();
    return new Response(JSON.stringify(u.pathname==='/api/project'?b.project:u.pathname==='/api/session'?b.session:[]));
  }) as typeof fetch});
  const receive=(type:string,payload:any)=>sockets.at(-1)!.onmessage?.({data:JSON.stringify({protocolVersion:'3.0',messageId:'frame-'+(++seq),sessionId:b.session.sessionId,seq,type,payload})});
  async function hello(){await client.connect();sockets.at(-1)!.onopen?.({});receive('SESSION_SNAPSHOT',structuredClone(b));await turn();}
  await hello();
  const posts=()=>requests.filter(r=>r.method==='POST');
  async function timeout(t:any){t.mock.timers.enable({apis:['setTimeout']});const wait=client.finishSession('COMPLETED');await turn();t.mock.timers.tick(5000);await wait;await turn();}
  return {client,b,sockets,receive,hello,posts,requests,timeout,setReport:(r:Wire.Report|null)=>{getReport=r;},hold:(fn:(()=>Promise<Response>)|null)=>{holdSession=fn;}};
}

test('FINISH UNKNOWN: 404 is not failure; matching durable WS+GET+FINISHED clears only this notice without POST replay',async t=>{
  const f=await unit();t.after(()=>f.client.close());await f.timeout(t);
  assert.match(f.client.getState().connectionError!,/nieznany/i);assert.equal(f.client.getState().report,null);
  assert.equal(f.posts().length,1);assert.equal(f.requests.filter(r=>r.path.includes('/report?')).length,1,'initial read can be 404');
  await f.client.finishSession('ABANDONED');assert.equal(f.posts().length,1,'opposite/repeated click cannot replace unknown request');
  const r=report();f.setReport(r);f.receive('SESSION_REPORT',r);await turn();
  assert.match(f.client.getState().connectionError!,/nieznany/i,'durable report without FINISHED is not enough');
  f.b.session.lifecycle='FINISHED';f.receive('SESSION_STATE',structuredClone(f.b.session));await turn();await turn();
  assert.equal(f.client.getState().connectionError,null);assert.equal(f.client.getState().report?.status,'PENDING','finish is durable before generation READY');
  assert.equal(f.posts().length,1);assert.ok(f.requests.every(r=>r.auth==='Bearer unit-token'));
  assert.equal(f.posts()[0].body.sessionId,'finish-session');assert.equal(f.posts()[0].body.expectedWorkspaceVersion,1);assert.ok(f.posts()[0].body.requestId);
});

test('FINISH UNKNOWN: alien payload, wrong source version/reason/report identity and GET session cannot reconcile',async t=>{
  const f=await unit();t.after(()=>f.client.close());await f.timeout(t);f.b.session.lifecycle='FINISHED';
  f.setReport(report());f.receive('SESSION_REPORT',report('alien'));await turn();
  assert.equal(f.client.getState().report,null,'payload.sessionId must match envelope/current session');
  for(const wrong of [{...report(),sourceWorkspaceVersion:2},{...report(),reason:'ABANDONED' as const}]){
    f.receive('SESSION_REPORT',wrong);await turn();assert.match(f.client.getState().connectionError!,/nieznany/i);
  }
  f.setReport({...report(),reportId:'alien-id'});f.receive('SESSION_REPORT',report());await turn();await turn();
  assert.match(f.client.getState().connectionError!,/nieznany/i,'GET identity differs from WS');
  f.setReport(report());f.hold(async()=>new Response(JSON.stringify({...f.b.session,sessionId:'alien'})));
  f.receive('SESSION_REPORT',report());await turn();await turn();assert.match(f.client.getState().connectionError!,/nieznany/i);
  f.hold(null);f.b.session.workspaceVersion=2;f.receive('SESSION_REPORT',report());await turn();await turn();
  assert.match(f.client.getState().connectionError!,/nieznany/i,'GET session version differs from final material');
  f.b.session.workspaceVersion=1;f.receive('SESSION_REPORT',report());await turn();await turn();assert.equal(f.client.getState().connectionError,null);
  assert.equal(f.posts().length,1);
});

test('FINISH UNKNOWN: valid reconciliation does not clear another error or unresolved Proposal UNKNOWN',async t=>{
  const f=await unit();t.after(()=>f.client.close());await f.timeout(t);
  f.receive('ERROR',{code:'OTHER_FAILURE',message:'independent',retryable:false,requestId:null,currentVersion:null});
  f.b.session.lifecycle='FINISHED';f.setReport(report());f.receive('SESSION_REPORT',report());await turn();await turn();
  assert.match(f.client.getState().connectionError!,/OTHER_FAILURE/);assert.equal(f.posts().length,1);
  const g=await unit();t.after(()=>g.client.close());
  // Same test clock; only start the second HTTP request after unit's real setup.
  const wait=g.client.finishSession('COMPLETED');await turn();t.mock.timers.tick(5000);await wait;await turn();
  const p:Wire.Proposal={proposalId:'proposal',kind:'FINISH_EXERCISE',questionText:'Finish?',yesLabel:'yes',noLabel:'no',basedOnWorkspaceVersion:1,expiresAt:new Date(Date.now()+60000).toISOString(),paths:[],snapshotId:null,resetTimer:false};
  g.receive('ACTION_PROPOSAL',p);const decision=g.client.respondToProposal(p.proposalId,false);await turn();t.mock.timers.tick(5000);await decision;
  const proposalNotice=g.client.getState().connectionError;assert.match(proposalNotice!,/ACK decyzji/);
  g.b.session.lifecycle='FINISHED';g.setReport(report());g.receive('SESSION_REPORT',report());await turn();await turn();
  assert.equal(g.client.getState().connectionError,proposalNotice);assert.equal(g.posts().length,1);
});

test('FINISH UNKNOWN: same-session reconnect reads only; changed session keeps historical UNKNOWN even with stale in-flight GET',async t=>{
  const f=await unit();t.after(()=>f.client.close());await f.timeout(t);
  f.sockets.at(-1)!.close();await f.hello();assert.match(f.client.getState().connectionError!,/nieznany/i);assert.equal(f.posts().length,1);
  let release!:(r:Response)=>void;f.hold(()=>new Promise(resolve=>{release=resolve;}));
  f.setReport(report());f.receive('SESSION_REPORT',report());await turn();assert.ok(release);
  f.hold(null);f.sockets.at(-1)!.close();f.b.session.sessionId=f.b.project.sessionId='new-session';await f.hello();
  release(new Response(JSON.stringify({...f.b.session,sessionId:'finish-session',lifecycle:'FINISHED'})));await turn();await turn();
  assert.match(f.client.getState().connectionError!,/SESSION_REPLACED.*nieznany/i);assert.equal(f.posts().length,1);
  f.receive('SESSION_REPORT',report('new-session'));await turn();assert.match(f.client.getState().connectionError!,/SESSION_REPLACED/);
  await f.client.finishSession('COMPLETED');assert.equal(f.posts().length,1,'no replay after replacement');
});

test('FINISH UNKNOWN: later READY during GET is not regressed to PENDING and no read polling loop occurs',async t=>{
  const f=await unit();t.after(()=>f.client.close());await f.timeout(t);
  let release!:(r:Response)=>void;f.hold(()=>new Promise(resolve=>{release=resolve;}));
  f.setReport(report());f.receive('SESSION_REPORT',report());await turn();assert.ok(release);
  f.receive('SESSION_REPORT',{...report(),status:'READY',markdown:'finished'});
  release(new Response(JSON.stringify({...f.b.session,lifecycle:'FINISHED'})));await turn();await turn();
  assert.equal(f.client.getState().report?.status,'READY');assert.equal(f.client.getState().connectionError,null);
  const reads=f.requests.length;await turn();await turn();assert.equal(f.requests.length,reads);assert.equal(f.posts().length,1);
});

test('FINISH UNKNOWN: resolving Proposal success first cannot pin a copied finish notice',async t=>{
  const f=await unit();t.after(()=>f.client.close());await f.timeout(t);
  f.receive('ACTION_PROPOSAL',{proposalId:'p',kind:'FINISH_EXERCISE',questionText:'Finish?',yesLabel:'yes',noLabel:'no',basedOnWorkspaceVersion:1,expiresAt:new Date(Date.now()+60000).toISOString(),paths:[],snapshotId:null,resetTimer:false});
  const decision=f.client.respondToProposal('p',false);await turn();
  const wire=JSON.parse(f.sockets.at(-1)!.sent.find(raw=>JSON.parse(raw).type==='PROPOSAL_RESPONSE')!);
  f.receive('ACK',{replyTo:wire.messageId,status:'OK',documentVersion:null,workspaceVersion:1,controlEpoch:1,error:null});await decision;
  f.b.session.lifecycle='FINISHED';f.setReport(report());f.receive('SESSION_REPORT',report());await turn();await turn();
  assert.equal(f.client.getState().connectionError,null);await f.hello();assert.equal(f.client.getState().connectionError,null);assert.equal(f.posts().length,1);
});

test('FINISH UNKNOWN: close ignores a read completing after disposal',async t=>{
  const f=await unit();await f.timeout(t);
  let release!:(r:Response)=>void;f.hold(()=>new Promise(resolve=>{release=resolve;}));f.setReport(report());f.receive('SESSION_REPORT',report());await turn();
  f.client.close();const before=f.client.getState().connectionError;release(new Response(JSON.stringify({...f.b.session,lifecycle:'FINISHED'})));await turn();await turn();
  assert.equal(f.client.getState().connectionError,before);assert.equal(f.posts().length,1);
});

async function until<T>(read:()=>T,valid:(v:T)=>boolean,label:string){const end=Date.now()+12000;do{const v=read();if(valid(v))return v;await delay(10);}while(Date.now()<end);assert.fail('Timeout: '+label);}
const serverRoot=process.env.PAIRCOACH_FINISH_SERVER_ROOT??fileURLToPath(new URL('../../',import.meta.url));
test('REAL FINISH separate process: 6500ms capture, original 5s UNKNOWN, durable READY+FINISHED, one POST and one final snapshot', {timeout:25000},async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'p2-finish-')),root=path.join(dir,'workspace'),data=path.join(root,'.paircoach');fs.mkdirSync(root);
  fs.writeFileSync(path.join(root,'main.py'),'FROZEN FINAL\n');fs.writeFileSync(path.join(root,'challenge.md'),'# Exercise\n');
  const token='fixture-'+crypto.randomUUID(),messages:any[]=[],frames:any[]=[],requests:any[]=[],errors:string[]=[];
  const script=`import {createPairCoachServer} from ${JSON.stringify(pathToFileURL(path.join(serverRoot,'src/server/http.ts')).href)};
    const app=createPairCoachServer({rootPath:${JSON.stringify(root)},dataDir:${JSON.stringify(data)},token:${JSON.stringify(token)},port:0,enableCoach:false,enableExecution:true});
    const port=await app.listen();
    let delayed=false;app.workspace.on('snapshotCheckpoint',e=>{if(e.phase!=='SNAPSHOT_FILE_CAPTURED'||delayed)return;delayed=true;
      let captureReadCode='NO_GUARD';
      try{app.workspace.listSnapshots();}catch(error){captureReadCode=error.code;}
      process.send({phase:'CAPTURE_PENDING',lifecycle:app.session.state.lifecycle,captureReadCode});
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,6500);});
    process.send({port,sessionId:app.session.state.sessionId});`;
  const child=spawn(process.execPath,['--import','tsx','--input-type=module','--eval',script],{cwd:serverRoot,stdio:['ignore','pipe','pipe','ipc']});
  child.on('message',m=>messages.push(m));let stderr='';child.stderr!.on('data',c=>stderr+=c);let client:LiveBackend|undefined;
  t.after(async()=>{
    client?.close();if(process.env.PAIRCOACH_FINISH_EVIDENCE_DIR){fs.mkdirSync(process.env.PAIRCOACH_FINISH_EVIDENCE_DIR,{recursive:true});fs.writeFileSync(path.join(process.env.PAIRCOACH_FINISH_EVIDENCE_DIR,'transport.json'),JSON.stringify({serverRoot,messages,frames,requests,errors,finalError:client?.getState().connectionError,stderr},null,2));}
    if(child.exitCode===null&&child.signalCode===null){const exit=once(child,'exit');child.kill('SIGKILL');await exit;}fs.rmSync(dir,{recursive:true,force:true});
  });
  const ready=await until<any>(()=>messages.find(m=>m.port),Boolean,'server ready '+stderr),baseUrl=`http://127.0.0.1:${ready.port}`;
  client=new LiveBackend({baseUrl,token,clientId:crypto.randomUUID(),fetch:async(url,opts)=>{
    const r={path:new URL(String(url)).pathname+new URL(String(url)).search,method:opts?.method??'GET',body:opts?.body?JSON.parse(String(opts.body)):null,authorized:new Headers(opts?.headers).get('Authorization')===`Bearer ${token}`,status:null as number|null};requests.push(r);
    const response=await fetch(url,opts);r.status=response.status;return response;
  },socket:url=>{
    const ws=new WebSocket(url),proxy={get readyState(){return ws.readyState;},send:(raw:string)=>ws.send(raw),close:()=>ws.close(),onopen:null as any,onmessage:null as any,onerror:null as any,onclose:null as any};
    ws.addEventListener('open',e=>proxy.onopen?.(e));ws.addEventListener('message',e=>{frames.push(JSON.parse(String(e.data)));proxy.onmessage?.(e);});ws.addEventListener('error',e=>proxy.onerror?.(e));ws.addEventListener('close',e=>proxy.onclose?.(e));return proxy;
  }});
  client.subscribe('state',s=>{if(s.connectionError)errors.push(s.connectionError);});await client.connect();await until(()=>client!.getState().isOffline,v=>!v,'sync');
  const started=performance.now();await client.finishSession('COMPLETED');const deadline=performance.now()-started;
  assert.match(client.getState().connectionError!,/nieznany/i);assert.equal(client.getState().report,null);assert.equal(frames.some(m=>m.type==='SESSION_REPORT'),false);
  const pending=messages.find(m=>m.phase==='CAPTURE_PENDING');assert.equal(pending.lifecycle,'READY');assert.equal(pending.captureReadCode,'WORKSPACE_BUSY');
  await client.finishSession('ABANDONED');
  await until(()=>client!.getState().report,r=>r?.status==='READY','report READY');await until(()=>client!.getState().connectionError,e=>e===null,'UNKNOWN reconciled');
  const headers={Authorization:`Bearer ${token}`},session=await fetch(baseUrl+'/api/session',{headers}).then(r=>r.json()),durable=await fetch(baseUrl+`/api/session/report?sessionId=${ready.sessionId}`,{headers}).then(r=>r.json()),snapshots=await fetch(baseUrl+'/api/snapshots',{headers}).then(r=>r.json());
  assert.equal(session.lifecycle,'FINISHED');assert.equal(durable.sessionId,ready.sessionId);assert.equal(durable.sourceWorkspaceVersion,session.workspaceVersion);
  assert.equal(snapshots.length,1);assert.equal(snapshots[0].snapshotId,durable.snapshotId);assert.equal(fs.readFileSync(path.join(root,'main.py'),'utf8'),'FROZEN FINAL\n');
  assert.equal(requests.filter(r=>r.method==='POST').length,1,'no retry finish/report or unrelated mutation');assert.ok(requests.every(r=>r.authorized));
  const reads=requests.filter(r=>r.path.includes('/api/session/report?'));assert.ok(reads.length>=1,'authenticated report GET used');
  assert.ok(frames.some(m=>m.type==='SESSION_REPORT'&&m.payload.status==='PENDING'));assert.ok(errors.some(e=>/nieznany/i.test(e)));
  t.diagnostic(JSON.stringify({latencyInjectionMs:6500,clientDeadlineMs:Math.round(deadline),finishPosts:1,finalSnapshots:1,readRequests:reads.length,finalLifecycle:session.lifecycle,finalReport:durable.status,finalError:client.getState().connectionError}));
});
