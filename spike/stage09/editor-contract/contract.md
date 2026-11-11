# FE ↔ BE proposal v2 (A–B only; verified ACK-only rebind revision)

## 1. Current product read-only findings at base38d5130

| Locator | Observed behavior and migration consequence |
|---|---|
| `src/shared/protocol.ts:44`, `src/shared/openapi.json`, `src/shared/ws.schema.json` | RunProfile is host `executable/args/cwd/timeout/report` data; Document is LF content plus disk EOL/BOM metadata; wire positions are 1-based UTF16. Both schema definitions must migrate together. |
| `src/server/Runner.ts:15,50,165`, `src/server/http.ts:397` | Approved host command runs in Runner; HTTP chooses profile by mode. New path must be mode→approved task→ExecutionPort, never retained host fallback. |
| `src/server/WorkspaceService.ts:375,380` | Settings validation and capabilities currently own old profile shape. Validation stays neutral; capabilities resolved through injected registry/runtime status, not tool commands/imports in WorkspaceService. |
| `src/server/LanguageFeatureRegistry.ts` | Reports NOT_INSTALLED, not real LSP. C/E must replace stub, not merely report ON. |
| `src/services/settingsValidation.ts`, `liveMapper.ts:6`, `LiveBackend.ts:945` | Strict old JSON parser, command display, old settings write-through. All need same explicit V2 transaction. Never parse display command into execution. |
| `src/components/ProjectSettingsModal.tsx:209` | Human is currently told to choose local executable/args. Remove that instruction/example in C, retain AI consent/context/draft data. |
| `src/components/EditorPanel.tsx` | One editor, models per URI, undo/view-state retention, direct coach model operations guarded by synchronous client state; external/snapshot setValue guarded against CODE_CHANGED; suggestions OFF. Existing extension→Monaco syntax IDs are coloring, not runtime adapter selection. Neutral bridge must not introduce Java/Docker conditionals here. |
| `src/services/LiveBackend.ts:413,573,601` | CONTROL_PREPARE sets preparing then eventual publish locks editor; CODE_CHANGED is 150ms throttled singleflight; coach mutation sends STEP_RENDERED, not CODE_CHANGED. Need immediate suggestion gate invalidation BEFORE flush/await/React render. |
| `src/services/LiveBackend.ts:613`, `src/services/editorViewP2.ts` | Veto invalidates coach intervention and keeps optimistic student draft; versioned view throttling has its own ACK. Do not repurpose view ACK as document/LSP ACK. |
| `src/components/HeaderBar.tsx`, `src/types/paircoach.ts` | Plugin enum lacks INDEXING; Run status lacks STOPPING/PROCESS_STOP_UNCONFIRMED. Add neutral statuses/reasons, not language tests. |

`paircoach.config.json` is existing Codex config: **do not overwrite it** with the separate
`paircoach.runtime.json`. Stage08 documentation/toolchain is not runtime preparation evidence.

Current baseline2FAIL are a **path-only publication K1**, not permission to migrate frozen assertions:
HUMAN0977ef31 requires a later narrow product correction after ROOT A–B gate, preserving guards and
120ms cursor/selection throttle. See `baseline-selection-analysis.md`; no product fix in this candidate.

## 2. RunProfile migration / exact proposed DTO boundary

`dto-proposal.d.ts` is the normative shape of THIS proposal, pending K consolidation with P1.
RuntimeProfile is backend-owned catalog data (id/adapter/imageLock/LSP/tools); GUI gets RuntimeView,
not selectable arbitrary executable/image arguments. Global `paircoach.runtime.json.schemaVersion=1`
is DISTINCT from proposed project `Settings.schemaVersion=2`. Project settings persist only
RunProfileV2 task data. Spring is TaskEntry.kind=SPRING_BOOT in the single Java/Maven family.
Two kinds maximum, unique; `[]` disables Run/Test explicitly. Backend validates entry-kind compatibility
with selected runtime and returns typed descriptors. UI renders TEXT/PATH/INTEGER/CHOICE fields by
neutral `input`, never `if java/python/spring`. Descriptor keys map to centrally allowlisted task
field paths; reject prototype keys/arbitrary dotted paths instead of assigning untrusted object paths. Task selectors never allow flags/shell/env bypass;
server validates exact keys, safe paths, name grammar, max counts/lengths and permitted task modes.

Run Main/Tests still POST `/api/run` with existing command/session/idempotency fields and mode,
plus `configurationGeneration`; **no command/image/user Docker args**. Server freezes current
approved config and immutable ACK input; returns Run plus RunInputIdentity. Run status proposal adds
STOPPING and PROCESS_STOP_UNCONFIRMED: latter retains Stop retry for SAME runId, blocks new Run,
not editable-state lock. Tail/outputSeq semantics stay. Stop→confirmed exit→logs/JUnit→durable state→rm.
Spring HTTP-ready is a separate boolean/loopback URL, not SUCCEEDED. Failed/UNKNOWN/NO_TESTS and
all-skipped/nonzero-exit JUnit remain honest. Stop never calls LSP dispose. These are BE-owned details,
GUI only displays authoritative state; it does not synthesize PASSED on exit0.

### Migration transaction

1. Detect shape before execution. Exact V2 strict validation; any legacy executable/args/cwd/report
   keys, mixed versions or missing schema version with host shape => LEGACY_RUN_PROFILE_REQUIRES_MIGRATION.
   **Do not execute, guess language from command/path, erase or silently replace old fields.**
2. Open project/HTTP/WS/manual editor/drafts/recovery stay usable. Expose actionable reason:
   “Stary profil uruchamiał program hosta. Wybierz profil w paircoach.runtime.json, wykonaj prepare,
   a następnie zapisz konfigurację zadania w Ustawieniach. Stare dane zachowano.”
3. Preserve original settings bytes or existing durable settings record unchanged until explicit
   human save; show legacy JSON read-only for copying (do not expose secrets in logs/AI).
   Valid V2 save uses expectedWorkspaceVersion/idempotency and atomic durable replacement/backup.
   Validation/write failure keeps old data and modal input; cancellation is no mutation.
4. No automatic fallback. [] choice is explicit disabling, not inferred success. Restart is acceptable.
   env PAIRCOACH_RUNTIME_PROFILE > config activeProfile; GUI workspace > env > workspaceRoot;
   config paths resolve from config file, never cwd. Settings cannot override active global profile.
5. Server/runtime error cannot throw before serving editor API. Return resolved runtime status and
   separate per-mode canRun/reason. LSP FAILED affects autocomplete/markers, not typing or recovery.
   Config changes invalidate generation/cache/AI/Run/LSP across project restart. No hot swap required.

## 3. Transport and identity

Proposed additive authenticated WS messages, same envelope sequence/session validation as3.0:
client LANGUAGE_OPEN / LANGUAGE_CHANGE (OpenOrChange), LANGUAGE_CLOSE (stamp),
LANGUAGE_COMPLETE (CompleteRequest), LANGUAGE_CANCEL ({requestId}); server
LANGUAGE_COMPLETE_RESULT, LANGUAGE_DIAGNOSTICS, LANGUAGE_STATUS ({projectId, profileId,
configurationGeneration, providerGeneration, state, problem}). Wire schema additions require central
approval. These messages do NOT persist workspace content or grant writes. No private parallel socket,
no bypass of existing token/session scope. OPEN/CHANGE content <= existing document cap; completion
items <=100, total result <=256KiB, per edit text <=existing4096 cap, diagnostics <=500/truncated flag
must be explicit in finalized schema. Reject oversize, invalid tuple, unexpected paths or provider
responses. Closed/cancelled/error completion resolves empty with a visible provider status, no reconnect
mutation replay. Independent LSP synchronization acknowledgments are NOT WriteGate ACKs.

DocumentStamp separates:
- ACK baseDocumentVersion and exact-content documentVersion (null while local content differs),
- modelLifetime + monotonic localModelVersion (`getVersionId`, never alternativeVersionId),
- configuration/provider/shadow/connection generations, session/project/path/profile,
- current controlEpoch and requestGeneration; content hash of normalized LF buffer.
Server never trusts a caller's stamp as authorization: current authenticated project, active profile,
allowed paths and server-owned generations are checked. Store exact sent tuple per requestId and
JSON-RPC ID mapping. Reject unknown/duplicate/late responses; cancellation is best effort, generation
comparison is mandatory. Do not stamp replies with current metadata. ACK changes stamp/requestGeneration
but does not resend content as another save/didChange; new requests receive updated exact ACK metadata.
Diagnostics use the explicit verified ACK-only rebind below, never blind current-state stamping.
LSP `version` is server-assigned increasing integer per provider URI, explicitly mapped to a sent
stamp; it is not a WriteGate version. UTF16 capability must be negotiated (or LSP default UTF16).

### URI and text

One shared mapper: `paircoach://p-<UTF8-hex-projectId>/<percent-encoded-path-segments>` ↔ canonical
relative POSIX path ↔ `file:///workspace/<same-percent-encoded-segments>` in a provider-owned mount.
Hex authority avoids Id ':'/case/port ambiguity; retain canonical raw projectId separately. Changes
from existing raw authority require one coordinated model-lifetime migration, not two URI schemes
at once. Container root fixed by adapter contract, not user-selected. Decode once, validate then
re-encode canonical equality; reject scheme/root/authority/query/fragment mismatch, encoded slash,
backslash, dot/empty segments, traversal, Windows devices/ADS/trailing dot/space, controls, malformed
escapes and wrong project. `%252e%252e` is literal filename `%2e%2e`, never decode it a second time.
Filesystem containment/symlink/junction/case-alias exclusion is still backend responsibility, not
proven by a string mapper. No Unicode normalization/case folding that aliases two files.

Buffers/wire/LSP use LF; preserve disk eol/utf8Bom as existing Document metadata. Convert CRLF once
at ingress; preserve lone CR as content, not phantom line break. Wire/Monaco line,column 1-based ↔
LSP line,character 0-based UTF16. Reject out-of-bounds/reversed ranges and surrogate-pair splits;
no Monaco validateRange clamping. End exclusive. NonBMP counts two code units, not UTF8 bytes.
Provider URIs outside project/unknown files are dropped, never fetched or accepted as edits.

## 4. Model synchronization: one observer, no second autosave

Bridge watches EVERY live model via model.onDidChangeContent, including inactive models; Editor
onChange stays sole student→existing save callback. Snapshot the real model AFTER mutation; no
parallel computed document cache. Immediate local update/invalidation; transport may coalesce full
text with latest stamp (never defer until disk ACK). Only current project/provider observes models.

| Event | LSP effect | Existing persistence effect preserved |
|---|---|---|
| Open loaded model/tab, recover draft | didOpen latest LF buffer beforeACK; create lifetime | Existing draft storage/singleflight; no LSP save |
| Typing, completion, Undo, Redo | didChange actual content/version immediately | Exactly one CODE_CHANGED/autosave path |
| COACH_STEP_EDIT (incl inactive model) | model observer didChange despite isApplyingCoachStep guard | Existing guarded model edit→STEP_RENDERED only; no student save |
| EXTERNAL_FILE_SYNC/update, conflict LOAD_DISK | invalidate first; didChange after actual model update | Existing authoritative disk change; no duplicate save |
| KEEP_LOCAL after conflict | retain/show draft buffer; invalidate on renewed ACK mapping | Existing human-approved resolution/singleflight |
| Snapshot restore/SESSION_SNAPSHOT/resync | invalidate connection/shadow generation; reopen reconstructed loaded models | No replay of mutation requests; keep recovery drafts |
| CREATE | authorized success creates shadow entry/didOpen when model exists | Existing HTTP/WriteGate; failed create has no shadow file |
| RENAME | invalidate/cancel old URI, didClose/dispose old lifetime, shadow rename, new URI/didOpen | Success only; transfer current buffer/view state explicitly, never reuse stale requests |
| DELETE/external delete | invalidate, didClose/remove shadow/markers; draft tombstone NOT publishable | Existing protected conflict draft remains recoverable; explicit recreate starts new lifetime |
| Close tab | didClose, cancel requests, clear marker owner; retain Monaco undo if model retained | No file deletion/save; reopen didOpen current model with fresh request generation |
| Project/profile/session change/disconnect/dispose | cancel all, detach listeners, dispose LSP scope/shadow/markers; old callbacks cannot rebind | Existing project/session isolation and draft recovery retained |
| ACK only | update exact ACK map/request generation, NOT second didChange/save | Existing documents.version assignment; ACK never setValue |

Ordering across project file events and full text: monotonic project mutation/shadow generation,
serial port queue; stale/open replies after rename/delete fail scope match. LSP shadow is disposable
and writable only in its own storage; never original workspace. Run reads a DIFFERENT immutable
ACK copy with manifest/version/hash after settled writes. Unsaved LSP buffer cannot become Run input.

## 5. Diagnostics: ACK-only liveness and unversioned safety

### Explicit preACK→ACK metadata rebind (K review counterprobe)

Initial draft correctly rejected stale stamps but also dropped valid later analysis of unchanged buffers
after ACK metadata changed. K's independent counterprobe reproduced true→false; keep that as a
liveness finding, not a product regression. Corrected oracle `rebindDiagnosticsOnAck` separates analysis
identity (project/session/connection/profile/config/provider/shadow/path/model lifetime/local version/
content hash/epoch) from ACK metadata (base/exact documentVersion, requestGeneration). No analysis
identity may change during this transition, including whole-project dependency/shadow identity.

Only the trusted local save ledger may initiate rebind: exact ACK.replyTo matches immutable flight,
OK/DUPLICATE, strictly newer acknowledged disk version, matching previous ACK base/path/model version/
lifetime/hash, and actual current normalized model bytes equal immutable flight bytes. Pending newer
draft/Undo/Redo, external sync/conflict, stale ACK, changed dependency/config or epoch fails rebind.
A hash cannot be assumed valid from an LSP payload; locally captured model bytes/version are required.

For exact matching old stamps ONLY, atomically replace diagnostic version-map/request-map/fixed-stamp
metadata with verified next ACK metadata. Do not change LSP version, shadow manifest or provider process,
and do not send didChange/save. Adapter maps subsequent raw version/pull/immutable callbacks using
this explicit stored mapping, not arbitrary current state. Already constructed old-stamp wire events
are dropped; backend may re-emit an already validated diagnostic set via the same verified transition
without recomputation. Older/different sent versions stay old and rejected. Completion request/widget
is cancelled on ACK and NOT rebound (fresh request required). If ledger cannot prove equivalence,
diagnostics markers remain invalidated and schedule a fresh correlated analysis/generation instead.
This is narrowly authorized metadata change for identical input, never permission to relabel stale
results for new text. Tests retain draft true→false counterexample and then require corrected true,
plus negative content/dependency/epoch/model/receipt cases.

### Unversioned diagnostics: no idle-time fiction

Versioned push: accept ONLY if (providerGeneration,URI,LSPversion) maps to exact sent stamp still
current, plus project shadow generation equals captured generation. Pull: accept ONLY mapped
request response for exact generation/stamp; dependency edits invalidate in-flight project diagnostics.
Clear old markers immediately on mutation/rebind; [] with wrong/old identity cannot clear new markers.

Unversioned push from a MUTABLE provider is **dropped**, never relabelled with latest local/ACK version.
Debounce, didChange send-order, didClose/reopen, ping/barrier, quiet period and URI equality are NOT
proof of which document/server analysis produced a publish. “No edits pending” alone is insufficient.

Safe fallback if actual pinned server lacks usable versioned/pull output: separate diagnostics provider
process/connection bound to a single immutable whole-project shadow manifest/generation, open current
buffers once and NEVER mutate files/buffers/dependencies in that generation; do not reuse provider
process across generations. Provider has no previous project/URI lifetime or old workspace cache.
Manifest includes every analyzed source and open-buffer overlay, dependency/config files, resolved
dependency lock/digests and read-only dependency artifact identities, runtime/image/LSP identity and
analysis target/release. Do not borrow mutable Maven/pip caches or reuse old workspace/index/cache
state. Dependency/config readiness change creates a NEW shadow generation even if this file is equal.
All unversioned notifications then belong to that frozen input; adapter supplies IMMUTABLE_GENERATION
provenance using OWN launch manifest, not event-receipt time. Any subsequent local/project mutation
invalidates/discards that generation, cancels/disposes it, clears markers; bounded coalescing creates a
new isolated generation when allowed. Old processes cannot publish through new callbacks. Completion
may keep separate mutable provider. Versioned future/current mismatches are dropped too.

This fallback is heavier but executable and safe; bound to one active diagnostics generation + one
pending latest snapshot, no uncontrolled parallel containers. Dispose invalidated generation under
a bounded deadline; collect scoped logs, confirm actual provider container exit, then remove only
owned generation storage/container. If exit cannot be confirmed, block new generation admission,
report FAILED and request scoped cleanup rather than accumulate processes. Run Stop never owns
this cleanup. Completion provider remains separate and mutable; runtime Run remains separate again. **K must choose after P1_2's real JDT/pylsp
capability probe**; if neither correct version/pull nor immutable-generation strategy is implemented,
mark diagnostics FAILED/unsupported and gate remains incomplete (not claim AC108 success). Live
capability/latency/resource behavior is NOT established by these synthetic checks.

## 6. Completion acceptance = STUDENT mutation, not provider authority

At request start/result display: validate tuple, local content hash, authorized loaded writable model,
connection and provider ON; no COACH/SYNCING/prepare/conflict/veto-pending. Per-request cancellation
token cancels JSON-RPC and invalidates generation. Result validation strips nothing silently: reject
unsupported CompletionItem.command/resolve edits/snippets/insertReplace/multifile rather than run
commands or let Monaco apply unknown workspace changes. Reject unsolicited workspace/applyEdit.

**At actual Tab/Enter/click acceptance**, synchronous current-client getter (not React closure)
checks STUDENT, online/synced, !preparing, !vetoPending, !conflict/readOnly, modelLifetime/URI/path,
localModelVersion/hash, documentVersion/base ACK, epoch and every generation against item stamp.
Compare actual model.getValue() to the captured request buffer synchronously too; do not await a new
crypto.subtle hash at acceptance. Any asynchronous request-time hashing rechecks version afterward.
Validate primary+additional edits are SAME document, valid UTF16 bounds, disjoint including ambiguous
same-offset insertions, total size cap. Apply atomically via model.pushEditOperations/one undo unit
while ordinary student onChange sends ONE autosave. No asynchronous await between final check and
mutation; reject all edits if any invalid, not partially apply. No second HTTP/WS write. Undo/Redo
must remain ordinary student edits, not model.setValue.

Monaco stock CompletionItem.command runs AFTER mutation and is NOT an acceptance gate. Provider
resolve occurs before acceptance and is NOT enough. Implementation must own a public-API acceptance
controller/widget for bridged suggestions OR demonstrate a public synchronous BEFORE-edit hook
for pinned Monaco that covers keyboard + mouse + auto/commit acceptance (without private API patch).
Recommended bounded E design: bridge-supplied editor contribution/list using public model APIs;
explicit Tab/Enter/click handler above, disable competing automatic/commit acceptance. Keep existing
Solarized UI, keyboard selection/Escape, aria-expanded/activedescendant/listbox, readable empty/error
state. JS/TS built-in worker may supply candidates, but must pass SAME acceptance controller, not
an ungated stock mutation route. Coloring does not imply LSP or accepted completion correctness.
The exact widget implementation is deferred to approved E; standalone oracle cannot prove Monaco hook.

CONTROL_PREPARE reception FIRST sets synchronous accepting=false, increments requestGeneration,
cancels completion requests, hides/disposes widget and clears candidates BEFORE flush/CONTROL_READY,
await/load/publish/blue frame. Even denied prepare invalidates old widget. COACH and ownership epoch
changes also invalidate. Local Veto invalidates before optimistic STUDENT publication; pending veto
allows manual draft editing per old behavior but NOT old/new completion acceptance until authoritative
cutoff reconciles. Fresh request after confirmed student epoch allowed; no old response reopens list.
Disconnected editor may accept manual offline drafts, NOT LSP mutation based on old authorization.

## 7. Cross-proposal consolidation notes

P1_2 linked LanguageFeaturesPort proposal was read. Agreement communicated through K: content/shadow
identity separate from ACK association, trusted same-content ACK remap only, mutable unversioned DROP,
separate immutable diagnostic provider generation if needed, no second autosave/command acceptance.
K still must normalize names (ownershipEpoch vs controlEpoch, modelHandle vs modelLifetime), optional
ACK vs explicit null, opaque provider-generation type, completion-result identity and descriptor schema.
These are explicit proposal differences, not two approved wire contracts. Real capabilities/target27
and immutable-worker latency remain operator/probe evidence, not inferred from agreement.
