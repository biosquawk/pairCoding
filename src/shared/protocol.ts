// Source: HUMAN pasted-text-1.txt section 4.1. Wire names are authoritative.
export type Id = string; // minLength: 1, maxLength: 128, pattern: ^[A-Za-z0-9][A-Za-z0-9._:-]*$
export type Path = string; // względna ścieżka POSIX w root, bez "/", "..", "\" ani nazw urządzeń Windows
export type Sha256Hash = string; // ^[a-f0-9]{64}$
export type IsoDateTime = string; // ISO 8601 date-time

export interface Position {
  line: number;   // integer >= 1
  column: number; // integer >= 1 (UTF-16)
}

export interface Range {
  startLine: number;   // integer >= 1
  startColumn: number; // integer >= 1
  endLine: number;     // integer >= 1
  endColumn: number;   // integer >= 1 (koniec wyłączny)
}

export interface ApiError {
  code: string;
  message: string;
  retryable: boolean;
  requestId: Id | null;
  currentVersion: number | null;
}

export interface FileEntry {
  path: Path;
  kind: "FILE" | "DIRECTORY";
  version: number | null;
}

export interface Document {
  path: Path;
  version: number; // integer >= 1
  content: string; // max 1048576 znaków (1 MiB), w API przesyłane z LF
  contentHash: Sha256Hash;
  languageId: "java" | "python" | "javascript" | "typescript" | "markdown" | "plaintext";
  eol: "LF" | "CRLF";
  utf8Bom: boolean;
  readOnly: boolean;
}

export interface RunProfile {
  kind: "RUN_MAIN" | "RUN_TESTS";
  executable: string;
  args: string[];
  cwd: string;
  timeoutMs: number; // 1000..300000
  testReportFormat: "NONE" | "JUNIT_XML";
  testReportGlob: string | null;
}

export interface Settings {
  taskFilePath: Path | null;
  taskMode: "IMPLEMENTATION" | "CODE_REVIEW";
  reviewNotesPath: Path;
  runProfiles: RunProfile[];
  aiConsent: boolean;
  contextPatterns: string[];
}

export interface Capabilities {
  canRunMain: boolean;
  canRunTests: boolean;
  docs: "NOT_INSTALLED" | "OFF" | "ON" | "FAILED";
  autocomplete: "NOT_INSTALLED" | "OFF" | "ON" | "FAILED";
}

export interface Project {
  projectId: Id;
  sessionId: Id;
  rootPath: string;
  workspaceVersion: number;
  settings: Settings;
  capabilities: Capabilities;
  files: FileEntry[];
}

export interface Timer {
  status: "STOPPED" | "RUNNING" | "PAUSED" | "OVERTIME";
  elapsedMs: number;
  limitMs: number | null;
  pauseOnHidden: boolean;
  manualPaused: boolean;
  serverTime: IsoDateTime;
}

export type CoachMode =
  | "ACTIVE_WATCHING"
  | "INTERVENING"
  | "COOLDOWN_AFTER_VETO"
  | "MUTED_WINDOW_HIDDEN"
  | "MUTED_MANUAL"
  | "UNAVAILABLE";

export interface Session {
  sessionId: Id;
  projectId: Id;
  lifecycle: "READY" | "RUNNING" | "FINISHED";
  workspaceVersion: number;
  controlEpoch: number;
  writeOwner: "STUDENT" | "COACH";
  coachMode: CoachMode;
  cooldownAfterVeto: boolean;
  presence: "FOCUSED" | "BLURRED" | "HIDDEN";
  aiStatus: "OFF" | "READY" | "THINKING" | "FAILED";
  timer: Timer;
  activeFilePath: Path | null;
  interventionId: Id | null;
  lastServerSeq: number;
}

export interface Snapshot {
  snapshotId: Id;
  projectId: Id;
  createdAt: IsoDateTime;
  label: string;
  workspaceVersion: number;
  paths: Path[];
}

export interface Proposal {
  proposalId: Id;
  kind: "RETRY_FROM_SNAPSHOT" | "RESTORE_SNAPSHOT" | "GENERATE_TESTS" | "FINISH_EXERCISE";
  questionText: string;
  yesLabel: string;
  noLabel: string;
  basedOnWorkspaceVersion: number;
  expiresAt: IsoDateTime;
  paths: Path[];
  snapshotId: Id | null; // wymagane dla RETRY_FROM_SNAPSHOT i RESTORE_SNAPSHOT
  resetTimer: false;     // w MVP zawsze false
}

export interface Run {
  runId: Id;
  mode: "RUN_MAIN" | "RUN_TESTS";
  status: "QUEUED" | "RUNNING" | "SUCCEEDED" | "FAILED" | "CANCELLED" | "TIMED_OUT";
  exitCode: number | null;
  workspaceVersionAtStart: number;
  workspaceChangedDuringRun: boolean;
  testOutcome: "NOT_APPLICABLE" | "UNKNOWN" | "NO_TESTS" | "PASSED" | "FAILED";
  testCount: number | null;
  outputTail: string; // max 65536 znaków
  outputTruncated: boolean;
  startedAt: IsoDateTime | null;
  finishedAt: IsoDateTime | null;
}

export interface Report {
  reportId: Id;
  sessionId: Id;
  status: "PENDING" | "READY" | "FAILED";
  reason: "COMPLETED" | "ABANDONED" | "TIME_LIMIT_REVIEW";
  sourceWorkspaceVersion: number;
  snapshotId: Id;
  generatedAt: IsoDateTime | null;
  markdown: string | null;
  evidenceIds: Id[];
  error: ApiError | null;
}

export interface ChatEntry {
  messageId: Id;
  author: "STUDENT" | "COACH" | "SYSTEM";
  text: string;
  createdAt: IsoDateTime;
}

export interface SessionBundle {
  session: Session;
  project: Project;
  activeDocument: Document | null;
  proposals: Proposal[];
  lastRun: Run | null;
  report: Report | null;
  chat: ChatEntry[];
}

export interface TextEdit {
  range: Range;
  textBlock: string; // 1..4096 znaków
}

export type CoachDecision =
  | { kind: "SILENT"; reason: string }
  | {
      kind: "HINT";
      severity: "POSITIVE" | "NEUTRAL" | "WARNING";
      text: string; // max 400 znaków
      path: Path | null;
      documentVersion: number | null;
      range: Range | null;
      showPointer: boolean;
      evidenceIds: Id[];
    }
  | {
      kind: "EDIT";
      purpose: string; // max 240 znaków
      path: Path;
      documentVersion: number;
      workspaceVersion: number;
      steps: TextEdit[]; // 1..60 kroków
    }
  | {
      kind: "PROPOSE";
      proposalKind: "RETRY_FROM_SNAPSHOT" | "RESTORE_SNAPSHOT" | "GENERATE_TESTS" | "FINISH_EXERCISE";
      questionText: string;
      snapshotId: Id | null;
      paths: Path[];
      resetTimer: false;
    }
  | { kind: "REPLY"; text: string }
  | { kind: "MUTE"; durationSeconds: number | null; sourceUserMessageId: Id };
