## Lightweight policy (current)
All seven catalog profiles and regenerated templates select builtin/null/null. Public prepare,
staging and the operator plan prepare execution assets only; no language images/artifacts/readiness.
The historical language recipes below/above are inert source history, not current instructions.
Use the public flow in docs/windows-polyglot.md. Generated selectors contain one profile only;
changing target requires preparing that profile into a new output and restarting with its selectors.
Local Java/Python completion is current-document prefix words; typing diagnostics=N/A.

---

# Runtime adapter wave1 — explicit fail-closed preparation

`catalog.json` defines the seven profile IDs and neutral task fields. Only the dispatcher Node22.22.0
expected version is populated from the approved platform reference; missing compiler/test tools MUST
be added from reviewed artifact identities. This is not evidence of any runtime image version.
`images.lock.json` intentionally has no images: strict resolver rejects it, Run/Test are NOTREADY.
The read-only spike base refs in pin-status.json are NOT dispatcher/Maven/pytest images and must not
be copied into production lock as if prepared. No invented tool version/imageId/digest.

## Exact container convention (for coordinated executor integration)
- `/input`: complete immutable ACK input, read-only; no dependency/build/old reports/secrets.
- `/workspace`: executor-populated independent fresh writable COPY (never original workspace), dispatcher never recopies; `/artifacts`: fresh reports.
- ordered cache[0]: `/cache/0` read-only on Run/Test, exact family/toolchain/dependency identity retained in plan.
- plan cwd EXACT `/workspace`, child cwd `/workspace[/task.workingDirectory]`; explicit plan env is ONLY CI=true, LANG/LC_ALL=C.UTF-8, TZ=UTC, PYTHONDONTWRITEBYTECODE=1. Tool HOME/PATH are controlled inside dispatcher, not forwarded host values.
- Node dispatcher `/opt/paircoach/node/bin/node /opt/paircoach/runtime-task.mjs <base64url JSON>`.
  Canonical sorted-key compact JSON, unpadded strict base64url<=4096 ASCII. JSON has no executable/env/args fields. Adapter and container validate selectors as data.
- DockerExecutor alone constructs Docker argv. Adapter only returns ExecutionPlan, never spawns.
- No host toolchain fallback; every task tool is a fixed in-image absolute executable. `--pull=never`,
  nonroot10001, capdropALL, no-new-privileges, resource/log limits, no secrets/home/socket mounts.
- Java ONE adapter for11/17/21/27. Before plan, adapter checks the cache-bound actual prepared effective POM, exact dependency hash/task directory/tools. Selected Maven ALSO re-resolves actual effective POM offline at Run, strict release/
  source/target/preview/conflicting compiler/toolchain checks, then selected javac compile. Spring is
  entry data21/27 only. Actual image tools and compiler release must be validated before readiness.

## Explicit operator preparation (NOT_RUN here)
No worker starts Docker or executes this prepare script now. K reviews a bounded exact request first.
The utility accepts `node scripts/runtime-prepare.mjs REQUEST.json [--execute]`. Without --execute it
validates complete inventories and writes PLAN_ONLY_NOT_PREPARED to a NEW output directory; never
claim this plan is a prepared image/cache. With --execute it explicitly pulls ONLY supplied pinned
base/node refs, builds offline from approved tool files, prepares dependencies in an isolated
nonroot container and retains exact receipts. No `latest`, host npm/pip/mvn installs, private .m2,
registry credentials, arbitrary Docker flags or task commands. Failed uncertain operations retain
ownership/receipt; operator reads exact container before recovery, never blind-retries create.

Request strict keys: schemaVersion1, workingDirectory (literal relative path or .), installationId, family, key, imageTag `paircoach/runtime-*:*`,
baseImage and nodeImage `repo@sha256:<64hex>`, tools `{root,files:[{path,sha256}]}`, project same
shape, expectedTools `[{name,version}]`, dependencySha256, outputRoot (NEW absolute owned directory).
Tool inventory contains `node_modules/fast-xml-parser` and its full pinned dependency closure, plus
TypeScript when needed. No symlinks or secret/home data. All files are bounded, regular and hashed;
no package scripts/network install during image build. Python requirements must lock pytest and
all transitives with actual hashes; empty/unlocked requirements are NOT preparation.

Cache identity uses all tool pins+image refs+tool inventory and the dependency/config inventory hashed by runtime-dependencies.mjs.
Ordinary source edits reuse dependencies; pom/package/requirements/tsconfig/.mvn changes invalidate readiness. Config owner/caller must resolve the
same hashes from the settled input; stale caches are not ready. Prepared cache is RW only during
prepare, RO during Run; Maven copies it into separate `/workspace/.paircoach/runtime/m2` for locks/metadata. Package scripts
are disabled on npm prepare; Python uses --require-hashes/--only-binary. Run has network none.

Preparation checks actual tool versions against expectedTools and retains raw probes in cache tools.json.
Before publishing production images.lock: inspect exact built imageId + real OCI digest (local
imageId is NOT presumed registry digest), record actual tools from runtime-tools.mjs and compare
all expected versions, add complete expectedTools to catalog; execution image pins come from its
owner. Run actual offline task Main/Test after prepare with no registry access, prove source unchanged,
current XML, effective javac release/preview and failed/passed variants. K must review ONE bounded
operator request with exact argv/pins/source/ownership/limits/artifacts/cleanup before any live run.
The preparation receipt alone is deliberately PREPARED_REQUIRES_OFFLINE_AND_TOOL_VALIDATION.

After integration the normal packager owner adds these paths/commands; package/lock/packager are
untouched here. Runtime config selection, HTTP/Runner/settings/UI cutover are separate, not simulated.

## Reviewed production-input preparation (not readiness)
`production-inputs.lock.json` resolves immutable official linux/amd64 image manifests/configs,
regular-file npm tool inventories and real PyPI wheel hashes. Catalog expected versions derive from
those metadata; they are NOT measured actual tools. `images.lock.json` stays empty/NOTREADY until
actual image ID+manifest/descriptor digest, tools and reviewed cache/offline receipts exist. Never
substitute a local config imageId for an absent registry/OCI manifest digest.

Operator workflow, only after K reviews the exact frozen source AND plan:
1. `node scripts/runtime-operator.mjs plan ABS_PRIVATE_OPERATOR_ROOT NEW_PLAN.json` is pure:
   nine cache jobs cover seven runtime profiles and Spring21/27; includes copied fixture bytes,
   exact source/inventory hashes, explicit mounts/pins and language build recipes. No download/Docker.
2. `node scripts/runtime-stage-inputs.mjs ABS_PRIVATE_OPERATOR_ROOT` creates a NEW private owned
   root under an existing canonical parent. Downloads only exact official URLs/hash/size-bounded
   artifacts. Node stdlib only; no package install, lifecycle script or host Java/Python/TS toolchain dependency.
3. `node scripts/runtime-operator.mjs execute PLAN.json EXACT_PLAN_SHA256` refuses any source,
   pin, fixture or staged-tool difference. Max ONE heavy operation, aggregate45min, command8min;
   unknown/failure retains resources/receipts. Inspect exact ownership/state before any retry;
   never rerun a partially consumed root, use force cleanup or Docker prune.

Controlled prepare containers have network only during explicit dependency acquisition. Build uses
network=none; Run/Test fixture smoke uses no network, immutable RO input, fresh independent RW copy,
fresh artifacts and one RO dependency cache. All containers lack host socket/home/credentials. Exit,
full raw logs, image/tools and bounded artifact digests persist before exact nonforce container-ID rm.
Images/caches/inputs/evidence are retained for review; there is NO automated image/volume cleanup.
The fixtures deliberately fail, then independent corrected copies must pass with nonzero testcase
counts and no skipped tests. Smoke is Test-only, NOT Run/service/Stop/GUI/realACK authority or fullQA.

Java LSP image has server `/opt/jdk27/bin/java`, targets `/opt/jdk11`, `/opt/jdk17`,
`/opt/java/openjdk`(21), `/opt/jdk27`; exact JDT launcher/config in lock. Python LSP preinstalls
same12 frozen wheels into `/opt/pylsp`, uses `/usr/local/bin/python -m pylsp` and explicit
`PYTHONPATH=/opt/pylsp`. No startup install/fallback. Dedicated images are NOT runtime containers.
Version probes are not LSP functionality proof. Raw JDT severity/oracle/FULL5aFAIL remain unchanged.

Receipt writes use a writable exclusive handle, required file fsync, close, identity/content readback,
rename and post-publication bounded readback. Directory fsync only tolerates established unsupported
codes on actual Win32 after canonical component ancestry checks. File errors, POSIX directory errors,
unexpected errors and close/rename/read errors always propagate. Win32 metadata-directory durability
can be unavailable; confidentiality relies on operator private-parent inherited ACLs, NOT fake POSIX
chmod/0700 assertions. This is not protection against a malicious same-user host process. Final native
proof remains pending. Preparation request keys permit safe dots for the frozen `python-3.13` ID;
no shared DTO/port, executable, mount or environment grammar changed.
