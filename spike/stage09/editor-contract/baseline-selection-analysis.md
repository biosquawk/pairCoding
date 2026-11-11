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

## Classification and minimal next correction

Evidence supports **stale synchronous test-API expectation**, not demonstrated loss of local tab
selection. It does NOT prove all snapshot races safe: K's real integration FAIL prevented the first
test's later ACK/exact-FS assertions from executing. Those assertions still need to run.

After central approval, explicit contract-alignment test change can wait using the existing `until`
helper and unchanged5000ms bound until the **same path/version VIEW_CHANGED exists and its real ACK
is delivered**, then retain all original assertions: selectedPath survives delayed snapshot, exact
created-file bytes, untouched challenge.md, no errors, slow tab cannot override latest selection,
project/session/delete/late mutation controls. Do not delete/assert-less/skip or increase limits.
Where a snapshot cancels/rebinds view, observe/wait for the current scope rather than reuse old ACK.
No product change to force an unthrottled stale view just to make the old test green.

A real post-throttle failure to send latest view/receive ACK, or activePath reverting, would instead
be a **product K1** and requires repair; wait must not hide such outcome. Keep baseline2FAIL in
risk register until corrected real HTTP/WS/FS test proves behavior. Frozen test unchanged in this A–B
candidate. Existing stage05 actualMonaco proof and editor-view tests are complementary, not a claim
that skipped later first-test branches passed.
