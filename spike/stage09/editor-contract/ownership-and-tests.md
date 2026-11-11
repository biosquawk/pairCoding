# Proposed C–E ownership and acceptance inventory

No assignment or approval is implied. K must choose named role instances and freeze the consolidated
wire contract first; no dependent edits before ROOT A–B PASS. Every row needs its own work/execution.

| Stream | Exclusive product files after approval | Handoff |
|---|---|---|
| Central BE contract/integration | `src/shared/protocol.ts`, `openapi.json`, `ws.schema.json`, `src/server/http.ts`, `src/server/transport.ts`, schema contract tests | One owner only; neutral runtime/capability/LSP envelope and strict V2 migration. P2 sends proposals, never concurrent edits here. |
| BE runtime (P1 family) | `Runner.ts`, new ExecutionPort/DockerExecutor/TaskRuntimeAdapter/config/catalog files; `server/index.ts`; runtime/Runner tests; runtime scripts/images/examples | No FE imports. Registry status injection into neutral core agreed centrally. Commands/locks/preparation are BE data. |
| BE workspace/settings (designated P1 instance) | `WorkspaceService.ts` settings validation/persistence + injected capabilities; migration tests | No Docker/tool imports/branches in WorkspaceService; atomic legacy preservation. Avoid overlap with core runtime owner. |
| BE language (P1_2 family) | `LanguageFeatureRegistry.ts`, new `server/language/**` adapters/shadow/URI validation, LSP tests | Supplies real capabilities, URI root, effective target, diagnostics provenance and status to central wire owner. |
| FE settings/client (P2 family) | `types/paircoach.ts`, `services/liveTypes.ts`, `settingsValidation.ts`, `liveMapper.ts`, `LiveBackend.ts`, `PairCoachClient.ts`, `ProjectSettingsModal.tsx`, `HeaderBar.tsx`, `App.tsx`; unique settings/transport tests | One owner for LiveBackend and facade; exposes synchronous acceptance gate/invalidation and bridge events. Does not mix runtime commands into UI. |
| FE bridge/editor (P2_2 family if delegated) | new `services/monacoLspBridge.ts`, neutral URI/acceptance widget helpers, `EditorPanel.tsx`, unique bridge/browser tests | Consumes finalized client facade. Cannot also edit LiveBackend/App/shared protocol; conflicts to K. Coloring descriptors move out if needed; no Java/Maven branching. |
| Packaging/docs (designated BE/FE implementation role) | scripts/package-windows.mjs, allowlist/closure tests, runtime prepare docs | Must coordinate new paths after C–E; old verifier/golden/METRIC immutable. Final native/build/realAI by restored roles after9 implementation. |

BottomPanel/report/history/SafeMarkdown/bubbles are not owned by this A–B task. Do not rewrite them
for architecture demos. Current protecting tests retain original blobs; new assertions supplement,
not replace, existing tests. Legacy DTO fixtures may migrate only with explicit old→new behavior
mapping and equivalent strength (host-spawn oracle becomes matching real Docker oracle, not a skip).

## Proposed targeted checks for C/E (NOT_RUN here)

- **AC103:** static import + AST conditional check of components/App/WriteGate/SessionController/
  WorkspaceService: reject Docker/Maven/Spring/Python imports or tool-specific execution conditions;
  detect aliases/dynamic imports too. Neutral MIME syntax coloring is data, not runtime selection.
- **AC108:** actual Java/Python container server, project method after dot and Ctrl+Space, rename a
  method then old result cannot reappear; actual marker at known UTF16 position then disappears on
  correction; unversioned late publish after second change cannot create/clear current markers.
  Record pinned JDT server JVM separately from target11/17/21/27 and actual diagnostic version fields.
- **AC109:** unchanged Monaco retention/models/tabs/view-state tests, existing UndoRedo/coach/Veto/
  singleflight tests and METRIC001–004/golden; new completion primary+additional one undo group,
  one CODE_CHANGED flight; Undo/Redo each synchronize LSP. Inactive coach model, external sync,
  restore/draft recovery/create/rename/delete/close all synchronized exactly once. Separate ACK cannot
  reset model/undo or emit second save. PreACK completion sees live buffer; Run sees ACK copy only.
- **CONTROL_PREPARE race:** real opened suggestion → PREPARE receipt → press Enter BEFORE React
  paint/blue frame: zero model mutation/CODE_CHANGED, widget closed, JSON-RPC cancel seen. Repeat
  Tab, mouse click, commit-character/automatic path disabled, ownership change after provider resolve,
  stale epoch/model/reopen, Veto optimistic student and delayed response: cannot reopen or mutate.
  Public Monaco API implementation must be reviewed; synthetic `AcceptanceFence` is NOT this proof.
- **AC110:** configError/unknown profile/missing image/daemonOFF disable Run/Test with visible reason
  and recovery action; remain able to open/edit/save drafts/recover snapshots and keep HTTP/WS.
  LSP INDEXING→ON/OFF/FAILED shown independently; retry only scoped LSP; manual editor stays usable.
  PROCESS_STOP_UNCONFIRMED retains same-run retry, no phantom success/new run/LSP cancellation.
- **Migration:** exact V2 roundtrip; all legacy host-shape variations/mixed/extra keys rejected with
  preserved bytes + actionable migration; failed save/cancel keeps modal/draft; [] explicit disable;
  duplicate kinds/config-generation mismatch rejected; no shell/executable/args injection fields.
  Restart/profile21→27→Python→21 isolates models/session/AI/LSP/Run; second unrelated example uses
  task config, not directory/class detection.
- **URI:** roundtrips spaces/Polish/nonBMP/literal percent/reserved chars; cross-project/root/escape/
  devices/encoded slash rejected; UTF16 positions/CRLF and same-document atomic edits validated.
  Add real Windows drive/WSL mount/symlink/junction/case-collision tests to BE/native suite.
- **UX/accessibility:** one entry Settings→profile/config/help→prepare→Run→visible result; status text
  plus icon (not color alone), disabled reason readable even on disabled control, live polite status;
  INDEXING loading/empty candidates/error clear; keyboard suggestions+Escape+Tab/Enter+Veto,
  labels/focus restoration, no listbox steals Veto; 390×844 and1440×1000 renderproof with exactSHA.
  No installed-browser changes or browser run for this additive A–B proposal itself.

## Full requirement responsibility (none waived)

REQ101/A topology/reference inventory: ROOT/K; REQ102 ports/AC103: all C owners; REQ103 config /
RunProfile: central BE+FE; REQ104 prepare/offline/cache: runtime; REQ105 immutable ACK/Stop/JUnit/
loopback/ownership: runtime+central BE, neutral FE status; REQ106 LSP/buffers/gate: language+FE.
TEST101 JS,102 TS,103 Java11,104 Java17,105 Java21 and27,106 Spring21 and27,107 Python3.13 all
remain actual GUI LIVE F requirements, positive+negative, fresh ACK/code/input/JUnit and real results.
Java/Python real configured trainer, markers, completion rename and Veto not replaced by a mock.
AC101 host independence,102 restart isolation,103 boundaries,104 source protection,105 real JUnit,
106 confirmed Stop/control container/orphan ownership,107 prepare/offline,108 real LSP,
109 editor/METRIC preservation,110 actionable failure,111 truthful WSL/native split,
112 human instructions+fresh unpacked package remain full campaign scope. Build/native/realAI/full F
are NOT_RUN here and intentionally not conditions for completing this small P2 proposal.
