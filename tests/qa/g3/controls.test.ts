// Targeted harness/contract counter-controls. NOT a product E2E or Windows receipt.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { acknowledged, Wire } from './helpers';
import { programs, profile, denySnapshotWrites, type Fixture } from './fixture';
import { languageCases, invalidInputs, limitBytes, taskMarkdown, nonEmptyAlert } from './g3-basics';
import { require as tsRequire } from 'tsx/cjs/api';
const { validateMessage, validateRequest } = tsRequire('../../../src/server/transport.ts', import.meta.url) as typeof import('../../../src/server/transport');

test('G3 harness saved oracle rejects missing, unrelated, stale and failed ACK; positive exact real-frame shape', () => {
  const edit = { type: 'CODE_CHANGED', messageId: 'edit-1', payload: { path: 'main.py', content: 'literal\n', controlEpoch: 7, baseVersion: 9 } };
  const ack = { type: 'ACK', payload: { replyTo: 'edit-1', status: 'OK', error: null, controlEpoch: 7, documentVersion: 10 } };
  const w = new Wire(); w.sent = [edit]; w.received = [ack]; assert.equal(acknowledged(w, 'literal\n', 'main.py'), true);
  for (const bad of [{ replyTo: 'other' }, { status: 'DUPLICATE' }, { status: 'REJECTED' }, { error: { code: 'IO_ERROR' } }, { controlEpoch: 6 }, { documentVersion: 9 }]) {
    w.received = [{ ...ack, payload: { ...ack.payload, ...bad } }]; assert.equal(acknowledged(w, 'literal\n', 'main.py'), false, JSON.stringify(bad));
  }
  w.received = []; assert.equal(acknowledged(w, 'literal\n', 'main.py'), false);
  w.received = [ack]; assert.equal(acknowledged(w, 'wrong\n', 'main.py'), false); assert.equal(acknowledged(w, 'literal\n', 'review.md'), false);
});

test('G3 public contract accepts proposal response with version and denies resetTimer/command injection', () => {
  const message = { protocolVersion: '3.0', messageId: 'g3-message', clientId: 'g3-client', sessionId: 'g3-session',
    type: 'PROPOSAL_RESPONSE', payload: { proposalId: 'g3-proposal', accepted: true, basedOnWorkspaceVersion: 1 } };
  assert.equal(validateMessage(message), true);
  assert.equal(validateMessage({ ...message, payload: { ...message.payload, resetTimer: true } }), false);
  assert.equal(validateMessage({ ...message, payload: { proposalId: 'g3-proposal', accepted: true } }), false);
  const request = { requestId: 'g3-request', clientId: 'g3-client', sessionId: 'g3-session', mode: 'RUN_TESTS', expectedWorkspaceVersion: 1 };
  assert.equal(validateRequest('RunRequest', request), true);
  assert.equal(validateRequest('RunRequest', { ...request, executable: 'arbitrary-shell' }), false);
});

test('G3 fixture pass/zero/unknown commands are real executable child inputs, not fake execution services', () => {
  const dir = path.resolve('artifacts/g3/fixture-control'); fs.mkdirSync(dir, { recursive: true });
  const root = fs.mkdtempSync(path.join(dir, 'case-'));
  for (const [p, source] of Object.entries(programs)) fs.writeFileSync(path.join(root, p), source);
  for (const mode of ['pass', 'zero', 'unknown'] as const) {
    const p = profile('RUN_TESTS', mode); assert.equal(p.executable, process.execPath);
    const r = spawnSync(p.executable, p.args.map(a => a.replaceAll('{runId}', 'fixture-' + mode)), {
      cwd: root, shell: false, encoding: 'utf8', timeout: 5000,
      env: { ...process.env, PAIRCOACH_RUN_ID: 'fixture-' + mode },
    });
    assert.equal(r.status, 0, r.stderr); assert.equal(r.error, undefined);
    if (mode === 'unknown') assert.equal(fs.existsSync(path.join(root, 'qa-fixture-unknown.xml')), false);
    else {
      const xml = fs.readFileSync(path.join(root, 'qa-fixture-' + mode + '.xml'), 'utf8');
      assert.match(xml, mode === 'pass' ? /<testcase / : /tests="0"/);
      if (mode === 'pass') assert.match(xml, /name="addition"/);
      else assert.doesNotMatch(xml, /<testcase/);
    }
  }
  const negative = spawnSync(process.execPath, ['qa-pass.cjs', '3'], { cwd: root, shell: false, encoding: 'utf8', timeout: 5000,
    env: { ...process.env, PAIRCOACH_RUN_ID: 'fixture-negative' } });
  assert.equal(negative.status, 1); assert.match(fs.readFileSync(path.join(root, 'qa-fixture-negative.xml'), 'utf8'), /<failure /);
});


test('G3 OS-denial fixture really blocks new backup directory while retaining old bytes and restores access', () => {
  const root = fs.mkdtempSync(path.resolve('artifacts/g3/fixture-control/denial-'));
  const store = path.join(root, 'snapshots-v1'); fs.mkdirSync(store); fs.writeFileSync(path.join(store, 'old'), 'RETAINED');
  const f = { app: { workspace: { dataDir: root } } } as unknown as Fixture;
  const restore = denySnapshotWrites(f);
  try {
    assert.equal(fs.readFileSync(path.join(store, 'old'), 'utf8'), 'RETAINED');
    assert.throws(() => fs.mkdirSync(path.join(store, 'blocked')), (e: any) => ['EACCES', 'EPERM'].includes(e.code));
  } finally { restore(); }
  fs.mkdirSync(path.join(store, 'restored')); assert.equal(fs.readFileSync(path.join(store, 'old'), 'utf8'), 'RETAINED');
});

// Input controls only: these do not launch a browser or claim AC001..003 PASS.
test('Final GUI fixture has four distinct language inputs, multiline workspace and no answer/build tool dependency', () => {
  assert.deepEqual(languageCases.map(c => c.file.split('.').at(-1)), ['java', 'py', 'js', 'ts']);
  assert.match(taskMarkdown, /^# QA markdown-only task\n/);
  assert.deepEqual(languageCases.map(c => c.marker), ['qa_java', 'qa_python', 'qa_js', 'qa_ts']);
  for (const empty of ['', ' ', '\n\t']) assert.equal(nonEmptyAlert.test(empty), false);
  for (const error of ['FILE_NOT_FOUND: task missing', 'Błąd zapisu', 'x']) assert.equal(nonEmptyAlert.test(error), true);
  for (const c of languageCases) {
    assert.ok(c.first.startsWith(c.keyword + ' ')); assert.ok(c.first.includes(c.name));
    assert.equal(c.text.split('\n').length, 121); assert.ok(c.text.split('\n')[69].length > 6);
    assert.ok(c.comment.startsWith(c.file.endsWith('.py') ? '#' : '//'));
    assert.match(c.marker, /^[A-Za-z_][A-Za-z0-9_]*$/); // one lexical token: native Monaco word-group Undo, HUMAN d0af9e73
    // K b000f41a pins the proven literal markers. Seed already has `def qa_python()`;
    // retain an exact input control instead of claiming all selected words are absent.
    assert.equal(c.text.split(c.marker).length - 1, c.language === 'python' ? 1 : 0);
    assert.equal(c.text.endsWith(c.marker), false); // EOF stimulus is still a new edit of literal original bytes
  }
});

test('Final GUI invalid inputs straddle the literal inclusive 1MiB UTF-8 limit and retain invalid binary octets', () => {
  assert.equal(limitBytes, 1048576);
  assert.equal(invalidInputs['boundary.txt'].length, 1048576);
  assert.equal(invalidInputs['oversized.txt'].length, 1048577);
  assert.equal(new TextDecoder('utf-8', { fatal: true }).decode(invalidInputs['boundary.txt']).length, 1048576);
  assert.throws(() => new TextDecoder('utf-8', { fatal: true }).decode(invalidInputs['binary.dat']));
  assert.ok(invalidInputs['binary.dat'].includes(0));
  assert.equal(invalidInputs['boundary.txt'].subarray(-1).toString(), 'Z');
  assert.equal(invalidInputs['oversized.txt'].subarray(-1).toString(), 'Z'); // tail must never be silently clipped
});
