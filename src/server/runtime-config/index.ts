/** Standalone V2 configuration. No process/host fallback; the legacy server is not wired here. */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ExecutionPort } from '../execution/ports';
import type { ExecutionView, ImageLock, ImageLockEntry, ModeReadiness, RunKind, RunProfileV2, RuntimeCatalog, RuntimeConfigV1, RuntimeProblem, RuntimeProfile } from '../../shared/runtime-v2';
import { validateCatalogImageReferences, validateImageLock, validateRuntimeCatalog, validateRuntimeConfigV1, validateSettingsV2, validateTaskForProfile } from '../../shared/validation-v2';

export interface RuntimeEnvironment { PAIRCOACH_RUNTIME_PROFILE?: string; PAIRCOACH_WORKSPACE_DIR?: string }
export interface ResolvedRuntime {
  configurationGeneration: string; configPath: string; workspaceRoot: string;
  config: RuntimeConfigV1; catalog: RuntimeCatalog; imageLock: ImageLock;
  profile: RuntimeProfile; image: ImageLockEntry; languageImage: ImageLockEntry | null;
}
/** Valid local editor inputs do not prove execution image/cache readiness. */
export interface LocalRuntimeConfiguration {
  config: RuntimeConfigV1; profile: RuntimeProfile; workspaceRoot: string;
}
export type RuntimeConfiguration = ({ configurationGeneration: string; resolved: ResolvedRuntime; problem: null } |
  { configurationGeneration: string; resolved: null; problem: RuntimeProblem }) & { local?: LocalRuntimeConfiguration };
export const runtimeProblem = (code: string, message: string, recovery: string, retryable = false): RuntimeProblem => ({ code, message, recovery, retryable });
const denied = (problem: RuntimeProblem): ModeReadiness => ({ canRun: false, problem });
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') { for (const v of Object.values(value)) freeze(v); Object.freeze(value); }
  return value;
}
function jsonFile(file: string): unknown {
  const limit = 4 * 1024 * 1024;
  const unsafe = (): never => { throw Error('Expected an unchanged bounded regular JSON file'); };
  const regular = (s: fs.BigIntStats): boolean => s.isFile() && !s.isSymbolicLink() && s.nlink > 0n && s.size >= 0n && s.size <= BigInt(limit);
  const same = (a: fs.BigIntStats, b: fs.BigIntStats): boolean => regular(b) &&
    a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.nlink === b.nlink && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
  const before = fs.lstatSync(file, { bigint: true });
  if (!regular(before)) return unsafe();
  // Optional platform flag is not the identity boundary: check path AND opened fd.
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    if (!same(before, fs.fstatSync(fd, { bigint: true }))) return unsafe();
    const bytes = Buffer.alloc(Number(before.size) + 1);
    let count = 0;
    while (count < bytes.length) {
      const n = fs.readSync(fd, bytes, count, bytes.length - count, null);
      if (n === 0) break;
      count += n;
    }
    if (BigInt(count) !== before.size || !same(before, fs.fstatSync(fd, { bigint: true })) ||
      !same(before, fs.lstatSync(file, { bigint: true }))) return unsafe();
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, count)));
  } finally { fs.closeSync(fd); }
}
/** New generation on EVERY load, including failures. Env is explicitly injected, not forwarded to processes. */
export function loadRuntimeConfiguration(options: { configPath: string; environment?: RuntimeEnvironment; explicitWorkspaceRoot?: string }): RuntimeConfiguration {
  const configurationGeneration = randomUUID();
  let local:LocalRuntimeConfiguration|undefined;
  try {
    if (!path.isAbsolute(options.configPath)) throw Error('configPath must be absolute');
    const configPath = path.normalize(options.configPath), base = path.dirname(configPath);
    const config = jsonFile(configPath);
    if (!validateRuntimeConfigV1(config)) throw Error('Invalid runtime config schema');
    const catalog = jsonFile(path.resolve(base, config.runtimeCatalog));
    if (!validateRuntimeCatalog(catalog)) throw Error('Invalid catalog');
    const profileId = options.environment?.PAIRCOACH_RUNTIME_PROFILE ?? config.activeProfile;
    const profile = catalog.profiles.find(p => p.id === profileId);
    if (!profile) return freeze({ configurationGeneration, resolved: null, problem: runtimeProblem('RUNTIME_PROFILE_UNKNOWN', 'Selected runtime profile is not in the approved catalog.', 'Select an existing profile in paircoach.runtime.json or PAIRCOACH_RUNTIME_PROFILE, then restart.') });
    const workspace = options.explicitWorkspaceRoot ?? options.environment?.PAIRCOACH_WORKSPACE_DIR ?? config.workspaceRoot;
    if (!workspace || /[\x00-\x1f\x7f]/.test(workspace)) throw Error('Invalid workspace root');
    local={config,profile,workspaceRoot:path.resolve(base,workspace)};
    const imageLock = jsonFile(path.resolve(base,config.imageLock));
    if (!validateImageLock(imageLock) || !validateCatalogImageReferences(catalog,imageLock,profile.id)) throw Error('Selected image pins or supplied tool references are invalid');
    const resolved: ResolvedRuntime = { configurationGeneration, configPath, workspaceRoot: path.resolve(base, workspace), config, catalog, imageLock,
      profile, image: imageLock.images.find(i => i.key === profile.imageLockKey)!,
      languageImage: profile.language.imageLockKey === null ? null : imageLock.images.find(i => i.key === profile.language.imageLockKey)! };
    return freeze({ configurationGeneration, resolved, problem: null, local });
  } catch {
    // Paths/config bytes may contain sensitive data. Never echo parser errors or environment values to UI.
    return freeze({ configurationGeneration, resolved: null, ...(local?{local}:{}), problem: runtimeProblem('RUNTIME_CONFIG_INVALID', 'Runtime configuration, catalog or image lock is unavailable or invalid.', 'Repair paircoach.runtime.json and its config-relative catalog/image lock. Explicitly prepare approved images, then restart. Editing and recovery remain available.') });
  }
}
/** Inject adapter/dependency/cache validation; this must inspect the current project, never return stale prepared state. */
export interface RuntimeModeProbe {
  probe(runtime: ResolvedRuntime, mode: RunKind, run: RunProfileV2): Promise<ModeReadiness>;
}
export interface RuntimeReadinessDependencies { execution: Pick<ExecutionPort, 'readiness'>; probe: RuntimeModeProbe; timeoutMs?: number }
const wellFormed = (m: ModeReadiness): boolean => !!m && typeof m.canRun === 'boolean' &&
  (m.canRun ? m.problem === null : !!m.problem && (['code','message','recovery'] as const).every(k => typeof m.problem![k] === 'string' && m.problem![k].length > 0) && typeof m.problem.retryable === 'boolean');
class ReadinessDeadlineError extends Error {}
async function bounded<T>(operation: () => Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([Promise.resolve().then(operation), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new ReadinessDeadlineError('readiness timeout')), timeoutMs); })]); }
  finally { clearTimeout(timer); }
}
/** No execution/mutation. A false mode never disables the editor. Every invocation re-probes dependency readiness. */
export async function aggregateRuntimeReadiness(configuration: RuntimeConfiguration, settings: unknown, dependencies: RuntimeReadinessDependencies): Promise<ExecutionView> {
  const selected=configuration.resolved??configuration.local;
  const runtime = { profileId: selected?.profile.id ?? null, label: selected?.profile.label ?? '',
    configurationGeneration: configuration.configurationGeneration, state: 'READY' as ExecutionView['runtime']['state'], problem: null as RuntimeProblem | null,
    taskFields: structuredClone(selected?.profile.taskFields ?? []) };
  const failBoth = (problem: RuntimeProblem, state: ExecutionView['runtime']['state']): ExecutionView => ({ runtime: { ...runtime, state, problem }, modes: { RUN_MAIN: denied(problem), RUN_TESTS: denied(problem) } });
  if (configuration.problem !== null) return failBoth(configuration.problem, 'CONFIG_ERROR');
  if (!validateSettingsV2(settings)) return failBoth(runtimeProblem('LEGACY_RUN_PROFILE_REQUIRES_MIGRATION', 'Execution requires explicitly saved V2 settings; original settings are preserved.', 'Review task selectors and explicitly save V2 settings. No commands are inferred. You can keep editing.'), 'CONFIG_ERROR');
  const resolved = configuration.resolved;
  const timeoutMs = dependencies.timeoutMs ?? resolved.config.execution.readinessTimeoutMs ?? 30000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000) throw Error('Invalid readiness timeout');
  let readiness: Awaited<ReturnType<ExecutionPort['readiness']>>;
  try {
    readiness = await bounded(() => dependencies.execution.readiness(resolved.profile, configuration.configurationGeneration), timeoutMs);
  } catch (error) {
    // The deadline covers cache/source/ownership AND engine/image observers. Its expiry
    // (or an opaque port rejection) is not evidence that the Docker daemon is off.
    return failBoth(error instanceof ReadinessDeadlineError
      ? runtimeProblem('RUNTIME_READINESS_TIMEOUT', 'Execution readiness measurement exceeded its deadline.', 'Retry current readiness. Cache, engine and image checks must complete before Run; editing remains available.', true)
      : runtimeProblem('RUNTIME_READINESS_UNAVAILABLE', 'Execution readiness could not be measured.', 'Retry current readiness and check the runtime configuration. No host fallback is used; editing remains available.', true), 'PREPARE_REQUIRED');
  }
  if (readiness?.configurationGeneration !== configuration.configurationGeneration || !wellFormed(readiness?.modes?.RUN_MAIN) || !wellFormed(readiness?.modes?.RUN_TESTS))
    return failBoth(runtimeProblem('RUNTIME_READINESS_INVALID', 'Execution readiness evidence is stale or invalid.', 'Reload the current configuration and measure readiness again. No execution is permitted from invalid evidence.', true), 'CONFIG_ERROR');
  const modes = {} as ExecutionView['modes'];
  for (const mode of ['RUN_MAIN','RUN_TESTS'] as const) {
    const run = settings.runProfiles.find(p => p.kind === mode);
    if (!run) { modes[mode] = denied(runtimeProblem('TASK_CONFIG_INVALID', 'This run mode has no approved task configuration.', 'Explicitly configure this mode in project settings.')); continue; }
    if (!validateTaskForProfile(resolved.profile, run)) { modes[mode] = denied(runtimeProblem('TASK_CONFIG_INVALID', 'Task selectors are incompatible with the active runtime.', 'Review the task entry, working directory and test selectors.')); continue; }
    if (!readiness.modes[mode].canRun) { modes[mode] = structuredClone(readiness.modes[mode]); continue; }
    try {
      const probed = await bounded(() => dependencies.probe.probe(resolved, mode, structuredClone(run)), timeoutMs);
      if (!wellFormed(probed)) throw Error('Invalid probe response');
      modes[mode] = structuredClone(probed);
    } catch { modes[mode] = denied(runtimeProblem('PREPARE_REQUIRED', 'Current project dependencies could not be confirmed ready.', 'Run explicit runtime preparation for this project and retry.', true)); }
  }
  // A failed mode must not suppress an independently ready mode. Task problems live per-mode.
  if (!Object.values(modes).some(m => m.canRun)) {
    const p = Object.values(modes).map(m => m.problem).find(p => p && ['DAEMON_UNAVAILABLE','IMAGE_MISSING','PREPARE_REQUIRED'].includes(p.code));
    if (p) { runtime.problem = p; runtime.state = p.code === 'DAEMON_UNAVAILABLE' ? 'DAEMON_OFF' : p.code === 'IMAGE_MISSING' ? 'IMAGE_MISSING' : 'PREPARE_REQUIRED'; }
  }
  return { runtime, modes };
}
