import type * as Wire from '../shared/protocol';
import type { CoachEditStep, ProjectFile, FileConflict } from '../types/paircoach';
import type { simulator } from './simulator';

export type TransportMode = 'LIVE_BACKEND' | 'MOCK_SIMULATOR';
export type ClientState = Omit<ReturnType<typeof simulator.getFullState>, 'fileConflict'> & {
  fileConflict: FileConflict | null;
  transportMode: TransportMode;
  connectionError: string | null;
  pendingPaths: string[];
  storageError: string | null;
  snapshotsError: string | null;
};
export type UpdatedFile = ProjectFile & { isExternalOrSnapshot?: boolean };
export type CoachStep = CoachEditStep;
export interface ServerPayloads {
  SESSION_SNAPSHOT: Wire.SessionBundle;
  ACK: { replyTo: string; status: 'OK' | 'DUPLICATE' | 'REJECTED'; documentVersion: number | null; workspaceVersion: number; controlEpoch: number; error: Wire.ApiError | null };
  CONTROL_PREPARE: { requestId: string; purpose: string; path: string; basedOnWorkspaceVersion: number };
  CONTROL_STATE: Pick<Wire.Session, 'writeOwner' | 'controlEpoch' | 'coachMode' | 'cooldownAfterVeto' | 'interventionId'> & { purpose: string | null };
  COACH_STEP_EDIT: { stepId: string; interventionId: string; controlEpoch: number; path: string; baseVersion: number; version: number; workspaceVersion: number; range: Wire.Range; textBlock: string; contentHash: string };
  EXTERNAL_FILE_SYNC: { operation: 'CREATED' | 'UPDATED' | 'DELETED'; path: string; version: number; workspaceVersion: number; document: Wire.Document | null };
  COACH_POINTER: { id: string; path: string; documentVersion: number; range: Wire.Range | null; clear: boolean };
  COACH_HINT_BUBBLE: { id: string; severity: 'POSITIVE' | 'NEUTRAL' | 'WARNING'; text: string; path: string | null; documentVersion: number | null; range: Wire.Range | null; evidenceIds: string[] };
  ACTION_PROPOSAL: Wire.Proposal;
  CHAT_REPLY: { replyTo: string | null; text: string };
  RUN_OUTPUT: { runId: string; outputSeq: number; stream: 'STDOUT' | 'STDERR'; chunk: string };
  RUN_STATE: Wire.Run;
  SESSION_STATE: Wire.Session;
  SESSION_REPORT: Wire.Report;
  ERROR: Wire.ApiError;
}
export type ServerMessage = { [K in keyof ServerPayloads]: { protocolVersion: '3.0'; sessionId: string; messageId: string; seq: number; type: K; payload: ServerPayloads[K] } }[keyof ServerPayloads];
