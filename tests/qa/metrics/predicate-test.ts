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

// Synthetic DOM locator controls, NOT native/browser evidence. Run the actual serialized observer.
// Independent structure: Monaco codeEditorWidget stores data-mode-id on its supplied create host,
// not necessarily on the inner .monaco-editor. Nearest ancestor owns the language; siblings do not.
for (const [name, innerMode, parentMode, outerMode, expected] of [
  ['ancestor python', null, 'python', null, 'python'],
  ['direct python', 'python', null, null, 'python'],
  ['missing language rejects', null, null, null, null],
  ['plaintext ancestor rejects', null, 'plaintext', null, 'plaintext'],
  ['nearest plaintext blocks outer python', null, 'plaintext', 'python', 'plaintext'],
  ['sibling python does not authorize', null, null, null, null],
] as const) {
  test(`actual serialized observer reads language: ${name}`, async () => {
    const node = (parent: any = null, mode: string | null = null): any => ({
      parentElement: parent, isConnected: true,
      getClientRects: () => [{}], getBoundingClientRect: () => ({ width: 10, height: 10 }),
      getAttribute: (key: string) => key === 'data-mode-id' ? mode : null,
      hasAttribute: (key: string) => key === 'data-mode-id' && mode !== null,
      classList: { contains: () => false }, querySelector: () => null,
      closest(selector: string) {
        if (selector !== '[data-mode-id]') return null;
        for (let n: any = this; n; n = n.parentElement) if (n.hasAttribute('data-mode-id')) return n;
        return null;
      },
    });
    const outer = node(null, outerMode), parent = node(outer, parentMode), host = node(parent, innerMode);
    const panel = node(), header = node(panel), input = node(host), view = node(host);
    panel.classList.contains = (c: string) => c === 'border-blue-500';
    panel.firstElementChild = header;
    header.querySelector = (selector: string) => selector.includes('aria-selected') ? { textContent: 'main.py' }
      : selector === 'span.text-blue-400' ? { textContent: 'Pisze Trener AI' } : null;
    input.classList.contains = (c: string) => c === 'native-edit-context';
    input.getAttribute = (key: string) => key === 'aria-autocomplete' ? 'none' : null;
    host.querySelectorAll = () => [input];
    host.querySelector = (selector: string) => selector === '.view-lines' ? view : input;
    const nearest = host.closest;
    host.closest = (selector: string) => selector === '[class~="border-[4px]"]' ? panel : nearest.call(host, selector);
    const sibling = node(parent, 'python'); // Present in document, deliberately outside host's ancestor chain.
    const win: any = { addEventListener() {}, WebSocket: class {}, __qaMetricRecord: async () => {} };
    const context = vm.createContext({ window: win, document: { addEventListener() {},
      querySelectorAll: (selector: string) => selector === '.monaco-editor' ? [host] : [sibling] },
      getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1' }),
      MutationObserver: class { disconnect() {} observe() {} }, performance, setTimeout, clearTimeout, Promise, WeakMap, Set });
    new vm.Script(metricObserverSource()).runInContext(context);
    try {
      if (expected === 'python') assert.equal(win.__qaMetric.arm(0, 'qa_probe_0').mode, 'python');
      else assert.throws(() => win.__qaMetric.arm(0, 'qa_probe_0'), /UNSUPPORTED/);
      const observed = win.__qaMetric.output.vetoes[0];
      assert.equal(observed.baseline.mode, expected);
      assert.equal(observed.validBase, expected === 'python');
      for (const key of ['native', 'connected', 'visible', 'loaded']) assert.equal(observed.baseline[key], true);
      assert.equal(observed.baseline.owner, 'COACH');
      assert.equal(observed.baseline.autocomplete, 'none');
    } finally { await win.__qaMetric.flush(); }
  });
}

import { observerControl } from './observer-controls';
import { calibrationMarkerEvidence } from './observer';
import { transformSync } from 'esbuild';
import { createRequire } from 'node:module';

for (const kind of ['current', 'stale', 'unknown', 'foreign session', 'foreign connection', 'wrong path', 'wrong request version', 'advance before render', 'external advance before render', 'ACK advance before render', 'pending write', 'matching write ACK', 'orphan ACK', 'rejected write ACK'] as const) {
  test(`actual serialized hint observer: ${kind}`, async () => {
    const h = observerControl();
    h.snapshot(kind === 'unknown' || kind === 'orphan ACK' ? null : kind === 'matching write ACK' || kind === 'rejected write ACK' ? 7 : 8);
    if (kind === 'pending write' || kind === 'matching write ACK' || kind === 'rejected write ACK') {
      h.socket.send(JSON.stringify({ type: 'CODE_CHANGED', messageId: 'write1', sessionId: 's1',
        payload: { path: 'main.py', content: 'synthetic', baseVersion: 7 } }));
      if (kind === 'matching write ACK') h.incoming('ACK', { replyTo: 'write1', status: 'OK', error: null, documentVersion: 8 });
    }
    if (kind === 'orphan ACK') h.incoming('ACK', { replyTo: 'unknownWrite', status: 'OK', error: null, documentVersion: 8 });
    if (kind === 'rejected write ACK') h.incoming('ACK', { replyTo: 'write1', status: 'REJECTED', error: { code: 'DENIED' }, documentVersion: 8 });
    h.request(kind === 'wrong request version' ? 7 : 8);
    const other = kind === 'foreign connection' ? new h.win.WebSocket('ws://synthetic-other') : h.socket;
    h.hint(kind === 'stale' ? 7 : 8, kind === 'wrong path' ? 'other.py' : 'main.py', kind === 'foreign session' ? 'foreign' : 's1', other);
    if (kind === 'advance before render') h.incoming('COACH_STEP_EDIT', { path: 'main.py', version: 9 });
    if (kind === 'external advance before render') h.incoming('EXTERNAL_FILE_SYNC', { path: 'main.py', version: 9, operation: 'MODIFIED' });
    if (kind === 'ACK advance before render') {
      h.socket.send(JSON.stringify({ type: 'CODE_CHANGED', messageId: 'laterWrite', sessionId: 's1',
        payload: { path: 'main.py', content: 'synthetic later edit', baseVersion: 8 } }));
      h.incoming('ACK', { replyTo: 'laterWrite', status: 'OK', error: null, documentVersion: 9 });
    }
    h.render(); await h.flush();
    const sample = h.win.__qaMetric.output.hints[0];
    const accepted = kind === 'current' || kind === 'matching write ACK';
    assert.equal(sample.valid, accepted);
    assert.equal(sample.renderMs !== null, accepted);
    assert.equal(h.win.__qaMetric.output.recordingErrors.length, 0);
    assert.ok(h.records.some(e => e.hint?.id === 'hint1')); // Rejected receipt stays in durable stream.
    if (kind.includes('advance before render')) {
      assert.equal(sample.receiptFilters.currentVersion, true);
      assert.equal(sample.renderFilters.currentVersion, false);
      assert.ok(h.records.some(e => e.kind === 'hintRenderRejected'));
      const dir = mkdtempSync(path.join(os.tmpdir(), 'paircoach-hint-recovery-'));
      try {
        const recorder = new MetricRecorder({ outputPath: (file: string) => path.join(dir, file) } as any);
        recorder.record(h.records);
        const recovered = recorder.recoverObserved(null).hints[0];
        assert.equal(recovered.valid, false); assert.equal(recovered.renderMs, null);
        assert.equal(recovered.renderFilters.currentVersion, false);
        assert.match(readFileSync(recorder.streamPath, 'utf8'), /hintRenderRejected/);
      } finally { rmSync(dir, { recursive: true, force: true }); }
    }
  });
}

for (const kind of ['positive', 'missing marker', 'hidden marker', 'detached marker', 'replaced input', 'unloaded input', 'wrong path'] as const) {
  test(`actual positive DOM evidence function: ${kind}`, () => {
    const baseline = { inputId: 1, hostId: 2, panelId: 3 };
    const state = { ...ready, ...baseline, ...(kind === 'replaced input' ? { inputId: 4 } : {}),
      ...(kind === 'unloaded input' ? { loaded: false } : {}), ...(kind === 'wrong path' ? { activePath: 'other.py' } : {}) };
    const line = { parentElement: null, isConnected: kind !== 'detached marker', getClientRects: () => [{}],
      textContent: kind === 'missing marker' ? 'other text' : '# qa_calibration_student', hasAttribute: () => false };
    const context = vm.createContext({ window: { __qaMetric: { snapshot: () => state } },
      document: { querySelectorAll: () => [line] },
      getComputedStyle: () => ({ display: kind === 'hidden marker' ? 'none' : 'block', visibility: 'visible', opacity: '1' }) });
    // Function is exactly what page.evaluate executes, not a copied implementation of its filters.
    const filters = new vm.Script(`(${calibrationMarkerEvidence.toString()})(${JSON.stringify({ marker: 'qa_calibration_student', baseline })})`).runInContext(context);
    assert.equal(Object.values(filters).every(Boolean), kind === 'positive');
  });
}

// Execute the ACTUAL registered campaign callback, including its catch/finally/report, without a browser.
// Only setup/stimulus are controlled; actual MetricRecorder writes JSON/JSONL to disk.
for (const finalManifest of ['throw', 'null'] as const) {
  test(`actual campaign finally keeps original failure and durable raw when manifest ${finalManifest}`, async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'paircoach-finally-unit-'));
    try {
      const original = new Error('synthetic veto stimulus failure');
      let manifestCalls = 0, campaign: Function | null = null;
      const first = { reference: true, rootPath: dir, dataDir: dir, base: 'fixture', mainBytes: 10, vetoCutoffMs: [] };
      const fakeTest: any = (_name: string, cb: Function) => { if (_name.startsWith('AC-027 ')) campaign = cb; };
      fakeTest.extend = () => fakeTest;
      const fakeExpect = (actual: any) => ({ toBe: (expected: any) => assert.equal(actual, expected),
        toHaveLength: (n: number) => assert.equal(actual.length, n), toBeLessThanOrEqual: (n: number) => assert.ok(actual <= n),
        toBeVisible: () => assert.equal(actual.visible, true),
        toEqual: (expected: any) => assert.equal(JSON.stringify(actual), JSON.stringify(expected)) });
      const actualRequire = createRequire(import.meta.url);
      const hashes = actualRequire('./observer-recorder.ts').sourceHashes();
      const deps: Record<string, any> = {
        '@playwright/test': { test: fakeTest, expect: fakeExpect },
        './observer-recorder': actualRequire('./observer-recorder.ts'), './observer': { metricObserverSource: () => '' },
        '../e2e/browser-helpers': { manifest: () => {
          if (++manifestCalls < 4) return first;
          if (finalManifest === 'null') return null;
          throw new Error('synthetic final manifest unavailable');
        }, openEditor: async () => {}, chat: async () => {}, focusEditor: async () => {}, disk: () => '# qa_probe_0\n' },
        'node:fs': { readFileSync: () => JSON.stringify({ status: 'PASS', platform: 'win32', revision: 'a'.repeat(40),
          node: process.version, chromium: 'synthetic', sourceHashes: hashes }), readdirSync: () => Array(100), statSync: () => ({ size: 10 }) },
      };
      const context = vm.createContext({ exports: {}, process: { platform: 'win32', version: process.version,
        env: { PAIRCOACH_QA_REVISION: 'a'.repeat(40) } }, require: (key: string) => key in deps ? deps[key] : actualRequire(key) });
      const source = readFileSync('tests/qa/metrics/reference.spec.ts', 'utf8');
      new vm.Script(transformSync(source, { loader: 'ts', format: 'cjs', target: 'es2022' }).code).runInContext(context);
      const observed = { identity: { rootPath: dir, sessionId: 's1', connection: 1 }, vetoes: [], hints: [], recordingErrors: [], connections: [] };
      const page = { getByText: () => ({ visible: true }), exposeBinding: async () => {}, addInitScript: async () => {},
        evaluate: async () => observed, keyboard: { press: async () => { throw original; } } };
      const info = { outputPath: (file: string) => path.join(dir, file), attach: async () => {} };
      assert.ok(campaign);
      await assert.rejects(() => (campaign as Function)({ page, browser: { version: () => 'synthetic' } }, info), e => e === original);
      const report = JSON.parse(readFileSync(path.join(dir, 'AC027-reference.json'), 'utf8'));
      assert.equal(report.pairedFixture, false); assert.equal(report.partial, true);
      assert.equal(report.failure.phase, 'veto'); assert.equal(report.failure.name, 'Error');
      assert.equal(report.raw.metric001.length, 1); assert.equal(report.raw.metric001[0], null);
      assert.equal(report.raw.metric002[0], null); assert.equal(report.raw.metric003[0], null); assert.equal(report.raw.metric004[0], null);
      assert.ok(report.recordingErrors.some((e: any) => e.stage === 'finalManifest'));
      assert.match(readFileSync(path.join(dir, 'AC027-wire-and-dom.jsonl'), 'utf8'), /trialStart/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
}
