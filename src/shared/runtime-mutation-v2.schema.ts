import { RunRequestV2Schema, UpdateSettingsRequestV2Schema } from './runtime-v2.schema';
import { id, nullable, object } from './schema-v2';
const runIdentity = object({ projectId: id, kind: { const: 'RUN' }, request: RunRequestV2Schema });
const saveIdentity = object({ projectId: id, kind: { const: 'SAVE' }, request: UpdateSettingsRequestV2Schema });
export const MutationIdentitySchema = { oneOf: [runIdentity, saveIdentity] };
export const ReconcileMutationRequestV2Schema = object({ mutation: MutationIdentitySchema });
export const CurrentMutationSnapshotV2Schema = object({ project: { $ref: '#/$defs/Project' }, run: nullable({ $ref: '#/$defs/Run' }) });
export const MutationOutcomeV2Schema = { oneOf: [
  object({ mutation: MutationIdentitySchema, state: { const: 'UNKNOWN' }, result: { type: 'null' }, current: { type: 'null' } }),
  object({ mutation: MutationIdentitySchema, state: { const: 'DEFINITIVELY_ABORTED' }, result: { type: 'null' }, current: CurrentMutationSnapshotV2Schema }),
  object({ mutation: runIdentity, state: { const: 'COMMITTED' }, result: { $ref: '#/$defs/Run' }, current: CurrentMutationSnapshotV2Schema }),
  object({ mutation: saveIdentity, state: { const: 'COMMITTED' }, result: { $ref: '#/$defs/Project' }, current: CurrentMutationSnapshotV2Schema }),
] };
