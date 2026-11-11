import type { CompletionProjectionCodec, CompletionProjectionInput } from './CompletionProjection';
import { projectCompletion } from './CompletionProjection';
import { LANGUAGE_LIMITS } from '../../shared/language-v2';
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const identifier = /^[_\p{ID_Start}][_\p{ID_Continue}]*$/u;
/**
 * Pinned pylsp1.12.2 jedi_completion._format_completion emits explicit insertText=d.name, no textEdit.
 * Convert ONLY plain identifiers, against the EXACT sent source/cursor, to a self-contained edit before
 * the unchanged generic allowlist projector. No label fallback, snippet/path/function call/resolve/defaults.
 * Existing textEdit is NEVER replaced or repaired. Middle-of-word/surrogate/invalid position fails closed.
 */
export function normalizePylspCompletion(raw: unknown, input: CompletionProjectionInput, codec: CompletionProjectionCodec): unknown {
  // Shared captured URI/hash/cursor and UTF16/surrogate validation FIRST, even for an empty response.
  projectCompletion(null, input, codec);
  let items: unknown[];
  if (Array.isArray(raw)) items = raw;
  else if (record(raw) && Array.isArray(raw.items) && typeof raw.isIncomplete === 'boolean' && !Object.hasOwn(raw, 'itemDefaults')) items = raw.items;
  else return raw;
  try { if (items.length > LANGUAGE_LIMITS.completionItems || Buffer.byteLength(JSON.stringify(raw)) > LANGUAGE_LIMITS.responseBytes) return null; } catch { return null; }
  const { position } = input.request, content = codec.normalizeContent(input.content), line = content.split('\n')[position.line - 1], column = position.column - 1;
  // No right-hand identifier suffix: never guess overwrite semantics when the cursor is inside a word.
  const right = [...line.slice(column)][0]; if (right && /^[_\p{ID_Continue}]$/u.test(right)) return [];
  const left = line.slice(0, column), prefix = left.match(/[_\p{ID_Continue}]*$/u)![0];
  if (prefix && !identifier.test(prefix)) return [];
  const converted = items.map(item => {
    if (!record(item) || Object.hasOwn(item, 'textEdit')) return item;
    if (typeof item.insertText !== 'string' || item.insertText.length > LANGUAGE_LIMITS.editUtf16 || !identifier.test(item.insertText) ||
      !item.insertText.startsWith(prefix) || item.insertTextFormat !== undefined && item.insertTextFormat !== 1 ||
      item.insertTextMode !== undefined && item.insertTextMode !== 1 ||
      item.additionalTextEdits !== undefined && (!Array.isArray(item.additionalTextEdits) || item.additionalTextEdits.length !== 0)) return null;
    return { ...item, textEdit: { range: { start: { line: position.line - 1, character: column - prefix.length },
      end: { line: position.line - 1, character: column } }, newText: item.insertText } };
  });
  return Array.isArray(raw) ? converted : { isIncomplete: (raw as { isIncomplete: boolean }).isIncomplete, items: converted };
}
