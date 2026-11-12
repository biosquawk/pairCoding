import Ajv2020 from 'ajv/dist/2020.js';
import { CoachResponseRejected } from './authorization';
import type { CoachDecision, Range } from '../../shared/protocol';

// One schema for provider constraints AND application-side validation. No coercion.
type Schema = {
  type?: string; enum?: readonly unknown[]; const?: unknown;
  anyOf?: Schema[]; oneOf?: Schema[];
  properties?: Record<string, Schema>; required?: string[]; additionalProperties?: boolean;
  items?: Schema; minItems?: number; maxItems?: number;
  minLength?: number; maxLength?: number; pattern?: string;
  minimum?: number; maximum?: number;
};
const str = (maxLength: number, minLength = 1): Schema => ({ type: 'string', minLength, maxLength });
const integer = (minimum: number, maximum = Number.MAX_SAFE_INTEGER): Schema => ({ type: 'integer', minimum, maximum });
const choices = (...values: string[]): Schema => ({ type: 'string', enum: values });
const nullable = (schema: Schema): Schema => ({ anyOf: [schema, { type: 'null' }] });
const array = (items: Schema, maxItems: number, minItems = 0): Schema => ({ type: 'array', items, minItems, maxItems });
const object = (properties: Record<string, Schema>): Schema => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });
const id: Schema = { ...str(128), pattern: '^[A-Za-z0-9][A-Za-z0-9._:-]*$' };
const path: Schema = { ...str(1024), pattern: '^(?!/)(?!.*(?:^|/)\\.\\.?(?:/|$))[^\\\\:\\u0000]+$' };
const range = object({ startLine: integer(1), startColumn: integer(1), endLine: integer(1), endColumn: integer(1) });
export const COACH_DECISION_SCHEMA: Schema = {
  oneOf: [
    object({ kind: { const: 'SILENT' }, reason: str(200) }),
    object({ kind: { const: 'HINT' }, severity: choices('POSITIVE', 'NEUTRAL', 'WARNING'), text: str(400),
      path: nullable(path), documentVersion: nullable(integer(1)), range: nullable(range),
      showPointer: { type: 'boolean' }, evidenceIds: array(id, 20) }),
    object({ kind: { const: 'EDIT' }, purpose: str(240), path, documentVersion: integer(1), workspaceVersion: integer(0),
      steps: array(object({ range, textBlock: str(4096) }), 60, 1) }),
    object({ kind: { const: 'PROPOSE' }, proposalKind: choices('RETRY_FROM_SNAPSHOT', 'RESTORE_SNAPSHOT', 'FINISH_EXERCISE'),
      questionText: str(600), snapshotId: nullable(id), paths: array(path, 1000), resetTimer: { const: false } }),
    object({ kind: { const: 'REPLY' }, text: str(1200) }),
    object({ kind: { const: 'MUTE' }, durationSeconds: nullable(integer(1, 86400)), sourceUserMessageId: id }),
  ],
};

// Reuse the project's established JSON Schema engine; do not coerce or strip fields.
const validate = new Ajv2020({ strict: false, coerceTypes: false, removeAdditional: false }).compile(COACH_DECISION_SCHEMA);

export function isOrderedRange(range: Range): boolean {
  return range.startLine < range.endLine || (range.startLine === range.endLine && range.startColumn <= range.endColumn);
}

export function parseCoachDecision(input: unknown): CoachDecision {
  const value: unknown = typeof input === 'string' ? JSON.parse(input) : input;
  if (value && typeof value === 'object' && !Array.isArray(value) &&
      (value as any).kind === 'PROPOSE' && (value as any).proposalKind === 'GENERATE_TESTS') throw new CoachResponseRejected('CAPABILITY');
  if (!validate(value)) throw new Error('COACH_INVALID_DECISION');
  const decision = value as CoachDecision;
  if (decision.kind === 'EDIT' && decision.steps.some(step => !isOrderedRange(step.range))) throw new Error('COACH_INVALID_RANGE');
  if (decision.kind === 'HINT' && (decision.range && !isOrderedRange(decision.range))) throw new Error('COACH_INVALID_RANGE');
  if (decision.kind === 'HINT' && ((decision.path === null) !== (decision.documentVersion === null) ||
      (decision.path === null && (decision.range !== null || decision.showPointer)))) throw new Error('COACH_INVALID_ANCHOR');
  if (decision.kind === 'PROPOSE' && ['RESTORE_SNAPSHOT', 'RETRY_FROM_SNAPSHOT'].includes(decision.proposalKind) &&
      (decision.snapshotId === null || decision.paths.length === 0)) throw new Error('COACH_INVALID_SNAPSHOT');
  return structuredClone(decision);
}
