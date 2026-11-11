import { spawn, type ChildProcessWithoutNullStreams, type SpawnOptionsWithoutStdio } from 'node:child_process';
import { isAbsolute } from 'node:path';
import type { Readable, Writable } from 'node:stream';
import { assertRealDirectory } from './LanguageProcessJournal';

export interface LanguageContainerInspection {
  id: string; name: string; imageId: string; labels: Record<string, string>;
  running: boolean; status: string; startedAt: string; exitCode: number;
}
export interface LanguageCommandResult { exitCode: number; stdout: string; stderr: string; truncated: boolean }
export interface LanguageAttachment {
  input: Readable; output: Writable;
  /** Completion/error of docker-attach CLI, NEVER a container Stop proof. */
  done: Promise<LanguageCommandResult>;
  disconnect(): void;
}
export interface LanguageDockerDriver {
  engineId(): Promise<string>;
  inspect(name: string): Promise<LanguageContainerInspection | null>;
  command(args: readonly string[], timeoutMs?: number): Promise<LanguageCommandResult>;
  attach(name: string): LanguageAttachment;
}
export type LanguageDockerSpawner = (executable: string, args: string[], options: SpawnOptionsWithoutStdio) => ChildProcessWithoutNullStreams;
export interface DockerLanguageDriverOptions {
  /** Trusted installation configuration, NEVER supplied by task, client or AI. */
  executable: string; dockerConfigDirectory: string;
  context?: string;
  /** Dependency seam for unit tests only. Default uses real Node spawn(shell:false). */
  spawn?: LanguageDockerSpawner;
}
const MAX_OUTPUT = 512 * 1024;
const safeName = (name: string): void => { if (!/^paircoach-lsp-[a-f0-9]{16}-[a-f0-9-]{36}$/.test(name) && !/^[a-f0-9]{64}$/.test(name)) throw new Error('Invalid owned LSP container name'); };
/** No shell, inherited secrets, task executable, host JDK/Python, daemon-wide cleanup or pull. */
export class DockerLanguageDriver implements LanguageDockerDriver {
  private readonly env: NodeJS.ProcessEnv;
  private readonly prefix: string[];
  private readonly spawnProcess: LanguageDockerSpawner;
  constructor(private readonly options: DockerLanguageDriverOptions) {
    if (!isAbsolute(options.executable) || /[\0\r\n]/.test(options.executable)) throw new Error('Docker executable must be absolute');
    assertRealDirectory(options.dockerConfigDirectory);
    if (options.context && !/^[A-Za-z0-9_.-]{1,100}$/.test(options.context)) throw new Error('Invalid trusted Docker context');
    this.prefix = options.context ? ['--context', options.context] : [];
    this.env = { DOCKER_CONFIG: options.dockerConfigDirectory };
    // Native CLI requires OS DLL discovery, but never HOME/credentials/task environment.
    if (process.platform === 'win32' && process.env.SystemRoot) this.env.SystemRoot = process.env.SystemRoot;
    this.spawnProcess = options.spawn ?? ((exe, args, opts) => spawn(exe, args, { ...opts, stdio: ['pipe', 'pipe', 'pipe'] }));
  }
  private child(args: readonly string[]): ChildProcessWithoutNullStreams {
    if (args.length > 128 || args.some(arg => typeof arg !== 'string' || arg.includes('\0')) || args.join('').length > 64 * 1024)
      throw new Error('Invalid/bounded Docker argv');
    return this.spawnProcess(this.options.executable, [...this.prefix, ...args], { shell: false, env: { ...this.env }, windowsHide: true });
  }
  private observe(child: ChildProcessWithoutNullStreams, timeoutMs: number | null): Promise<LanguageCommandResult> {
    return new Promise((resolve, reject) => {
      const stdout: Buffer[] = [], stderr: Buffer[] = []; let out = 0, err = 0, truncated = false, failure: Error | null = null;
      const consume = (chunks: Buffer[], size: 'out' | 'err') => (chunk: Buffer | string) => {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk), used = size === 'out' ? out : err;
        const kept = bytes.subarray(0, Math.max(0, MAX_OUTPUT - used));
        if (kept.length) chunks.push(kept); if (kept.length !== bytes.length) truncated = true;
        if (size === 'out') out += kept.length; else err += kept.length;
      };
      // Timeout/disconnect only kills the CLI. Caller MUST reconcile the actual container by inspect.
      const timer = timeoutMs === null ? undefined : setTimeout(() => {
        failure = new Error('Docker CLI deadline; operation outcome unknown'); child.kill('SIGKILL'); reject(failure);
      }, timeoutMs);
      child.stdout.on('data', consume(stdout, 'out')); child.stderr.on('data', consume(stderr, 'err'));
      child.on('error', error => { failure = error; reject(error); });
      child.on('close', code => {
        if (timer) clearTimeout(timer);
        if (failure) reject(failure);
        else resolve({ exitCode: code ?? -1, stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8'), truncated });
      });
    });
  }
  command(args: readonly string[], timeoutMs = 5000): Promise<LanguageCommandResult> {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10000) return Promise.reject(new Error('Invalid Docker command deadline'));
    const child = this.child(args); child.stdin.end(); return this.observe(child, timeoutMs);
  }
  async engineId(): Promise<string> {
    const result = await this.command(['info', '--format', '{{json .ID}}']);
    if (result.exitCode !== 0 || result.truncated) throw new Error('Docker daemon identity unavailable');
    const id = JSON.parse(result.stdout);
    if (typeof id !== 'string' || !/^[A-Za-z0-9:_.-]{1,200}$/.test(id)) throw new Error('Invalid Docker engine identity'); return id;
  }
  async inspect(name: string): Promise<LanguageContainerInspection | null> {
    safeName(name); const result = await this.command(['container', 'inspect', '--format', '{{json .}}', name]);
    if (result.truncated) throw new Error('Container inspection truncated');
    if (result.exitCode !== 0) {
      const missing = [`Error: No such object: ${name}`, `Error response from daemon: No such container: ${name}`, `Error: No such container: ${name}`];
      if (!result.stdout.trim() && missing.includes(result.stderr.trim())) return null;
      throw new Error('Container inspection unavailable; not proof of absence');
    }
    const value = JSON.parse(result.stdout);
    if (!value || !/^[a-f0-9]{64}$/.test(value.Id) || typeof value.Name !== 'string' || typeof value.Image !== 'string' ||
      !value.Config?.Labels || Array.isArray(value.Config.Labels) || typeof value.Config.Labels !== 'object' ||
      Object.values(value.Config.Labels).some(v => typeof v !== 'string') || typeof value.State?.Running !== 'boolean' ||
      typeof value.State.Status !== 'string' || typeof value.State.StartedAt !== 'string' || !Number.isSafeInteger(value.State.ExitCode))
      throw new Error('Malformed container inspection');
    return { id: value.Id, name: value.Name.replace(/^\//, ''), imageId: value.Image, labels: value.Config.Labels,
      running: value.State.Running, status: value.State.Status, startedAt: value.State.StartedAt, exitCode: value.State.ExitCode };
  }
  attach(name: string): LanguageAttachment {
    safeName(name);
    const child = this.child(['start', '--attach', '--interactive', name]);
    // Do not consume stdout: JsonRpcTransport is its sole reader. Drain only bounded stderr locally.
    let used = 0; const errors: Buffer[] = []; let truncated = false, failure: Error | null = null;
    const done = new Promise<LanguageCommandResult>((resolve, reject) => {
      child.stderr.on('data', chunk => { const b = Buffer.from(chunk), kept = b.subarray(0, Math.max(0, MAX_OUTPUT - used));
        if (kept.length) errors.push(kept); used += kept.length; if (b.length !== kept.length) truncated = true; });
      child.on('error', e => { failure = e; reject(e); });
      child.on('close', code => { if (failure) reject(failure); else resolve({ exitCode: code ?? -1, stdout: '', stderr: Buffer.concat(errors).toString('utf8'), truncated }); });
    });
    // Owner may be reconciling failed startup while spawn errors arrive; no unhandled rejection.
    void done.catch(() => {});
    return { input: child.stdout, output: child.stdin, done, disconnect: () => { child.kill('SIGKILL'); } };
  }
}
