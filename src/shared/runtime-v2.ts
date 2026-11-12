/** Stage09 frozen contracts. Additive foundation, NOT an adapter to legacy host RunProfile. */
import type { Id, Path, Run, Settings } from './protocol';
export type RunKind = 'RUN_MAIN' | 'RUN_TESTS';
export type TaskEntry =
  | { kind: 'SCRIPT'; path: Path }
  | { kind: 'MODULE'; name: string }
  | { kind: 'JAVA_MAIN'; className: string }
  | { kind: 'SPRING_BOOT'; containerPort: number; healthPath: string }
  | { kind: 'TESTS' };
export interface TaskRunConfig {
  workingDirectory: '.' | Path;
  entry: TaskEntry;
  /** Selectors are data. Adapter validates profile-specific combinations before planning. */
  tests: { paths: Path[]; names: string[] };
}
export interface RunProfileV2 { kind: RunKind; task: TaskRunConfig; timeoutMs: number }
export interface SettingsV2 extends Omit<Settings, 'runProfiles'> {
  schemaVersion: 2;
  runProfiles: RunProfileV2[]; // max2 unique kinds; [] disables execution
}
export interface RuntimeConfigV1 {
  schemaVersion: 1;
  activeProfile: Id;
  workspaceRoot: string;
  runtimeCatalog: string;
  imageLock: string;
  languageFeatures: { completion: boolean; diagnostics: boolean };
  execution: { backend: 'docker'; pullPolicy: 'never'; readinessTimeoutMs?: number };
}
export type AdapterFamily = 'node' | 'typescript' | 'python' | 'java-maven';
export interface ToolVersion { name: string; version: string }
export type JavaRelease = 11 | 17 | 21 | 27;
export interface RuntimeProfile {
  id: Id; label: string; adapterFamily: AdapterFamily; imageLockKey: Id;
  expectedTools: ToolVersion[];
  /** Null for non-Java. Legacy name: selected container JDK identity, not Maven targetRelease.
   * Maven target comes from the validated POM and is never silently rewritten. */
  compilerRelease: JavaRelease | null;
  analysis: { languageLevel: string; preview: boolean };
  language: { provider: 'builtin' | 'jdt' | 'pylsp' | 'off'; imageLockKey: Id | null; serverJvm: string | null };
  taskFields: TaskField[];
}
export interface RuntimeCatalog { schemaVersion: 1; profiles: RuntimeProfile[] }
export interface ImageLockEntry {
  key: Id; image: string; imageId: string; digest: string; tools: ToolVersion[];
}
export interface ImageLock { schemaVersion: 1; images: ImageLockEntry[] }
export const TASK_FIELD_KEYS = [
  'workingDirectory', 'entry.kind', 'entry.path', 'entry.name', 'entry.className',
  'entry.containerPort', 'entry.healthPath', 'tests.paths', 'tests.names', 'timeoutMs',
] as const;
export type TaskFieldKey = typeof TASK_FIELD_KEYS[number];
/** These are exact allowlisted keys, NOT arbitrary dotted paths to write into an object. */
export interface TaskField {
  key: TaskFieldKey; label: string; help: string; required: boolean;
  input: 'TEXT' | 'PATH' | 'INTEGER' | 'CHOICE';
  choices: { value: string; label: string }[];
  min: number | null; max: number | null;
}
export interface RuntimeProblem { code: string; message: string; recovery: string; retryable: boolean }
export type RuntimeReadinessState = 'READY' | 'CONFIG_ERROR' | 'DAEMON_OFF' | 'IMAGE_MISSING' | 'PREPARE_REQUIRED';
export interface ModeReadiness { canRun: boolean; problem: RuntimeProblem | null }
export interface RuntimeView {
  profileId: Id | null; label: string; configurationGeneration: Id;
  state: RuntimeReadinessState; problem: RuntimeProblem | null; taskFields: TaskField[];
}
export interface ExecutionView {
  runtime: RuntimeView;
  modes: { RUN_MAIN: ModeReadiness; RUN_TESTS: ModeReadiness };
}
export interface RunRequestV2 {
  requestId: Id; clientId: Id; sessionId: Id; expectedWorkspaceVersion: number;
  mode: RunKind; configurationGeneration: Id;
}
export interface UpdateSettingsRequestV2 {
  requestId: Id; clientId: Id; sessionId: Id; expectedWorkspaceVersion: number; settings: SettingsV2;
}
export type RunStatusV2 = Run['status'] | 'STOPPING' | 'PROCESS_STOP_UNCONFIRMED';
export interface RunV2 extends Omit<Run, 'status'> {
  status: RunStatusV2;
  profileId: Id; configurationGeneration: Id;
  processProblem: RuntimeProblem | null;
  serviceReadiness: { ready: boolean; url: string | null } | null;
}
export interface RunInputIdentity {
  runId: Id; profileId: Id; configurationGeneration: Id;
  workspaceVersion: number; manifestSha256: string;
}
export const RUNTIME_ERROR_CODES = [
  'LEGACY_RUN_PROFILE_REQUIRES_MIGRATION', 'CONFIGURATION_STALE', 'RUNTIME_CONFIG_INVALID',
  'RUNTIME_PROFILE_UNKNOWN', 'IMAGE_MISSING', 'DAEMON_UNAVAILABLE', 'PREPARE_REQUIRED',
  'TASK_CONFIG_INVALID', 'TARGET_PROFILE_CONFLICT', 'RUN_INPUT_CHANGED', 'PROCESS_STOP_UNCONFIRMED',
] as const;
/** Replacement project/session shape at migration cutover; old host DTO remains unmodified until then. */
export interface CapabilitiesV2 {
  execution: ExecutionView;
  language: import('./language-v2').LanguageView;
}
export interface ProjectV2 extends Omit<import('./protocol').Project, 'settings' | 'capabilities'> {
  settings: SettingsV2; capabilities: CapabilitiesV2;
}
export interface SessionBundleV2 extends Omit<import('./protocol').SessionBundle, 'project' | 'lastRun'> {
  languageBootstrap: import('./language-authority-v2').LanguageBootstrapV2 | null;
  project: ProjectV2; lastRun: RunV2 | null;
}
