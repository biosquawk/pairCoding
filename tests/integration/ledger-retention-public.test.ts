/** Real authenticated REST + WS, no substitute gate/ledger. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { serverFixture, connected, Peer, id, settings } from '../qa/helpers';
const rejected=(a:any,code:string)=>{assert.equal(a.payload.status,'REJECTED');assert.equal(a.payload.error.code,code);};

test('ledger REST/WS: concurrent CODE_CHANGED, failed replay, conflicts, cross-transport veto once',async t=>{
  const f=await serverFixture(t,{'solution.js':'start\n'}),p=await connected(t,f);
  const initial=(await f.http('GET','/api/file?path=solution.js')).body;
  const body={path:'solution.js',baseVersion:initial.version,controlEpoch:f.state.controlEpoch,content:'after\n',editKind:'TYPING'};
  const key=id();p.send('CODE_CHANGED',body,key);p.send('CODE_CHANGED',body,key);
  const a=await p.ack(key),b=await p.ack(key);
  assert.deepEqual([a.payload.status,b.payload.status].sort(),['DUPLICATE','OK']);
  assert.equal(a.payload.documentVersion,b.payload.documentVersion);
  assert.equal((await f.http('GET','/api/file?path=solution.js')).body.version,initial.version+1);
  p.send('CODE_CHANGED',{...body,content:'wrong\n'},key);rejected(await p.ack(key),'IDEMPOTENCY_CONFLICT');
  const bad=id();p.send('CODE_CHANGED',{...body,baseVersion:initial.version+2},bad);
  const failure=await p.ack(bad);assert.equal(failure.payload.status,'REJECTED');
  const next={...body,baseVersion:initial.version+1,content:'second\n'};
  assert.equal((await p.ack(p.send('CODE_CHANGED',next))).payload.status,'OK');
  p.send('CODE_CHANGED',{...body,baseVersion:initial.version+2},bad);
  const replay=await p.ack(bad);assert.equal(replay.payload.status,'REJECTED');assert.deepEqual(replay.payload.error,failure.payload.error);
  assert.equal((await f.http('GET','/api/file?path=solution.js')).body.content,'second\n');
  const state=(await f.http('GET','/api/session')).body,veto=id();
  const payload={controlEpoch:state.controlEpoch,activeInterventionId:null,lastAppliedSeq:0};
  p.send('VETO_ESCAPE',payload,veto);
  const rest=await f.http('POST','/api/session/veto',{requestId:veto,clientId:f.clientId,sessionId:f.sessionId,...payload});
  const va=await p.ack(veto);assert.equal(rest.status,200);assert.equal(va.payload.status,'OK');
  assert.equal((await f.http('GET','/api/session')).body.controlEpoch,state.controlEpoch+1);
  const stale=p.send('CODE_CHANGED',{...body,baseVersion:initial.version+2,content:'stale-epoch\n'});
  assert.equal((await p.ack(stale)).payload.status,'REJECTED');
  assert.equal((await f.http('GET','/api/file?path=solution.js')).body.content,'second\n');p.assertProtocol();
});

test('ledger REST/WS: 1100 autosaves with PING and view history do not hit an arbitrary 500/1000 cutoff',{timeout:20000},async t=>{
  const f=await serverFixture(t,{'solution.js':'start\n'}),p=await connected(t,f);
  let version=(await f.http('GET','/api/file?path=solution.js')).body.version;
  const firstKey=id(),first={path:'solution.js',baseVersion:version,controlEpoch:f.state.controlEpoch,content:'edit0\n',editKind:'TYPING'};
  for(let i=0;i<1100;i++) {
    // Respect WS1000/s: no more than 600 commands per batch; pauses are rate pacing, not an oracle.
    if(i&&i%200===0)await new Promise(r=>setTimeout(r,1100));
    const ack=await p.ack(p.send('CODE_CHANGED',{...first,baseVersion:version,content:`edit${i}\n`},i===0?firstKey:id()));
    assert.equal(ack.payload.status,'OK',`autosave ${i}: ${JSON.stringify(ack.payload)}`);version++;
    assert.equal(ack.payload.documentVersion,version);
    assert.equal((await p.ack(p.send('PING',{lastAppliedSeq:0}))).payload.status,'OK');
    assert.equal((await p.ack(p.send('VIEW_CHANGED',{path:'solution.js',documentVersion:version,cursor:null,selection:null}))).payload.status,'OK');
  }
  p.send('CODE_CHANGED',first,firstKey);assert.equal((await p.ack(firstKey)).payload.status,'DUPLICATE');
  const final=(await f.http('GET','/api/file?path=solution.js')).body;
  assert.equal(final.content,'edit1099\n');assert.equal(final.version,version);p.assertProtocol();
});

test('ledger project/open lifecycle: old open replay cannot rebind project and old-session mutation cannot execute',async t=>{
  const f=await serverFixture(t,{'solution.js':'original\n'}),p=await connected(t,f);
  const roots=[path.join(f.base,'project-A'),path.join(f.base,'project-B')];
  for(const root of roots){await fs.mkdir(root);await fs.writeFile(path.join(root,'challenge.md'),'task\n');await fs.writeFile(path.join(root,'solution.js'),path.basename(root)+'\n');}
  const body={requestId:id(),clientId:f.clientId,rootPath:roots[0],settings};
  assert.equal((await f.http('POST','/api/project/open',body)).status,201);
  const projectA=await f.http('GET','/api/project');assert.notEqual(projectA.body.sessionId,f.sessionId);
  assert.equal((await f.http('POST','/api/project/open',{...body,requestId:id(),rootPath:roots[1]})).status,201);
  const projectB=(await f.http('GET','/api/project')).body;
  const replay=await f.http('POST','/api/project/open',body);
  assert(replay.status===201||replay.status===409,'old open recognized or explicitly rejected');
  assert.equal((await f.http('GET','/api/project')).body.sessionId,projectB.sessionId,'old open must never repeat its effect');
  assert.equal((await f.http('GET','/api/file?path=solution.js')).body.content,'project-B\n');
  assert.equal((await f.http('POST','/api/session/start',{requestId:id(),clientId:f.clientId,sessionId:f.sessionId,limitMs:60000,pauseOnHidden:true})).status,409);
  p.close();const np=new Peer({...f,sessionId:projectB.sessionId});await np.connect();
  const doc=(await f.http('GET','/api/file?path=solution.js')).body,state=(await f.http('GET','/api/session')).body;
  assert.equal((await np.ack(np.send('CODE_CHANGED',{path:'solution.js',baseVersion:doc.version,controlEpoch:state.controlEpoch,content:'new-scope\n',editKind:'TYPING'}))).payload.status,'OK');
  assert.equal((await f.http('GET','/api/file?path=solution.js')).body.content,'new-scope\n');np.assertProtocol();
});

for(const accepted of [false,true])test(`ledger proposal decision: concurrent ${accepted?'accept':'decline'}, new message duplicate and conflicting response`,async t=>{
  const f=await serverFixture(t,{'solution.js':'snapshot\n'}),p=await connected(t,f);
  const source=await f.app.workspace.createSnapshotAsync('independent source',['solution.js']);
  const doc=(await f.http('GET','/api/file?path=solution.js')).body;
  assert.equal((await p.ack(p.send('CODE_CHANGED',{path:'solution.js',baseVersion:doc.version,controlEpoch:f.state.controlEpoch,content:'work\n',editKind:'TYPING'}))).payload.status,'OK');
  assert.equal((await p.ack(p.send('PROPOSAL_REQUEST',{kind:'RESTORE_SNAPSHOT',snapshotId:source.snapshotId}))).payload.status,'OK');
  const proposal=(await p.take(m=>m.type==='ACTION_PROPOSAL')).payload;
  const response={proposalId:proposal.proposalId,accepted,basedOnWorkspaceVersion:proposal.basedOnWorkspaceVersion};
  const first=p.send('PROPOSAL_RESPONSE',response),second=p.send('PROPOSAL_RESPONSE',response);
  const replies=await Promise.all([p.ack(first),p.ack(second)]);
  assert.deepEqual(replies.map(a=>a.payload.status).sort(),['DUPLICATE','OK']);
  assert.equal((await p.ack(p.send('PROPOSAL_RESPONSE',response))).payload.status,'DUPLICATE');
  rejected(await p.ack(p.send('PROPOSAL_RESPONSE',{...response,accepted:!accepted})),'IDEMPOTENCY_CONFLICT');
  assert.equal((await f.http('GET','/api/snapshots')).body.length,accepted?2:1,'one effect only, never two backups');
  assert.equal((await f.http('GET','/api/file?path=solution.js')).body.content,accepted?'snapshot\n':'work\n');
  assert.equal((await f.http('GET','/api/session')).status,200);p.assertProtocol();
});

test('ledger proposal rejected outcome remains rejected with a new messageId',async t=>{
  const f=await serverFixture(t),p=await connected(t,f);
  const response={proposalId:id(),accepted:true,basedOnWorkspaceVersion:0};
  const a=await p.ack(p.send('PROPOSAL_RESPONSE',response)),b=await p.ack(p.send('PROPOSAL_RESPONSE',response));
  rejected(a,'STALE_PROPOSAL');rejected(b,'STALE_PROPOSAL');
  assert.deepEqual({...b.payload.error,requestId:null},{...a.payload.error,requestId:null});
  rejected(await p.ack(p.send('PROPOSAL_RESPONSE',{...response,accepted:false})),'IDEMPOTENCY_CONFLICT');p.assertProtocol();
});
