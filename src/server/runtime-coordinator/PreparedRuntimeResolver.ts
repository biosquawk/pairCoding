/** Trusted prepare-output selection. No discovery, Docker mutation, host toolchain or receipt-only READY.
 * Producer hashing/source-inclusion policies are injected until their exact reviewed modules integrate.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { ManagedDependencyCache } from '../execution/ports';
import type { DockerTransport } from '../execution/DockerTransport';
import type { ResolvedRuntime, RuntimeModeProbe } from '../runtime-config';
import type { ImageLockEntry, ModeReadiness, RunKind, RunProfileV2, ToolVersion } from '../../shared/runtime-v2';
import { validateTaskForProfile } from '../../shared/validation-v2';
import { canonical, canonicalDirectory, readRecord, sha256 } from './storage';

export interface PreparedRuntimeResolverOptions { readonly outputRoots: readonly string[] }
export interface PreparedToolchainIdentity {
  readonly toolchainHash: string;
  readonly dispatcherFiles: readonly Readonly<{ path: string; sha256: string }>[];
}
export interface PreparedRuntimeDependencies {
  readRunSourceInventory(root: string): Promise<readonly Readonly<{ path: string; sha256: string; bytes: number }>[]>;
  dependencyHash(files: { path: string; sha256: string }[]): string;
  resolvePreparedToolchainIdentity(request: unknown): PreparedToolchainIdentity;
  /** Actual read-only engine info/image inspect, composed with approved credential-free CLI transport. */
  inspectEngine(): Promise<unknown>;
  inspectImage(imageId: string): Promise<unknown>;
}
/** Accepted transport owns absolute CLI/environment policy. This helper can only read info/image. */
export function createPreparedRuntimeInspection(transport: Pick<DockerTransport, 'run'>): Pick<PreparedRuntimeDependencies, 'inspectEngine' | 'inspectImage'> {
  const inspect = async (args: readonly string[]): Promise<unknown> => {
    const response = await transport.run(args, { timeoutMs: 3000, maxBytes: 1024 * 1024 });
    requireThat(response.exitCode === 0 && Buffer.byteLength(response.stdout, 'utf8') <= 1024 * 1024);
    return JSON.parse(response.stdout);
  };
  return {
    inspectEngine: () => inspect(['info', '--format', '{{json .}}']),
    inspectImage: imageId => {
      requireThat(digest(imageId));
      return inspect(['image', 'inspect', imageId]);
    },
  };
}
export interface PreparedRuntimeSelection {
  readonly outputRoot: string;
  /** Historical prepare provenance only. NEVER a source path/inventory for Run capture. */
  readonly preparationProjectRoot: string;
  readonly engineId: string;
  readonly image: Readonly<ImageLockEntry>;
  readonly caches: readonly Readonly<ManagedDependencyCache>[];
}
export class PreparedRuntimeError extends Error {
  readonly code = 'PREPARE_REQUIRED';
  constructor() { super('Current prepared runtime, OCI image identity, tools and dependencies could not be verified. Explicitly prepare this project and task working directory, publish the measured image lock, and select its output with --prepared-runtime. Editing remains available.'); }
}
type Obj = Record<string, unknown>;
const requireThat: (condition: unknown) => asserts condition = condition => { if (!condition) throw new PreparedRuntimeError(); };
const object = (v: unknown): Obj => { requireThat(v && typeof v === 'object' && !Array.isArray(v)); return v as Obj; };
const hex = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const digest = (v: unknown): v is string => typeof v === 'string' && /^sha256:[a-f0-9]{64}$/.test(v);
const text = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 1024 && !/[\x00-\x1f\x7f]/.test(v);
const inside = (a: string, b: string): boolean => a === b || b.startsWith(a + path.sep);
const privateRoot = (root: string): void => {
  requireThat(root !== path.parse(root).root && root !== os.homedir());
  canonicalDirectory(root);
  requireThat(process.platform === 'win32' || !(fs.lstatSync(root).mode & 0o077));
  // Win32: configured canonical parent and inherited ACL are trusted, not POSIX mode emulation.
};
const decode = (bytes: Buffer): unknown => JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
const read = (file: string, max = 4 * 1024 * 1024): { bytes: Buffer; data: Obj } => {
  const bytes = readRecord(file, max)!;
  return { bytes, data: object(decode(bytes)) };
};
function engine(value: unknown): { ID: string; ServerVersion: string; OSType: string; Architecture: string } {
  const e = object(value);
  requireThat(text(e.ID) && text(e.ServerVersion) && e.OSType === 'linux' && ['amd64', 'x86_64'].includes(String(e.Architecture)));
  return { ID: e.ID, ServerVersion: e.ServerVersion, OSType: e.OSType, Architecture: String(e.Architecture) };
}
function image(value: unknown, lock: ImageLockEntry): void {
  // CLI JSON array and a single parsed inspect object are both read-only transport results.
  const i = object(Array.isArray(value) ? (requireThat(value.length === 1), value[0]) : value);
  const config = object(i.Config);
  requireThat(digest(lock.imageId) && digest(lock.digest) && lock.digest !== lock.imageId && i.Id === lock.imageId &&
    i.Os === 'linux' && i.Architecture === 'amd64' && config.User === '10001:10001' &&
    (config.Entrypoint === null || Array.isArray(config.Entrypoint) && config.Entrypoint.length === 0));
  const descriptor = i.Descriptor ? object(i.Descriptor) : null;
  const manifestTypes = ['application/vnd.oci.image.manifest.v1+json', 'application/vnd.oci.image.index.v1+json',
    'application/vnd.docker.distribution.manifest.v2+json', 'application/vnd.docker.distribution.manifest.list.v2+json'];
  const descriptorMatch = descriptor && descriptor.digest === lock.digest && manifestTypes.includes(String(descriptor.mediaType)) && Number.isSafeInteger(descriptor.size) && Number(descriptor.size) > 0;
  const repoMatch = Array.isArray(i.RepoDigests) && i.RepoDigests.some(v => typeof v === 'string' && /^[a-z0-9]+(?:[._-][a-z0-9]+)*(?::[0-9]{1,5})?(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)*@sha256:[a-f0-9]{64}$/.test(v) && v.endsWith('@' + lock.digest));
  requireThat(descriptorMatch || repoMatch); // NEVER image config Id promoted to OCI manifest digest.
}
function tools(value: unknown, expected: readonly ToolVersion[], measured = false): void {
  requireThat(Array.isArray(value) && value.length === expected.length && expected.length > 0);
  const names = new Set<string>();
  for (const t of value) {
    const item = object(t);
    requireThat(text(item.name) && text(item.version) && !names.has(item.name) &&
      expected.some(e => e.name === item.name && e.version === item.version));
    if (measured) requireThat(typeof item.raw === 'string' && item.raw.length > 0 && item.raw.length <= 65536);
    names.add(item.name);
  }
}
function dispatcher(value: unknown): void {
  requireThat(Array.isArray(value) && value.length > 0 && value.length <= 64);
  const paths = new Set<string>();
  for (const f of value) {
    const item = object(f);
    requireThat(text(item.path) && hex(item.sha256) && !paths.has(item.path));
    paths.add(item.path);
  }
}
function freeze<T>(v: T): T {
  if (v && typeof v === 'object') { for (const value of Object.values(v)) freeze(value); Object.freeze(v); }
  return v;
}

export class PreparedRuntimeResolver implements RuntimeModeProbe {
  private readonly roots: readonly string[];
  constructor(options: PreparedRuntimeResolverOptions, private readonly dependencies: PreparedRuntimeDependencies) {
    requireThat(options && Array.isArray(options.outputRoots) && options.outputRoots.length <= 16);
    const roots = [...options.outputRoots];
    for (const root of roots) requireThat(text(root) && path.isAbsolute(root) && path.normalize(root) === root && path.resolve(root) === root && !/[,]/.test(root));
    requireThat(new Set(roots.map(r => process.platform === 'win32' ? r.toLowerCase() : r)).size === roots.length);
    for (const a of roots) for (const b of roots) if (a !== b) requireThat(!inside(a, b));
    this.roots = Object.freeze(roots);
  }
  async probe(runtime: ResolvedRuntime, mode: RunKind, run: RunProfileV2): Promise<ModeReadiness> {
    try { await this.resolve(runtime, mode, run); return { canRun: true, problem: null }; }
    catch { return { canRun: false, problem: { code: 'PREPARE_REQUIRED', message: new PreparedRuntimeError().message,
      recovery: 'Run explicit runtime preparation and select the verified output using --prepared-runtime <absolute-outputRoot>. Check the actual engine and measured OCI image lock. No host fallback is used.', retryable: true } }; }
  }
  /** Call afresh under the same WriteGate lease during capture. This does not cache previous READY. */
  async resolve(runtimeInput: ResolvedRuntime, mode: RunKind, runInput: RunProfileV2): Promise<PreparedRuntimeSelection> {
    try {
      const runtime = structuredClone(runtimeInput), run = structuredClone(runInput);
      requireThat(this.roots.length && run.kind === mode && validateTaskForProfile(runtime.profile, run));
      canonicalDirectory(runtime.workspaceRoot);
      const currentEngine = engine(await this.dependencies.inspectEngine());
      const inventory = await this.dependencies.readRunSourceInventory(runtime.workspaceRoot);
      const dependency = this.dependencies.dependencyHash(inventory.map(({ path, sha256 }) => ({ path, sha256 })));
      requireThat(hex(dependency));
      tools(runtime.image.tools, runtime.profile.expectedTools);
      const matches: PreparedRuntimeSelection[] = [];
      for (const root of this.roots) {
        privateRoot(root);
        requireThat(!inside(root, runtime.workspaceRoot) && !inside(runtime.workspaceRoot, root));
        const receiptPath = path.join(root, 'receipt.json'), receipt = read(receiptPath), r = receipt.data, request = object(r.request);
        // Unrelated valid outputs are not candidates; never select by directory/profile-name guesses.
        const project = object(request.project);
        if (request.key !== runtime.profile.id || request.workingDirectory !== run.task.workingDirectory) continue;
        // Explicit prepared output is reusable across roots only with the complete current raw
        // dependency hash + exact pins/tools/cache/engine/image proof below. Keep the historical
        // producer request untouched; a root-sensitive producer helper must fail, not be remapped.
        requireThat(text(project.root) && (path.posix.isAbsolute(project.root) || /^[A-Za-z]:[\\/]/.test(project.root) || /^\\\\[^\\]+\\[^\\]+/.test(project.root)));
        requireThat(r.schemaVersion === 1 && r.status === 'PREPARED_REQUIRES_OFFLINE_AND_TOOL_VALIDATION' &&
          request.outputRoot === root && request.family === runtime.profile.adapterFamily && request.imageTag === runtime.image.image &&
          request.dependencySha256 === dependency && r.imageId === runtime.image.imageId && canonical(engine(r.engine)) === canonical(currentEngine));
        tools(request.expectedTools, runtime.profile.expectedTools);
        // Helper validates actual installed production pins/dispatcher, NOT obsolete staged roots.
        const identity = this.dependencies.resolvePreparedToolchainIdentity(structuredClone(request));
        requireThat(hex(identity.toolchainHash) && r.toolchainHash === identity.toolchainHash);
        dispatcher(identity.dispatcherFiles); dispatcher(r.dispatcherFiles);
        requireThat(canonical(r.dispatcherFiles) === canonical(identity.dispatcherFiles));
        image(r.imageInspect, runtime.image);
        const observedImage = object(r.imageInspect);
        requireThat(canonical(r.observedImage) === canonical({ Id: observedImage.Id, RepoDigests: observedImage.RepoDigests ?? [], Descriptor: observedImage.Descriptor ?? null }));
        image(await this.dependencies.inspectImage(runtime.image.imageId), runtime.image);
        const container = object(r.container), state = object(container.State), config = object(container.Config), labels = object(config.Labels);
        requireThat(hex(container.Id) && state.Running === false && state.ExitCode === 0 && config.Image === runtime.image.imageId &&
          text(request.installationId) && labels['paircoach.installation'] === request.installationId && labels['paircoach.role'] === 'prepare');
        const directory = path.join(root, 'cache', runtime.profile.adapterFamily, identity.toolchainHash, dependency);
        canonicalDirectory(directory);
        const toolPath = path.join(directory, 'tools.json'), preparedPath = path.join(directory, 'dependencies-prepared.json');
        const toolBytes = readRecord(toolPath, 128 * 1024)!, prepared = read(preparedPath, 256 * 1024);
        const actualTools = decode(toolBytes);
        const cacheEvidence = object(r.cacheEvidence), toolEvidence = object(cacheEvidence.tools), dependencyEvidence = object(cacheEvidence.dependencies);
        requireThat(cacheEvidence.root === directory && toolEvidence.path === 'tools.json' && dependencyEvidence.path === 'dependencies-prepared.json' &&
          toolEvidence.sha256 === sha256(toolBytes) && dependencyEvidence.sha256 === sha256(prepared.bytes) &&
          canonical(toolEvidence.actual) === canonical(actualTools) && canonical(dependencyEvidence.actual) === canonical(prepared.data));
        tools(actualTools, runtime.profile.expectedTools, true);
        const p = prepared.data;
        requireThat(p.family === request.family && p.workingDirectory === request.workingDirectory && p.dependencySha256 === dependency &&
          typeof p.preparedAt === 'string' && Number.isFinite(Date.parse(p.preparedAt)) && canonical(p.tools) === canonical(actualTools));
        // Fence all awaited observers before publishing trusted identities. Source edits may reuse dependencies.
        requireThat(canonical(engine(await this.dependencies.inspectEngine())) === canonical(currentEngine));
        image(await this.dependencies.inspectImage(runtime.image.imageId), runtime.image);
        const after = await this.dependencies.readRunSourceInventory(runtime.workspaceRoot);
        requireThat(this.dependencies.dependencyHash(after.map(({ path, sha256 }) => ({ path, sha256 }))) === dependency);
        const finalIdentity = this.dependencies.resolvePreparedToolchainIdentity(structuredClone(request));
        requireThat(canonical(finalIdentity) === canonical(identity) &&
          sha256(readRecord(receiptPath, 4 * 1024 * 1024)!) === sha256(receipt.bytes) &&
          readRecord(toolPath, 128 * 1024)!.equals(toolBytes) && readRecord(preparedPath, 256 * 1024)!.equals(prepared.bytes));
        privateRoot(root); canonicalDirectory(directory);
        matches.push({ outputRoot: root, preparationProjectRoot: project.root, engineId: currentEngine.ID, image: structuredClone(runtime.image), caches: [{ directory,
          family: runtime.profile.adapterFamily, toolchainHash: identity.toolchainHash, dependencyHash: dependency, readOnly: true }] });
      }
      requireThat(matches.length === 1); // Multiple matching outputs are ambiguous even if their hashes agree.
      return freeze(matches[0]);
    } catch { throw new PreparedRuntimeError(); } // No private parser/path/daemon stderr in public problem.
  }
}
