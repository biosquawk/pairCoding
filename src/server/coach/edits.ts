import type { TextEdit } from '../../shared/protocol';
import { isOrderedRange } from './schema';

/** Monaco-compatible UTF-16 columns, LF text, never the student's live cursor. */
export function applyTextEdit(content: string, edit: TextEdit): string {
  const range = edit.range;
  if (!isOrderedRange(range)) throw new Error('COACH_INVALID_RANGE');
  const lines = content.split('\n');
  const offset = (line: number, column: number) => {
    if (!Number.isSafeInteger(line) || !Number.isSafeInteger(column) || line < 1 || line > lines.length || column < 1 || column > lines[line - 1].length + 1) {
      throw new Error('COACH_RANGE_OUT_OF_BOUNDS');
    }
    // Do not split a surrogate pair at a UTF-16 boundary.
    const text = lines[line - 1];
    const index = column - 1;
    if (index > 0 && index < text.length && /[\uD800-\uDBFF]/.test(text[index - 1]) && /[\uDC00-\uDFFF]/.test(text[index])) {
      throw new Error('COACH_RANGE_SPLITS_SURROGATE');
    }
    return lines.slice(0, line - 1).reduce((sum, value) => sum + value.length + 1, 0) + index;
  };
  const start = offset(range.startLine, range.startColumn);
  const end = offset(range.endLine, range.endColumn);
  const result = content.slice(0, start) + edit.textBlock.replace(/\r\n?/g, '\n') + content.slice(end);
  if (result.length > 1048576 || Buffer.byteLength(result, 'utf8') > 1048576) throw new Error('COACH_DOCUMENT_TOO_LARGE');
  return result;
}
