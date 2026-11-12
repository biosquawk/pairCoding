/** Offline production-subscriber regression, NOT browser/HTTP proof.
 * Runs the unchanged EditorPanel layout-effect body with explicit Monaco-boundary
 * doubles. Recorded Undo emits a scroll event after the model shrinks but before
 * its selection is reconciled (90b8 bundle 524:17876, trace t5439.17).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const panel = fs.readFileSync(new URL('../../src/components/EditorPanel.tsx', import.meta.url), 'utf8');
const marker = panel.indexOf('// Protect the whole active line/selection band');
const hook = 'useLayoutEffect(() => {';
const start = panel.indexOf(hook, marker);
const end = panel.indexOf('}, [editorGeneration, activePath]);', start);
assert.ok(marker >= 0 && start > marker && end > start, 'production geometry effect must be found');
const body = panel.slice(start + hook.length, end);

function setup() {
  let lines = 12, selection: any = { startLineNumber: 12, startColumn: 1, endLineNumber: 12, endColumn: 1 };
  let protectedCode: any = null, hintContainer: any = {}, modelPresent = true, nodePresent = true;
  let scroll = 0, height = 500, offset = 0, validations = 0, disconnected = false, unexpected = false;
  const calls: any[] = [], callbacks = new Map<string, () => void>();
  const subscribe = (name: string) => (cb: () => void) => {
    callbacks.set(name, cb); return { dispose: () => callbacks.delete(name) };
  };
  const geometry = (kind: string, line: number) => {
    // Monaco top validates its position; bottom queries getLineMaxColumn first.
    if (unexpected) throw new Error('unexpected model failure');
    if (kind === 'top') line = Math.max(1, Math.min(lines, line));
    if (line < 1 || line > lines) throw new Error('Illegal value for lineNumber');
    calls.push([kind, line]); return (line - (kind === 'top' ? 1 : 0)) * 20;
  };
  const model = { validateRange(r: any) {
    validations++;
    return { ...r, startLineNumber: Math.max(1, Math.min(lines, r.startLineNumber)),
      endLineNumber: Math.max(1, Math.min(lines, r.endLineNumber)) };
  } };
  const editor = {
    getModel: () => modelPresent ? model : null, getSelection: () => selection,
    getDomNode: () => nodePresent ? { getBoundingClientRect: () => ({ top: offset }) } : null,
    getTopForLineNumber: (line: number) => geometry('top', line),
    getBottomForLineNumber: (line: number) => geometry('bottom', line), getScrollTop: () => scroll,
    onDidChangeCursorSelection: subscribe('cursor'), onDidScrollChange: subscribe('scroll'),
    onDidLayoutChange: subscribe('layout'), onDidChangeModel: subscribe('model'), onDidChangeModelContent: subscribe('content'),
  };
  const state = (key: 'protected' | 'container', value: any) => {
    const old = key === 'protected' ? protectedCode : hintContainer;
    const next = typeof value === 'function' ? value(old) : value;
    if (key === 'protected') protectedCode = next; else hintContainer = next;
  };
  const cleanup = vm.runInNewContext('(function(){' + body + '})()', {
    contentContainerRef: { current: { getBoundingClientRect: () => ({ top: 0, width: 900, height }) } },
    editorRef: { current: editor }, setHintContainer: (v: any) => state('container', v),
    setProtectedCode: (v: any) => state('protected', v),
    ResizeObserver: class { constructor(cb: () => void) { callbacks.set('resizeObserver', cb); } observe() {} disconnect() { disconnected = true; callbacks.delete('resizeObserver'); } },
    window: { addEventListener: (_: string, cb: () => void) => callbacks.set('resize', cb), removeEventListener: () => callbacks.delete('resize') },
  });
  return { calls, callbacks, cleanup, model, get rect() { return protectedCode; }, get validations() { return validations; }, get disconnected() { return disconnected; },
    unexpected: () => { unexpected = true; }, select: (r: any) => { selection = r; }, get selection() { return selection; }, shrink: (n: number) => { lines = n; },
    detach: () => { modelPresent = false; }, noSelection: () => { selection = null; }, noNode: () => { nodePresent = false; },
    viewport: (s: number, h: number, o = 0) => { scroll = s; height = h; offset = o; },
    emit: (name: string) => { const cb = callbacks.get(name); assert.ok(cb); cb(); },
  };
}

test('recorded multiline edit → Undo shrink → scroll before cursor reconciliation never throws', () => {
  const f = setup(), old = f.selection;
  f.shrink(10); // trailing comment/newline removed by ordinary Undo
  assert.doesNotThrow(() => f.emit('scroll'));
  assert.equal(f.calls.at(-1)[1], 10);
  assert.equal(f.selection, old, 'presentation must not change selection/model/Undo');
  assert.equal(f.rect.top, 180); assert.equal(f.rect.height, 20);
  f.select({ startLineNumber: 10, startColumn: 2, endLineNumber: 10, endColumn: 2 }); f.emit('cursor');
  f.shrink(12); f.select(old); f.emit('content'); // Redo/growth remains normal
  assert.equal(f.rect.top, 220); assert.equal(f.rect.height, 20); f.cleanup();
});

test('every geometry invalidation uses current model even with an old selection', () => {
  for (const event of ['scroll', 'content', 'layout', 'model', 'resizeObserver', 'resize', 'cursor']) {
    const f = setup(); f.shrink(1);
    assert.doesNotThrow(() => f.emit(event), event);
    assert.equal(f.calls.at(-1)[1], 1); assert.equal(f.rect.top, 0); assert.equal(f.rect.height, 20); f.cleanup();
  }
});

test('valid multiline band retains both ends and clipping, not just caret or EOF', () => {
  const f = setup(); f.select({ startLineNumber: 3, startColumn: 1, endLineNumber: 6, endColumn: 8 });
  f.viewport(30, 80, 10); f.emit('cursor');
  assert.equal(f.rect.top, 20); assert.equal(f.rect.height, 60); assert.equal(f.rect.width, 900);
  f.viewport(500, 80); f.emit('scroll'); assert.equal(f.rect, null); f.cleanup();
});

test('empty document after replacement stays at its one valid line', () => {
  const f = setup(); f.shrink(1); f.emit('model');
  assert.equal(f.calls.at(-1)[1], 1); assert.equal(f.rect.height, 20); f.cleanup();
});

for (const missing of ['detach', 'noSelection', 'noNode'] as const) test(`${missing} clears band without querying geometry`, () => {
  const f = setup(), before = f.calls.length; f[missing](); f.emit('model');
  assert.equal(f.rect, null); assert.equal(f.calls.length, before); f.cleanup();
});

test('unexpected Monaco failures still propagate; no catch-all error suppression', () => {
  const f = setup(); f.unexpected();
  assert.throws(() => f.emit('scroll'), /unexpected model failure/); f.cleanup();
});

test('cleanup releases observer and all listeners', () => {
  const f = setup(); assert.equal(f.callbacks.size, 7); f.cleanup();
  assert.equal(f.disconnected, true); assert.equal(f.callbacks.size, 0);
});
