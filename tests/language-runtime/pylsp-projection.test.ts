import test from 'node:test';
import assert from 'node:assert/strict';
import * as codec from '../../src/language/uriCodec';
import { normalizePylspCompletion } from '../../src/server/language/PylspCompletionProjection';
import { projectCompletion, type CompletionProjectionInput } from '../../src/server/language/CompletionProjection';
import type { CompleteRequest } from '../../src/shared/language-v2';
import { stamp } from '../runtime-contract/fixtures';
function input(content = 'calc.', column = codec.normalizeContent(content).split('\n').at(-1)!.length + 1): CompletionProjectionInput {
  const request: CompleteRequest = { requestId: 'req', stamp: { ...stamp(), contentSha256: codec.contentSha256(content) },
    position: { line: codec.normalizeContent(content).split('\n').length, column }, trigger: null };
  return { request, content, workspaceUri: codec.toWorkspaceUri(request.stamp.path) };
}
const run = (raw: unknown, i = input()) => projectCompletion(normalizePylspCompletion(raw, i, codec), i, codec);
const pinnedItem = () => ({ label: 'own_method(x)', kind: 3, sortText: 'own_method', insertText: 'own_method', data: { doc_uri: 'file:///workspace/main.py' } });
test('before generic projector drops actual pinned insertText shape; narrow normalizer creates exact captured dot edit', () => {
  const raw = [pinnedItem()], i = input(); assert.equal(projectCompletion(raw, i, codec).items.length, 0);
  const r = run(raw, i); assert.equal(r.items.length, 1);
  assert.deepEqual(r.items[0].primary, { path: i.request.stamp.path, range: { startLine: 1, startColumn: 6, endLine: 1, endColumn: 6 }, text: 'own_method' });
  assert.equal(JSON.stringify(r).includes('doc_uri'), false); assert.deepEqual(r.stamp, i.request.stamp);
});
test('explicit request replaces only captured matching prefix, never suffix or current stamp', () => {
  const i = input('calc.own'); const r = run([pinnedItem()], i); assert.equal(r.items.length, 1);
  assert.deepEqual(r.items[0].primary.range, { startLine: 1, startColumn: 6, endLine: 1, endColumn: 9 });
  assert.equal(run([pinnedItem()], input('calc.ownSuffix', 9)).items.length, 0);
  assert.equal(run([pinnedItem()], input('calc.other')).items.length, 0);
});
test('CRLF, Unicode identifiers and astral UTF16 offsets use SAME central codec, not byte/alternative ranges', () => {
  const r = run([{ label: 'żółć', insertText: 'żółć' }], input('x\r\n😀.ż')); assert.equal(r.items.length, 1);
  assert.deepEqual(r.items[0].primary.range, { startLine: 2, startColumn: 4, endLine: 2, endColumn: 5 });
  assert.throws(() => run([pinnedItem()], input('😀.', 2)), /captured/);
});
test('label-only/default/snippet/path/call/nonidentifier never manufacture self-contained edits', () => {
  for (const v of [{ label: 'own_method' }, { ...pinnedItem(), insertText: 'own_method()' }, { ...pinnedItem(), insertText: 'a/b.py' },
    { ...pinnedItem(), insertText: '../escape' }, { ...pinnedItem(), insertText: '$1' }, { ...pinnedItem(), insertTextFormat: 2 },
    { ...pinnedItem(), insertTextMode: 2 }, { ...pinnedItem(), insertText: '9x' }]) assert.equal(run([v]).items.length, 0);
  assert.equal(run({ isIncomplete: false, items: [pinnedItem()], itemDefaults: { insertTextFormat: 1 } }).items.length, 0);
});
test('existing malformed/valid textEdit remains unchanged; additional edits never inferred from insertText', () => {
  assert.equal(run([{ ...pinnedItem(), textEdit: { invalid: true } }]).items.length, 0);
  assert.equal(run([{ ...pinnedItem(), additionalTextEdits: [{}] }]).items.length, 0);
  const i = input(); const valid = { ...pinnedItem(), textEdit: { newText: 'explicit()', range: { start: { line: 0, character: 5 }, end: { line: 0, character: 5 } } } };
  assert.equal(run([valid], i).items[0].primary.text, 'explicit()');
});
test('raw lists remain bounded; no resolve, commands, data or documentation survive final projection', () => {
  assert.equal(run(new Array(101).fill(pinnedItem())).items.length, 0);
  assert.equal(run([{ ...pinnedItem(), documentation: 'x'.repeat(256 * 1024) }]).items.length, 0);
  const r = run([{ ...pinnedItem(), command: { command: 'evil' }, data: { evil: true }, documentation: '<b>evil</b>' }]);
  assert.equal(r.items.length, 1); assert.equal(JSON.stringify(r).includes('evil'), false);
});
