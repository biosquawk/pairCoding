/** Real HTTP/WS/WriteGate/immutable Run capture; Docker alone is controlled. */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {httpRunFixture} from '../backend-cutover/http-run-report-fixture';
async function until(predicate:()=>boolean){const end=Date.now()+10000;while(!predicate()){if(Date.now()>end)throw Error('Expected correlated transition');await delay(10);}}
test('one ACK-bound Run capture and concurrent editor view settle without a stale WORKSPACE_BUSY banner or duplicate Run',{timeout:60000},async t=>{
  const f=await httpRunFixture(t,{server:{enableCoach:false}}),app=f.app(),port=await app.listen();
  const http=async(method:string,url:string,body?:unknown)=>{
    const response=await fetch(`http://127.0.0.1:${port}${url}`,{method,headers:{Authorization:`Bearer ${f.token}`,'Content-Type':'application/json'},signal:AbortSignal.timeout(10000),body:body===undefined?undefined:JSON.stringify(body)});
    return {status:response.status,body:await response.json()};
  };
  const initial=(await http('GET','/api/project')).body,peer=await f.connect(port,initial.sessionId);
  const doc=(await http('GET','/api/file?path=main.js')).body;
  const save=peer.send('CODE_CHANGED',{path:'main.js',content:'console.log("ACKED");\n',editKind:'TYPING',baseVersion:doc.version,controlEpoch:app.session.state.controlEpoch});
  await until(()=>peer.frames.some(m=>m.type==='ACK'&&m.payload.replyTo===save));
  const ack=peer.frames.find(m=>m.type==='ACK'&&m.payload.replyTo===save).payload;
  assert.equal(ack.status,'OK');
  const project=(await http('GET','/api/project')).body,request=f.runRequest(project,'RUN_MAIN');
  assert.equal(request.expectedWorkspaceVersion,ack.workspaceVersion);
  f.fake.onStart=async()=>{f.fake.finish(0);};
  const original=app.workspace._settledRunInput.bind(app.workspace);
  let entered=false,release!:()=>void;
  const barrier=new Promise<void>(resolve=>{release=resolve;});t.after(()=>release());
  app.workspace._settledRunInput=async(...args:Parameters<typeof original>)=>{entered=true;await barrier;return original(...args);};
  const run=http('POST','/api/run',request);
  try {
    await until(()=>entered);
    assert.throws(()=>app.gate.write({actor:'STUDENT',clientId:'tab',sessionId:project.sessionId,controlEpoch:app.session.state.controlEpoch,path:'main.js',baseVersion:ack.documentVersion,content:'MUST NOT COMMIT'}),{code:'WORKSPACE_BUSY'});
    const read=await http('GET','/api/file?path=main.js');
    assert.equal(read.status,409);assert.equal(read.body.code,'WORKSPACE_BUSY','public direct reads remain fail-closed during held capture');
    const viewId=peer.send('VIEW_CHANGED',{path:'main.js',documentVersion:ack.documentVersion,cursor:null,selection:null});
    // PING acknowledges receipt ordering without requiring the queued read to finish.
    const ping=peer.send('PING',{lastAppliedSeq:0});await until(()=>peer.frames.some(m=>m.type==='ACK'&&m.payload.replyTo===ping));
    release();
    const accepted=await run;assert.equal(accepted.status,202,JSON.stringify(accepted));
    await until(()=>peer.frames.some(m=>m.type==='ACK'&&m.payload.replyTo===viewId));
    const viewAck=peer.frames.find(m=>m.type==='ACK'&&m.payload.replyTo===viewId).payload;
    assert.equal(viewAck.status,'OK',JSON.stringify({requestId:request.requestId,runId:accepted.body.runId,viewId,viewAck}));
    assert.equal(viewAck.documentVersion,ack.documentVersion);
    assert.equal(peer.frames.some(m=>m.type==='ERROR'&&m.payload.code==='WORKSPACE_BUSY'),false);
    const replay=await http('POST','/api/run',request);assert.equal(replay.status,202);assert.deepEqual(replay.body,accepted.body);
    await until(()=>peer.frames.some(m=>m.type==='RUN_STATE'&&m.payload.runId===accepted.body.runId&&m.payload.finishedAt));
    const terminal=peer.frames.filter(m=>m.type==='RUN_STATE'&&m.payload.runId===accepted.body.runId).at(-1).payload;
    assert.equal(terminal.status,'SUCCEEDED');assert.equal(terminal.workspaceVersionAtStart,ack.workspaceVersion);
    assert.equal(f.fake.calls.filter(args=>args[0]==='create').length,1);
    console.log(JSON.stringify({saveRequestId:save,viewRequestId:viewId,requestId:request.requestId,runId:terminal.runId,viewAck:viewAck.status,terminal:terminal.status,creates:1}));
  } finally {release();await run;app.workspace._settledRunInput=original;}
});
