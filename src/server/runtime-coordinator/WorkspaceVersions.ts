/** Durable V2 workspace/document versions + exact settings outcomes. One kernel owner, no eviction.
 * Enabled explicitly by the V2 composition; legacy Workspace constructors keep their old contract.
 */
import path from 'node:path';
import fs from 'node:fs';
import { JournalLease } from './JournalLease';
import { canonical, privateDirectory, readRecord, createRecord, replaceRecord, sha256 } from './storage';
import type { SettingsSaveReceipt, SettingsTransactionIdentity, SettingsTransactionOutcome, SettingsMutation } from '../settings-v2';
import { AppError } from '../errors';
export interface VersionSnapshot { workspaceVersion: number; files: { path: string; version: number; stamp: string | null }[] }
type Saved = { identity: SettingsTransactionIdentity; outcome: Exclude<SettingsTransactionOutcome, { state: 'UNKNOWN' }> };
interface State extends VersionSnapshot { schemaVersion: 1; projectId: string; root: string; pending: SettingsTransactionIdentity | null; outcomes: Saved[] }
const MAX_BYTES = 16 * 1024 * 1024, MAX_PATHS = 10000, MAX_OUTCOMES = 10000;
const copy = <T>(v: T): T => structuredClone(v);
const positive = (v: unknown): v is number => Number.isSafeInteger(v) && Number(v) > 0;
const nonnegative = (v: unknown): v is number => Number.isSafeInteger(v) && Number(v) >= 0;
const validIdentity = (i: SettingsTransactionIdentity): boolean => !!i &&
  ['requestId','sessionId','clientId'].every(k => typeof i[k as keyof typeof i] === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(String(i[k as keyof typeof i]))) &&
  nonnegative(i.expectedWorkspaceVersion) && /^[a-f0-9]{64}$/.test(i.payloadSha256);
const key = (i: SettingsTransactionIdentity) => canonical([i.sessionId, i.clientId, i.requestId]);
const fail = (code: string, message: string): never => { throw new AppError(409, code, message); };
export class DurableWorkspaceVersions {
  private readonly lease: JournalLease;
  private readonly file: string;
  private state: State;
  private poisoned = false;
  private closed = false;
  constructor(directory: string, projectId: string, root: string, initial: VersionSnapshot) {
    privateDirectory(directory);
    this.file = path.join(directory, 'versions.json');
    const leasePath = path.join(directory, 'lease.lock');
    const priorOwnership = fs.existsSync(leasePath);
    this.lease = new JournalLease(leasePath);
    try {
      // Unknown/partial publications are retained. No record absence in a nonempty journal is
      // authority to forget prior versions or settings outcomes.
      const names = fs.readdirSync(directory);
      if (names.some(n => n !== 'lease.lock' && n !== 'versions.json')) throw Error('Workspace version recovery required');
      const bytes = readRecord(this.file, MAX_BYTES, true);
      if (bytes) {
        const envelope = JSON.parse(new TextDecoder('utf8', { fatal: true }).decode(bytes));
        this.state = envelope.body;
        if (envelope.sha256 !== sha256(canonical(this.state))) throw Error('Workspace version integrity failure');
        this.validate(this.state);
        if (this.state.projectId !== projectId || this.state.root !== root) throw Error('Workspace version scope mismatch');
        // A crash/external edit before the last acknowledgement cannot reuse an old version.
        const disk = new Map(initial.files.map(f => [f.path, f.stamp]));
        const previous = new Map(this.state.files.map(f => [f.path, f]));
        const files: VersionSnapshot['files'] = [];
        let workspaceVersion = this.state.workspaceVersion;
        for (const name of new Set([...disk.keys(), ...previous.keys()])) {
          const old = previous.get(name), stamp = disk.get(name) ?? null;
          if (!old && stamp === null) continue;
          if (old?.stamp === stamp) files.push(copy(old));
          else { files.push({ path: name, stamp, version: (old?.version ?? 0) + 1 }); workspaceVersion++; }
        }
        // Pending settings retain the old version until operation-specific recovery. Ordinary
        // disk observations are still reconciled, but cannot settle/guess the settings result.
        if (canonical(files) !== canonical(this.state.files) || workspaceVersion !== this.state.workspaceVersion)
          this.publish({ ...this.state, files, workspaceVersion });
      } else {
        // The stable kernel lease is never unlinked. Its prior presence with missing state is
        // initialization uncertainty/lost persistence, NOT a new workspace/version-zero grant.
        if (priorOwnership) throw Error('Missing prior workspace versions; retain state and recover');
        this.state = { ...copy(initial), schemaVersion: 1, projectId, root, pending: null, outcomes: [] };
        this.validate(this.state); createRecord(this.file, this.encoded(this.state));
      }
    } catch (e) { this.lease.close(); throw e; }
  }
  private validate(s: State): void {
    if (!s || s.schemaVersion !== 1 || typeof s.projectId !== 'string' || typeof s.root !== 'string' || !path.isAbsolute(s.root) ||
        !nonnegative(s.workspaceVersion) || !Array.isArray(s.files) || s.files.length > MAX_PATHS || !Array.isArray(s.outcomes) || s.outcomes.length > MAX_OUTCOMES ||
        (s.pending !== null && !validIdentity(s.pending))) throw Error('Invalid durable workspace versions');
    const paths = new Set<string>(), requests = new Set<string>();
    for (const f of s.files) {
      if (!f || typeof f.path !== 'string' || !f.path || f.path.length > 1024 || paths.has(f.path) || !positive(f.version) ||
          !(f.stamp === null || typeof f.stamp === 'string' && f.stamp.length > 0 && f.stamp.length <= 1024)) throw Error('Invalid durable document version');
      paths.add(f.path);
    }
    for (const r of s.outcomes) {
      if (!r || !validIdentity(r.identity) || requests.has(key(r.identity)) || !r.outcome || !['COMMITTED','ABORTED'].includes(r.outcome.state)) throw Error('Invalid settings outcome');
      requests.add(key(r.identity));
      if (r.outcome.state === 'COMMITTED') {
        const receipt = r.outcome.receipt;
        if (!receipt || receipt.status !== 'OK' || !/^[a-f0-9]{64}$/.test(receipt.sourceSha256) || !/^[a-f0-9]{64}$/.test(receipt.settingsSha256) ||
            receipt.workspaceVersion !== r.identity.expectedWorkspaceVersion + 1 || receipt.workspaceVersion > s.workspaceVersion ||
            Object.entries(r.identity).some(([k,v]) => receipt[k as keyof typeof receipt] !== v)) throw Error('Invalid committed settings receipt');
      }
    }
    if (s.pending && requests.has(key(s.pending))) throw Error('Final settings operation still pending');
  }
  private encoded(s: State): Buffer {
    const bytes = Buffer.from(canonical({ body: s, sha256: sha256(canonical(s)) }));
    if (bytes.length > MAX_BYTES) throw Error('Workspace versions exhausted');
    return bytes;
  }
  assertCurrent(): void {
    if (this.closed || this.poisoned) throw new AppError(503, 'WORKSPACE_VERSIONS_UNAVAILABLE', 'Durable workspace state is unavailable; retain original requests.');
    this.lease.assertCurrent();
    try { if (!readRecord(this.file, MAX_BYTES)!.equals(this.encoded(this.state))) throw Error('Workspace versions changed'); }
    catch (e) { this.poisoned = true; throw e; }
  }
  private publish(next: State): void {
    this.validate(next);
    try { replaceRecord(this.file, this.encoded(next)); this.state = copy(next); }
    catch (e) { this.poisoned = true; throw e; }
  }
  snapshot(): VersionSnapshot { this.assertCurrent(); return copy({ workspaceVersion: this.state.workspaceVersion, files: this.state.files }); }
  assertWritable(): void {
    this.assertCurrent();
    if (this.state.pending) fail('SETTINGS_RECOVERY_REQUIRED', 'Reconcile the original settings operation before another mutation.');
  }
  commitVersions(next: VersionSnapshot): void {
    this.assertWritable();
    if (next.workspaceVersion !== this.state.workspaceVersion + 1) fail('WORKSPACE_VERSION_CONFLICT', 'Workspace version publication is not the next durable version.');
    const before = new Map(this.state.files.map(f => [f.path, f]));
    for (const f of next.files) {
      const old = before.get(f.path);
      if (old && (f.version < old.version || f.version > old.version + 1 || f.stamp !== old.stamp && f.version !== old.version + 1)) throw Error('Document version regression');
      before.delete(f.path);
    }
    if (before.size) throw Error('Document version tombstones cannot be discarded');
    this.publish({ ...this.state, ...copy(next) });
  }
  outcome(identity: SettingsTransactionIdentity): SettingsTransactionOutcome | null {
    this.assertCurrent();
    if (!validIdentity(identity)) throw Error('Invalid settings identity');
    const stored = this.state.outcomes.find(r => key(r.identity) === key(identity));
    const original = stored?.identity ?? (this.state.pending && key(this.state.pending) === key(identity) ? this.state.pending : null);
    if (original && canonical(original) !== canonical(identity)) fail('IDEMPOTENCY_CONFLICT', 'Settings request is bound to different immutable input.');
    return stored ? copy(stored.outcome) : original ? { state: 'UNKNOWN' } : null;
  }
  pendingSettings(): SettingsTransactionIdentity | null { this.assertCurrent(); return copy(this.state.pending); }
  beginSettings(identity: SettingsTransactionIdentity): void {
    this.assertWritable();
    if (this.outcome(identity)) throw Error('Settings operation already reserved');
    if (this.state.outcomes.length >= MAX_OUTCOMES) throw Error('Settings outcome budget exhausted');
    if (identity.expectedWorkspaceVersion !== this.state.workspaceVersion || !Number.isSafeInteger(identity.expectedWorkspaceVersion + 1))
      fail('WORKSPACE_VERSION_CONFLICT', 'Settings require the current durable workspace version.');
    this.publish({ ...this.state, pending: copy(identity) });
  }
  finishSettings(identity: SettingsTransactionIdentity, mutation: SettingsMutation | null): SettingsTransactionOutcome {
    this.assertCurrent();
    if (this.state.pending && canonical(this.state.pending) !== canonical(identity)) fail('SETTINGS_RECOVERY_REQUIRED', 'Another settings intent owns the durable reservation.');
    if (this.outcome(identity)?.state === 'COMMITTED' || this.outcome(identity)?.state === 'ABORTED') throw Error('Settings outcome is immutable');
    if (mutation && (!this.state.pending || this.state.workspaceVersion !== identity.expectedWorkspaceVersion)) throw Error('Settings version reservation changed');
    if (this.state.outcomes.length >= MAX_OUTCOMES) throw Error('Settings outcome budget exhausted');
    const outcome: Saved['outcome'] = mutation ? { state: 'COMMITTED', receipt: { ...copy(identity), ...copy(mutation), status: 'OK', workspaceVersion: identity.expectedWorkspaceVersion + 1 } } : { state: 'ABORTED' };
    this.publish({ ...this.state, workspaceVersion: mutation ? identity.expectedWorkspaceVersion + 1 : this.state.workspaceVersion,
      pending: null, outcomes: [...this.state.outcomes, { identity: copy(identity), outcome }] });
    return copy(outcome);
  }
  close(): void { if (!this.closed) { this.lease.close(); this.closed = true; } }
}
