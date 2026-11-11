import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { Document, FileEntry, Project, Settings, Snapshot } from '../shared/protocol';
import type { MutationAuth } from './WriteGate';
import { drainSteps, drainStepsAsync } from './SnapshotSteps';
import { AppError } from './errors';
import { SnapshotStorage, type FrozenSnapshot, snapshotAllowed, identity, snapshotFailure } from './SnapshotStorage';
import { SnapshotJournal, type RestoreBefore } from './SnapshotJournal';
import { LanguageFeatureRegistry } from './LanguageFeatureRegistry';
import { SerialQueue } from './runtime-coordinator/storage';
import type { InputFile } from './execution/ports';
import { DurableWorkspaceVersions } from './runtime-coordinator/WorkspaceVersions';
import type { SettingsSaveReceipt } from './settings-v2';

const activeRoots = new Set<string>(); // guard shared by all instances, held across async operations
const activeAsyncRoots = new Set<string>();
const queuedRoots = new Map<string, number>(); // sync admission fence, including before the first queue microtask
const openWorkspaces = new Map<string, Set<WorkspaceService>>();
const MAX_BYTES = 1048576;
const MAX_FILES = 1000;
const EXCLUDED = new Set(['.git', 'node_modules', 'target', '__pycache__', '.venv', 'dist', '.paircoach']);
const TEMP_PREFIX = '.paircoach-write-';
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const lf = (value: string) => value.replace(/\r\n?/g, '\n');
const textSignature = (value: string) => hash(value.replace(/\s/g, ''));
const isMissing = (error: unknown) => ['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '');

type DiskFile = { stamp: string; raw: Buffer | null; document: Document | null; error: AppError | null };
type Tracked = DiskFile & { version: number; signature: string };
export type ExternalSync = { operation: 'CREATED' | 'UPDATED' | 'DELETED'; path: string;
  version: number; workspaceVersion: number; document: Document | null };

export class WorkspaceService extends EventEmitter {
  readonly rootPath: string;
  readonly dataDir: string;
  readonly projectId: string;
  workspaceVersion = 0;
  settings: Settings;
  private readonly snapshotStore: SnapshotStorage;
  private readonly snapshotJournal: SnapshotJournal;
  private mutationBusy = false;
  private readonly mutationQueue = new SerialQueue();
  private recoveryRequired = false;
  private records = new Map<string, Tracked>();
  private versions = new Map<string, number>();
  private directories: string[] = [];
  private watchers = new Map<string, fs.FSWatcher>();
  private poll: ReturnType<typeof setInterval> | null = null;
  private scanTimer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;
  private backgroundScan: { steps: Generator<void, void, void>; immediate: ReturnType<typeof setImmediate> | null } | null = null;

  private versionStore: DurableWorkspaceVersions | null = null;
  private versionFailure = false;
  private startupSnapshotRecovery = false;
  private observationDeferred = false;
  constructor(rootPath: string, dataDir?: string, options: { durableVersions?: true; recoverSnapshotsBeforeVersions?: true; deferObservation?: true } = {}) {
    super();
    this.observationDeferred = options.deferObservation === true;
    if (typeof rootPath !== 'string' || !rootPath || rootPath.includes('\0')) {
      throw new AppError(400, 'INVALID_ROOT', 'Choose an existing workspace directory.');
    }
    try {
      const root = path.resolve(rootPath);
      if (fs.lstatSync(root).isSymbolicLink() || !fs.statSync(root).isDirectory()) {
        throw new AppError(403, 'UNSAFE_ROOT', 'Workspace must be a real directory, not a link.');
      }
      this.rootPath = fs.realpathSync.native(root);
      fs.accessSync(this.rootPath, fs.constants.R_OK | fs.constants.W_OK);
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError(400, 'ROOT_UNAVAILABLE', 'Workspace directory does not exist or is not accessible.');
    }
    if (activeRoots.has(this.rootPath)) throw new AppError(409, 'WORKSPACE_BUSY', 'An operation owns this workspace root.');
    const existing = openWorkspaces.get(this.rootPath);
    if (existing?.size && (options.durableVersions === true || [...existing].some(w => w.versionStore)))
      throw new AppError(409, 'WORKSPACE_BUSY', 'Durable V2 workspace requires one authoritative owner.');
    this.dataDir = path.resolve(dataDir ?? path.join(this.rootPath, '.paircoach'));
    if (this.dataDir === this.rootPath) throw new AppError(400, 'INVALID_DATA_DIR', 'Data directory must not be the workspace root.');
    this.snapshotStore = new SnapshotStorage(this.rootPath, this.dataDir, (p, missing) => this._safePath(p, missing));
    this.projectId = this.snapshotStore.projectId;
    this.snapshotJournal = new SnapshotJournal(this.snapshotStore, (p, missing) => this._safePath(p, missing),
      (phase, index) => this.emit('snapshotCheckpoint', { phase, index }));
    try { this.recoveryRequired = this.snapshotJournal.hasPending(); }
    catch { this.recoveryRequired = true; } // Gate validates/reports the exact cause before any mutation.
    this.settings = { taskFilePath: 'challenge.md', taskMode: 'IMPLEMENTATION', reviewNotesPath: 'review.md',
      runProfiles: [], aiConsent: false, contextPatterns: ['**/*.java', '**/*.py', '**/*.js', '**/*.ts', '**/*.md'] };
    if (options.recoverSnapshotsBeforeVersions && !options.durableVersions)
      throw new AppError(400, 'DURABLE_VERSIONS_REQUIRED', 'Ordered V2 startup requires durable workspace ownership.');
    if (!this.recoveryRequired && !options.recoverSnapshotsBeforeVersions) this.scan(true);
    if (options.durableVersions === true) {
      if (this.recoveryRequired && !options.recoverSnapshotsBeforeVersions) throw snapshotFailure('Recover snapshots before enabling durable V2 versions.');
      this.safeDataDirectory();
      this.versionStore = new DurableWorkspaceVersions(path.join(this.dataDir, 'workspace-v2'), this.projectId, this.rootPath,
        this.versionSnapshot(), options.recoverSnapshotsBeforeVersions ? { deferDiskReconcile: true } : {});
      try {
        if (options.recoverSnapshotsBeforeVersions) {
          // Own the durable root BEFORE snapshot recovery can affect public paths. No watcher,
          // session, source scan or settings route may observe a partial recovered tree.
          this.startupSnapshotRecovery = true;
          try { this._recoverSnapshots(); } finally { this.startupSnapshotRecovery = false; }
          this.scan(true);
          this.versionStore.reconcileDisk(this.versionSnapshot());
        }
        const recovered = this.versionStore.snapshot();
        this.workspaceVersion = recovered.workspaceVersion;
        this.versions = new Map(recovered.files.map(f => [f.path, f.version]));
        for (const file of recovered.files) {
          const current = this.records.get(file.path);
          if (current) this.records.set(file.path, this.track(file.path, current, file.version));
        }
      } catch (error) { this.versionStore.close(); throw error; }
    }
    if (!options.deferObservation) this._startObservation();
    if (!openWorkspaces.has(this.rootPath)) openWorkspaces.set(this.rootPath, new Set());
    openWorkspaces.get(this.rootPath)!.add(this);
  }

  /** @internal V2 composition calls this ONLY after settings recovery, before publishing its core. */
  _startObservation(): void {
    if (this.closed) throw new AppError(503, 'WORKSPACE_CLOSED', 'Workspace is closed.');
    if (this.poll) return;
    this.observationDeferred = false;
    this.refreshWatchers();
    this.poll = setInterval(() => this.watchScan(), 500);
    this.poll.unref();
  }

  /** All API paths are relative POSIX; use this before *every* filesystem effect. */
  _safePath(relative: string, allowMissing = false): string {
    if (this.closed) throw new AppError(503, 'WORKSPACE_CLOSED', 'Workspace is closed.');
    if (typeof relative !== 'string' || !relative || relative.length > 1024 ||
        /[\\:\x00-\x1f<>"|?*]/.test(relative) || relative.startsWith('/')) {
      throw new AppError(403, 'UNSAFE_PATH', 'A safe relative POSIX path is required.');
    }
    const parts = relative.split('/');
    let current = this.rootPath;
    // Detect replacement of root itself after opening the workspace.
    if (fs.lstatSync(current).isSymbolicLink() || fs.realpathSync.native(current) !== current) {
      throw new AppError(403, 'UNSAFE_PATH', 'Workspace root changed.');
    }
    let missing = false;
    for (const [index, component] of parts.entries()) {
      const lower = component.toLowerCase();
      if (!component || component === '.' || component === '..' || /[. ]$/.test(component) ||
          /^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(component) ||
          EXCLUDED.has(lower) || lower.startsWith(TEMP_PREFIX)) {
        throw new AppError(403, 'UNSAFE_PATH', 'Path is excluded, ambiguous, or a Windows device name.');
      }
      if (!missing) {
        // Windows aliases must not produce independent version records, even in Linux tests.
        const alias = fs.readdirSync(current).find(name => name.toLowerCase() === lower);
        if (alias !== undefined && alias !== component) {
          throw new AppError(403, 'PATH_CASE_CONFLICT', 'Use the exact path casing listed by the workspace.');
        }
      }
      current = path.join(current, component);
      if (current === this.dataDir || current.startsWith(this.dataDir + path.sep)) {
        throw new AppError(403, 'UNSAFE_PATH', 'Session data is not part of the editable workspace.');
      }
      if (missing) continue;
      try {
        const stat = fs.lstatSync(current);
        if (stat.isSymbolicLink()) throw new AppError(403, 'UNSAFE_PATH', 'Symlinks and junctions are not traversed.');
        if (index < parts.length - 1 && !stat.isDirectory()) throw new AppError(403, 'UNSAFE_PATH', 'Parent is not a directory.');
        const real = fs.realpathSync.native(current);
        if (real !== current || !(real.startsWith(this.rootPath + path.sep))) {
          throw new AppError(403, 'UNSAFE_PATH', 'Path escapes or aliases the workspace.');
        }
      } catch (error) {
        if (!isMissing(error)) throw error;
        if (!allowMissing) throw new AppError(404, 'FILE_NOT_FOUND', 'Path does not exist.');
        missing = true;
      }
    }
    return current;
  }

  private disk(relative: string): DiskFile | null {
    let absolute: string;
    try { absolute = this._safePath(relative, true); } catch (error) { throw error; }
    let stat: fs.BigIntStats;
    try { stat = fs.lstatSync(absolute, { bigint: true }); }
    catch (error) { if (isMissing(error)) return null; throw error; }
    if (!stat.isFile()) throw new AppError(403, 'NOT_A_FILE', 'Only regular text files can be opened.');
    const metadata = (s: fs.BigIntStats) => [s.dev, s.ino, s.size, s.mtimeNs, s.ctimeNs, s.mode].join(':');
    const stamp = metadata(stat);
    // An inaccessible file is still a real tree entry. Never open hardlinks,
    // including an own publication alias left by failed cleanup. This also
    // reconciles safely after restart without trusting/replaying a journal path.
    if (stat.nlink > 1n) return { stamp: stamp + ':hardlink:' + stat.nlink,
      raw: null, document: null, error: new AppError(403, 'UNSAFE_PATH',
        'Hard-linked file is unavailable; no bytes were opened. For an incomplete rename consult .paircoach/rename-recovery before removing any private alias.') };
    if (stat.size > BigInt(MAX_BYTES)) return { stamp, raw: null, document: null,
      error: new AppError(413, 'FILE_TOO_LARGE', 'File exceeds 1 MiB UTF-8; it was not truncated or rewritten.') };
    const fd = fs.openSync(absolute, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    let raw: Buffer;
    try {
      if (metadata(fs.fstatSync(fd, { bigint: true })) !== stamp) throw new AppError(409, 'DISK_CONFLICT', 'File changed while opening.');
      // Bounded read, including detection of growth after stat.
      const buffer = Buffer.alloc(MAX_BYTES + 1);
      let read = 0;
      while (read < buffer.length) {
        const n = fs.readSync(fd, buffer, read, buffer.length - read, null);
        if (!n) break;
        read += n;
      }
      raw = Buffer.from(buffer.subarray(0, read));
      if (metadata(fs.fstatSync(fd, { bigint: true })) !== stamp ||
          metadata(fs.lstatSync(absolute, { bigint: true })) !== stamp) {
        throw new AppError(409, 'DISK_CONFLICT', 'File changed while reading; reload and preserve your draft.');
      }
    } finally { fs.closeSync(fd); }
    if (raw.length > MAX_BYTES) throw new AppError(413, 'FILE_TOO_LARGE', 'File exceeds 1 MiB UTF-8.');
    const fingerprint = stamp + ':' + hash(raw);
    const utf8Bom = raw.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]));
    let content: string;
    try {
      content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(utf8Bom ? raw.subarray(3) : raw);
      if (/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(content)) throw new Error('binary');
    } catch {
      return { stamp: fingerprint, raw, document: null,
        error: new AppError(400, 'UNSUPPORTED_ENCODING', 'Only UTF-8 text is supported; original bytes remain untouched.') };
    }
    const eol = content.includes('\r\n') ? 'CRLF' : 'LF';
    content = lf(content);
    let readOnly = false;
    try { fs.accessSync(absolute, fs.constants.W_OK); } catch { readOnly = true; }
    return { stamp: fingerprint, raw, error: null, document: { path: relative, version: 1, content,
      contentHash: hash(content), languageId: this.language(relative), eol, utf8Bom, readOnly } };
  }

  private language(relative: string): Document['languageId'] {
    const extensions: Record<string, Document['languageId']> = { '.java': 'java', '.py': 'python', '.js': 'javascript',
      '.jsx': 'javascript', '.ts': 'typescript', '.tsx': 'typescript', '.md': 'markdown' };
    return extensions[path.extname(relative).toLowerCase()] ?? 'plaintext';
  }

  private nextVersion(relative: string): number {
    const version = (this.versions.get(relative) ?? 0) + 1;
    if (!Number.isSafeInteger(version)) throw new AppError(503, 'VERSION_EXHAUSTED', 'Document version cannot be incremented safely.');
    this.versions.set(relative, version);
    return version;
  }

  private track(relative: string, disk: DiskFile, version: number): Tracked {
    return { ...disk, version, signature: disk.document ? textSignature(disk.document.content) : '',
      document: disk.document ? { ...disk.document, version } : null };
  }

  private external(relative: string, disk: DiskFile | null, initial = false): void {
    const old = this.records.get(relative);
    if (old?.stamp === disk?.stamp || (!old && !disk)) return;
    const version = this.nextVersion(relative);
    if (disk) this.records.set(relative, this.track(relative, disk, version));
    else this.records.delete(relative);
    if (initial) return;
    this.workspaceVersion++; this.persistVersions();
    const document = this.records.get(relative)?.document ?? null;
    const payload: ExternalSync = { operation: !disk ? 'DELETED' : old ? 'UPDATED' : 'CREATED',
      path: relative, version, workspaceVersion: this.workspaceVersion, document: document ? { ...document } : null };
    this.emit('external', payload);
    this.emit('changed', { path: relative, workspaceVersion: this.workspaceVersion, actor: 'EXTERNAL' });
  }

  private collect(): { files: string[]; dirs: string[] } { return drainSteps(this.collectSteps()); }

  private *collectSteps(): Generator<void, { files: string[]; dirs: string[] }, void> {
    const files: string[] = [], dirs: string[] = [];
    const self = this;
    function* walk(relative: string): Generator<void, void, void> {
      const directory = relative ? self._safePath(relative) : self.rootPath;
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const candidate = relative ? `${relative}/${entry.name}` : entry.name;
        try { self._safePath(candidate); }
        catch (error) { if (error instanceof AppError && error.status === 403) continue; throw error; }
        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) { dirs.push(candidate); yield* walk(candidate); }
        else if (entry.isFile()) {
          files.push(candidate);
          if (files.length > MAX_FILES) throw new AppError(413, 'TOO_MANY_FILES', 'Workspace exceeds 1000 visible files.');
        }
        yield;
      }
    }
    yield* walk('');
    return { files, dirs };
  }

  private scan(initial = false): void { drainSteps(this.scanSteps(initial)); }

  private *scanSteps(initial = false): Generator<void, void, void> {
    const { files, dirs } = yield* this.collectSteps();
    // Gather first, so a failed scan cannot publish a partially missing tree.
    const found = new Map<string, DiskFile>();
    for (const file of files) { const disk = this.disk(file); if (disk) found.set(file, disk); yield; }
    this.directories = dirs;
    for (const [file, disk] of found) this.external(file, disk, initial);
    for (const file of [...this.records.keys()]) if (!found.has(file)) this.external(file, null, initial);
  }

  scanExternal(): void {
    this.assertReadable();
    this.scanInternal();
  }

  private scanInternal(): void {
    this.cancelRootBackgroundScans();
    if (this.recoveryRequired) throw snapshotFailure('Workspace has pending snapshot recovery; construct WriteGate before publishing state.');
    this.scan(); this.refreshWatchers();
  }

  /** Background observation is incremental, NOT an async drain of scanSteps' frozen results.
   * Read + publish each path in one turn; never infer deletion from an old collected tree.
   * Structural mutations/full scans cancel the traversal across instances of the same root.
   * No root/mutation lock is held across yields, so autosave remains available. */
  private *backgroundScanSteps(): Generator<void, void, void> {
    const previousDirectories = this.directories;
    const { files, dirs } = yield* this.collectSteps();
    for (const file of new Set([...files, ...this.records.keys()])) {
      this.external(file, this.backgroundDisk(file));
      yield;
    }
    // A normal WRITE may refresh directories without changing structure. Keep that
    // newer list, but do not restart the scan on every autosave (tail starvation).
    if (this.directories === previousDirectories) this.directories = dirs;
    this.refreshWatchers();
  }

  /** A tracked file can disappear through a safe external change of entry type.
   * Only fresh, validated topology proves absence; an unsafe path is NOT a deletion.
   * Keep this observation-only exception out of disk(), API reads and mutations. */
  private backgroundDisk(relative: string): DiskFile | null {
    try { return this.disk(relative); }
    catch (error) {
      if (!(error instanceof AppError)) throw error;
      if (error.code === 'NOT_A_FILE') {
        if (fs.lstatSync(this._safePath(relative)).isDirectory()) return null;
      } else if (error.code === 'UNSAFE_PATH') {
        const parts = relative.split('/');
        for (let n = 1; n < parts.length; n++) {
          const stat = fs.lstatSync(this._safePath(parts.slice(0, n).join('/')), { bigint: true });
          // _safePath rechecks root, casing and every ancestor/link before lstat.
          // Never reinterpret a hardlink (or another non-directory type) as absence.
          if (stat.isFile() && stat.nlink === 1n) return null;
          if (!stat.isDirectory()) break;
        }
      }
      throw error;
    }
  }

  private cancelRootBackgroundScans(): void {
    this.cancelBackgroundScan(); // also safe before constructor registration
    for (const workspace of openWorkspaces.get(this.rootPath) ?? []) workspace.cancelBackgroundScan();
  }

  private cancelBackgroundScan(): void {
    if (this.backgroundScan?.immediate) clearImmediate(this.backgroundScan.immediate);
    // No descriptor/lock spans a yield. Do not call generator.return(): a synchronous
    // external listener may cancel while next() itself is still executing.
    this.backgroundScan = null;
  }

  private watchScan(): void {
    if (this.closed || activeRoots.has(this.rootPath) || this.recoveryRequired || this.backgroundScan) return;
    const scan = { steps: this.backgroundScanSteps(), immediate: null as ReturnType<typeof setImmediate> | null };
    this.backgroundScan = scan;
    const advance = () => {
      if (this.backgroundScan !== scan) return;
      if (this.closed || activeRoots.has(this.rootPath) || this.recoveryRequired) { this.cancelBackgroundScan(); return; }
      try {
        if (scan.steps.next().done) { this.cancelBackgroundScan(); return; }
      } catch (error) {
        this.cancelBackgroundScan();
        this.emit('watcherError', error instanceof AppError ? error : new AppError(503, 'WATCHER_FAILED', 'Reload workspace; watcher could not scan safely.'));
        return;
      }
      if (this.backgroundScan === scan) scan.immediate = setImmediate(advance);
    };
    scan.immediate = setImmediate(advance);
  }

  private refreshWatchers(): void {
    if (this.observationDeferred) return;
    const required = new Set(['', ...this.directories]);
    for (const [dir, watcher] of this.watchers) if (!required.has(dir)) { watcher.close(); this.watchers.delete(dir); }
    for (const relative of required) {
      if (this.watchers.has(relative)) continue;
      const absolute = relative ? this._safePath(relative) : this.rootPath;
      try {
        const watcher = fs.watch(absolute, { persistent: false }, (_event, name) => {
          if (name?.toString().toLowerCase().startsWith(TEMP_PREFIX)) return;
          if (!this.scanTimer) {
            this.scanTimer = setTimeout(() => { this.scanTimer = null; this.watchScan(); }, 20);
            this.scanTimer.unref();
          }
        });
        watcher.on('error', () => { watcher.close(); this.watchers.delete(relative); });
        this.watchers.set(relative, watcher);
      } catch { /* Explicit polling remains active when native watches are unavailable. */ }
    }
  }

  getDocument(relative: string): Document {
    this.assertReadable();
    this.external(relative, this.disk(relative));
    const tracked = this.records.get(relative);
    if (!tracked) throw new AppError(404, 'FILE_NOT_FOUND', 'File does not exist.');
    if (tracked.error) throw tracked.error;
    return { ...tracked.document! };
  }

  listFiles(): FileEntry[] {
    this.assertReadable();
    return [...this.directories.map(p => ({ path: p, kind: 'DIRECTORY' as const, version: null })),
      ...[...this.records].map(([p, record]) => ({ path: p, kind: 'FILE' as const, version: record.version }))]
      .sort((a, b) => a.path.localeCompare(b.path));
  }

  getProject(sessionId: string): Project {
    return { projectId: this.projectId, sessionId, rootPath: this.rootPath, workspaceVersion: this.workspaceVersion,
      settings: structuredClone(this.settings), files: this.listFiles(), capabilities: new LanguageFeatureRegistry().getCapabilities(this.settings.runProfiles) };
  }

  updateSettings(settings: Settings): void {
    if (this.versionStore) throw new AppError(409, 'V2_SETTINGS_REQUIRED', 'Use explicit V2 settings persistence, never legacy executable settings.');
    if (this.mutationBusy || activeRoots.has(this.rootPath) || queuedRoots.has(this.rootPath)) throw new AppError(409, 'WORKSPACE_BUSY', 'Another workspace operation is in progress.');
    this._assertWritable();
    if (!settings || !['IMPLEMENTATION', 'CODE_REVIEW'].includes(settings.taskMode) || typeof settings.aiConsent !== 'boolean' ||
        !Array.isArray(settings.runProfiles) || settings.runProfiles.length > 2 || !Array.isArray(settings.contextPatterns) ||
        settings.contextPatterns.length > 100 || settings.contextPatterns.some(p => typeof p !== 'string' || !p || p.length > 1024)) {
      throw new AppError(400, 'INVALID_SETTINGS', 'Invalid project settings.');
    }
    if (settings.taskFilePath !== null) this._safePath(settings.taskFilePath, true);
    this._safePath(settings.reviewNotesPath, true);
    const kinds = new Set<string>();
    for (const profile of settings.runProfiles) {
      if (!profile || !['RUN_MAIN', 'RUN_TESTS'].includes(profile.kind) || kinds.has(profile.kind) ||
          typeof profile.executable !== 'string' || !profile.executable || profile.executable.length > 1024 || /[\0\r\n]/.test(profile.executable) ||
          !Array.isArray(profile.args) || profile.args.length > 100 || profile.args.some(a => typeof a !== 'string' || a.length > 4096 || a.includes('\0')) ||
          typeof profile.cwd !== 'string' || !profile.cwd || profile.cwd.length > 1024 || profile.cwd.includes('\0') ||
          !Number.isInteger(profile.timeoutMs) || profile.timeoutMs < 1000 || profile.timeoutMs > 300000 ||
          !['NONE', 'JUNIT_XML'].includes(profile.testReportFormat) ||
          !(profile.testReportGlob === null || (typeof profile.testReportGlob === 'string' && profile.testReportGlob.length > 0 && profile.testReportGlob.length <= 1024))) {
        throw new AppError(400, 'INVALID_SETTINGS', 'Invalid or duplicate approved run profile.');
      }
      kinds.add(profile.kind);
    }
    this.settings = structuredClone(settings);
    this.workspaceVersion++; this.persistVersions();
    this.emit('changed', { path: null, workspaceVersion: this.workspaceVersion, actor: 'SETTINGS' });
  }

  /** @internal Only WriteGate uses these mutation primitives. Single-file effects stay synchronous. */
  _baseline(): Map<string, string> { return new Map([...this.records].map(([p, r]) => [p, r.signature])); }
  _signature(content: string): string { return textSignature(lf(content)); }
  _fresh(relative: string, baseVersion: number): Tracked {
    if (!Number.isSafeInteger(baseVersion) || baseVersion < 1) throw new AppError(400, 'INVALID_VERSION', 'baseVersion must be a positive integer.');
    const before = this.records.get(relative);
    const disk = this.disk(relative);
    if (!before || !disk || disk.stamp !== before.stamp) {
      this.external(relative, disk);
      throw new AppError(409, 'DISK_CONFLICT', 'Disk changed; preserve draft and reload.', this.versions.get(relative) ?? null);
    }
    if (before.version !== baseVersion) throw new AppError(409, 'VERSION_CONFLICT', 'Document version is stale.', before.version);
    if (before.error) throw before.error;
    if (before.document!.readOnly) throw new AppError(403, 'READ_ONLY', 'File is read-only.');
    return before;
  }

  private encoded(content: string, original?: Document): Buffer {
    if (typeof content !== 'string') throw new AppError(400, 'INVALID_CONTENT', 'Content must be text.');
    const normalized = lf(content);
    if (/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(normalized) || new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(normalized)) !== normalized) {
      throw new AppError(400, 'INVALID_CONTENT', 'Content must be valid UTF-8 text without binary controls.');
    }
    const bytes = Buffer.from((original?.utf8Bom ? '\ufeff' : '') +
      (original?.eol === 'CRLF' ? normalized.replace(/\n/g, '\r\n') : normalized), 'utf8');
    if (normalized.length > MAX_BYTES || bytes.length > MAX_BYTES) throw new AppError(413, 'FILE_TOO_LARGE', 'File exceeds 1 MiB on disk.');
    return bytes;
  }

  private temp(absolute: string, bytes: Buffer, mode: number): string {
    const temporary = path.join(path.dirname(absolute), TEMP_PREFIX + randomUUID() + '.tmp');
    const fd = fs.openSync(temporary, 'wx', mode);
    // open(mode) is filtered by umask; replacement/rename must retain source mode.
    try { fs.fchmodSync(fd, mode); fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); }
    catch (error) { fs.closeSync(fd); fs.unlinkSync(temporary); throw error; }
    fs.closeSync(fd);
    return temporary;
  }

  private committed(relative: string, actor: string): Document {
    const disk = this.disk(relative);
    if (!disk) throw new AppError(500, 'WRITE_VERIFY_FAILED', 'Written file could not be verified.');
    const version = this.nextVersion(relative);
    this.records.set(relative, this.track(relative, disk, version));
    this.workspaceVersion++; this.persistVersions();
    this.emit('changed', { path: relative, workspaceVersion: this.workspaceVersion, actor });
    this.refreshDirectories();
    return { ...this.records.get(relative)!.document! };
  }

  private refreshDirectories(): void { this.directories = this.collect().dirs; this.refreshWatchers(); }

  _replace(relative: string, baseVersion: number, content: string, actor: string, authorize: () => void): Document {
    this._assertWritable();
    const before = this._fresh(relative, baseVersion);
    const absolute = this._safePath(relative);
    const temporary = this.temp(absolute, this.encoded(content, before.document!), Number(fs.statSync(absolute).mode) & 0o777);
    try {
      this._safePath(relative);
      this._fresh(relative, baseVersion); // Hash and mtime immediately before replacement, not just watcher state.
      authorize();
      fs.renameSync(temporary, absolute);
      return this.committed(relative, actor);
    } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
  }

  _create(relative: string, content: string, actor: string, authorize: () => void): Document {
    this._assertWritable();
    this.cancelRootBackgroundScans();
    const absolute = this._safePath(relative, true);
    const bytes = this.encoded(content);
    if (fs.existsSync(absolute)) throw new AppError(409, 'FILE_EXISTS', 'Destination already exists.');
    if (this.collect().files.length >= MAX_FILES) throw new AppError(413, 'TOO_MANY_FILES', 'Workspace limit is 1000 files.');
    const created: string[] = [];
    let temporary: string | null = null;
    try {
      const parents = relative.split('/').slice(0, -1);
      for (let i = 1; i <= parents.length; i++) {
        const dir = this._safePath(parents.slice(0, i).join('/'), true);
        authorize();
        if (!fs.existsSync(dir)) { fs.mkdirSync(dir); created.push(dir); }
      }
      temporary = this.temp(absolute, bytes, 0o600);
      this._safePath(relative, true);
      authorize();
      // Atomic no-clobber publication. Unlike rename, link refuses an externally created destination.
      try { fs.linkSync(temporary, absolute); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new AppError(409, 'FILE_EXISTS', 'Destination appeared before create.'); throw error; }
      fs.unlinkSync(temporary); temporary = null;
      return this.committed(relative, actor);
    } catch (error) {
      for (const dir of created.reverse()) { try { fs.rmdirSync(dir); } catch { /* Never remove nonempty or foreign directories. */ } }
      throw error;
    } finally { if (temporary && fs.existsSync(temporary)) fs.unlinkSync(temporary); }
  }

  /** Private, append-only recovery material; never a public rollback target. */
  private renameRecovery(relative: string, newPath: string, before: Tracked, temporary: string): string {
    // Keep capture on the workspace volume even when dataDir is on another drive.
    let directory = this.rootPath;
    for (const component of ['.paircoach', 'rename-recovery']) {
      directory = path.join(directory, component);
      try { fs.mkdirSync(directory, { mode: 0o700 }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
      const stat = fs.lstatSync(directory);
      if (stat.isSymbolicLink() || !stat.isDirectory() || fs.realpathSync.native(directory) !== directory) {
        throw new AppError(403, 'UNSAFE_DATA_DIR', 'Rename recovery must use real private directories.');
      }
    }
    directory = fs.mkdtempSync(path.join(directory, 'operation-'));
    fs.chmodSync(directory, 0o700);
    this.recoveryFile(directory, 'original', before.raw!);
    this.recoveryFile(directory, 'intent.json', Buffer.from(JSON.stringify({
      format: 1, path: relative, newPath, version: before.version, originalHash: hash(before.raw!),
      temporary, captured: 'source', policy: 'Retain original and captured bytes; never overwrite either public path.'
    })));
    return directory;
  }

  private recoveryFile(directory: string, name: string, bytes: Buffer): void {
    const fd = fs.openSync(path.join(directory, name), 'wx', 0o600);
    try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  }

  /** Bounded retry of our own private entry only; never unlink a public path. */
  private cleanupRenameLink(temporary: string, attempts = 3): unknown {
    let last: unknown;
    for (let attempt = 0; attempt < attempts; attempt++) {
      try { fs.unlinkSync(temporary); return; }
      catch (error) { if (isMissing(error)) return; last = error; }
    }
    return last;
  }

  private restoreCapturedSource(directory: string, relative: string): void {
    const captured = path.join(directory, 'source');
    const stat = fs.lstatSync(captured);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
      throw new AppError(403, 'UNSAFE_PATH', 'Unexpected captured entry remains in recovery; it was not opened.');
    }
    // An independent copy avoids a public hardlink to retained recovery bytes.
    // Both copy and no-clobber publish can fail: the captured inode is NEVER deleted.
    const temporary = path.join(directory, 'restore');
    fs.copyFileSync(captured, temporary, fs.constants.COPYFILE_EXCL);
    const fd = fs.openSync(temporary, fs.constants.O_RDWR | (fs.constants.O_NOFOLLOW ?? 0));
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    try {
      const from = this._safePath(relative, true);
      try { fs.linkSync(temporary, from); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    } finally {
      const error = this.cleanupRenameLink(temporary);
      if (error) this.emit('watcherError', error);
    }
  }

  _rename(relative: string, newPath: string, baseVersion: number, actor: string, authorize: () => void): void {
    this._assertWritable();
    this.cancelRootBackgroundScans();
    const before = this._fresh(relative, baseVersion);
    const from = this._safePath(relative), to = this._safePath(newPath, true);
    if (fs.existsSync(to)) throw new AppError(409, 'FILE_EXISTS', 'Destination already exists.');
    if (!fs.existsSync(path.dirname(to))) throw new AppError(404, 'PARENT_NOT_FOUND', 'Create destination directory first.');
    const temporary = this.temp(to, before.raw!, fs.statSync(from).mode & 0o777);
    let pin: number | undefined, sourcePin: number | undefined;
    let published = false, captured = false;
    let recovery: string | undefined;
    const closePins = () => {
      // Drop ownership before close: an ambiguous close must not be replayed
      // against a descriptor number that the OS could already have reused.
      const target = pin, source = sourcePin;
      pin = sourcePin = undefined;
      try { if (target !== undefined) fs.closeSync(target); }
      finally { if (source !== undefined) fs.closeSync(source); }
    };
    try {
      recovery = this.renameRecovery(relative, newPath, before, temporary);
      pin = fs.openSync(temporary, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
      const identity = fs.fstatSync(pin, { bigint: true });
      sourcePin = fs.openSync(from, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
      const sourceIdentity = fs.fstatSync(sourcePin, { bigint: true });
      if (!before.stamp.startsWith(`${sourceIdentity.dev}:${sourceIdentity.ino}:`)) {
        throw new AppError(409, 'DISK_CONFLICT', 'Source changed before capture.');
      }
      this._fresh(relative, baseVersion); this._safePath(newPath, true); authorize();
      try { fs.linkSync(temporary, to); }
      catch (error) {
        // Resolve an ambiguous syscall outcome by observing the pinned inode,
        // never by replaying publication against the public destination.
        try {
          const observed = fs.lstatSync(this._safePath(newPath, true), { bigint: true });
          published = observed.dev === identity.dev && observed.ino === identity.ino;
        } catch { /* No safely observable own publication; preserve the original error. */ }
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
          throw new AppError(409, 'FILE_EXISTS', 'Destination appeared before rename.');
        }
        throw error;
      }
      published = true;
      // A first cleanup failure aborts the mutation even if bounded retries can
      // reconcile it. Do not conceal partial publication behind HTTP 200.
      fs.unlinkSync(temporary);
      this._safePath(relative); this._fresh(relative, baseVersion); authorize();
      const matchesDestination = (file: DiskFile | null) =>
        !!file?.stamp.startsWith(`${identity.dev}:${identity.ino}:`) && !!file.raw?.equals(before.raw!);
      if (!matchesDestination(this.disk(newPath))) {
        throw new AppError(409, 'DISK_CONFLICT', 'Rename destination changed after publication.');
      }
      // The PUBLIC source is never unlinked. Atomic rename captures the inode
      // actually present at this boundary, including a late IDE replacement.
      // The destination is an exclusive entry inside an unguessable private dir.
      const capture = path.join(recovery, 'source');
      fs.renameSync(this._safePath(relative), capture);
      captured = true;
      const stat = fs.lstatSync(capture, { bigint: true });
      if (!stat.isFile() || stat.nlink !== 1n || stat.dev !== sourceIdentity.dev || stat.ino !== sourceIdentity.ino ||
          stat.size !== BigInt(before.raw!.length) || stat.mtimeNs !== sourceIdentity.mtimeNs) {
        throw new AppError(409, 'DISK_CONFLICT', 'Captured source changed; all captured bytes are retained.');
      }
      // Bounded read from the pinned original, not a second path-based open.
      // An IDE can still write through a pre-existing fd after capture.
      const bytes = Buffer.alloc(MAX_BYTES + 1);
      let length = 0;
      while (length < bytes.length) {
        const count = fs.readSync(sourcePin, bytes, length, bytes.length - length, length);
        if (!count) break;
        length += count;
      }
      const afterCapture = fs.fstatSync(sourcePin, { bigint: true });
      if (!bytes.subarray(0, length).equals(before.raw!) || afterCapture.size !== stat.size ||
          afterCapture.mtimeNs !== stat.mtimeNs || afterCapture.ctimeNs !== stat.ctimeNs || afterCapture.nlink !== 1n) {
        throw new AppError(409, 'DISK_CONFLICT', 'Captured source was edited during validation; recovery retained.');
      }
      // Windows may settle link/unlink ctime only on the last handle close.
      // Close BOTH own pins before the final read/track, then revalidate identity,
      // bytes and source absence. Never reuse a pre-close destination stamp or
      // waive ctime checks in disk(): later real external changes must still sync.
      // The captured inode remains retained even if an IDE still has it open.
      closePins();
      const destination = this.disk(newPath);
      if (!matchesDestination(destination) || fs.existsSync(this._safePath(relative, true))) {
        throw new AppError(409, 'DISK_CONFLICT', 'A public path changed during capture.');
      }
      authorize();
      this.recoveryFile(recovery, 'complete.json', Buffer.from(JSON.stringify({ path: relative, newPath, retained: ['original', 'source'] })));
      this.records.delete(relative); this.nextVersion(relative);
      const version = this.nextVersion(newPath);
      this.records.set(newPath, this.track(newPath, destination!, version));
      this.workspaceVersion++; this.persistVersions();
      this.emit('changed', { path: newPath, workspaceVersion: this.workspaceVersion, actor });
      this.refreshDirectories();
    } catch (error) {
      // This includes ambiguous publication and cleanup failures. Reconciliation
      // must observe post-close metadata too, not publish a stamp finally invalidates.
      try { closePins(); } catch (closeError) { this.emit('watcherError', closeError); }
      const cleanupError = this.cleanupRenameLink(temporary, 2);
      if (!published && !cleanupError) throw error;
      // Reconcile a syscall with unknown outcome by reading its private target.
      // This never retries the destructive move of the public source.
      if (!captured && recovery) captured = fs.existsSync(path.join(recovery, 'source'));
      if (captured && recovery) {
        try { this.restoreCapturedSource(recovery, relative); }
        catch (restoreError) { this.emit('watcherError', restoreError); }
      }
      if (recovery) {
        try { this.recoveryFile(recovery, 'incomplete.json', Buffer.from(JSON.stringify({
          path: relative, newPath, temporary, captured,
          code: error instanceof AppError ? error.code : (error as NodeJS.ErrnoException).code ?? 'IO_ERROR'
        }))); } catch (journalError) { this.emit('watcherError', journalError); }
      }
      // Both readable copies and inaccessible (hardlinked) entries are tracked.
      // No public destination rollback; a foreign replacement always survives.
      for (const relativePath of [relative, newPath]) {
        try { this.external(relativePath, this.disk(relativePath)); }
        catch (reconcileError) { this.emit('watcherError', reconcileError); }
      }
      try { this.refreshDirectories(); }
      catch (reconcileError) { this.emit('watcherError', reconcileError); }
      const incomplete = new AppError(409, 'RENAME_INCOMPLETE',
        `Rename incomplete. No public path was overwritten or deleted for rollback. Recovery: ${recovery ?? temporary}. ` +
        'Preserve both public paths. Copy original and source from recovery to NEW names before resolving private aliases; see intent.json.');
      incomplete.cause = error;
      throw incomplete;
    } finally { closePins(); }
  }

  _delete(relative: string, baseVersion: number, actor: string, authorize: () => void): void {
    this._assertWritable();
    this.cancelRootBackgroundScans();
    const before = this._fresh(relative, baseVersion);
    const absolute = this._safePath(relative);
    // Minimal durable safety copy. Full snapshot/restore journal belongs to GATE003.
    this.safeDataDirectory();
    const id = randomUUID();
    const backup = path.join(this.dataDir, 'trash');
    if (!fs.existsSync(backup)) fs.mkdirSync(backup);
    if (fs.lstatSync(backup).isSymbolicLink()) throw new AppError(403, 'UNSAFE_DATA_DIR', 'Recovery directory cannot be a link.');
    const payload = JSON.stringify({ path: relative, version: before.version, rawBase64: before.raw!.toString('base64') });
    const fd = fs.openSync(path.join(backup, id + '.json'), 'wx', 0o600);
    try { fs.writeFileSync(fd, payload); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    this._safePath(relative); this._fresh(relative, baseVersion); authorize();
    fs.unlinkSync(absolute);
    this.records.delete(relative); this.nextVersion(relative); this.workspaceVersion++; this.persistVersions();
    this.emit('changed', { path: relative, workspaceVersion: this.workspaceVersion, actor });
    this.refreshDirectories();
  }

  private safeDataDirectory(): void {
    const absolute = this.dataDir;
    const parsed = path.parse(absolute);
    let current = parsed.root;
    for (const part of absolute.slice(parsed.root.length).split(path.sep)) {
      current = path.join(current, part);
      if (!fs.existsSync(current)) fs.mkdirSync(current, { mode: 0o700 });
      if (fs.lstatSync(current).isSymbolicLink() || !fs.statSync(current).isDirectory()) {
        throw new AppError(403, 'UNSAFE_DATA_DIR', 'Recovery data must be stored in real directories.');
      }
    }
  }

  private versionSnapshot() {
    return { workspaceVersion: this.workspaceVersion,
      files: [...this.versions].map(([path, version]) => ({ path, version, stamp: this.records.get(path)?.stamp ?? null })) };
  }
  private persistVersions(): void {
    if (!Number.isSafeInteger(this.workspaceVersion)) throw new AppError(503, 'VERSION_EXHAUSTED', 'Workspace version cannot be incremented safely.');
    try { this.versionStore?.commitVersions(this.versionSnapshot()); }
    catch (e) { this.versionFailure = true; throw e; }
  }
  /** @internal V2 authority must never fall back to an ephemeral legacy workspace. */
  _settingsVersionStore(): DurableWorkspaceVersions {
    if (!this.versionStore) throw new AppError(503, 'DURABLE_VERSIONS_REQUIRED', 'V2 settings require a durable V2 workspace.');
    this.versionStore.assertCurrent(); return this.versionStore;
  }
  /** @internal Only under the actual gate lease. Read current disk before expected-version admission. */
  _scanSettingsVersion(): void { this.scanInternal(); }
  /** @internal The ledger receipt is durable BEFORE its new version is published to listeners. */
  _publishSettingsReceipt(receipt: SettingsSaveReceipt): void {
    const snapshot = this._settingsVersionStore().snapshot();
    if (snapshot.workspaceVersion !== receipt.workspaceVersion) throw Error('Settings receipt is not the current durable commit');
    this.workspaceVersion = snapshot.workspaceVersion;
    this.emit('changed', { path: null, workspaceVersion: this.workspaceVersion, actor: 'SETTINGS' });
  }

  /** @internal Shared by every gate referencing this workspace; listeners cannot reenter a mutation. */
  _withMutation<T>(action: () => T): T {
    if (this.mutationBusy || activeRoots.has(this.rootPath) || queuedRoots.has(this.rootPath)) throw new AppError(409, 'WORKSPACE_BUSY', 'Another synchronous workspace operation is in progress.');
    this._assertWritable();
    this.mutationBusy = true; activeRoots.add(this.rootPath);
    try { return action(); } finally { this.mutationBusy = false; activeRoots.delete(this.rootPath); }
  }

  /** Admission order is shared by all WriteGate instances. Sync callers retain BUSY refusal. */
  _withQueuedMutation<T>(action: () => Promise<T>, settingsRecovery = false): Promise<T> {
    queuedRoots.set(this.rootPath, (queuedRoots.get(this.rootPath) ?? 0) + 1);
    return this.mutationQueue.run(() => {
      const remaining = queuedRoots.get(this.rootPath)! - 1;
      if (remaining) queuedRoots.set(this.rootPath, remaining); else queuedRoots.delete(this.rootPath);
      return this._withMutationAsync(action, true, settingsRecovery);
    });
  }

  /** Internal: caller retains this workspace's mutation lease through immutable copy + both fences.
   * Inventory is the executor-owned bounded raw inventory, injected rather than duplicated here.
   * Document versions come from actual tracked workspace records, never the client or filesystem mtime.
   */
  async _settledRunInput(inventory: (root: string) => Promise<readonly { path: string; sha256: string; bytes: number }[]>,
      assertLease: () => void): Promise<{ workspaceVersion: number; files: readonly InputFile[];
        normalizedContentHashes: Readonly<Record<string, string | null>>; assertCurrent(): Promise<void> }> {
    assertLease();
    this.scan();
    const before = this.workspaceVersion;
    const actual = await inventory(this.rootPath);
    assertLease(); this.scan();
    if (this.workspaceVersion !== before) throw new AppError(409, 'RUN_INPUT_CHANGED', 'Workspace changed during input capture.');
    const paths = new Set<string>(), normalized: Record<string, string | null> = {};
    const files = actual.map(file => {
      this._safePath(file.path);
      const record = this.records.get(file.path);
      if (paths.has(file.path) || !record || !Number.isSafeInteger(record.version) || record.version < 1 ||
          !/^[a-f0-9]{64}$/.test(file.sha256) || !Number.isSafeInteger(file.bytes) || file.bytes < 0 ||
          (record.raw !== null && (hash(record.raw) !== file.sha256 || record.raw.length !== file.bytes))) {
        throw new AppError(409, 'RUN_INPUT_CHANGED', 'Inventory does not match current authoritative document records.');
      }
      paths.add(file.path); normalized[file.path] = record.document?.contentHash ?? null;
      return Object.freeze({ ...file, documentVersion: record.version });
    }).sort((a,b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
    const original = JSON.stringify(files.map(({path,sha256,bytes}) => ({path,sha256,bytes})));
    return { workspaceVersion: before, files: Object.freeze(files), normalizedContentHashes: Object.freeze(normalized),
      assertCurrent: async () => {
        assertLease(); this.scan();
        const current = await inventory(this.rootPath);
        assertLease(); this.scan();
        const sorted = [...current].sort((a,b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
        if (this.workspaceVersion !== before || JSON.stringify(sorted.map(({path,sha256,bytes}) => ({path,sha256,bytes}))) !== original ||
            files.some(f => this.records.get(f.path)?.version !== f.documentVersion)) throw new AppError(409, 'RUN_INPUT_CHANGED', 'Source/dependency inventory or document authority changed.');
      },
    };
  }

  /** Async critical sections MUST retain both guards until terminal commit/rollback. */
  async _withMutationAsync<T>(action: () => Promise<T>, admitted = false, settingsRecovery = false): Promise<T> {
    if (this.mutationBusy || activeRoots.has(this.rootPath) || (!admitted && queuedRoots.has(this.rootPath))) throw new AppError(409, 'WORKSPACE_BUSY', 'Another workspace operation is in progress.');
    if (settingsRecovery) {
      this._settingsVersionStore().assertCurrent();
      if (this.closed || this.recoveryRequired) throw new AppError(503, 'WORKSPACE_RECOVERY_REQUIRED', 'Workspace cannot admit settings recovery.');
    } else this._assertWritable();
    this.cancelRootBackgroundScans();
    this.mutationBusy = true; activeRoots.add(this.rootPath); activeAsyncRoots.add(this.rootPath);
    try { return await action(); }
    finally { this.mutationBusy = false; activeRoots.delete(this.rootPath); activeAsyncRoots.delete(this.rootPath); }
  }

  private assertReadable(): void {
    if (this.versionFailure) throw new AppError(503, 'WORKSPACE_VERSIONS_UNAVAILABLE', 'Durable version publication failed; restart recovery is required.');
    this.versionStore?.assertCurrent();
    if (activeAsyncRoots.has(this.rootPath)) throw new AppError(409, 'WORKSPACE_BUSY', 'Snapshot capture/restore is in progress; retry after its terminal result.');
  }

  _assertWritable(): void {
    if (this.versionFailure) throw new AppError(503, 'WORKSPACE_VERSIONS_UNAVAILABLE', 'Durable version publication failed; restart recovery is required.');
    if (this.closed) throw new AppError(503, 'WORKSPACE_CLOSED', 'Workspace is closed.');
    this.versionStore?.assertWritable();
    if (!this.recoveryRequired) {
      try { this.recoveryRequired = this.snapshotJournal.hasPending(); }
      catch { this.recoveryRequired = true; }
    }
    if (this.recoveryRequired) throw snapshotFailure(`Pending/invalid snapshot journal in ${this.snapshotJournal.base}. Preserve all material; recovery is required before writing.`);
  }

  /** @internal Called only by the gate constructor, before exposing normal mutation authority. */
  _recoverSnapshots(): void {
    if (this.mutationBusy || activeRoots.has(this.rootPath) || queuedRoots.has(this.rootPath)) throw new AppError(409, 'WORKSPACE_BUSY', 'Recovery cannot reenter an active workspace operation.');
    this.cancelRootBackgroundScans();
    this.mutationBusy = true; activeRoots.add(this.rootPath);
    try {
      this.snapshotJournal.recover();
      this.recoveryRequired = false;
      if (!this.startupSnapshotRecovery) this.scanInternal();
    } catch (error) {
      this.recoveryRequired = true;
      const failure = snapshotFailure(`Recovery required in ${this.snapshotJournal.base}. Preserve public paths and copy recovery material to NEW names before manual resolution.`);
      failure.cause = error; throw failure;
    } finally { this.mutationBusy = false; activeRoots.delete(this.rootPath); }
  }

  private *captureSnapshotSteps(paths?: string[]): Generator<void, { files: RestoreBefore[]; validate: () => Generator<void, void, void>; version: number }, void> {
    yield* this.scanSteps();
    const version = this.workspaceVersion;
    const baseline = new Map([...this.records].map(([p, r]) => [p, r.stamp]));
    const selected = paths === undefined ? [...baseline.keys()].filter(snapshotAllowed).sort() : paths;
    yield* this.snapshotStore.pathSteps(selected);
    const files: RestoreBefore[] = [];
    for (const [index, relative] of selected.entries()) {
      const absolute = this._safePath(relative, true);
      const disk = this.disk(relative);
      let file: RestoreBefore;
      if (!disk) file = { path: relative, rawBase64: null, mode: null, identity: null, mtimeNs: null };
      else {
        if (!disk.raw) throw disk.error ?? new AppError(403, 'UNSAFE_PATH', 'Snapshot requires a regular, bounded, unlinked file.');
        const stat = fs.lstatSync(absolute, { bigint: true });
        const prefix = [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs, stat.mode].join(':') + ':';
        if (!disk.stamp.startsWith(prefix)) throw new AppError(409, 'DISK_CONFLICT', 'File changed during snapshot capture.');
        file = { path: relative, rawBase64: disk.raw.toString('base64'), mode: Number(stat.mode & 0o777n), identity: identity(stat), mtimeNs: String(stat.mtimeNs) };
      }
      this.emit('snapshotCheckpoint', { phase: 'SNAPSHOT_FILE_CAPTURED', index });
      files.push(file);
      yield;
    }
    const self = this;
    function* validate(): Generator<void, void, void> {
      let changed = version !== self.workspaceVersion;
      const collected = (yield* self.collectSteps()).files;
      if (collected.length !== baseline.size || collected.some(p => !baseline.has(p))) changed = true;
      for (const [p, stamp] of baseline) { if (self.disk(p)?.stamp !== stamp) changed = true; yield; }
      // Missing explicit paths (tombstones) must still be missing after every other capture.
      for (const f of files) { if (f.rawBase64 === null && self.disk(f.path) !== null) changed = true; yield; }
      if (changed) {
        yield* self.scanSteps();
        throw new AppError(409, 'DISK_CONFLICT', 'Workspace changed during capture; no snapshot was published with an old version.');
      }
    }
    yield* validate();
    return { files, validate, version };
  }

  createSnapshot(label: string, paths?: string[]): Snapshot {
    return this._withMutation(() => {
      return drainSteps(this.createSnapshotSteps(label, paths));
    });
  }

  /** Yieldable capture for public finish; legacy internal sync API remains compatible. */
  createSnapshotAsync(label: string, paths?: string[]): Promise<Snapshot> {
    const selected = Array.isArray(paths) ? [...paths] : paths;
    return this._withMutationAsync(() => drainStepsAsync(this.createSnapshotSteps(label, selected)));
  }

  private *createSnapshotSteps(label: string, paths?: string[]): Generator<void, Snapshot, void> {
    const captured = yield* this.captureSnapshotSteps(paths);
    return yield* this.snapshotStore.putSteps(label, captured.version, captured.files, captured.validate);
  }

  listSnapshots(): Snapshot[] { this.assertReadable(); return this.snapshotStore.list(); }
  /** Internal frozen material only: never an automatic AI, wire, or log payload. */
  readSnapshot(snapshotId: string): FrozenSnapshot { this.assertReadable(); return this.snapshotStore.read(snapshotId); }

  restoreSnapshot(_snapshotId: string, _paths: string[], _auth: MutationAuth): Snapshot {
    throw new AppError(403, 'WRITE_GATE_REQUIRED', 'Only WriteGate may authorize snapshot restoration.');
  }

  /** @internal WriteGate is the sole authority; expected version is the ORIGINAL proposal version. */
  _restoreSnapshot(snapshotId: string, paths: string[], expectedWorkspaceVersion: number, authorize: () => void): Promise<Snapshot> {
    return drainStepsAsync(this.restoreSnapshotSteps(snapshotId, paths, expectedWorkspaceVersion, authorize));
  }

  private *restoreSnapshotSteps(snapshotId: string, paths: string[], expectedWorkspaceVersion: number, authorize: () => void): Generator<void, Snapshot, void> {
    this._assertWritable();
    if (!Number.isSafeInteger(expectedWorkspaceVersion) || expectedWorkspaceVersion < 0) throw new AppError(400, 'INVALID_VERSION', 'A nonnegative expectedWorkspaceVersion is required.');
    yield* this.snapshotStore.pathSteps(paths, false);
    const source = yield* this.snapshotStore.readSteps(snapshotId);
    const sourceFiles = new Map(source.files.map(f => [f.path, f]));
    if (paths.some(p => !sourceFiles.has(p))) throw new AppError(400, 'INVALID_SNAPSHOT_PATHS', 'Restore is limited to an explicit subset of the snapshot.');
    yield* this.scanSteps(); authorize();
    if (this.workspaceVersion !== expectedWorkspaceVersion) throw new AppError(409, 'WORKSPACE_VERSION_CONFLICT', 'Proposal workspace version is stale.');
    let backup: Snapshot, captured: ReturnType<WorkspaceService['captureSnapshotSteps']> extends Generator<void, infer T, void> ? T : never;
    try {
      captured = yield* this.captureSnapshotSteps(paths);
      backup = yield* this.snapshotStore.putSteps('Backup before restore ' + snapshotId, captured.version, captured.files, function* () { yield* captured.validate(); authorize(); });
    } catch (error) {
      if (error instanceof AppError && ['DISK_CONFLICT', 'WORKSPACE_VERSION_CONFLICT', 'STALE_EPOCH', 'LEASE_REQUIRED', 'SESSION_MISMATCH', 'WRITE_OWNER_CONFLICT'].includes(error.code)) throw error;
      const failure = new AppError(503, 'SNAPSHOT_BACKUP_FAILED', 'Durable backup failed; task files were not modified.');
      failure.cause = error; throw failure;
    }
    const self = this;
    function* preflight(): Generator<void, void, void> {
      yield* captured.validate(); authorize();
      if (self.workspaceVersion !== expectedWorkspaceVersion) throw new AppError(409, 'WORKSPACE_VERSION_CONFLICT', 'Proposal workspace version changed before restore.');
    }
    yield* preflight();
    try {
      yield* this.snapshotJournal.runSteps(captured.files, paths.map(p => sourceFiles.get(p)!), backup.snapshotId, authorize, preflight);
    } catch (error) {
      try { this.recoveryRequired = yield* this.snapshotJournal.pendingSteps(); } catch { this.recoveryRequired = true; }
      if (!this.recoveryRequired) yield* this.scanSteps();
      throw error;
    }
    yield* this.scanSteps(); this.refreshWatchers(); // post-close stamps only; no historical document version is replayed
    return backup;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.cancelBackgroundScan();
    const instances = openWorkspaces.get(this.rootPath);
    instances?.delete(this);
    if (!instances?.size) openWorkspaces.delete(this.rootPath);
    if (this.poll) clearInterval(this.poll);
    if (this.scanTimer) clearTimeout(this.scanTimer);
    for (const watcher of this.watchers.values()) watcher.close();
    this.watchers.clear();
    this.versionStore?.close();
    this.removeAllListeners();
  }
}
