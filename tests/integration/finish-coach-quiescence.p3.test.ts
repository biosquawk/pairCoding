/** Independent HUMAN stage03 oracle. Real listener, WS, CoachAdapter, Runner child,
 * snapshot and ReportService. Only local AI output, snapshot scheduling and observation
 * are injected through seams already present at base 24484a25. No external AI. */
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createPairCoachServer } from '../../src/server/http';
import { CoachAdapter } from '../../src/server/CoachAdapter';
import type { CoachContext } from '../../src/server/coach/context';
import type { FrozenFacts } from '../../src/server/ReportService';
import { workspaceFiles, Peer, id, settings } from '../qa/helpers';

const silent = { kind: 'SILENT', reason: 'Local independent fixture' };
const interventions = new Set(['CONTROL_PREPARE', 'COACH_STEP_EDIT', 'COACH_HINT_BUBBLE', 'ACTION_PROPOSAL']);
const digest = (s: string) => createHash('sha256').update(s).digest('hex');
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(r => { resolve = r; });
  return { promise, resolve };
}
async function until(predicate: () => boolean, label: string) {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    assert(Date.now() < deadline, `hang guard: ${label}`);
    await delay(5);
  }
}

async function fixture(t: TestContext, limitMs: number | null = null) {
  const dirs = await workspaceFiles(t, { 'main.py': 'value = 0\n' });
  const token = id(), clientId = id();
  const calls: { context: Readonly<CoachContext>; afterAcceptance: boolean }[] = [];
  const wire: { type: string; payload: any }[] = [];
  let armed = false, accepted = false;
  let releaseGate = () => {};
  const app = createPairCoachServer({ ...dirs, port: 0, token, enableExecution: true, enableCoach: true,
    coachFactory(context) {
      const adapter = new CoachAdapter({ ...context, provider: { name: 'P3_LOCAL', mode: 'INJECTED',
        async decide(c) {
          calls.push({ context: structuredClone(c), afterAcceptance: accepted });
          if (c.trigger?.reason !== 'RUN' && c.trigger?.reason !== 'OVERTIME') return silent;
          return { kind: 'HINT', severity: 'NEUTRAL', text: `P3 local ${c.trigger.reason} ${c.lastRun?.runId ?? ''}`,
            path: null, documentVersion: null, range: null, showPointer: false,
            evidenceIds: c.lastRun ? [c.lastRun.runId] : [] };
        },
      } });
      // Observe, do not substitute, the first synchronous finish abort. Mark before
      // delegation so even reentrant callbacks inside abort are in the measured window.
      const abort = adapter.abort.bind(adapter);
      adapter.abort = () => { if (armed) { accepted = true; armed = false; } abort(); };
      return adapter;
    },
  });
  const peers = new Set<{ close(): void }>();
  t.after(async () => {
    releaseGate();
    for (const p of peers) p.close();
    try { await app.close(); } finally { await dirs.cleanup(); }
  });
  function profile(active: boolean) {
    return { kind: 'RUN_MAIN' as const, executable: process.execPath,
      args: ['-e', active ? "process.stdout.write('P3_CHILD_READY\\n');setInterval(()=>{},1000)" : "process.stdout.write('P3_NORMAL_DONE\\n')"],
      cwd: '.', timeoutMs: 10000, testReportFormat: 'NONE' as const, testReportGlob: null };
  }
  app.workspace.updateSettings({ ...settings, aiConsent: true, runProfiles: [profile(true)] });
  const port = await app.listen(), baseURL = `http://127.0.0.1:${port}`;
  assert(![8081, 8765, 8766, 8767, 8768].includes(port));
  const sessionId = app.session.getSession().sessionId;
  const peer = new Peer({ port, baseURL, token, clientId, sessionId, peers } as any);
  peer.socket.on('message', raw => wire.push(JSON.parse(raw.toString())));
  await peer.connect();
  const command = () => ({ requestId: id(), clientId, sessionId });
  async function http(method: string, url: string, body?: unknown) {
    const res = await fetch(baseURL + url, { method,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(8000) });
    return { status: res.status, body: await res.json() };
  }
  assert.equal((await http('POST', '/api/session/start', { ...command(), limitMs, pauseOnHidden: true })).status, 200);
  await until(() => app.session.getSession().aiStatus !== 'THINKING', 'START provider settles');
  async function run(active = true) {
    if (!active) {
      assert.equal((await http('PUT', '/api/project/settings', { ...command(),
        expectedWorkspaceVersion: app.workspace.workspaceVersion,
        settings: { ...app.workspace.settings, runProfiles: [profile(false)] } })).status, 200);
    }
    const res = await http('POST', '/api/run', { ...command(), mode: 'RUN_MAIN', expectedWorkspaceVersion: app.workspace.workspaceVersion });
    assert.equal(res.status, 202);
    const runId = res.body.runId as string;
    if (active) {
      await peer.take(m => m.type === 'RUN_OUTPUT' && m.payload.runId === runId && m.payload.chunk.includes('P3_CHILD_READY'));
      assert.equal((await http('GET', `/api/run/${runId}`)).body.status, 'RUNNING', 'actual live child before finish');
    } else {
      await peer.take(m => m.type === 'RUN_STATE' && m.payload.runId === runId && !!m.payload.finishedAt);
    }
    return runId;
  }
  function gateSnapshot() {
    const entered = deferred(), release = deferred();
    const original = app.workspace.createSnapshotAsync.bind(app.workspace);
    app.workspace.createSnapshotAsync = async (...args) => {
      entered.resolve();
      await release.promise;
      return original(...args);
    };
    releaseGate = release.resolve;
    return { entered: entered.promise, release: release.resolve };
  }
  function finish() {
    armed = true;
    return http('POST', '/api/session/finish', { ...command(),
      expectedWorkspaceVersion: app.workspace.workspaceVersion, reason: 'COMPLETED' });
  }
  async function write(content: string) {
    const doc = (await http('GET', '/api/file?path=main.py')).body;
    const state = (await http('GET', '/api/session')).body;
    const ack = await peer.ack(peer.send('CODE_CHANGED', { path: 'main.py', content,
      baseVersion: doc.version, controlEpoch: state.controlEpoch, editKind: 'TYPING' }));
    assert.equal(ack.payload.status, 'OK');
    assert.equal(await readFile(path.join(dirs.rootPath, 'main.py'), 'utf8'), content);
  }
  async function frozen() {
    const file = path.join(app.workspace.dataDir, 'reports', digest(sessionId), 'facts.json');
    const saved = JSON.parse(await readFile(file, 'utf8'));
    assert.equal(digest(saved.serialized), saved.sha256, 'durable FrozenFacts integrity');
    return JSON.parse(saved.serialized) as FrozenFacts;
  }
  return { app, peer, http, command, run, finish, gateSnapshot, frozen, write, calls, wire, sessionId,
    accepted: () => accepted };
}

function assertFinalMaterial(facts: FrozenFacts, runId: string) {
  const run = facts.runs.find(r => r.runId === runId);
  assert(run, 'terminal Run retained in FrozenFacts');
  assert.equal(run.status, 'CANCELLED');
  assert(run.startedAt && run.finishedAt);
  assert.match(run.outputTail, /P3_CHILD_READY/);
  const events = facts.events.filter((e: any) => e.type === 'RUN' && e.run?.runId === runId) as any[];
  assert.equal(events.length, 1, 'terminal Run fact retained exactly once, not deleted to silence coach');
  assert.deepEqual(events[0].run, run, 'event and final runs retain the same complete Run');
  assert.equal(facts.session.lifecycle, 'FINISHED');
  assert.equal(facts.session.writeOwner, 'STUDENT');
  const material = facts.finalMaterial as { snapshot: { snapshotId: string }; files: { path: string; rawBase64: string | null }[] };
  assert.equal(material.snapshot.snapshotId, facts.snapshot.snapshotId);
  const file = material.files.find(f => f.path === 'main.py');
  assert(file?.rawBase64);
  assert.equal(Buffer.from(file.rawBase64, 'base64').toString(), 'value = 0\n');
}

function assertNoAnalysis(t: TestContext, f: Awaited<ReturnType<typeof fixture>>, wireStart: number) {
  const late = f.calls.filter(c => c.afterAcceptance);
  const lateInterventions = f.wire.slice(wireStart).filter(m => interventions.has(m.type));
  t.diagnostic(JSON.stringify({ accepted: f.accepted(), lateDecide: late.map(c => c.context.trigger),
    lateInterventions: lateInterventions.map(m => m.type) }));
  assert.equal(f.accepted(), true, 'synchronous finish acceptance was actually observed');
  assert.deepEqual({ decideStarts: late.length, interventions: lateInterventions.length },
    { decideStarts: 0, interventions: 0 }, 'no new analysis/intervention from acceptance through persistence');
}

test('P3 control: normal terminal Run starts actual local provider analysis and hint', { timeout: 15000 }, async t => {
  const f = await fixture(t);
  const runId = await f.run(false);
  await f.peer.take(m => m.type === 'COACH_HINT_BUBBLE' && m.payload.text.includes(runId));
  const calls = f.calls.filter(c => c.context.trigger?.reason === 'RUN');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].context.lastRun?.runId, runId);
  assert.equal(calls[0].context.lastRun?.status, 'SUCCEEDED');
  assert.equal(calls[0].afterAcceptance, false);
  assert.equal(f.app.session.getSession().lifecycle, 'RUNNING');
  assert.equal(f.app.session.getSession().writeOwner, 'STUDENT');
  f.peer.assertProtocol();
});

test('P3 finish: live Runner stopAll keeps full final facts but starts zero decide/interventions during snapshot await', { timeout: 15000 }, async t => {
  const f = await fixture(t);
  const runId = await f.run(), gate = f.gateSnapshot();
  const wireStart = f.wire.length, epoch = f.app.session.getSession().controlEpoch;
  const finishing = f.finish();
  await gate.entered;
  assert.equal(f.accepted(), true);
  assert.equal(f.app.session.getSession().lifecycle, 'RUNNING', 'not FINISHED while persistence is gated');
  assert.equal((await f.http('GET', `/api/run/${runId}`)).body.status, 'CANCELLED');
  // A real WS roundtrip drains outbound frames; 400 ms also covers EDIT's existing
  // 350 ms debounce. This is an observation window, not a product latency threshold.
  await delay(400);
  await f.peer.ack(f.peer.send('PING', { lastAppliedSeq: 0 }));
  const duringGateCalls = f.calls.filter(c => c.afterAcceptance).length;
  gate.release();
  const res = await finishing;
  assert.equal(res.status, 202);
  assert.equal(res.body.sessionId, f.sessionId);
  const facts = await f.frozen();
  assertFinalMaterial(facts, runId);
  assert(facts.session.controlEpoch > epoch, 'finish retains epoch cutoff');
  const ready = await f.peer.take(m => m.type === 'SESSION_REPORT' && m.payload.status === 'READY');
  assert(ready.payload.evidenceIds.includes(runId));
  assert.match(ready.payload.markdown, /CANCELLED/);
  t.diagnostic(JSON.stringify({ runId, duringGateCalls, finalFactsComplete: true, reportReady: true }));
  await f.peer.ack(f.peer.send('PING', { lastAppliedSeq: 0 }));
  assertNoAnalysis(t, f, wireStart);
  f.peer.assertProtocol();
});

test('P3 finish: real timer overtime cannot start provider while snapshot persistence is gated', { timeout: 15000 }, async t => {
  const f = await fixture(t, 1000);
  const runId = await f.run(), gate = f.gateSnapshot(), wireStart = f.wire.length;
  const finishing = f.finish();
  await gate.entered;
  await f.peer.take(m => m.type === 'CHAT_REPLY' && m.payload.text.includes('Limit czasu minął'));
  assert.equal(f.app.session.getSession().timer.status, 'OVERTIME');
  await f.peer.ack(f.peer.send('PING', { lastAppliedSeq: 0 }));
  assert.equal(f.app.session.getSession().lifecycle, 'RUNNING');
  const inGateReasons = f.calls.filter(c => c.afterAcceptance).map(c => c.context.trigger?.reason);
  gate.release();
  assert.equal((await finishing).status, 202);
  assertFinalMaterial(await f.frozen(), runId);
  await f.peer.take(m => m.type === 'SESSION_REPORT' && m.payload.status === 'READY');
  await f.peer.ack(f.peer.send('PING', { lastAppliedSeq: 0 }));
  t.diagnostic(JSON.stringify({ inGateReasons, realOvertimeObserved: true }));
  assertNoAnalysis(t, f, wireStart);
  f.peer.assertProtocol();
});

for (const failure of ['snapshot', 'report', 'report-existing', 'report-rename'] as const) {
  test(`P3 finish ${failure} storage failure: no FINISHED, student write and coach resume, later finish succeeds`, { timeout: 15000 }, async t => {
    const f = await fixture(t);
    await f.run();
    const target = failure === 'report-existing' || failure === 'report-rename'
      ? path.join(f.app.workspace.dataDir, 'reports', digest(f.sessionId), 'report.json')
      : path.join(f.app.workspace.dataDir, failure === 'snapshot' ? 'snapshots-v1' : 'reports');
    const backup = target + '.p3-backup';
    if (failure === 'report') await rename(target, backup);
    let failedRename = 0;
    let factsAtReportFailure: string | undefined;
    const originalRename = fs.renameSync;
    const renameFault = failure === 'report-rename' ? t.mock.method(fs, 'renameSync', (from: fs.PathLike, to: fs.PathLike) => {
      if (String(to) === target) {
        failedRename++;
        // Observe the durable boundary before failure; legitimate rollback may remove
        // this invocation's unpublished facts before the rejected finish returns.
        factsAtReportFailure = fs.readFileSync(path.join(path.dirname(target), 'facts.json'), 'utf8');
        throw Object.assign(new Error('P3 injected report rename EIO'), { code: 'EIO' });
      }
      return originalRename(from, to);
    }) : undefined;
    syncBuiltinESMExports();
    if (failure === 'report-existing') await mkdir(target, { recursive: true });
    else if (failure !== 'report-rename') await writeFile(target, 'P3 actual ENOTDIR obstruction');
    let result: Awaited<ReturnType<typeof f.finish>>;
    try { result = await f.finish(); }
    finally {
      renameFault?.mock.restore();
      syncBuiltinESMExports();
      if (failure !== 'report-rename') await rm(target, { force: true, recursive: failure === 'report-existing' });
      if (failure === 'report') await rename(backup, target);
    }
    if (failure === 'report-rename') {
      assert.equal(failedRename, 1, 'fault hit report commit, not snapshot/facts creation');
      assert(factsAtReportFailure, 'durable facts observed inside report rename fault before throw');
      const saved = JSON.parse(factsAtReportFailure);
      assert.equal(digest(saved.serialized), saved.sha256, 'durable FrozenFacts integrity at failure boundary');
      const prospective = JSON.parse(saved.serialized) as FrozenFacts;
      assert.equal(prospective.session.lifecycle, 'FINISHED', 'prospective frozen facts were already written before rename EIO');
      t.diagnostic(JSON.stringify({ failure, durableFactsBeforeReportFailure: true }));
    }
    assert(result.status >= 400 && result.status < 600, 'real persistence failure must reject finish');
    assert.equal(f.app.session.getSession().lifecycle, 'RUNNING');
    assert.equal(f.app.session.getSession().writeOwner, 'STUDENT');
    assert.equal(f.wire.some(m => m.type === 'SESSION_STATE' && m.payload.lifecycle === 'FINISHED'), false);
    assert.equal(f.wire.some(m => m.type === 'SESSION_REPORT'), false, 'no success-like report from rejected persistence');
    const beforeRecovery = f.calls.length;
    await f.write(`student recovery after ${failure}\n`);
    const request = f.peer.send('CHAT_MESSAGE', { text: `recover ${failure}`, path: null, documentVersion: null, selection: null });
    assert.equal((await f.peer.ack(request)).payload.status, 'OK');
    await until(() => f.calls.slice(beforeRecovery).some(c => c.context.trigger?.reason === 'CHAT'), 'coach resumes after failed finish');
    await until(() => f.app.session.getSession().aiStatus !== 'THINKING', 'recovery provider settles');
    const retried = await f.finish();
    t.diagnostic(JSON.stringify({ failure, firstStatus: result.status, firstError: result.body.code,
      retryStatus: retried.status, retryError: retried.body.code }));
    assert.equal(retried.status, 202, 'fresh explicit finish works after storage is repaired');
    const facts = await f.frozen();
    assert.equal(facts.runs.length, 1);
    assert.equal(facts.runs[0].status, 'CANCELLED');
    assert.equal(facts.events.filter((e: any) => e.type === 'RUN').length, 1);
    assert.equal(facts.session.lifecycle, 'FINISHED');
    assert(facts.chat.some(c => c.text === `recover ${failure}`));
    const material = facts.finalMaterial as { files: { path: string; rawBase64: string | null }[] };
    const recoveredFile = material.files.find(file => file.path === 'main.py');
    assert(recoveredFile?.rawBase64, 'retry freezes current student material');
    assert.equal(Buffer.from(recoveredFile.rawBase64, 'base64').toString(), `student recovery after ${failure}\n`);
    await f.peer.take(m => m.type === 'SESSION_REPORT' && m.payload.status === 'READY');
    t.diagnostic(JSON.stringify({ failure, rejectedStatus: result.status, errorCode: result.body.code,
      recoveryChatDecide: true, retryFinish: 202 }));
    f.peer.assertProtocol();
  });
}
