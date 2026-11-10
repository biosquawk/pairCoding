import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import schema from '../shared/ws.schema.json';
import type { ApiError } from '../shared/protocol';

// The schema builders are from HUMAN file2; payload names match authoritative file1.
const ajv = new Ajv2020({ allErrors: false, strict: false });
addFormats(ajv);
ajv.addSchema(schema, 'paircoach');
const clientValidator = ajv.compile({ $ref: 'paircoach#/$defs/ClientMessage' });
const requestValidators = new Map<string, ReturnType<typeof ajv.compile>>();
export interface ClientMessage {
  protocolVersion: '3.0'; messageId: string; sessionId: string; clientId: string;
  type: string; payload: Record<string, any>;
}
export function validateMessage(value: unknown): value is ClientMessage {
  return Boolean(clientValidator(value));
}
export function validateRequest(name: string, value: unknown): boolean {
  let validate = requestValidators.get(name);
  if (!validate) {
    validate = ajv.compile({ $ref: `paircoach#/$defs/${name}` });
    requestValidators.set(name, validate);
  }
  return Boolean(validate(value));
}
export function apiError(error: unknown, requestId: string | null = null): ApiError {
  const candidate = error as { status?: number; code?: string; message?: string; currentVersion?: number };
  const safe = typeof candidate?.status === 'number' && candidate.status >= 400 && candidate.status < 500;
  return { code: candidate?.code || 'INTERNAL_ERROR', message: safe ? candidate.message || 'Żądanie odrzucone.' : 'Błąd operacji lokalnej. Dane nie zostały potwierdzone.', retryable: !safe, requestId, currentVersion: candidate?.currentVersion ?? null };
}
export class TransportError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}
export function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.entries(value).sort(([a],[b]) => a.localeCompare(b)).map(([k,v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
}

/** Shared HTTP/WS ledger; a pending promise is registered before the effect begins. */
export class CommandLedger {
  private entries = new Map<string, { fingerprint: string; result: Promise<unknown> }>();
  run<T>(key: string, input: unknown, operation: () => Promise<T> | T): { duplicate: boolean; result: Promise<T> } {
    const fingerprint = canonical(input), existing = this.entries.get(key);
    if (existing) {
      if (existing.fingerprint !== fingerprint) throw new TransportError(409, 'IDEMPOTENCY_CONFLICT', 'Ten identyfikator ma już inną treść.');
      return { duplicate: true, result: existing.result as Promise<T> };
    }
    // Never evict an effect silently: a full ledger rejects new mutations instead.
    if (this.entries.size >= 100000) throw new TransportError(429, 'COMMAND_LIMIT', 'Osiągnięto limit komend sesji; zachowaj dane i otwórz nową sesję.');
    const result = Promise.resolve().then(operation);
    this.entries.set(key, { fingerprint, result });
    return { duplicate: false, result };
  }
}
