import type { Position, Range } from '../shared/protocol';

/** Content is a local ACK guard. It is never part of VIEW_CHANGED. */
export interface EditorViewObservationP2 {
  projectId: string;
  path: string;
  content: string;
  cursor: Position | null;
  selection: Range | null;
}

/** One trailing-latest window, not a debounce: updates never move its deadline. */
export class EditorViewThrottleP2 {
  private timer?: ReturnType<typeof setTimeout>;
  constructor(private readonly send: () => void, private readonly delay = 120) {}
  schedule() {
    if (this.timer) return;
    this.timer = setTimeout(() => { this.timer = undefined; this.send(); }, this.delay);
  }
  cancel() { clearTimeout(this.timer); this.timer = undefined; }
}

export function sameEditorViewP2(a: EditorViewObservationP2 | null, b: EditorViewObservationP2) {
  return !!a && a.projectId === b.projectId && a.path === b.path && a.content === b.content
    && JSON.stringify(a.cursor) === JSON.stringify(b.cursor) && JSON.stringify(a.selection) === JSON.stringify(b.selection);
}

// Structural Monaco surface keeps this lifecycle harness testable without loading Monaco in Node.
interface Disposable { dispose(): void }
interface Model {
  uri: { scheme: string; authority: string; path: string };
  getValue(): string;
  isDisposed(): boolean;
}
interface Editor {
  getModel(): Model | null;
  getPosition(): { lineNumber: number; column: number } | null;
  getSelection(): { startLineNumber: number; startColumn: number; endLineNumber: number; endColumn: number } | null;
  onDidChangeCursorPosition(cb: () => void): Disposable;
  onDidChangeCursorSelection(cb: () => void): Disposable;
  onDidChangeModelContent(cb: () => void): Disposable;
}
/** Observe actual editor state; never mutate a model, cursor, selection or Undo stack. */
export function observeMonacoViewP2(editor: Editor, projectId: string, path: string,
  current: () => boolean, observe: (view: EditorViewObservationP2) => void) {
  let disposed = false;
  const model = editor.getModel();
  const sample = () => {
    if (disposed || !current() || !model || model.isDisposed() || editor.getModel() !== model
      || model.uri.scheme !== 'paircoach' || model.uri.authority !== projectId || model.uri.path !== `/${path}`) return;
    const p = editor.getPosition(), s = editor.getSelection();
    observe({ projectId, path, content: model.getValue(), cursor: p ? { line: p.lineNumber, column: p.column } : null,
      selection: s ? { startLine: s.startLineNumber, startColumn: s.startColumn, endLine: s.endLineNumber, endColumn: s.endColumn } : null });
  };
  const listeners = [editor.onDidChangeCursorPosition(sample), editor.onDidChangeCursorSelection(sample), editor.onDidChangeModelContent(sample)];
  sample();
  return () => { disposed = true; listeners.forEach(listener => listener.dispose()); };
}
