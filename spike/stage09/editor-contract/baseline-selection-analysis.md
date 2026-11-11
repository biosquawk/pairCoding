# Baseline two selection assertions — diagnosis, NOT a repaired test run

Base exact38d5130634d0f0ac7ace4c82a77273fe7f4ef3e9. K raw
`deliveries/_drafts/K/paircoach-seq09-ab/baseline-editor.log`:19 tests,17PASS/2FAIL.
Separate editor-view11PASS + selection-snapshot6PASS/2FAIL. FAILs at frozen
`tests/triage/selection-snapshot.test.ts:60` and`:96` remain FAIL; this analysis does not supersede them.

## Cause supported by source/history and focused diagnostic

- First test calls await mutateFile(CREATE), asserts activePath solution.py (this **passed**), then
  immediately finds sent VIEW_CHANGED; it does NOT wait for the production view throttle.
- Third test awaits latest selectFile(challenge.md), releases slower old read, asserts activePath
  challenge.md (this **passed**), then immediately inspects last VIEW_CHANGED without waiting.
- Current LiveBackend.selectFile:632–652 invalidates old observation, preserves selectionRequest /
  project/session guard, loads document, sets selectedView and activePath, calls observePathOnly
  then publish. observePathOnly:725→updateEditorView:717→EditorViewThrottleP2.schedule uses120ms
  timer. selectFile's Promise does **not** await that timer or view ACK. Snapshots/resync can cancel
  old timers; latest observation is intentionally coalesced. There is STILL automatic path-only
  fallback: missing real Monaco observer is NOT why no frame is present at those immediate asserts.
- Historical73e4d37 preserved selection by sending VIEW_CHANGED synchronously before return.
  Stage054965257 changed BOTH selectFile and post-snapshot advertisement from immediate send to
  observePathOnly (confirmed by `git diff 73e4d37 4965257 -- src/services/LiveBackend.ts`). Thus the
  timing premise of the older test changed with requested throttled/ACK-bound stage05 view contract.
- Actual service diagnostic `selection-timing-probe.mjs` imports current LiveBackend; injected
  fetch/socket deliberately avoid another integration campaign. It records activePath solution.py,
  no sent view immediately after await (~1ms), then matching version1 path-only VIEW_CHANGED after
  real120ms throttle (~163ms), with no Monaco observer. Injected ACK and no connection error.
  This is **synthetic transport**, not proof of real server ACK/FS/GUI. Raw logs are in P2 delivery.

## Current classification and binding correction (HUMAN0977ef31)

Initial P2 interpretation called this a stale synchronous test premise and proposed wait-until5000.
That hypothesis/recommendation was sent in NOTE711aedee. **ROOT explicitly rejected it** after reading
frozen scenarios and implementation: publication after awaitselectFile/mutateFile remains required;
requested cursor/selection throttling does not waive safe immediate path-only publication.
Source0977ef31-8fe2-4c14-8d68-f81878e37eef was read through END. It supersedes that interpretation.
The timing observation above remains valid; it is NOT proof that the original contract passed.

Current finding: **product K1 regression in path-only publication guarantee after awaited selection**,
not demonstrated loss of local selectedPath. Both baseline FAILs/timeouts/assertions remain byte-identical.
K's real integration FAIL prevents later first-test ACK/exact-FS assertions from executing; they remain
NOT_RUN for that failed branch. Do NOT replace immediate assertions with waits, skip them or raise limits.

After independent ROOT A–B approval, plan a narrow product correction: safely publish path-only VIEW
when selection/mutation and same-session snapshot selection reconciliation settle; retain current
project/session/selectionRequest/generation guards, documentVersion/content ACK consistency, conflict/
pending-write barrier and view singleflight ACK behavior. Preserve120ms trailing throttle for actual
cursor/selection motion. No model trigger and no DTO change required for this correction. Do not flush
old coordinates or old-scope callbacks to satisfy the test. Immediate safe path-only publication may
coexist with the subsequent actual Monaco observation; latest observed cursor/selection must still win.

Verify against the UNCHANGED real HTTP/WS/FS frozen selection test (including fresh save ACK, exact
solution.py bytes, untouched challenge.md, latest-tab race and all scope/delete/mutation controls),
plus stage05 view/chat/throttle checks. No fix or test migration is performed in this A–B readonly scope.
If baseline closure is required before gate, K must present a separate minimal authorized scope; this
proposal does not authorize it. Existing eventual publication and actualMonaco proof complement, not
replace, the old immediate guarantee or unexecuted later branches.
