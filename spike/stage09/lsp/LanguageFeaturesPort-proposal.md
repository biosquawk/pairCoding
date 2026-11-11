# LanguageFeaturesPort — proposal for central K contract, A–B only

Base: 38d5130634d0f0ac7ace4c82a77273fe7f4ef3e9. No product imports or edits.
C–E MUST wait for ROOT A–B approval. REQ106 / AC108–110; full ROOT matrix retained.

## Neutral boundary and DTO proposal

`LanguageFeaturesPort` owns project/profile/provider generations and controlled LSP shadow only:

```ts
type DocumentIdentity = {
  projectId: string; path: string; // canonical relative POSIX, no symlink escape
  profileId: string; localModelVersion: number; // Monaco version, NOT ACK version
  documentVersion?: number; // acknowledged disk version when available, not guessed
  requestGeneration: number; providerGeneration: number; ownershipEpoch: number;
};
type LanguageStatus = 'OFF'|'INDEXING'|'ON'|'FAILED';
interface LanguageFeaturesPort {
  startProject(input: {projectId: string; profileId: string; shadowManifestHash: string}): Promise<void>;
  openDocument(input: DocumentIdentity & {text: string}): Promise<void>;
  changeDocument(input: DocumentIdentity & {text: string; source: ModelMutationSource}): Promise<void>;
  closeDocument(input: DocumentIdentity): Promise<void>;
  projectFilesChanged(input: {projectId: string; generation: number; operations: ProjectFileOperation[]}): Promise<void>;
  complete(input: DocumentIdentity & {position: UTF16Position; trigger: CompletionTrigger}): Promise<CompletionEnvelope>;
  cancel(input: {projectId: string; requestGeneration: number}): void;
  subscribe(listener: (event: DiagnosticEnvelope|StatusEnvelope) => void): () => void;
  disposeProject(projectId: string): Promise<void>; // stop-confirmed own LSP only
}
```

Backend registry implements selected approved language provider; generic coordinator and FE bridge never import Docker/Maven/pip or branch on Java/Python. Provider generations are opaque, minted by server, never accepted from arbitrary AI settings. `startProject` receives trusted resolved profile through K's configuration registry, not executable/args or user Docker flags. RuntimeProfile selects LSP image/start plan; TaskRunConfig entries/tests do NOT control LSP process argv. Disabled/missing/failed LSP reports actionable status while editing/HTTP/WS/drafts continue.

`documentVersion` is optional before ACK. A later ACK for identical localModelVersion/text hash may attach an association in controller state, but must NOT rewrite an in-flight envelope's identity or require a second autosave. Reply acceptance compares its captured local identity to current active model plus acknowledged association when it existed at dispatch. K must decide optional-ACK comparison details with P2: a legitimate same-text ACK during flight should not force a model mutation, while an unrelated external ACK must invalidate. The synthetic strict comparator is intentionally conservative and not final DTO/product implementation.

## Three different inputs, never shared mutable storage

1. Student Monaco model and local version, possibly unacknowledged.
2. LSP controlled project shadow + didOpen/full didChange buffers, including before ACK. Never saves original workspace or writes via a second autosave. All typing, completion acceptance, COACH_STEP_EDIT, Undo/Redo, EXTERNAL_FILE_SYNC, snapshot restore, CREATE/RENAME/DELETE use the same synchronization coordinator. File operations increment generations, close old URI and cancel old requests before re-open. Shadow symlinks/secrets/build output excluded; exact copied manifest and profile recorded.
3. Run receives only immutable acknowledged WriteGate snapshot with separate runId/hash/version. LSP state cannot change it. Run Stop cannot stop a project LSP container.

## URI, UTF-16, model lifecycle

K/P2 own one canonical codec: paircoach URI ↔ validated relative POSIX ↔ file:///workspace/{encoded segments} (P2 proposal; this standalone spike uses private /work only). Resolve project identity server-side; never trust client-provided absolute file URI. Encode each segment once. Reject NUL, traversal, drive/UNC/absolute paths and duplicate encodings. Preserve Unicode spelling (do not silently NFC-normalize filenames), case under actual filesystem policy, spaces, Polish/nonBMP; Production model/wire/LSP uses normalized LF per existing Document contract; CRLF conversion occurs once at ingress, preserving original disk EOL/BOM. This standalone spike deliberately sends CRLF as a server probe, not a proposal to change production normalization. LSP character and Monaco columns are UTF-16 code units; Monaco one-based, LSP zero-based. Map back only paths in this project's controlled shadow; reject library/external and other-project locations for edits. URI may be stable while model handle/generation changes: delayed replies must still fail identity checks.

## Diagnostics: no invented current version

The spike sends `publishDiagnostics.versionSupport=true` and captures every raw incoming notification, its actual presence/absence of `params.version`, receive ordering, tool versions and server capabilities. It does NOT add modelVersion to a notification. At this delivery, role Docker is BLOCKED: actual JDT/pylsp behavior is NOT_RUN pending ROOT. Do not infer observed behavior from package docs or a synthetic test.

**Safe final rule is conditional on real capability/behavior:**
- If push carries a valid version, compare it to the LSP version assigned to the captured local buffer, plus project/path/profile/provider/request/ownership generations. Reject old/unknown versions. Do not compare it to ACK disk version.
- For unversioned push from the mutable completion server, **discard it as a UI marker source**. didChange ordering, a later completion response, debounce, a quiet window, didSave, clear-on-edit, or cancellation are NOT proofs that publication belongs to latest text.
- To still meet diagnostics when server is unversioned, use a **dedicated immutable diagnostic snapshot provider generation**, with a separate shadow and a fresh server process that never receives another document revision. Capture project shadow/text manifest hash and local-model vector when creating it. Each notification is associated with that immutable source context by transport identity. Drop whole snapshot generation immediately on ANY model/project/profile/file/ownership change. Restart (debounced/coalesced) only diagnostics generation, not original document and not Run; status INDEXING until fresh. Late notifications from retired processes cannot revive markers. A dedicated process may run within an owned LSP diagnostic container; no mutation of the mutable completion provider can be used as the fence.
- Negotiated pull diagnostics can be considered if actual server capability is proved and server semantics bind response to a captured immutable input; request/response alone is not a substitute for source-state proof.

This fallback costs Java startup/index time and extra resources. **Unresolved for K/ROOT:** choose versioned push when actually verified; otherwise explicitly approve bounded immutable-worker strategy and its resource limits, or request tested upstream version-binding mechanism. Do not silently omit diagnostics or ship unsafe unversioned stamping. The current real spike is for behavior discovery, not an implementation/performance proof of snapshot worker. Its bad→clear observations are not claimed to establish a production fence.

## Completion/ownership acceptance

Provider returns bounded plain items and captured identity; strip/reject command, workspace edits, external/multifile edits. Monaco single-document textEdit/additionalTextEdits require non-overlap, bounded valid UTF16 ranges and atomic application. Snippet execution unsupported until explicitly validated. At Enter/Tab (not just widget opening), recheck STUDENT, CONTROL_PREPARE=false, model handle/version/epoch/profile/project/request/provider. Then route ordinary CODE_CHANGED to existing single-flight autosave/WriteGate and preserve normal undo grouping, cursor/selection. Never call a parallel save path.

CONTROL_PREPARE immediately closes widget, cancels requests, retires acceptance tokens and clears pending markers before ownership display. COACH permits no student suggestion mutation. Veto increments epoch/generations and late resolve/push cannot reopen. workspace/applyEdit returns applied=false. CompletionItem.command is never executed. Cancel request is advisory; identity fence is authoritative.

## Fresh C–E tests (not claimed executed here)

- Real contextual custom-method dot and explicit completion Java27/Python3.13, rename removes old method, error marker then corrected removal, capabilities/version observations (AC108).
- All model sources and CREATE/RENAME/DELETE synchronize before ACK without extra saves. Delayed old/unversioned notification, concurrent ACK and external-sync negative cases.
- URI spaces/Polish/nonBMP/CRLF, full/incremental versions, project switch/restart and profile21→27→Python→21 isolate buffers/cache/AI.
- Widget→CONTROL_PREPARE→Enter, COACH→Veto→late response, same-document atomic additionalTextEdits vs commands/multifile, Undo/Redo/single-flight autosave/METRIC protections unchanged (AC109).
- Missing daemon/image/config and failed LSP leave editor/drafts available and clear stale language status (AC110). Real nativeWindows vs WSL evidence separate (AC111).

No original tests/assertions/golden/METRIC/verifier changed. Full TEST101–107 and AC101–112 remain final-F requirements, not satisfied by A–B or unit tests.

## ACK-only consolidation requested by K (after reading P2 proposal)

Use two immutable records, not a single rewritten stamp:
- **ContentIdentity:** project/session/modelLifetime/path/localModelVersion/LF-contentSHA256, whole-project shadow manifest + configuration/profile/provider generations. Invalidate on actual content/dependency/model lifetime/project changes.
- **Authorization/ACK association:** current authenticated connection/control epoch, request generation, baseDocumentVersion and exact-content documentVersion. Server/controller owns associations; LSP/client/AI cannot assert equality.

`acknowledge` is metadata-only: look up the exact pending autosave transaction and original model version/text hash. Confirm ACK returned the same normalized content hash and belongs to that project/path/connection; associate its disk documentVersion with the SAME ContentIdentity. No setValue, autosave, didChange or whole-project provider restart for identical content. If normalized content differs, project manifest changed or stale transaction cannot be proved, invalidate/re-sync instead.

Outstanding completion may be conservatively cancelled/re-requested under the new authorization stamp. For diagnostics, retain `(providerGeneration,URI,LSPversion or immutable snapshot source)` → original **ContentIdentity**, not a frozen all-fields ACK stamp. The authenticated controller may publish a separate **presentation association** to the current ACK/auth metadata ONLY after the equality proof above, same model/whole-project snapshot/profile/provider and current control authority. Keep original source stamp/provenance in the envelope; never overwrite it with current receipt-time version. If ACK changes requestGeneration, a trusted internal alias links the old diagnostic source to current presentation association; do not demand an impossible new didChange to create that link. Unversioned mutable push remains DROP even if ACK text hashes match, since its unknown analysis version has no source identity.

`linkAckOnly` synthetic helper illustrates equality/negative checks and preservation of original source. It is not a public wire API or an authorization implementation. Final central DTO should use P2's full DocumentStamp and separate source/presentation fields or equivalent trusted map, NOT transplant this minimal example unchanged. `/workspace` canonical container URI and LF normalization align with P2; `/work`/CRLF in standalone harness are explicit probe-only details.
