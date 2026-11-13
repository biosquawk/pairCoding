# Runner fixture LIVE — final approved lane only

These discoverable tests are **NOT_RUN**, not skipped and not proven by the UNIT transport. No default host engine, pin, credentials, prepare or image fallback exists. Unfiltered discovery without configuration fails clearly. Current implementation checks use only the explicit `^UNIT ` name pattern, not a change to npm/globs/tsconfig.

Final operator entry point (after the normal final-campaign lane is approved):

```sh
PAIRCOACH_RUNNER_LIVE_CONFIG=/absolute/approved-runner-live.json \
  "$NODE" --import tsx --test --test-name-pattern='^LIVE ' tests/execution/runner.test.ts
```

The JSON has these **measured final campaign** values (not these placeholder strings):

```json
{
  "runtime": "actual validated javascript-node RuntimeProfile OBJECT from the frozen catalog",
  "imageLock": "actual validated ImageLock OBJECT containing its ONE genuine measured image binding",
  "engineId": "actual approved Engine ID",
  "dockerExecutable": "/absolute/approved/docker",
  "dockerEnvironment": {"PATH":"/approved/path","DOCKER_CONFIG":"/absolute/empty/dedicated/docker-config"},
  "managedCacheRoot": "/absolute/private/approved/cache-root",
  "cacheDirectory": "/absolute/prepared/node-cache",
  "toolchainHash": "actual 64-hex prepared identity",
  "dependencyHash": "actual 64-hex prepared source dependency identity",
  "outputDirectory": "/absolute/approved/new/evidence-parent",
  "preparedPackage": {"path":"/absolute/original-public-prepare-project/package.json","sha256":"actual 64-hex SHA256 of those exact prepared bytes"}
}
```

Do not copy UNIT image IDs or `engine-unit`. Provision the credential-free Docker config and the **already-prepared approved Node runtime image**, containing `/opt/paircoach/node/bin/node` and `/opt/paircoach/runtime-task.mjs`, plus cache compatible with the original public-prepared package (no npm dependencies/lockfiles for this fixture). The trusted `preparedPackage` binding supplies those original package.json bytes; the fixture copies them byte-for-byte into its workspace and acknowledged immutable inventory. It neither rewrites cache dependencyHash nor edits/grafts a receipt. Missing/changed package bytes or a dependency mismatch fail visibly before task execution. All existing lifecycle/output/credential/time bounds remain unchanged. Actual runtime catalog/image/engine validation and immutable input/plan validation remain production code; no read stub or parser mock is used. Paths must be usable as Docker daemon bind sources on the final Windows/WSL topology. Windows native and WSL results are distinct; this harness does not change their mapping/settings. No pull/build is performed here. Config is trusted operator input, never HTTP/task input.

## Obligations and evidence

- STOP and TIMEOUT: preserve 5000ms/1000ms and the original 10000ms/15ms wait bounds. A separately owned real control Run lives while a parent/child/grandchild task runs. Probe all three real namespace PIDs through actual `docker exec ... process.kill(pid,0)` before Stop; retain their distinct identities. The real executor confirms exited state, collects artifacts, mints the genuine fsynced receipt and removes exact owned container. Immediately **before** rm a pass-through observer independently inspects exact ID as `exited/dead`, verifies the daemon refuses namespace entry as `not running`. Afterwards require exact-ID and name absence, and actual control inspect+exec still alive. Repeat Stop must return the same terminal status. This is container-lifecycle death proof on DockerDesktop, not fabricated host `process.kill` against unrelated WSL/native PID namespaces.
- Credential task prints exactly `CREDENTIAL_NOT_INHERITED`, never the sentinel/LEAK; setting the sentinel affects the backend environment only, not the image/task env.
- Real stdout/stderr/tail/seq/version test retains 70000-byte input, 65536 tail, 16384 max chunk, singleflight and defensive-copy oracles. V2 has no arbitrary task argv: literal shell-bearing string is also tested through real DockerCliTransport `shell:false` with only spawn intercepted in UNIT, and shell-bearing selector is rejected by the real adapter.
- Each fixture has a unique installation/name/private run root. No broad ps/prune/rm-force, no socket/home mount or target host task. `t.after` Stops only each own runner; it does **not** delete LIVE evidence. Raw timestamped CLI argv/options/replies are retained in `runner-live-evidence-*/docker.jsonl`, plus `tree-result.json`; run input, executor journal, collection and fsynced receipts remain in `runner-migration-*`. Failed cleanup is a failed test, not success.

## Explicit NOT_RUN limitations

No actual Docker/daemon/image/native/task-tree probe was performed in the developer role. LIVE code is scoped-typechecked only; successful execution is not asserted. A final approved prepared Node pin/cache/empty CLI config, real reachable daemon/bind topology and allocated lane are concrete prerequisites. The 1000ms TIMEOUT scenario deliberately retains its bound; slow startup or the frozen executor-vs-coordinator timeout race must fail visibly, not receive a larger timeout. This harness does not close full GUI/HTTP integration, AC106 orphan recovery, Java/Python/Spring, platform security, final native campaign or stage9.
