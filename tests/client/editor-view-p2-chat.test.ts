import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { BottomPanel } from '../../src/components/BottomPanel';
import { EditorChatSubmissionP2, type EditorChatSenderP2 } from '../../src/services/editorChatP2';

function form(send: EditorChatSenderP2) {
  let text = '  question  ', revision = 1, error: string | null = null, busy = false, clears = 0;
  const submitter = new EditorChatSubmissionP2();
  return {
    submit: () => submitter.submit({ text, revision, currentRevision: () => revision, send,
      clear: () => { clears++; text = ''; }, error: value => { error = value; }, busy: value => { busy = value; } }),
    edit(value: string) { text = value; revision++; },
    get text() { return text; }, get error() { return error; }, get busy() { return busy; }, get clears() { return clears; },
  };
}

test('async false/rejection preserve exact draft and visible error; retry can succeed', async () => {
  let mode = 'false'; const sent: string[] = [];
  const f = form(async text => { sent.push(text); if (mode === 'throw') throw new Error('VIEW_REJECTED'); return mode !== 'false'; });
  assert.equal(await f.submit(), false); assert.equal(f.text, '  question  '); assert.match(f.error!, /Nie wysłano/); assert.equal(f.clears, 0); assert.equal(f.busy, false);
  mode = 'throw'; assert.equal(await f.submit(), false); assert.equal(f.text, '  question  '); assert.equal(f.error, 'VIEW_REJECTED'); assert.equal(f.busy, false);
  mode = 'success'; assert.equal(await f.submit(), true); assert.equal(f.text, ''); assert.equal(f.error, null); assert.equal(f.clears, 1);
  assert.deepEqual(sent, ['question', 'question', 'question']);
});

test('Enter/click singleflight guard is synchronous; only submitted input revision is cleared', async () => {
  let finish!: (ok: boolean) => void, calls = 0;
  const f = form(() => { calls++; return new Promise<boolean>(resolve => { finish = resolve; }); });
  const first = f.submit(); assert.equal(f.busy, true); assert.equal(await f.submit(), false); assert.equal(calls, 1);
  f.edit('new text while waiting'); finish(true); assert.equal(await first, true);
  assert.equal(f.text, 'new text while waiting'); assert.equal(f.clears, 0); assert.equal(f.busy, false);
  const second = f.submit(); finish(true); assert.equal(await second, true); assert.equal(f.text, ''); assert.equal(f.clears, 1);
});

test('editing and returning to identical text is a new revision; legacy void/boolean senders remain compatible', async () => {
  let finish!: () => void;
  const f = form(() => new Promise<void>(resolve => { finish = resolve; }));
  const request = f.submit(); f.edit('other'); f.edit('  question  '); finish();
  assert.equal(await request, true); assert.equal(f.text, '  question  '); assert.equal(f.clears, 0);
  const sync = form(() => {}); assert.equal(await sync.submit(), true); assert.equal(sync.text, '');
  const bool = form(() => true); assert.equal(await bool.submit(), true); assert.equal(bool.text, '');
  const empty = form(() => assert.fail('blank input sent')); empty.edit('  '); assert.equal(await empty.submit(), false); assert.equal(empty.busy, false);
});

test('BottomPanel real form renders textarea/submit semantics and preserves stage4 wrapped tabbar', () => {
  const html = renderToStaticMarkup(React.createElement(BottomPanel, {
    activeTab: 'chat', taskContent: '', chatEntries: [], activeProposal: null, activeRun: null, report: null,
    height: 260, isMaximized: false, isCollapsed: false, onSelectTab() {}, onSendMessage: async () => false,
    onProposalResponse() {}, onRetryReport() {}, onToggleCollapse() {}, onToggleMaximize() {},
  }));
  assert.match(html, /<form aria-busy="false"/); assert.match(html, /<textarea/); assert.match(html, /type="submit" disabled/);
  assert.match(html, /flex flex-wrap items-center justify-between gap-1/);
});
