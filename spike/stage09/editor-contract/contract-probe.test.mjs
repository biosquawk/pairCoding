import test from 'node:test';
import assert from 'node:assert/strict';
import { modelUri, containerUri, fromModelUri, fromContainerUri, validatePath, normalizeLF,
  toLsp, fromLsp, applyAtomicEdits, AcceptanceFence, acceptDiagnostics, stampKeys, sameStamp } from './contract-probe.mjs';
const path = 'źródła z luką/Żółw😀.java';
const stamp = () => ({ projectId: 'Project:A', sessionId: 's1', connectionGeneration: 'c1', path,
  profileId: 'java-maven-27', configurationGeneration: 'cfg1', providerGeneration: 'pg1', shadowGeneration: 'sg1',
  modelLifetime: 'm1', localModelVersion: 7, baseDocumentVersion: 3, documentVersion: null,
  contentSha256: 'a'.repeat(64), controlEpoch: 9, requestGeneration: 12 });
const state = () => ({ owner: 'STUDENT', synced: true, providerOn: true, preparing: false, vetoPending: false, conflict: false, readOnly: false });
const r = (a, b) => ({ startLine: 1, startColumn: a, endLine: 1, endColumn: b });
const item = () => ({ id: 'i1', label: 'new', detail: null, primary: { path, range: r(1, 4), text: 'new' }, additionalTextEdits: [] });
function opened() {
  const fence = new AcceptanceFence(), s = stamp(), st = state();
  const reply = fence.request('r1', s, st, 'old'); assert.equal(fence.show(reply, s, st), true);
  return { fence, s, st, reply };
}
test('URI roundtrips spaces, Polish, nonBMP, literal % and reserved characters; IDs keep case/colon', () => {
  for (const p of [path, 'a/%2e%2e.txt', 'a/#?.py', 'src/main/Main.java']) {
    const uri = modelUri('Project:A', p);
    assert.equal(fromModelUri('Project:A', uri), p);
    assert.equal(fromContainerUri(containerUri(p)), p);
    assert.throws(() => fromModelUri('project:a', uri));
  }
});
test('reject traversal/aliases/devices/control/invalid encodings/root/project/query', () => {
  for (const p of ['', '/', '../x', 'a/../b', './x', 'a//b', 'a\\b', 'C:/x', 'a/NUL.txt', 'con', 'a. ', 'a.', 'a/\n', 'x/'])
    assert.throws(() => validatePath(p), p);
  const prefix = modelUri('p1', 'x').slice(0, -1);
  for (const tail of ['%2e%2e/x', '%2Fetc', '%5Cb', '%C0%AF', '%', 'x?query', 'x#frag', '%78', 'a/../x'])
    assert.throws(() => fromModelUri('p1', prefix + tail), tail);
  assert.throws(() => fromContainerUri('file:///workspacex/a'));
  assert.throws(() => fromContainerUri('file:///workspace/../secret'));
  assert.throws(() => modelUri('x@y', 'a'));
});
test('UTF16 offsets and CRLF normalization never use UTF8 byte or codepoint counts', () => {
  const text = 'ą😀z\r\nŻółw\r\n';
  assert.equal(normalizeLF(text), 'ą😀z\nŻółw\n');
  for (const p of [{ line: 1, column: 1 }, { line: 1, column: 2 }, { line: 1, column: 4 },
    { line: 1, column: 5 }, { line: 2, column: 5 }, { line: 3, column: 1 }])
    assert.deepEqual(fromLsp(text, toLsp(text, p)), p);
  assert.deepEqual(toLsp(text, { line: 1, column: 4 }), { line: 0, character: 3 });
  assert.throws(() => toLsp(text, { line: 1, column: 3 }));
  for (const p of [{ line: 0, column: 1 }, { line: 4, column: 1 }, { line: 1, column: 6 }, { line: 1, column: 1.5 }]) assert.throws(() => toLsp(text, p));
  assert.equal(normalizeLF('a\rb'), 'a\rb');
});
test('same-document primary + additional edits are atomic; invalid edit leaves input unchanged', () => {
  const text = 'old abc';
  const edits = [{ path, range: r(1, 4), text: 'new' }, { path, range: r(5, 8), text: 'xyz' }];
  assert.equal(applyAtomicEdits(text, path, edits), 'new xyz');
  for (const bad of [{ path: 'other.java', range: r(5, 8), text: 'x' }, { path, range: r(3, 6), text: 'x' },
    { path, range: r(9, 10), text: 'x' }, { path, range: r(7, 6), text: 'x' }]) {
    assert.throws(() => applyAtomicEdits(text, path, [edits[0], bad]));
    assert.equal(text, 'old abc');
  }
  assert.throws(() => applyAtomicEdits(text, path, [{ path, range: r(1, 1), text: 'x' }, { path, range: r(1, 1), text: 'y' }]));
  assert.throws(() => applyAtomicEdits('ą😀', path, [{ path, range: r(2, 3), text: 'x' }]));
});
test('ordinary STUDENT completion yields one prospective edit, cannot be accepted twice', () => {
  const { fence, s, st, reply } = opened();
  assert.equal(fence.accept(reply, s, st, 'old', item()), 'new');
  assert.throws(() => fence.accept(reply, s, st, 'old', item()));
  assert.equal(fence.visible, false);
});
test('every correlation dimension rejects display/acceptance after a change', () => {
  for (const key of stampKeys) {
    const { fence, s, st, reply } = opened();
    s[key] = typeof s[key] === 'number' ? s[key] + 1 : `${s[key]}changed`;
    assert.equal(fence.show(reply, s, st), false, key);
    assert.throws(() => fence.accept(reply, s, st, 'old', item()), key);
  }
  assert.equal(sameStamp({}, {}), false);
});
test('Tab/Enter acceptance rechecks permission/version AFTER widget opened, without React render', () => {
  for (const [key, value] of [['owner', 'COACH'], ['owner', 'SYNCING'], ['preparing', true], ['vetoPending', true],
    ['synced', false], ['providerOn', false], ['conflict', true], ['readOnly', true]]) {
    const { fence, s, st, reply } = opened(); st[key] = value;
    assert.throws(() => fence.accept(reply, s, st, 'old', item()), key);
  }
});
test('CONTROL_PREPARE closes/cancels synchronously BEFORE frame; Enter then no-op', () => {
  const { fence, s, st, reply } = opened();
  st.preparing = true; fence.invalidate();
  assert.equal(fence.visible, false); assert.deepEqual(fence.cancelled, ['r1']);
  assert.throws(() => fence.accept(reply, s, st, 'old', item()));
  st.owner = 'COACH'; st.preparing = false;
  assert.equal(fence.show(reply, s, st), false);
});
test('veto optimistic STUDENT and eventual fresh epoch never resurrect pre-veto request', () => {
  const { fence, s, st, reply } = opened();
  fence.invalidate(); st.vetoPending = true;
  assert.equal(fence.request('during-veto', s, st, 'old'), null);
  st.vetoPending = false; s.controlEpoch++; s.requestGeneration++;
  const next = fence.request('fresh', s, st, 'old');
  assert.equal(fence.show(reply, s, st), false);
  assert.equal(fence.show(next, s, st), true);
});
test('commands/workspace edits/snippets and multifile additional edits are rejected as a unit', () => {
  for (const extra of [{ command: { command: 'evil' } }, { insertTextRules: 4 }, { workspaceEdit: {} }, { textEdit: {} }]) {
    const { fence, s, st, reply } = opened();
    assert.throws(() => fence.accept(reply, s, st, 'old', { ...item(), ...extra }));
  }
  const { fence, s, st, reply } = opened(), candidate = item();
  candidate.additionalTextEdits.push({ path: 'Other.java', range: r(1, 1), text: 'write' });
  assert.throws(() => fence.accept(reply, s, st, 'old', candidate));
});
test('unversioned mutable push is rejected even if relabelled current, idle or reopened', () => {
  const s = stamp();
  const event = { stamp: s, version: null };
  for (const extra of [{}, { idle: true }, { reopened: true }, { latestAck: 3 }, { neverMutated: true }])
    assert.equal(acceptDiagnostics(event, s, { generation: s.providerGeneration, mode: 'MUTABLE', ...extra }), false);
});
test('versioned and pull diagnostics need stored sent-version/request map, not receipt-time stamp', () => {
  const s = stamp(), prior = { ...s, localModelVersion: 6 };
  const provider = { generation: s.providerGeneration, mode: 'MUTABLE', versions: new Map([[7, s], [6, prior]]) };
  assert.equal(acceptDiagnostics({ stamp: s, version: 7 }, s, provider), true);
  assert.equal(acceptDiagnostics({ stamp: s, version: 6 }, s, provider), false);
  assert.equal(acceptDiagnostics({ stamp: s, version: 8 }, s, provider), false);
  const pull = { generation: s.providerGeneration, mode: 'PULL', requests: new Map([['r1', s], ['r0', prior]]) };
  assert.equal(acceptDiagnostics({ stamp: s, version: null, requestId: 'r1' }, s, pull), true);
  assert.equal(acceptDiagnostics({ stamp: s, version: null, requestId: 'r0' }, s, pull), false);
  assert.equal(acceptDiagnostics({ stamp: s, version: null, requestId: 'unknown' }, s, pull), false);
});
test('immutable-generation unversioned fence needs non-reused process + whole-project fixed stamp', () => {
  const s = stamp();
  const provider = { generation: s.providerGeneration, mode: 'IMMUTABLE', neverMutated: true,
    manifestSha256: 'b'.repeat(64), fixedStamp: structuredClone(s) };
  const event = { stamp: structuredClone(s), version: null };
  assert.equal(acceptDiagnostics(event, s, provider), true);
  for (const key of stampKeys) {
    const current = { ...s, [key]: `${s[key]}changed` };
    assert.equal(acceptDiagnostics(event, current, provider), false, key);
  }
  assert.equal(acceptDiagnostics(event, s, { ...provider, neverMutated: false }), false);
  assert.equal(acceptDiagnostics(event, s, { ...provider, manifestSha256: null }), false);
  assert.equal(acceptDiagnostics({ ...event, version: 99 }, s, provider), false);
});
test('all mutation/rebind boundaries invalidate old request even if content is equal after Undo', () => {
  for (const reason of ['TYPING', 'COMPLETION', 'UNDO', 'REDO', 'COACH_STEP_EDIT', 'EXTERNAL_FILE_SYNC',
    'RESTORE_SNAPSHOT', 'DRAFT_RECOVERY', 'CREATE', 'RENAME', 'DELETE', 'CLOSE', 'PROJECT', 'PROFILE', 'SESSION', 'DISCONNECT', 'ACK']) {
    const { fence, s, st, reply } = opened(); fence.invalidate();
    assert.equal(fence.show(reply, s, st), false, reason);
  }
});

test('acceptance checks actual buffer synchronously even if metadata is accidentally unchanged', () => {
  const { fence, s, st, reply } = opened();
  assert.throws(() => fence.accept(reply, s, st, 'changed', item()));
});

import { validateRunProfilesV2 } from './contract-probe.mjs';
const profile = () => ({ kind: 'RUN_MAIN', task: { workingDirectory: '.', entry: { kind: 'JAVA_MAIN', className: 'other.example.Main' }, tests: { paths: [], names: [] } }, timeoutMs: 10000 });
test('RunProfileV2 neutral data roundtrip, explicit disable, and legacy host keys fail closed preserving input', () => {
  const p = profile(), original = JSON.stringify(p);
  assert.deepEqual(validateRunProfilesV2([p]), [p]);
  assert.deepEqual(validateRunProfilesV2([]), []);
  assert.equal(JSON.stringify(p), original);
  for (const old of [{ kind: 'RUN_MAIN', executable: 'node', args: ['a.js'], cwd: '.', timeoutMs: 10000, testReportFormat: 'NONE', testReportGlob: null },
    { ...p, executable: 'node' }, { ...p, image: 'arbitrary' }, { ...p, args: ['--privileged'] }, { ...p, dockerArgs: ['-v', '/:/host'] }]) {
    const copy = JSON.stringify(old); assert.throws(() => validateRunProfilesV2([old])); assert.equal(JSON.stringify(old), copy);
  }
  assert.throws(() => validateRunProfilesV2([p, p]));
});
test('task entry variants are data; reject path traversal/host flags/unsafe selectors and extra fields', () => {
  for (const entry of [{ kind: 'SCRIPT', path: 'different folder/program.py' }, { kind: 'MODULE', name: 'other.application' },
    { kind: 'SPRING_BOOT', containerPort: 8080, healthPath: '/actuator/health' }]) {
    const p = profile(); p.task.entry = entry; assert.deepEqual(validateRunProfilesV2([p]), [p]);
  }
  for (const entry of [{ kind: 'SCRIPT', path: '../outside' }, { kind: 'MODULE', name: '-m malicious' },
    { kind: 'JAVA_MAIN', className: 'java -jar x' }, { kind: 'SPRING_BOOT', containerPort: 80, healthPath: '/health' },
    { kind: 'SPRING_BOOT', containerPort: 8080, healthPath: 'http://external' }]) {
    const p = profile(); p.task.entry = entry; assert.throws(() => validateRunProfilesV2([p]));
  }
  const p = profile(); p.task.tests.names = ['--flag']; assert.throws(() => validateRunProfilesV2([p]));
});

import { rebindDiagnosticsOnAck } from './contract-probe.mjs';
function ackFixture(mode = 'VERSIONED') {
  const before = stamp(), after = { ...before, documentVersion: 4, baseDocumentVersion: 4, requestGeneration: 13 };
  const provider = { generation: before.providerGeneration, mode, versions: new Map([[7, before]]),
    requests: new Map([['d1', before]]), neverMutated: true, manifestSha256: 'b'.repeat(64), fixedStamp: before };
  const ack = { replyTo: 'save-1', status: 'OK', documentVersion: 4 };
  const flight = { messageId: 'save-1', path, baseVersion: 3, modelLifetime: 'm1', localModelVersion: 7,
    contentSha256: before.contentSha256, content: 'same live buffer' };
  return { before, after, provider, ack, flight };
}
test('verified preACK→ACK-only rebind keeps correct diagnostics live without another didChange/process', () => {
  for (const mode of ['VERSIONED', 'PULL', 'IMMUTABLE']) {
    const { before, after, provider, ack, flight } = ackFixture(mode);
    const wire = mode === 'VERSIONED' ? { version: 7 } : mode === 'PULL' ? { version: null, requestId: 'd1' } : { version: null };
    assert.equal(acceptDiagnostics({ stamp: before, ...wire }, before, provider), true);
    assert.equal(acceptDiagnostics({ stamp: after, ...wire }, after, provider), false, 'original draft liveness gap retained as control');
    const rebound = rebindDiagnosticsOnAck(provider, before, after, ack, flight, flight.content);
    // Adapter builds event stamp from explicit rebound version/request/fixed map, not current-on-receipt metadata.
    const mapped = mode === 'VERSIONED' ? rebound.versions.get(7) : mode === 'PULL' ? rebound.requests.get('d1') : rebound.fixedStamp;
    assert.equal(acceptDiagnostics({ stamp: mapped, ...wire }, after, rebound), true, mode);
    assert.equal(sameStamp(provider.versions.get(7), before), true, 'original map untouched');
    assert.equal(acceptDiagnostics({ stamp: before, ...wire }, after, rebound), false, 'pre-built stale wire event is not auto-retagged');
  }
});
test('ACK rebind cannot relabel different content/model/dependency/project/epoch or unverified receipt', () => {
  const { before, after, provider, ack, flight } = ackFixture();
  for (const key of stampKeys.filter(k => !['baseDocumentVersion', 'documentVersion', 'requestGeneration'].includes(k))) {
    const changed = { ...after, [key]: typeof after[key] === 'number' ? after[key] + 1 : `${after[key]}changed` };
    assert.throws(() => rebindDiagnosticsOnAck(provider, before, changed, ack, flight, flight.content), key);
  }
  for (const badAck of [{ ...ack, replyTo: 'unknown' }, { ...ack, status: 'REJECTED' }, { ...ack, documentVersion: 3 }, { ...ack, documentVersion: 5 }])
    assert.throws(() => rebindDiagnosticsOnAck(provider, before, after, badAck, flight, flight.content));
  for (const badFlight of [{ ...flight, baseVersion: 2 }, { ...flight, contentSha256: 'c'.repeat(64) },
    { ...flight, modelLifetime: 'old' }, { ...flight, localModelVersion: 6 }, { ...flight, path: 'Other.java' }])
    assert.throws(() => rebindDiagnosticsOnAck(provider, before, after, ack, badFlight, flight.content));
  assert.throws(() => rebindDiagnosticsOnAck(provider, before, after, ack, flight, 'new content'));
  assert.throws(() => rebindDiagnosticsOnAck(provider, before, { ...after, requestGeneration: 12 }, ack, flight, flight.content));
  const oldVersion = { ...before, localModelVersion: 6 }, p = { ...provider, versions: new Map([[6, oldVersion]]) };
  const rebound = rebindDiagnosticsOnAck(p, before, after, ack, flight, flight.content);
  assert.equal(acceptDiagnostics({ stamp: after, version: 6 }, after, rebound), false, 'older analysis never upgraded');
});
