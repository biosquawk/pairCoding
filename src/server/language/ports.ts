/** INTERNAL provider API. Registry selects provider from backend RuntimeProfile, never a client stamp. */
import type { Id } from '../../shared/protocol';
import type { RuntimeProfile } from '../../shared/runtime-v2';
import type { AnalysisSource, CancelRequest, CompleteRequest, CompleteResult, DiagnosticsResult, DocumentStamp, LanguageFileOperation, LanguageView, OpenOrChange } from '../../shared/language-v2';
export interface LanguageProjectScope {
  projectId: Id; sessionId: Id; profile: RuntimeProfile;
  configurationGeneration: Id; providerGeneration: Id; shadowGeneration: Id; connectionGeneration: Id;
  /** Separate controlled copy, NEVER original workspace RW, Run input or another provider generation. */
  shadowDirectory: string;
}
export interface ImmutableDiagnosticGeneration {
  launchId: Id; inputManifestSha256: string; wholeProjectManifestPath: string;
  sources: readonly AnalysisSource[]; immutableShadowDirectory: string;
  /** Fresh connection/process/index/cache. Open once, no didChange; read-only immutable dependency artifacts. */
  policy: 'IMMUTABLE_WHOLE_PROJECT'; maxAnalysisMs: 30000; retirementDeadlineMs: 10000;
}
declare const verifiedLanguageAck: unique symbol;
/**
 * Only verified pending immutable autosave replyTo/transaction can mint this; NEVER wire/client/LSP input.
 * Requires OK/DUPLICATE, exact project/path/connection/control, previous base/lifetime/localVersion/hash,
 * newer disk version, actual current normalized bytes, unchanged dependency/shadow/config/profile/provider.
 * Any pending newer draft/external conflict/epoch/reconnect invalidates proof. ACK is NOT didChange/save/restart.
 */
export interface VerifiedLanguageAck {
  readonly [verifiedLanguageAck]: true;
  readonly saveReceiptId: Id; readonly transactionMessageId: Id; readonly replyTo: Id;
  readonly status: 'OK' | 'DUPLICATE'; readonly source: Readonly<AnalysisSource>;
  readonly previous: Readonly<DocumentStamp>; readonly presentation: Readonly<DocumentStamp>;
  readonly normalizedContentSha256: string; readonly dependencyManifestSha256: string;
}
export type LanguageEvent = { type: 'STATUS'; status: LanguageView }
  | { type: 'DIAGNOSTICS'; result: DiagnosticsResult };
/**
 * Mutable completion lifecycle is separate from diagnostic generations and from Run.
 * Default JDT AND Python policy: immutable whole-project diagnostic generation; one active+latest pending,
 * coalesce150ms scheduling ONLY; retire immediately+clear on any source/dependency/scope change.
 * Confirm previous exit within10s before new launch; daemon uncertainty => FAILED + retained ownership,
 * no next generation until reconciliation. Analysis max30s; missing/unsafe results never become fake markers.
 * Exact sent ledger maps request/LSP version/launch to AnalysisSource unchanged. Mutable unversioned pushes
 * and unknown/duplicate/cancelled/late replies DROP; pull/version association requires actual semantic proof.
 */
export interface LanguageFeaturesPort {
  startProject(scope: LanguageProjectScope): Promise<LanguageView>;
  open(document: OpenOrChange): Promise<void>;
  change(document: OpenOrChange): Promise<void>;
  acknowledge(proof: VerifiedLanguageAck): void;
  close(stamp: DocumentStamp): Promise<void>;
  /** Authorized successful WorkspaceService operation feed ONLY, never an unrestricted client endpoint. */
  fileOperation(scope: LanguageProjectScope, operation: LanguageFileOperation): Promise<void>;
  complete(request: CompleteRequest, signal?: AbortSignal): Promise<CompleteResult>;
  cancel(request: CancelRequest): void;
  subscribe(scope: LanguageProjectScope, listener: (event: LanguageEvent) => void): () => void;
  startDiagnostics(scope: LanguageProjectScope, generation: ImmutableDiagnosticGeneration): Promise<void>;
  retireDiagnostics(scope: LanguageProjectScope, launchId: Id): Promise<{ confirmed: boolean; status: LanguageView }>;
  /** Stop-confirmed -> bounded boot/workspace logs -> durable receipt -> exact rm; uncertain retirement retained. */
  disposeProject(scope: LanguageProjectScope): Promise<{ confirmed: boolean; status: LanguageView }>;
}
