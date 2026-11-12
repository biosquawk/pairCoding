import { TASK_FIELD_KEYS } from './runtime-v2';
import { array, bool, directory, enumeration, hash, id, integer, nullable, object, path, problem, string } from './schema-v2';
export const TaskEntrySchema = { oneOf: [
  object({ kind: { const: 'SCRIPT' }, path }),
  object({ kind: { const: 'MODULE' }, name: { ...string(256), pattern: '^[A-Za-z_][A-Za-z0-9_]*(?:\\.[A-Za-z_][A-Za-z0-9_]*)*$' } }),
  object({ kind: { const: 'JAVA_MAIN' }, className: { ...string(256), pattern: '^[A-Za-z_$][A-Za-z0-9_$]*(?:\\.[A-Za-z_$][A-Za-z0-9_$]*)*$' } }),
  object({ kind: { const: 'SPRING_BOOT' }, containerPort: integer(1,65535), healthPath: { ...string(1024), pattern: '^/(?!/)[^\\s?#\\\\]*$' } }),
  object({ kind: { const: 'TESTS' } }),
] };
export const TaskRunConfigSchema = object({
  workingDirectory: directory, entry: TaskEntrySchema,
  tests: object({ paths: { ...array(path,100), uniqueItems: true }, names: { ...array({ ...string(256), pattern: '^[^\\u0000-\\u001f\\u007f]+$' },100), uniqueItems: true } }),
});
export const RunProfileV2Schema = {
  ...object({ kind: enumeration('RUN_MAIN','RUN_TESTS'), task: TaskRunConfigSchema, timeoutMs: integer(1000,300000) }),
  not: { type: 'object', properties: {
    kind: { const: 'RUN_MAIN' },
    task: { type: 'object', properties: { entry: { type: 'object', properties: { kind: { const: 'TESTS' } }, required: ['kind'] } }, required: ['entry'] },
  }, required: ['kind','task'] },
};
const runProfiles = {
  ...array(RunProfileV2Schema,2),
  allOf: ['RUN_MAIN','RUN_TESTS'].map(kind=>({
    contains: { type: 'object', properties: { kind: { const: kind } }, required: ['kind'] }, minContains: 0, maxContains: 1,
  })),
};
export const SettingsV2Schema = object({
  schemaVersion: { const: 2 }, taskFilePath: nullable(path), taskMode: enumeration('IMPLEMENTATION','CODE_REVIEW'),
  reviewNotesPath: path, runProfiles, aiConsent: bool,
  contextPatterns: array(string(1024),100),
});
// These backend configuration file paths may be absolute; they resolve against config file, never task input/cwd.
const configPath = { ...string(4096), pattern: '^[^\\u0000-\\u001f\\u007f]+$' };
export const RuntimeConfigV1Schema = object({
  schemaVersion: { const: 1 }, activeProfile: id, workspaceRoot: configPath, runtimeCatalog: configPath, imageLock: configPath,
  languageFeatures: object({ completion: bool, diagnostics: bool }),
  execution: object({ backend: { const: 'docker' }, pullPolicy: { const: 'never' } }),
});
export const TaskFieldSchema = object({
  key: enumeration(...TASK_FIELD_KEYS), label: string(160), help: string(1024,0), required: bool,
  input: enumeration('TEXT','PATH','INTEGER','CHOICE'),
  choices: array(object({ value: string(256), label: string(160) }),32), min: nullable(integer()), max: nullable(integer()),
});
const tools = array(object({ name: { ...string(64), pattern: '^[a-z][a-z0-9._-]*$' }, version: string(256) }),16,1);
export const RuntimeProfileSchema = object({
  id, label: string(160), adapterFamily: enumeration('node','typescript','python','java-maven'), imageLockKey: id,
  expectedTools: tools, compilerRelease: nullable(enumeration(11,17,21,27)),
  analysis: object({ languageLevel: string(64), preview: bool }),
  language: object({ provider: enumeration('builtin','jdt','pylsp','off'), imageLockKey: nullable(id), serverJvm: nullable(string(256)) }),
  taskFields: array(TaskFieldSchema,10),
});
export const RuntimeCatalogSchema = object({ schemaVersion: { const: 1 }, profiles: array(RuntimeProfileSchema,32,1) });
export const ImageLockSchema = object({ schemaVersion: { const: 1 }, images: array(object({
  key: id, image: { ...string(256), pattern: '^[a-z0-9][a-z0-9._/:@-]*$' },
  imageId: { type: 'string', pattern: '^sha256:[a-f0-9]{64}$' }, digest: { type: 'string', pattern: '^sha256:[a-f0-9]{64}$' }, tools,
}),64,1) });
export const ModeReadinessSchema = object({ canRun: bool, problem: nullable(problem) });
export const RuntimeViewSchema = object({
  profileId: nullable(id), label: string(160,0), configurationGeneration: id,
  state: enumeration('READY','CONFIG_ERROR','DAEMON_OFF','IMAGE_MISSING','PREPARE_REQUIRED'),
  problem: nullable(problem), taskFields: array(TaskFieldSchema,10),
});
export const ExecutionViewSchema = object({ runtime: RuntimeViewSchema, modes: object({ RUN_MAIN: ModeReadinessSchema, RUN_TESTS: ModeReadinessSchema }) });
const request = { requestId: id, clientId: id, sessionId: id, expectedWorkspaceVersion: integer() };
export const RunRequestV2Schema = object({ ...request, mode: enumeration('RUN_MAIN','RUN_TESTS'), configurationGeneration: id });
export const UpdateSettingsRequestV2Schema = object({ ...request, settings: SettingsV2Schema });
export const RunInputIdentitySchema = object({ runId: id, profileId: id, configurationGeneration: id, workspaceVersion: integer(), manifestSha256: hash });
const date = { ...string(64), format: 'date-time' };
export const RunV2Schema = object({
  runId: id, mode: enumeration('RUN_MAIN','RUN_TESTS'),
  status: enumeration('QUEUED','RUNNING','STOPPING','PROCESS_STOP_UNCONFIRMED','SUCCEEDED','FAILED','CANCELLED','TIMED_OUT'),
  exitCode: nullable(integer(-2147483648,2147483647)), workspaceVersionAtStart: integer(), workspaceChangedDuringRun: bool,
  testOutcome: enumeration('NOT_APPLICABLE','UNKNOWN','NO_TESTS','PASSED','FAILED'), testCount: nullable(integer()),
  outputTail: string(65536,0), outputTruncated: bool, startedAt: nullable(date), finishedAt: nullable(date),
  profileId: id, configurationGeneration: id, processProblem: nullable(problem),
  serviceReadiness: nullable(object({ ready: bool, url: nullable({ ...string(2048), pattern: '^http://127\\.0\\.0\\.1:[0-9]{1,5}/' }) })),
});
