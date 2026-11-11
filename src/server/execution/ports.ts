/** INTERNAL trusted contracts, never decoded from HTTP/settings/AI. No host execution fallback. */
import type { Id, Path } from '../../shared/protocol';
import type { ImageLockEntry, ModeReadiness, RunInputIdentity, RunKind, RunProfileV2, RuntimeProfile, RuntimeProblem, ToolVersion } from '../../shared/runtime-v2';
export interface ExecutionOwnership {
  installationId: Id; runId: Id; profileId: Id; engineId: string; containerName: string; imageId: string;
}
export interface InputFile { path: Path; documentVersion: number; sha256: string; bytes: number }
export interface AcknowledgedRunInput {
  projectId: Id; sessionId: Id; identity: Readonly<RunInputIdentity>; files: readonly Readonly<InputFile>[];
  /** Complete stable non-following inventory, ACK settled by WriteGate, sealed before plan. */
  immutableDirectory: string; buildDirectory: string; artifactsDirectory: string;
}
export interface ManagedDependencyCache {
  directory: string; family: RuntimeProfile['adapterFamily']; toolchainHash: string; dependencyHash: string;
  readOnly: boolean;
}
export interface ExecutionPlan {
  ownership: Readonly<ExecutionOwnership>; input: Readonly<AcknowledgedRunInput>;
  profile: Readonly<RuntimeProfile>; lockedImage: Readonly<ImageLockEntry>; mode: RunKind; timeoutMs: number;
  /** Only trusted adapter output. DockerExecutor revalidates ownership/bounds and ALONE builds docker argv, shell:false. */
  command: { executable: string; args: readonly string[]; workingDirectory: string; environment: Readonly<Record<string,string>> };
  caches: readonly Readonly<ManagedDependencyCache>[];
  resources: { memoryBytes: number; cpus: number; pids: number; logBytes: 10485760; logFiles: 1 };
  isolation: { nonRootUser: string; capDropAll: true; noNewPrivileges: true; readOnlyRoot: boolean; network: 'none' | 'loopback' };
  spring: { containerPort: number; healthPath: string; bindHost: '127.0.0.1'; readinessTimeoutMs: number } | null;
  /** Approved artifact types, not client-supplied globs/parser settings. */
  artifacts: readonly ('JUNIT_XML' | 'COMPILER_DIAGNOSTICS')[];
}
export interface ExecutionHandle { runId: Id; opaqueId: Id }
export interface ExecutionOutput { stream: 'STDOUT' | 'STDERR'; text: string }
export interface ExecutionServiceReadiness { handle: ExecutionHandle; ready: boolean; url: string | null; problem: RuntimeProblem | null }
export interface ExecutionExit { handle: ExecutionHandle; exitCode: number; exitedAt: string }
export type StopConfirmation = { confirmed: true; exit: ExecutionExit } | { confirmed: false; handle: ExecutionHandle; problem: RuntimeProblem };
export interface CollectedArtifacts {
  handle: ExecutionHandle; inputManifestSha256: string; collectionSha256: string;
  stdoutPath: string; stderrPath: string;
  files: readonly { kind: 'JUNIT_XML' | 'COMPILER_DIAGNOSTICS'; path: string; sha256: string; bytes: number; freshForRun: boolean }[];
  tools: readonly ToolVersion[];
}
declare const durableTerminalReceipt: unique symbol;
/** Minted ONLY after confirmed exit -> bounded collection -> fsynced terminal journal+digests. Not a wire receipt. */
export interface DurableTerminalReceipt {
  readonly [durableTerminalReceipt]: true;
  readonly handle: ExecutionHandle; readonly ownership: ExecutionOwnership;
  readonly exit: ExecutionExit; readonly collectionSha256: string; readonly journalSha256: string;
}
export interface OwnedOrphan {
  ownership: ExecutionOwnership; handle: ExecutionHandle;
  state: 'RUNNING' | 'EXITED' | 'UNKNOWN'; durableReceipt: DurableTerminalReceipt | null;
}
export interface ExecutionReadiness {
  configurationGeneration: Id; modes: { RUN_MAIN: ModeReadiness; RUN_TESTS: ModeReadiness };
}
/**
 * Runner owns runId/singleflight/outputSeq/tail64KiB/states/version observations/durable outcome.
 * Executor owns durable pre-create intent, exact labels/name/engine/image + uncertain-operation reconciliation.
 * Never blind retry create/stop; read actual state first. Unconfirmed Stop retains handle, blocks new Run,
 * allows same-run retry and manual editing. stop affects THIS Run only, never LSP/AI/control containers.
 */
export interface ExecutionPort {
  readiness(profile: RuntimeProfile, configurationGeneration: Id): Promise<ExecutionReadiness>;
  start(plan: ExecutionPlan): Promise<ExecutionHandle>;
  subscribe(handle: ExecutionHandle, listener: (output: ExecutionOutput) => void): () => void;
  /** Actual loopback HTTP readiness, nonterminal and distinct from process RUNNING. Null if no service. */
  serviceReadiness(handle: ExecutionHandle): Promise<ExecutionServiceReadiness | null>;
  wait(handle: ExecutionHandle, signal?: AbortSignal): Promise<ExecutionExit>;
  stop(handle: ExecutionHandle, reason: 'USER' | 'TIMEOUT' | 'RECOVERY'): Promise<StopConfirmation>;
  collect(handle: ExecutionHandle, exit: ExecutionExit): Promise<CollectedArtifacts>;
  /** Verify receipt matches retained ownership/exit/collection; exact NON-force rm only after durable outcome. */
  cleanup(receipt: DurableTerminalReceipt): Promise<void>;
  /** Installation-scoped journals+exact labels, never broad ps/prune; no foreign resource mutation. */
  inspectOwnedOrphans(installationId: Id): Promise<readonly OwnedOrphan[]>;
}
export interface AdapterValidation { valid: boolean; problem: RuntimeProblem | null }
export interface PlanContext {
  ownership: ExecutionOwnership; input: AcknowledgedRunInput; profile: RuntimeProfile;
  lockedImage: ImageLockEntry; caches: readonly ManagedDependencyCache[];
}
export interface AdapterOutcome {
  status: 'SUCCEEDED' | 'FAILED'; testOutcome: 'NOT_APPLICABLE' | 'UNKNOWN' | 'NO_TESTS' | 'PASSED' | 'FAILED';
  testCount: number | null; skipped: number | null; failures: number | null; errors: number | null; problem: RuntimeProblem | null;
}
/** Pure runtime-family boundary: no GUI/WriteGate/Veto, no Docker CLI; one data-parameterized JavaMaven adapter. */
export interface TaskRuntimeAdapter {
  readonly family: RuntimeProfile['adapterFamily'];
  validate(profile: RuntimeProfile, runProfile: RunProfileV2): Promise<AdapterValidation>;
  buildPlan(context: PlanContext, runProfile: RunProfileV2): Promise<ExecutionPlan>;
  /** Fresh current-input JUnit only; exit0 + non-skipped>0 + zero errors/failures. Missing XML UNKNOWN, zero NO_TESTS. */
  interpret(plan: ExecutionPlan, exit: ExecutionExit, artifacts: CollectedArtifacts): Promise<AdapterOutcome>;
}
