# A–B runtime spike, not product Runner

`runtime-spike.mjs` is dependency-free Node22+ and uses Docker CLI only. `images.lock.json` pins official linux/amd64 platform manifest digests observed via official registry metadata; metadata is not a successful image pull/tool version proof. No invented checksum, JDK downgrade, Maven27 assumption or host Java/Python fallback. No image builds necessary: the spike directly uses pinned upstream JDK/Python images with controlled security flags. The later application images/Maven/pytest/cache are NOT implemented here.

For K review→ROOT execution, see delivered operator-request.md. Modes:

```
node runtime-spike.mjs prepare ABS_NEW_PREPARE_DIRECTORY
node runtime-spike.mjs run ABS_NEW_RUN_DIRECTORY
node runtime-spike.mjs cleanup ABS_EXISTING_RUN_DIRECTORY
```

prepare: three sequential pinned pulls (180s each) and image inspect; no containers/builds. run: never pulls, requires all three local pinned images. Creates ONLY generated fixtures under new evidence directory, never mounts a student's workspace. JDK21/27 compile/run with release21/27, older-release API negative and class major verification; Python3.13 version and execution; UTF8 filename/CRLF bytes proof from RO input; hard Stop SIGTERM-ignoring owned target and independent owned control preservation. Each short run wait max45s, RPC max15s, stop10s, readiness5s. No network during containers; caps/memoryCPU/PIDs/log limits fixed. Normal probe creates five containers in total, max2 small loops concurrently. No broad cleanup, no --rm, no rm -f; logs/artifacts→persist→rm. No host toolchain execution.

Output: evidence.json journal with Docker/engine metadata, exact image IDs/digests, argv/cwd/UTC/wall/exit and raw stdout/stderr per command, per-container inspect/hash/version/release/mapping/artifacts/ownership, stop target/control IDs, durable state before removal. Compile stdout+stderr/raw negative logs are retained. Stop proof records control running BEFORE its subsequent separate owned cleanup. The output retains source fixtures and classes for review.

On error, FAIL_OR_BLOCKED (not PASS), one bounded own-resource reconciliation/stop+collect+remove attempt. Unconfirmed engine operation never becomes success. Unknown create reconciles exact name/labels/image before mutation. If daemon unavailable preserve journal; ROOT uses cleanup against the SAME run directory once daemon responds. Cleanup does not rerun failed work; exact ownership check required, reads logs/artifacts before deletion. A create intent with no existing container may require operator read-only name reconciliation; do not blindly rerun create or broaden scope. Stop/rm only probe-owned records, never external control/LSP. Never modify prior evidence or re-run prepare/run on the same output path.

```
node --check runtime-spike.mjs
node --test selftest.mjs
```

8 local construction/ownership/hash tests, NOT Docker or Java/Python execution. In a restricted role set TMPDIR to an authorized writable private tmp directory; first local test attempt found read-only /tmp and was retained as environment FAIL. No tests were skipped or weakened. Native Windows follows same harness with native Node and a native drive evidence path; WSL evidence is not native. Read PROPOSAL.md for boundaries and all deferred C–F evidence.
