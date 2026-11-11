/** Adapter-policy regressions only. Public finish/Runner/FrozenFacts oracle belongs to P3. */
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { CoachAdapter, type CoachProvider } from '../../src/server/CoachAdapter';
import { WorkspaceService } from '../../src/server/WorkspaceService';
import { SessionController } from '../../src/server/SessionController';
import { WriteGate } from '../../src/server/WriteGate';
import { LocalFallbackProvider } from '../../src/server/coach/provider';
import type { CoachContext } from '../../src/server/coach/context';
import type { ChatEntry, Run } from '../../src/shared/protocol';

const silent = { kind: 'SILENT', reason: 'injected policy fixture' };
const chat = (messageId: string): ChatEntry => ({ messageId, author: 'STUDENT', text: 'help', createdAt: new Date().toISOString() });
const settled = () => delay(15);
function fixture(t: TestContext, provider: CoachProvider) {
  const root = mkdtempSync(join(tmpdir(), 'finish-admission-p1-'));
  const task = join(root, 'task'); mkdirSync(task); writeFileSync(join(task, 'main.py'), 'original\n');
  const workspace = new WorkspaceService(task, join(root, 'data'));
  workspace.updateSettings({ ...workspace.settings, aiConsent: true, contextPatterns: ['**/*.py'] });
  const session = new SessionController(workspace);
  session.claimLease('policy-client'); session.start(null, false);
  const gate = new WriteGate(workspace, session);
  const policy = { allowed: true };
  const events: { type: string; payload: any }[] = [];
  const options = { workspace, session, gate, provider, canAnalyze: () => policy.allowed,
    emit: (type: string, payload: unknown) => events.push({ type, payload }),
    onProposal: (payload: unknown) => events.push({ type: 'ACTION_PROPOSAL', payload }) };
  const adapter = new CoachAdapter(options);
  t.after(() => { adapter.close(); session.close(); workspace.close(); rmSync(root, { recursive: true, force: true }); });
  const run = (runId: string): Run => ({ runId, mode: 'RUN_MAIN', status: 'CANCELLED',
    workspaceVersionAtStart: workspace.workspaceVersion, workspaceChangedDuringRun: false,
    startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), exitCode: null,
    testOutcome: 'NOT_APPLICABLE', testCount: null, outputTail: 'final stdout', outputTruncated: false });
  const write = () => { const doc = workspace.getDocument('main.py'); gate.write({ clientId: 'policy-client',
    sessionId: session.state.sessionId, controlEpoch: session.state.controlEpoch, actor: 'STUDENT',
    path: 'main.py', baseVersion: doc.version, content: 'student\n' }); };
  return { workspace, session, gate, policy, events, adapter, run, write, task };
}

for (const reason of ['START', 'EDIT', 'CHAT', 'RUN', 'OVERTIME'] as const) {
  test(`policy denies ${reason} admission without provider or intervention`, async t => {
    let calls = 0;
    const f = fixture(t, { name: 'INJECTED', async decide() { calls++; return { kind: 'REPLY', text: 'must not publish' }; } });
    f.policy.allowed = false;
    f.adapter.abort(); f.session.releaseCoach();
    const before = f.events.length;
    f.adapter.trigger(reason, reason === 'CHAT' ? chat('denied-chat') : undefined);
    await delay(reason === 'EDIT' ? 400 : 20);
    assert.equal(calls, 0);
    assert.equal(f.events.length, before, 'denied trigger has no chat/control/proposal effects');
    assert.equal(f.session.state.writeOwner, 'STUDENT');
  });
}

test('Run cache survives denied admission; no cooldown unlock/replay, future genuine facts work', async t => {
  const contexts: Readonly<CoachContext>[] = [];
  const f = fixture(t, { name: 'INJECTED', async decide(context) { contexts.push(context); return silent; } });
  f.session.veto();
  const epoch = f.session.state.controlEpoch;
  f.policy.allowed = false; f.adapter.abort();
  f.adapter.updateRun(f.run('run-during-finish'));
  assert.equal(f.session.state.cooldownAfterVeto, true, 'finish result is cached, not an authorization to resume coaching');
  assert.equal(f.session.state.controlEpoch, epoch);
  await settled(); assert.equal(contexts.length, 0);
  f.policy.allowed = true;
  await settled(); assert.equal(contexts.length, 0, 'failure-style re-enable never replays a finish trigger');
  f.adapter.trigger('CHAT', chat('new-after-failure'));
  await settled();
  assert.equal(contexts.length, 1);
  assert.equal(contexts[0].lastRun?.runId, 'run-during-finish');
  assert.equal(f.session.state.cooldownAfterVeto, false, 'new explicit chat remains an actual new fact');
  f.adapter.updateRun(f.run('normal-run-after-failure'));
  await settled();
  assert.equal(contexts.length, 2);
  assert.equal(contexts[1].lastRun?.runId, 'normal-run-after-failure');
  assert.equal(contexts[1].trigger?.reason, 'RUN');
});

test('policy also guards a queued EDIT pump', async t => {
  let calls = 0;
  const f = fixture(t, { name: 'INJECTED', async decide() { calls++; return silent; } });
  f.adapter.trigger('EDIT');
  // Admission may change after scheduling but before the debounce/pump executes.
  f.policy.allowed = false;
  await delay(400);
  assert.equal(calls, 0);
  f.adapter.abort();
  f.policy.allowed = true;
  f.adapter.trigger('CHAT', chat('fresh-chat'));
  await settled(); assert.equal(calls, 1);
});

test('changed listener and fallback cannot publish/queue during denied admission', async t => {
  let calls = 0;
  const f = fixture(t, { name: 'INJECTED', async decide() { calls++; return silent; } });
  f.policy.allowed = false; f.adapter.abort();
  f.write();
  await delay(400); assert.equal(calls, 0);
  f.policy.allowed = true;
  await settled(); assert.equal(calls, 0, 'no stale EDIT resumes merely because persistence failed');
  const local = fixture(t, new LocalFallbackProvider());
  local.policy.allowed = false;
  local.adapter.trigger('OVERTIME');
  assert.equal(local.events.some(e => e.type === 'CHAT_REPLY'), false, 'fallback is an intervention too');
  local.policy.allowed = true;
  local.adapter.trigger('START');
  assert.equal(local.events.filter(e => e.type === 'CHAT_REPLY').length, 1);
});

test('ignored-abort provider settles silently during policy cutoff; later request stays single-flight', async t => {
  let resolveOld!: (value: unknown) => void;
  let oldSignal!: AbortSignal;
  let calls = 0, inflight = 0, maxInflight = 0;
  const f = fixture(t, { name: 'INJECTED', async decide(_context, signal) {
    calls++; inflight++; maxInflight = Math.max(maxInflight, inflight);
    try {
      if (calls === 1) { oldSignal = signal; return await new Promise(resolve => { resolveOld = resolve; }); }
      return { kind: 'REPLY', text: 'fresh-after-failure' };
    } finally { inflight--; }
  } });
  f.adapter.trigger('CHAT', chat('old-chat'));
  assert.equal(calls, 1);
  f.policy.allowed = false;
  // Exercise synchronous reentrancy: abort listeners must see admission already denied.
  oldSignal.addEventListener('abort', () => f.adapter.trigger('OVERTIME'), { once: true });
  f.adapter.abort(); f.session.releaseCoach();
  assert.equal(oldSignal.aborted, true);
  f.adapter.updateRun(f.run('final-run'));
  f.adapter.trigger('CHAT', chat('denied-chat'));
  f.session.timerAction('PAUSE'); f.session.timerAction('RESUME');
  resolveOld({ kind: 'REPLY', text: 'stale-old-reply' });
  await settled();
  assert.equal(calls, 1);
  assert.equal(f.events.some(e => e.type === 'CHAT_REPLY' || e.type === 'CONTROL_PREPARE' || e.type === 'ACTION_PROPOSAL'), false);
  assert.equal(readFileSync(join(f.task, 'main.py'), 'utf8'), 'original\n');
  f.policy.allowed = true;
  await settled(); assert.equal(calls, 1, 'denied triggers are not deferred/replayed');
  f.adapter.trigger('CHAT', chat('fresh-chat'));
  await settled();
  assert.equal(calls, 2); assert.equal(maxInflight, 1);
  assert.deepEqual(f.events.filter(e => e.type === 'CHAT_REPLY').map(e => e.payload.text), ['fresh-after-failure']);
});


test('policy guards state-driven pending resume and late response freshness independently of abort', async t => {
  let calls = 0;
  const f = fixture(t, { name: 'INJECTED', async decide() { calls++; return silent; } });
  f.session.timerAction('PAUSE');
  f.adapter.trigger('RUN'); // Queue while normal lifecycle policy allows but manual pause does not.
  f.policy.allowed = false;
  f.session.timerAction('RESUME');
  await settled(); assert.equal(calls, 0, 'state microtask must recheck admission');
  f.adapter.abort();

  let resolve!: (value: unknown) => void;
  const late = fixture(t, { name: 'INJECTED', decide: () => new Promise(done => { resolve = done; }) });
  late.adapter.trigger('START');
  late.policy.allowed = false; // Defensive freshness check, even without a cooperating abort caller.
  resolve({ kind: 'REPLY', text: 'must not intervene' });
  await settled();
  assert.equal(late.events.some(e => e.type === 'CHAT_REPLY'), false);
});
