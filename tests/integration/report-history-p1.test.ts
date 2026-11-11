import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createPairCoachServer } from '../../src/server/http';
import { Peer, workspaceFiles, id, settings } from '../qa/helpers';

const hash=(s:string)=>createHash('sha256').update(s).digest('hex');
async function fixture(t:TestContext) {
  const dirs=await workspaceFiles(t,{'main.ts':'const value=1;\n'}), token='history-'+id(),clientId=id();
  let app:ReturnType<typeof createPairCoachServer>, port:number, peer:Peer;
  const peers=new Set<Peer>();
  t.after(async()=>{for(const p of peers)p.close();try{await app?.close();}finally{await dirs.cleanup();}});
  async function start() {
    app=createPairCoachServer({...dirs,token,port:0,enableExecution:true,enableCoach:false});port=await app.listen();
    return connect();
  }
  async function connect() {
    const f={...dirs,app,token,port,clientId,sessionId:app.session.state.sessionId,peers,baseURL:`http://127.0.0.1:${port}`};
    peer=new Peer(f as any);return peer.connect();
  }
  async function http(method:string,target:string,body?:unknown,authorized=true) {
    const response=await fetch(`http://127.0.0.1:${port}`+target,{method,
      headers:{...(authorized?{Authorization:`Bearer ${token}`}:{ }),'Content-Type':'application/json'},
      body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(5000)});
    return {status:response.status,body:await response.json()};
  }
  async function ready(sessionId:string) {
    for(let i=0;i<100;i++) {
      const r=await http('GET','/api/session/report?sessionId='+sessionId);
      assert.equal(r.status,200);if(r.body.status!=='PENDING')return r.body;
      await new Promise(resolve=>setTimeout(resolve,5));
    }
    throw new Error('local report did not settle');
  }
  async function finish() {
    const sessionId=app.session.state.sessionId;
    const body={requestId:id(),clientId,sessionId,reason:'COMPLETED',expectedWorkspaceVersion:app.workspace.workspaceVersion};
    const pending=await http('POST','/api/session/finish',body);assert.equal(pending.status,202);
    const report=await ready(sessionId);assert.equal(report.status,'READY');
    return {report,body};
  }
  async function open(rootPath=dirs.rootPath) {
    const r=await http('POST','/api/project/open',{requestId:id(),clientId,rootPath,settings});assert.equal(r.status,201);
    await connect();return r.body;
  }
  await start();
  return {...dirs,get app(){return app;},get peer(){return peer;},http,ready,finish,open,start,connect};
}

test('real HTTP A→B→restart: immutable historical identity/facts, minimal listing, no historical WS/current overwrite', async t=>{
  const f=await fixture(t), first=await f.finish(), a=first.report;
  const aDir=path.join(f.app.workspace.dataDir,'reports',hash(a.sessionId)), facts=fs.readFileSync(path.join(aDir,'facts.json'),'utf8');
  await f.open();assert.notEqual(f.app.session.state.sessionId,a.sessionId);
  const {report:b,body:finishBody}=await f.finish();
  assert.deepEqual((await f.http('GET','/api/session/report?sessionId='+a.sessionId)).body,a);
  const listed=await f.http('GET','/api/session/reports');assert.equal(listed.status,200);
  assert.deepEqual(listed.body.reports.map((r:any)=>r.sessionId).sort(),[a.sessionId,b.sessionId].sort());
  for(const summary of listed.body.reports)assert.deepEqual(Object.keys(summary).sort(),['reportId','sessionId','status','reason','sourceWorkspaceVersion','snapshotId','generatedAt'].sort());
  assert.equal(JSON.stringify(listed.body).includes('markdown'),false);
  assert.equal((await f.connect()).payload.report.reportId,b.reportId);
  const duplicate=await f.http('POST','/api/session/finish',finishBody);assert.equal(duplicate.status,202);assert.equal(duplicate.body.reportId,b.reportId);
  assert.equal((await f.http('POST','/api/session/report/retry',{requestId:id(),clientId:finishBody.clientId,sessionId:a.sessionId})).status,409,'history read grants no old-session retry authority');
  await f.app.close();
  // Durable PENDING models restart interruption; not a claimed process-crash/OS-fault proof.
  const reportPath=path.join(aDir,'report.json'), interrupted={...a,status:'PENDING',generatedAt:null,markdown:null,error:null};
  fs.writeFileSync(reportPath,JSON.stringify(interrupted));
  await f.start();
  const response=await f.http('GET','/api/session/report?sessionId='+a.sessionId);
  assert.equal(response.status,200);assert.equal(response.body.reportId,a.reportId);
  assert.equal(response.body.snapshotId,a.snapshotId);assert.equal(response.body.status,'FAILED');assert.equal(response.body.error.code,'REPORT_INTERRUPTED');
  assert.equal((await f.http('GET','/api/session/reports')).body.reports.length,2);
  const ping=f.peer.send('PING',{lastAppliedSeq:0});await f.peer.ack(ping);
  assert.equal(f.peer.frames.some(m=>m.type==='SESSION_REPORT'),false,'historical interrupted load never publishes in the current envelope');
  assert.equal((await f.connect()).payload.report,null,'history load must not set current bundle report');
  assert.equal(fs.readFileSync(path.join(aDir,'facts.json'),'utf8'),facts);
  f.peer.assertProtocol();
});

test('HTTP history is bearer-authenticated/current-project only; invalid IDs, foreign facts and symlinks cannot leak',async t=>{
  const f=await fixture(t),{report:a}=await f.finish();
  const oldDir=path.join(f.app.workspace.dataDir,'reports',hash(a.sessionId));
  for(const target of ['/api/session/reports','/api/session/report?sessionId='+a.sessionId])assert.equal((await f.http('GET',target,undefined,false)).status,401);
  for(const suffix of ['', '?sessionId=', '?sessionId=..%2Fprivate', '?sessionId=%2Fabsolute'])assert.equal((await f.http('GET','/api/session/report'+suffix)).status,400);
  const otherRoot=path.join(f.base,'other-project');fs.mkdirSync(otherRoot);fs.writeFileSync(path.join(otherRoot,'challenge.md'),'other');
  await f.open(otherRoot);
  assert.equal((await f.http('GET','/api/session/report?sessionId='+a.sessionId)).status,404);
  assert.deepEqual((await f.http('GET','/api/session/reports')).body,{reports:[]});
  const foreignDir=path.join(f.app.workspace.dataDir,'reports',hash(a.sessionId));fs.cpSync(oldDir,foreignDir,{recursive:true});
  const foreign=await f.http('GET','/api/session/report?sessionId='+a.sessionId);
  assert.equal(foreign.status,404);assert.equal(foreign.body.code,'REPORT_NOT_FOUND');
  assert.deepEqual((await f.http('GET','/api/session/reports')).body,{reports:[]});
  fs.rmSync(foreignDir,{recursive:true});fs.symlinkSync(oldDir,foreignDir,'dir');
  const escaped=await f.http('GET','/api/session/report?sessionId='+a.sessionId);
  assert.equal(escaped.status,403);assert.equal(escaped.body.code,'UNSAFE_REPORT_STORAGE');
  assert.deepEqual((await f.http('GET','/api/session/reports')).body,{reports:[]});
  assert.equal((await f.connect()).payload.report,null);
  assert.equal(JSON.stringify(foreign.body).includes(a.markdown),false);
});
