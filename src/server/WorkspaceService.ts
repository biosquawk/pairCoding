import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { Document, FileEntry, Project, Settings, Snapshot } from '../shared/protocol';
import type { MutationAuth } from './WriteGate';
import { AppError } from './errors';

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
  readonly projectId = randomUUID();
  workspaceVersion = 0;
  settings: Settings;
  private records = new Map<string, Tracked>();
  private versions = new Map<string, number>();
  private directories: string[] = [];
  private watchers = new Map<string, fs.FSWatcher>();
  private poll: ReturnType<typeof setInterval>;
  private scanTimer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;

  constructor(rootPath: string, dataDir?: string) {
    super();
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
    this.dataDir = path.resolve(dataDir ?? path.join(this.rootPath, '.paircoach'));
    if (this.dataDir === this.rootPath) throw new AppError(400, 'INVALID_DATA_DIR', 'Data directory must not be the workspace root.');
    this.settings = { taskFilePath: 'challenge.md', taskMode: 'IMPLEMENTATION', reviewNotesPath: 'review.md',
      runProfiles: [], aiConsent: false, contextPatterns: ['**/*.java', '**/*.py', '**/*.js', '**/*.ts', '**/*.md'] };
    this.scan(true);
    // Watch each real directory without following symlinks; polling covers missed events.
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
    if (stat.nlink > 1n) throw new AppError(403, 'UNSAFE_PATH', 'Hard-linked files are not opened.');
    const metadata = (s: fs.BigIntStats) => [s.dev, s.ino, s.size, s.mtimeNs, s.ctimeNs, s.mode].join(':');
    const stamp = metadata(stat);
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
    this.workspaceVersion++;
    const document = this.records.get(relative)?.document ?? null;
    const payload: ExternalSync = { operation: !disk ? 'DELETED' : old ? 'UPDATED' : 'CREATED',
      path: relative, version, workspaceVersion: this.workspaceVersion, document: document ? { ...document } : null };
    this.emit('external', payload);
    this.emit('changed', { path: relative, workspaceVersion: this.workspaceVersion, actor: 'EXTERNAL' });
  }

  private collect(): { files: string[]; dirs: string[] } {
    const files: string[] = [], dirs: string[] = [];
    const walk = (relative: string) => {
      const directory = relative ? this._safePath(relative) : this.rootPath;
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const candidate = relative ? `${relative}/${entry.name}` : entry.name;
        try { this._safePath(candidate); }
        catch (error) { if (error instanceof AppError && error.status === 403) continue; throw error; }
        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) { dirs.push(candidate); walk(candidate); }
        else if (entry.isFile()) {
          files.push(candidate);
          if (files.length > MAX_FILES) throw new AppError(413, 'TOO_MANY_FILES', 'Workspace exceeds 1000 visible files.');
        }
      }
    };
    walk('');
    return { files, dirs };
  }

  private scan(initial = false): void {
    const { files, dirs } = this.collect();
    // Gather first, so a failed scan cannot publish a partially missing tree.
    const found = new Map<string, DiskFile>();
    for (const file of files) { const disk = this.disk(file); if (disk) found.set(file, disk); }
    this.directories = dirs;
    for (const [file, disk] of found) this.external(file, disk, initial);
    for (const file of [...this.records.keys()]) if (!found.has(file)) this.external(file, null, initial);
  }

  scanExternal(): void { this.scan(); this.refreshWatchers(); }

  private watchScan(): void {
    if (this.closed) return;
    try { this.scanExternal(); }
    catch (error) { this.emit('watcherError', error instanceof AppError ? error : new AppError(503, 'WATCHER_FAILED', 'Reload workspace; watcher could not scan safely.')); }
  }

  private refreshWatchers(): void {
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
    this.external(relative, this.disk(relative));
    const tracked = this.records.get(relative);
    if (!tracked) throw new AppError(404, 'FILE_NOT_FOUND', 'File does not exist.');
    if (tracked.error) throw tracked.error;
    return { ...tracked.document! };
  }

  listFiles(): FileEntry[] {
    return [...this.directories.map(p => ({ path: p, kind: 'DIRECTORY' as const, version: null })),
      ...[...this.records].map(([p, record]) => ({ path: p, kind: 'FILE' as const, version: record.version }))]
      .sort((a, b) => a.path.localeCompare(b.path));
  }

  getProject(sessionId: string): Project {
    return { projectId: this.projectId, sessionId, rootPath: this.rootPath, workspaceVersion: this.workspaceVersion,
      settings: structuredClone(this.settings), files: this.listFiles(), capabilities: {
        canRunMain: this.settings.runProfiles.some(p => p.kind === 'RUN_MAIN'),
        canRunTests: this.settings.runProfiles.some(p => p.kind === 'RUN_TESTS'), docs: 'NOT_INSTALLED', autocomplete: 'NOT_INSTALLED' } };
  }

  updateSettings(settings: Settings): void {
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
    this.workspaceVersion++;
    this.emit('changed', { path: null, workspaceVersion: this.workspaceVersion, actor: 'SETTINGS' });
  }

  /** @internal Only WriteGate uses these mutation primitives. No async critical sections. */
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
    this.workspaceVersion++;
    this.emit('changed', { path: relative, workspaceVersion: this.workspaceVersion, actor });
    this.refreshDirectories();
    return { ...this.records.get(relative)!.document! };
  }

  private refreshDirectories(): void { this.directories = this.collect().dirs; this.refreshWatchers(); }

  _replace(relative: string, baseVersion: number, content: string, actor: string, authorize: () => void): Document {
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

  _rename(relative: string, newPath: string, baseVersion: number, actor: string, authorize: () => void): void {
    const before = this._fresh(relative, baseVersion);
    const from = this._safePath(relative), to = this._safePath(newPath, true);
    if (fs.existsSync(to)) throw new AppError(409, 'FILE_EXISTS', 'Destination already exists.');
    if (!fs.existsSync(path.dirname(to))) throw new AppError(404, 'PARENT_NOT_FOUND', 'Create destination directory first.');
    // Publish an independent, fsynced copy: linking the source itself would leave
    // dangerous aliases if removing the source failed (and change its ctime).
    const temporary = this.temp(to, before.raw!, fs.statSync(from).mode & 0o777);
    // Pin the published inode until the final check: without an open descriptor,
    // unlink+create can immediately reuse its inode number, even with equal bytes.
    let pin: number | undefined;
    let published = false;
    try {
      let identity: fs.BigIntStats;
      try {
        pin = fs.openSync(temporary, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
        identity = fs.fstatSync(pin, { bigint: true });
        this._fresh(relative, baseVersion); this._safePath(newPath, true); authorize();
        // This is the no-clobber linearization point, not an existsSync check.
        // renameSync would overwrite a destination created by an external IDE.
        try { fs.linkSync(temporary, to); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
            throw new AppError(409, 'FILE_EXISTS', 'Destination appeared before rename.');
          }
          throw error;
        }
        published = true;
      } finally {
        fs.unlinkSync(temporary); // Drop only the private publication link.
      }
      // Publication and removal are two filesystem effects. Source freshness and
      // authority must still hold after publication; a copy is not a fresh source.
      this._safePath(relative); this._fresh(relative, baseVersion); authorize();
      const destination = this.disk(newPath);
      if (!destination?.stamp.startsWith(`${identity.dev}:${identity.ino}:`) ||
          !destination.raw?.equals(before.raw!)) {
        throw new AppError(409, 'DISK_CONFLICT', 'Rename destination changed after publication.');
      }
      fs.unlinkSync(from);
    } catch (error) {
      if (!published) throw error;
      // No unlink(to), even after an inode check: Node has no atomic conditional
      // unlink, and a foreign replacement could appear between check and cleanup.
      // Preserve both paths, reconcile observable state, and never ACK success.
      for (const relativePath of [relative, newPath]) {
        try { this.external(relativePath, this.disk(relativePath)); }
        catch (reconcileError) { this.emit('watcherError', reconcileError); }
      }
      try { this.refreshDirectories(); }
      catch (reconcileError) { this.emit('watcherError', reconcileError); }
      const incomplete = new AppError(409, 'RENAME_INCOMPLETE',
        'Rename was partially published. No destination was rolled back. Reload both paths and preserve their contents before retrying.');
      incomplete.cause = error;
      throw incomplete;
    } finally { if (pin !== undefined) fs.closeSync(pin); }
    this.records.delete(relative); this.nextVersion(relative);
    // A rename is one workspace mutation, but both path identities advance monotonically.
    this.committed(newPath, actor);
  }

  _delete(relative: string, baseVersion: number, actor: string, authorize: () => void): void {
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
    this.records.delete(relative); this.nextVersion(relative); this.workspaceVersion++;
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

  createSnapshot(_label: string, _paths?: string[]): Snapshot { throw new AppError(503, 'SNAPSHOTS_NOT_READY', 'Snapshots require GATE003 acceptance.'); }
  listSnapshots(): Snapshot[] { throw new AppError(503, 'SNAPSHOTS_NOT_READY', 'Snapshots require GATE003 acceptance.'); }
  restoreSnapshot(_snapshotId: string, _paths: string[], _auth: MutationAuth): Snapshot {
    throw new AppError(503, 'SNAPSHOTS_NOT_READY', 'Restore/journal/recovery require GATE003 implementation.');
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.poll);
    if (this.scanTimer) clearTimeout(this.scanTimer);
    for (const watcher of this.watchers.values()) watcher.close();
    this.watchers.clear();
    this.removeAllListeners();
  }
}
