/** NEW actual public consumer for K61cd06da's frozen-validator lost-create finding. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { httpNetworkFixture } from './http-network-fixture';
import { validateRunV2, validateMutationOutcomeV2, validateV2WireShape } from '../../src/shared/validation-v2';
test('UNIT actual HTTP lost create preserves original QUEUED and retained owner, canonical uncertain DTO across current/reconcile/WS, no duplicate start',async t=>{
  const f=await httpNetworkFixture(t),a=f.app(),port=await a.listen(),p=(await f.http(port,'GET','/api/project')).body;await f.connect(port,p.sessionId);
  // The injected daemon commits create but both reply and subsequent readback are
  // unavailable. Production cannot infer absence or retry creation.
  f.fake.createThrowsAfterCommit=true;f.fake.beforeCreate=async()=>{f.fake.daemon=false;};
  const request=f.runRequest(p,'RUN_MAIN'),accepted=await f.http(port,'POST','/api/run',request);
  assert.equal(accepted.status,202,JSON.stringify(accepted));assert.ok(validateRunV2(accepted.body));assert.equal(accepted.body.status,'QUEUED');
  const current=(await f.http(port,'GET','/api/run/'+accepted.body.runId)).body;
  assert.ok(validateRunV2(current));assert.equal(current.status,'PROCESS_STOP_UNCONFIRMED');assert.equal(current.finishedAt,null);assert.equal(current.exitCode,null);
  assert.ok(current.processProblem);assert.equal(current.processProblem.code,'PROCESS_STOP_UNCONFIRMED');assert.match(current.processProblem.message,/RUN_START_UNCONFIRMED/);
  assert.equal(JSON.stringify(current.processProblem).includes(f.token),false);assert.equal(current.runId,accepted.body.runId);
  const outcome=await f.http(port,'POST','/api/runtime/mutation/reconcile',{mutation:{projectId:p.projectId,kind:'RUN',request}});
  assert.equal(outcome.status,200,JSON.stringify(outcome));assert.ok(validateMutationOutcomeV2(outcome.body));assert.deepEqual(outcome.body.result,accepted.body);assert.ok(outcome.body.current);assert.deepEqual(outcome.body.current.run,current);
  const reconnect=await f.connect(port,p.sessionId);assert.ok(validateV2WireShape('SessionBundle',reconnect.bundle));assert.deepEqual(reconnect.bundle.lastRun,current);
  assert.deepEqual((await f.http(port,'POST','/api/run',request)).body,accepted.body);assert.equal(f.fake.calls.filter(a=>a[0]==='create').length,1);assert.equal(f.fake.calls.filter(a=>a[0]==='rm').length,0);assert.equal(f.ai.length,0);
  // Exact-owner readback now proves a created-but-UNSTARTED container. Accepted
  // executor correctly refuses to invent exit/rm/start for this recovery state.
  // Exercise that negative shutdown explicitly, rather than fabricate a terminal cleanup.
  f.fake.daemon=true;f.fake.beforeCreate=undefined;
  const stopped=await f.http(port,'POST','/api/run/'+current.runId+'/stop',{requestId:'confirm-original-stop',clientId:'tab',sessionId:p.sessionId});
  assert.equal(stopped.status,503,JSON.stringify(stopped));assert.equal(stopped.body.code,'PROCESS_STOP_UNCONFIRMED');
  assert.equal(f.fake.calls.filter(a=>a[0]==='create').length,1);assert.equal(f.fake.calls.filter(a=>a[0]==='start').length,0);assert.equal(f.fake.calls.filter(a=>a[0]==='rm').length,0);
  f.expectUnconfirmedClose();
});
