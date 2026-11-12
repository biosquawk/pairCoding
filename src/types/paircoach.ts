/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

export type WriteOwner = 'STUDENT' | 'COACH' | 'SYNCING';

export type CoachMode =
  | 'ACTIVE_WATCHING'
  | 'INTERVENING'
  | 'COOLDOWN_AFTER_VETO'
  | 'MUTED_WINDOW_HIDDEN'
  | 'MUTED_MANUAL'
  | 'UNAVAILABLE';

export type AiStatus = 'OFF' | 'READY' | 'THINKING' | 'FAILED';

export type SessionStatus = 'STOPPED' | 'RUNNING' | 'PAUSED' | 'OVERTIME';

export type TaskMode = 'IMPLEMENTATION' | 'CODE_REVIEW';

export type PluginStatus = 'NOT_INSTALLED' | 'OFF' | 'ON' | 'FAILED';

export type FileKind = 'FILE' | 'DIRECTORY';

export interface ProjectFile {
  path: string;
  kind: FileKind;
  version: number;
  content: string;
  readOnly?: boolean;
  loaded?: boolean;
  loadError?: string;
}

export interface RunProfile {
  id: string;
  name: string;
  command: string;
  isTest: boolean;
}

export interface ProjectSettings {
  wireRunProfiles?: import('../shared/protocol').RunProfile[];
  contextPatterns?: string[];
  aiConsent: boolean;
  taskMode: TaskMode;
  taskFilePath: string;
  reviewNotesPath: string;
  runProfiles: RunProfile[];
}

export interface Capabilities {
  canRunMain: boolean;
  canRunTests: boolean;
  runMainReason?: string;
  runTestsReason?: string;
  docsPlugin: PluginStatus;
  autocompletePlugin: PluginStatus;
  docs?: PluginStatus;
  autocomplete?: PluginStatus;
}

export type ExecutionStatus =
  | 'IDLE'
  | 'QUEUED'
  | 'RUNNING'
  | 'SUCCEEDED'
  | 'FAILED'
  | 'CANCELLED'
  | 'TIMED_OUT';

export type TestOutcome =
  | 'NOT_APPLICABLE'
  | 'UNKNOWN'
  | 'NO_TESTS'
  | 'PASSED'
  | 'FAILED';

export interface ConsoleOutputEntry {
  id: string;
  timestamp: number;
  type: 'STDOUT' | 'STDERR' | 'SYSTEM';
  text: string;
}

export interface ExecutionRun {
  runId: string;
  profileName: string;
  status: ExecutionStatus;
  exitCode?: number;
  testOutcome: TestOutcome;
  workspaceChangedDuringRun: boolean;
  outputTruncated: boolean;
  logs: ConsoleOutputEntry[];
}

export interface CoachPointer {
  path: string;
  documentVersion: number;
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
  clear?: boolean;
}

export type HintBubbleSeverity = 'POSITIVE' | 'NEUTRAL' | 'WARNING';

export interface CoachHintBubble {
  id: string;
  path: string;
  documentVersion: number;
  line: number;
  text: string;
  severity: HintBubbleSeverity;
  createdAt: number;
  // Position override for drag & drop
  posX?: number;
  posY?: number;
}

export type ProposalType =
  | 'RETRY_FROM_SNAPSHOT'
  | 'RESTORE_SNAPSHOT'
  | 'GENERATE_TESTS'
  | 'FINISH_EXERCISE';

export interface ActionProposal {
  id: string;
  proposalId?: string;
  type: ProposalType;
  kind?: ProposalType;
  questionText: string;
  paths: string[];
  yesLabel: string;
  noLabel: string;
  expiresAt?: number;
  resetTimer?: boolean;
}

export interface FileConflict {
  diskDeleted?: boolean;
  path: string;
  diskContent: string;
  localDraftContent: string;
}

export interface SnapshotItem {
  id: string;
  label: string;
  timestamp: number;
  files: { path: string; content: string }[];
}

export interface ChatEntry {
  id: string;
  sender: 'STUDENT' | 'COACH' | 'SYSTEM';
  message: string;
  timestamp: number;
  proposal?: ActionProposal;
}

export type EndReason = 'COMPLETED' | 'ABANDONED' | 'TIME_LIMIT_REVIEW';

export interface ReportMetrics {
  durationFormatted: string;
  coachInterventionsCount: number;
  userVetoCount: number;
  testRunsCount: number;
  linesChanged: number;
  scorePercentage?: number;
}

export interface SessionReport {
  status: 'PENDING' | 'READY' | 'FAILED';
  reason?: EndReason;
  markdown?: string;
  error?: string;
  metrics?: ReportMetrics;
}

export type WindowPresence = 'FOCUSED' | 'BLURRED' | 'HIDDEN';

export interface CoachEditStep {
  path: string;
  interventionId: string;
  controlEpoch?: number;
  stepIndex?: number; // simulator-only; absent in LIVE protocol
  totalSteps?: number;
  stepId?: string;
  baseVersion?: number;
  version?: number;
  range: {
    startLine: number;
    startColumn: number;
    endLine: number;
    endColumn: number;
  };
  text: string;
  explanation?: string;
  delayMs?: number;
}

export interface TrainingScenario {
  id: string;
  title: string;
  category: 'LeetCode' | 'Code Review' | 'Algorytmy';
  taskMode: TaskMode;
  description: string;
  defaultTimeLimitMs: number;
  files: ProjectFile[];
  taskFilePath: string;
  reviewNotesPath: string;
  capabilities: Capabilities;
}
