import { join } from 'node:path';
import { JsonRpcTransport, type RpcTransportOptions } from './JsonRpcTransport';
import type { LanguageAttachment, LanguageContainerInspection, LanguageDockerDriver } from './DockerLanguageDriver';
import { assertLaunchId, assertRealDirectory, intentHash, receiptHash, sha256,
  type LanguageProcessIntent, type LanguageProcessJournal, type LanguageProcessReceipt } from './LanguageProcessJournal';

export interface PreparedLanguageLaunch {
  /** Backend-generated UUID; shadow capture has already created these fresh siblings below ownedRoot/launchId. */
  launchId: string; installationId: string; engineId: string;
  projectId: string; sessionId: string; profileId: string; providerGeneration: string;
  configurationGeneration: string; shadowGeneration: string; connectionGeneration: string;
  phase: 'completion' | 'diagnostics'; provider: 'jdt' | 'pylsp'; imageId: string;
  /** Fixed pinned provider launcher, never wire/task/AI commands. argv follows imageId, not Docker flags. */
  argv: readonly string[];
}
/** Shared by the single-project backend registry across ALL profiles/projects/generations, never per launch. */
export class LanguageProcessAdmission {
  private owners = new Map<PreparedLanguageLaunch['phase'], { launchId: string; owner: object }>();
  claim(phase: PreparedLanguageLaunch['phase'], launchId: string, owner: object): void {
    const held = this.owners.get(phase);
    if (held && held.owner !== owner) throw new Error(`LSP ${phase} ownership retained for ${held.launchId}; reconcile before another launch`);
    this.owners.set(phase, { launchId, owner });
  }
  release(phase: PreparedLanguageLaunch['phase'], owner: object): void {
    if (this.owners.get(phase)?.owner === owner) this.owners.delete(phase);
  }
}
export interface DockerLanguageProcessOptions {
  /** Private controlled language-copy root, NOT original workspace, Run input, home or shared dependency cache. */
  ownedRoot: string; driver: LanguageDockerDriver; journal: LanguageProcessJournal; admission: LanguageProcessAdmission;
  rpc?: Omit<RpcTransportOptions, 'connectionId' | 'onClosed'>;
  onTransportClosed?: (error: Error) => void;
}
export type LanguageProcessRetirement = { confirmed: boolean; removed: boolean; problem: string | null };
const identityKeys = ['installationId', 'engineId', 'projectId', 'sessionId', 'profileId', 'providerGeneration',
  'configurationGeneration', 'shadowGeneration', 'connectionGeneration'] as const;
const frozen = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const deepFreeze = <T>(value: T): T => {
  if (value && typeof value === 'object') { for (const child of Object.values(value)) deepFreeze(child); Object.freeze(value); }
  return value;
};
const message = (e: unknown): string => e instanceof Error ? e.message : String(e);
const delay = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));
const terminal = (c: LanguageContainerInspection): boolean => !c.running && ['exited', 'dead'].includes(c.status)
  && !!c.startedAt && !c.startedAt.startsWith('0001-');

/**
 * Owns ONE actual LSP container. Never invokes Run, host toolchains or original workspace writes.
 * Unknown create/start/stop/remove keeps intent+phase admission; retry is retire/reconcile, NEVER new create.
 */
export class DockerLanguageProcess {
  readonly intent: Readonly<LanguageProcessIntent>;
  private readonly hash: string;
  private rpcTransport: JsonRpcTransport | null = null;
  private attachment: LanguageAttachment | null = null;
  private admitted = false;
  private startAttempted = false;
  private startOperation: Promise<JsonRpcTransport> | null = null;
  private retirement: Promise<LanguageProcessRetirement> | null = null;
  private removed = false;
  private retiring = false;
  private lastProblem: string | null = null;
  private constructor(intent: LanguageProcessIntent, private readonly options: DockerLanguageProcessOptions, recovery: boolean) {
    this.intent = deepFreeze(frozen(intent)); this.hash = intentHash(intent);
    if (recovery) { this.claim(); this.startAttempted = true; }
  }
  static prepare(spec: PreparedLanguageLaunch, options: DockerLanguageProcessOptions): DockerLanguageProcess {
    return DockerLanguageProcess.prepared(spec, options, true);
  }
  private static prepared(spec: PreparedLanguageLaunch, options: DockerLanguageProcessOptions, requireDirectories: boolean): DockerLanguageProcess {
    assertLaunchId(spec.launchId); assertRealDirectory(options.ownedRoot);
    for (const key of identityKeys) if (typeof spec[key] !== 'string' || !spec[key].length || spec[key].length > 200 || /[\x00-\x1f\x7f]/.test(spec[key]))
      throw new Error(`Invalid trusted process identity: ${key}`);
    if (!['completion', 'diagnostics'].includes(spec.phase) || !['jdt', 'pylsp'].includes(spec.provider) || !/^sha256:[a-f0-9]{64}$/.test(spec.imageId))
      throw new Error('Invalid resolved language image/provider');
    if (!Array.isArray(spec.argv) || !spec.argv.length || spec.argv.length > 48 || spec.argv.some(arg => typeof arg !== 'string' || arg.includes('\0')) ||
      spec.argv.join('').length > 16 * 1024 || !/^(?:\/bin\/sh|sh|\/opt\/[a-zA-Z0-9/_.-]+|\/usr\/local\/bin\/python|python)$/.test(spec.argv[0]))
      throw new Error('Invalid trusted pinned provider launcher');
    const root = join(options.ownedRoot, spec.launchId);
    const workspaceDirectory = join(root, 'workspace'), bootDirectory = join(root, 'boot'), stateDirectory = join(root, 'state');
    const mounts = [workspaceDirectory, bootDirectory, stateDirectory];
    options.journal.assertIsolated(mounts);
    if (requireDirectories) for (const path of mounts) assertRealDirectory(path);
    const labels: Record<string, string> = {
      'paircoach.kind': 'lsp', 'paircoach.launch': spec.launchId, 'paircoach.phase': spec.phase,
      'paircoach.provider': spec.provider, 'paircoach.image': spec.imageId,
      'paircoach.argv': sha256(JSON.stringify(spec.argv)),
      'paircoach.paths': sha256(JSON.stringify([workspaceDirectory, bootDirectory, stateDirectory])),
    };
    for (const key of identityKeys) labels[`paircoach.${key}`] = sha256(spec[key]);
    const identity = Object.fromEntries(identityKeys.map(key => [key, spec[key]])) as Pick<LanguageProcessIntent, typeof identityKeys[number]>;
    const intent: LanguageProcessIntent = { ...identity, launchId: spec.launchId, phase: spec.phase, provider: spec.provider, imageId: spec.imageId, argv: [...spec.argv], schemaVersion: 1,
      name: `paircoach-lsp-${sha256(spec.installationId).slice(0,16)}-${spec.launchId}`, labels,
      workspaceDirectory, bootDirectory, stateDirectory, createdUTC: new Date().toISOString() };
    return new DockerLanguageProcess(intent, options, false);
  }
  /** Restored handles can ONLY retire, never replay start/create or reattach a mutable old index. */
  static recover(launchId: string, options: DockerLanguageProcessOptions): DockerLanguageProcess {
    const intent = options.journal.readIntent(launchId);
    if (intent.launchId !== launchId || intent.schemaVersion !== 1) throw new Error('Journal identity conflict');
    // Recompute ALL names, labels and fixed paths rather than trusting deserialized Docker identity.
    const expected = DockerLanguageProcess.prepared(intent, options, false).intent;
    const { createdUTC: _a, ...left } = intent, { createdUTC: _b, ...right } = expected;
    if (Object.keys(left).length !== Object.keys(right).length || (Object.keys(right) as (keyof typeof right)[]).some(key => JSON.stringify(left[key]) !== JSON.stringify(right[key])) || !Number.isFinite(Date.parse(intent.createdUTC))) throw new Error('Invalid restored process intent');
    return new DockerLanguageProcess(intent, options, true);
  }
  get problem(): string | null { return this.lastProblem; }
  get transport(): JsonRpcTransport | null { return this.rpcTransport; }
  private claim(): void { this.options.admission.claim(this.intent.phase, this.intent.launchId, this); this.admitted = true; }
  private assertOwned(c: LanguageContainerInspection): void {
    const recordedId = this.options.journal.startContainerId(this.intent.launchId, this.hash);
    if (c.name !== this.intent.name || c.imageId !== this.intent.imageId || !/^[a-f0-9]{64}$/.test(c.id) ||
      Object.entries(this.intent.labels).some(([key, value]) => c.labels[key] !== value) ||
      (recordedId !== null && recordedId !== c.id)) throw new Error('LSP container ownership/image mismatch; no mutation');
  }
  private async engine(): Promise<void> {
    if (await this.options.driver.engineId() !== this.intent.engineId) throw new Error('LSP Docker engine changed/unavailable; ownership retained');
  }
  private assertIntentReadback(): void {
    if (intentHash(this.options.journal.readIntent(this.intent.launchId)) !== this.hash) throw new Error('LSP durable intent readback mismatch');
  }
  private createArgv(): string[] {
    const i = this.intent;
    // Only these three fixed owned binds. Never mount Docker socket, home, credentials, original sources or Run input.
    const mounts = [[i.workspaceDirectory, '/workspace', true], [i.bootDirectory, '/artifacts', false], [i.stateDirectory, '/jdt-state', false]] as const;
    if (mounts.some(([path]) => /[,\x00-\x1f\x7f]/.test(path))) throw new Error('Unsafe Docker mount path');
    return ['create', '--interactive', '--name', i.name, '--pull=never', '--network=none', '--restart=no', '--read-only',
      '--cap-drop=ALL', '--security-opt=no-new-privileges', '--user=10001:10001', '--memory=2048m', '--cpus=2', '--pids-limit=192',
      '--log-driver=json-file', '--log-opt=max-size=10m', '--log-opt=max-file=1', '--tmpfs', '/tmp:rw,nosuid,nodev,size=768m,mode=1777',
      '--env', 'HOME=/tmp', '--env', 'XDG_CACHE_HOME=/tmp/cache', '--env', 'PYTHONDONTWRITEBYTECODE=1',
      ...(i.provider === 'pylsp' ? ['--env', 'PYTHONPATH=/opt/pylsp'] : []),
      ...Object.entries(i.labels).flatMap(([key, value]) => ['--label', `${key}=${value}`]),
      ...mounts.flatMap(([path, dest, ro]) => ['--mount', `type=bind,src=${path},dst=${dest}${ro ? ',readonly' : ''}`]),
      '--workdir=/workspace', '--entrypoint', i.argv[0], i.imageId, ...i.argv.slice(1)];
  }
  start(): Promise<JsonRpcTransport> {
    if (this.retiring || this.removed) return Promise.reject(new Error('Launch is retiring/removed, cannot be restarted'));
    if (this.startOperation) return this.startOperation;
    if (this.startAttempted || this.retirement) return Promise.reject(new Error('Launch cannot be restarted; reconcile retained ownership'));
    this.startAttempted = true;
    this.startOperation = this.launch().catch(error => { this.lastProblem = message(error); throw error; });
    return this.startOperation;
  }
  private async launch(): Promise<JsonRpcTransport> {
    this.claim();
    // Validated filesystem/argv before journaling or any daemon mutation.
    const args = this.createArgv(); await this.engine();
    this.options.journal.putIntent(this.intent as LanguageProcessIntent); this.assertIntentReadback();
    let actual = await this.options.driver.inspect(this.intent.name);
    if (actual) throw new Error('Container name already exists; use explicit journal recovery, never blind create/start');
    for (const path of [this.intent.workspaceDirectory, this.intent.bootDirectory, this.intent.stateDirectory]) assertRealDirectory(path);
    this.options.journal.assertIsolated([this.intent.workspaceDirectory, this.intent.bootDirectory, this.intent.stateDirectory]);
    let createFailure: unknown = null;
    try { const result = await this.options.driver.command(args); if (result.exitCode !== 0) createFailure = new Error('Docker create failed/unknown'); }
    catch (error) { createFailure = error; }
    // Even successful CLI stdout is NOT ownership. Unknown create is reconciled by exact read, never reissued.
    actual = await this.options.driver.inspect(this.intent.name);
    if (!actual) throw createFailure ?? new Error('Created LSP container not observed; outcome unknown');
    this.assertOwned(actual);
    if (actual.running || actual.status !== 'created') throw new Error('Fresh LSP container unexpectedly already started');
    await this.engine(); this.assertIntentReadback();
    this.options.journal.markStart(this.intent.launchId, this.hash, actual.id);
    if (!this.options.journal.hasStart(this.intent.launchId, this.hash)) throw new Error('Durable start intent missing');
    this.attachment = this.options.driver.attach(actual.id);
    this.rpcTransport = new JsonRpcTransport(this.attachment.input, this.attachment.output, {
      ...this.options.rpc, connectionId: this.intent.launchId,
      onClosed: error => { this.lastProblem = message(error); try { this.options.onTransportClosed?.(error); } catch { /* Observer cannot crash editor/process ownership. */ } },
    });
    void this.attachment.done.then(result => {
      this.rpcTransport?.close(new Error(`Docker attach closed (${result.exitCode}); actual Stop unconfirmed`));
    }, error => { this.rpcTransport?.close(new Error(`Docker attach failed: ${message(error)}; actual Stop unconfirmed`)); });
    // Start -ai may still be in flight. Never call a 'created' observation terminal after a start intent.
    const until = Date.now() + 3000;
    do {
      actual = await this.options.driver.inspect(this.intent.name);
      if (!actual) throw new Error('LSP disappeared after start; ownership retained'); this.assertOwned(actual);
      if (actual.running) {
        if (this.retiring) throw new Error('LSP retired while starting; no request authority');
        if (this.rpcTransport.closed) throw new Error('LSP transport failed during startup; retire actual process');
        return this.rpcTransport;
      }
      if (terminal(actual)) throw new Error(`LSP exited during bootstrap (${actual.exitCode}); collect before remove`);
      await delay(25);
    } while (Date.now() < until);
    throw new Error('LSP start not observed; retain ownership and reconcile, never start twice');
  }
  retire(): Promise<LanguageProcessRetirement> {
    if (this.removed) return Promise.resolve({ confirmed: true, removed: true, problem: null });
    if (this.retirement) return this.retirement;
    this.retiring = true;
    // Immediately reject all request authority; this does NOT claim the container stopped.
    this.rpcTransport?.close(new Error('Language process retiring; container Stop pending'));
    this.retirement = this.retireOnce().finally(() => { this.retirement = null; });
    return this.retirement;
  }
  private async retireOnce(): Promise<LanguageProcessRetirement> {
    let confirmed = false;
    const deadline = Date.now() + 10000;
    const bounded = async <T>(operation: () => Promise<T>): Promise<T> => {
      const remaining = deadline - Date.now(); if (remaining < 1) throw new Error('LSP retirement deadline; Stop unconfirmed/ownership retained');
      let timer: ReturnType<typeof setTimeout>;
      try { return await Promise.race([operation(), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('LSP retirement deadline; ownership retained')), remaining); })]); }
      finally { clearTimeout(timer!); }
    };
    try {
      this.claim();
      // Await a pending startup before touching its container; never race a late start/create with rm.
      if (this.startOperation) await bounded(() => this.startOperation!.then(() => {}, () => {}));
      this.rpcTransport?.close(new Error('Language process retiring; container Stop pending'));
      this.assertIntentReadback(); await bounded(() => this.engine());
      let actual = await bounded(() => this.options.driver.inspect(this.intent.name));
      let receipt = this.options.journal.readReceipt(this.intent.launchId);
      if (receipt) this.assertReceipt(receipt);
      if (!actual) {
        // Missing before collection/receipt is NOT Stop+artifact proof (unknown create/rm/external deletion).
        if (!receipt) throw new Error('LSP absent without durable terminal collection receipt; reconciliation required');
        this.finishRemoval(receipt); return { confirmed: true, removed: true, problem: null };
      }
      this.assertOwned(actual);
      if (actual.running) {
        try { await bounded(() => this.options.driver.command(['stop', '--time', '3', actual!.id], Math.max(1, Math.min(5000, deadline - Date.now())))); }
        catch { /* Only actual inspection below can confirm Stop. */ }
        actual = await bounded(() => this.options.driver.inspect(this.intent.name));
        if (!actual) throw new Error('LSP vanished before terminal collection'); this.assertOwned(actual);
      }
      // Created is removable ONLY if a durable start intent was never written.
      confirmed = terminal(actual) || (!actual.running && actual.status === 'created' && !this.options.journal.hasStart(this.intent.launchId, this.hash));
      if (!confirmed) throw new Error('PROCESS_STOP_UNCONFIRMED; retain same launch and block next process');
      if (receipt && receipt.containerId !== actual.id) throw new Error('Terminal receipt/container identity conflict');
      this.attachment?.disconnect();
      if (!receipt) {
        const logs = await bounded(() => this.options.driver.command(['logs', '--timestamps', '--tail', '2000', actual!.id]));
        if (logs.exitCode !== 0) throw new Error('LSP log collection failed; retain stopped container');
        const collection = this.options.journal.collect(this.intent as LanguageProcessIntent,
          { stdout: logs.stdout, stderr: logs.stderr, truncated: logs.truncated });
        receipt = { schemaVersion: 1, intentSha256: this.hash, containerId: actual.id, exitCode: actual.exitCode,
          stoppedUTC: new Date().toISOString(), collection };
        this.options.journal.putReceipt(this.intent.launchId, receipt);
        const readback = this.options.journal.readReceipt(this.intent.launchId);
        if (!readback || receiptHash(readback) !== receiptHash(receipt)) throw new Error('LSP terminal receipt readback mismatch');
      }
      // Durably collected before exact NON-force rm; inspect again in case ownership/engine changed.
      this.assertReceipt(receipt); await bounded(() => this.engine());
      actual = await bounded(() => this.options.driver.inspect(this.intent.name));
      if (actual) {
        this.assertOwned(actual);
        if (actual.id !== receipt.containerId || actual.running) throw new Error('LSP changed after receipt; no removal');
        try { await bounded(() => this.options.driver.command(['rm', actual!.id])); }
        catch { /* Unknown rm must reconcile by read, not be blindly repeated. */ }
        actual = await bounded(() => this.options.driver.inspect(this.intent.name));
        if (actual) { this.assertOwned(actual); throw new Error('LSP removal not confirmed; receipt retained for same-launch retry'); }
      }
      this.finishRemoval(receipt); return { confirmed: true, removed: true, problem: null };
    } catch (error) { this.lastProblem = message(error); return { confirmed, removed: false, problem: this.lastProblem }; }
  }
  private assertReceipt(receipt: LanguageProcessReceipt): void {
    if (receipt.schemaVersion !== 1 || receipt.intentSha256 !== this.hash || !/^[a-f0-9]{64}$/.test(receipt.containerId) ||
      !Number.isSafeInteger(receipt.exitCode) || !Number.isFinite(Date.parse(receipt.stoppedUTC))) throw new Error('LSP terminal receipt identity invalid');
  }
  private finishRemoval(receipt: LanguageProcessReceipt): void {
    this.options.journal.markRemoved(this.intent.launchId, receiptHash(receipt));
    this.attachment?.disconnect(); this.removed = true; this.lastProblem = null;
    if (this.admitted) this.options.admission.release(this.intent.phase, this);
  }
}
