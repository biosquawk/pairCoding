import type { Position, Range } from '../shared/protocol';
import { AppError } from './errors';

/** Server-local state, not a wire/session schema extension. Coordinates are raw LF UTF-16. */
export interface EditorViewPayload {
  path: string | null;
  documentVersion: number | null;
  cursor: Position | null;
  selection: Range | null;
}
export interface VersionedEditorView {
  projectId: string;
  path: string;
  documentVersion: number;
  cursor: Position | null;
  selection: Range | null;
}

export function viewOffsets(content: string, cursor: Position | null, selection: Range | null): { start: number; end: number } | null {
  const lines = content.split('\n');
  const offsets: number[] = [];
  let length = 0;
  for (const line of lines) { offsets.push(length); length += line.length + 1; }
  const invalid = (): never => { throw new AppError(400, 'INVALID_VIEW', 'Invalid UTF-16 cursor or selection.'); };
  const offset = (line: number, column: number) => {
    if (!Number.isSafeInteger(line) || !Number.isSafeInteger(column) || line < 1 || line > lines.length ||
        column < 1 || column > lines[line - 1].length + 1) return invalid();
    const text = lines[line - 1], i = column - 1;
    if (i > 0 && i < text.length && /[\uD800-\uDBFF]/.test(text[i - 1]) && /[\uDC00-\uDFFF]/.test(text[i])) return invalid();
    return offsets[line - 1] + i;
  };
  if (cursor !== null) offset(cursor.line, cursor.column);
  if (selection === null) return null;
  const start = offset(selection.startLine, selection.startColumn), end = offset(selection.endLine, selection.endColumn);
  if (end < start) return invalid();
  return { start, end };
}
