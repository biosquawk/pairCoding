/** Nonpersisted ProjectV2 form is NEVER settings/readiness/Run/language authority. K030a03f8. */
import type { SettingsV2Store, SettingsReadResult } from '../settings-v2';
import type { WorkspaceService } from '../WorkspaceService';
import type { RuntimeConfiguration, RuntimeReadinessDependencies } from '../runtime-config';
import { aggregateRuntimeReadiness } from '../runtime-config';
import type { ExecutionView, ProjectV2, SettingsV2 } from '../../shared/runtime-v2';
import type { LanguageView } from '../../shared/language-v2';
import { validateLanguageView, validateSettingsV2, validateV2WireShape } from '../../shared/validation-v2';
import { AppError } from '../errors';
import { readRecord, sha256 } from './storage';

type Core = { workspace: WorkspaceService; settingsStore: SettingsV2Store };
export interface RuntimeProjectSettings {
  /** SOLE authority, including settings:null and original migration problem/hash. */
  readonly source: SettingsReadResult;
  /** Required DTO/editor form ONLY; validation does not grant execution/consent/persistence. */
  readonly form: SettingsV2;
}
const changed = (): never => { throw new AppError(409, 'PROJECT_STATE_CHANGED', 'Project or settings changed during the read. Preserve drafts and request current state.'); };
/** Read-only projection of source-hash-bound nonexecution fields. Never parse/guess old commands. */
export function readRuntimeProjectSettings(core: Core): RuntimeProjectSettings {
  const source = core.settingsStore.read();
  if (source.settings !== null) return { source, form: structuredClone(source.settings) };
  const form: SettingsV2 = { schemaVersion: 2, taskFilePath: null, taskMode: 'IMPLEMENTATION', reviewNotesPath: 'review.md',
    runProfiles: [], aiConsent: false, contextPatterns: [] };
  if (source.exists) {
    const bytes = readRecord(core.settingsStore.settingsPath, 4 * 1024 * 1024)!;
    if (sha256(bytes) !== source.sourceSha256) return changed();
    let object: unknown;
    try { object = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
    catch { object = null; } // Malformed raw is retained; neutral IN-MEMORY fields, not repair/save.
    if (object && typeof object === 'object' && !Array.isArray(object)) {
      // Use the actual shared field semantics instead of inventing a path/settings validator.
      for (const key of ['taskFilePath', 'taskMode', 'reviewNotesPath', 'aiConsent', 'contextPatterns'] as const) {
        if (!Object.hasOwn(object, key)) continue;
        const candidate = { ...form, [key]: (object as Record<string, unknown>)[key] };
        if (validateSettingsV2(candidate)) Object.assign(form, { [key]: structuredClone(candidate[key]) });
      }
    }
  }
  const after = core.settingsStore.read();
  if (after.sourceSha256 !== source.sourceSha256 || after.kind !== source.kind || after.exists !== source.exists) return changed();
  return { source, form };
}
/** Construction/save application to the neutral legacy policy core; never V2 tasks→host profiles. */
export function applyRuntimeSettingsMetadata(workspace: WorkspaceService, form: SettingsV2): void {
  const { schemaVersion: _version, runProfiles: _profiles, ...metadata } = form;
  workspace.settings = { ...structuredClone(metadata), runProfiles: [] };
}
/** Coherent read for the actual HTTP/WS coordinator. Readiness always consumes Store.settings,
 * NOT form/project.settings. Editor-only reads never call runtime ports or grant Run.
 * Caller supplies the actual language authority, never a READY stub.
 */
export async function readRuntimeProject(options: {
  core: Core;
  sessionId: string;
  configuration: RuntimeConfiguration;
  readiness: RuntimeReadinessDependencies;
  /** Omit for an actual measurement; false is a nonauthoritative editor projection. */
  measureReadiness?: boolean;
  readLanguage(): LanguageView;
  assertCurrent(): void;
}): Promise<ProjectV2> {
  options.assertCurrent();
  const { core, configuration } = options, before = readRuntimeProjectSettings(core), version = core.workspace.workspaceVersion;
  let execution: ExecutionView;
  if (options.measureReadiness !== false || configuration.problem !== null || before.source.settings === null) {
    // Configuration/settings errors are synchronous in the existing aggregator (zero ports).
    execution = await aggregateRuntimeReadiness(configuration, before.source.settings, options.readiness);
  } else {
    const selected = configuration.resolved;
    const problem = { code: 'RUNTIME_READINESS_PENDING', message: 'Execution readiness has not been measured for this editor snapshot.',
      recovery: 'Keep editing. The connected session will receive the actual runtime readiness separately.', retryable: true };
    execution = { runtime: { profileId: selected?.profile.id ?? null, label: selected?.profile.label ?? '',
      configurationGeneration: configuration.configurationGeneration, taskFields: structuredClone(selected?.profile.taskFields ?? []),
      state: 'PREPARE_REQUIRED', problem },
      modes: { RUN_MAIN: { canRun: false, problem }, RUN_TESTS: { canRun: false, problem } } };
  }
  options.assertCurrent();
  const after = core.settingsStore.read();
  if (core.workspace.workspaceVersion !== version || after.sourceSha256 !== before.source.sourceSha256 || after.kind !== before.source.kind) return changed();
  const language = structuredClone(options.readLanguage());
  if (!validateLanguageView(language) || language.projectId !== core.workspace.projectId ||
      language.configurationGeneration !== configuration.configurationGeneration ||
      configuration.resolved && language.profileId !== configuration.resolved.profile.id) return changed();
  if (before.source.settings === null) {
    // A shape-valid form cannot hide migration even when another runtime problem also exists.
    const problem = before.source.problem!;
    execution.runtime.state = 'CONFIG_ERROR'; execution.runtime.problem = structuredClone(problem);
    execution.modes = { RUN_MAIN: { canRun: false, problem: structuredClone(problem) }, RUN_TESTS: { canRun: false, problem: structuredClone(problem) } };
    language.state = 'OFF'; language.autocomplete = 'OFF'; language.problem = structuredClone(problem);
  }
  const project: ProjectV2 = { projectId: core.workspace.projectId, sessionId: options.sessionId,
    rootPath: core.workspace.rootPath, workspaceVersion: version, files: core.workspace.listFiles(),
    settings: before.form, capabilities: { execution, language } };
  if (!validateV2WireShape('Project', project)) throw Error('Actual V2 project does not match the frozen transport contract');
  return project;
}
