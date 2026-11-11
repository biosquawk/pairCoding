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

`prepare` verifies trusted pinned JDT archive and all Python wheel hashes, builds Java then Python sequentially without any Dockerfile RUN instructions, saves inspected image IDs. Artifact fetches / pinned base pulls are explicit prepare-only network use. JDT1.63.0 server JVM21 and target JDK27 are distinct. Python candidate pylsp1.12.2/Jedi0.19.2 pinned (no arbitrary upgrade); Pyflakes3.2 for diagnostics. `pip check` must pass inside the live Python container. The prepared image contains the complete immutable hashed wheel set; startup unpacks it offline into capped tmpfs under nonroot10001, with no dependency resolution or build. This deliberately avoids an uncapped build RUN.

`run` uses recorded exact image IDs and `--pull=never --network=none`, nonroot10001, read-only rootfs, own generated RW shadow, tmpfs, cap-drop ALL, no-new-privileges, CPU/memory/PID and log caps. No source workspace/home/.m2/socket/secrets mounts. Java sessions target27 and21 receive identical ScopedValue (final Java25 API) fixture;27 must complete and clear type-error diagnostics;21 must diagnose unavailable ScopedValue. Eclipse project compiler prefs/release and JRE container are explicit. This distinguishes tool JDK from analysis release but is not Maven execution proof (P1 owns that).

Python completion is for a custom project Calculator method; bad undefined name diagnostic, correction and rename must change completions. All full didChange buffers stay in LSP memory; fixture disk is only an owned shadow. Raw LSP frames preserve absent/present diagnostic version fields; timestamps or completion barriers are not claimed as production version correlation. See proposal for conservative immutable snapshot fence if unversioned.

RPC completion/index waits are finite, request timeouts cancel, failures stop this run (no blind retry). A bounded series of completion queries during initial indexing is not an image/build retry. Role Docker absence is not retested. Container logs/inspect and Java log are collected, stopped state confirmed, durable case summary written before exact owner+nonce rm. No `--rm`, broad prune, global settings, unrelated resource stop or Run/FE harness. Failed prepare may retain uniquely tagged images; operator removes only after evidence review, never broad prune. `run` cannot overwrite existing shadows: use a new prepare result for a reviewed rerun.

Inspect each `*-summary.json`, `*-wire.jsonl`, `*-commands.jsonl`, prepared image IDs and overall `summary.json`. FAIL and missing overall summary are not PASS. This is a small A–B CLI LSP proof only: no GUI LIVE, realAI, Run Stop, full matrix or gate approval.
