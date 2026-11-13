/** Real HTTP/WS/neutral Runner; controlled Docker exit boundary, not native runtime proof. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { httpRunFixture, until } from '../backend-cutover/http-run-report-fixture';
import { id } from '../qa/helpers';

for (const exitCode of [0, 1]) {
  test(`completed Run with exit ${exitCode} preserves wire ordering and subsequent settings access`, async t => {
    const f=await httpRunFixture(t),app=f.app(),port=await app.listen();
    const project=(await f.http(port,'GET','/api/project?readiness=actual')).body;
    const peer=await f.connect(port,project.sessionId),clientId='tab',sessionId=project.sessionId;
    const command=()=>({requestId:id(),clientId,sessionId});
    const start=await f.http(port,'POST','/api/session/start',{...command(),limitMs:null,pauseOnHidden:true});
    assert.equal(start.status,200);
    const accepted=await f.http(port,'POST','/api/run',f.runRequest(project,'RUN_MAIN'));
    assert.equal(accepted.status,202,JSON.stringify(accepted));
    const runId=accepted.body.runId;
    f.fake.finish(exitCode);
    await until(()=>peer.frames.some(frame=>frame.type==='RUN_STATE'&&frame.payload.runId===runId&&frame.payload.finishedAt));
    await delay(10);
    const terminal=peer.frames.find(frame=>frame.type==='RUN_STATE'&&frame.payload.runId===runId&&frame.payload.finishedAt).payload;
    assert.equal(terminal.exitCode,exitCode);assert.equal(terminal.status,exitCode===0?'SUCCEEDED':'FAILED');
    const sequences=peer.frames.map(frame=>frame.seq);
    for(let index=1;index<sequences.length;index++)assert.equal(sequences[index],sequences[index-1]+1);
    assert.equal(app.session.leaseClientId,clientId);
    const update=await f.http(port,'PUT','/api/project/settings',{...command(),expectedWorkspaceVersion:app.workspace.workspaceVersion,settings:f.settings});
    assert.equal(update.status,200);
  });
}
