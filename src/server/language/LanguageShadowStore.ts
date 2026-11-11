import { isDeepStrictEqual } from 'node:util';
import { constants, closeSync, chmodSync, fchmodSync, fstatSync, lstatSync, mkdirSync, openSync, opendirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import type { DocumentStamp } from '../../shared/language-v2';
import { LANGUAGE_LIMITS } from '../../shared/language-v2';
import { assertPrivateLanguageDirectory, assertRealDirectory, readRegular, sha256 } from './LanguageProcessJournal';
import { NodeLanguageJournalDurability, type LanguageJournalDurability } from './LanguageJournalDurability';

/** Inject these SAME central src/language/uriCodec exports at composition; never supply a second mapper. */
export interface LanguageShadowCodec {
  assertRelativePath(path: string): void;
  toWorkspaceUri(path: string): string;
  normalizeContent(content: string): string;
  contentSha256(content: string): string;
}
export interface ShadowIdentity {
  projectId: string; sessionId: string; profileId: string; configurationGeneration: string;
  providerGeneration: string; shadowGeneration: string; connectionGeneration: string;
  provider: 'jdt' | 'pylsp'; imageId: string;
  toolchainSha256: string; dependencyManifestSha256: string; analysisSettingsSha256: string;
}
export interface ShadowFile { path: string; bytes: number; sha256: string }
/** NOT a wire DTO. Only the backend's serialized project/overlay/prepared-dependency authority may mint this. */
export interface TrustedLanguageSnapshot {
  leaseId: string; identity: ShadowIdentity;
  projectRoot: string;
  /** Complete included inventory, not just the active file. Empty directories are independently scanned too. */
  files: readonly ShadowFile[];
  /** ALL current publishable open models, including inactive tabs and pre-ACK drafts. */
  overlays: readonly { stamp: Readonly<DocumentStamp>; content: string }[];
  /** Prepared immutable artifacts, never an original/private cache. Copied, NOT mounted or written. */
  dependencies: { root: string; files: readonly ShadowFile[] } | null;
}
export interface LanguageSnapshotAuthority {
  capture(): TrustedLanguageSnapshot;
  /** Synchronous trusted lease check: inventory/overlays/scope/epoch/dependency current; NOT receipt presence. */
  isCurrent(snapshot: TrustedLanguageSnapshot): boolean;
}
export interface ShadowManifest {
  schemaVersion: 1; phase: 'completion' | 'diagnostics'; launchId: string; leaseId: string;
  identity: Readonly<ShadowIdentity>;
  sourceInventorySha256: string; dependencyInventorySha256: string;
  files: readonly (ShadowFile & { uri: string; origin: 'disk' | 'overlay' | 'dependency' })[];
  directories: readonly string[];
  overlays: readonly Readonly<DocumentStamp>[];
}
export interface LanguageShadow {
  launchId: string; phase: 'completion' | 'diagnostics';
  workspaceDirectory: string; bootDirectory: string; stateDirectory: string;
  wholeProjectManifestPath: string; inputManifestSha256: string; manifest: Readonly<ShadowManifest>;
}
type Tree = { files: ShadowFile[]; directories: string[]; contents: Map<string, Buffer> };
type RecordState = { shadow: LanguageShadow; poisoned: boolean };
export const LANGUAGE_DEPENDENCY_DIRECTORY = '.paircoach-dependencies';
const DEPENDENCIES = LANGUAGE_DEPENDENCY_DIRECTORY;
const excluded = new Set(['.git', '.paircoach', DEPENDENCIES, 'node_modules', 'target', 'build', 'dist', '__pycache__',
  '.pytest_cache', '.mypy_cache', '.venv', 'venv', '.idea', '.vscode', '.gradle', '.m2', '.npm', '.cache',
  'coverage', 'test-results', 'surefire-reports', 'failsafe-reports']);
const secret = (name: string): boolean => /^\.env/i.test(name) || /^(?:\.aws|\.ssh|\.gnupg|\.azure|\.kube|\.npmrc|\.pypirc|\.netrc|\.git-credentials|id_rsa|id_ed25519)$/i.test(name) ||
  /(?:^|[._-])(?:credentials?|secrets?)(?:[._-]|$)/i.test(name) || /\.(?:pem|key|p12|pfx|class|pyc|jks|keystore)$/i.test(name);
const hashValid = (hash: string): boolean => /^[a-f0-9]{64}$/.test(hash);
const json = (value: unknown): string => JSON.stringify(value);
const copy = <T>(value: T): T => JSON.parse(json(value));
const freeze = <T>(value: T): T => { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };
const contains = (parent: string, child: string): boolean => { const p = relative(parent, child); return p === '' || (!isAbsolute(p) && p !== '..' && !p.startsWith(`..${sep}`)); };
const byPath = (a: ShadowFile, b: ShadowFile): number => a.path < b.path ? -1 : a.path > b.path ? 1 : 0;

/**
 * Real private copies only. Diagnostic handles can never be refreshed; each generation has fresh siblings.
 * Mutable completion refresh may expose intermediate files to its OWN process; never use it for diagnostics.
 * Caller serializes Workspace/overlay transactions and retires on failure. No original writes, no autosave.
 */
export class LanguageShadowStore {
  private records = new Map<string, RecordState>();
  constructor(readonly ownedRoot: string, private readonly codec: LanguageShadowCodec,
    private readonly durability: LanguageJournalDurability = new NodeLanguageJournalDurability(assertRealDirectory)) { assertRealDirectory(ownedRoot); }
  private path(path: string): void {
    this.codec.assertRelativePath(path);
    // Target Windows filesystem policy, NOT an alternate URI mapper. Preserve case/Unicode spelling.
    if (path.length > 1024 || path.split('/').some(p => p.length > 240 || /[<>:"|?*\\\x00-\x1f\x7f]/.test(p) || /[. ]$/.test(p) ||
      /^(?:con|prn|aux|nul|clock\$|conin\$|conout\$|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(p))) throw new Error('Unsafe target filesystem path');
  }
  private included(path: string): boolean { return path.split('/').every(name => !excluded.has(name.toLowerCase()) && !secret(name)); }
  private list(dir: string, budget: number): string[] {
    assertRealDirectory(dir); const names: string[] = [], stream = opendirSync(dir);
    try { let entry; while ((entry = stream.readSync())) { if (names.length >= budget) throw new Error('Language inventory entry limit'); names.push(entry.name); } }
    finally { stream.closeSync(); }
    return names.sort();
  }
  private scan(root: string, dependencies = false, privateCopy = false): Tree {
    assertRealDirectory(root); const rootIdentity = lstatSync(root, { bigint: true });
    const files: ShadowFile[] = [], directories: string[] = [], contents = new Map<string, Buffer>();
    let entries = 0, total = 0; const seen = new Set<string>();
    const walk = (dir: string, prefix: string, depth: number): void => {
      if (depth > 32) throw new Error('Language inventory depth limit');
      for (const name of this.list(dir, 16000 - entries)) {
        if (++entries > 16000) throw new Error('Language inventory entry limit');
        const path = prefix ? `${prefix}/${name}` : name; this.path(path);
        const stat = lstatSync(join(dir, name));
        if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())) throw new Error('Unsafe language inventory link/type');
        const folded = path.normalize('NFC').toLowerCase(); if (seen.has(folded)) throw new Error('Language inventory case/Unicode collision'); seen.add(folded);
        if (!privateCopy && !dependencies && !this.included(path)) continue;
        if (dependencies && secret(name)) throw new Error('Secret/unsafe dependency artifact');
        if (stat.isDirectory()) { directories.push(path); walk(join(dir, name), path, depth + 1); }
        else {
          const bytes = readRegular(join(dir, name), dependencies || privateCopy ? 64 * 1024 * 1024 : 4 * 1024 * 1024);
          total += bytes.length; if (total > (dependencies || privateCopy ? 256 : 64) * 1024 * 1024) throw new Error('Language inventory byte limit');
          files.push({ path, bytes: bytes.length, sha256: sha256(bytes) }); contents.set(path, bytes);
        }
      }
    };
    walk(root, '', 0);
    const after = lstatSync(root, { bigint: true });
    if (!after.isDirectory() || after.isSymbolicLink() || after.ino !== rootIdentity.ino || after.dev !== rootIdentity.dev) throw new Error('Language source root changed');
    return { files: files.sort(byPath), directories: directories.sort(), contents };
  }
  private validateExpected(expected: readonly ShadowFile[], actual: readonly ShadowFile[]): void {
    if (!Array.isArray(expected) || expected.length > 16000) throw new Error('Invalid trusted inventory');
    const sorted = expected.map(file => {
      this.path(file.path); if (!hashValid(file.sha256) || !Number.isSafeInteger(file.bytes) || file.bytes < 0) throw new Error('Invalid trusted file hash/size');
      return { path: file.path, bytes: file.bytes, sha256: file.sha256 };
    }).sort(byPath);
    if (json(sorted) !== json(actual)) throw new Error('Language source inventory/manifest mismatch');
  }
  private current(authority: LanguageSnapshotAuthority, lease: TrustedLanguageSnapshot): void {
    if (authority.isCurrent(lease) !== true) throw new Error('Stale language snapshot/overlay authority');
  }
  private capture(authority: LanguageSnapshotAuthority): { lease: TrustedLanguageSnapshot; snapshot: TrustedLanguageSnapshot; source: Tree; deps: Tree | null } {
    const lease = authority.capture(), snapshot = freeze(copy(lease)); this.current(authority, lease);
    if (!snapshot.leaseId || snapshot.leaseId.length > 200 || !snapshot.identity || !['jdt', 'pylsp'].includes(snapshot.identity.provider) ||
      !/^sha256:[a-f0-9]{64}$/.test(snapshot.identity.imageId)) throw new Error('Invalid trusted shadow identity');
    for (const key of ['projectId', 'sessionId', 'profileId', 'configurationGeneration', 'providerGeneration', 'shadowGeneration', 'connectionGeneration', 'provider', 'imageId', 'toolchainSha256', 'dependencyManifestSha256', 'analysisSettingsSha256']) if (!Object.hasOwn(snapshot.identity, key)) throw new Error('Incomplete trusted shadow identity');
    for (const [key, value] of Object.entries(snapshot.identity)) if (typeof value !== 'string' || !value.length || value.length > 200 || /[\x00-\x1f\x7f]/.test(value) ||
      (key.endsWith('Sha256') && !hashValid(value))) throw new Error('Invalid trusted shadow identity');
    assertRealDirectory(this.ownedRoot);
    const roots = [snapshot.projectRoot, ...(snapshot.dependencies ? [snapshot.dependencies.root] : [])];
    for (const root of roots) { assertRealDirectory(root); if (contains(root, this.ownedRoot) || contains(this.ownedRoot, root)) throw new Error('Language copies must be isolated from sources/dependencies'); }
    if (roots.length === 2 && (contains(roots[0], roots[1]) || contains(roots[1], roots[0]))) throw new Error('Dependencies must be separate prepared immutable artifacts');
    const source = this.scan(snapshot.projectRoot); this.validateExpected(snapshot.files, source.files);
    const deps = snapshot.dependencies ? this.scan(snapshot.dependencies.root, true) : null;
    if (deps) this.validateExpected(snapshot.dependencies!.files, deps.files);
    this.current(authority, lease);
    return { lease, snapshot, source, deps };
  }
  private plan(snapshot: TrustedLanguageSnapshot, source: Tree, deps: Tree | null, launchId: string, phase: LanguageShadow['phase']): { manifest: ShadowManifest; contents: Map<string, Buffer> } {
    const contents = new Map(source.contents), files: ShadowManifest['files'][number][] = source.files.map(f => ({ ...f, uri: this.codec.toWorkspaceUri(f.path), origin: 'disk' }));
    const directories = new Set(source.directories), overlays: DocumentStamp[] = [], seen = new Set<string>();
    if (!Array.isArray(snapshot.overlays) || snapshot.overlays.length > 1000) throw new Error('Overlay count limit');
    for (const overlay of snapshot.overlays) {
      const stamp = overlay.stamp; this.path(stamp.path);
      if (!this.included(stamp.path) || seen.has(stamp.path) || !contents.has(stamp.path)) throw new Error('Overlay not in trusted project inventory/duplicate');
      seen.add(stamp.path);
      for (const key of ['projectId', 'sessionId', 'profileId', 'configurationGeneration', 'providerGeneration', 'shadowGeneration', 'connectionGeneration'] as const)
        if (stamp[key] !== snapshot.identity[key]) throw new Error('Overlay scope mismatch');
      if (!stamp.modelLifetime || !Number.isSafeInteger(stamp.localModelVersion) || stamp.localModelVersion < 1 ||
        !Number.isSafeInteger(stamp.baseDocumentVersion) || stamp.baseDocumentVersion < 0 ||
        (stamp.documentVersion !== null && (!Number.isSafeInteger(stamp.documentVersion) || stamp.documentVersion < stamp.baseDocumentVersion)) ||
        !Number.isSafeInteger(stamp.controlEpoch) || stamp.controlEpoch < 0 || !Number.isSafeInteger(stamp.requestGeneration) || stamp.requestGeneration < 0 ||
        typeof overlay.content !== 'string' || overlay.content.length > LANGUAGE_LIMITS.contentUtf16 || this.codec.contentSha256(overlay.content) !== stamp.contentSha256)
        throw new Error('Invalid overlay stamp/content');
      const bytes = Buffer.from(this.codec.normalizeContent(overlay.content)); contents.set(stamp.path, bytes);
      const entry = files.find(f => f.path === stamp.path)!; entry.bytes = bytes.length; entry.sha256 = sha256(bytes); entry.origin = 'overlay'; overlays.push(copy(stamp));
    }
    if (deps) {
      directories.add(DEPENDENCIES);
      for (const dir of deps.directories) directories.add(`${DEPENDENCIES}/${dir}`);
      for (const file of deps.files) {
        const path = `${DEPENDENCIES}/${file.path}`; this.path(path); contents.set(path, deps.contents.get(file.path)!);
        files.push({ ...file, path, uri: this.codec.toWorkspaceUri(path), origin: 'dependency' });
      }
    }
    return { contents, manifest: { schemaVersion: 1, phase, launchId, leaseId: snapshot.leaseId, identity: copy(snapshot.identity),
      sourceInventorySha256: sha256(json({ files: source.files, directories: source.directories })),
      dependencyInventorySha256: sha256(json(deps ? { files: deps.files, directories: deps.directories } : null)),
      files: files.sort(byPath), directories: [...directories].sort(), overlays: overlays.sort((a,b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0) } };
  }
  private atomicFile(path: string, bytes: Buffer): void {
    assertRealDirectory(dirname(path)); const temporary = join(dirname(path), `.${randomUUID()}.tmp`);
    const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
    let written: import('node:fs').BigIntStats | undefined;
    try {
      try {
        writeFileSync(fd, bytes); fchmodSync(fd, 0o444); this.durability.file(fd);
        written = fstatSync(fd, { bigint: true });
        if (!written.isFile() || written.nlink !== 1n || written.size !== BigInt(bytes.length)) throw new Error('Invalid copy output');
      } finally { closeSync(fd); }
      assertRealDirectory(dirname(path)); renameSync(temporary, path); this.durability.directory(dirname(path));
      const final = lstatSync(path, { bigint: true });
      if (!final.isFile() || final.isSymbolicLink() || final.dev !== written!.dev || final.ino !== written!.ino ||
        !readRegular(path, bytes.length).equals(bytes)) throw new Error('Language copy identity/readback mismatch');
    } catch (error) { try { chmodSync(temporary, 0o600); rmSync(temporary); } catch {} throw error; }
  }
  private writeTree(workspace: string, manifest: ShadowManifest, contents: Map<string, Buffer>): void {
    for (const dir of [...manifest.directories].sort((a,b) => a.split('/').length - b.split('/').length)) {
      const path = join(workspace, ...dir.split('/')); mkdirSync(path, { mode: 0o755, recursive: false }); assertRealDirectory(path);
    }
    for (const file of manifest.files) this.atomicFile(join(workspace, ...file.path.split('/')), contents.get(file.path)!);
  }
  private revalidate(authority: LanguageSnapshotAuthority, captured: ReturnType<LanguageShadowStore['capture']>): void {
    const { lease, snapshot, source, deps } = captured;
    this.current(authority, lease);
    const after = this.scan(snapshot.projectRoot);
    if (json(after.files) !== json(source.files) || json(after.directories) !== json(source.directories)) throw new Error('Language source changed during capture');
    if (snapshot.dependencies && deps) {
      const afterDeps = this.scan(snapshot.dependencies.root, true);
      if (json(afterDeps.files) !== json(deps.files) || json(afterDeps.directories) !== json(deps.directories)) throw new Error('Language dependencies changed during capture');
    }
    this.current(authority, lease);
  }
  private removeUnlaunched(root: string): void {
    // A failed pre-launch copy has no process owner. Windows requires writable files for unlink.
    const clear = (directory: string): void => {
      for (const name of this.list(directory, 16000)) {
        const path = join(directory, name), stat = lstatSync(path);
        if (stat.isDirectory() && !stat.isSymbolicLink()) clear(path);
        else if (stat.isFile() && !stat.isSymbolicLink()) chmodSync(path, 0o644);
      }
    };
    clear(root); rmSync(root, { recursive: true, force: false });
  }
  materialize(phase: LanguageShadow['phase'], authority: LanguageSnapshotAuthority): LanguageShadow {
    if (phase !== 'completion' && phase !== 'diagnostics') throw new Error('Invalid shadow phase');
    const captured = this.capture(authority), launchId = randomUUID(), root = join(this.ownedRoot, launchId);
    const { manifest, contents } = this.plan(captured.snapshot, captured.source, captured.deps, launchId, phase);
    mkdirSync(root, { mode: 0o700 }); assertPrivateLanguageDirectory(root);
    try {
      const workspaceDirectory = join(root, 'workspace'), bootDirectory = join(root, 'boot'), stateDirectory = join(root, 'state');
      mkdirSync(workspaceDirectory, { mode: 0o755 });
      // These are fresh disposable non-root LSP output directories; never a shared index or private journal.
      for (const path of [bootDirectory, stateDirectory]) { mkdirSync(path, { mode: 0o777 }); chmodSync(path, 0o777); }
      this.writeTree(workspaceDirectory, manifest, contents); this.revalidate(authority, captured);
      const wholeProjectManifestPath = join(root, 'manifest.json'), bytes = Buffer.from(json(manifest)); this.atomicFile(wholeProjectManifestPath, bytes);
      const shadow = freeze({ launchId, phase, workspaceDirectory, bootDirectory, stateDirectory, wholeProjectManifestPath,
        inputManifestSha256: sha256(bytes), manifest: freeze(manifest) });
      this.records.set(launchId, { shadow, poisoned: false });
      this.assertIntegrity(shadow); this.current(authority, captured.lease); return shadow;
    } catch (error) { this.records.delete(launchId); this.removeUnlaunched(root); throw error; }
  }
  private record(shadow: LanguageShadow): RecordState {
    const record = this.records.get(shadow.launchId);
    if (!record || record.shadow !== shadow || record.poisoned) throw new Error('Unknown/stale/poisoned language shadow');
    assertPrivateLanguageDirectory(dirname(shadow.workspaceDirectory)); return record;
  }
  /** Read-only ACK handoff check: actual complete disk/cache inventory still yields the EXACT original
   * provider input, except this one acknowledged overlay stamp. No writes/manifest rewrite/new generation.
   * The factory separately binds the before/after full revisions and all unaffected raw source descriptors.
   */
  assertAcknowledgedSnapshot(shadow: LanguageShadow, authority: LanguageSnapshotAuthority,
    previous: Readonly<DocumentStamp>, presentation: Readonly<DocumentStamp>): void {
    this.assertIntegrity(shadow);
    if (previous.path !== presentation.path || !shadow.manifest.overlays.some(s => isDeepStrictEqual(s, previous)))
      throw new Error('ACK not in original private shadow');
    let prior = '';
    for (let i = 0; i < 2; i++) {
      const captured = this.capture(authority), { manifest } = this.plan(captured.snapshot, captured.source, captured.deps, shadow.launchId, shadow.phase);
      const saved = captured.source.contents.get(previous.path);
      if (!saved || this.codec.contentSha256(saved.toString('utf8')) !== presentation.contentSha256)
        throw new Error('ACK disk bytes not the committed model');
      const expected = { ...shadow.manifest, leaseId: captured.snapshot.leaseId,
        sourceInventorySha256: manifest.sourceInventorySha256,
        overlays: shadow.manifest.overlays.map(s => s.path === previous.path ? presentation : s) };
      // Property order of a coordinator's stamps is not authority; compare canonical structural values.
      if (!isDeepStrictEqual(manifest, expected) || i > 0 && prior !== json(manifest)) throw new Error('ACK changed effective whole-project input');
      prior = json(manifest); this.current(authority, captured.lease);
    }
    this.assertIntegrity(shadow);
  }
  assertIntegrity(shadow: LanguageShadow): void {
    const record = this.record(shadow);
    try {
      const bytes = readRegular(shadow.wholeProjectManifestPath, 16 * 1024 * 1024);
      if (sha256(bytes) !== shadow.inputManifestSha256 || bytes.toString('utf8') !== json(shadow.manifest)) throw new Error('Language shadow manifest mismatch');
      const actual = this.scan(shadow.workspaceDirectory, false, true);
      if (json(actual.files) !== json(shadow.manifest.files.map(({ path, bytes, sha256 }) => ({ path, bytes, sha256 }))) ||
        json(actual.directories) !== json(shadow.manifest.directories)) throw new Error('Language shadow contents mismatch');
    } catch (error) { record.poisoned = true; throw error; }
  }
  /** No didChange/save here. Registry sends ordered didChange only AFTER successful replacement. Failure => retire. */
  refreshCompletion(shadow: LanguageShadow, authority: LanguageSnapshotAuthority): LanguageShadow {
    this.record(shadow); if (shadow.phase !== 'completion') throw new Error('Immutable diagnostic shadow cannot change');
    this.assertIntegrity(shadow);
    const captured = this.capture(authority);
    if (Object.keys(shadow.manifest.identity).some(key => captured.snapshot.identity[key as keyof ShadowIdentity] !== shadow.manifest.identity[key as keyof ShadowIdentity])) throw new Error('Language scope/dependency changed; retire process before new shadow');
    const { manifest, contents } = this.plan(captured.snapshot, captured.source, captured.deps, shadow.launchId, 'completion');
    if (manifest.dependencyInventorySha256 !== shadow.manifest.dependencyInventorySha256) throw new Error('Language dependency bytes changed; retire process before new shadow');
    this.revalidate(authority, captured);
    const record = this.record(shadow); record.poisoned = true;
    // Keep the bind-mounted root inode stable. Intermediate mutable completion state is never diagnostic evidence.
    try {
      for (const file of shadow.manifest.files) chmodSync(join(shadow.workspaceDirectory, ...file.path.split('/')), 0o644);
      for (const name of this.list(shadow.workspaceDirectory, 16000)) rmSync(join(shadow.workspaceDirectory, name), { recursive: true, force: false });
      this.writeTree(shadow.workspaceDirectory, manifest, contents); this.revalidate(authority, captured);
      chmodSync(shadow.wholeProjectManifestPath, 0o644);
      this.atomicFile(shadow.wholeProjectManifestPath, Buffer.from(json(manifest)));
      const next = freeze({ ...shadow, manifest: freeze(manifest), inputManifestSha256: sha256(json(manifest)) });
      record.shadow = next; record.poisoned = false; this.assertIntegrity(next); this.current(authority, captured.lease); return next;
    } catch (error) { record.poisoned = true; throw error; }
  }
}
