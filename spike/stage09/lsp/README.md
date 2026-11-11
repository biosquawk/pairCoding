# Bounded real LSP spike (not product C–E)

Only own Docker LSP images/containers, no host Java/Maven/Python installation or fallback. Node22+ and existing Docker CLI/daemon are platform prerequisites. K must reserve the single heavy-build slot before operator prepare. linux/amd64; no native Windows claim.

Read `LanguageFeaturesPort-proposal.md` and the delivery's `operator-request.md` before execution. Actual commands:

```sh
node --check spike/stage09/lsp/spike.mjs
node --test spike/stage09/lsp/selftest.mjs
# OUT must be a NEW absolute directory under the operator's own authorized draft.
node spike/stage09/lsp/spike.mjs prepare "$OUT" "$VERIFIED_JDT_ARCHIVE"
node spike/stage09/lsp/spike.mjs run "$OUT"
```

`prepare` verifies trusted pinned JDT archive and all Python wheel hashes, builds Java then Python sequentially without any Dockerfile RUN instructions, saves inspected image IDs. Artifact fetches / pinned base pulls are explicit prepare-only network use. JDT1.63.0 now starts with the already-pinned/copied `/opt/jdk27/bin/java` (server JVM27), independently of target JDK21/27. ROOT observed the original e44c0f3 run FAIL (transport exit13 before initialize); actual archive dependencies require JavaSE25. The original bootlog was lost, so that root cause is a hypothesis, not a proven historical diagnosis. No image/archive/wheel pins or negative assertions change. Python candidate pylsp1.12.2/Jedi0.19.2 pinned (no arbitrary upgrade); Pyflakes3.2 for diagnostics. `pip check` must pass inside the live Python container. The prepared image contains the complete immutable hashed wheel set; startup unpacks it offline into capped tmpfs under nonroot10001, with no dependency resolution or build. This deliberately avoids an uncapped build RUN.

`run` uses recorded exact image IDs and `--pull=never --network=none`, nonroot10001, read-only rootfs, own generated RW shadow, tmpfs, cap-drop ALL, no-new-privileges, CPU/memory/PID and log caps. No source workspace/home/.m2/socket/secrets mounts. Java sessions target27 and21 receive identical ScopedValue (final Java25 API) fixture;27 must complete and clear type-error diagnostics;21 must diagnose unavailable ScopedValue. Eclipse project compiler prefs/release and JRE container are explicit. This distinguishes tool JDK from analysis release but is not Maven execution proof (P1 owns that).

Python completion is for a custom project Calculator method; bad undefined name diagnostic, correction and rename must change completions. All full didChange buffers stay in LSP memory; fixture disk is only an owned shadow. Raw LSP frames preserve absent/present diagnostic version fields; timestamps or completion barriers are not claimed as production version correlation. See proposal for conservative immutable snapshot fence if unversioned.

RPC completion/index waits are finite, request timeouts cancel, failures stop this run (no blind retry). A bounded series of completion queries during initial indexing is not an image/build retry. Role Docker absence is not retested. Actual server Java and target Java/javac versions are written to the own bind before JDT launch and validated before initialize; summary distinguishes observations from expected server major27 and analysis release21/27. OSGi configuration/early logs and JVM error logs live at `/artifacts` backed by NEW `OUT/boot-java27` or `boot-java21` (not tmpfs). Only the generated shadow and this own artifact directory are mounted. No consoleLog flag/stdout version logging. After owner-verified stopped state, bounded config/log files and the shadow-backed `.metadata/.log` are read without following links and SHA256-indexed in `*-boot-artifacts.json` (8MiB/file,32MiB total,2048 entries,depth12). Missing optional workspace log is explicit, collection errors retain the container and FAIL. Container logs, artifacts manifest and durable case summary precede exact rm. Recovery uses the same bounded collector and retains containers. No `--rm`, broad prune, global settings, unrelated resource stop or Run/FE harness. Failed prepare may retain uniquely tagged images; operator removes only after evidence review, never broad prune. `run` cannot overwrite existing shadows: use a new prepare result for a reviewed rerun.

Inspect each `*-summary.json`, `*-wire.jsonl`, `*-commands.jsonl`, prepared image IDs and overall `summary.json`. FAIL and missing overall summary are not PASS. This is a small A–B CLI LSP proof only: no GUI LIVE, realAI, Run Stop, full matrix or gate approval.


## Bootstrap correction checks (no Docker execution)

`node --test spike/stage09/lsp/boot-artifacts.test.mjs` covers fixed JVM27 vs target21/27, prelaunch version evidence and rejected mismatches, durable early-boot collection when workspace log never existed, recovery repeat, and symlink/size rejection. These are synthetic filesystem/argv tests only. Existing `selftest.mjs` remains byte-identical. K must check the exact corrected candidate before requesting ONE bounded ROOT execution in a NEW evidence directory. Do not reuse old output or rerun e44c0f3.
