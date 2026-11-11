/** Exact original request reconciliation. Structural validation never proves durable settlement. */
import type { Id } from './protocol';
import type { ProjectV2, RunRequestV2, RunV2, UpdateSettingsRequestV2 } from './runtime-v2';
export type MutationIdentity = { projectId: Id; kind: 'RUN'; request: RunRequestV2 } |
  { projectId: Id; kind: 'SAVE'; request: UpdateSettingsRequestV2 };
export interface ReconcileMutationRequestV2 { mutation: MutationIdentity }
export interface CurrentMutationSnapshotV2 { project: ProjectV2; run: RunV2 | null }
export type MutationOutcomeV2 =
  | { mutation: MutationIdentity; state: 'UNKNOWN'; result: null; current: null }
  | { mutation: MutationIdentity; state: 'DEFINITIVELY_ABORTED'; result: null; current: CurrentMutationSnapshotV2 }
  | { mutation: Extract<MutationIdentity, {kind:'RUN'}>; state: 'COMMITTED'; result: RunV2; current: CurrentMutationSnapshotV2 }
  | { mutation: Extract<MutationIdentity, {kind:'SAVE'}>; state: 'COMMITTED'; result: ProjectV2; current: CurrentMutationSnapshotV2 };
