import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import * as codec from '../../src/language/uriCodec';
import { LanguageFeatureRegistry, type RegistryCallbacks, type RegistryClock, type RegistrySession, type RegistrySnapshot } from '../../src/server/language/LanguageFeatureRegistry';
import { LanguageAckLedger, type LanguageAckCurrent, type LanguageSaveCommit, type LanguageSaveInput } from '../../src/server/language/LanguageAckLedger';
import type { ImmutableDiagnosticGeneration, LanguageEvent, LanguageProjectScope, VerifiedLanguageAck } from '../../src/server/language/ports';
import type { AnalysisSource, CompleteRequest, CompleteResult, DiagnosticsResult, OpenOrChange } from '../../src/shared/language-v2';
import type { LanguageProcessRetirement } from '../../src/server/language/DockerLanguageProcess';
const hash = 'e'.repeat(64), dependency = 'd'.repeat(64);
const tick = async () => { for (let i = 0; i < 8; i++) await new Promise<void>(resolve => setImmediate(resolve)); };
function deferred<T>() { let resolve!: (v: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
class Clock implements RegistryClock {
  time = 0; id = 0; tasks = new Map<number, { at: number; cb: () => void }>();
  set(ms: number, cb: () => void) { const id = ++this.id; this.tasks.set(id, { at: this.time + ms, cb }); return id; }
  clear(h: unknown) { this.tasks.delete(h as number); }
  async advance(ms: number) {
    this.time += ms;
    for (const [id, task] of [...this.tasks]) if (task.at <= this.time && this.tasks.delete(id)) task.cb();
    await tick();
  }
}
const scope = (): LanguageProjectScope => ({ projectId: 'p', sessionId: 's', configurationGeneration: 'config', providerGeneration: 'provider',
  shadowGeneration: 'shadow', connectionGeneration: 'connection', shadowDirectory: '/owned/fixture', profile: {
    id: 'python-3.13', label: 'Python', adapterFamily: 'python', imageLockKey: 'python', expectedTools: [], compilerRelease: null,
    analysis: { languageLevel: '3.13', preview: false }, language: { provider: 'pylsp', imageLockKey: 'pylsp', serverJvm: null }, taskFields: [] } });
function document(version = 1, path = 'Zażółć space.py'): OpenOrChange {
  const content = `name${version} = missing\r\n`;
  return { stamp: { projectId: 'p', sessionId: 's', profileId: 'python-3.13', configurationGeneration: 'config', providerGeneration: 'provider', shadowGeneration: 'shadow',
    connectionGeneration: 'connection', path, modelLifetime: 'model', localModelVersion: version, requestGeneration: version, baseDocumentVersion: 1, documentVersion: null,
    contentSha256: codec.contentSha256(content), controlEpoch: 0 }, content, reason: version === 1 ? 'OPEN' : 'TYPING' };
}
const confirmed: LanguageProcessRetirement = { confirmed: true, removed: true, problem: null };
class Session implements RegistrySession {
  invalidations: string[] = []; opens: OpenOrChange[] = []; started = 0; retired = 0; cancelled: string[] = [];
  startGate: Promise<void> = Promise.resolve(); stopGate: Promise<LanguageProcessRetirement> | null = null;
  outcome = confirmed; completionGate: Promise<CompleteResult> | null = null;
  constructor(readonly launchId: string, readonly phase: 'completion' | 'diagnostics', readonly snapshot: RegistrySnapshot, readonly cb: RegistryCallbacks, readonly generation: ImmutableDiagnosticGeneration | null) {}
  async start() { this.started++; await this.startGate; this.cb.onState('INDEXING', null); }
  async open(doc: OpenOrChange) {
    this.opens.push(doc);
    const source: AnalysisSource = this.generation?.sources.find(s => s.sourceStamp.path === doc.stamp.path) ?? {
      sourceStamp: doc.stamp, provenance: { kind: 'VERSIONED_PUSH', lspVersion: 1, inputManifestSha256: hash } };
    this.cb.onSourceSent(doc.stamp, source);
  }
  changes: OpenOrChange[] = []; closed: string[] = []; completionCancellations = 0;
  cancelCompletions() { this.completionCancellations++; }
  async change(doc: OpenOrChange) { this.changes.push(doc); }
  async close(stamp: OpenOrChange['stamp']) { this.closed.push(stamp.path); }
  async complete(request: CompleteRequest): Promise<CompleteResult> {
    return this.completionGate ?? { requestId: request.requestId, stamp: request.stamp, items: [], isIncomplete: false };
  }
  cancel(requestId: string) { this.cancelled.push(requestId); }
  invalidate(problem = '') { this.invalidations.push(problem); this.cb.onState('FAILED', problem); }
  async retire() { this.retired++; return this.stopGate ?? this.outcome; }
  result(path = this.snapshot.documents[0].stamp.path, empty = false): DiagnosticsResult {
    const source = this.generation!.sources.find(s => s.sourceStamp.path === path)!;
    return { ...structuredClone(source), presentationStamp: structuredClone(source.sourceStamp), association: null,
      items: empty ? [] : [{ range: { startLine: 1, startColumn: 1, endLine: 1, endColumn: 5 }, severity: 'ERROR', message: 'undefined name', code: null }], truncated: false };
  }
  emit(path?: string, empty = false) { this.cb.onDiagnostics(this.result(path, empty)); }
}
// UNIT-only factory and full-vector authorities. SAME actual issuer+central codec, no Docker/WriteGate/real LSP proof.
function fixture(t: TestContext, documents = [document()]) {
  const clock = new Clock(), project = scope(); let revision = 'r1', docs = structuredClone(documents), nextId = 0;
  let registry!: LanguageFeatureRegistry;
  const sessions: Session[] = [], events: LanguageEvent[] = [], commits = new Map<string, LanguageSaveCommit>();
  let messageId = 'doc1', currentStamp = structuredClone(docs[0]?.stamp), admitted = true;
  const current = (): LanguageAckCurrent | null => admitted ? { documentMessageId: messageId, stamp: currentStamp, content: docs[0].content, projectRevision: revision, dependencyManifestSha256: dependency } : null;
  const ledger = new LanguageAckLedger({ readCurrent: current,
    readAnalysisSource: (_peer, id) => id === messageId ? registry.readSentAnalysisSource(documents[0].stamp) : null,
    readCommittedSave: (_req, receipt) => commits.get(receipt) ?? null }, codec);
  let alter: ((session: Session) => void) | null = null, refreshAllowed = true;
  let held = false, acquisitions = 0, refreshes = 0;
  let acquisitionGate: Promise<void> | null = null, releaseError = false;
  let acquired: (() => void) | null = null;
  const assertHeld = () => assert.equal(held, true, 'copy/owner transfer requires the freshly held FIFO');
  registry = new LanguageFeatureRegistry({ clock, ackLedger: ledger, authority: {
    capture: () => ({ revision, documents: docs }), isCurrent: (_scope, snapshot) => admitted && snapshot.revision === revision,
  }, factory: {
    withCaptureLease: async (_scope, _snapshot, action) => {
      acquisitions++; const wait = acquisitionGate; acquisitionGate = null; acquired?.();
      await wait; assert.equal(held, false); held = true;
      try { action(); if (releaseError) throw Error('Final release fence failed'); }
      finally { held = false; }
    }, create: (_scope, phase, snapshot, cb, requested) => {
    assertHeld(); const launchId = `${phase}-${++nextId}`;
    const generation: ImmutableDiagnosticGeneration | null = phase === 'diagnostics' ? {
      launchId, inputManifestSha256: hash, wholeProjectManifestPath: `/owned/${launchId}/manifest.json`, immutableShadowDirectory: `/owned/${launchId}/workspace`,
      policy: 'IMMUTABLE_WHOLE_PROJECT', maxAnalysisMs: 30000, retirementDeadlineMs: 10000,
      sources: snapshot.documents.map(d => ({ sourceStamp: d.stamp, provenance: { kind: 'IMMUTABLE_GENERATION', launchId, lspVersion: 1, inputManifestSha256: hash } })),
    } : null;
    const s = new Session(launchId, phase, snapshot, cb, generation);
    const start = s.start.bind(s); s.start = async () => { assert.equal(held, false, 'provider start is outside FIFO'); return start(); }; alter?.(s); sessions.push(s); return { session: s, generation };
  }, refreshCompletion: () => { assertHeld(); refreshes++; return refreshAllowed; } } });
  t.after(async () => { for (const s of sessions) { s.stopGate = null; s.outcome = confirmed; } await registry.disposeProject(project); });
  return { get held() { return held; }, get acquisitions() { return acquisitions; }, get refreshes() { return refreshes; },
    block: (p: Promise<void>) => { acquisitionGate = p; },
    onAcquire: (fn: () => void) => { acquired = fn; }, failRelease: () => { releaseError = true; },
    registry, ledger, project, clock, sessions, events,
    listen: () => registry.subscribe(project, event => events.push(event)),
    edit: (next: OpenOrChange[]) => { revision = `r${Number(revision.slice(1)) + 1}`; docs = structuredClone(next); currentStamp = structuredClone(docs[0]?.stamp); },
    dependenciesChanged: () => { refreshAllowed = false; },
    alter: (fn: (s: Session) => void) => { alter = fn; }, revoke: () => { admitted = false; },
    async launch() { await registry.startProject(project); this.listen(); await tick(); await clock.advance(150); return sessions.find(s => s.phase === 'diagnostics')!; },
    save(): VerifiedLanguageAck {
      ledger.observeDocument('peer', messageId, documents[0]);
      const req: LanguageSaveInput = { peerId: 'peer', transactionMessageId: 'save', languageDocumentMessageId: messageId, path: documents[0].stamp.path, baseVersion: 1, controlEpoch: 0, content: documents[0].content };
      const handle = ledger.beginSave(req); assert.ok(handle, 'source must already have been actually sent');
      const before = revision; revision = 'r99'; currentStamp = { ...currentStamp, baseDocumentVersion: 2, documentVersion: 2 };
      commits.set('ack', { request: req, saveReceiptId: 'ack', replyTo: 'save', status: 'OK', documentVersion: 2, workspaceVersion: 2,
        committedContent: documents[0].content, beforeProjectRevision: before, afterProjectRevision: revision });
      const proof = ledger.commitSave(handle, 'ack'); assert.ok(proof); return proof;
    },
  };
}
const markers = (events: LanguageEvent[]) => events.filter((e): e is Extract<LanguageEvent, { type: 'DIAGNOSTICS' }> => e.type === 'DIAGNOSTICS').map(e => e.result);


test('delayed diagnostics acquire a fresh FIFO after completion lease release; no lifetime gate hold', async t => {
  const f = fixture(t); await f.registry.startProject(f.project); await tick();
  assert.equal(f.acquisitions, 1); assert.equal(f.sessions.length, 1); assert.equal(f.held, false);
  await f.clock.advance(149); assert.equal(f.acquisitions, 1);
  await f.clock.advance(1); assert.equal(f.acquisitions, 2); assert.equal(f.held, false);
  assert.deepEqual(f.sessions.map(s => [s.phase, s.started]), [['completion',1], ['diagnostics',1]]);
});
test('completion refresh captures under a NEW lease and sends change only after release', async t => {
  const f = fixture(t); await f.launch(); const owner = f.sessions[0], next = document(2), before = f.acquisitions;
  const change = owner.change.bind(owner); owner.change = async d => { assert.equal(f.held, false); await change(d); };
  f.edit([next]); await f.registry.change(next); await tick();
  assert.equal(f.refreshes, 1); assert.equal(f.acquisitions, before + 1); assert.deepEqual(owner.changes, [next]);
  assert.equal(f.sessions.filter(s => s.phase === 'completion').length, 1);
});
test('superseded pending capture cannot create old diagnostics and latest snapshot is coalesced', async t => {
  const f = fixture(t); await f.registry.startProject(f.project); await tick(); const gate = deferred<void>();
  f.block(gate.promise); await f.clock.advance(150); assert.equal(f.acquisitions, 2);
  const next = document(2); f.edit([next]); await f.registry.change(next); await tick();
  gate.resolve(); await tick(); assert.equal(f.sessions.filter(s => s.phase === 'diagnostics').length, 0);
  await f.clock.advance(150); assert.equal(f.sessions.filter(s => s.phase === 'diagnostics').length, 1);
  assert.equal(f.sessions.at(-1)!.snapshot.documents[0].stamp.localModelVersion, 2);
});
test('disposal while waiting for a source lease never creates or starts an orphan', async t => {
  const f = fixture(t), gate = deferred<void>(); f.block(gate.promise);
  await f.registry.startProject(f.project); await tick(); await f.registry.disposeProject(f.project);
  gate.resolve(); await tick(); assert.equal(f.sessions.length, 0); assert.equal(f.held, false);
});
test('final capture fence failure retains transferred owner and confirms retirement before replacement', async t => {
  const f = fixture(t), stop = deferred<LanguageProcessRetirement>();
  f.alter(s => { s.stopGate = stop.promise; }); f.failRelease();
  await f.registry.startProject(f.project); await tick();
  const owner = f.sessions[0]; assert.equal(owner.started, 0); assert.equal(owner.retired, 1);
  const next = document(2); f.edit([next]); await f.registry.change(next); await tick();
  assert.equal(f.sessions.filter(s => s.phase === 'completion').length, 1, 'unconfirmed owner is retained');
  stop.resolve(confirmed); await tick(); assert.equal(owner.retired, 1); assert.equal(f.held, false);
});
test('refresh final fence failure retires existing owner instead of sending changed bytes', async t => {
  const f = fixture(t); await f.launch(); const owner = f.sessions[0]; f.failRelease();
  const next = document(2); f.edit([next]); await f.registry.change(next); await tick();
  assert.equal(f.refreshes, 1); assert.equal(owner.changes.length, 0); assert.equal(owner.retired, 1);
});
