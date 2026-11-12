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
  registry = new LanguageFeatureRegistry({ clock, ackLedger: ledger, authority: {
    capture: () => ({ revision, documents: docs }), isCurrent: (_scope, snapshot) => admitted && snapshot.revision === revision,
  }, factory: { create: (_scope, phase, snapshot, cb, requested) => {
    const launchId = `${phase}-${++nextId}`;
    const generation: ImmutableDiagnosticGeneration | null = phase === 'diagnostics' ? {
      launchId, inputManifestSha256: hash, wholeProjectManifestPath: `/owned/${launchId}/manifest.json`, immutableShadowDirectory: `/owned/${launchId}/workspace`,
      policy: 'IMMUTABLE_WHOLE_PROJECT', maxAnalysisMs: 30000, retirementDeadlineMs: 10000,
      sources: snapshot.documents.map(d => ({ sourceStamp: d.stamp, provenance: { kind: 'IMMUTABLE_GENERATION', launchId, lspVersion: 1, inputManifestSha256: hash } })),
    } : null;
    const s = new Session(launchId, phase, snapshot, cb, generation); alter?.(s); sessions.push(s); return { session: s, generation };
  }, refreshCompletion: () => refreshAllowed } });
  t.after(async () => { for (const s of sessions) { s.stopGate = null; s.outcome = confirmed; } await registry.disposeProject(project); });
  return { registry, ledger, project, clock, sessions, events,
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

test('immutable exact source is unavailable before actual send; 150ms coalesce, not ready-on-start', async t => {
  const f = fixture(t); const initial = await f.registry.startProject(f.project); f.listen();
  assert.equal(initial.state, 'INDEXING'); assert.equal(f.registry.readAnalysisSource(document().stamp), null);
  await tick(); assert.equal(f.sessions.length, 1); assert.equal(f.sessions[0].phase, 'completion');
  await f.clock.advance(149); assert.equal(f.sessions.length, 1);
  await f.clock.advance(1); const diagnostic = f.sessions[1]; assert.equal(diagnostic.phase, 'diagnostics');
  const source = f.registry.readAnalysisSource(document().stamp); assert.ok(source); assert.equal(source.provenance.kind, 'IMMUTABLE_GENERATION');
  assert.ok(Object.isFrozen(source)); assert.ok(Object.isFrozen(source.sourceStamp));
  assert.equal(f.registry.readAnalysisSource({ ...document().stamp, localModelVersion: 2 }), null);
  assert.equal(markers(f.events).length, 0);
});
test('all-project mutation synchronously clears + invalidates BOTH owners before awaits; late push drops', async t => {
  const f = fixture(t, [document(), document(1, 'inactive.py')]), diagnostic = await f.launch();
  diagnostic.emit(); await tick(); const old = f.sessions[0];
  const next = document(2); f.edit([next, document(1, 'inactive.py')]); const change = f.registry.change(next);
  assert.equal(markers(f.events).at(-1)!.items.length, 0); assert.ok(old.completionCancellations); assert.ok(diagnostic.invalidations.length);
  assert.equal(f.registry.readAnalysisSource(document().stamp), null);
  const count = markers(f.events).length; diagnostic.emit(); assert.equal(markers(f.events).length, count); await change;
});
test('one active + ONLY latest pending; old actual exit AND removal before next launch', async t => {
  const f = fixture(t), old = await f.launch(), stop = deferred<LanguageProcessRetirement>(); old.stopGate = stop.promise;
  for (let i = 2; i <= 5; i++) { const d = document(i); f.edit([d]); await f.registry.change(d); await f.clock.advance(50); }
  await f.clock.advance(150); assert.equal(f.sessions.filter(s => s.phase === 'diagnostics').length, 1);
  stop.resolve(confirmed); await tick();
  const generations = f.sessions.filter(s => s.phase === 'diagnostics'); assert.equal(generations.length, 2);
  assert.equal(generations[1].snapshot.documents[0].stamp.localModelVersion, 5); assert.equal(old.retired, 1);
});
test('confirmed exit WITHOUT removal retains SAME owner and prevents next generation; explicit reconciliation', async t => {
  const f = fixture(t), old = await f.launch(); old.outcome = { confirmed: true, removed: false, problem: 'rm uncertain' };
  const next = document(2); f.edit([next]); await f.registry.change(next); await f.clock.advance(150);
  assert.equal(f.sessions.filter(s => s.phase === 'diagnostics').length, 1);
  assert.ok(f.events.some(e => e.type === 'STATUS' && e.status.state === 'FAILED'));
  old.outcome = confirmed; await f.registry.retireDiagnostics(f.project, old.launchId); await tick();
  assert.equal(f.sessions.filter(s => s.phase === 'diagnostics').length, 1, 'explicit retire cancels pending, not a hidden retry');
  await f.registry.change(next); await f.clock.advance(150); assert.equal(f.sessions.filter(s => s.phase === 'diagnostics').length, 2);
});
test('10s bounded Stop uncertainty owns original pending operation, no duplicate retirement while in flight', async t => {
  const f = fixture(t), old = await f.launch(), stop = deferred<LanguageProcessRetirement>(); old.stopGate = stop.promise;
  const next = document(2); f.edit([next]); await f.registry.change(next); await tick(); await f.clock.advance(10000);
  assert.equal(old.retired, 1); assert.equal(f.sessions.filter(s => s.phase === 'diagnostics').length, 1);
  const reconcile = f.registry.retireDiagnostics(f.project, old.launchId); await tick(); assert.equal(old.retired, 1);
  stop.resolve(confirmed); assert.equal((await reconcile).confirmed, true);
});
test('30s analysis includes startup: blocked initialize is invalidated and retired, never fake empty markers', async t => {
  const f = fixture(t), start = deferred<void>(); f.alter(s => { if (s.phase === 'diagnostics') s.startGate = start.promise; });
  const old = await f.launch(); await f.clock.advance(30000);
  assert.ok(old.invalidations.some(v => /deadline/.test(v))); assert.equal(old.retired, 1); assert.deepEqual(markers(f.events), []);
  start.resolve(); await tick(); assert.equal(old.opens.length, 0);
});
test('fixed source+result survive confirmed automatic retirement while exact vector remains current', async t => {
  const f = fixture(t), old = await f.launch(); old.emit(); await tick();
  assert.equal(old.retired, 1); const source = f.registry.readAnalysisSource(document().stamp); assert.ok(source);
  assert.equal(markers(f.events).length, 1); assert.equal(markers(f.events)[0].items.length, 1);
  old.emit(); assert.equal(markers(f.events).length, 1, 'late/duplicate push after retirement drops');
  f.revoke(); assert.equal(f.registry.readAnalysisSource(document().stamp), null);
});
test('SAME actual issuer ACK AFTER broadcast aliases presentation ONLY, including requestGeneration; no process change', async t => {
  const f = fixture(t), old = await f.launch(); old.emit(); await tick(); const before = structuredClone(markers(f.events)[0]);
  const proof = f.save(); f.events.push({ type: 'STATUS', status: { projectId: 'ack-before-marker', profileId: 'ack', configurationGeneration: 'ack', providerGeneration: 'ack', state: 'ON', autocomplete: 'ON', docs: 'N/A', problem: null } });
  const sessions = f.sessions.length, opens = f.sessions.map(s => s.opens.length), retirements = f.sessions.map(s => s.retired);
  f.registry.acknowledge(proof);
  const result = markers(f.events).at(-1)!;
  assert.deepEqual(result.sourceStamp, before.sourceStamp); assert.deepEqual(result.provenance, before.provenance);
  assert.deepEqual(result.items, before.items); assert.equal(result.association?.saveReceiptId, 'ack');
  assert.equal(result.presentationStamp.baseDocumentVersion, 2); assert.equal(result.presentationStamp.documentVersion, 2);
  assert.equal(result.presentationStamp.requestGeneration, result.sourceStamp.requestGeneration);
  assert.equal(f.sessions.length, sessions); assert.deepEqual(f.sessions.map(s => s.opens.length), opens); assert.deepEqual(f.sessions.map(s => s.retired), retirements);
  assert.deepEqual(f.registry.readAnalysisSource(document().stamp), proof.source);
});
test('genuine ACK before first diagnostic retains sent source, late result uses verified presentation', async t => {
  const f = fixture(t), old = await f.launch(), proof = f.save(); f.registry.acknowledge(proof);
  assert.equal(markers(f.events).length, 0); old.emit(); await tick();
  const result = markers(f.events)[0]; assert.ok(result); assert.equal(result.association?.saveReceiptId, 'ack'); assert.deepEqual(result.sourceStamp, proof.source.sourceStamp);
});
test('forged/copied proof never aliases; clears immediately then schedules genuinely fresh diagnostics', async t => {
  const f = fixture(t), old = await f.launch(); old.emit(); await tick(); const proof = f.save();
  f.registry.acknowledge(structuredClone(proof) as VerifiedLanguageAck);
  assert.equal(markers(f.events).at(-1)!.items.length, 0); assert.ok(markers(f.events).every(r => r.association === null));
  await f.clock.advance(150); assert.equal(f.sessions.filter(s => s.phase === 'diagnostics').length, 2);
});
test('dependency/external-file feed clears all inactive document markers, even without active model change', async t => {
  const f = fixture(t, [document(), document(1, 'inactive.py')]), old = await f.launch(); old.emit(); old.emit('inactive.py'); await tick();
  f.edit([document(), document(1, 'inactive.py')]); const operation = f.registry.fileOperation(f.project, { kind: 'DELETE', path: 'other.py' });
  assert.equal(markers(f.events).filter(r => r.items.length === 0).length, 2); assert.equal(f.registry.readAnalysisSource(document().stamp), null); await operation;
});
test('close uses actual admitted complete vector; no foreign scope or invented current overlay', async t => {
  const f = fixture(t); await f.launch(); assert.throws(() => f.registry.change({ ...document(2), stamp: { ...document(2).stamp, connectionGeneration: 'foreign' } }));
  await assert.rejects(f.registry.change(document(2)), /not admitted/);
  f.edit([]); await f.registry.close(document().stamp); await f.clock.advance(150);
  assert.equal(f.sessions.filter(s => s.phase === 'diagnostics').at(-1)!.opens.length, 0);
});
test('completion capture rejects late result after any source change; cancel delegates exact request', async t => {
  const f = fixture(t); await f.launch(); const s = f.sessions[0], request: CompleteRequest = { requestId: 'complete', stamp: document().stamp, position: { line: 1, column: 2 }, trigger: null };
  const complete = deferred<CompleteResult>(); s.completionGate = complete.promise;
  const result = f.registry.complete(request); f.registry.cancel({ requestId: request.requestId, stamp: request.stamp }); assert.deepEqual(s.cancelled, ['complete']);
  const next = document(2); f.edit([next]); await f.registry.change(next);
  complete.resolve({ requestId: request.requestId, stamp: request.stamp, items: [], isIncomplete: false }); await assert.rejects(result, /Late/);
});
test('bad actual factory descriptor fails closed BUT retains its process for actual Stop', async t => {
  const f = fixture(t); f.alter(s => { if (s.generation) (s.generation as { launchId: string }).launchId = 'foreign'; });
  const old = await f.launch(); assert.equal(old.started, 0); assert.equal(old.retired, 1); assert.equal(markers(f.events).length, 0);
});
test('dispose clears synchronously and retains unresolved owner; no replacement project can launch', async t => {
  const f = fixture(t), old = await f.launch(); old.emit(); await tick();
  const completion = f.sessions[0]; completion.outcome = { confirmed: false, removed: false, problem: 'daemon off' };
  const disposing = f.registry.disposeProject(f.project); assert.equal(markers(f.events).at(-1)!.items.length, 0); assert.equal((await disposing).confirmed, false);
  const other = { ...f.project, projectId: 'new' }; await assert.rejects(f.registry.startProject(other), /ownership unresolved/);
  assert.equal(f.registry.getProjectScope()?.projectId, 'p');
});
test('source changes cannot mutate retained scope or source/result objects; listener throw cannot steal ownership', async t => {
  const f = fixture(t), old = await f.launch(); f.registry.subscribe(f.project, () => { throw new Error('observer'); });
  f.project.profile.label = 'changed outside'; assert.equal(f.registry.getProjectScope()?.profile.label, 'Python');
  // Use actual retained scope for cleanup and lifecycle from here.
  f.project.profile.label = 'Python'; const source = f.registry.readAnalysisSource(document().stamp)!; assert.throws(() => { (source.sourceStamp as { path: string }).path = 'other'; });
  old.emit(); await tick(); assert.ok(Object.isFrozen(markers(f.events)[0].items)); assert.equal(old.retired, 1);
});
test('archive is exact-sent ONLY, erased on equal-byte ABA/full-vector mutation; no receipt-time latest capture', async t => {
  const f = fixture(t), old = await f.launch(); const source = f.registry.readSentAnalysisSource(document().stamp); assert.ok(source);
  assert.equal(f.registry.readSentAnalysisSource({ ...document().stamp, requestGeneration: 2 }), null);
  const sameBytes = document(); f.edit([sameBytes]); const operation = f.registry.fileOperation(f.project, { kind: 'CREATE', path: 'new.py', content: '' });
  assert.equal(f.registry.readSentAnalysisSource(document().stamp), null); old.emit(); assert.equal(markers(f.events).length, 0); await operation;
});
test('mutable, unknown, mismatched-manifest and duplicate pushes never become diagnostic evidence', async t => {
  const f = fixture(t), old = await f.launch(), source = f.registry.readSentAnalysisSource(document().stamp)!;
  f.sessions[0].cb.onDiagnostics(old.result()); assert.equal(markers(f.events).length, 0);
  const wrong: DiagnosticsResult = { ...old.result(), provenance: { kind: 'IMMUTABLE_GENERATION', launchId: old.launchId, lspVersion: 99, inputManifestSha256: hash } };
  old.cb.onDiagnostics(wrong); assert.equal(markers(f.events).length, 0);
  old.cb.onSourceSent(document().stamp, { sourceStamp: document().stamp, provenance: { kind: 'IMMUTABLE_GENERATION', launchId: old.launchId, lspVersion: 99, inputManifestSha256: hash } });
  assert.deepEqual(f.registry.readSentAnalysisSource(document().stamp), source);
  old.emit(); old.emit(); await tick(); assert.equal(markers(f.events).length, 1);
});
test('manual retirement keeps current exact evidence, rejects unknown process without touching actual owner', async t => {
  const f = fixture(t), old = await f.launch();
  await assert.rejects(f.registry.retireDiagnostics(f.project, 'not-owned'), /Foreign/); assert.equal(old.retired, 0);
  assert.equal((await f.registry.retireDiagnostics(f.project, old.launchId)).confirmed, true);
  assert.ok(f.registry.readAnalysisSource(document().stamp)); assert.equal((await f.registry.retireDiagnostics(f.project, old.launchId)).confirmed, true);
  await assert.rejects(f.registry.retireDiagnostics(f.project, 'unknown'), /Unknown/); assert.equal(old.retired, 1);
});
test('scope disposal returns FAILED not OFF when daemon Stop remains uncertain', async t => {
  const f = fixture(t); await f.launch(); f.sessions[0].outcome = { confirmed: false, removed: false, problem: 'daemon unknown' };
  const result = await f.registry.disposeProject(f.project); assert.equal(result.confirmed, false); assert.equal(result.status.state, 'FAILED');
  assert.equal(result.status.problem?.code, 'PROCESS_STOP_UNCONFIRMED');
});
test('genuine but now stale ACK never reattaches source after unrelated mutation', async t => {
  const f = fixture(t), old = await f.launch(); old.emit(); await tick(); const proof = f.save();
  const newer = document(2); f.edit([newer]); await f.registry.change(newer); assert.equal(f.ledger.isVerified(proof), false);
  f.registry.acknowledge(proof); assert.ok(markers(f.events).every(r => r.association === null)); assert.equal(f.registry.readSentAnalysisSource(document().stamp), null);
});
test('mutable completion reuses one owner; synchronously cancels before refresh and sends actual change', async t => {
  const f = fixture(t); await f.launch(); const old = f.sessions[0], next = document(2);
  f.edit([next]); const operation = f.registry.change(next); assert.equal(old.completionCancellations, 1); await operation; await tick();
  assert.equal(f.sessions.filter(s => s.phase === 'completion').length, 1); assert.equal(old.retired, 0); assert.deepEqual(old.changes, [next]);
});
test('incompatible completion dependencies retire old mutable owner before fresh sibling admission', async t => {
  const f = fixture(t); await f.launch(); const old = f.sessions[0], next = document(2); f.dependenciesChanged(); f.edit([next]);
  await f.registry.change(next); await tick(); assert.equal(old.retired, 1); assert.equal(old.changes.length, 0);
  const completions = f.sessions.filter(s => s.phase === 'completion'); assert.equal(completions.length, 2); assert.deepEqual(completions[1].opens, [next]);
});
test('cancelled startup cannot monopolize scheduler after actual Stop+removal confirmed', async t => {
  const f = fixture(t), stuck = deferred<void>(); let block = true;
  f.alter(s => { if (s.phase === 'diagnostics' && block) s.startGate = stuck.promise; });
  const old = await f.launch(); block = false; const next = document(2); f.edit([next]);
  await f.registry.change(next); await f.clock.advance(150);
  assert.equal(old.retired, 1); assert.equal(f.sessions.filter(s => s.phase === 'diagnostics').length, 2);
  stuck.resolve(); await tick(); assert.equal(old.opens.length, 0, 'late initialize never sends obsolete source');
});
