import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { LanguageFeatureRegistry, type RegistryCaptureOperationHint, type RegistryClock, type RegistryFactory,
  type RegistryLaunch, type RegistrySession, type RegistrySnapshot } from '../../src/server/language/LanguageFeatureRegistry';
import { LanguageAckLedger } from '../../src/server/language/LanguageAckLedger';
import type { LanguageProjectScope } from '../../src/server/language/ports';
import type { OpenOrChange } from '../../src/shared/language-v2';
import { LANGUAGE_LIMITS } from '../../src/shared/language-v2';
import * as codec from '../../src/language/uriCodec';

// UNIT: actual exported Registry, ledger and codec; clock/FIFO/authority/session observations
// are controlled seams, NOT production source-lease, fsync, Docker, LSP or readiness proof.
const tick = async () => { for (let i = 0; i < 8; i++) await new Promise<void>(r => setImmediate(r)); };
function deferred() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; }
class Clock implements RegistryClock {
  private id = 0;
  private tasks = new Map<number, { ms: number; cb: () => void }>();
  set(ms: number, cb: () => void) { const id = ++this.id; this.tasks.set(id, { ms, cb }); return id; }
  clear(id: unknown) { this.tasks.delete(id as number); }
  async diagnostics() {
    for (const [id, task] of [...this.tasks]) if (task.ms === LANGUAGE_LIMITS.diagnosticCoalesceMs && this.tasks.delete(id)) task.cb();
    await tick();
  }
}
const project: LanguageProjectScope = { projectId: 'p', sessionId: 's', configurationGeneration: 'config', providerGeneration: 'provider',
  shadowGeneration: 'shadow', connectionGeneration: 'connection', shadowDirectory: '/unit/owned', profile: {
    id: 'python-3.13', label: 'Python', adapterFamily: 'python', imageLockKey: 'python', expectedTools: [], compilerRelease: null,
    analysis: { languageLevel: '3.13', preview: false }, language: { provider: 'pylsp', imageLockKey: 'pylsp', serverJvm: null }, taskFields: [] } };
function document(version = 1): OpenOrChange {
  const content = `value = ${version}\n`;
  return { stamp: { projectId: 'p', sessionId: 's', profileId: 'python-3.13', configurationGeneration: 'config', providerGeneration: 'provider',
    shadowGeneration: 'shadow', connectionGeneration: 'connection', path: 'main.py', modelLifetime: 'model', localModelVersion: version,
    requestGeneration: version, baseDocumentVersion: 1, documentVersion: null, contentSha256: codec.contentSha256(content), controlEpoch: 0 },
    content, reason: version === 1 ? 'OPEN' : 'TYPING' };
}
type Phase = 'completion' | 'diagnostics';
type Capture = { scope: Readonly<LanguageProjectScope>; snapshot: RegistrySnapshot; action: () => void;
  operation: RegistryCaptureOperationHint | undefined; argumentCount: number; lease: number };
type Owner = { phase: Phase; snapshot: RegistrySnapshot; launch: RegistryLaunch; starts: number; retirements: number; changes: OpenOrChange[] };
function fixture(t: TestContext, mode: 'hint' | 'legacy' | 'no-hook' = 'hint') {
  const clock = new Clock(), captures: Capture[] = [], owners: Owner[] = [], events: string[] = [];
  let revision = 'r1', documents = [document()], held = false, lease = 0, refreshes = 0;
  let before: ((c: Capture) => Promise<void>) | undefined, after: ((c: Capture) => void) | undefined;
  let omit = false, releaseFailure = false;
  const perform: NonNullable<RegistryFactory['withCaptureLease']> = async function(scope, snapshot, action, operation) {
    const c: Capture = { scope, snapshot, action, operation, argumentCount: arguments.length, lease: ++lease };
    captures.push(c); await before?.(c); assert.equal(held, false); held = true; events.push(`held:${c.lease}`);
    try {
      if (!omit) { action(); events.push(`action:${c.lease}`); }
      after?.(c);
      if (releaseFailure) throw Error('UNIT final release failure');
    } finally { events.push(`release:${c.lease}`); held = false; }
  };
  // This function REALLY declares only three parameters; structural compatibility is typechecked.
  const legacy: NonNullable<RegistryFactory['withCaptureLease']> = async function(scope, snapshot, action) {
    await perform(scope, snapshot, action);
  };
  const factory: RegistryFactory = {
    ...(mode === 'no-hook' ? {} : { withCaptureLease: mode === 'legacy' ? legacy : perform }),
    create(_scope, phase, snapshot) {
      assert.equal(held, mode !== 'no-hook', 'owner transfer occurs inside SAME observed lease');
      events.push(`create:${phase}:${lease}`);
      const launchId = `${phase}-${owners.length + 1}`, hash = 'a'.repeat(64);
      const generation = phase === 'diagnostics' ? {
        launchId, inputManifestSha256: hash, wholeProjectManifestPath: `/unit/${launchId}/manifest.json`, immutableShadowDirectory: `/unit/${launchId}/workspace`,
        policy: 'IMMUTABLE_WHOLE_PROJECT' as const, maxAnalysisMs: LANGUAGE_LIMITS.diagnosticAnalysisMs,
        retirementDeadlineMs: LANGUAGE_LIMITS.diagnosticRetirementMs,
        sources: snapshot.documents.map(d => ({ sourceStamp: d.stamp,
          provenance: { kind: 'IMMUTABLE_GENERATION' as const, launchId, lspVersion: 1, inputManifestSha256: hash } })),
      } : null;
      const owner: Owner = { phase, snapshot, launch: null!, starts: 0, retirements: 0, changes: [] };
      const session: RegistrySession = {
        launchId,
        async start() { assert.equal(held, false, 'provider starts ONLY after lease return'); owner.starts++; events.push(`start:${phase}`); },
        async open() {}, async change(d) { assert.equal(held, false); owner.changes.push(d); }, async close() {},
        cancelCompletions() {}, cancel() {}, invalidate() {},
        async complete(r) { return { requestId: r.requestId, stamp: r.stamp, items: [], isIncomplete: false }; },
        async retire() { owner.retirements++; events.push(`retire:${phase}:${held}`); return { confirmed: true, removed: true, problem: null }; },
      };
      owner.launch = { session, generation }; owners.push(owner); return owner.launch;
    },
    refreshCompletion(_scope, _snapshot, launch) {
      assert.equal(held, mode !== 'no-hook'); assert.equal(launch.session, owners.find(o => o.phase === 'completion')!.launch.session);
      refreshes++; events.push(`refresh:${lease}`); return true;
    },
  };
  const ledger = new LanguageAckLedger({ readCurrent: () => null, readAnalysisSource: () => null, readCommittedSave: () => null }, codec);
  const registry = new LanguageFeatureRegistry({ clock, factory, ackLedger: ledger,
    authority: { capture: () => ({ revision, documents }), isCurrent: (_scope, snapshot) => snapshot.revision === revision } });
  t.after(async () => { await registry.disposeProject(project); });
  return { registry, clock, captures, owners, events,
    get held() { return held; }, get refreshes() { return refreshes; },
    before(fn: (c: Capture) => Promise<void>) { before = fn; }, after(fn: (c: Capture) => void) { after = fn; },
    omitAction() { omit = true; }, failRelease() { releaseFailure = true; },
    edit() { revision = 'r2'; documents = [document(2)]; return documents[0]; },
    async launch() { await registry.startProject(project); await tick(); await clock.diagnostics(); },
  };
}
function hints(captures: Capture[]) { return captures.map(c => c.operation); }

test('actual initial CREATE captures BOTH lanes, fresh frozen exact scheduling hints and same-lease handoff', async t => {
  const f = fixture(t); await f.launch();
  assert.deepEqual(hints(f.captures), [{ kind: 'CREATE', phase: 'completion' }, { kind: 'CREATE', phase: 'diagnostics' }]);
  assert.notEqual(f.captures[0].operation, f.captures[1].operation);
  for (const c of f.captures) {
    assert.equal(c.argumentCount, 4); assert.ok(Object.isFrozen(c.operation));
    assert.deepEqual(Object.keys(c.operation!).sort(), ['kind', 'phase']);
    assert.throws(() => { (c.operation as { kind: string }).kind = 'REFRESH'; }, TypeError);
    assert.equal(c.scope.projectId, project.projectId); assert.equal(c.snapshot.revision, 'r1');
    assert.deepEqual(c.snapshot.documents, [document()]);
    const phase = c.operation!.phase;
    assert.ok(f.events.indexOf(`held:${c.lease}`) < f.events.indexOf(`create:${phase}:${c.lease}`));
    assert.ok(f.events.indexOf(`create:${phase}:${c.lease}`) < f.events.indexOf(`release:${c.lease}`));
    assert.ok(f.events.indexOf(`release:${c.lease}`) < f.events.indexOf(`start:${phase}`));
  }
  assert.deepEqual(f.owners.map(o => [o.phase, o.starts]), [['completion', 1], ['diagnostics', 1]]);
  assert.equal(f.held, false);
});
test('real active completion REFRESH preserves owner; invalidated diagnostics is genuine new CREATE, never REFRESH', async t => {
  const f = fixture(t); await f.launch(); const completion = f.owners[0], diagnostic = f.owners[1];
  const next = f.edit(); await f.registry.change(next); await tick(); await f.clock.diagnostics();
  assert.deepEqual(hints(f.captures), [
    { kind: 'CREATE', phase: 'completion' }, { kind: 'CREATE', phase: 'diagnostics' },
    { kind: 'REFRESH', phase: 'completion' }, { kind: 'CREATE', phase: 'diagnostics' },
  ]);
  assert.equal(f.refreshes, 1); assert.equal(f.owners.filter(o => o.phase === 'completion').length, 1);
  assert.equal(completion.retirements, 0); assert.deepEqual(completion.changes, [next]);
  assert.equal(diagnostic.retirements, 1); assert.equal(f.owners[2].phase, 'diagnostics'); assert.equal(f.owners[2].starts, 1);
  assert.equal(f.captures[2].snapshot.revision, 'r2'); assert.equal(f.captures[3].snapshot.revision, 'r2');
  assert.equal(new Set(f.captures.map(c => c.operation)).size, 4);
});
for (const phase of ['completion', 'diagnostics'] as const) {
  test(`delayed ${phase} CREATE hint has no authority after epoch revoke: no create/provider`, async t => {
    const f = fixture(t), gate = deferred();
    if (phase === 'diagnostics') { await f.registry.startProject(project); await tick(); }
    f.before(async () => gate.promise);
    if (phase === 'completion') { await f.registry.startProject(project); await tick(); }
    else await f.clock.diagnostics();
    const waiting = f.captures.at(-1)!; assert.deepEqual(waiting.operation, { kind: 'CREATE', phase });
    const count = f.owners.length; f.registry.invalidateSource(project);
    gate.resolve(); await tick();
    assert.equal(f.owners.length, count); assert.equal(f.owners.some(o => o.phase === phase), false);
    assert.equal(f.held, false); assert.throws(waiting.action, /exactly once within its lease/);
  });
}
test('same-epoch authority-currentness failure cannot authorize CREATE merely from frozen hint', async t => {
  const f = fixture(t), gate = deferred(); f.before(async () => gate.promise);
  await f.registry.startProject(project); await tick(); f.edit(); gate.resolve(); await tick();
  assert.deepEqual(f.captures[0].operation, { kind: 'CREATE', phase: 'completion' });
  assert.equal(f.owners.length, 0);
});
test('duplicate synchronous and late callbacks rejected; action and provider applied only once', async t => {
  const f = fixture(t); f.after(c => assert.throws(c.action, /exactly once within its lease/)); await f.launch();
  assert.equal(f.owners.length, 2); assert.deepEqual(f.owners.map(o => o.starts), [1, 1]);
  for (const c of f.captures) assert.throws(c.action, /exactly once within its lease/);
  assert.equal(f.owners.length, 2);
});
test('omitted lease action fails, callback arriving after return cannot launch a provider', async t => {
  const f = fixture(t); f.omitAction(); await f.registry.startProject(project); await tick();
  assert.equal(f.owners.length, 0); assert.throws(f.captures[0].action, /exactly once within its lease/);
  assert.equal(f.owners.length, 0);
});
test('owner is retained before final lease release failure; same owner retired with zero provider starts', async t => {
  const f = fixture(t); f.failRelease(); await f.registry.startProject(project); await tick();
  assert.equal(f.owners.length, 1); assert.equal(f.owners[0].starts, 0); assert.equal(f.owners[0].retirements, 1);
  assert.deepEqual(f.events, ['held:1', 'create:completion:1', 'action:1', 'release:1', 'retire:completion:false']);
});
test('disposal from SAME lease after action sees retained owner before release, cannot start provider', async t => {
  const f = fixture(t); let disposal: Promise<unknown> | undefined;
  f.after(() => { disposal = f.registry.disposeProject(project); assert.equal(f.owners[0].retirements, 1); });
  await f.registry.startProject(project); await tick(); await disposal;
  assert.equal(f.owners.length, 1); assert.equal(f.owners[0].starts, 0);
  assert.ok(f.events.indexOf('retire:completion:true') < f.events.indexOf('release:1'));
});
for (const mode of ['legacy', 'no-hook'] as const) {
  test(`${mode}: genuine existing three-argument/no-hook factory remains compatible for both lanes and refresh`, async t => {
    const f = fixture(t, mode); await f.launch(); const next = f.edit(); await f.registry.change(next); await tick(); await f.clock.diagnostics();
    assert.equal(f.refreshes, 1); assert.deepEqual(f.owners.map(o => [o.phase, o.starts]), [['completion', 1], ['diagnostics', 1], ['diagnostics', 1]]);
    assert.deepEqual(f.owners[0].changes, [next]);
    if (mode === 'legacy') { assert.equal(f.captures.length, 4); assert.ok(f.captures.every(c => c.operation === undefined)); }
    else assert.equal(f.captures.length, 0);
  });
}
