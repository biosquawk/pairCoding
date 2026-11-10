import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { AppError } from './errors';
import { atomicNoReplace, prepareAtomicNoReplace } from './AtomicNoReplace';
import { SnapshotStorage, type FrozenFile, type Identity, identity, sameIdentity, validIdentity, privateDirectory,
  privateRead, privateWrite, syncDirectory, sha256, missing, snapshotFailure, SNAPSHOT_MAX_BYTES } from './SnapshotStorage';

export type RestoreBefore = FrozenFile & { identity: Identity | null; mtimeNs: string | null };
type Image = { hash: string; mode: number; size: number };
type Entry = { path: string; before: Image | null; after: Image | null; original: Identity | null;
  originalMtime: string | null; forward: Identity | null; rollback: Identity | null };
type Intent = { format: number; id: string; binding: unknown; backupId: string; ownerPid: number; entries: Entry[] };
const operationName = /^transaction-([0-9a-f-]{36})$/;

/** No forward replay. All captured entries are retained, even after a clean rollback/commit. */
export class SnapshotJournal {
  readonly base: string;
  private settled = new Map<string, string>();
  constructor(private readonly store: SnapshotStorage, private readonly safePath: (p: string, missing?: boolean) => string,
    private readonly checkpoint: (phase: string, index: number) => void) {
    this.base = path.join(store.privateRoot, 'snapshot-journal-v1');
  }

  private operations(): string[] {
    try { privateDirectory(this.base); } catch (e) { if (missing(e)) return []; throw e; }
    const names = fs.readdirSync(this.base);
    if (names.some(n => !operationName.test(n) && !/^\.prepare-[0-9a-f-]{36}$/.test(n))) throw snapshotFailure(`Unknown journal material in ${this.base}.`);
    for (const name of names.filter(n => n.startsWith('.prepare-'))) {
      const preparing = privateDirectory(path.join(this.base, name));
      if (fs.readdirSync(preparing).some(n => /\.(captured|undone)$|\.foreign-|^(COMMITTED|ROLLED_BACK)$/.test(n))) {
        throw snapshotFailure('A preparation directory contains mutation evidence; preserve and inspect it before writing.');
      }
    }
    return names.filter(n => operationName.test(n)).sort().map(n => path.join(this.base, n));
  }

  hasPending(): boolean {
    for (const directory of this.operations()) {
      const stamp = this.terminalStamp(directory);
      if (this.settled.get(directory) === stamp) continue;
      const intent = this.header(directory);
      if (!this.terminal(directory, intent)) return true;
      this.settled.set(directory, stamp);
    }
    return false;
  }

  private terminalStamp(directory: string): string {
    privateDirectory(directory);
    return ['', 'intent.json', 'COMMITTED', 'ROLLED_BACK'].map(name => {
      try {
        const s = fs.lstatSync(path.join(directory, name), { bigint: true });
        return [s.dev, s.ino, s.mode, s.size, s.mtimeNs, s.ctimeNs, s.nlink].join(':');
      } catch (e) { if (missing(e)) return 'MISSING'; throw e; }
    }).join('|');
  }

  private exists(file: string): boolean {
    privateDirectory(path.dirname(file));
    try { fs.lstatSync(file); return true; } catch (e) { if (missing(e)) return false; throw e; }
  }

  private terminal(directory: string, intent: Intent): boolean {
    this.assertNoActiveMove(directory);
    let terminal = false;
    for (const state of ['COMMITTED', 'ROLLED_BACK']) if (this.exists(path.join(directory, state))) {
      const marker = this.store.readSigned<{ id: string; state: string; binding: unknown }>(path.join(directory, state), 8192);
      this.store.assertBinding(marker.binding);
      if (marker.id !== intent.id || marker.state !== state || terminal) throw snapshotFailure('Inconsistent journal terminal markers.');
      terminal = true;
    }
    return terminal;
  }

  private marker(directory: string, intent: Intent, state: string): void {
    const temp = path.join(directory, '.marker-' + randomUUID());
    this.store.writeSigned(temp, { id: intent.id, state, binding: this.store.binding }, 8192);
    privateDirectory(directory);
    fs.linkSync(temp, path.join(directory, state));
    fs.unlinkSync(temp);
    syncDirectory(directory);
  }

  private header(directory: string): Intent {
    privateDirectory(directory);
    const intent = this.store.readSigned<Intent>(path.join(directory, 'intent.json'));
    this.store.assertBinding(intent.binding);
    if (intent.format !== 1 || path.basename(directory) !== 'transaction-' + intent.id || !Number.isSafeInteger(intent.ownerPid) || intent.ownerPid <= 0 || !Array.isArray(intent.entries) || !intent.entries.length) throw snapshotFailure('Invalid journal intent.');
    this.store.paths(intent.entries.map(e => e.path), false, false);
    return intent;
  }

  private load(directory: string): Intent {
    const intent = this.header(directory);
    // Backup is independently authenticated and is a complete before-image of this transaction.
    const backup = this.store.read(intent.backupId);
    if (backup.files.length !== intent.entries.length) throw snapshotFailure('Journal backup mismatch.');
    for (const [i, e] of intent.entries.entries()) {
      this.checkImages(directory, i, e);
      if ((e.before === null) !== (e.original === null) || (e.before === null) !== (e.rollback === null) ||
          (e.after === null) !== (e.forward === null) || (e.original && !validIdentity(e.original)) ||
          (e.rollback && !validIdentity(e.rollback)) || (e.forward && !validIdentity(e.forward)) ||
          (e.before && !/^\d+$/.test(e.originalMtime ?? ''))) throw snapshotFailure('Invalid journal ownership metadata.');
      const b = backup.files[i];
      if (b.path !== e.path || b.mode !== (e.before?.mode ?? null) ||
          (b.rawBase64 === null ? e.before !== null : sha256(Buffer.from(b.rawBase64, 'base64')) !== e.before?.hash)) throw snapshotFailure('Before-image does not match durable backup.');
    }
    return intent;
  }

  private checkImages(directory: string, i: number, e: Entry): void {
    const check = (image: Image | null, slot: string) => {
      if (image === null) return;
      if (!image || !/^[a-f0-9]{64}$/.test(image.hash) || !Number.isInteger(image.mode) || image.mode < 0 || image.mode > 0o777 ||
          !Number.isInteger(image.size) || image.size < 0 || image.size > SNAPSHOT_MAX_BYTES) throw snapshotFailure('Invalid journal image.');
      const raw = privateRead(path.join(directory, slot), SNAPSHOT_MAX_BYTES);
      if (raw.length !== image.size || sha256(raw) !== image.hash) throw snapshotFailure('Journal image checksum mismatch.');
    };
    check(e.before, `${i}.before`); check(e.after, `${i}.after`);
  }

  private file(relative: string): string { this.store.assertBinding(this.store.binding); return this.safePath(relative, true); }

  private matches(file: string, id: Identity | null, image: Image | null, links = 1, mtime?: string): boolean {
    if (!id || !image) return false;
    const s = fs.lstatSync(file, { bigint: true });
    if (!s.isFile() || s.isSymbolicLink() || !sameIdentity(s, id) || s.nlink < 1n || s.nlink > BigInt(links) ||
        s.size !== BigInt(image.size) || Number(s.mode & 0o777n) !== image.mode || (mtime !== undefined && String(s.mtimeNs) !== mtime)) return false;
    // The same bounded/pinned read rules apply to public paths (ancestry is checked by file()).
    return sha256(privateRead(file, SNAPSHOT_MAX_BYTES, links)) === image.hash;
  }

  private assertFile(file: string, id: Identity | null, image: Image | null, links = 1, mtime?: string): void {
    if (!this.matches(file, id, image, links, mtime)) throw snapshotFailure(`Unexpected inode/bytes at ${file}; preserve public paths and all captures.`);
  }

  private prepare(before: RestoreBefore[], after: FrozenFile[], backupId: string): { directory: string; intent: Intent } {
    privateDirectory(this.base, true);
    const id = randomUUID();
    const staging = privateDirectory(path.join(this.base, '.prepare-' + id), true);
    const entries = before.map((b, i): Entry => {
      const a = after[i];
      const image = (f: FrozenFile, name: string): Image | null => {
        if (f.rawBase64 === null) return null;
        const bytes = Buffer.from(f.rawBase64, 'base64');
        privateWrite(path.join(staging, name), bytes);
        return { hash: sha256(bytes), mode: f.mode!, size: bytes.length };
      };
      const beforeImage = image(b, `${i}.before`), afterImage = image(a, `${i}.after`);
      const forward = afterImage ? privateWrite(path.join(staging, `${i}.forward`), Buffer.from(a.rawBase64!, 'base64'), a.mode!) : null;
      const rollback = beforeImage ? privateWrite(path.join(staging, `${i}.rollback`), Buffer.from(b.rawBase64!, 'base64'), b.mode!) : null;
      return { path: b.path, before: beforeImage, after: afterImage, original: b.identity, originalMtime: b.mtimeNs, forward, rollback };
    });
    const intent: Intent = { format: 1, id, binding: this.store.binding, backupId, ownerPid: process.pid, entries };
    this.store.writeSigned(path.join(staging, 'intent.json'), intent);
    const directory = path.join(this.base, 'transaction-' + id);
    fs.renameSync(staging, directory); syncDirectory(this.base);
    return { directory, intent };
  }

  private assertNoActiveMove(directory: string): void {
    privateDirectory(directory);
    // Parent SIGKILL can orphan a helper. Only a durable authenticated JOINED record
    // proves that spawnSync reaped it. Neither public vacancy nor dead parent PID does.
    for (const name of fs.readdirSync(directory).filter(name => name.endsWith('.move-pending'))) {
      const file = path.join(directory, name);
      const pending = this.store.readSigned<{ binding: unknown }>(file, 8192);
      this.store.assertBinding(pending.binding);
      let joined: unknown;
      try { joined = this.store.readSigned(file + '.joined', 8192); }
      catch { throw snapshotFailure('A native move may have been in flight. Preserve the entire journal/public files and confirm the helper has stopped before manual reconciliation.'); }
      if (JSON.stringify(joined) !== JSON.stringify(pending)) throw snapshotFailure('Native move completion does not match its durable intent.');
    }
  }

  private captureNoReplace(directory: string, i: number, from: string, to: string, undo: boolean): void {
    const id = randomUUID();
    const pending = path.join(directory, `${i}.${undo ? 'undo' : 'capture'}.${id}.move-pending`);
    const record = { id, binding: this.store.binding, index: i, undo, ownerPid: process.pid };
    this.store.writeSigned(pending, record, 8192);
    try {
      this.checkpoint(undo ? 'UNDO_MOVE_ARMED' : 'CAPTURE_MOVE_ARMED', i);
      atomicNoReplace(from, to);
    } finally {
      // spawnSync joins (also after a SIGKILL timeout) before returning/throwing. A hard
      // parent termination skips this append: recovery then refuses uncertain effects.
      // Keep BOTH records; no unlink of a slot that could have been replaced meanwhile.
      this.store.writeSigned(pending + '.joined', record, 8192);
    }
    this.checkpoint(undo ? 'UNDO_MOVE_JOINED' : 'CAPTURE_MOVE_JOINED', i);
  }

  /** A private alias is removed only after BOTH aliases have been validated. */
  private publish(directory: string, i: number, e: Entry, rollback: boolean): void {
    const id = rollback ? e.rollback : e.forward, image = rollback ? e.before : e.after;
    const stage = path.join(directory, `${i}.${rollback ? 'rollback' : 'forward'}`);
    this.assertFile(stage, id, image);
    const absolute = this.file(e.path);
    fs.linkSync(stage, absolute); // no-clobber, including a file appearing after all prechecks
    syncDirectory(path.dirname(absolute));
    this.cleanAlias(stage, e, id, image);
  }

  private cleanAlias(stage: string, e: Entry, id: Identity | null, image: Image | null): void {
    if (!this.exists(stage)) return;
    this.assertFile(stage, id, image, 2);
    this.assertFile(this.file(e.path), id, image, 2);
    fs.unlinkSync(stage); syncDirectory(path.dirname(stage));
    // No pinned handle survives this method. ctime is read only after the last close.
    this.assertFile(this.file(e.path), id, image);
  }

  private parents(relative: string, authorize: () => void): void {
    const parts = relative.split('/').slice(0, -1);
    for (let n = 1; n <= parts.length; n++) {
      const directory = this.file(parts.slice(0, n).join('/'));
      authorize();
      if (!fs.existsSync(directory)) { fs.mkdirSync(directory, { mode: 0o700 }); syncDirectory(path.dirname(directory)); }
      this.file(parts.slice(0, n).join('/'));
    }
  }

  /** A late foreign regular inode captured by THIS live syscall is put back no-clobber.
   * The captured inode is retained regardless. Startup never guesses this provenance from JSON. */
  private returnLateCapture(directory: string, i: number, e: Entry): void {
    const captured = path.join(directory, `${i}.captured`);
    if (!this.exists(captured) || fs.existsSync(this.file(e.path))) return;
    const stat = fs.lstatSync(captured, { bigint: true });
    if (!stat.isFile() || stat.nlink !== 1n || stat.isSymbolicLink() || stat.size > BigInt(SNAPSHOT_MAX_BYTES)) return;
    if (sameIdentity(stat, e.original!) && this.matches(captured, e.original, e.before, 1, e.originalMtime!)) return;
    const raw = privateRead(captured, SNAPSHOT_MAX_BYTES);
    const image = { hash: sha256(raw), size: raw.length, mode: Number(stat.mode & 0o777n) };
    const stage = path.join(directory, `${i}.foreign-${randomUUID()}`);
    const id = privateWrite(stage, raw, image.mode);
    // Recheck ancestry and vacancy immediately before no-clobber publication.
    fs.linkSync(stage, this.file(e.path));
    syncDirectory(path.dirname(this.file(e.path)));
    this.cleanAlias(stage, e, id, image);
  }

  run(before: RestoreBefore[], after: FrozenFile[], backupId: string, authorize: () => void, preflight: () => void): void {
    authorize();
    prepareAtomicNoReplace(); // before any journal/public effect; compiler failure is fail-closed
    authorize();
    const { directory, intent } = this.prepare(before, after, backupId);
    let started = false;
    let captureAttempt = -1;
    try {
      this.checkpoint('PREPARED', -1);
      preflight(); authorize();
      for (const [i, e] of intent.entries.entries()) {
        authorize();
        const absolute = this.file(e.path);
        if (e.before) {
          this.assertFile(absolute, e.original, e.before, 1, e.originalMtime!);
          const capture = path.join(directory, `${i}.captured`);
          if (this.exists(capture)) throw snapshotFailure('Capture slot already exists.');
          privateDirectory(directory); this.file(e.path); authorize();
          started = true; captureAttempt = i;
          this.captureNoReplace(directory, i, absolute, capture, false); // one OS no-replace move
          syncDirectory(directory); syncDirectory(path.dirname(absolute));
          this.assertFile(capture, e.original, e.before, 1, e.originalMtime!);
          captureAttempt = -1;
        } else if (fs.existsSync(absolute)) throw new AppError(409, 'DISK_CONFLICT', 'A tombstone path appeared before capture.');
        this.checkpoint('CAPTURED', i);
      }
      // Recheck every captured original and every public vacancy, not just the last file.
      for (const [i, e] of intent.entries.entries()) {
        if (e.before) this.assertFile(path.join(directory, `${i}.captured`), e.original, e.before, 1, e.originalMtime!);
        if (fs.existsSync(this.file(e.path))) throw snapshotFailure('Public path appeared after capture.');
      }
      authorize();
      this.checkpoint('BEFORE_PUBLICATION', -1);
      for (const [i, e] of intent.entries.entries()) {
        authorize();
        if (e.after) { started = true; this.parents(e.path, authorize); this.publish(directory, i, e, false); }
        this.checkpoint('PUBLISHED', i);
      }
      for (const [i, e] of intent.entries.entries()) {
        if (e.before) this.assertFile(path.join(directory, `${i}.captured`), e.original, e.before, 1, e.originalMtime!);
        if (e.after) this.assertFile(this.file(e.path), e.forward, e.after);
        else if (fs.existsSync(this.file(e.path))) throw snapshotFailure('Deleted path reappeared.');
      }
      authorize();
      this.marker(directory, intent, 'COMMITTED');
      this.checkpoint('COMMITTED', -1);
    } catch (error) {
      if (captureAttempt >= 0) {
        try { this.returnLateCapture(directory, captureAttempt, intent.entries[captureAttempt]); }
        catch { /* Never conceal the primary error; the actual capture remains retained. */ }
      }
      // A durable commit is NEVER rolled back, even if an observer subsequently throws.
      try {
        if (!this.terminal(directory, intent)) {
          if (!started) this.marker(directory, intent, 'ROLLED_BACK'); // known zero task effects in this live invocation
          else this.rollback(directory, this.load(directory));
        }
      } catch (recoveryError) {
        const failure = snapshotFailure(`Restore requires recovery in ${directory}. Copy material to NEW names before manual resolution; do not delete markers/captures.`);
        failure.cause = recoveryError; throw failure;
      }
      if (started) {
        const failure = new AppError(409, 'RESTORE_INCOMPLETE', `Restore did not return success; material retained in ${directory}.`);
        failure.cause = error; throw failure;
      }
      throw error;
    }
  }

  private rollback(directory: string, intent: Intent): void {
    this.assertNoActiveMove(directory);
    this.checkpoint('ROLLBACK_BEGIN', -1);
    for (let i = intent.entries.length - 1; i >= 0; i--) {
      // Treat the journal as untrusted before each effect, including resumed recovery.
      const loaded = this.header(directory);
      if (JSON.stringify(loaded) !== JSON.stringify(intent)) throw snapshotFailure('Journal intent changed during recovery.');
      const e = loaded.entries[i];
      this.checkImages(directory, i, e);
      const capture = path.join(directory, `${i}.captured`), undo = path.join(directory, `${i}.undone`);
      const captured = this.exists(capture), undone = this.exists(undo);
      let absolute = this.file(e.path);
      if (captured) this.assertFile(capture, e.original, e.before, 1, e.originalMtime!);
      if (undone) this.assertFile(undo, e.forward, e.after, 1);
      if (e.before && !captured) {
        // This entry never crossed its capture boundary. Absence/foreign identity is ambiguous.
        this.assertFile(absolute, e.original, e.before, 1, e.originalMtime!);
        this.checkpoint('ROLLED_BACK_FILE', i); continue;
      }
      if (fs.existsSync(absolute)) {
        // Already restored before a crash; clean up a surviving OWN publication alias.
        if (e.before && this.matches(absolute, e.rollback, e.before, 2)) {
          this.cleanAlias(path.join(directory, `${i}.rollback`), e, e.rollback, e.before);
          this.checkpoint('ROLLED_BACK_FILE', i); continue;
        }
        this.assertFile(absolute, e.forward, e.after, 2);
        this.cleanAlias(path.join(directory, `${i}.forward`), e, e.forward, e.after);
        if (undone) throw snapshotFailure('Both forward public and undo capture exist.');
        absolute = this.file(e.path); this.assertFile(absolute, e.forward, e.after);
        privateDirectory(directory);
        this.captureNoReplace(directory, i, absolute, undo, true);
        syncDirectory(directory); syncDirectory(path.dirname(absolute));
        this.assertFile(undo, e.forward, e.after);
        this.checkpoint('ROLLBACK_CAPTURED', i);
      }
      if (e.before) {
        // Only an original that was actually captured may be restored. No expired forward auth is used.
        this.assertFile(capture, e.original, e.before, 1, e.originalMtime!);
        this.parents(e.path, () => this.store.assertBinding(this.store.binding));
        this.publish(directory, i, e, true);
      }
      this.checkpoint('ROLLED_BACK_FILE', i);
    }
    this.checkpoint('ROLLBACK_BEFORE_DONE', -1);
    const final = this.header(directory);
    if (JSON.stringify(final) !== JSON.stringify(intent)) throw snapshotFailure('Journal intent changed before recovery settled.');
    for (const [i, e] of final.entries.entries()) {
      const captured = this.exists(path.join(directory, `${i}.captured`));
      if (captured) this.assertFile(path.join(directory, `${i}.captured`), e.original, e.before, 1, e.originalMtime!);
      if (e.before) this.assertFile(this.file(e.path), captured ? e.rollback : e.original, e.before, 1, captured ? undefined : e.originalMtime!);
      else if (fs.existsSync(this.file(e.path))) throw snapshotFailure('A rolled-back tombstone path reappeared.');
    }
    this.marker(directory, intent, 'ROLLED_BACK');
    this.checkpoint('ROLLED_BACK', -1);
  }

  recover(): void {
    for (const directory of this.operations()) {
      const intent = this.header(directory);
      if (this.terminal(directory, intent)) continue;
      if (intent.ownerPid !== process.pid) {
        let live = false;
        try { process.kill(intent.ownerPid, 0); live = true; }
        catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ESRCH') live = true; }
        if (live) throw snapshotFailure('Another process may still own this restore; never roll back a live writer.');
      }
      this.rollback(directory, this.load(directory));
    }
  }
}
