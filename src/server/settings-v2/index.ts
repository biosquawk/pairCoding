/** Non-destructive V2 project-settings persistence. Actual WriteGate wiring is deliberately injected. */
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { RuntimeProblem, SettingsV2, UpdateSettingsRequestV2 } from '../../shared/runtime-v2';
import { validateSettingsV2, validateUpdateSettingsRequestV2 } from '../../shared/validation-v2';

const MAX_BYTES = 4 * 1024 * 1024;
const KEYS = ['schemaVersion','taskFilePath','taskMode','reviewNotesPath','runProfiles','aiConsent','contextPatterns'] as const;
const sha = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
const hashOK = (s: unknown): s is string => typeof s === 'string' && /^[a-f0-9]{64}$/.test(s);
export class SettingsPersistenceError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = 'SettingsPersistenceError'; }
}
const fail = (code: string, message: string): never => { throw new SettingsPersistenceError(code, message); };
export interface SettingsTransactionIdentity {
  requestId: string; clientId: string; sessionId: string; expectedWorkspaceVersion: number; payloadSha256: string;
}
export interface SettingsMutation { sourceSha256: string; settingsSha256: string }
export interface SettingsSaveReceipt extends SettingsMutation, SettingsTransactionIdentity {
  status: 'OK' | 'DUPLICATE'; workspaceVersion: number;
}
export interface SettingsWriteLease {
  /** Must synchronously verify actual current authorization/owner/expected version/cancellation. */
  assertCurrent(): void;
}
/**
 * REQUIRED dependency, no permissive default. Production must serialize with actual WriteGate writes,
 * validate authenticated HUMAN/session/owner/version/idempotency, invoke effect at most once under that
 * lock and durably record its result+new workspaceVersion BEFORE returning OK. A throwing effect must
 * NOT advance version. A duplicate returns the retained original receipt WITHOUT invoking effect.
 * Unknown transaction results are reconciled by reconcile; they must never be guessed ABORTED.
 */
export type SettingsTransactionOutcome = { state: 'COMMITTED'; receipt: SettingsSaveReceipt } | { state: 'ABORTED' } | { state: 'UNKNOWN' };
export interface SettingsTransactionAuthority {
  transact(identity: Readonly<SettingsTransactionIdentity>, effect: (lease: SettingsWriteLease) => SettingsMutation): Promise<SettingsSaveReceipt>;
  /** Read actual durable outcome AND execute recovery under the same real write serialization. */
  reconcile<T>(identity: Readonly<SettingsTransactionIdentity>, effect: (outcome: SettingsTransactionOutcome, lease: SettingsWriteLease) => T): Promise<T>;
}
export interface SettingsReadResult {
  kind: 'V2' | 'MIGRATION_REQUIRED'; exists: boolean; sourceSha256: string;
  settings: SettingsV2 | null; problem: RuntimeProblem | null;
}
export interface SaveSettingsInput {
  request: UpdateSettingsRequestV2;
  /** Authoritative UI handler must obtain an explicit HUMAN save, never AI/autosave inference. */
  humanConfirmed: true;
  expectedSourceSha256: string;
}
export type SettingsCheckpoint = 'BACKUP_DURABLE' | 'NEXT_DURABLE' | 'JOURNAL_DURABLE' | 'BEFORE_REPLACE' | 'REPLACED' | 'DIRECTORY_SYNCED';
interface Source { exists: boolean; bytes: Buffer; hash: string; object: Record<string, unknown> | null }
interface Journal {
  schemaVersion: 1; identity: SettingsTransactionIdentity; sourceExists: boolean;
  sourceSha256: string; settingsSha256: string; nextFile: string;
}
/** Existing, absolute, trusted project storage parent. Reject links/ancestor substitutions, no following. */
function safeParents(directory: string): void {
  const full = path.resolve(directory), root = path.parse(full).root;
  let current = root;
  for (const component of path.relative(root, full).split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    const s = fs.lstatSync(current);
    if (!s.isDirectory() || s.isSymbolicLink() || fs.realpathSync.native(current) !== current) fail('UNSAFE_SETTINGS_PATH','Settings storage cannot traverse symbolic links.');
  }
}
function readRegular(file: string, missing = false): Buffer | null {
  safeParents(path.dirname(file));
  let fd: number;
  try { fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW); }
  catch (error) { if (missing && (error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  try {
    const s = fs.fstatSync(fd);
    if (!s.isFile() || s.nlink !== 1 || s.size > MAX_BYTES) fail('UNSAFE_SETTINGS_FILE','Expected a bounded unlinked regular settings file.');
    const bytes = fs.readFileSync(fd);
    if (bytes.length > MAX_BYTES) fail('SETTINGS_TOO_LARGE','Settings exceed the persistence bound.');
    return bytes;
  } finally { fs.closeSync(fd); }
}
const syncDirectory = (directory: string) => {
  safeParents(directory);
  let fd: number | undefined;
  try {
    fd = fs.openSync(directory, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
    fs.fsyncSync(fd);
  } catch (error) {
    // Match the existing SnapshotStorage platform boundary: Node on Windows does not expose
    // directory fsync. File fsync remains mandatory; native power-loss directory durability
    // is NOT claimed. All other errors (and all POSIX directory-sync failures) are fatal.
    if (process.platform !== 'win32' || !['EPERM','EACCES','EINVAL','EISDIR','EBADF'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
  } finally { if (fd !== undefined) fs.closeSync(fd); }
};
function writeExclusive(file: string, bytes: Buffer): void {
  safeParents(path.dirname(file));
  const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
  try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
/** A crash never publishes partially written bytes at a content-addressed or intent path. */
function publishExclusive(file: string, bytes: Buffer): void {
  const temp = file + '-tmp-' + randomUUID();
  writeExclusive(temp, bytes);
  try { fs.linkSync(temp, file); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  finally { fs.unlinkSync(temp); }
  syncDirectory(path.dirname(file));
  if (!readRegular(file)!.equals(bytes)) fail('PERSISTENCE_CONFLICT','Published settings state does not match durable input.');
}
const decodeObject = (bytes: Buffer): Record<string, unknown> | null => {
  try {
    const v: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    return v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null;
  } catch { return null; }
};
function projectSettings(object: Record<string, unknown> | null): SettingsV2 | null {
  if (!object) return null;
  const projected = Object.fromEntries(KEYS.map(key => [key, object[key]]));
  // A mixed root with legacy execution fields is not silently accepted as V2.
  if (['executable','args','cwd','runProfileSchemaVersion','runProfile'].some(key => Object.hasOwn(object, key))) return null;
  return validateSettingsV2(projected) ? projected : null;
}

export class SettingsV2Store {
  readonly settingsPath: string;
  readonly stateDirectory: string;
  private busy = false;
  constructor(options: { settingsPath: string; authority: SettingsTransactionAuthority; checkpoint?: (phase: SettingsCheckpoint) => void }) {
    if (!path.isAbsolute(options.settingsPath)) fail('UNSAFE_SETTINGS_PATH','An absolute trusted project settings path is required.');
    if (!options.authority || typeof options.authority.transact !== 'function' || typeof options.authority.reconcile !== 'function') fail('AUTHORITY_REQUIRED','An actual transaction/version/idempotency authority is required.');
    this.settingsPath = path.normalize(options.settingsPath);
    this.stateDirectory = this.settingsPath + '.v2-state';
    safeParents(path.dirname(this.settingsPath));
    this.authority = options.authority; this.checkpoint = options.checkpoint ?? (() => {});
  }
  private readonly authority: SettingsTransactionAuthority;
  private readonly checkpoint: (phase: SettingsCheckpoint) => void;
  private get journalPath() { return path.join(this.stateDirectory, 'pending.json'); }
  private stateExists(): boolean {
    try {
      const s = fs.lstatSync(this.stateDirectory);
      if (!s.isDirectory() || s.isSymbolicLink()) fail('UNSAFE_SETTINGS_PATH','Settings state directory is unsafe.');
      safeParents(this.stateDirectory); return true;
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
  }
  private ensureState(): void {
    if (!this.stateExists()) { fs.mkdirSync(this.stateDirectory, { mode: 0o700 }); syncDirectory(path.dirname(this.stateDirectory)); }
  }
  private source(): Source {
    const bytes = readRegular(this.settingsPath, true);
    return { exists: bytes !== null, bytes: bytes ?? Buffer.alloc(0), hash: sha(bytes ?? Buffer.alloc(0)), object: bytes === null ? {} : decodeObject(bytes) };
  }
  private pending(): Journal | null {
    if (!this.stateExists()) return null;
    const bytes = readRegular(this.journalPath, true);
    if (!bytes) return null;
    let j: Journal;
    try { j = JSON.parse(bytes.toString('utf8')); } catch { return fail('RECOVERY_REQUIRED','Invalid settings transaction journal; retain evidence.'); }
    if (j.schemaVersion !== 1 || !hashOK(j.sourceSha256) || !hashOK(j.settingsSha256) || j.nextFile !== 'next-' + j.settingsSha256 + '.json' || typeof j.sourceExists !== 'boolean' ||
      !j.identity || !hashOK(j.identity.payloadSha256) || !(['requestId','clientId','sessionId'] as const).every(k => typeof j.identity[k] === 'string' && j.identity[k].length > 0 && j.identity[k].length <= 256) ||
      !Number.isSafeInteger(j.identity.expectedWorkspaceVersion) || j.identity.expectedWorkspaceVersion < 0) return fail('RECOVERY_REQUIRED','Invalid settings journal identity; retain evidence.');
    return j;
  }
  /** Read never rewrites original bytes or upgrades an unknown/legacy/mixed format. */
  read(): SettingsReadResult {
    if (this.pending()) fail('RECOVERY_REQUIRED','Reconcile the pending settings transaction before reading executable settings.');
    const source = this.source(), settings = projectSettings(source.object);
    return { kind: settings ? 'V2' : 'MIGRATION_REQUIRED', exists: source.exists, sourceSha256: source.hash, settings: settings ? structuredClone(settings) : null,
      problem: settings ? null : { code: 'LEGACY_RUN_PROFILE_REQUIRES_MIGRATION', message: 'Existing settings have not been explicitly saved as V2; execution is disabled.', recovery: 'Review and explicitly save V2 task configuration. Original settings remain intact; editing/recovery are available.', retryable: false } };
  }
  private backup(source: Source): void {
    if (!source.exists) return;
    const final = path.join(this.stateDirectory, 'backup-' + source.hash + '.json');
    const prior = readRegular(final, true);
    if (prior) { if (!prior.equals(source.bytes)) fail('BACKUP_CONFLICT','Existing settings backup does not match its source hash.'); return; }
    // Atomic NO-REPLACE publication; interrupted temp writes are never accepted as a backup.
    publishExclusive(final, source.bytes);
    if (!readRegular(final)!.equals(source.bytes)) fail('BACKUP_CONFLICT','Settings backup readback failed.');
  }
  private replace(bytes: Buffer): void {
    safeParents(path.dirname(this.settingsPath));
    const temp = path.join(path.dirname(this.settingsPath), '.' + path.basename(this.settingsPath) + '-v2-' + randomUUID());
    writeExclusive(temp, bytes);
    try { safeParents(path.dirname(this.settingsPath)); fs.renameSync(temp, this.settingsPath); syncDirectory(path.dirname(this.settingsPath)); }
    finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); }
  }
  private cleanJournal(j: Journal): void {
    const current = this.pending();
    if (!current) return; // Another serialized recovery already completed this exact intent.
    if (JSON.stringify(current) !== JSON.stringify(j)) fail('RECOVERY_REQUIRED','A different settings transaction owns the current journal.');
    // Remove intent first and fsync before removing next bytes; recovery never sees a missing required next file.
    fs.unlinkSync(this.journalPath); syncDirectory(this.stateDirectory);
    const next = path.join(this.stateDirectory, j.nextFile);
    if (readRegular(next, true)) fs.unlinkSync(next);
    syncDirectory(this.stateDirectory);
  }
  private receiptValid(receipt: SettingsSaveReceipt, identity: SettingsTransactionIdentity): boolean {
    return !!receipt && ['OK','DUPLICATE'].includes(receipt.status) && hashOK(receipt.sourceSha256) && hashOK(receipt.settingsSha256) &&
      (['requestId','clientId','sessionId','expectedWorkspaceVersion','payloadSha256'] as const).every(k => receipt[k] === identity[k]) &&
      receipt.workspaceVersion === identity.expectedWorkspaceVersion + 1;
  }
  /** Explicit save only. Unknown results retain durable intent and block another save until readback. */
  async save(input: SaveSettingsInput): Promise<SettingsSaveReceipt> {
    if (this.busy) fail('SETTINGS_BUSY','A settings operation is already in progress.');
    if (input.humanConfirmed !== true || !validateUpdateSettingsRequestV2(input.request) || !hashOK(input.expectedSourceSha256)) fail('INVALID_SETTINGS','An explicit HUMAN V2 save with valid version/idempotency and source hash is required.');
    const request = structuredClone(input.request);
    const expectedSourceSha256 = input.expectedSourceSha256;
    // Bind idempotency to ALL input, including source version and explicit settings; never profile inference.
    const identity: SettingsTransactionIdentity = { requestId: request.requestId, clientId: request.clientId, sessionId: request.sessionId,
      expectedWorkspaceVersion: request.expectedWorkspaceVersion, payloadSha256: sha(JSON.stringify({ settings: request.settings, source: expectedSourceSha256 })) };
    this.busy = true;
    let applied: Journal | null = null, invoked = false, callbackOpen = true;
    try {
      if (this.pending()) fail('RECOVERY_REQUIRED','Reconcile pending settings intent before another save.');
      const receipt = await this.authority.transact(Object.freeze(identity), lease => {
        if (!callbackOpen || invoked) return fail('AUTHORITY_PROTOCOL','Authority invoked a settings effect more than once or after settlement.');
        invoked = true;
        lease.assertCurrent();
        if (this.pending()) fail('RECOVERY_REQUIRED','Another settings transaction must be reconciled first.');
        const source = this.source();
        if (source.hash !== expectedSourceSha256) fail('SETTINGS_SOURCE_CONFLICT','Settings source changed; preserve modal input and reload before saving.');
        if (!source.object) return fail('UNMERGEABLE_SETTINGS','Malformed/non-object settings cannot be safely merged. Retain original bytes and resolve explicitly.');
        if (source.object.schemaVersion !== undefined && ![1, 2].includes(source.object.schemaVersion as number)) fail('UNSUPPORTED_SETTINGS_VERSION','Unknown settings versions cannot be downgraded; retain original bytes and resolve explicitly.');
        if (!projectSettings(source.object)) {
          // A RunProfile migration is NOT a consent/context/task reset. The UI must preserve these
          // existing values rather than submitting defaults. Later explicit V2 edits may change them.
          for (const key of KEYS.filter(key => key !== 'schemaVersion' && key !== 'runProfiles')) {
            if (Object.hasOwn(source.object, key) && JSON.stringify(source.object[key]) !== JSON.stringify(request.settings[key])) {
              return fail('UNRELATED_SETTINGS_CONFLICT','Migration must retain existing consent, context and task settings. Preserve modal input and review those fields.');
            }
          }
        }
        const nextObject: Record<string, unknown> = { ...source.object, ...request.settings };
        // Retire only known legacy execution root keys. Original bytes are retained in their hash backup.
        for (const key of ['executable','args','cwd','runProfileSchemaVersion','runProfile']) delete nextObject[key];
        const next = Buffer.from(JSON.stringify(nextObject, null, 2) + '\n');
        if (next.length > MAX_BYTES) fail('SETTINGS_TOO_LARGE','Merged settings exceed persistence bound.');
        this.ensureState(); this.backup(source); this.checkpoint('BACKUP_DURABLE');
        const nextSha = sha(next), nextFile = 'next-' + nextSha + '.json', nextPath = path.join(this.stateDirectory, nextFile);
        const previous = readRegular(nextPath, true);
        if (previous) { if (!previous.equals(next)) fail('RECOVERY_REQUIRED','Staged settings hash conflict.'); }
        else publishExclusive(nextPath, next);
        this.checkpoint('NEXT_DURABLE');
        const journal: Journal = { schemaVersion: 1, identity, sourceExists: source.exists, sourceSha256: source.hash, settingsSha256: nextSha, nextFile };
        publishExclusive(this.journalPath, Buffer.from(JSON.stringify(journal)));
        applied = journal; this.checkpoint('JOURNAL_DURABLE');
        // No awaits between authoritative check / exact bytes recheck and atomic replace.
        lease.assertCurrent();
        if (this.source().hash !== source.hash) fail('SETTINGS_SOURCE_CONFLICT','Settings changed while staging; original/new external bytes are retained.');
        this.checkpoint('BEFORE_REPLACE');
        lease.assertCurrent();
        if (this.source().hash !== source.hash) fail('SETTINGS_SOURCE_CONFLICT','Settings source changed before replacement.');
        try {
          this.replace(next); this.checkpoint('REPLACED');
          this.checkpoint('DIRECTORY_SYNCED');
          if (this.source().hash !== nextSha) fail('SETTINGS_SOURCE_CONFLICT','Settings changed after replacement.');
        } catch (error) {
          // A known failed effect must leave original bytes. Never overwrite an unrelated external writer.
          if (this.source().hash === nextSha) {
            if (source.exists) this.replace(source.bytes);
            else { fs.unlinkSync(this.settingsPath); syncDirectory(path.dirname(this.settingsPath)); }
          }
          throw error;
        }
        return { sourceSha256: source.hash, settingsSha256: nextSha };
      });
      callbackOpen = false;
      const completed = applied as Journal | null;
      if (!this.receiptValid(receipt, identity) || (invoked ? receipt.status !== 'OK' || !completed || receipt.sourceSha256 !== completed.sourceSha256 || receipt.settingsSha256 !== completed.settingsSha256 : receipt.status !== 'DUPLICATE')) fail('RECOVERY_REQUIRED','Transaction outcome is not an authoritative matching receipt.');
      if (applied) {
        const outcome = await this.reconcile();
        if (outcome !== 'COMMITTED' && outcome !== 'NONE') fail('RECOVERY_REQUIRED','Authority receipt conflicts with durable transaction readback.');
      }
      return structuredClone(receipt);
    } catch (error) {
      callbackOpen = false;
      // No blind retry or presumed rollback after an unknown authority result.
      if (applied) {
        try { await this.reconcile(); }
        catch { return fail('RECOVERY_REQUIRED','Settings transaction outcome is uncertain. Keep modal input; reconcile by authority readback before retry.'); }
      }
      throw error;
    } finally { callbackOpen = false; this.busy = false; }
  }
  private async reconcile(): Promise<'NONE' | 'COMMITTED' | 'ABORTED'> {
    const j = this.pending(); if (!j) return 'NONE';
    return this.authority.reconcile(Object.freeze(j.identity), (outcome, lease) => {
    lease.assertCurrent();
    const currentJournal = this.pending();
    if (!currentJournal) return 'NONE';
    if (JSON.stringify(currentJournal) !== JSON.stringify(j)) return fail('RECOVERY_REQUIRED','The pending transaction changed before serialized recovery.');
    if (outcome.state === 'UNKNOWN') return fail('RECOVERY_REQUIRED','Actual settings transaction outcome is unknown.');
    const current = this.source();
    if (current.hash !== j.sourceSha256 && current.hash !== j.settingsSha256) return fail('SETTINGS_SOURCE_CONFLICT','An external writer changed settings during recovery; preserve all evidence.');
    if (outcome.state === 'COMMITTED') {
      if (!this.receiptValid(outcome.receipt, j.identity) || outcome.receipt.sourceSha256 !== j.sourceSha256 || outcome.receipt.settingsSha256 !== j.settingsSha256) fail('RECOVERY_REQUIRED','Committed authority receipt does not match pending settings.');
      const next = readRegular(path.join(this.stateDirectory, j.nextFile));
      if (sha(next!) !== j.settingsSha256) fail('RECOVERY_REQUIRED','Durable next settings do not match journal.');
      if (current.hash !== j.settingsSha256) this.replace(next!);
    } else {
      if (current.hash !== j.sourceSha256) {
        if (j.sourceExists) {
          const backup = readRegular(path.join(this.stateDirectory, 'backup-' + j.sourceSha256 + '.json'));
          if (sha(backup!) !== j.sourceSha256) fail('RECOVERY_REQUIRED','Original settings backup is invalid.');
          this.replace(backup!);
        } else { fs.unlinkSync(this.settingsPath); syncDirectory(path.dirname(this.settingsPath)); }
      }
    }
    this.cleanJournal(j); return outcome.state;
    });
  }
  /** Restart path: reconcile by actual authority receipt, never replay transact/advance a version. */
  async recover(): Promise<'NONE' | 'COMMITTED' | 'ABORTED'> {
    if (this.busy) fail('SETTINGS_BUSY','A settings operation is already in progress.');
    this.busy = true;
    try { return await this.reconcile(); } finally { this.busy = false; }
  }
}
