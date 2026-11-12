import fs from 'node:fs';
import path from 'node:path';
import type { RunV2 } from '../../shared/runtime-v2';
import type { ExecutionPlan } from '../execution/ports';
import type { RetainedRunPolicy } from './RuntimeExecution';
import type { SettingsTransactionIdentity } from '../settings-v2';
import { AppError } from '../errors';
import { JournalLease } from './JournalLease';
import { canonical, createRecord, privateDirectory, readRecord, replaceRecord, SerialQueue, sha256 } from './storage';

/** Internal identity. HTTP validates exact public request schema before construction. */
export interface MutationIdentity {
  projectId: string; sessionId: string; clientId: string; requestId: string;
  kind: 'RUN' | 'SAVE'; payload: unknown;
}
export type MutationOutcome<T> = { state: 'UNKNOWN'; result: null } |
  { state: 'COMMITTED'; result: T } | { state: 'DEFINITIVELY_ABORTED'; result: null };
export type DefinitiveOutcome<T> = Exclude<MutationOutcome<T>, { state: 'UNKNOWN' }>;
export interface SettingsResultStage<T> { identity: SettingsTransactionIdentity; result: T }
export interface RunAdmissionStage { result: RunV2; plan: ExecutionPlan; policy: RetainedRunPolicy }
const RUN_PROTOCOL = 'ORIGINAL_RUN_ADMISSION_V1';
type RecordBody = { version: 1; identity: MutationIdentity; fingerprint: string; outcome: MutationOutcome<unknown>;
  settingsStage?: SettingsResultStage<unknown>; runProtocol?: typeof RUN_PROTOCOL; runStage?: RunAdmissionStage };
const validRunStage = (body: RecordBody): boolean => {
  if (body.runProtocol !== undefined && (body.identity.kind !== 'RUN' || body.runProtocol !== RUN_PROTOCOL)) return false;
  if (body.runStage === undefined) return true;
  const s = body.runStage, payload = body.identity.payload as Record<string, unknown> | null;
  return body.runProtocol === RUN_PROTOCOL && !!payload && !!s.result && !!s.plan && !!s.policy &&
    s.result.status === 'QUEUED' && s.result.runId === s.plan.ownership?.runId &&
    s.plan.input?.projectId === body.identity.projectId && s.plan.input.sessionId === body.identity.sessionId &&
    s.result.configurationGeneration === payload.configurationGeneration && s.result.mode === payload.mode &&
    s.result.workspaceVersionAtStart === payload.expectedWorkspaceVersion &&
    typeof s.policy.managedCacheRoot === 'string' && path.isAbsolute(s.policy.managedCacheRoot) &&
    (s.policy.serviceNetwork === null || typeof s.policy.serviceNetwork === 'string');
};
const validStage = (body: RecordBody): boolean => {
  const s = body.settingsStage;
  if (!s) return true;
  return body.identity.kind === 'SAVE' && !!s.identity && s.result !== undefined &&
    (['requestId','clientId','sessionId'] as const).every(k => s.identity[k] === body.identity[k]) &&
    Number.isSafeInteger(s.identity.expectedWorkspaceVersion) && s.identity.expectedWorkspaceVersion >= 0 &&
    !!body.identity.payload && typeof body.identity.payload === 'object' &&
    s.identity.expectedWorkspaceVersion === (body.identity.payload as { expectedWorkspaceVersion?: unknown }).expectedWorkspaceVersion &&
    /^[a-f0-9]{64}$/.test(s.identity.payloadSha256);
};
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const MAX_RECORD = 8 * 1024 * 1024;
const fail = (code: string, message: string): never => { throw new AppError(409, code, message); };
const snapshot = <T>(v: T): T => structuredClone(v);

/**
 * Durable per-project/client/request admission, independent of WebSocket lifetime.
 * No eviction. Pending or ambiguous effects remain UNKNOWN across restart and fence all NEW
 * RUN/SAVE. Only actual operation-specific recovery may settle such a reservation later.
 * A missing key is NOT an abort until reconcile has fsynced a tombstone with exclusive ownership.
 */
export class DurableMutationJournal {
  private readonly serial = new SerialQueue();
  private readonly lease: JournalLease;
  private readonly records = new Map<string, RecordBody>();
  private closed = false;
  private poisoned = false;
  private bytes = 0;
  private activeEffects = 0;
  constructor(readonly directory: string, private readonly options: { maxEntries?: number; maxBytes?: number } = {}) {
    if (!path.isAbsolute(directory)) throw Error('Absolute journal directory required');
    privateDirectory(directory);
    for (const value of [options.maxEntries ?? 10000, options.maxBytes ?? 128*1024*1024])
      if (!Number.isSafeInteger(value) || value < 1) throw Error('Invalid journal budget');
    this.lease = new JournalLease(path.join(directory, 'lease.lock'));
    try { this.load(); }
    catch (e) { this.lease.close(); throw e; }
  }
  private assertOwner(): void {
    if (this.closed || this.poisoned) throw new AppError(503, 'MUTATION_JOURNAL_UNAVAILABLE', 'Mutation result is unknown; retain the original request.');
    this.lease.assertCurrent();
  }
  private key(identity: MutationIdentity): string {
    if (!identity || ![identity.projectId,identity.sessionId,identity.clientId,identity.requestId].every(id => typeof id === 'string' && ID.test(id)) ||
        !['RUN','SAVE'].includes(identity.kind)) throw Error('Invalid mutation identity');
    // Exact frozen scope: project/session/client/request ID; kind and full payload are fingerprint-bound.
    return sha256(canonical([identity.projectId, identity.sessionId, identity.clientId, identity.requestId]));
  }
  private record(identity: MutationIdentity, outcome: MutationOutcome<unknown>): RecordBody {
    return { version: 1, identity: snapshot(identity), fingerprint: sha256(canonical(identity)), outcome: snapshot(outcome) };
  }
  private encoded(body: RecordBody): Buffer {
    const text = canonical(body), bytes = Buffer.from(canonical({ sha256: sha256(text), body }));
    if (bytes.length > MAX_RECORD) throw Error('Mutation outcome exceeds durable bound');
    return bytes;
  }
  private load(): void {
    const names = fs.readdirSync(this.directory);
    if (names.length > (this.options.maxEntries ?? 10000) * 2 + 4) throw Error('Journal inventory exceeds bound');
    for (const name of names.sort()) {
      if (name === 'lease.lock') continue;
      if (/^\.next-[a-f0-9-]{36}$/.test(name)) {
        readRecord(path.join(this.directory, name), MAX_RECORD);
        continue; // retained partial publication is NOT an outcome or an abort proof
      }
      // Partial writes/unknown names are uncertainty, not permission to forget reservations.
      if (!/^[a-f0-9]{64}\.json$/.test(name)) throw Error('Unreconciled mutation journal entry');
      const bytes = readRecord(path.join(this.directory, name), MAX_RECORD)!;
      const stored = JSON.parse(new TextDecoder('utf8', { fatal: true }).decode(bytes));
      const body = stored.body as RecordBody;
      if (!body || body.version !== 1 || stored.sha256 !== sha256(canonical(body)) ||
          body.fingerprint !== sha256(canonical(body.identity)) || this.key(body.identity) + '.json' !== name ||
          !validStage(body) || !validRunStage(body) || !body.outcome || !['UNKNOWN','COMMITTED','DEFINITIVELY_ABORTED'].includes(body.outcome.state) ||
          (body.outcome.state !== 'COMMITTED' && body.outcome.result !== null)) throw Error('Invalid mutation journal record');
      this.records.set(name.slice(0, -5), body); this.bytes += bytes.length;
    }
    if (this.records.size > (this.options.maxEntries ?? 10000) || this.bytes > (this.options.maxBytes ?? 128*1024*1024)) throw Error('Mutation journal exhausted');
  }
  private existing(key: string, identity: MutationIdentity): RecordBody | undefined {
    const record = this.records.get(key);
    if (record && record.fingerprint !== sha256(canonical(identity))) fail('IDEMPOTENCY_CONFLICT', 'Request ID is already bound to another immutable mutation.');
    // Read exact disk record even for cached known ID. Missing/corrupt persistence never means absent.
    if (record) {
      try { if (!readRecord(path.join(this.directory, key + '.json'), MAX_RECORD)!.equals(this.encoded(record))) throw Error('Mutation record changed'); }
      catch (error) { this.poisoned = true; throw error; }
    }
    return record;
  }
  private reserve(key: string, body: RecordBody): void {
    const bytes = this.encoded(body);
    if (this.records.size >= (this.options.maxEntries ?? 10000) || this.bytes + MAX_RECORD > (this.options.maxBytes ?? 128*1024*1024))
      fail('MUTATION_JOURNAL_LIMIT', 'Mutation journal budget exhausted; retain original requests.');
    try { createRecord(path.join(this.directory, key + '.json'), bytes); }
    catch (e) { this.poisoned = true; throw e; }
    this.records.set(key, body); this.bytes += bytes.length;
  }
  private settle(key: string, body: RecordBody): void {
    const bytes = this.encoded(body), previous = this.records.get(key)!;
    if (previous.outcome.state !== 'UNKNOWN') fail('MUTATION_ALREADY_FINAL', 'A definitive mutation outcome cannot be changed.');
    const total = this.bytes - this.encoded(previous).length + bytes.length;
    if (total > (this.options.maxBytes ?? 128*1024*1024)) throw Error('Mutation journal budget exhausted');
    try { replaceRecord(path.join(this.directory, key + '.json'), bytes); }
    catch (e) { this.poisoned = true; throw e; }
    this.records.set(key, body); this.bytes = total;
  }
  /** INTERNAL synchronous pre-effect stage. Called only inside the actual settings lease,
   * after durable mutation reservation, before the authority/Store effect can begin. No await
   * can interleave settlement. Repetition/replacement is forbidden; failed fsync poisons owner.
   */
  stageSettings<T>(original: MutationIdentity, stage: SettingsResultStage<T>): void {
    this.assertOwner();
    const identity = snapshot(original), key = this.key(identity), prior = this.existing(key, identity);
    const body: RecordBody = { ...prior!, settingsStage: snapshot(stage) };
    if (!prior || prior.outcome.state !== 'UNKNOWN' || prior.settingsStage || !this.activeEffects || !validStage(body))
      fail('INVALID_SETTINGS_STAGE', 'Original SAVE result must be staged once before its actual effect.');
    this.settle(key, body);
  }
  /** Trusted recovery consumes the retained original result + exact Store-generated identity,
   * never regenerates a payload hash from reordered JSON or a later current Project snapshot. */
  readSettingsStage<T>(original: MutationIdentity): SettingsResultStage<T> | null {
    this.assertOwner();
    const prior = this.existing(this.key(original), original);
    return prior?.settingsStage ? snapshot(prior.settingsStage) as SettingsResultStage<T> : null;
  }
  /** INTERNAL original RUN acceptance. Durable before execution.start, not process-success proof.
   * Only the operation-specific protocol may stage this record; the original plan/policy survives
   * final settlement so startup can join the REAL executor journal without reading later config. */
  stageRun(original: MutationIdentity, stage: RunAdmissionStage): void {
    this.assertOwner();
    const identity = snapshot(original), key = this.key(identity), prior = this.existing(key, identity);
    const body: RecordBody = { ...prior!, runStage: snapshot(stage) };
    if (!prior || prior.outcome.state !== 'UNKNOWN' || prior.runStage || !this.activeEffects || !validRunStage(body))
      fail('INVALID_RUN_STAGE', 'Original RUN acceptance must be staged once before execution.start.');
    this.settle(key, body);
  }
  readRunReservation(original: MutationIdentity): { protocol: boolean; stage: RunAdmissionStage | null } {
    this.assertOwner();
    const prior = this.existing(this.key(original), original);
    return { protocol: prior?.runProtocol === RUN_PROTOCOL, stage: prior?.runStage ? snapshot(prior.runStage) : null };
  }
  /** Exact inventory for startup join; never a synthesized plan/current configuration lookup. */
  runAdmissions(): { identity: MutationIdentity; stage: RunAdmissionStage }[] {
    this.assertOwner();
    return [...this.records.entries()].flatMap(([key, cached]) => {
      const record = this.existing(key, cached.identity)!;
      return record.runStage ? [{ identity: snapshot(record.identity), stage: snapshot(record.runStage) }] : [];
    });
  }
  /** The exclusive reservation itself records this protocol BEFORE the callback can execute.
   * Missing stage proves no execution.start ONLY for this protocol after active-effect exclusion. */
  executeRun<T>(original: MutationIdentity, effect: () => Promise<DefinitiveOutcome<T>>): Promise<MutationOutcome<T>> {
    if (original.kind !== 'RUN') throw Error('RUN protocol requires a RUN identity');
    return this.executeEffect(original, effect, RUN_PROTOCOL);
  }
  /** Reservation is durable before the callback; callback MUST NOT return abort after an uncertain effect. */
  execute<T>(original: MutationIdentity, effect: () => Promise<DefinitiveOutcome<T>>): Promise<MutationOutcome<T>> {
    return this.executeEffect(original, effect);
  }
  private async executeEffect<T>(original: MutationIdentity, effect: () => Promise<DefinitiveOutcome<T>>, protocol?: typeof RUN_PROTOCOL): Promise<MutationOutcome<T>> {
    const identity = snapshot(original), key = this.key(identity);
    const admission = await this.serial.run(() => {
      this.assertOwner();
      const prior = this.existing(key, identity);
      if (prior) return { admitted: false, outcome: snapshot(prior.outcome) as MutationOutcome<T> };
      if ([...this.records.values()].some(r => r.outcome.state === 'UNKNOWN')) fail('MUTATION_PENDING', 'An unresolved mutation fences new RUN/SAVE admission.');
      this.reserve(key, { ...this.record(identity, { state: 'UNKNOWN', result: null }), ...(protocol ? { runProtocol: protocol } : {}) });
      this.activeEffects++;
      return { admitted: true, outcome: null };
    });
    if (!admission.admitted) return admission.outcome!;
    let outcome: DefinitiveOutcome<T>;
    try {
      outcome = snapshot(await effect());
      if (!outcome || !['COMMITTED','DEFINITIVELY_ABORTED'].includes(outcome.state) ||
          (outcome.state === 'DEFINITIVELY_ABORTED' && outcome.result !== null)) throw Error('Invalid operation outcome');
    } catch {
      // The effect might have committed before throwing. Keep reservation and ownership; NEVER infer abort.
      await this.serial.run(() => { this.activeEffects--; });
      return { state: 'UNKNOWN', result: null };
    }
    return this.serial.run(() => {
      try {
        this.assertOwner(); this.existing(key, identity);
        this.settle(key, { ...this.records.get(key)!, outcome: snapshot(outcome) });
        return snapshot(outcome);
      } finally { this.activeEffects--; }
    });
  }
  /** Reconcile full immutable request; absent -> fsynced tombstone before definitive response. */
  reconcile<T>(original: MutationIdentity): Promise<MutationOutcome<T>> {
    const identity = snapshot(original), key = this.key(identity);
    return this.serial.run(() => {
      this.assertOwner();
      const prior = this.existing(key, identity);
      if (prior) return snapshot(prior.outcome) as MutationOutcome<T>;
      const outcome = { state: 'DEFINITIVELY_ABORTED', result: null } as const;
      this.reserve(key, this.record(identity, outcome));
      return outcome;
    });
  }
  /**
   * INTERNAL operation-specific recovery. The trusted callback must prove the exact original
   * outcome from its durable effect journal, never current UI state/absence in RAM. Not a wire
   * callback. Hold exclusion through proof AND fsynced settlement; a live admitted effect may
   * still commit, so it must not be inspected into a definitive abort here.
   */
  recover<T>(original: MutationIdentity, prove: () => Promise<MutationOutcome<T>>): Promise<MutationOutcome<T>> {
    const identity = snapshot(original), key = this.key(identity);
    return this.serial.run(async () => {
      this.assertOwner();
      const prior = this.existing(key, identity);
      if (!prior) {
        const outcome = { state: 'DEFINITIVELY_ABORTED', result: null } as const;
        this.reserve(key, this.record(identity, outcome));
        return outcome;
      }
      if (prior.outcome.state !== 'UNKNOWN') return snapshot(prior.outcome) as MutationOutcome<T>;
      if (this.activeEffects) return { state: 'UNKNOWN', result: null };
      let outcome: MutationOutcome<T>;
      try {
        outcome = snapshot(await prove());
        if (!outcome || !['UNKNOWN','COMMITTED','DEFINITIVELY_ABORTED'].includes(outcome.state) ||
            (outcome.state !== 'COMMITTED' && outcome.result !== null)) throw Error('Invalid recovery proof');
      } catch { return { state: 'UNKNOWN', result: null }; }
      this.assertOwner(); this.existing(key, identity);
      if (outcome.state !== 'UNKNOWN') this.settle(key, { ...this.records.get(key)!, outcome: snapshot(outcome) });
      return snapshot(outcome);
    });
  }
  /** Close only after all admitted effects have settled; pending records intentionally survive. */
  close(): Promise<void> {
    return this.serial.run(() => {
      if (this.activeEffects) fail('MUTATION_IN_FLIGHT', 'Wait for admitted effects before releasing journal ownership.');
      // Poisoned persistence still retains a pending record; closing releases only the kernel lease.
      if (!this.closed) { this.lease.close(); this.closed = true; }
    });
  }
}
