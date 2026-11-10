import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildContext, contextFingerprint, isContextPathAllowed, matchesContextPattern, isCoachWriteAllowed, redactSecrets } from '../../src/server/coach/context';
import { parseCoachDecision } from '../../src/server/coach/schema';
import { applyTextEdit } from '../../src/server/coach/edits';
import { LocalFallbackProvider } from '../../src/server/coach/provider';
import { COACH_SYSTEM_PROMPT } from '../../src/server/coach/prompt';
import type { Document, Session, Settings } from '../../src/shared/protocol';

const settings: Settings = { aiConsent: true, contextPatterns: ['**/*'], taskFilePath: 'challenge.md', taskMode: 'IMPLEMENTATION', reviewNotesPath: 'review.md', runProfiles: [] };
const range = { startLine: 1, startColumn: 1, endLine: 1, endColumn: 1 };
const edit = { kind: 'EDIT', purpose: 'example', path: 'main.py', workspaceVersion: 1, documentVersion: 1, steps: [{ range, textBlock: 'x' }] };

test('TEST-025/026 schema rejects extra powers, bad steps, ranges, null anchors and malformed JSON', () => {
  assert.deepEqual(parseCoachDecision(edit), edit);
  for (const bad of [
    { ...edit, shell: 'rm -rf' }, { ...edit, steps: [] }, { ...edit, steps: Array(61).fill(edit.steps[0]) },
    { ...edit, documentVersion: 0 }, { ...edit, workspaceVersion: NaN }, { ...edit, path: '../x' },
    { ...edit, steps: [{ range: { ...range, endColumn: 0 }, textBlock: 'x' }] },
    { ...edit, steps: [{ range, textBlock: '' }] }, { ...edit, steps: [{ range, textBlock: 'x'.repeat(4097) }] },
    { kind: 'MUTE', durationSeconds: 0, sourceUserMessageId: 'x' },
    { kind: 'HINT', severity: 'WARNING', text: 'x', path: null, documentVersion: 1, range: null, showPointer: true, evidenceIds: [] },
    { kind: 'PROPOSE', proposalKind: 'RESTORE_SNAPSHOT', questionText: 'restore?', paths: [], snapshotId: null, resetTimer: false },
    'not JSON', [], null,
  ]) assert.throws(() => parseCoachDecision(bad));
});

test('TEST-008 sequential UTF16 edits use explicit ranges, reject out-of-bounds and surrogate split', () => {
  const initial = '😀a\nb';
  const changed = applyTextEdit(initial, { range: { ...range, startColumn: 3, endColumn: 4 }, textBlock: 'z' });
  assert.equal(changed, '😀z\nb');
  assert.equal(applyTextEdit(changed, { range: { ...range, startLine: 2, endLine: 2, endColumn: 2 }, textBlock: 'c\r\nd' }), '😀z\nc\nd');
  assert.throws(() => applyTextEdit(initial, { range: { ...range, startColumn: 2, endColumn: 2 }, textBlock: 'x' }));
  assert.throws(() => applyTextEdit(initial, { range: { ...range, endLine: 3 }, textBlock: 'x' }));
  assert.throws(() => applyTextEdit(initial, { range: { ...range, endColumn: 9 }, textBlock: 'x' }));
});

test('TEST-025 sensitive files denied before read even under **/* and case variations', () => {
  const denied = ['.env', '.ENV.local', 'src/.env', '.git/config', '.paircoach/snapshot', '.ssh/id_rsa', '.aws/credentials', 'keys/private.pem', 'x.key', 'x.pfx', 'x.p12', 'credentials.json', 'secrets.txt', 'tokens.txt', 'src/../x', 'CON.txt', 'x:y', 'x\\y', 'src/NUL', 'config.'];
  denied.forEach(path => assert.equal(isContextPathAllowed(path), false, path));
  assert.equal(isContextPathAllowed('src/main.ts'), true);
  assert.equal(matchesContextPattern('main.py', '**/*.py'), true);
  assert.equal(matchesContextPattern('src/a.py', '**/*.py'), true);
  assert.equal(matchesContextPattern('src/main.py', '*.py'), false);
  assert.equal(matchesContextPattern('src/main.py', 'src/ma?n.py'), true);
  assert.equal(matchesContextPattern('src/main.py', '../**'), false);
});

test('TEST-025 context consent, allowlist, exact token redaction and stable fingerprints', () => {
  const reads: string[] = [];
  const source = ['main.py', 'challenge.md', '.env', '.git/config', 'secret.key', 'ignored.txt'];
  const workspace = { workspaceVersion: 1, settings: { ...settings, contextPatterns: ['*.py', '*.md', '.env', '**/*.key', '.git/*'] },
    listFiles: () => source.map(path => ({ path, kind: 'FILE' })),
    getDocument: (path: string) => { reads.push(path); return { path, version: 1, content: 'print("API-TOKEN-EXACT")\napi_key="sensitive-value"\nAuthorization: Bearer abcdefghijk', readOnly: false } as Document; } };
  const session = { controlEpoch: 1, activeFilePath: 'main.py', timer: { status: 'RUNNING', elapsedMs: 100, limitMs: null } } as Session;
  const context = buildContext(workspace, session, [], null, [], ['API-TOKEN-EXACT']);
  assert.deepEqual(reads.sort(), ['challenge.md', 'main.py']);
  const serialized = JSON.stringify(context);
  for (const secret of ['API-TOKEN-EXACT', 'sensitive-value', 'abcdefghijk']) assert.equal(serialized.includes(secret), false);
  assert.equal(contextFingerprint(context), contextFingerprint({ ...context, controlEpoch: 5, timer: { ...context.timer, elapsedMs: 999 } }));
  workspace.settings.aiConsent = false;
  reads.length = 0;
  assert.throws(() => buildContext(workspace, session, [], null, []), /AI_CONSENT_REQUIRED/);
  assert.deepEqual(reads, []);
  assert.equal(redactSecrets('Bearer abcd'), 'Bearer [REDACTED]');
});

test('TEST-021 immutable task/tests/config; CODE_REVIEW notes only', () => {
  for (const path of ['challenge.md', 'tests/a.py', 'src/a.test.ts', 'src/a.spec.ts', 'config.py', 'package.json', 'foo.config.ts', 'AGENTS.md', 'Dockerfile', 'test_main.py', '.env']) {
    assert.equal(isCoachWriteAllowed(path, settings), false, path);
  }
  assert.equal(isCoachWriteAllowed('main.py', settings), true);
  assert.equal(isCoachWriteAllowed('main.py', { ...settings, taskMode: 'CODE_REVIEW' }), false);
  assert.equal(isCoachWriteAllowed('review.md', { ...settings, taskMode: 'CODE_REVIEW' }), true);
});

test('missing key local fallback is honestly named, silent and has no model execution', async () => {
  const provider = new LocalFallbackProvider();
  assert.equal(provider.mode, 'LOCAL_FALLBACK');
  assert.equal(provider.name, 'LOCAL_FALLBACK_NO_GEMINI_KEY');
  assert.equal(parseCoachDecision(await provider.decide()).kind, 'SILENT');
});

test('runtime prompt is current file1, never old file3 prompt', () => {
  assert.ok(COACH_SYSTEM_PROMPT.startsWith('„Jesteś trenerem programowania pracującym z jednym użytkownikiem.'));
  assert.ok(COACH_SYSTEM_PROMPT.includes('MUTE'));
  assert.ok(COACH_SYSTEM_PROMPT.includes('Nie pokazuj rozumowania wewnętrznego'));
  assert.ok(!COACH_SYSTEM_PROMPT.includes('na żywo z jednym użytkownikiem w jednym edytorze'));
});


test('regression: valid HINT and PROPOSE enums have no implicit length constraint', () => {
  for (const decision of [
    { kind: 'SILENT', reason: 'wait' },
    { kind: 'HINT', severity: 'POSITIVE', text: 'good', path: null, documentVersion: null, range: null, showPointer: false, evidenceIds: [] },
    { kind: 'PROPOSE', proposalKind: 'FINISH_EXERCISE', questionText: 'finish?', snapshotId: null, paths: [], resetTimer: false },
    { kind: 'REPLY', text: 'reply' },
    { kind: 'MUTE', durationSeconds: null, sourceUserMessageId: 'message1' },
  ]) assert.deepEqual(parseCoachDecision(decision), decision);
});


test('TEST-025 exact token redaction also covers metadata (path/message ID), not just body', () => {
  const path = 'TOKENFIXTURE.py';
  const workspace = { workspaceVersion: 1, settings, listFiles: () => [{ path, kind: 'FILE' }],
    getDocument: () => ({ path, version: 1, content: 'safe' } as Document) };
  const session = { controlEpoch: 1, activeFilePath: path, timer: { status: 'RUNNING', elapsedMs: 0, limitMs: null } } as Session;
  const context = buildContext(workspace, session, [{ messageId: 'TOKENFIXTURE', author: 'STUDENT', text: 'safe', createdAt: '2026-11-10T00:00:00Z' }], null, [], ['TOKENFIXTURE']);
  assert.equal(JSON.stringify(context).includes('TOKENFIXTURE'), false);
});
