import type { ProjectV2, SessionBundleV2, RunV2, ExecutionView } from '../shared/runtime-v2';
import type { LanguageServerPayloads, LanguageView } from '../shared/language-v2';
import type { RuntimeClientV2State } from './RuntimeClientV2';
import type * as Wire from '../shared/protocol';
import type { CoachEditStep, ProjectFile, FileConflict } from '../types/paircoach';
import type { simulator } from './simulator';

export type TransportMode = 'LIVE_BACKEND' | 'MOCK_SIMULATOR';
export type ProjectSnapshot = Wire.Project | ProjectV2;
export type BundleSnapshot = Wire.SessionBundle | SessionBundleV2;
export type ClientState = import('../shared/durable-project').DurableProjectState & Omit<ReturnType<typeof simulator.getFullState>, 'fileConflict'> & {
  fileConflict: FileConflict | null;
  transportMode: TransportMode;
  connectionError: string | null;
  taskReadError: { path: string; message: string } | null;
  pendingPaths: string[];
  storageError: string | null;
  snapshotsError: string | null;
  runtime?: RuntimeClientV2State;
  language?: LanguageView | null;
  languageDiagnostics?: 'OFF'|'INDEXING'|'ON'|'FAILED'|'N/A';
  languageProblem?: string | null;
};
export type UpdatedFile = ProjectFile & { isExternalOrSnapshot?: boolean };
export type CoachStep = CoachEditStep;
export interface ServerPayloads {
  DURABLE_PROJECT_STATE: import('../shared/durable-project').DurableProjectState;
  SESSION_SNAPSHOT: BundleSnapshot;
  ACK: { replyTo: string; status: 'OK' | 'DUPLICATE' | 'REJECTED'; documentVersion: number | null; workspaceVersion: number; controlEpoch: number; error: Wire.ApiError | null };
  CONTROL_PREPARE: { requestId: string; purpose: string; path: string; basedOnWorkspaceVersion: number };
  CONTROL_STATE: Pick<Wire.Session, 'writeOwner' | 'controlEpoch' | 'coachMode' | 'cooldownAfterVeto' | 'interventionId'> & { purpose: string | null };
  COACH_STEP_EDIT: { stepId: string; interventionId: string; controlEpoch: number; path: string; baseVersion: number; version: number; workspaceVersion: number; range: Wire.Range; textBlock: string; contentHash: string };
  EXTERNAL_FILE_SYNC: { operation: 'CREATED' | 'UPDATED' | 'DELETED'; path: string; version: number; workspaceVersion: number; document: Wire.Document | null };
  COACH_POINTER: { id: string; path: string; documentVersion: number; range: Wire.Range | null; clear: boolean };
  COACH_HINT_BUBBLE: { locale?: import('../shared/durable-project').Locale;createdAt?:string; id: string; severity: 'POSITIVE' | 'NEUTRAL' | 'WARNING'; text: string; path: string | null; documentVersion: number | null; range: Wire.Range | null; evidenceIds: string[] };
  ACTION_PROPOSAL: Wire.Proposal;
  CHAT_REPLY: { locale?: import('../shared/durable-project').Locale; createdAt?:string; replyTo: string | null; text: string };
  RUN_OUTPUT: { runId: string; outputSeq: number; stream: 'STDOUT' | 'STDERR'; chunk: string };
  RUN_STATE: RunV2 | Wire.Run;
  SESSION_STATE: Wire.Session;
  SESSION_REPORT: Wire.Report;
  ERROR: Wire.ApiError;
}
export type ServerMessage = { [K in keyof (ServerPayloads & LanguageServerPayloads)]: { protocolVersion: '3.0'; sessionId: string; messageId: string; seq: number; type: K; payload: (ServerPayloads & LanguageServerPayloads)[K] } }[keyof (ServerPayloads & LanguageServerPayloads)];
