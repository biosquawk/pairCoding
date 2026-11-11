import type { Id, Path, Position, Range } from './protocol';
import type { RuntimeProblem } from './runtime-v2';
export type LanguageState = 'OFF' | 'INDEXING' | 'ON' | 'FAILED';
export interface LanguageView {
  projectId: Id; profileId: Id; configurationGeneration: Id; providerGeneration: Id;
  state: LanguageState; autocomplete: LanguageState; docs: 'N/A'; problem: RuntimeProblem | null;
}
/** Captured identity, never infer a missing documentVersion or replace Monaco getVersionId with alternativeVersionId. */
export interface DocumentStamp {
  projectId: Id; sessionId: Id; path: Path; profileId: Id;
  connectionGeneration: Id; configurationGeneration: Id; providerGeneration: Id; shadowGeneration: Id;
  modelLifetime: Id; localModelVersion: number; baseDocumentVersion: number; documentVersion: number | null;
  contentSha256: string; controlEpoch: number; requestGeneration: number;
}
export type MutationReason = 'OPEN' | 'TYPING' | 'COMPLETION' | 'UNDO' | 'REDO' | 'COACH_STEP_EDIT'
  | 'EXTERNAL_FILE_SYNC' | 'RESTORE_SNAPSHOT' | 'DRAFT_RECOVERY';
export interface OpenOrChange { stamp: DocumentStamp; content: string; reason: MutationReason }
export interface CompleteRequest { requestId: Id; stamp: DocumentStamp; position: Position; trigger: string | null }
export interface CancelRequest { requestId: Id; stamp: DocumentStamp }
export interface CompletionEdit { path: Path; range: Range; text: string }
/** Allowlist projection only: no command/data/resolve/snippets/HTML/workspace action can cross this boundary. */
export interface CompletionItem {
  id: Id; label: string; detail: string | null; primary: CompletionEdit; additionalTextEdits: CompletionEdit[];
}
export interface CompleteResult { requestId: Id; stamp: DocumentStamp; items: CompletionItem[]; isIncomplete: boolean }
export interface Diagnostic { range: Range; severity: 'ERROR' | 'WARNING' | 'INFO' | 'HINT'; message: string; code: string | null }
export type DiagnosticProvenance =
  | { kind: 'VERSIONED_PUSH'; lspVersion: number; inputManifestSha256: string }
  | { kind: 'PULL'; requestId: Id; inputManifestSha256: string }
  | { kind: 'IMMUTABLE_GENERATION'; launchId: Id; lspVersion: number | null; inputManifestSha256: string };
/** Frozen in exact sent-version / request / fixed launch-manifest ledger; NOT a receipt-time identity. */
export interface AnalysisSource { readonly sourceStamp: Readonly<DocumentStamp>; readonly provenance: Readonly<DiagnosticProvenance> }
/** An informational wire reference to a SERVER verified save receipt, not proof or a client ACK grant. */
export interface PresentationAssociation { saveReceiptId: Id }
export interface DiagnosticsResult extends AnalysisSource {
  presentationStamp: DocumentStamp; association: PresentationAssociation | null;
  items: Diagnostic[]; truncated: boolean;
}
export type LanguageFileOperation =
  | { kind: 'CREATE'; path: Path; content: string }
  | { kind: 'RENAME'; path: Path; newPath: Path }
  | { kind: 'DELETE'; path: Path };
/** Added to existing authenticated/session-bound ordered transport. No new socket or language-write endpoint. */
export type LanguageClientPayloads = {
  LANGUAGE_OPEN: OpenOrChange; LANGUAGE_CHANGE: OpenOrChange; LANGUAGE_CLOSE: { stamp: DocumentStamp };
  LANGUAGE_COMPLETE: CompleteRequest; LANGUAGE_CANCEL: CancelRequest;
};
export type LanguageServerPayloads = {
  COMPLETE_RESULT: CompleteResult; DIAGNOSTICS: DiagnosticsResult; LANGUAGE_STATUS: LanguageView;
};
export type LanguageClientMessage = { [K in keyof LanguageClientPayloads]: {
  protocolVersion: '3.0'; messageId: Id; sessionId: Id; clientId: Id; type: K; payload: LanguageClientPayloads[K];
} }[keyof LanguageClientPayloads];
export type LanguageServerMessage = { [K in keyof LanguageServerPayloads]: {
  protocolVersion: '3.0'; messageId: Id; sessionId: Id; seq: number; type: K; payload: LanguageServerPayloads[K];
} }[keyof LanguageServerPayloads];
/** Current synchronous authority, from the same model/controller, not React state captured when widget opened. */
/** synced means authoritative session/control snapshot is current, NOT waiting for disk ACK of this draft. */
export interface AcceptanceState {
  stamp: DocumentStamp; content: string; writeOwner: 'STUDENT' | 'COACH'; connected: boolean; synced: boolean;
  controlPrepare: boolean; vetoPending: boolean; conflict: boolean; readOnly: boolean;
}
export interface CompletionCandidate { requestId: Id; stamp: DocumentStamp; item: CompletionItem }
export type AcceptanceResult = { accepted: true } | { accepted: false; reason: 'STALE' | 'AUTHORITY' | 'UNSAFE_EDIT' };
/**
 * All providers incl built-in use one public synchronous facade. accept rechecks actual bytes/full stamp + authority,
 * validates disjoint edits and calls ONE pushEditOperations undo unit, with no await between check and mutation.
 * No post-edit command/resolve hook; ordinary onChange remains the only CODE_CHANGED/autosave path.
 * invalidate is synchronous BEFORE awaits/flush/CONTROL_READY/React, including denied CONTROL_PREPARE.
 */
export interface CompletionAcceptanceFacade {
  current(): Readonly<AcceptanceState>;
  present(result: CompleteResult): void;
  accept(candidate: CompletionCandidate): AcceptanceResult;
  invalidate(reason: 'CONTROL_PREPARE' | 'VETO' | 'SCOPE' | 'MODEL_CHANGED' | 'DISCONNECTED' | 'CONFLICT'): void;
  cancel(): void;
}
export const LANGUAGE_LIMITS = Object.freeze({
  contentUtf16: 1048576, completionItems: 100, responseBytes: 256*1024, editUtf16: 4096,
  totalEditBytes: 64*1024, diagnostics: 500, diagnosticCoalesceMs: 150,
  diagnosticRetirementMs: 10000, diagnosticAnalysisMs: 30000,
});
