import type { AnalysisSource, CompletionItem, Diagnostic, DiagnosticsResult } from '../../shared/language-v2';
import { LANGUAGE_LIMITS } from '../../shared/language-v2';
import { validateCompletionEdits, validateDiagnosticsResult } from '../../shared/validation-v2';
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const integer = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0 && (v as number) < Number.MAX_SAFE_INTEGER;
/** Only called for exact sent immutable launch source. Raw severity is preserved, NEVER promoted. */
export function projectDiagnostics(raw: unknown, source: Readonly<AnalysisSource>, content: string): DiagnosticsResult | null {
  if (!Array.isArray(raw)) return null;
  try { if (Buffer.byteLength(JSON.stringify(raw)) > LANGUAGE_LIMITS.responseBytes) return null; } catch { return null; }
  const result: DiagnosticsResult = { ...structuredClone(source), presentationStamp: structuredClone(source.sourceStamp), association: null,
    items: [], truncated: raw.length > LANGUAGE_LIMITS.diagnostics };
  for (const v of raw.slice(0, LANGUAGE_LIMITS.diagnostics)) {
    if (!record(v) || !record(v.range) || !record(v.range.start) || !record(v.range.end) ||
      !integer(v.range.start.line) || !integer(v.range.start.character) || !integer(v.range.end.line) || !integer(v.range.end.character) ||
      typeof v.message !== 'string' || v.message.length < 1 || v.message.length > 4096 ||
      ![1, 2, 3, 4].includes(v.severity as number)) return null;
    const range = { startLine: v.range.start.line + 1, startColumn: v.range.start.character + 1,
      endLine: v.range.end.line + 1, endColumn: v.range.end.character + 1 };
    // Use the SAME shared UTF16/bounds validator; a diagnostic is NOT an edit and never mutates content.
    const probe: CompletionItem = { id: 'range', label: 'range', detail: null,
      primary: { path: source.sourceStamp.path, range, text: '' }, additionalTextEdits: [] };
    if (!validateCompletionEdits(probe, source.sourceStamp, content)) return null;
    let code: string | null = null;
    if (v.code !== undefined && v.code !== null) {
      if (typeof v.code !== 'string' && !(typeof v.code === 'number' && Number.isSafeInteger(v.code))) return null;
      code = String(v.code); if (!code.length || code.length > 128) return null;
    }
    const severity = (['ERROR', 'WARNING', 'INFO', 'HINT'] as const)[(v.severity as number) - 1];
    const diagnostic: Diagnostic = { range, severity, message: v.message, code };
    result.items.push(diagnostic);
    const valid: boolean = validateDiagnosticsResult(result);
    if (!valid) { result.items.pop(); result.truncated = true; break; }
  }
  return validateDiagnosticsResult(result) ? result : null;
}
