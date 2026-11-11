/** A–B PROPOSAL ONLY. Not imported by product. K consolidation + ROOT approval before C. */
export type Id = string;
export type Path = string; // canonical relative POSIX; server validates filesystem containment too
export type RunKind = 'RUN_MAIN' | 'RUN_TESTS';
export type FeatureState = 'INDEXING' | 'ON' | 'OFF' | 'FAILED';
export interface Problem { code: string; message: string; recovery: string; retryable: boolean }
export interface RuntimeView {
  profileId: Id; label: string; configurationGeneration: Id;
  state: 'READY' | 'CONFIG_ERROR' | 'DAEMON_OFF' | 'IMAGE_MISSING' | 'PREPARE_REQUIRED';
  problem: Problem | null;
  // Executable/image/LSP launch parameters NEVER supplied by the UI or AI.
  taskFields: TaskField[];
}
export interface TaskField {
  key: string; label: string; help: string; required: boolean;
  input: 'TEXT' | 'PATH' | 'INTEGER' | 'CHOICE';
  choices: { value: string; label: string }[];
  min: number | null; max: number | null;
}
export type TaskEntry =
  | { kind: 'SCRIPT'; path: Path }
  | { kind: 'MODULE'; name: string }
  | { kind: 'JAVA_MAIN'; className: string }
  | { kind: 'SPRING_BOOT'; containerPort: number; healthPath: string };
export interface TaskRunConfig {
  workingDirectory: '.' | Path;
  entry: TaskEntry;
  // Adapter selects its approved test runner; selectors are validated DATA, never shell/flags.
  tests: { paths: Path[]; names: string[] };
}
export interface RunProfileV2 {
  kind: RunKind; task: TaskRunConfig; timeoutMs: number; // 1000..300000
}
export interface SettingsV2 {
  schemaVersion: 2; runProfiles: RunProfileV2[]; // unique kind, <=2; [] supported
  taskFilePath: Path | null; taskMode: 'IMPLEMENTATION' | 'CODE_REVIEW';
  reviewNotesPath: Path; aiConsent: boolean; contextPatterns: string[];
}
export interface ExecutionView {
  canRunMain: boolean; canRunTests: boolean;
  runMainProblem: Problem | null; runTestsProblem: Problem | null;
  runtime: RuntimeView;
}
export interface LanguageView {
  state: FeatureState; generation: Id; problem: Problem | null;
  docs: 'N/A'; autocomplete: FeatureState;
}
export interface RunInputIdentity {
  runId: Id; profileId: Id; configurationGeneration: Id;
  workspaceVersion: number; manifestSha256: string;
}
export interface RunRequest {
  requestId: Id; clientId: Id; sessionId: Id;
  expectedWorkspaceVersion: number; mode: RunKind;
  configurationGeneration: Id; // server rejects changed config, never caller-chosen image
}
export interface Position { line: number; column: number } // 1-based UTF16, wire/Monaco
export interface Range { startLine: number; startColumn: number; endLine: number; endColumn: number }
export interface DocumentStamp {
  projectId: Id; sessionId: Id; connectionGeneration: Id; path: Path; profileId: Id;
  configurationGeneration: Id; providerGeneration: Id; shadowGeneration: Id;
  modelLifetime: Id; localModelVersion: number; // Monaco versionId, NOT alternativeVersionId
  baseDocumentVersion: number; documentVersion: number | null; // exact-content ACK only
  contentSha256: string; controlEpoch: number; requestGeneration: number;
}
export interface OpenOrChange { stamp: DocumentStamp; content: string; reason: MutationReason }
export type MutationReason = 'OPEN' | 'TYPING' | 'COMPLETION' | 'UNDO' | 'REDO'
  | 'COACH_STEP_EDIT' | 'EXTERNAL_FILE_SYNC' | 'RESTORE_SNAPSHOT' | 'DRAFT_RECOVERY';
export type FileOperation =
  | { kind: 'CREATE'; path: Path; content: string }
  | { kind: 'RENAME'; path: Path; newPath: Path }
  | { kind: 'DELETE'; path: Path };
export interface CompleteRequest { requestId: Id; stamp: DocumentStamp; position: Position; trigger: string | null }
export interface CompletionEdit { path: Path; range: Range; text: string }
export interface CompletionItem {
  id: Id; label: string; detail: string | null;
  primary: CompletionEdit; additionalTextEdits: CompletionEdit[];
  // No command, resolve action, snippets, documentation HTML, insert/replace union or workspace edits in v1.
}
export interface CompleteResult { requestId: Id; stamp: DocumentStamp; items: CompletionItem[]; isIncomplete: boolean }
export interface Diagnostic { range: Range; severity: 'ERROR' | 'WARNING' | 'INFO' | 'HINT'; message: string; code: string | null }
export interface DiagnosticsResult {
  stamp: DocumentStamp;
  provenance: { kind: 'VERSIONED_PUSH'; lspVersion: number }
    | { kind: 'PULL'; requestId: Id }
    | { kind: 'IMMUTABLE_GENERATION'; inputManifestSha256: string };
  items: Diagnostic[]; truncated: boolean;
}
export interface LanguageFeaturesPortProposal {
  open(document: OpenOrChange): Promise<void>;
  change(document: OpenOrChange): Promise<void>;
  acknowledge(previous: DocumentStamp, next: DocumentStamp,
    verifiedSaveReceiptId: Id): void; // INTERNAL trusted ledger proof; not a client-granted ACK; no didChange/save
  close(stamp: DocumentStamp): Promise<void>;
  fileOperation(projectId: Id, generation: Id, operation: FileOperation): Promise<void>;
  complete(request: CompleteRequest): Promise<CompleteResult>;
  cancel(requestId: Id): void;
  disposeProject(projectId: Id, generation: Id): Promise<void>;
  // status/diagnostics subscription emitted separately on authenticated project-bound transport.
}
