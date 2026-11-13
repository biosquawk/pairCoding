/** Exact P1 async core + real public REST/WS. No Promise mock, sleep injection,
 * fake filesystem or provider call. 100 files exercise real macrotask yields;
 * these are correctness checks, NOT Windows/AC027 latency benchmarks. */
import test, {type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createPairCoachServer} from '../../src/server/http';
import {Peer, workspaceFiles, id} from '../qa/helpers';

async function fixture(t:TestContext) {
  const files=Object.fromEntries(Array.from({length:100},(_,i)=>[`f${i}.ts`,`SOURCE ${i}\n`]));
  const dirs=await workspaceFiles(t,files),token='async-public-'+id();
  const app=createPairCoachServer({...dirs,token,port:0,enableExecution:true,enableCoach:false});
  const port=await app.listen(),baseURL=`http://127.0.0.1:${port}`,clientId=id(),sessionId=app.session.state.sessionId;
  const peers=new Set<{close():void}>();
  t.after(async()=>{for(const p of peers)p.close();try{await app.close();}finally{await dirs.cleanup();}});
  async function http(method:string,url:string,body?:unknown) {
    const r=await fetch(baseURL+url,{method,headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},
      body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(10000)});
    return {status:r.status,body:await r.json()};
  }
  const f={...dirs,app,token,port,baseURL,clientId,sessionId,peers,http,files};
  const peer=new Peer(f as any);await peer.connect();
  return {...f,peer,command:()=>({requestId:id(),clientId,sessionId})};
}

for(const revoke of [false,true])test(`G3 real async public restore: ${revoke?'VETO during forward rolls back':'success'}; busy reads, live PING, one backup and terminal snapshot/ACK`,{timeout:40000},async t=>{
  const f=await fixture(t),paths=Object.keys(f.files);
  const source=await f.app.workspace.createSnapshotAsync('Source',paths);
  for(const p of paths)fs.writeFileSync(path.join(f.rootPath,p),'WORK '+p);
  f.app.workspace.scanExternal();
  await f.peer.ack(f.peer.send('PROPOSAL_REQUEST',{kind:'RESTORE_SNAPSHOT',snapshotId:source.snapshotId}));
  const proposal=(await f.peer.take(m=>m.type==='ACTION_PROPOSAL')).payload;
  const payload={proposalId:proposal.proposalId,accepted:true,basedOnWorkspaceVersion:proposal.basedOnWorkspaceVersion};
  let probe:Promise<any>|undefined,cutoff=false,forwardAfterCutoff=0,settled=false,guardAtTerminal=false;
  f.app.session.on('veto',()=>{cutoff=true;});
  const epoch=f.app.session.state.controlEpoch;
  const original=id();
  f.app.workspace.on('snapshotCheckpoint',e=>{
    if(cutoff&&['CAPTURE_MOVE_RETURNED','PUBLISHED','COMMITTED'].includes(e.phase))forwardAfterCutoff++;
    if(['COMMITTED','ROLLED_BACK'].includes(e.phase)) {
      settled=true;
      try { f.app.workspace.getDocument(paths[0]); }
      catch(error) { guardAtTerminal=(error as {code?:string}).code==='WORKSPACE_BUSY'; }
      assert.equal(f.peer.frames.some(m=>m.type==='ACK'&&m.payload.replyTo===original),false,'no terminal ACK from a still-guarded transaction');
    }
    if(e.phase==='PUBLISHED'&&e.index===0&&!probe) {
      probe=(async()=>{
        // Both ledger keys must attach to the existing operation before BUSY checks.
        f.peer.send('PROPOSAL_RESPONSE',payload,original);
        const duplicate=f.peer.send('PROPOSAL_RESPONSE',payload);
        const ping=f.peer.send('PING',{lastAppliedSeq:0});
        const veto=revoke?f.peer.send('VETO_ESCAPE',{controlEpoch:epoch,activeInterventionId:null,lastAppliedSeq:0}):null;
        let pingBeforeSettlement=false;
        const [pingAck,busy,vetoAck]=await Promise.all([
          f.peer.ack(ping).then(ack=>{pingBeforeSettlement=!settled;return ack;}),f.http('GET','/api/file?path='+paths[0]),veto?f.peer.ack(veto):Promise.resolve(null),
        ]);
        assert.equal(pingAck.payload.status,'OK',JSON.stringify(pingAck.payload));
        assert.equal(busy.status,409);assert.equal(busy.body.code,'WORKSPACE_BUSY');
        if(vetoAck)assert.equal(vetoAck.payload.status,'OK',JSON.stringify(vetoAck.payload));
        return {duplicate,pingBeforeSettlement};
      })();
    }
  });
  f.peer.send('PROPOSAL_RESPONSE',payload,original);
  // Restore may cross the UI deadline while committing or rolling back 100 files.
  // Keep testing early PING and the terminal ACK without treating a 5s wait as cancellation.
  const ack=await f.peer.ack(original,30000);
  assert(probe,'real forward checkpoint reached');const observations=await probe;
  assert(observations.pingBeforeSettlement,'PING/VETO are serviced while actual core guard is held');
  assert(settled);assert(guardAtTerminal);assert.equal(forwardAfterCutoff,0);
  assert.equal(ack.payload.status,revoke?'REJECTED':'OK');
  if(revoke)assert.equal(ack.payload.error.code,'RESTORE_INCOMPLETE');
  const replay=await f.peer.ack(original),duplicate=await f.peer.ack(observations.duplicate);
  for(const a of [replay,duplicate]) {
    assert.equal(a.payload.status,revoke?'REJECTED':'DUPLICATE');
    assert.deepEqual(a.payload.error,revoke?{...ack.payload.error,requestId:a.payload.replyTo}:null);
  }
  const bundle=(await f.peer.take(m=>m.type==='SESSION_SNAPSHOT'&&m.payload.proposals.length===0&&m.payload.project.workspaceVersion>proposal.basedOnWorkspaceVersion)).payload;
  assert.equal(bundle.proposals.length,0);assert.equal(Object.hasOwn(bundle.project.capabilities,'docs'),false,'V2 omits retired legacy docs capability');assert.equal(bundle.project.capabilities.language.docs,'N/A');assert.equal(bundle.languageBootstrap.provider,'builtin');assert.equal(bundle.project.capabilities.language.profileId,bundle.project.capabilities.execution.runtime.profileId);
  const snapshots=(await f.http('GET','/api/snapshots')).body;assert.equal(snapshots.length,2);
  const backup=f.app.workspace.readSnapshot(snapshots.find((s:any)=>s.snapshotId!==source.snapshotId).snapshotId);
  assert.equal(backup.files.length,paths.length);
  for(const file of backup.files)assert.equal(Buffer.from(file.rawBase64!,'base64').toString(),'WORK '+file.path);
  for(const p of paths)assert.equal(fs.readFileSync(path.join(f.rootPath,p),'utf8'),revoke?'WORK '+p:f.files[p]);
  const document=f.app.workspace.getDocument(paths[0]);
  assert.equal((await f.peer.ack(f.peer.send('CODE_CHANGED',{path:paths[0],content:'AFTER',baseVersion:document.version,controlEpoch:f.app.session.state.controlEpoch,editKind:'TYPING'}))).payload.status,'OK');
  f.peer.assertProtocol();t.diagnostic(JSON.stringify({files:paths.length,revoke,guardAtTerminal,forwardAfterCutoff,pingBeforeSettlement:observations.pingBeforeSettlement,terminal:ack.payload.status,snapshots:snapshots.length}));
});

test('G3 real async public finish captures once: BUSY reads and responsive control precede durable report/FINISHED',{timeout:20000},async t=>{
  const f=await fixture(t),body={...f.command(),reason:'COMPLETED',expectedWorkspaceVersion:f.app.workspace.workspaceVersion};
  let probe:Promise<any>|undefined,captured=0;
  f.app.workspace.on('snapshotCheckpoint',e=>{
    if(e.phase!=='SNAPSHOT_FILE_CAPTURED')return;
    captured++;
    if(probe)return;
    probe=(async()=>{
      const ping=f.peer.send('PING',{lastAppliedSeq:0});
      const veto=f.peer.send('VETO_ESCAPE',{controlEpoch:f.app.session.state.controlEpoch,activeInterventionId:null,lastAppliedSeq:0});
      const hidden=f.peer.send('WINDOW_STATE',{presence:'HIDDEN'});
      const duplicate=f.http('POST','/api/session/finish',body);
      const [pingAck,vetoAck,hiddenAck,project,file,snapshots,session,report]=await Promise.all([
        f.peer.ack(ping),f.peer.ack(veto),f.peer.ack(hidden),f.http('GET','/api/project'),f.http('GET','/api/file?path=f0.ts'),f.http('GET','/api/snapshots'),f.http('GET','/api/session'),f.http('GET',`/api/session/report?sessionId=${f.sessionId}`),
      ]);
      for(const a of [pingAck,vetoAck,hiddenAck])assert.equal(a.payload.status,'OK',JSON.stringify(a.payload));
      assert.equal(project.status,409);assert.equal(project.body.code,'PROJECT_STATE_CHANGED');
      for(const r of [file,snapshots]){assert.equal(r.status,409);assert.equal(r.body.code,'WORKSPACE_BUSY');}
      assert.equal(session.body.lifecycle,'READY');assert.equal(report.status,404);
      assert.equal(f.peer.frames.some(m=>m.type==='SESSION_REPORT'),false,'no early report during real capture');
      return {duplicate};
    })();
  });
  const result=await f.http('POST','/api/session/finish',body);
  assert(probe);const observation=await probe;assert.deepEqual(await observation.duplicate,result);
  assert.equal(result.status,202);assert.equal(result.body.status,'PENDING');assert.equal(captured,101,'100 source files plus challenge, exactly one capture');
  const pending=await f.peer.take(m=>m.type==='SESSION_REPORT');assert.equal(pending.payload.status,'PENDING');
  assert.equal((await f.http('GET','/api/session')).body.lifecycle,'FINISHED');
  const snapshots=await f.http('GET','/api/snapshots');assert.equal(snapshots.status,200);assert.equal(snapshots.body.length,1);
  assert.equal(snapshots.body[0].snapshotId,result.body.snapshotId);
  const frozen=f.app.workspace.readSnapshot(result.body.snapshotId);
  for(const [p,content] of Object.entries(f.files))assert.equal(Buffer.from(frozen.files.find(file=>file.path===p)!.rawBase64!,'base64').toString(),content);
  const reportRoot=path.join(f.app.workspace.dataDir,'reports');
  assert(fs.readdirSync(reportRoot).some(dir=>fs.existsSync(path.join(reportRoot,dir,'facts.json'))));
  f.peer.assertProtocol();t.diagnostic(JSON.stringify({files:captured,captureCount:1,guardedReads:3,controls:3,firstReport:pending.payload.status,finalLifecycle:'FINISHED'}));
});
