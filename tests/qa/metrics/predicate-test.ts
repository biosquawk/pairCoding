/** Synthetic unit controls only: NEVER evidence of native Monaco or integration. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { createMetricPredicates } from './observer-predicates';
import { metricObserverSource } from './observer';
import { percentile, MetricRecorder } from './observer-recorder';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const p = createMetricPredicates(), all = (filters: any) => Object.values(filters).every(Boolean);
const base = { inputId: 1, hostId: 2, panelId: 3, native: true, inputCount: 1, connected: true, visible: true,
  loaded: true, activePath: 'main.py', mode: 'python', owner: 'COACH', autocomplete: 'none', activeDescendant: null };
const ready = { ...base, owner: 'STUDENT', autocomplete: 'both' };
const keys = [{ at: 10, key: 'Escape', repeat: false, isTrusted: true }, { at: 100, key: 'Escape', repeat: false, isTrusted: true }];
const veto = { messageId: 'veto1', sessionId: 'session1', connection: 1, at: 100, controlEpoch: 26, lastServerSeq: 19 };
const ack = { replyTo: 'veto1', sessionId: 'session1', connection: 1, at: 180, controlEpoch: 27, seq: 22, status: 'OK', error: null };
const control = { sessionId: 'session1', connection: 1, at: 160, controlEpoch: 27, seq: 21, writeOwner: 'STUDENT', interventionId: null };
test('positive-shaped baseline/pair/readiness/ACK', () => {
  assert.equal(p.baseline(base), true); assert.equal(p.pair(keys), true);
  assert.equal(all(p.ready(base, ready, p.baseline(base), p.pair(keys), veto)), true);
  assert.equal(all(p.vetoAck(veto, ack, control)), true);
});
for (const [name, change] of Object.entries({ 'label but read-only': { autocomplete: 'none' },
  'both without STUDENT': { owner: 'COACH' }, detached: { connected: false }, hidden: { visible: false },
  wrongPath: { activePath: 'other.py' }, unloaded: { loaded: false }, wrongLanguage: { mode: 'plaintext' },
  legacyTextarea: { native: false }, replacedInput: { inputId: 4 }, replacedPanel: { panelId: 4 },
  twoInputs: { inputCount: 2 }, suggestionOverride: { activeDescendant: 'suggestion1' } })) {
  test(`readiness rejects ${name}`, () => assert.equal(all(p.ready(base, { ...ready, ...change }, true, true, veto)), false));
}
test('bad baseline / absent VETO / invalid pair never count', () => {
  assert.equal(p.baseline({ ...base, owner: 'STUDENT' }), false);
  assert.equal(p.baseline({ ...base, autocomplete: 'both' }), false);
  assert.equal(all(p.ready(base, ready, false, true, veto)), false);
  assert.equal(all(p.ready(base, ready, true, true, null)), false);
  assert.equal(all(p.ready(base, ready, true, false, veto)), false);
});
for (const [name, k] of Object.entries({ single: keys.slice(0, 1), gap: [keys[0], { ...keys[1], at: 411 }],
  repeat: [keys[0], { ...keys[1], repeat: true }], fake: [keys[0], { ...keys[1], isTrusted: false }],
  zeroGap: [keys[0], { ...keys[1], at: 10 }], reversed: [keys[0], { ...keys[1], at: 9 }] })) {
  test(`Escape pair rejects ${name}`, () => assert.equal(p.pair(k), false));
}
for (const [name, change] of Object.entries({ foreign: { replyTo: 'other' }, rejected: { status: 'REJECTED' },
  duplicate: { status: 'DUPLICATE' }, error: { error: { code: 'DENIED' } }, staleEpoch: { controlEpoch: 26 },
  wrongSession: { sessionId: 'session2' }, otherConnection: { connection: 2 }, beforeSend: { at: 90 }, oldSeq: { seq: 19 } })) {
  test(`ACK rejects ${name}`, () => assert.equal(all(p.vetoAck(veto, { ...ack, ...change }, control)), false));
}
test('local owner label is not server confirmation', () => {
  for (const c of [null, { ...control, writeOwner: 'COACH' }, { ...control, controlEpoch: 26 },
    { ...control, interventionId: 'active' }, { ...control, at: 181 }]) assert.equal(all(p.vetoAck(veto, ack, c)), false);
});
test('complete valid hint shape required', () => {
  const hint = { id: 'h1', path: 'main.py', text: 'visible hint', severity: 'NEUTRAL', documentVersion: 2, evidenceIds: [], range: null };
  assert.equal(p.hint(hint), true);
  for (const h of [{ ...hint, text: '' }, { ...hint, path: 'other.py' }, { ...hint, documentVersion: null }, { ...hint, severity: 'INVALID' }, { ...hint, range: undefined }, { ...hint, range: { startLine: 2, endLine: 1, startColumn: 1, endColumn: 1 } }]) {
    assert.equal(p.hint(h), false);
  }
});
test('nearest-rank keeps outliers/nulls', () => {
  assert.deepEqual(percentile(Array.from({ length: 100 }, (_, i) => i + 1)), { count: 100, missingOrInvalid: 0, p95: 95, max: 100 });
  assert.deepEqual(percentile([1, null, 1000]), { count: 3, missingOrInvalid: 1, p95: null, max: null });
});
test('actual serialized init script executes; no DOM fails closed', async () => {
  const fakeWindow: any = { addEventListener() {}, WebSocket: class {} };
  const context = vm.createContext({ window: fakeWindow, document: { addEventListener() {}, querySelectorAll: () => [] },
    MutationObserver: class { disconnect() {} observe() {} }, performance, setTimeout, clearTimeout, Promise, WeakMap, Set });
  new vm.Script(metricObserverSource()).runInContext(context);
  assert.throws(() => fakeWindow.__qaMetric.arm(0, 'qa_probe_0'), /UNSUPPORTED/);
  fakeWindow.__qaMetricRecord = async () => {};
  await fakeWindow.__qaMetric.flush();
});
test('durable raw retains rejected filters and redacts content; partial starts survive', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'paircoach-metric-unit-'));
  try {
    const r = new MetricRecorder({ outputPath: (file: string) => path.join(dir, file) } as any);
    r.record([{ kind: 'armed', trial: 0, marker: 'qa_probe_0', baseline: base, validBase: true },
    { kind: 'wire', direction: 'out', type: 'CODE_CHANGED', trial: 0, messageId: 'w1', at: 200,
      connection: 1, sessionId: 's', payload: { path: 'main.py', baseVersion: 3, controlEpoch: 2 }, content: '# qa_probe_0\nprivate text\n' },
    { kind: 'wire', direction: 'in', type: 'ACK', at: 230, connection: 1, sessionId: 's',
      payload: { replyTo: 'w1', status: 'REJECTED', error: { code: 'DENIED' }, documentVersion: 3, controlEpoch: 2 } }]);
    const pair = r.pairs([{ trial: 0, marker: 'qa_probe_0' }])[0].writes[0];
    assert.equal(pair.filters.exactMarker, true); assert.equal(pair.acknowledgements[0].filters.statusOK, false);
    assert.equal(pair.filters.exactDisk, false); assert.equal(pair.filters.completedOracle, false);
    assert.equal(readFileSync(r.streamPath, 'utf8').includes('private text'), false);
    assert.match(readFileSync(r.streamPath, 'utf8'), /contentEvidence/);
    assert.equal(r.pairs([{ trial: 0, marker: 'qa_probe_WRONG' }])[0].writes[0].filters.exactMarker, false);
    assert.equal(r.recoverObserved(null).vetoes[0].localMs, null);
    assert.equal(r.recoverObserved(null).vetoes[0].marker, 'qa_probe_0');
    r.record([{ kind: 'secondEscape', trial: 0, at: 100, validAtEscape: true },
      { kind: 'ready', trial: 0, observedAt: 120 }, { kind: 'vetoAck', trial: 0, ackMs: 40 }]);
    const recovered = r.recoverObserved({ vetoes: [{ trial: 0, localMs: null, ackMs: null }] });
    assert.equal(recovered.vetoes[0].localMs, 20); assert.equal(recovered.vetoes[0].ackMs, 40);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('recorder IO failure throws and remains explicit, not swallowed into PASS', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'paircoach-metric-error-'));
  const r = new MetricRecorder({ outputPath: (file: string) => path.join(dir, file) } as any);
  rmSync(dir, { recursive: true, force: true });
  assert.throws(() => r.record([{ kind: 'syntheticIOControl' }]), /ENOENT/);
  assert.equal(r.errors.length, 1); assert.equal(r.errors[0].stage, 'durableStream');
});
