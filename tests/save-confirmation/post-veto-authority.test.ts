/** Actual LiveBackend -> RuntimeClientV2 composition, controlled authenticated transport.
 * No real Monaco/browser, backend commit, AI or Docker claim. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate, setTimeout as pause } from 'node:timers/promises';
import { LiveBackend } from '../../src/services/LiveBackend';
import type { CoachEditStep } from '../../src/types/paircoach';
import { bundle, doc } from '../frontend-cutover/fixtures';
import { hash } from '../client-v2/fixtures';
import { validateV2WireShape } from '../../src/shared/validation-v2';

async function fixture(t: any) {
  const remote = bundle(); remote.project.settings.aiConsent = true;
  const http: { path: string; method: string; body: any }[] = [], sent: any[] = [], rendered: CoachEditStep[] = [];
  const fileEvents: any[] = [];
  let projectRead: (() => unknown | Promise<unknown>) | undefined;
  let fileRead: (() => unknown | Promise<unknown>) | undefined;
  let seq = 0, disk = doc(), saveReply: ((body: any) => Promise<unknown>) | undefined;
  const socket: any = { readyState: 1, onopen: null, onmessage: null, onclose: null, onerror: null,
    send(raw: string) { sent.push(JSON.parse(raw)); }, close() { this.readyState = 3; } };
  const live = new LiveBackend({ token: 'unit-auth-only', clientId: 'c1', socket: () => socket,
    fetch: (async (input, options) => {
      const path = new URL(String(input)).pathname, method = options?.method ?? 'GET';
      const body = options?.body ? JSON.parse(String(options.body)) : null;
      http.push({ path, method, body });
      assert.equal((options?.headers as Record<string,string>).Authorization, 'Bearer unit-auth-only');
      if (path === '/api/project' && projectRead) return Response.json(await projectRead());
      if (path === '/api/file' && fileRead) return Response.json(await fileRead());
      if (path === '/api/project/settings') {
        if (saveReply) return Response.json(await saveReply(body));
        remote.project.settings = structuredClone(body.settings); remote.project.workspaceVersion++;
        return Response.json(remote.project);
      }
      return Response.json(path === '/api/project' ? remote.project : path === '/api/session' ? remote.session : path === '/api/snapshots' ? [] : disk);
    }) as typeof fetch });
  t.after(() => live.close());
  const receive = (type: string, payload: unknown) => live.receive({ protocolVersion: '3.0', sessionId: 's1',
    messageId: `server-${++seq}`, seq, type, payload: structuredClone(payload) } as any);
  await live.connect(); receive('SESSION_SNAPSHOT', remote); await setImmediate();
  assert.equal(live.getState().isOffline, false);
  live.subscribe('file', file => fileEvents.push(file));
  live.subscribe('step', (step: CoachEditStep) => { rendered.push(step); live.stepRendered(step, disk.content); });
  const control = (owner: 'COACH' | 'STUDENT', epoch: number) => {
    Object.assign(remote.session, { writeOwner: owner, controlEpoch: epoch, coachMode: owner === 'COACH' ? 'INTERVENING' : 'COOLDOWN_AFTER_VETO',
      cooldownAfterVeto: owner === 'STUDENT', interventionId: owner === 'COACH' ? 'intervention' : null });
    receive('CONTROL_STATE', { writeOwner: remote.session.writeOwner, controlEpoch: epoch, coachMode: remote.session.coachMode,
      cooldownAfterVeto: remote.session.cooldownAfterVeto, interventionId: remote.session.interventionId, purpose: null });
  };
  const step = async (n: number) => {
    const content = `coach-${n}`; disk = doc('main.txt', content, n + 1);
    remote.project.workspaceVersion = n + 1; remote.project.files[0].version = n + 1; remote.session.workspaceVersion = n + 1;
    const payload = { stepId: `step-${n}`, interventionId: 'intervention', controlEpoch: 1, path: 'main.txt', baseVersion: n,
      version: n + 1, workspaceVersion: n + 1, range: { startLine: 1, startColumn: 1, endLine: 1, endColumn: n === 1 ? 6 : 8 },
      textBlock: content, contentHash: hash(content) };
    const shouldRender = remote.session.writeOwner === 'COACH' && !sent.some(m => m.type === 'VETO_ESCAPE');
    let finish!: () => void;
    const renderedWait = new Promise<void>(resolve => { finish = resolve; });
    const off = live.subscribe('step', (step: CoachEditStep) => { if (step.stepId === payload.stepId) finish(); });
    receive('COACH_STEP_EDIT', payload);
    if (shouldRender) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try { await Promise.race([renderedWait, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(Error('expected step not rendered')), 2000); })]); }
      finally { clearTimeout(timer); off(); }
    } else { off(); await setImmediate(); }
    return payload;
  };
  const veto = () => { live.triggerVeto(); return sent.filter(m => m.type === 'VETO_ESCAPE').at(-1); };
  const confirmVeto = (request: any) => {
    control('STUDENT', 2);
    receive('ACK', { replyTo: request.messageId, status: 'OK', documentVersion: null,
      workspaceVersion: remote.project.workspaceVersion, controlEpoch: 2, error: null });
    receive('SESSION_STATE', remote.session);
  };
  const save = () => live.saveRuntimeSettings({ ...structuredClone(remote.project.settings), aiConsent: false }, remote.project.workspaceVersion);
  return { live, remote, http, sent, rendered, fileEvents, receive, control, step, veto, confirmVeto, save,
    setProjectRead(read: () => unknown | Promise<unknown>) { projectRead = read; },
    setFileRead(read: () => unknown | Promise<unknown>) { fileRead = read; },
    setSaveReply(reply: (body: any) => Promise<unknown>) { saveReply = reply; } };
}

test('rendered steps alone + Veto epoch change do not reproduce stale authority at SAVE', async t => {
  const f = await fixture(t); f.control('COACH', 1); await f.step(1); await f.step(2);
  assert.equal(f.rendered.length, 2); const veto = f.veto(); f.confirmVeto(veto);
  const result = await f.save(); assert.equal(result.ok, true);
  assert.equal(f.http.filter(r => r.method === 'PUT').length, 1);
  assert.equal(f.http.find(r => r.method === 'PUT')!.body.expectedWorkspaceVersion, 3);
});

test('late committed third step after Veto is never rendered; confirmed current settings can still be saved', async t => {
  const f = await fixture(t); f.control('COACH', 1); await f.step(1); await f.step(2);
  const veto = f.veto(); await f.step(3); f.confirmVeto(veto);
  assert.equal(f.rendered.length, 2, 'Veto must forbid late coach model mutation');
  assert.equal(f.sent.filter(m => m.type === 'STEP_RENDERED').length, 2);
  assert.equal(f.live.getState().workspaceVersion, 4);
  assert.equal(f.live.getState().files[0].content, 'coach-2', 'late content not installed as coach edit');
  assert.ok(validateV2WireShape('Project', f.remote.project));
  const result = await f.save(); assert.equal(result.ok, true, JSON.stringify(result));
  const puts = f.http.filter(r => r.method === 'PUT'); assert.equal(puts.length, 1);
  assert.equal(puts[0].body.expectedWorkspaceVersion, 4); assert.equal(puts[0].body.settings.aiConsent, false);
  assert.equal(f.live.getState().runtime?.reconciliationRequired, false);
  assert.equal(f.http.filter(r => r.path === '/api/project').length, 2, 'one initial GET plus one fresh read, never a retry');
  assert.equal(f.sent.filter(m => m.type === 'STEP_RENDERED').length, 2, 'SAVE must not render late content');
  assert.equal(f.sent.some(m => m.type === 'CODE_CHANGED'), false, 'metadata refresh never writes pupil source');
  assert.equal(f.live.getState().runtime?.project?.files[0].version, 4, 'use actual current file version from DTO');
});

test('post-Veto UNKNOWN SAVE cannot be healed by a current project or duplicated', async t => {
  const f = await fixture(t);
  f.setSaveReply(async () => { throw Error('lost original SAVE response'); });
  assert.equal((await f.save()).ok, false);
  f.control('COACH', 1); await f.step(1); const veto = f.veto(); await f.step(2); f.confirmVeto(veto);
  assert.equal((await f.save()).ok, false);
  assert.equal(f.http.filter(r => r.method === 'PUT').length, 1);
  assert.equal(f.live.getState().runtime?.reconciliationRequired, true);
});

test('pending original SAVE remains singleflight across Veto and late-step publications', async t => {
  const f = await fixture(t); let settle!: (value: unknown) => void;
  f.setSaveReply(() => new Promise(resolve => { settle = resolve; }));
  const saving = f.save(); await setImmediate();
  const original = f.http.find(r => r.method === 'PUT')!.body;
  f.control('COACH', 1); await f.step(1); const veto = f.veto(); await f.step(2); f.confirmVeto(veto);
  assert.equal((await f.save()).ok, false);
  settle({ ...structuredClone(f.remote.project), settings: original.settings, workspaceVersion: 2 });
  assert.equal((await saving).ok, false, 'real epoch/source drift rejects late original HTTP');
  assert.equal(f.http.filter(r => r.method === 'PUT').length, 1);
  assert.equal(f.live.getState().runtime?.reconciliationRequired, true);
});

for (const mismatch of ['project', 'session', 'root', 'old-version', 'future-version', 'config', 'profile', 'settings', 'malformed'] as const) {
  test(`post-Veto fresh read cannot grant SAVE for ${mismatch}`, async t => {
    const f = await fixture(t); f.control('COACH', 1); await f.step(1);
    const veto = f.veto(); await f.step(2); f.confirmVeto(veto);
    const value = structuredClone(f.remote.project);
    if (mismatch === 'project') value.projectId = 'foreign';
    if (mismatch === 'session') value.sessionId = 'foreign';
    if (mismatch === 'root') value.rootPath = '/other';
    if (mismatch === 'old-version') value.workspaceVersion--;
    if (mismatch === 'future-version') value.workspaceVersion++;
    if (mismatch === 'config') value.capabilities.execution.runtime.configurationGeneration = 'foreign';
    if (mismatch === 'profile') value.capabilities.execution.runtime.profileId = 'foreign';
    if (mismatch === 'settings') value.settings.contextPatterns = ['foreign/**'];
    if (mismatch === 'malformed') (value as any).extra = true;
    f.setProjectRead(() => value);
    assert.equal((await f.save()).ok, false);
    assert.equal(f.http.filter(r => r.method === 'PUT').length, 0);
    assert.equal(f.rendered.length, 1); assert.equal(f.sent.filter(m => m.type === 'STEP_RENDERED').length, 1);
  });
}
for (const drift of ['veto-epoch', 'pending-draft', 'disconnect', 'generation', 'connection'] as const) {
  test(`post-Veto read cannot bind authority after ${drift} during read`, async t => {
    const f = await fixture(t); f.control('COACH', 1); await f.step(1);
    const veto = f.veto(); await f.step(2); f.confirmVeto(veto);
    let readWasCalled = false;
    f.setProjectRead(async () => {
      readWasCalled = true;
      if (drift === 'veto-epoch') f.control('STUDENT', 3);
      if (drift === 'pending-draft') f.live.saveFileContent('main.txt', 'protected draft');
      if (drift === 'disconnect') f.live.close();
      if (drift === 'generation') { f.receive('SESSION_SNAPSHOT', f.remote); await setImmediate(); }
      if (drift === 'connection') { f.setProjectRead(() => f.remote.project); await f.live.connect(); }
      return f.remote.project;
    });
    assert.equal((await f.save()).ok, false);
    assert.equal(f.http.filter(r => r.method === 'PUT').length, 0);
    if (drift === 'pending-draft' && readWasCalled) assert.ok(f.live.getState().pendingPaths.includes('main.txt'));
  });
}

for (const invalid of ['hash', 'stale-base', 'foreign-intervention'] as const) {
  test(`unverified ${invalid} step cannot be rendered or grant runtime SAVE`, async t => {
    const f = await fixture(t); f.control('COACH', 1);
    const payload = { stepId: 'bad-step', interventionId: invalid === 'foreign-intervention' ? 'foreign' : 'intervention',
      controlEpoch: 1, path: 'main.txt', baseVersion: invalid === 'stale-base' ? 0 : 1, version: 2, workspaceVersion: 2,
      range: { startLine: 1, startColumn: 1, endLine: 1, endColumn: 6 }, textBlock: 'coach', contentHash: invalid === 'hash' ? hash('foreign') : hash('coach') };
    let offline!: () => void;
    const offlineWait = new Promise<void>(resolve => { offline = resolve; });
    const off = f.live.subscribe('state', () => { if (f.live.getState().isOffline) offline(); });
    f.receive('COACH_STEP_EDIT', payload);
    if (invalid !== 'foreign-intervention') {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try { await Promise.race([offlineWait, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(Error('invalid step did not resync')), 2000); })]); }
      finally { clearTimeout(timer); }
    }
    off(); f.live.stepRendered({ ...payload, text: payload.textBlock } as CoachEditStep, 'coach');
    assert.equal(f.rendered.length, 0); assert.equal(f.sent.filter(m => m.type === 'STEP_RENDERED').length, 0);
    assert.equal((await f.save()).ok, false); assert.equal(f.http.filter(r => r.method === 'PUT').length, 0);
    assert.equal(f.live.getState().files[0].content, 'draft');
  });
}

test('runtime publication cannot hide a reentrant authority change before metadata installation and SAVE', async t => {
  const f = await fixture(t); f.control('COACH', 1); await f.step(1);
  const veto = f.veto(); await f.step(2); f.confirmVeto(veto);
  let armed = true;
  const off = f.live.subscribe('state', state => {
    if (armed && state.runtime?.project?.workspaceVersion === 3) { armed = false; f.control('STUDENT', 3); }
  });
  assert.equal((await f.save()).ok, false); off();
  assert.equal(f.http.filter(r => r.method === 'PUT').length, 0);
});

// Owner dc8fbf24: metadata cannot silently rebase old cached bytes onto a late committed version.
for (const choice of ['KEEP_LOCAL', 'LOAD_DISK'] as const) {
  test(`post-Veto follow-up edit protects draft, then explicit ${choice} permits current-base edit/restore and original ACK`, async t => {
    const f = await fixture(t); f.control('COACH', 1); await f.step(1); await f.step(2);
    const veto = f.veto(); await f.step(3); f.confirmVeto(veto);
    assert.equal((await f.save()).ok, true);
    assert.equal(f.live.getState().files[0].content, 'coach-2', 'SAVE must not install late coach edit');
    assert.deepEqual(f.fileEvents, [], 'settings SAVE must not repaint the clean source document');
    f.live.saveFileContent('main.txt', 'student restore');
    await setImmediate();
    await pause(180);
    assert.equal(f.sent.some(m => m.type === 'CODE_CHANGED'), false, 'no stale write or silent rebase');
    assert.deepEqual(f.live.getState().fileConflict, { path: 'main.txt', localDraftContent: 'student restore', diskContent: 'coach-3' });
    assert.equal(f.live.getState().files[0].content, 'student restore', 'typing must not be overwritten');
    assert.deepEqual(f.live.getState().pendingPaths, ['main.txt']);
    assert.equal(f.rendered.length, 2); assert.equal(f.sent.filter(m => m.type === 'STEP_RENDERED').length, 2);
    await f.live.resolveConflict(choice);
    if (choice === 'LOAD_DISK') {
      assert.equal(f.live.getState().files[0].content, 'coach-3', 'explicit choice, not late coach render');
      assert.deepEqual(f.live.getState().pendingPaths, []);
      f.live.saveFileContent('main.txt', 'student restore');
    }
    await pause(180);
    const changes = () => f.sent.filter(m => m.type === 'CODE_CHANGED');
    assert.equal(changes().length, 1);
    const change = changes()[0];
    assert.equal(change.payload.baseVersion, 4); assert.equal(change.payload.controlEpoch, 2);
    assert.equal(change.payload.content, 'student restore');
    // An unrelated ACK cannot claim this edit saved.
    f.receive('ACK', { replyTo: 'unrelated', status: 'OK', documentVersion: 5, workspaceVersion: 6, controlEpoch: 2, error: null });
    assert.deepEqual(f.live.getState().pendingPaths, ['main.txt']);
    f.receive('ACK', { replyTo: change.messageId, status: 'OK', documentVersion: 5, workspaceVersion: 6, controlEpoch: 2, error: null });
    assert.deepEqual(f.live.getState().pendingPaths, []);
    assert.equal(f.live.getState().files[0].content, 'student restore');
    assert.equal(f.live.getState().files[0].version, 5);
    // Next ordinary restore uses only the version authenticated by the original ACK.
    f.live.saveFileContent('main.txt', 'draft'); await pause(180);
    assert.equal(changes().length, 2); assert.equal(changes()[1].payload.baseVersion, 5);
    assert.notEqual(changes()[1].messageId, change.messageId);
    f.receive('ACK', { replyTo: changes()[1].messageId, status: 'OK', documentVersion: 6, workspaceVersion: 7, controlEpoch: 2, error: null });
    assert.deepEqual(f.live.getState().pendingPaths, []); assert.equal(f.live.getState().files[0].content, 'draft');
    assert.equal(f.http.filter(r => r.path === '/api/file').length, 1, 'one authenticated document read, no retry');
    assert.equal(f.http.filter(r => r.method === 'PUT').length, 1, 'no repeated settings SAVE');
  });
}
for (const read of ['failure', 'typing', 'disconnect'] as const) {
  test(`post-Veto follow-up protected draft survives document-read ${read} without stale CODE_CHANGED`, async t => {
    const f = await fixture(t); f.control('COACH', 1); await f.step(1); await f.step(2);
    const veto = f.veto(); await f.step(3); f.confirmVeto(veto);
    assert.equal((await f.save()).ok, true);
    let settle!: (value: unknown) => void, reject!: (error: Error) => void;
    f.setFileRead(() => new Promise((resolve, fail) => { settle = resolve; reject = fail; }));
    f.live.saveFileContent('main.txt', 'protected typing'); await setImmediate();
    assert.equal(typeof settle, 'function');
    if (read === 'typing') f.live.saveFileContent('main.txt', 'newer protected typing');
    if (read === 'disconnect') f.live.close();
    if (read === 'failure') reject(Error('authenticated read unavailable'));
    else settle(doc('main.txt', 'coach-3', 4));
    await setImmediate(); await pause(180);
    assert.equal(f.sent.some(m => m.type === 'CODE_CHANGED'), false);
    assert.deepEqual(f.live.getState().pendingPaths, ['main.txt']);
    assert.equal(f.live.getState().files[0].content, read === 'typing' ? 'newer protected typing' : 'protected typing');
    if (read === 'typing') assert.deepEqual(f.live.getState().fileConflict, { path: 'main.txt', localDraftContent: 'newer protected typing', diskContent: 'coach-3' });
    else assert.equal(f.live.getState().fileConflict, null, 'unavailable/stale response cannot grant conflict resolution authority');
    assert.equal(f.rendered.length, 2); assert.equal(f.http.filter(r => r.path === '/api/file').length, 1);
  });
}

for (const invalid of ['foreign-path', 'old-version', 'future-version', 'hash'] as const) {
  test(`post-Veto conflict read ${invalid} cannot grant explicit resolution authority`, async t => {
    const f = await fixture(t); f.control('COACH', 1); await f.step(1); await f.step(2);
    const veto = f.veto(); await f.step(3); f.confirmVeto(veto);
    assert.equal((await f.save()).ok, true);
    const value = doc('main.txt', 'coach-3', 4);
    if (invalid === 'foreign-path') value.path = 'foreign.txt';
    if (invalid === 'old-version') value.version = 3;
    if (invalid === 'future-version') value.version = 5;
    if (invalid === 'hash') value.contentHash = hash('foreign');
    f.setFileRead(() => value);
    f.live.saveFileContent('main.txt', 'protected typing');
    await pause(180);
    await f.live.resolveConflict('KEEP_LOCAL'); await pause(180);
    assert.equal(f.sent.some(m => m.type === 'CODE_CHANGED'), false);
    assert.equal(f.live.getState().files[0].content, 'protected typing');
    assert.deepEqual(f.live.getState().pendingPaths, ['main.txt']);
    assert.equal(f.live.getState().fileConflict, null, 'bad read must not grant a conflict-resolution base');
    assert.equal(f.rendered.length, 2);
  });
}

for (const drift of ['epoch', 'snapshot'] as const) {
  test(`post-Veto explicit conflict read rejects ${drift} authority drift`, async t => {
    const f = await fixture(t); f.control('COACH', 1); await f.step(1); await f.step(2);
    const veto = f.veto(); await f.step(3); f.confirmVeto(veto); assert.equal((await f.save()).ok, true);
    let settle!: (value: unknown) => void;
    f.setFileRead(() => new Promise(resolve => { settle = resolve; }));
    f.live.saveFileContent('main.txt', 'protected typing'); await setImmediate();
    if (drift === 'epoch') f.control('STUDENT', 3);
    else { f.receive('SESSION_SNAPSHOT', f.remote); await setImmediate(); }
    settle(doc('main.txt', 'coach-3', 4)); await setImmediate(); await pause(180);
    assert.equal(f.sent.some(m => m.type === 'CODE_CHANGED'), false);
    assert.equal(f.live.getState().files[0].content, 'protected typing');
    assert.deepEqual(f.live.getState().pendingPaths, ['main.txt']);
    assert.equal(f.rendered.length, 2);
  });
}
