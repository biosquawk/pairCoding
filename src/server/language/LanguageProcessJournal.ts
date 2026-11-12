import { constants, closeSync, fstatSync, lstatSync, mkdirSync, openSync, opendirSync, readSync,
  realpathSync, renameSync, unlinkSync, writeFileSync, type BigIntStats } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import { NodeLanguageJournalDurability, type LanguageJournalDurability } from './LanguageJournalDurability';

export const sha256 = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex');
export interface LanguageProcessIntent {
  schemaVersion: 1; launchId: string; installationId: string; engineId: string;
  projectId: string; sessionId: string; profileId: string; providerGeneration: string;
  configurationGeneration: string; shadowGeneration: string; connectionGeneration: string;
  phase: 'completion' | 'diagnostics'; provider: 'jdt' | 'pylsp'; imageId: string;
  name: string; labels: Record<string, string>; argv: string[];
  workspaceDirectory: string; bootDirectory: string; stateDirectory: string;
  createdUTC: string;
}
export interface CollectedFile { path: string; bytes: number; sha256: string }
export interface LanguageProcessCollection {
  files: CollectedFile[]; missing: string[];
  logs: { stdout: string; stderr: string; truncated: boolean };
}
export interface LanguageProcessReceipt {
  schemaVersion: 1; intentSha256: string; containerId: string;
  exitCode: number; stoppedUTC: string; collection: LanguageProcessCollection;
}
/** Synchronous durable operations. No Docker mutation may precede the corresponding readback. */
export interface LanguageProcessJournal {
  assertIsolated(mounts: readonly string[]): void;
  putIntent(intent: LanguageProcessIntent): void;
  readIntent(launchId: string): LanguageProcessIntent;
  markStart(launchId: string, intentSha256: string, containerId: string): void;
  startContainerId(launchId: string, intentSha256: string): string | null;
  hasStart(launchId: string, intentSha256: string): boolean;
  collect(intent: LanguageProcessIntent, logs: LanguageProcessCollection['logs']): LanguageProcessCollection;
  putReceipt(launchId: string, receipt: LanguageProcessReceipt): void;
  readReceipt(launchId: string): LanguageProcessReceipt | null;
  markRemoved(launchId: string, receiptSha256: string): void;
}
export const intentHash = (intent: LanguageProcessIntent): string => sha256(JSON.stringify(intent));
export const receiptHash = (receipt: LanguageProcessReceipt): string => sha256(JSON.stringify(receipt));
export function assertLaunchId(id: string): void {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id)) throw new Error('Invalid server launch ID');
}
/** Trusted unit-IO seam only. Production always uses actual native platform/FD/path primitives. */
export interface LanguageReadIO {
  lstat(path: string): BigIntStats; realpath(path: string): string;
  open(path: string, flags: number): number; stat(fd: number): BigIntStats;
  read(fd: number, buffer: Buffer, offset: number, length: number, position: number | null): number;
  close(fd: number): void;
}
const nativeReadIO: LanguageReadIO = { lstat: p => lstatSync(p, { bigint: true }), realpath: p => realpathSync.native(p),
  open: openSync, stat: fd => fstatSync(fd, { bigint: true }), read: readSync, close: closeSync };
const stamp = (s: BigIntStats): string => [s.dev, s.ino, s.size, s.mtimeNs, s.ctimeNs, s.mode, s.nlink].join(':');
/** Reject EVERY ancestor link/junction and realpath alias, including the filesystem root. */
export function assertRealDirectory(path: string, io: Pick<LanguageReadIO, 'lstat' | 'realpath'> = nativeReadIO): void {
  if (!isAbsolute(path) || resolve(path) !== path) throw new Error('Directory must be absolute/canonical');
  let current = parse(path).root;
  const check = (): void => {
    const stat = io.lstat(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Unsafe directory/link');
    if (io.realpath(current) !== current) throw new Error('Unsafe directory canonical alias');
  };
  check();
  for (const segment of relative(current, path).split(sep).filter(Boolean)) { current = join(current, segment); check(); }
}
/** POSIX boundary of EACH generated private launch/journal subtree. Win32 trusts inherited private-parent ACLs,
 * exactly as SnapshotStorage: mode bits are NOT evidence of an ACL and are never used to claim Windows privacy.
 * The caller must own/control the parent; no ACL reconfiguration or malicious same-user host guarantee. */
export function assertPrivateLanguageDirectory(path: string): void {
  assertRealDirectory(path);
  if (process.platform !== 'win32' && (lstatSync(path, { bigint: true }).mode & 0o077n) !== 0n)
    throw new Error('Language launch directory must be private');
}
export function readRegular(path: string, limit: number, io: LanguageReadIO = nativeReadIO): Buffer {
  if (!Number.isSafeInteger(limit) || limit < 0 || limit > 256 * 1024 * 1024) throw new Error('Invalid bounded file read budget');
  assertRealDirectory(dirname(path), io);
  const before = io.lstat(path);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || before.size > BigInt(limit)) throw new Error('Unsafe/oversize file');
  // Windows may lack O_NOFOLLOW: initial/final lstat plus exact BigInt opened/post-read fstat are mandatory.
  const fd = io.open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = io.stat(fd);
    if (!opened.isFile() || stamp(opened) !== stamp(before)) throw new Error('File changed while opening');
    // before.size is bounded by the checked safe-integer limit. Keep one EOF/growth sentinel.
    const buffer = Buffer.alloc(Number(before.size) + 1); let size = 0, n: number;
    do { n = io.read(fd, buffer, size, buffer.length - size, null); size += n; } while (n && size < buffer.length);
    const after = io.stat(fd), final = io.lstat(path);
    if (size > limit || BigInt(size) !== before.size || !after.isFile() || !final.isFile() || final.isSymbolicLink() ||
      stamp(after) !== stamp(before) || stamp(final) !== stamp(before)) throw new Error('File changed/oversize during read');
    assertRealDirectory(dirname(path), io);
    return buffer.subarray(0, size);
  } finally { io.close(fd); }
}
const absent = (error: unknown): boolean => (error as NodeJS.ErrnoException)?.code === 'ENOENT';
/**
 * Private receipt root is NEVER mounted. Bind-backed boot/state are copied here after verified exit.
 * Regular files require writable-handle fsync. POSIX also requires directory fsync.
 * Win32 follows existing SnapshotStorage atomic-rename/readback policy (no directory-flush power-loss promise).
 */
export class DiskLanguageProcessJournal implements LanguageProcessJournal {
  constructor(readonly root: string, private readonly durability: LanguageJournalDurability = new NodeLanguageJournalDurability(assertRealDirectory)) { assertRealDirectory(root); }
  get durabilityPolicy(): LanguageJournalDurability['policy'] { return this.durability.policy; }
  private directory(id: string): string {
    assertLaunchId(id); const path = join(this.root, id);
    try { mkdirSync(path, { mode: 0o700 }); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e; }
    assertPrivateLanguageDirectory(path); this.durability.directory(this.root); return path;
  }
  private put(id: string, name: string, bytes: Buffer): void {
    const dir = this.directory(id), destination = join(dir, name);
    try {
      if (!readRegular(destination, bytes.length).equals(bytes)) throw new Error('Durable record conflict');
      const before = lstatSync(destination, { bigint: true });
      const existing = openSync(destination, constants.O_RDWR | (constants.O_NOFOLLOW ?? 0));
      try {
        const opened = fstatSync(existing, { bigint: true });
        if (!before.isFile() || before.isSymbolicLink() || opened.nlink !== 1n || stamp(opened) !== stamp(before) || opened.size !== BigInt(bytes.length)) throw new Error('Durable record changed while opening writable flush handle');
        this.durability.file(existing);
        const after = fstatSync(existing, { bigint: true }), final = lstatSync(destination, { bigint: true });
        if (!final.isFile() || final.isSymbolicLink() || stamp(after) !== stamp(before) || stamp(final) !== stamp(before)) throw new Error('Durable record changed during flush');
      } finally { closeSync(existing); }
      this.durability.directory(dir);
      if (!readRegular(destination, bytes.length).equals(bytes)) throw new Error('Durable record changed after flush');
      return;
    } catch (e) { if (!absent(e)) throw e; }
    // Single backend owner/phase admission serializes this journal. No shared multiwriter directory.
    const temporary = join(dir, `.${randomUUID()}.tmp`);
    const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
    let created: BigIntStats;
    try {
      writeFileSync(fd, bytes); this.durability.file(fd); created = fstatSync(fd, { bigint: true });
      const named = lstatSync(temporary, { bigint: true });
      if (!created.isFile() || created.nlink !== 1n || created.size !== BigInt(bytes.length) || stamp(named) !== stamp(created)) throw new Error('Durable output changed while writing');
    }
    catch (error) { try { unlinkSync(temporary); } catch {} throw error; }
    finally { closeSync(fd); }
    try { renameSync(temporary, destination); this.durability.directory(dir); }
    catch (e) { try { unlinkSync(temporary); } catch {} throw e; }
    const final = lstatSync(destination, { bigint: true });
    if (!final.isFile() || final.isSymbolicLink() || final.dev !== created.dev || final.ino !== created.ino ||
      !readRegular(destination, bytes.length).equals(bytes)) throw new Error('Durable identity/readback mismatch');
  }
  private json(id: string, name: string, limit = 256 * 1024): any {
    assertLaunchId(id); assertPrivateLanguageDirectory(join(this.root, id));
    return JSON.parse(readRegular(join(this.root, id, name), limit).toString('utf8'));
  }
  assertIsolated(mounts: readonly string[]): void {
    assertRealDirectory(this.root);
    const contains = (parent: string, child: string): boolean => {
      const rest = relative(parent, child); return rest === '' || (!rest.startsWith(`..${sep}`) && rest !== '..' && !isAbsolute(rest));
    };
    if (mounts.some(path => contains(path, this.root) || contains(this.root, path))) throw new Error('Receipt journal must be isolated from all LSP mounts');
  }
  putIntent(intent: LanguageProcessIntent): void { this.put(intent.launchId, 'intent.json', Buffer.from(JSON.stringify(intent))); }
  readIntent(id: string): LanguageProcessIntent { return this.json(id, 'intent.json'); }
  markStart(id: string, hash: string, containerId: string): void {
    if (!/^[a-f0-9]{64}$/.test(hash) || !/^[a-f0-9]{64}$/.test(containerId)) throw new Error('Invalid start identity');
    this.put(id, 'start.json', Buffer.from(JSON.stringify({ intentSha256: hash, containerId })));
  }
  startContainerId(id: string, hash: string): string | null {
    try {
      const start = this.json(id, 'start.json');
      if (start.intentSha256 !== hash || !/^[a-f0-9]{64}$/.test(start.containerId)) throw new Error('Start intent conflict');
      return start.containerId;
    } catch (e) { if (absent(e)) return null; throw e; }
  }
  hasStart(id: string, hash: string): boolean { return this.startContainerId(id, hash) !== null; }
  collect(intent: LanguageProcessIntent, logs: LanguageProcessCollection['logs']): LanguageProcessCollection {
    const files: CollectedFile[] = [], missing: string[] = [];
    const accounting: BootCollectionEntry[] = [];
    const directories: { path: string; stamp: string; names: string[] }[] = [];
    const sources: { path: string; stamp: string }[] = [];
    let total = 0, entries = 0, policyUsed = false;
    let internalFiles = 0;
    const store = (destination: string, bytes: Buffer): void => {
      if (bytes.length > BOOT_FILE_LIMIT || total + bytes.length > BOOT_TOTAL_LIMIT || files.length + internalFiles >= 258)
        throw new Error('Boot artifact selected budget limit');
      total += bytes.length;
      this.put(intent.launchId, artifactName(destination), bytes);
      files.push({ path: destination, bytes: bytes.length, sha256: sha256(bytes) });
    };
    const read = (path: string): Buffer => {
      const before = lstatSync(path, { bigint: true }), bytes = readRegular(path, BOOT_FILE_LIMIT);
      if (stamp(lstatSync(path, { bigint: true })) !== stamp(before)) throw new Error('Boot artifact changed during collection');
      sources.push({ path, stamp: stamp(before) }); return bytes;
    };
    const walk = (dir: string, prefix: string, depth: number): void => {
      const jdt = intent.provider === 'jdt' && (prefix === 'boot/jdt-config' || prefix.startsWith('boot/jdt-config/'));
      if (jdt) {
        if (!jdtDirectory(prefix.slice(5))) throw new Error('Unknown JDT boot directory');
        policyUsed = true;
      } else if (depth > 4) throw new Error('Boot artifact depth limit');
      assertRealDirectory(dir);
      const before = lstatSync(dir, { bigint: true }), names = boundedNames(dir, 256 - entries);
      directories.push({ path: dir, stamp: stamp(before), names });
      for (const name of names) {
        if (++entries > 256) throw new Error('Boot artifact entry limit');
        const path = join(dir, name), stat = lstatSync(path, { bigint: true }), dest = `${prefix}/${name}`;
        if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())) throw new Error('Unsafe boot artifact');
        if (stat.isDirectory()) { accounting.push({ path: dest, type: 'directory' }); walk(path, dest, depth + 1); }
        else {
          const bytes = read(path);
          if (stamp(lstatSync(path, { bigint: true })) !== stamp(stat)) throw new Error('Boot artifact changed after enumeration');
          const binary = intent.provider === 'jdt' ? jdtBinary(dest.slice(5)) : null;
          if (binary) {
            if (!bytes.subarray(0, 4).equals(binary === 'ZIP' ? Buffer.from([0x50, 0x4b, 3, 4]) : Buffer.from([0x7f, 0x45, 0x4c, 0x46])))
              throw new Error('Malformed JDT binary cache');
            policyUsed = true;
          } else {
            if (!/\.(log|txt|ini|info|properties)$/.test(name)) policyUsed = true;
            store(dest, bytes);
          }
          accounting.push({ path: dest, type: 'file', bytes: bytes.length, sha256: sha256(bytes),
            selection: binary ? 'excluded' : 'selected', reason: binary ? 'JDT_EXTRACTED_BINARY_CACHE' : 'BOOT_EVIDENCE' });
        }
      }
    };
    walk(intent.bootDirectory, 'boot', 0);
    assertRealDirectory(intent.stateDirectory);
    const workspaceLog = join(intent.stateDirectory, '.metadata', '.log');
    if (stateLogAbsent(intent.stateDirectory)) missing.push('state/.metadata/.log');
    else store('state/.metadata/.log', read(workspaceLog));
    store('stdout.log', Buffer.from(logs.stdout)); store('stderr.log', Buffer.from(logs.stderr));
    // Legacy log-only/shallow collections keep their original artifact set. Actual new semantic
    // selection (including an empty special subtree) always carries transparent durable accounting.
    if (policyUsed) {
      const required = Buffer.from(JSON.stringify({ version: BOOT_POLICY_VERSION, intentSha256: intentHash(intent) }));
      // Internal durable discriminator, not a caller/schema flag. Loss of policy plus a removed
      // receipt reference must not turn a new collection into an apparently historical legacy one.
      // Reserve BOTH the internal marker and the receipt-visible policy within the original258.
      if (total + required.length > BOOT_TOTAL_LIMIT || files.length + 2 > 258) throw new Error('Boot artifact selected budget limit');
      total += required.length; internalFiles = 1;
      this.put(intent.launchId, BOOT_POLICY_REQUIRED, required);
      const policy = { requiredRecord: { name: BOOT_POLICY_REQUIRED, bytes: required.length, sha256: sha256(required) }, version: BOOT_POLICY_VERSION, intentSha256: intentHash(intent), launchId: intent.launchId,
        provider: intent.provider, imageId: intent.imageId,
        source: { bootDirectory: intent.bootDirectory, stateLog: workspaceLog },
        completeness: 'COMPLETE_POLICY_SELECTION_NOT_BINARY_CONTENT_ARCHIVE',
        limits: { entries: 256, regularFileBytes: BOOT_FILE_LIMIT, selectedBytes: BOOT_TOTAL_LIMIT, receiptFiles: 258 },
        entries: accounting.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0),
        selected: [...files].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0), missing: [...missing] };
      // No recursive self-hash. store counts actual serialized policy bytes within the SAME budget.
      store(BOOT_POLICY_PATH, Buffer.from(JSON.stringify(policy)));
    }
    // Recheck after ALL immutable output writes/flushes, including excluded files and root names.
    for (const source of sources) {
      assertRealDirectory(dirname(source.path));
      if (stamp(lstatSync(source.path, { bigint: true })) !== source.stamp) throw new Error('Boot source changed after collection');
    }
    for (const dir of directories) {
      assertRealDirectory(dir.path);
      if (stamp(lstatSync(dir.path, { bigint: true })) !== dir.stamp ||
        JSON.stringify(boundedNames(dir.path, 256)) !== JSON.stringify(dir.names)) throw new Error('Boot directory changed after collection');
    }
    if (missing.length && !stateLogAbsent(intent.stateDirectory)) throw new Error('Missing state log appeared during collection');
    return { files, missing, logs };
  }
  putReceipt(id: string, receipt: LanguageProcessReceipt): void { this.put(id, 'receipt.json', Buffer.from(JSON.stringify(receipt))); }
  readReceipt(id: string): LanguageProcessReceipt | null {
    let receipt: LanguageProcessReceipt;
    try { receipt = this.json(id, 'receipt.json', 2 * 1024 * 1024); } catch (e) { if (absent(e)) return null; throw e; }
    if (!receipt || receipt.schemaVersion !== 1 || !Array.isArray(receipt.collection?.files) || receipt.collection.files.length > 258)
      throw new Error('Invalid durable receipt');
    for (const file of receipt.collection.files) {
      if (!file || typeof file.path !== 'string' || !Number.isSafeInteger(file.bytes) || file.bytes < 0 || file.bytes > 1024 * 1024 || !/^[a-f0-9]{64}$/.test(file.sha256))
        throw new Error('Invalid receipt artifact');
      const name = artifactName(file.path);
      const bytes = readRegular(join(this.root, id, name), file.bytes);
      if (bytes.length !== file.bytes || sha256(bytes) !== file.sha256) throw new Error('Receipt artifact readback mismatch');
    }
    const policyRefs = receipt.collection.files.filter(file => file.path === BOOT_POLICY_PATH);
    let policyBytes: Buffer | null = null;
    try { policyBytes = readRegular(join(this.root, id, artifactName(BOOT_POLICY_PATH)), BOOT_FILE_LIMIT); }
    catch (e) { if (!absent(e)) throw e; }
    let required: Buffer | null = null;
    try { required = readRegular(join(this.root, id, BOOT_POLICY_REQUIRED), 1024); } catch (e) { if (!absent(e)) throw e; }
    if (required && (!policyBytes || policyRefs.length !== 1)) throw new Error('Required durable collection policy missing');
    if (policyBytes) {
      if (!required || !required.equals(Buffer.from(JSON.stringify({ version: BOOT_POLICY_VERSION, intentSha256: receipt.intentSha256 }))))
        throw new Error('Collection policy required record mismatch');
      if (policyRefs.length !== 1) throw new Error('Collection policy missing from receipt');
      if (policyBytes.length !== policyRefs[0].bytes || sha256(policyBytes) !== policyRefs[0].sha256) throw new Error('Collection policy changed during readback');
      // Apply combined budgets only to new-policy receipts; historical schema1 guards stay exact.
      if (receipt.collection.files.length + 1 > 258 ||
        receipt.collection.files.reduce((sum, file) => sum + file.bytes, required.length) > BOOT_TOTAL_LIMIT)
        throw new Error('Collection policy combined artifact budget limit');
      const policy = JSON.parse(policyBytes.toString('utf8'));
      if (policy.requiredRecord?.name !== BOOT_POLICY_REQUIRED || policy.requiredRecord.bytes !== required.length ||
        policy.requiredRecord.sha256 !== sha256(required) || policy.version !== BOOT_POLICY_VERSION || policy.intentSha256 !== receipt.intentSha256 || policy.launchId !== id ||
        policy.completeness !== 'COMPLETE_POLICY_SELECTION_NOT_BINARY_CONTENT_ARCHIVE' ||
        JSON.stringify(policy.selected) !== JSON.stringify(receipt.collection.files.filter(f => f.path !== BOOT_POLICY_PATH)
          .sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)) ||
        JSON.stringify(policy.missing) !== JSON.stringify(receipt.collection.missing)) throw new Error('Collection policy receipt mismatch');
    } else if (policyRefs.length) throw new Error('Missing durable collection policy');
    return receipt;
  }
  markRemoved(id: string, hash: string): void { this.put(id, 'removed.json', Buffer.from(JSON.stringify({ receiptSha256: hash }))); }
  /** Startup reads only this installation-owned journal, not daemon-wide ps/prune. */
  listIntents(): LanguageProcessIntent[] {
    return boundedNames(this.root, 1024).filter(name => /^[a-f0-9-]{36}$/.test(name)).map(name => this.readIntent(name));
  }
}
const BOOT_FILE_LIMIT = 1024 * 1024, BOOT_TOTAL_LIMIT = 4 * 1024 * 1024;
const BOOT_POLICY_PATH = 'collection-policy.json', BOOT_POLICY_VERSION = 'JDT_BOOT_EVIDENCE_V1';
const BOOT_POLICY_REQUIRED = 'collection-policy-required.json';
interface BootCollectionEntry {
  path: string; type: 'directory' | 'file'; bytes?: number; sha256?: string;
  selection?: 'selected' | 'excluded'; reason?: 'BOOT_EVIDENCE' | 'JDT_EXTRACTED_BINARY_CACHE';
}
const artifactName = (path: string): string => path === 'stdout.log' || path === 'stderr.log' ? path : `artifact-${sha256(path)}`;
const jdtLauncher = 'jdt-config/org.eclipse.equinox.launcher/org.eclipse.equinox.launcher.gtk.linux.x86_64_1.2.1700.v20260913-1737';
const jdtNumber = '(?:0|[1-9][0-9]{0,8})';
const jdtBundle = `jdt-config/org\\.eclipse\\.osgi/${jdtNumber}/${jdtNumber}`;
function jdtDirectory(path: string): boolean {
  return path === 'jdt-config' || path === jdtLauncher ||
    /^jdt-config\/(org\.eclipse\.osgi|org\.eclipse\.core\.runtime|org\.eclipse\.equinox\.app|org\.eclipse\.equinox\.launcher)$/.test(path) ||
    /^jdt-config\/(org\.eclipse\.osgi|org\.eclipse\.core\.runtime|org\.eclipse\.equinox\.app)\/\.manager$/.test(path) ||
    new RegExp(`^jdt-config/org\\.eclipse\\.osgi/${jdtNumber}$`).test(path) ||
    new RegExp(`^${jdtBundle}(?:/\\.cp(?:/jars)?)?$`).test(path);
}
function jdtBinary(path: string): 'ZIP' | 'ELF' | null {
  if (path === `${jdtLauncher}/eclipse_11925.so`) return 'ELF';
  return new RegExp(`^${jdtBundle}/\\.cp/(?:jars/)?[A-Za-z0-9][A-Za-z0-9_.-]{0,127}\\.jar$`).test(path) ? 'ZIP' : null;
}
// Only the exact optional state log (or absent .metadata) may be missing. A read/flush/race
// ENOENT after this observation is fatal, not reclassified as an optional absence.
function stateLogAbsent(state: string): boolean {
  assertRealDirectory(state); const metadata = join(state, '.metadata');
  try { lstatSync(metadata); } catch (e) { if (absent(e)) return true; throw e; }
  assertRealDirectory(metadata);
  try { lstatSync(join(metadata, '.log')); return false; } catch (e) { if (absent(e)) return true; throw e; }
}
// Never traverse the JDT workspace binary index/dependencies. Boot cache uses the finite schema above.
function boundedNames(path: string, maximum: number): string[] {
  const dir = opendirSync(path), names: string[] = [];
  try { let entry; while ((entry = dir.readSync())) { if (names.length >= maximum) throw new Error('Directory entry limit'); names.push(entry.name); } }
  finally { dir.closeSync(); }
  return names.sort();
}
