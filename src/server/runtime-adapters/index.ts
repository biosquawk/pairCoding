import { encodeSpec } from '../../../scripts/runtime-spec.mjs';
import { join } from 'node:path';
import { dependencyHash } from '../../../scripts/runtime-dependencies.mjs';
import { inspectEffectivePom } from '../../../scripts/runtime-pom.mjs';
import type { AdapterFamily, RuntimeProfile, RunProfileV2 } from '../../shared/runtime-v2';
import { validateRunProfileV2, validateRuntimeProfile } from '../../shared/validation-v2';
import type { AdapterValidation, ExecutionPlan, PlanContext, TaskRuntimeAdapter } from '../execution/ports';
import { interpretOutcome, readArtifact, type ArtifactReader } from './outcome';
export { parseJUnit } from './junit';
export { interpretOutcome, readArtifact } from './outcome';
export type { ArtifactReader } from './outcome';
export class AdapterError extends Error { constructor(public readonly code: string, message: string) { super(message); } }
export interface AdapterDependencies { readArtifact?: ArtifactReader; readPreparedFile?: ArtifactReader }
export { dependencyHash } from '../../../scripts/runtime-dependencies.mjs';
const bad = (message: string): AdapterValidation => ({ valid: false, problem: { code: 'TASK_CONFIG_INVALID', message, recovery: 'Choose explicit valid entry/test selectors in V2 settings.', retryable: false } });
const ok: AdapterValidation = { valid: true, problem: null };
// Deliberately literal paths/names. No shell, glob, flag, nodeid expression or Maven selector DSL.
const dataPath = (s: string) => s.length <= 512 && !s.startsWith('-') && !/[\x00-\x1f\x7f\\:*?![\]{}<>|"$`;&]/u.test(s) && !s.startsWith('/') && s.split('/').every(p => p && p !== '.' && p !== '..' && !p.startsWith('-'));
const testName = (s: string) => /^[A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)*(?:#[A-Za-z_$][A-Za-z0-9_$]*)?$/.test(s);
export abstract class BaseAdapter implements TaskRuntimeAdapter {
  abstract readonly family: AdapterFamily;
  constructor(protected readonly dependencies: AdapterDependencies = {}) {}
  async validate(profile: RuntimeProfile, run: RunProfileV2): Promise<AdapterValidation> {
    if (profile?.analysis?.preview && profile.adapterFamily !== 'java-maven') return bad('Preview is only a Java policy.');
    if (!validateRuntimeProfile(profile) || profile.adapterFamily !== this.family || !validateRunProfileV2(run)) return bad('Invalid profile/task or adapter family mismatch.');
    const { task } = run, { entry, tests } = task;
    if ((task.workingDirectory !== '.' && !dataPath(task.workingDirectory)) || tests.paths.some(p => !dataPath(p)) || tests.names.some(n => !testName(n))) return bad('Selectors must be literal paths/names, not flags/globs/expressions.');
    if (entry.kind === 'SCRIPT' && !dataPath(entry.path)) return bad('Invalid script selector.');
    if (this.family === 'java-maven') {
      if (!['JAVA_MAIN', 'SPRING_BOOT', 'TESTS'].includes(entry.kind) || tests.paths.length || profile.compilerRelease === null) return bad('Java requires a main class/service/tests entry and Maven names selectors (paths must be empty).');
      if (entry.kind === 'SPRING_BOOT' && ![21,27].includes(profile.compilerRelease)) return bad('Service task variant is supported only by Java21/27.');
    } else {
      if (!['SCRIPT','MODULE','TESTS'].includes(entry.kind) || profile.compilerRelease !== null) return bad('This family requires script/module/tests entry.');
      if ((this.family === 'node' || this.family === 'typescript') && entry.kind === 'MODULE') return bad('Node requires a literal script entry.');
      if (run.kind === 'RUN_TESTS' && !tests.paths.length) return bad('Tests require explicit test-source paths.');
      if (tests.names.length) return bad('Named tests are not supported for this family; select literal test sources.');
      const ext = this.family === 'typescript' ? /\.ts$/ : this.family === 'node' ? /\.(?:js|mjs|cjs)$/ : /\.py$/;
      if (entry.kind === 'SCRIPT' && !ext.test(entry.path) || tests.paths.some(p => !ext.test(p))) return bad('Source selectors do not match the profile.');
    }
    return ok;
  }
  async buildPlan(context: PlanContext, run: RunProfileV2): Promise<ExecutionPlan> {
    const valid = await this.validate(context.profile, run); if (!valid.valid) throw new AdapterError(valid.problem!.code, valid.problem!.message);
    const { profile, input, ownership, lockedImage, caches } = context;
    if (ownership.runId !== input.identity.runId || ownership.profileId !== profile.id || input.identity.profileId !== profile.id || lockedImage.key !== profile.imageLockKey || lockedImage.imageId !== ownership.imageId || !/^sha256:[a-f0-9]{64}$/.test(lockedImage.imageId) || !/^sha256:[a-f0-9]{64}$/.test(lockedImage.digest)) throw new AdapterError('PREPARE_REQUIRED','Missing/mismatched pinned image and immutable Run identity.');
    const required = ['node', ...(this.family === 'typescript' ? ['typescript'] : this.family === 'python' ? ['python','pytest'] : this.family === 'java-maven' ? ['java','javac','maven'] : [])];
    if (required.some(name => !profile.expectedTools.some(t => t.name === name)) || profile.expectedTools.some(t => !lockedImage.tools.some(actual => actual.name === t.name && actual.version === t.version))) throw new AdapterError('PREPARE_REQUIRED','Pinned tool versions missing or different.');
    if (caches.some(c => c.family !== profile.adapterFamily || !c.readOnly || !/^[a-f0-9]{64}$/.test(c.toolchainHash) || !/^[a-f0-9]{64}$/.test(c.dependencyHash)) || caches.length !== 1) throw new AdapterError('PREPARE_REQUIRED','Exactly one isolated, prepared read-only family/toolchain/dependency cache required.');
    if (caches[0].dependencyHash !== dependencyHash(input.files)) throw new AdapterError('PREPARE_REQUIRED','Dependency/config identity changed; prepare this cache again.');
    const entries = new Set(input.files.map(f => f.path));
    const file = (p: string) => run.task.workingDirectory === '.' ? p : run.task.workingDirectory + '/' + p;
    const requiredSources = [...run.task.tests.paths, ...(run.task.entry.kind === 'SCRIPT' ? [run.task.entry.path] : []), ...(this.family === 'java-maven' ? ['pom.xml'] : this.family === 'typescript' ? ['tsconfig.json'] : [])];
    if (requiredSources.some(p => !entries.has(file(p)))) throw new AdapterError('TASK_CONFIG_INVALID','Selected source/config absent from immutable input manifest.');
    if (!/^[a-f0-9]{64}$/.test(input.identity.manifestSha256)) throw new AdapterError('RUN_INPUT_CHANGED','Invalid immutable manifest identity.');
    if (this.family === 'java-maven') {
      const read = this.dependencies.readPreparedFile ?? readArtifact;
      const prepared = JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(await read(join(caches[0].directory,'dependencies-prepared.json'),65536)));
      if (prepared.family !== this.family || prepared.workingDirectory !== run.task.workingDirectory || prepared.dependencySha256 !== caches[0].dependencyHash || !Array.isArray(prepared.tools) || profile.expectedTools.some(t => !prepared.tools.some((a: {name:string;version:string}) => a.name===t.name && a.version===t.version))) throw new AdapterError('PREPARE_REQUIRED','Prepared effective model/tool identity differs from selected task.');
      try { inspectEffectivePom(new TextDecoder('utf-8',{fatal:true}).decode(await read(join(caches[0].directory,'effective-pom.xml'),4*1024*1024)),profile.compilerRelease!,profile.analysis.preview); }
      catch (error) { throw new AdapterError('TARGET_PROFILE_CONFLICT',String(error)); }
    }
    const prefix = '/cache/0'; // cache[0]: exact approved family/toolchain/dependency identity remains on plan.caches[0]
    // Legacy wire field release identifies the selected JDK; Maven alone supplies targetRelease.
    const payload = { schemaVersion: 1, family: this.family, release: profile.compilerRelease, preview: profile.analysis.preview,
      runId: ownership.runId, manifestSha256: input.identity.manifestSha256, mode: run.kind, task: run.task, cache: prefix };
    let encoded: string;
    try { encoded = encodeSpec(payload); } catch (error) { throw new AdapterError('TASK_CONFIG_INVALID',String(error)); }
    return { ownership, input, profile, lockedImage, mode: run.kind, timeoutMs: run.timeoutMs,
      command: { executable: '/opt/paircoach/node/bin/node', args: ['/opt/paircoach/runtime-task.mjs', encoded], workingDirectory: '/workspace', environment: { CI: 'true', LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', TZ: 'UTC', PYTHONDONTWRITEBYTECODE: '1' } },
      caches, resources: { memoryBytes: 2*1024**3, cpus: 2, pids: 256, logBytes: 10485760, logFiles: 1 },
      isolation: { nonRootUser: '10001:10001', capDropAll: true, noNewPrivileges: true, readOnlyRoot: true, network: run.task.entry.kind === 'SPRING_BOOT' && run.kind === 'RUN_MAIN' ? 'loopback' : 'none' },
      service: run.task.entry.kind === 'SPRING_BOOT' && run.kind === 'RUN_MAIN' ? { containerPort: run.task.entry.containerPort, healthPath: run.task.entry.healthPath, bindHost: '127.0.0.1', readinessTimeoutMs: 30000 } : null,
      artifacts: run.kind === 'RUN_TESTS' ? ['JUNIT_XML','COMPILER_DIAGNOSTICS'] : ['COMPILER_DIAGNOSTICS'] };
  }
  interpret: TaskRuntimeAdapter['interpret'] = (plan, exit, artifacts) => interpretOutcome(plan, exit, artifacts, this.dependencies.readArtifact ?? readArtifact);
}
export class NodeAdapter extends BaseAdapter { readonly family = 'node' as const; }
export class TypeScriptAdapter extends BaseAdapter { readonly family = 'typescript' as const; }
export class PythonAdapter extends BaseAdapter { readonly family = 'python' as const; }
/** A single adapter; profile/compilerRelease is DATA for all four supported JDKs. */
export class JavaMavenAdapter extends BaseAdapter { readonly family = 'java-maven' as const; }
export class TaskRuntimeAdapterRegistry {
  private readonly adapters: ReadonlyMap<AdapterFamily, TaskRuntimeAdapter>;
  constructor(adapters: readonly TaskRuntimeAdapter[]) {
    if (new Set(adapters.map(a => a.family)).size !== adapters.length) throw new AdapterError('RUNTIME_CONFIG_INVALID','Duplicate adapter family.');
    this.adapters = new Map(adapters.map(a => [a.family, a]));
  }
  get(profile: RuntimeProfile): TaskRuntimeAdapter {
    const adapter = this.adapters.get(profile.adapterFamily); if (!adapter) throw new AdapterError('RUNTIME_PROFILE_UNKNOWN','No adapter for profile family.'); return adapter;
  }
}
export function createTaskRuntimeAdapterRegistry(dependencies: AdapterDependencies = {}): TaskRuntimeAdapterRegistry {
  return new TaskRuntimeAdapterRegistry([new NodeAdapter(dependencies), new TypeScriptAdapter(dependencies), new PythonAdapter(dependencies), new JavaMavenAdapter(dependencies)]);
}
