import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import type { Snapshot } from '../shared/protocol';
import { drainSteps } from './SnapshotSteps';
import { AppError } from './errors';
import type { ValidatedWorkspaceScope } from './runtime-coordinator/WorkspaceVersions';

export const SNAPSHOT_MAX_BYTES = 1048576;
export const SNAPSHOT_MAX_FILES = 1000;
// Covers 1000 x 1024 UTF-16 path units even with double JSON escaping (including lone
// surrogates), duplicated snapshot paths and entry metadata. Always bound on BOTH sides.
export const SIGNED_MAX_BYTES = 16 * 1024 * 1024;
export const sha256 = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export const missing = (e: unknown) => (e as NodeJS.ErrnoException).code === 'ENOENT';
export const snapshotFailure = (message: string) => new AppError(503, 'RECOVERY_REQUIRED', message);
export type FrozenFile = { path: string; rawBase64: string | null; mode: number | null };
export type FrozenSnapshot = { snapshot: Snapshot; files: FrozenFile[] };
export type Identity = { dev: string; ino: string };
export const identity = (stat: fs.BigIntStats): Identity => ({ dev: String(stat.dev), ino: String(stat.ino) });
export const sameIdentity = (stat: fs.BigIntStats, id: Identity) => !!id && String(stat.dev) === id.dev && String(stat.ino) === id.ino;
export const validIdentity = (id: Identity) => id && /^\d+$/.test(id.dev) && /^\d+$/.test(id.ino);

/** Every private path is absolute, real and link-free. No recursive mkdir through an unchecked parent. */
export function privateDirectory(absolute: string, create = false): string {
  const resolved = path.resolve(absolute);
  let current = path.parse(resolved).root;
  for (const part of resolved.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    if (create) {
      try { fs.mkdirSync(current, { mode: 0o700 }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    }
    const s = fs.lstatSync(current);
    if (!s.isDirectory() || s.isSymbolicLink() || fs.realpathSync.native(current) !== current) {
      throw snapshotFailure('Private snapshot/recovery ancestry changed; preserve its material.');
    }
  }
  return resolved;
}

/** Directory durability is supported on POSIX; Windows does not expose directory fsync via Node. */
export function syncDirectory(directory: string): void {
  privateDirectory(directory);
  let fd: number | undefined;
  try { fd = fs.openSync(directory, fs.constants.O_RDONLY); fs.fsyncSync(fd); }
  catch (error) {
    if (process.platform !== 'win32' || !['EPERM', 'EACCES', 'EINVAL', 'EISDIR', 'EBADF'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
  } finally { if (fd !== undefined) fs.closeSync(fd); }
}

export function privateRead(absolute: string, limit: number, allowedLinks = 1): Buffer {
  privateDirectory(path.dirname(absolute));
  const stat = fs.lstatSync(absolute, { bigint: true });
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink < 1n || stat.nlink > BigInt(allowedLinks) || stat.size > BigInt(limit)) {
    throw snapshotFailure('Unsafe or oversized private recovery file; no bytes were opened.');
  }
  const fd = fs.openSync(absolute, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  const stamp = (s: fs.BigIntStats) => [s.dev, s.ino, s.size, s.mtimeNs, s.ctimeNs, s.mode, s.nlink].join(':');
  try {
    if (stamp(fs.fstatSync(fd, { bigint: true })) !== stamp(stat)) throw snapshotFailure('Private file changed while opening.');
    const bytes = Buffer.alloc(limit + 1);
    let length = 0;
    while (length < bytes.length) {
      const count = fs.readSync(fd, bytes, length, bytes.length - length, null);
      if (!count) break;
      length += count;
    }
    if (length > limit || stamp(fs.fstatSync(fd, { bigint: true })) !== stamp(stat) ||
        stamp(fs.lstatSync(absolute, { bigint: true })) !== stamp(stat)) throw snapshotFailure('Private file changed while reading.');
    return Buffer.from(bytes.subarray(0, length));
  } finally { fs.closeSync(fd); }
}

export function privateWrite(absolute: string, bytes: Buffer, mode = 0o600): Identity {
  privateDirectory(path.dirname(absolute));
  const fd = fs.openSync(absolute, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW ?? 0), mode);
  try { fs.fchmodSync(fd, mode); fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
  return identity(fs.lstatSync(absolute, { bigint: true }));
}

export function snapshotAllowed(relative: string): boolean {
  return !relative.toLowerCase().split('/').some(part =>
    /^(\.git|\.idea|\.vscode|\.gitignore|target)$/.test(part) || /\.(iml|ipr|iws)$/.test(part) ||
    /^(\.env.*|\.aws|\.ssh|\.azure|\.kube|\.npmrc|\.pypirc|\.netrc|\.git-credentials|credentials?(?:[._-].*)?|secrets?(?:[._-].*)?|id_rsa|id_ed25519|.*\.(pem|key|pfx|p12|keystore))$/.test(part) ||
    /(?:^|[._-])credentials?(?:[._-]|$)/.test(part));
}

/** Signed manifests detect corruption/partial tampering; the local identity key is never sent over a transport. */
export class SnapshotStorage {
  readonly projectId: string;
  readonly privateRoot: string;
  readonly binding: { root: string; dev: string; ino: string; projectId: string };
  /** Historical signed binding and current live device/inode are deliberately different. */
  readonly rootIdentity: Identity;
  private key: string;
  private identityPublished = false;
  constructor(readonly root: string, readonly dataDir: string, private readonly safePath: (p: string, missing?: boolean) => string,
      scope?: ValidatedWorkspaceScope | null) {
    this.privateRoot = path.join(root, '.paircoach');
    privateDirectory(root);
    this.rootIdentity = Object.freeze(identity(fs.lstatSync(root, { bigint: true })));
    if (scope && scope.root !== root) throw snapshotFailure('Workspace identity/root scope mismatch.');
    const file = path.join(this.privateRoot, 'workspace-v1.json');
    this.assertNoPartialIdentity();
    let saved: ReturnType<SnapshotStorage['readIdentity']> | undefined;
    try { saved = this.readIdentity(file); } catch (e) { if (!missing(e)) throw e; }
    let historical = this.rootIdentity;
    if (saved) {
      historical = { dev: saved.dev, ino: saved.ino };
    } else if (scope) {
      // Genuine lazy-v1 authority: all candidate stamps are inspected, never a first-stamp
      // guess. Only the old device that exactly re-derives the validated UUID is authority.
      // Exact current root/dev/inode may prove an UNCHANGED lazy empty/tombstoned
      // workspace too. A changed device still needs a historical stamp witness.
      const devices = new Set<string>([this.rootIdentity.dev]);
      for (const f of scope.files) if (f.stamp !== null) {
        const match = /^(\d+):\d+:\d+:\d+:\d+:\d+(?::[a-f0-9]{64}|:hardlink:\d+)?$/.exec(f.stamp);
        if (!match) throw snapshotFailure('Ambiguous lazy workspace identity; retain its authority.');
        devices.add(match[1]);
      }
      const candidates = [...devices].filter(dev => this.derivedId({ dev, ino: this.rootIdentity.ino }) === scope.projectId);
      if (candidates.length !== 1) throw snapshotFailure('Unproven lazy workspace binding; retain its authority.');
      historical = { dev: candidates[0], ino: this.rootIdentity.ino };
    }
    this.projectId = this.derivedId(historical);
    this.binding = Object.freeze({ root, ...historical, projectId: this.projectId });
    if (scope && scope.projectId !== this.projectId) throw snapshotFailure('Workspace identity/project scope mismatch.');
    this.key = saved?.key ?? randomBytes(32).toString('hex');
    this.identityPublished = !!saved;
    if (scope !== undefined) {
      // Durable open only: resolver runs after full versions validation under its lease.
      // Never mint a replacement key over partial identity or dependent signed material.
      if (!saved) this.assertNoSignedMaterial();
      this.ensureIdentity();
    }
  }

  private derivedId(id: Identity): string {
    const digest = sha256(JSON.stringify({ root: this.root, ...id }));
    return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-8${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
  }

  private privateAuthority(file?: string): void {
    privateDirectory(this.privateRoot);
    if (process.platform !== 'win32') {
      for (const p of file ? [this.privateRoot, file] : [this.privateRoot]) {
        const stat = fs.lstatSync(p);
        if ((stat.mode & 0o077) || stat.uid !== process.getuid!()) throw snapshotFailure('Workspace identity authority is not privately owned.');
      }
    } // Windows uses the existing trusted inherited private-parent ACL boundary, not chmod.
  }

  private readIdentity(file: string): { root: string; dev: string; ino: string; projectId: string; key: string } {
    this.privateAuthority(file);
    const raw = privateRead(file, 4096);
    let value: any;
    try { value = JSON.parse(new TextDecoder('utf8', { fatal: true }).decode(raw)); } catch { throw snapshotFailure('Malformed workspace identity.'); }
    if (!value || value.format !== 1 || value.root !== this.root || typeof value.dev !== 'string' || typeof value.ino !== 'string' || !validIdentity(value) || value.ino !== this.rootIdentity.ino ||
        value.projectId !== this.derivedId({dev: value.dev, ino: value.ino}) || !/^[a-f0-9]{64}$/.test(value.key))
      throw snapshotFailure('Workspace identity/root binding is invalid.');
    return value;
  }

  private assertNoPartialIdentity(): void {
    try { this.privateAuthority(); } catch (e) { if (missing(e)) return; throw e; }
    if (fs.readdirSync(this.privateRoot).some(n => n.startsWith('identity-')))
      throw snapshotFailure('Partial workspace identity publication; preserve its material.');
  }

  private assertNoSignedMaterial(): void {
    const exists = (p: string) => { try { fs.lstatSync(p); return true; } catch (e) { if (missing(e)) return false; throw e; } };
    if (exists(this.privateRoot)) {
      this.privateAuthority();
      if (fs.readdirSync(this.privateRoot).some(n => n.startsWith('identity-') || n === 'snapshot-journal-v1'))
        throw snapshotFailure('Missing identity with partial/signed material; preserve it.');
    }
    if (exists(path.join(this.dataDir, 'snapshots-v1'))) throw snapshotFailure('Missing identity for signed snapshot history; preserve it.');
  }

  private ensureIdentity(): void {
    this.assertBinding(this.binding);
    this.assertNoPartialIdentity();
    privateDirectory(this.privateRoot, true);
    this.privateAuthority();
    const file = path.join(this.privateRoot, 'workspace-v1.json');
    let present = true;
    try { fs.lstatSync(file); } catch (e) { if (!missing(e)) throw e; present = false; }
    if (!present) {
      if (this.identityPublished) throw snapshotFailure('Published workspace identity disappeared; preserve recovery material.');
      this.assertNoSignedMaterial();
      const temp = path.join(this.privateRoot, 'identity-' + randomUUID());
      privateWrite(temp, Buffer.from(JSON.stringify({ format: 1, ...this.binding, key: this.key })));
      // Leave partial material on unknown failure. A later open must not silently repair it.
      this.assertBinding(this.binding);
      fs.linkSync(temp, file);
      syncDirectory(this.privateRoot); // Retain the temp/alias if publication durability is unknown.
      // The temporary second link is our own pinned publication, never accepted by normal reads.
      if (!privateRead(file, 4096, 2).equals(Buffer.from(JSON.stringify({ format: 1, ...this.binding, key: this.key }))))
        throw snapshotFailure('Workspace identity publication readback mismatch.');
      this.assertBinding(this.binding);
      fs.unlinkSync(temp);
      syncDirectory(this.privateRoot);
    }
    this.assertBinding(this.binding);
    const saved = this.readIdentity(file);
    if (saved.root !== this.binding.root || saved.dev !== this.binding.dev || saved.ino !== this.binding.ino ||
        saved.projectId !== this.projectId || saved.key !== this.key) throw snapshotFailure('Published workspace identity changed.');
    this.identityPublished = true;
  }

  assertBinding(binding: unknown): void {
    privateDirectory(this.root);
    if (JSON.stringify(binding) !== JSON.stringify(this.binding) || !sameIdentity(fs.lstatSync(this.root, { bigint: true }), this.rootIdentity)) {
      throw snapshotFailure('Recovery material belongs to another root/project.');
    }
  }

  writeSigned(file: string, value: unknown, limit = SIGNED_MAX_BYTES): void {
    this.assertBinding(this.binding);
    const payload = JSON.stringify(value);
    const bytes = Buffer.from(JSON.stringify({ payload, mac: createHmac('sha256', this.key).update(payload).digest('hex') }));
    if (!Number.isSafeInteger(limit) || limit < 0 || limit > SIGNED_MAX_BYTES || bytes.length > limit) {
      throw new AppError(413, 'SNAPSHOT_MANIFEST_TOO_LARGE', 'Signed snapshot/journal exceeds its readable byte budget; no material was published.');
    }
    privateWrite(file, bytes);
    syncDirectory(path.dirname(file));
  }

  readSigned<T>(file: string, limit = SIGNED_MAX_BYTES): T {
    this.assertBinding(this.binding);
    if (!Number.isSafeInteger(limit) || limit < 0 || limit > SIGNED_MAX_BYTES) throw snapshotFailure('Invalid signed read budget.');
    const raw = privateRead(file, limit);
    try {
      const envelope = JSON.parse(raw.toString('utf8'));
      if (!envelope || typeof envelope.payload !== 'string' || typeof envelope.mac !== 'string' ||
          createHmac('sha256', this.key).update(envelope.payload).digest('hex') !== envelope.mac) throw snapshotFailure('Recovery manifest authentication failed.');
      return JSON.parse(envelope.payload) as T;
    } catch (e) {
      if (e instanceof AppError) throw e;
      throw snapshotFailure('Malformed private recovery manifest.');
    }
  }

  paths(paths: string[], allowEmpty = true, inspectDisk = true): void {
    drainSteps(this.pathSteps(paths, allowEmpty, inspectDisk));
  }

  *pathSteps(paths: string[], allowEmpty = true, inspectDisk = true): Generator<void, void, void> {
    if (!Array.isArray(paths) || paths.length > SNAPSHOT_MAX_FILES || (!allowEmpty && !paths.length) ||
        new Set(paths.map(p => typeof p === 'string' ? p.toLowerCase() : p)).size !== paths.length) throw new AppError(400, 'INVALID_SNAPSHOT_PATHS', 'Use unique explicit snapshot paths, at most 1000.');
    for (const p of paths) {
      if (typeof p !== 'string' || !p || p.length > 1024 || /[\\:\x00-\x1f<>"|?*]/.test(p) || p.startsWith('/') ||
          p.split('/').some(c => !c || c === '.' || c === '..' || /[. ]$/.test(c) ||
            /^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(c) ||
            /^(\.git|node_modules|target|__pycache__|\.venv|dist|\.paircoach)$/i.test(c) || c.toLowerCase().startsWith('.paircoach-write-'))) {
        throw snapshotFailure('Invalid relative snapshot path.');
      }
      if (inspectDisk) this.safePath(p, true);
      if (!snapshotAllowed(p)) throw new AppError(403, 'SNAPSHOT_PATH_FORBIDDEN', 'Secrets are excluded from snapshots.');
      yield;
    }
    // A tombstone may not be an ancestor of another entry.
    const ordered = [...paths].sort();
    for (let i = 1; i < ordered.length; i++) if (ordered[i].startsWith(ordered[i - 1] + '/')) throw new AppError(400, 'INVALID_SNAPSHOT_PATHS', 'Snapshot entries cannot contain one another.');
  }

  put(label: string, workspaceVersion: number, files: FrozenFile[], validate: () => void): Snapshot {
    return drainSteps(this.putSteps(label, workspaceVersion, files, function* () { validate(); }));
  }

  *putSteps(label: string, workspaceVersion: number, files: FrozenFile[], validate: () => Generator<void, void, void>): Generator<void, Snapshot, void> {
    if (typeof label !== 'string' || !label.trim() || label.length > 200) throw new AppError(400, 'INVALID_SNAPSHOT_LABEL', 'Snapshot label must have 1..200 characters.');
    yield* this.pathSteps(files.map(f => f.path));
    this.ensureIdentity();
    const base = privateDirectory(path.join(this.dataDir, 'snapshots-v1'), true);
    const storeBinding = path.join(base, 'store-v1.json');
    if (!fs.existsSync(storeBinding)) {
      const temp = path.join(base, '.binding-' + randomUUID());
      this.writeSigned(temp, { format: 1, binding: this.binding }, 8192);
      try { fs.linkSync(temp, storeBinding); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e; }
      finally { fs.unlinkSync(temp); }
      syncDirectory(base);
    }
    this.assertBinding(this.readSigned<{ binding: unknown }>(storeBinding, 8192).binding);
    const id = randomUUID();
    const staging = privateDirectory(path.join(base, '.pending-' + id), true);
    const snapshot: Snapshot = { snapshotId: id, projectId: this.projectId, label, createdAt: new Date().toISOString(), workspaceVersion, paths: files.map(f => f.path) };
    const entries: { path: string; mode: number | null; hash: string | null; size: number }[] = [];
    for (const [i, f] of files.entries()) {
      if (f.rawBase64 === null) { entries.push({ path: f.path, mode: null, hash: null, size: 0 }); yield; continue; }
      const bytes = Buffer.from(f.rawBase64, 'base64');
      if (bytes.length > SNAPSHOT_MAX_BYTES) throw new AppError(413, 'FILE_TOO_LARGE', 'Snapshot file exceeds 1 MiB.');
      privateWrite(path.join(staging, `${i}.bin`), bytes);
      entries.push({ path: f.path, mode: f.mode, hash: sha256(bytes), size: bytes.length });
      yield;
    }
    this.writeSigned(path.join(staging, 'manifest.json'), { format: 1, binding: this.binding, snapshot, entries });
    // Entire capture is checked AFTER every byte has reached the private store.
    yield* validate();
    privateDirectory(base); privateDirectory(staging);
    fs.renameSync(staging, path.join(base, id));
    syncDirectory(base);
    return structuredClone(snapshot);
  }

  read(id: string): FrozenSnapshot { return drainSteps(this.readSteps(id)); }

  *readSteps(id: string): Generator<void, FrozenSnapshot, void> {
    if (typeof id !== 'string' || !uuid.test(id)) throw new AppError(400, 'INVALID_SNAPSHOT_ID', 'Invalid snapshot ID.');
    const directory = path.join(this.dataDir, 'snapshots-v1', id);
    try { privateDirectory(directory); }
    catch (e) { if (missing(e)) throw new AppError(404, 'SNAPSHOT_NOT_FOUND', 'Snapshot does not exist.'); throw e; }
    const value = this.readSigned<{ format: number; binding: unknown; snapshot: Snapshot; entries: { path: string; hash: string | null; mode: number | null; size: number }[] }>(path.join(directory, 'manifest.json'));
    this.assertBinding(value.binding);
    const s = value.snapshot;
    if (value.format !== 1 || !s || s.snapshotId !== id || s.projectId !== this.projectId ||
        typeof s.label !== 'string' || !s.label.trim() || s.label.length > 200 || !Number.isSafeInteger(s.workspaceVersion) || s.workspaceVersion < 0 ||
        typeof s.createdAt !== 'string' || !Number.isFinite(Date.parse(s.createdAt)) || !Array.isArray(value.entries)) throw snapshotFailure('Invalid snapshot manifest.');
    yield* this.pathSteps(s.paths, true, false);
    if (value.entries.length !== s.paths.length) throw snapshotFailure('Snapshot entry count mismatch.');
    const files: FrozenFile[] = [];
    for (const [i, f] of value.entries.entries()) {
      if (f.path !== s.paths[i]) throw snapshotFailure('Snapshot paths mismatch.');
      if (f.hash === null && f.mode === null && f.size === 0) { files.push({ path: f.path, rawBase64: null, mode: null }); yield; continue; }
      if (!/^[a-f0-9]{64}$/.test(f.hash ?? '') || !Number.isInteger(f.mode) || f.mode! < 0 || f.mode! > 0o777 ||
          !Number.isInteger(f.size) || f.size < 0 || f.size > SNAPSHOT_MAX_BYTES) throw snapshotFailure('Invalid snapshot entry.');
      const bytes = privateRead(path.join(directory, `${i}.bin`), SNAPSHOT_MAX_BYTES);
      if (bytes.length !== f.size || sha256(bytes) !== f.hash) throw snapshotFailure('Snapshot bytes do not match their manifest.');
      files.push({ path: f.path, rawBase64: bytes.toString('base64'), mode: f.mode });
      yield;
    }
    return { snapshot: structuredClone(s), files };
  }

  list(): Snapshot[] {
    const base = path.join(this.dataDir, 'snapshots-v1');
    try { privateDirectory(base); } catch (e) { if (missing(e)) return []; throw e; }
    return fs.readdirSync(base).filter(id => uuid.test(id)).map(id => this.read(id).snapshot).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }
}
