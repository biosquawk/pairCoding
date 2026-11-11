import { createHash } from 'node:crypto';
import type { ChatEntry, Document, Run, Session, Settings } from '../../shared/protocol';
import {projectRunFacts, type RunFacts} from './runFacts';
import { viewOffsets, type VersionedEditorView } from '../EditorView';

export interface ContextWorkspace {
  projectId?: string;
  workspaceVersion: number;
  settings: Settings;
  listFiles(): { path: string; kind: string }[];
  getDocument(path: string): Document;
}
export interface CoachContext {
  view?: (VersionedEditorView & { selectedText: string | null; selectionTruncated: boolean }) | null;
  workspaceVersion: number;
  controlEpoch: number;
  taskMode: Settings['taskMode'];
  taskFilePath: string | null;
  reviewNotesPath: string;
  activeFilePath: string | null;
  timer: { status: Session['timer']['status']; elapsedMs: number; limitMs: number | null };
  documents: { path: string; version: number; content: string }[];
  omittedPaths: string[];
  trigger?: { reason: string; messageId: string | null };
  messages: ChatEntry[];
  lastRun: RunFacts | null;
  previousInterventions: { kind: string; path: string | null; workspaceVersion: number }[];
}

// Deny before any file read. Case-insensitive on every host, not just Windows.
export function isContextPathAllowed(path: string): boolean {
  if (!path || path.startsWith('/') || /[\\:\x00-\x1f]/.test(path)) return false;
  return path.split('/').every(part => part !== '' && part !== '.' && part !== '..' &&
    !/[. ]$/.test(part) && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part) &&
    !/^(\.env.*|\.git|\.paircoach|node_modules|target|__pycache__|\.venv|dist|\.ssh|\.aws|\.docker|\.kube|\.azure|\.config|\.npmrc|\.netrc|\.pypirc)$/i.test(part) &&
    !/(?:^|[._-])(?:credentials?|secrets?|tokens?|passwords?|keystore|id_rsa|id_ed25519)(?:[._-]|$)/i.test(part) &&
    !/\.(pem|key|pfx|p12|jks|kdbx|der|crt)$/i.test(part));
}

// Small POSIX glob contract: *, ?, **; no extglob, brace expansion, or filesystem IO.
export function matchesContextPattern(path: string, pattern: string): boolean {
  if (!pattern || pattern.length > 1024 || pattern.startsWith('/') || /[\\:\x00]/.test(pattern) || pattern.split('/').includes('..')) return false;
  let source = '^';
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === '*' && pattern[i + 1] === '*') {
      i++;
      if (pattern[i + 1] === '/') { i++; source += '(?:.*/)?'; }
      else source += '.*';
    } else if (ch === '*') source += '[^/]*';
    else if (ch === '?') source += '[^/]';
    else source += ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(source + '$').test(path);
}

const SECRET_REDACTIONS: readonly [RegExp, string][] = [
  [/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g, '[REDACTED PRIVATE KEY]'],
  [/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi, 'Bearer [REDACTED]'],
  [/\b(?:AIza[A-Za-z0-9_-]{30,}|gh[pousr]_[A-Za-z0-9_]+|sk-[A-Za-z0-9_-]{16,})\b/g, '[REDACTED]'],
  [/((?:api[_-]?key|access[_-]?token|session[_-]?token|password|secret)\s*["']?\s*[:=]\s*)["']?[^\s,"';]+["']?/gi, '$1[REDACTED]'],
];
export function redactSecrets(text: string, sensitiveValues: readonly string[] = []): string {
  let safe = text;
  for (const value of sensitiveValues) if (value.length) safe = safe.split(value).join('[REDACTED]');
  for (const [pattern, replacement] of SECRET_REDACTIONS) safe = safe.replace(pattern, replacement);
  return safe;
}

/** Slice original coordinates, but mask even a PARTIAL selection of a known secret.
 * Slicing the already-redacted document would shift Monaco's raw coordinates. */
function redactSelection(content: string, start: number, end: number, sensitiveValues: readonly string[]): string {
  if (start === end) return '';
  const spans: { start: number; end: number }[] = [];
  const add = (a: number, b: number) => {
    if (a < end && b > start) spans.push({ start: Math.max(start, a), end: Math.min(end, b) });
  };
  for (const value of sensitiveValues) if (value.length) {
    for (let i = content.indexOf(value); i >= 0; i = content.indexOf(value, i + 1)) add(i, i + value.length);
  }
  for (const [pattern] of SECRET_REDACTIONS) for (const match of content.matchAll(pattern)) add(match.index!, match.index! + match[0].length);
  spans.sort((a, b) => a.start - b.start);
  let offset = start, safe = '';
  for (const span of spans) {
    if (span.end <= offset) continue;
    if (span.start >= offset) safe += content.slice(offset, span.start) + '[REDACTED]';
    offset = span.end;
  }
  return redactSecrets(safe + content.slice(offset, end), sensitiveValues);
}

function projectView(view: VersionedEditorView | null, workspace: ContextWorkspace, session: Session,
  rawDocuments: Map<string, Document>, sensitiveValues: readonly string[]): CoachContext['view'] {
  if (!view || view.projectId !== session.projectId || (workspace.projectId !== undefined && view.projectId !== workspace.projectId) ||
      view.path !== session.activeFilePath) return null;
  const document = rawDocuments.get(view.path);
  if (!document || document.version !== view.documentVersion) return null;
  try {
    const offsets = viewOffsets(document.content, view.cursor, view.selection);
    let selectedText = offsets ? redactSelection(document.content, offsets.start, offsets.end, sensitiveValues) : null;
    const selectionTruncated = selectedText !== null && selectedText.length > 8192;
    if (selectionTruncated) {
      let end = 8192;
      if (/[\uD800-\uDBFF]/.test(selectedText![end - 1]) && /[\uDC00-\uDFFF]/.test(selectedText![end])) end--;
      selectedText = selectedText!.slice(0, end);
    }
    return { projectId: view.projectId, path: view.path, documentVersion: view.documentVersion,
      cursor: view.cursor ? { line: view.cursor.line, column: view.cursor.column } : null,
      selection: view.selection ? { startLine: view.selection.startLine, startColumn: view.selection.startColumn,
        endLine: view.selection.endLine, endColumn: view.selection.endColumn } : null,
      selectedText, selectionTruncated };
  } catch { return null; }
}

export function buildContext(workspace: ContextWorkspace, session: Session, messages: ChatEntry[], lastRun: Run | null,
  previousInterventions: CoachContext['previousInterventions'], sensitiveValues: readonly string[] = [],
  view: VersionedEditorView | null = null): CoachContext {
  const settings = workspace.settings;
  if (!settings.aiConsent) throw new Error('AI_CONSENT_REQUIRED');
  const documents: CoachContext['documents'] = [];
  const rawDocuments = new Map<string, Document>();
  const omittedPaths: string[] = [];
  let bytes = 0;
  const entries = workspace.listFiles().filter(entry => entry.kind === 'FILE' && isContextPathAllowed(entry.path) &&
    settings.contextPatterns.some(pattern => matchesContextPattern(entry.path, pattern)));
  entries.sort((a, b) => Number(b.path === session.activeFilePath) - Number(a.path === session.activeFilePath) ||
    Number(b.path.toLowerCase() === settings.taskFilePath?.toLowerCase()) - Number(a.path.toLowerCase() === settings.taskFilePath?.toLowerCase()) || a.path.localeCompare(b.path));
  for (const entry of entries) {
    try {
      const doc = workspace.getDocument(entry.path);
      const content = redactSecrets(doc.content, sensitiveValues);
      const size = Buffer.byteLength(content, 'utf8');
      // Omit entire documents, never silently truncate code mid-file.
      if (bytes + size > 262144) { omittedPaths.push(entry.path); continue; }
      bytes += size;
      rawDocuments.set(entry.path, doc);
      documents.push({ path: entry.path, version: doc.version, content });
    } catch { omittedPaths.push(entry.path); }
  }
  const allowed = (path: string | null) => path && entries.some(entry => entry.path === path) ? path : null;
  const redact = (value: string) => redactSecrets(value, sensitiveValues);
  const context: CoachContext = {
    workspaceVersion: workspace.workspaceVersion, controlEpoch: session.controlEpoch,
    taskMode: settings.taskMode, taskFilePath: allowed(settings.taskFilePath),
    reviewNotesPath: isContextPathAllowed(settings.reviewNotesPath) ? settings.reviewNotesPath : '[EXCLUDED]',
    activeFilePath: allowed(session.activeFilePath),
    timer: { status: session.timer.status, elapsedMs: session.timer.elapsedMs, limitMs: session.timer.limitMs },
    documents, omittedPaths, view: projectView(view, workspace, session, rawDocuments, sensitiveValues),
    messages: messages.slice(-20).map(message => ({ ...message, text: redact(message.text) })),
    lastRun: lastRun ? projectRunFacts(lastRun) : null,
    previousInterventions: previousInterventions.slice(-20),
  };
  // Metadata can also contain a pasted token (filename/message ID), not just code.
  return JSON.parse(JSON.stringify(context, (_key, value) => typeof value === 'string' ? redactSecrets(value, sensitiveValues) : value)) as CoachContext;
}

export function contextFingerprint(context: CoachContext): string {
  // Ticking timer/server seq is NOT a new domain fact. Own edits never trigger this function.
  const { elapsedMs: _, ...timer } = context.timer;
  const { controlEpoch: __, trigger: ___, ...facts } = context;
  return createHash('sha256').update(JSON.stringify({ ...facts, messages: facts.messages.filter(m => m.author === 'STUDENT'), timer })).digest('hex');
}

export function isCoachWriteAllowed(path: string, settings: Settings): boolean {
  if (!isContextPathAllowed(path) || path.toLowerCase() === settings.taskFilePath?.toLowerCase()) return false;
  if (/(^|\/)(?:tests?|__tests__|fixtures?|goldens?|config|\.github)(\/|\.|$)|(?:^|[.\/_-])(?:test|spec|config)(?:[.\/_-]|$)/i.test(path)) return false;
  if (/\.(json|json5|ya?ml|toml|ini|xml|lock|gradle|bat|cmd|ps1|sh)$/i.test(path) || /(^|\/)(?:Dockerfile|Makefile|AGENTS\.md)$/i.test(path)) return false;
  if (/(^|\/)(?:requirements[^/]*\.txt|CMakeLists\.txt|\.editorconfig|\.vscode)(\/|$)/i.test(path)) return false;
  if (settings.taskMode === 'CODE_REVIEW') return path.toLowerCase() === settings.reviewNotesPath.toLowerCase();
  return /\.(java|py|js|jsx|ts|tsx)$/i.test(path);
}
