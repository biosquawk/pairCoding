# P1 runtime contract proposal v1 — A–B only, NOT central approval

Base 38d5130634d0f0ac7ace4c82a77273fe7f4ef3e9. Source: K central v1 and complete ROOT GOAL/ANNEX. Scope only spike/stage09/runtime. No product imports/types/DTOs changed. K must consolidate with P2/P1_2 and ROOT approve before C. This does not narrow TEST101–107/AC101–112.

## Existing seams read

`src/server/Runner.ts`: Runner currently imports spawn, parses approved executable/args/cwd, runs host child, inventories baseline JUnit, holds run/outputSeq/singleflight/version observations and termination. Keep state/output semantics and conservative parseJUnit requirements; replace host process mechanism, not whole Runner. `src/shared/protocol.ts:RunProfile` currently exposes executable/args/cwd/timeoutMs/testReportFormat/glob; Settings.runProfiles max2. `src/server/LanguageFeatureRegistry.ts` and FE settings/client mapping are separate owners; no edits here.

## Port boundaries (proposed TypeScript shapes)

```ts
type ExecutionHandle = { runId: string; opaqueId: string }; // trusted opaque ID, never user Docker name
interface ExecutionPort {
  readiness(profileId: string): Promise<Readiness>;
  start(plan: ExecutionPlan): Promise<ExecutionHandle>;
  output(handle: ExecutionHandle, onChunk: (s: 'STDOUT'|'STDERR', bytes: Uint8Array) => void): () => void;
  wait(handle: ExecutionHandle): Promise<{ exitCode: number|null; signal: string|null }>;
  stop(handle: ExecutionHandle): Promise<{ confirmed: true; stoppedAt: string }>; // throws PROCESS_STOP_UNCONFIRMED
  collect(handle: ExecutionHandle): Promise<CollectedArtifacts>; // after confirmed terminal; bounded, no traversal/symlink
  cleanup(handle: ExecutionHandle, durableReceipt: ArtifactStateReceipt): Promise<void>;
  inspectOwnedOrphans(installationId: string): Promise<OwnedOrphan[]>;
}
interface TaskRuntimeAdapter {
  validate(config: TaskRunConfig, profile: RuntimeProfile): void;
  plan(input: ImmutableRunInput, task: TaskRunConfig, profile: RuntimeProfile, mode: RunMode): ExecutionPlan;
  interpret(exit: ExecutionExit, artifacts: CollectedArtifacts, input: ImmutableRunInput): TaskOutcome;
}
```

Runner owns runId, singleflight, run statuses, workspaceChangedDuringRun, outputSeq, tail64KiB, timeout/stop request, durable Run. Runner imports ONLY ExecutionPort/adapter registry/types; no spawn/docker/javac/mvn/pytest/Spring/image conditions. DockerExecutor alone composes bounded Docker argv and uses shell:false. ExecutionPlan is internal adapter output with allowlisted profile, input manifest identity, controlled argv, artifact policy, bounded timeout and optional loopback endpoint descriptor. Never deserialize ExecutionPlan/Docker flags from HTTP/settings/AI. DockerExecutor independently validates plan bounds/ownership.

One JavaMavenAdapter parameterized by runtime toolchain/release and task mode, not four subclasses or Java conditions in GUI. Spring is task mode of same family. Python/Node adapters similarly behind registry. Adapter owns safe entry/test invocation, exit interpretation and strict JUnit parser; Runner only generic outcome/state. Keep existing XML parser guards (DTD/entity/size/counters/real leaf cases) and tests; migration must add equivalents with Docker path, not skip host-test failures. No separate autosave or WriteGate calls in adapter.

## Config / RuntimeProfile / TaskRunConfig / RunProfile v2 proposal

```ts
type RunProfileV2 = {
  kind: 'RUN_MAIN'|'RUN_TESTS';
  taskConfig: TaskRunConfig;
  timeoutMs: number; //1000..300000 bounded centrally
};
type TaskRunConfig =
  | { family:'node'; cwd:string; entry:string; testEntry:string|null }
  | { family:'python'; cwd:string; entry:string; testPaths:string[] }
  | { family:'java-maven'; cwd:string; mainClass:string|null; mode:'main'|'spring-boot';
      testSelector:string|null; springPort:number|null; compilerRelease:11|17|21|27 };
type RuntimeProfile = {
  id: string; family:'node'|'python'|'java-maven'; adapterId:string;
  imageLockKey:string; toolchainVersion:string; // immutable lock maps to imageId+digest
  languageFeaturesKey:string|null; // independent LSP image/JVM, not runtime container
};
```

RuntimeProfile selected globally by explicit runtime config/env (GUI displays it, restart allowed), not silently by which Run button is pressed. Task family must match active profile; Java release/task pom/runtime must agree. No automatic overriding of pom or compiler release; mismatches actionable CONFIG_ERROR, not hidden --release downgrade. Java11/17/21/27 are data. Spring21/27 plus pinned Boot version in task pom/lock, not new language. Other project with different class/path works by explicit TaskRunConfig, not examples name detection. Typed entry/class/module and bounded test selector validated; no shell fragments, arbitrary executable/args/env/image/volume/Docker flag fields. Additional properties rejected at schemas and runtime. Family descriptors/field labels/validation constraints from backend capability response keep GUI neutral. P2 may propose more neutral task schema; exact discriminants are an OPEN central decision, not parallel product types.

Config schemaVersion1 is separate from Settings schema version. Paths runtimeCatalog/imageLock/workspaceRoot relative to config file's directory, never cwd. PAIRCOACH_RUNTIME_PROFILE > activeProfile; explicit GUI open > PAIRCOACH_WORKSPACE_DIR > workspaceRoot. Unknown profile/conflict/family/release/missing image/daemon disables Run/Test with errorCode+human remediation, not server start, edit, HTTP/WS, draft/snapshot/recovery. No host/mock/simulator fallback. Profile/project restart invalidates AI project context, Run eligibility/cache readiness, LanguageFeatures provider generation; stale requests cannot migrate.

### Data/API migration plan (central approval required)

- Retain `kind` semantics and max two profiles, maintain existing Run/outcome wire fields/events. Add explicit settings version e.g. `runProfileSchemaVersion:2` to canonical persisted settings and FE/BE schema. Both schemas/DTO/client/settings mapper must move together; no accepting both host and Docker forms ambiguously.
- Old executable/args settings: preserve original settings bytes as revisioned backup; display MIGRATION_REQUIRED with offending fields and editable proposed structured task config. Do NOT interpret arbitrary old commands, silently infer language by directory, or execute them. Explicit user save of valid V2 authorizes new config; staged atomic write through existing settings path/version check, preserve unrelated settings. Default JS/TS templates can propose exact known bundled command mappings only after provenance check, still visible, never a host fallback.
- Unknown versions fail closed for Run/Test, preserve readable settings/drafts. In-flight old run before upgrade must be terminal/confirmed stopped before restart/migration. Server API should return additive runtime readiness descriptor rather than HTTP500 on boot.
- Migration transactional replace with expected settings version; conflict409 does not partially save. One idempotent backup per source revision/hash; new migration on same bytes reuses receipt. Recovery restores backup via explicit UI/maintenance path, not deleting project snapshots. Rollback checkout old code + matching backed-up settings in separate copy; never destructive downgrade in place.

## Immutable ACK input vs LSP

At Run request: validate mode/profile/prepared dependency hash; settle serialized WriteGate pending writes; under workspace/gate synchronization capture acknowledged workspaceVersion, projectId and per-document version/hash. Create runId-specific bounded immutable snapshot with non-following reads; exclude .git, .paircoach, node_modules, target, caches, old reports, .env/credential names and unsafe files. Ensure source file stable identity/hash across read and entire inventory revalidation before publishing manifest. Gate lock alone is insufficient against EXTERNAL_FILE_SYNC/foreign OS mutation: any unstable identity/version/hash/inventory invalidates whole copy (`RUN_INPUT_CHANGED`); no mixed accepted input. Reuse existing snapshot/capture consistency guarantees where available, do not forward-replay old mutation auth. Bounds and external-write race tests must be explicit in C/D. After published immutable copy, release gate; subsequent edits are allowed and only set workspaceChangedDuringRun. Non-adversarial host isolation, not full malicious OS race protection.

Artifacts/build output belong to independent run directory, not original workspace nor immutable ACK tree. Never mount original sources RW. The spike demonstrates fixed generated input: RO bind, before/after hashes, Unicode/space/nonBMP filename+CRLF bytes. It does NOT establish the future WriteGate freeze implementation. LSP container uses separate mutable shadow+buffers before ACK; not this input/output/cache. No original workspace edits from ExecutionPort or LanguageFeaturesPort.

## Lifecycle / concurrency / Stop / recovery

State: QUEUED -> RUNNING -> terminal CANCELLED/TIMED_OUT/FAILED/SUCCEEDED. Stop requests serialized per runId; repeated calls inspect same exact container, not start/kill replacement. EngineID, installationId/runId/profile/name/imageID persisted before start; create intent before Docker create, then reconcile by exact name+all labels+image on unknown return before retry. Do not use global ps matching/prune.

Termination order: Docker stop/kill bounded -> inspect Docker running=false and terminal exit status -> logs + bounded artifacts/JUnit -> persist terminal state+artifact digest -> rm exact container without force. CLI disconnect/kill/exit alone never success. If daemon unreachable return PROCESS_STOP_UNCONFIRMED; retain nonterminal ownership and same runId for retry; singleflight remains blocked until reconciled (existing wire lacks explicit status, propose retain RUNNING plus lastErrorCode; P2/K decide any additive field). Endpoint must not return CANCELLED optimistically. Startup scans only exact installation labels and reconciles durable run journals, collecting artifacts before rm. No broad container removal. Stop runtime does not address LSP/trainer handles at all.

Spring: RUNNING until actual exit/confirmed stop. Optional endpoint only127.0.0.1:assigned:containerPort, actual bounded HTTP probe records ready separately, never auto-SUCCEEDED from health/log text. On Stop require both terminal Docker state and loopback unavailable; control container/LSP unaffected. Spike target ignores SIGTERM; bounded `docker stop --time=2`, inspect exit137 demonstrates actual hard stop. It creates its own independent control, checks same ID+StartedAt still running after target removed, then separately stops owned control. No claim that a real LSP was tested by P1.

## prepare/cache/JUnit/security

Prepare is explicit, sequential budget via K, pinned official artifact/digest, records effective tool versions/imageIDs. Dependency cache keyed family/toolchain/profile + dependency files hash; application managed only, no ~/.m2/pip/npm/home secrets. Invalidate on pom/package lock/requirements change; offline runs --pull=never and network disabled unless explicitly bounded Spring loopback policy requires bridge. Plan for prepare uses separate bounded prepare container and managed cache, never arbitrary task Docker flags. Full Maven/npm/pip cache proof after C/D and registry cutoff test AC107 in F. Current javac/python-only spike has NO dependency preparation/cache/JUnit claim.

Run artifacts fresh directory per runId; classes/target/JUnit excluded from ACK input, output starts empty. PASSED only parseable valid current runId/input report, real testcase count>0, count-skipped>0, zero failures/errors, exit0. exit0 without report UNKNOWN; zero cases NO_TESTS; all skipped NOT_PASSED, nonzero exit overrides green XML. Reports paths non-following/bounded, count/hash manifest persisted; old XML or wrong-input XML cannot satisfy. No manufactured success report. Extend existing parser tests, preserve frozen oracles.

Execution uses nonroot UID, cap-dropALL/no-new-privileges, read-only rootfs, controlled temporary/output RW paths, CPU/memory/PIDs, max10m/max1 log independent from UI tail. No privileged/socket/private.m2/home/auth/secretsenv. No arbitrary user Docker flags; fixed approved entrypoints. Labels unique per installation/work/profile/run. Container safety reduces accidents; NOT a complete sandbox for arbitrary malicious code.

## Required next evidence / ownership / open decisions

- P1 operator harness: JDK21/27 versions, positive compiled class major65/71, older release negative, run output, Python3.13 version/output, mount mapping, offline execution flags, confirmed hard Stop/control preservation. BLOCKED in role; ROOT must execute existing harness after K review.
- K/P2 reconcile exact RunProfileV2 discriminants/settings version/error envelope and neutral descriptors; P1_2 owns LSP server compatibility/correlation. No dependent C implementation before ROOT gate.
- C/D/F still owe JS/TS migration equivalence, all Java11/17/21/27/Maven/Boot/Python pytest cases, cache cutoff, faults, JUnit negatives, run input freeze/external race, orphan recovery, Spring endpoint/timeout, real GUI LIVE/AI/native/fresh package. Not proven by selftests or manual Docker spike. Full matrix remains intact.
