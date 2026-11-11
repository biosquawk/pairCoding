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
all expected versions, add complete expectedTools to catalog; include language image pins from its
owner. Run actual offline task Main/Test after prepare with no registry access, prove source unchanged,
current XML, effective javac release/preview and failed/passed variants. K must review ONE bounded
operator request with exact argv/pins/source/ownership/limits/artifacts/cleanup before any live run.
The preparation receipt alone is deliberately PREPARED_REQUIRES_OFFLINE_AND_TOOL_VALIDATION.

After integration the normal packager owner adds these paths/commands; package/lock/packager are
untouched here. Runtime config selection, HTTP/Runner/settings/UI cutover are separate, not simulated.
