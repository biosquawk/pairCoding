import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RuntimeClientV2, type RuntimeAuthorityV2 } from '../../src/services/RuntimeClientV2';
import { project, run, settings } from './fixtures';
const deferred = () => { let resolve!: (value: unknown) => void; const promise = new Promise<unknown>(r => resolve = r); return { promise, resolve }; };
function fixture() {
  const a: RuntimeAuthorityV2 = { projectId:'p1',sessionId:'s1',clientId:'client1',connectionGeneration:'conn1',workspaceVersion:1,configurationGeneration:'cfg1',connected:true,canExecute:true,canSaveSettings:true };
  const calls: string[] = []; let response: unknown = run(), failure: Error | null = new Error('response lost AFTER acceptance'), gate: ReturnType<typeof deferred> | null = null;
  let n = 0;
  const call = async (kind: string) => { calls.push(kind); if (gate) return gate.promise; if (failure) throw failure; return response; };
  const client = new RuntimeClientV2({ current: () => a, requestId: () => `r${++n}`, http: { run: () => call('RUN'), saveSettings: () => call('SAVE'), stop: () => call('STOP') } });
  assert.equal(client.applyProject(project()), true);
  return { client, a, calls, set response(value: unknown) { response = value; }, set failure(value: Error | null) { failure = value; }, set gate(value: ReturnType<typeof deferred> | null) { gate = value; } };
}
test('unknown Run fences immediate new Run and Save without readback (K counter)', async () => {
  const f = fixture(); assert.equal(await f.client.run('RUN_TESTS'), false);
  assert.equal(await f.client.run('RUN_TESTS'), false); assert.equal((await f.client.saveSettings(settings(),1)).ok, false);
  assert.deepEqual(f.calls, ['RUN']); assert.equal(f.client.snapshot().run, null); assert.equal(f.client.snapshot().reconciliationRequired, true);
});
test('unknown Save fences Save and Run and preserves original settings and human draft', async () => {
  const f = fixture(), draft = settings(); draft.aiConsent = true;
  assert.equal((await f.client.saveSettings(draft,1)).ok, false);
  assert.equal((await f.client.saveSettings(draft,1)).ok, false); assert.equal(await f.client.run('RUN_TESTS'), false);
  assert.deepEqual(f.calls, ['SAVE']); assert.equal(draft.aiConsent, true); assert.equal(f.client.snapshot().project!.settings.aiConsent, false);
});
test('ordinary snapshots, readiness, invalidate and reconnect cannot clear unknown outcome', async () => {
  const f = fixture(); await f.client.run('RUN_TESTS');
  assert.equal(f.client.applyProject(project()), true); assert.equal(await f.client.run('RUN_TESTS'), false);
  assert.equal(f.client.applyExecution(project().capabilities.execution), true); assert.equal((await f.client.saveSettings(settings(),1)).ok, false);
  f.client.invalidate(); f.a.connectionGeneration = 'conn2'; assert.equal(f.client.applyProject(project()), true);
  assert.equal(await f.client.run('RUN_TESTS'), false); assert.deepEqual(f.calls, ['RUN']);
});
test('fresh explicit reconciliation gets exact unresolved mutation and full validated state; active Run still requires same-run Stop', async () => {
  const f = fixture(); await f.client.run('RUN_TESTS');
  assert.equal(await f.client.reconcile(async (mutation, signal) => {
    assert.equal(signal.aborted, false); assert.deepEqual(mutation, {kind:'RUN',requestId:'r1',projectId:'p1',sessionId:'s1',clientId:'client1',expectedWorkspaceVersion:1});
    return {project:project(),run:run()};
  }), true);
  assert.equal(f.client.snapshot().reconciliationRequired, false); assert.equal(await f.client.run('RUN_TESTS'), false);
  f.failure = null; f.response = {...run(),status:'CANCELLED',exitCode:137,finishedAt:'2026-11-11T21:01:00.000Z'};
  assert.equal(await f.client.stop(), true); assert.deepEqual(f.calls, ['RUN','STOP']);
});
test('authoritative settled absence permits a new mutation, never an automatic retry or invented Run', async () => {
  const f = fixture(); await f.client.run('RUN_TESTS'); let reads = 0;
  assert.equal(await f.client.reconcile(async () => { reads++; return {project:project(),run:null}; }), true);
  assert.equal(reads,1); assert.deepEqual(f.calls,['RUN']); assert.equal(f.client.snapshot().run,null);
  f.failure = null; assert.equal(await f.client.run('RUN_TESTS'),true); assert.deepEqual(f.calls,['RUN','RUN']);
});
test('unknown Save reconciliation accepts actual newer project without changing caller draft or automatically saving', async () => {
  const f = fixture(), draft = settings(); draft.aiConsent = true; await f.client.saveSettings(draft,1);
  const actual = {...project(),workspaceVersion:2,settings:structuredClone(draft)};
  assert.equal(await f.client.reconcile(async () => { f.a.workspaceVersion = 2; return {project:actual,run:null}; }),true);
  assert.equal(f.client.snapshot().project!.settings.aiConsent,true); assert.equal(draft.aiConsent,true); assert.deepEqual(f.calls,['SAVE']);
});
test('throw, malformed snapshot, mismatched run and readiness-only cannot resolve mutation', async () => {
  const f = fixture(); await f.client.run('RUN_TESTS');
  for (const read of [async () => { throw Error('read failed'); }, async () => ({project:project().capabilities.execution,run:null}), async () => ({project:project(),run:{...run(),profileId:'other'}})]) {
    assert.equal(await f.client.reconcile(read),false); assert.equal(f.client.snapshot().reconciliationRequired,true);
    assert.equal(await f.client.run('RUN_TESTS'),false);
  }
  assert.deepEqual(f.calls,['RUN']);
});
test('read cannot begin before operation settlement; ordinary authoritative event cannot authorize repeat', async () => {
  const f = fixture(), g = deferred(); f.gate = g; let reads = 0;
  const started = f.client.run('RUN_TESTS');
  assert.equal(await f.client.reconcile(async () => { reads++; return {project:project(),run:null}; }),false);
  assert.equal(f.client.applyProject(project()),true); g.resolve(run()); assert.equal(await started,false);
  assert.equal(await f.client.run('RUN_TESTS'),false); assert.equal(reads,0); assert.deepEqual(f.calls,['RUN']);
});
test('abort/invalidate does not allow read before dispatched operation drains or erase unknown mutation', async () => {
  const f = fixture(), g = deferred(); f.gate = g; const started = f.client.run('RUN_TESTS'); f.client.invalidate(); f.client.applyProject(project());
  let reads=0; assert.equal(await f.client.reconcile(async () => { reads++; return {project:project(),run:null}; }),false);
  assert.equal(await f.client.run('RUN_TESTS'),false); g.resolve(run()); assert.equal(await started,false);
  assert.equal(reads,0); assert.equal(f.client.snapshot().reconciliationRequired,true);
});
test('late read after reconnect/invalidate or ordinary snapshot cannot clear fence; another fresh read is required', async () => {
  for (const change of ['reconnect','snapshot','invalidate'] as const) {
    const f = fixture(); await f.client.run('RUN_TESTS'); const g = deferred();
    const reading = f.client.reconcile(async () => g.promise as Promise<{project:unknown;run:unknown}>);
    if (change === 'reconnect') f.a.connectionGeneration = 'conn2';
    else if (change === 'snapshot') f.client.applyProject(project());
    else { f.client.invalidate(); f.client.applyProject(project()); }
    g.resolve({project:project(),run:null}); assert.equal(await reading,false); assert.equal(await f.client.run('RUN_TESTS'),false);
    assert.equal(f.client.snapshot().reconciliationRequired,true); assert.deepEqual(f.calls,['RUN']);
    assert.equal(await f.client.reconcile(async () => ({project:project(),run:null})),true);
  }
});
test('pre-dispatch local validation failure does not require reconciliation', async () => {
  const f = fixture(); f.a.canExecute = false; assert.equal(await f.client.run('RUN_TESTS'),false);
  assert.equal(f.client.snapshot().reconciliationRequired,false); f.a.canExecute = true; f.failure = null;
  assert.equal(await f.client.run('RUN_TESTS'),true); assert.deepEqual(f.calls,['RUN']);
});
test('unknown result is retained for original scope across visiting another session; no cross-scope read can settle it', async () => {
  const f = fixture(); await f.client.run('RUN_TESTS'); f.client.invalidate(); f.a.sessionId = 's2';
  assert.equal(f.client.applyProject({...project(),sessionId:'s2'}),true);
  let reads=0; assert.equal(await f.client.reconcile(async () => { reads++; return {project:project(),run:null}; }),false);
  f.client.invalidate(); f.a.sessionId = 's1'; f.client.applyProject(project()); assert.equal(await f.client.run('RUN_TESTS'),false);
  assert.equal(reads,0); assert.deepEqual(f.calls,['RUN']);
});
test('invalid HTTP confirmation is also unknown, not evidence of rejected mutation', async () => {
  for (const kind of ['RUN','SAVE'] as const) {
    const f = fixture(); f.failure = null; f.response = kind === 'RUN' ? {...run(),profileId:'other'} : {...project(),workspaceVersion:2};
    const draft = settings(); draft.aiConsent = true;
    if (kind === 'RUN') assert.equal(await f.client.run('RUN_TESTS'),false);
    else assert.equal((await f.client.saveSettings(draft,1)).ok,false);
    assert.equal(await f.client.run('RUN_TESTS'),false); assert.equal((await f.client.saveSettings(draft,1)).ok,false);
    assert.deepEqual(f.calls,[kind]); assert.equal(f.client.snapshot().reconciliationRequired,true);
  }
});
test('failed local Save validation and ordinary successful mutations do not leave an unknown fence', async () => {
  const f = fixture(); assert.equal((await f.client.saveSettings(settings(),0)).ok,false);
  assert.equal(f.client.snapshot().reconciliationRequired,false); assert.deepEqual(f.calls,[]);
  f.failure = null; f.response = {...project(),workspaceVersion:2}; assert.equal((await f.client.saveSettings(settings(),1)).ok,true);
  assert.equal(f.client.snapshot().reconciliationRequired,false);
});
