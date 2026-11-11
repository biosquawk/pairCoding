import { isDeepStrictEqual as same } from 'node:util';
import type { AnalysisSource, CancelRequest, CompleteRequest, CompleteResult, DiagnosticsResult, DocumentStamp, LanguageFileOperation, LanguageState, LanguageView, OpenOrChange } from '../../shared/language-v2';
import { LANGUAGE_LIMITS } from '../../shared/language-v2';
import { validateCompleteRequest, validateCompleteResult, validateDiagnosticsResult, validateDocumentStamp, validateOpenOrChange } from '../../shared/validation-v2';
import type { LanguageAckLedger } from './LanguageAckLedger';
import type { LanguageServerSession } from './LanguageServerSession';
import type { LanguageProcessRetirement } from './DockerLanguageProcess';
import type { ImmutableDiagnosticGeneration, LanguageEvent, LanguageFeaturesPort, LanguageProjectScope, VerifiedLanguageAck } from './ports';

/** Backend-only complete-vector lease, including ALL inactive overlays, sources and dependencies. */
export interface RegistrySnapshot {
  readonly revision: string;
  readonly documents: readonly Readonly<OpenOrChange>[];
}
export interface RegistryAuthority {
  capture(scope: Readonly<LanguageProjectScope>): RegistrySnapshot;
  /** Synchronous SAME serialized coordinator authority; never a byte-equality/readiness shortcut. */
  isCurrent(scope: Readonly<LanguageProjectScope>, snapshot: RegistrySnapshot): boolean;
}
export interface RegistryCallbacks {
  onSourceSent(stamp: Readonly<DocumentStamp>, source: Readonly<AnalysisSource>): void;
  onDiagnostics(result: DiagnosticsResult): void;
  onState(state: LanguageState, problem: string | null): void;
}
export type RegistrySession = Pick<LanguageServerSession, 'launchId' | 'start' | 'open' | 'change' | 'close' | 'cancelCompletions' | 'complete' | 'cancel' | 'invalidate' | 'retire'>;
export interface RegistryLaunch { session: RegistrySession; generation: ImmutableDiagnosticGeneration | null }
export interface RegistryFactory {
  /** Reacquire actual backend FIFO and prepare this exact full snapshot, then invoke action ONCE
   * synchronously while the SAME lease is held. Never start a provider or await inside action.
   * Registry retains any new owner inside action, including when final lease release fails.
   * Optional for legacy factories only; selected production composition MUST supply it.
   */
  withCaptureLease?(scope: Readonly<LanguageProjectScope>, snapshot: RegistrySnapshot, action: () => void): Promise<void>;
  /** Bind once at construction, never chosen by wire/callers of acknowledge. */
  bindAckLedger?(ledger: LanguageAckLedger): void;
  /** Synchronous ownership transfer BEFORE start/any await. Compose actual private shadow/process/session.
   * Throws only BEFORE a process is admitted; it must never hide an admitted process on factory failure.
   * Diagnostic descriptor must describe this exact immutable shadow, not caller-selected files/paths.
   */
  create(scope: Readonly<LanguageProjectScope>, phase: 'completion' | 'diagnostics', snapshot: RegistrySnapshot,
    callbacks: RegistryCallbacks, requested?: Readonly<ImmutableDiagnosticGeneration>): RegistryLaunch;
  /** SAME mutable completion owner only. Verify dependencies/config/provider unchanged, refresh private
   * shadow atomically under current lease then call session.replaceCompletionShadow. Return false BEFORE
   * refresh if identity/dependencies require a new process. Never refresh immutable diagnostic siblings.
   */
  refreshCompletion(scope: Readonly<LanguageProjectScope>, snapshot: RegistrySnapshot, launch: RegistryLaunch): boolean;
  /** Actual production ACK-only full-vector handoff, no source/result rebind or provider operation.
   * Optional only for legacy/test factories: absent hooks never authorize fresh completion currentness.
   * Registry supplies its SAME ledger; no transport caller may choose this dependency.
   */
  acknowledge?(scope: Readonly<LanguageProjectScope>, snapshot: RegistrySnapshot, launch: RegistryLaunch,
    proof: VerifiedLanguageAck, ledger: LanguageAckLedger): void;
}
export interface RegistryClock {
  set(delayMs: number, callback: () => void): unknown;
  clear(handle: unknown): void;
}
export interface LanguageFeatureRegistryOptions {
  authority: RegistryAuthority; factory: RegistryFactory;
  /** SAME instance used by the actual coordinator save path, never a structural proof validator. */
  ackLedger: LanguageAckLedger;
  clock?: RegistryClock;
}
type Pending = { snapshot: RegistrySnapshot; requested?: Readonly<ImmutableDiagnosticGeneration> };
type Slot = { launch: RegistryLaunch; snapshot: RegistrySnapshot; epoch: number; invalid: boolean;
  retiring: boolean; stopping: Promise<LanguageProcessRetirement> | null; started: Promise<void>; opened: boolean; cancellation: AbortController; analysisTimer: unknown | null };
type Lane = { phase: 'completion' | 'diagnostics'; active: Slot | null; pending: Pending | null; pumping: Promise<void> | null;
  timer: unknown | null; ready: boolean; state: LanguageState };
type Evidence = { source: Readonly<AnalysisSource>; snapshot: RegistrySnapshot; result: Readonly<DiagnosticsResult> | null };
const frozen = <T>(v: T): T => {
  if (v && typeof v === 'object') { Object.values(v).forEach(frozen); Object.freeze(v); } return v;
};
const copy = <T>(v: T): T => frozen(structuredClone(v));
const keys = ['projectId', 'sessionId', 'profileId', 'connectionGeneration', 'configurationGeneration', 'providerGeneration', 'shadowGeneration'] as const;
const lane = (phase: Lane['phase']): Lane => ({ phase, active: null, pending: null, pumping: null, timer: null, ready: false, state: 'INDEXING' });

/** One project; independent completion and immutable diagnostic owners, never Run/original workspace writers.
 * Mutable completion refresh never supplies diagnostic evidence; incompatible dependencies retire it. No ACK restart.
 * Factory/authority are trusted backend seams, NOT wire injection points or fake-ready defaults.
 */
export class LanguageFeatureRegistry implements LanguageFeaturesPort {
  private scope: Readonly<LanguageProjectScope> | null = null;
  private completion = lane('completion');
  private diagnostics = lane('diagnostics');
  private epoch = 0;
  private disposed = false;
  private listeners = new Set<(event: LanguageEvent) => void>();
  private evidence = new Map<string, Evidence>();
  private published = new Map<string, Readonly<DiagnosticsResult>>();
  private alias: VerifiedLanguageAck | null = null;
  private aliasSnapshot: RegistrySnapshot | null = null;
  private scopeRequest = 0;
  private retiredDiagnostics = new Set<string>();
  private problem: LanguageView['problem'] = null;
  private readonly clock: RegistryClock;
  constructor(private readonly options: LanguageFeatureRegistryOptions) {
    options.factory.bindAckLedger?.(options.ackLedger);
    this.clock = options.clock ?? { set: (ms, cb) => setTimeout(cb, ms), clear: h => clearTimeout(h as ReturnType<typeof setTimeout>) };
  }
  getProjectScope(): Readonly<LanguageProjectScope> | null { return this.scope; }
  private assertScope(scope: LanguageProjectScope): void {
    if (!this.scope || !same(this.scope, scope) || this.disposed) throw new Error('Obsolete language project scope');
  }
  private stamp(stamp: Readonly<DocumentStamp>): void {
    if (!this.scope || this.disposed || !validateDocumentStamp(stamp) || keys.some(k => stamp[k] !== (k === 'profileId' ? this.scope!.profile.id : this.scope![k])))
      throw new Error('Document outside admitted language scope');
  }
  private current(snapshot: RegistrySnapshot): boolean {
    try { return !!this.scope && !this.disposed && this.options.authority.isCurrent(this.scope, snapshot); } catch { return false; }
  }
  private captured(): RegistrySnapshot {
    const s = this.options.authority.capture(this.scope!);
    if (!s || typeof s.revision !== 'string' || !s.revision.length || s.revision.length > 256 || !Array.isArray(s.documents) || s.documents.length > 1000 || !this.current(s))
      throw new Error('No current complete language snapshot');
    const result = copy(s), paths = new Set<string>(); let bytes = 0;
    for (const d of result.documents) {
      this.stamp(d.stamp);
      if (!validateOpenOrChange(d) || paths.has(d.stamp.path) || (bytes += Buffer.byteLength(d.content)) > 32 * 1024 * 1024) throw new Error('Invalid captured language overlays');
      paths.add(d.stamp.path);
    }
    // Authority must support immutable lease readback, not object identity of a mutable current record.
    if (!this.current(result)) throw new Error('Snapshot changed during capture');
    return result;
  }
  private enabled(): boolean { return !!this.scope && ['jdt', 'pylsp'].includes(this.scope.profile.language.provider); }
  private view(): LanguageView {
    if (!this.scope) throw new Error('No language scope');
    const state: LanguageState = this.problem ? 'FAILED' : this.disposed || !this.enabled() ? 'OFF'
      : this.completion.state === 'ON' || this.diagnostics.state === 'ON' ? 'ON' : 'INDEXING';
    return copy({ projectId: this.scope.projectId, profileId: this.scope.profile.id, configurationGeneration: this.scope.configurationGeneration,
      providerGeneration: this.scope.providerGeneration, state, autocomplete: this.disposed || !this.enabled() ? 'OFF' : this.completion.state,
      docs: 'N/A', problem: this.problem });
  }
  private emit(event: LanguageEvent): void { const immutable = copy(event); for (const l of [...this.listeners]) { try { l(immutable); } catch { /* Observer owns no lifecycle authority. */ } } }
  private status(): void { if (this.scope) this.emit({ type: 'STATUS', status: this.view() }); }
  private failed(message: string, code = 'LANGUAGE_RUNTIME_FAILED'): void {
    this.problem = { code, message, recovery: 'Reconcile the retained language process or prepare the selected runtime, then retry.', retryable: true };
    this.status();
  }
  private clear(): void {
    const old = [...this.published.values()]; this.published.clear(); this.evidence.clear(); this.alias = null; this.aliasSnapshot = null;
    // Explicit invalidation, NOT an analysed successful empty result. Clear BEFORE any await.
    for (const r of old) this.emit({ type: 'DIAGNOSTICS', result: { ...structuredClone(r), items: [], truncated: false } });
  }
  private revoke(l: Lane, refreshCompletion = false): void {
    if (l.timer !== null) this.clock.clear(l.timer); l.timer = null; l.pending = null; l.ready = false; l.state = 'INDEXING';
    if (l.active) {
      if (refreshCompletion && l.phase === 'completion' && l.active.opened && !l.active.invalid && !l.active.retiring) l.active.launch.session.cancelCompletions();
      else { l.active.invalid = true; l.active.cancellation.abort(); l.active.launch.session.invalidate('Complete source/overlay/dependency/scope vector invalidated'); }
    }
  }
  private invalidate(refreshCompletion = false): void { this.epoch++; this.revoke(this.completion, refreshCompletion); this.revoke(this.diagnostics); this.clear(); }
  async startProject(scope: LanguageProjectScope): Promise<LanguageView> {
    const admission = ++this.scopeRequest;
    if (this.scope && !this.disposed && same(this.scope, scope)) return this.view();
    if (this.scope) {
      const result = await this.disposeProject(this.scope);
      if (!result.confirmed) throw new Error('Previous language process ownership unresolved');
      if (admission !== this.scopeRequest) throw new Error('Language scope admission superseded');
    }
    this.retiredDiagnostics.clear(); this.scope = copy(scope); this.disposed = false; this.problem = null; this.completion = lane('completion'); this.diagnostics = lane('diagnostics');
    if (this.enabled()) { try { this.schedule(this.captured()); } catch (e) { this.failed(String(e)); } }
    this.status(); return this.view();
  }
  subscribe(scope: LanguageProjectScope, listener: (event: LanguageEvent) => void): () => void {
    this.assertScope(scope); this.listeners.add(listener); return () => this.listeners.delete(listener);
  }
  private schedule(snapshot: RegistrySnapshot, requested?: Readonly<ImmutableDiagnosticGeneration>): void {
    if (!this.enabled()) return;
    this.completion.pending = { snapshot }; this.completion.ready = true;
    this.diagnostics.pending = { snapshot, requested }; this.diagnostics.ready = false;
    if (this.diagnostics.timer !== null) this.clock.clear(this.diagnostics.timer);
    this.diagnostics.timer = this.clock.set(LANGUAGE_LIMITS.diagnosticCoalesceMs, () => {
      this.diagnostics.timer = null; this.diagnostics.ready = true; void this.pump(this.diagnostics);
    });
    void this.pump(this.completion); void this.pump(this.diagnostics);
  }
  private mutate(document?: OpenOrChange, closed?: DocumentStamp): Promise<void> {
    if (document) { this.stamp(document.stamp); if (!validateOpenOrChange(document)) throw new Error('Invalid language document'); }
    if (closed) this.stamp(closed);
    this.invalidate(true);
    try {
      const snapshot = this.captured(), found = document && snapshot.documents.find(d => d.stamp.path === document.stamp.path);
      if (document && !same(found, document) || closed && snapshot.documents.some(d => d.stamp.path === closed.path)) throw new Error('Operation not admitted by actual current overlay authority');
      this.problem = null; this.schedule(snapshot); this.status();
    } catch (e) { void this.pump(this.completion); void this.pump(this.diagnostics); this.failed(String(e)); return Promise.reject(e); }
    return Promise.resolve();
  }
  open(document: OpenOrChange): Promise<void> { return this.mutate(copy(document)); }
  change(document: OpenOrChange): Promise<void> { return this.mutate(copy(document)); }
  close(stamp: DocumentStamp): Promise<void> { return this.mutate(undefined, copy(stamp)); }
  fileOperation(scope: LanguageProjectScope, _operation: LanguageFileOperation): Promise<void> {
    this.assertScope(scope); return this.mutate(); // Actual successful Workspace feed; recapture COMPLETE inventory even for inactive files.
  }
  private valid(l: Lane, s: Slot): boolean { return l.active === s && !s.invalid && s.epoch === this.epoch && (this.current(s.snapshot) || l.phase === 'diagnostics' && this.aliasSnapshot === s.snapshot && !!this.alias && this.options.ackLedger.isVerified(this.alias)); }
  private sourceCurrent(e: Evidence): boolean {
    return this.current(e.snapshot) || this.aliasSnapshot === e.snapshot && !!this.alias && this.options.ackLedger.isVerified(this.alias);
  }
  /** Exact captured admitted stamp only; coordinator maps authenticated peer/messageId to THAT stamp. */
  readAnalysisSource(stamp: Readonly<DocumentStamp>): Readonly<AnalysisSource> | null {
    try { this.stamp(stamp); const e = this.evidence.get(stamp.path);
      return e && same(e.source.sourceStamp, stamp) && this.sourceCurrent(e) ? e.source : null; } catch { return null; }
  }
  /** Issuer-only archival reader: not a current/presentation grant. Exact admitted stamp -> actual sent
   * immutable source, including during the SAME atomic ACK-only revision transition. The issuer itself
   * checks the original before-vector and actual committed after-vector. Every NON-ACK vector mutation
   * MUST synchronously enter this registry's mutation feed (which erases this archive) under that SAME gate.
   * No receipt/latest-stamp lookup and no callback to isVerified here (that would create an issuance cycle).
   */
  readSentAnalysisSource(stamp: Readonly<DocumentStamp>): Readonly<AnalysisSource> | null {
    try { this.stamp(stamp); const e = this.evidence.get(stamp.path); return e && same(e.source.sourceStamp, stamp) ? e.source : null; }
    catch { return null; }
  }
  private callbacks(l: Lane, slot: () => Slot): RegistryCallbacks {
    return {
      onSourceSent: (stamp, source) => {
        const s = slot(); if (l.phase !== 'diagnostics' || !this.valid(l, s) || !same(stamp, source.sourceStamp)) return;
        const d = s.snapshot.documents.find(d => same(d.stamp, stamp)), g = s.launch.generation;
        if (this.evidence.has(stamp.path) || s.retiring || !d || !g || !g.sources.some(expected => same(expected, source)) || source.provenance.kind !== 'IMMUTABLE_GENERATION' ||
          source.provenance.launchId !== s.launch.session.launchId || source.provenance.inputManifestSha256 !== g.inputManifestSha256) return;
        this.evidence.set(stamp.path, { source: copy(source), snapshot: s.snapshot, result: null });
      },
      onDiagnostics: result => {
        const s = slot(); if (!this.valid(l, s) || s.retiring || l.phase !== 'diagnostics' || !validateDiagnosticsResult(result)) return;
        const e = this.evidence.get(result.sourceStamp.path);
        if (!e || e.result || !same(e.source, { sourceStamp: result.sourceStamp, provenance: result.provenance }) ||
          !same(result.presentationStamp, result.sourceStamp) || result.association !== null) return;
        e.result = copy(result); this.publishEvidence(e); l.state = 'ON'; this.status();
        if (s.snapshot.documents.every(d => this.evidence.get(d.stamp.path)?.result)) {
          s.retiring = true; s.cancellation.abort(); if (s.analysisTimer !== null) this.clock.clear(s.analysisTimer); s.analysisTimer = null; void this.stop(l).then(confirmed => { if (!confirmed) this.clear(); });
        }
      },
      onState: (state, problem) => {
        const s = slot(); if (!this.valid(l, s) || s.retiring) return;
        l.state = state;
        if (state === 'FAILED') { s.invalid = true; s.launch.session.invalidate(problem ?? 'Language session failed'); this.clear(); this.failed(problem ?? 'Language session failed'); void this.pump(l); }
        else this.status();
      },
    };
  }
  private publish(result: Readonly<DiagnosticsResult>): void { this.published.set(result.sourceStamp.path, result); this.emit({ type: 'DIAGNOSTICS', result }); }
  private publishEvidence(e: Evidence): void {
    if (!e.result) return;
    const proof = this.alias;
    this.publish(proof && this.aliasSnapshot === e.snapshot && same(proof.source, e.source) && this.options.ackLedger.isVerified(proof)
      ? copy({ ...e.result, presentationStamp: proof.presentation, association: { saveReceiptId: proof.saveReceiptId } }) : e.result);
  }
  acknowledge(proof: VerifiedLanguageAck): void {
    // Coordinator calls ONLY after authentic ACK broadcast. No wire structure/foreign issuer can mint this.
    const e = this.evidence.get(proof?.source?.sourceStamp.path);
    if (!e || !same(e.source, proof.source) || !this.options.ackLedger.isVerified(proof) ||
      proof.presentation.requestGeneration !== proof.source.sourceStamp.requestGeneration) { void this.mutate().catch(() => {}); return; }
    if (this.alias === proof) return;
    try {
      const changed = !same(this.alias?.presentation, proof.presentation);
      if (changed) {
        // Also fences a caller whose result resolved just before ACK but has not resumed in registry.complete.
        this.epoch++; this.completion.active?.launch.session.cancelCompletions();
        for (const l of [this.completion, this.diagnostics]) if (l.active && !l.active.invalid) l.active.epoch = this.epoch;
      }
      if (this.options.factory.acknowledge) {
        const snapshot = this.captured();
        for (const l of [this.completion, this.diagnostics]) {
          const s = l.active;
          if (!s || s.invalid || s.retiring) continue;
          this.options.factory.acknowledge(this.scope!, snapshot, s.launch, proof, this.options.ackLedger);
          if (l.phase === 'completion') s.snapshot = snapshot; // immutable diagnostic slot/evidence NEVER rebound
        }
      }
      this.alias = proof; this.aliasSnapshot = e.snapshot;
      this.publishEvidence(e);
    } catch { void this.mutate().catch(() => {}); }
  }
  private checkGeneration(g: ImmutableDiagnosticGeneration | null, s: Slot): void {
    if (!g || g.policy !== 'IMMUTABLE_WHOLE_PROJECT' || g.maxAnalysisMs !== LANGUAGE_LIMITS.diagnosticAnalysisMs ||
      g.retirementDeadlineMs !== LANGUAGE_LIMITS.diagnosticRetirementMs || g.launchId !== s.launch.session.launchId ||
      !/^[a-f0-9]{64}$/.test(g.inputManifestSha256) || !g.wholeProjectManifestPath || !g.immutableShadowDirectory ||
      g.sources.length !== s.snapshot.documents.length || new Set(g.sources.map(v => v.sourceStamp.path)).size !== g.sources.length ||
      g.sources.some(source => !s.snapshot.documents.some(d => same(d.stamp, source.sourceStamp)) || source.provenance.kind !== 'IMMUTABLE_GENERATION' ||
        source.provenance.launchId !== g.launchId || source.provenance.inputManifestSha256 !== g.inputManifestSha256 ||
        !validateDiagnosticsResult({ ...source, presentationStamp: source.sourceStamp, association: null, items: [], truncated: false }))) throw new Error('Unbound immutable diagnostic generation');
  }
  private pump(l: Lane): Promise<void> {
    if (l.pumping) return l.pumping;
    l.pumping = Promise.resolve().then(() => this.run(l)).catch(e => this.failed(String(e))).finally(() => { l.pumping = null;
      // Only genuinely new pending work, never a retry loop around uncertain Stop.
      if (l.pending && l.ready && (!l.active || l.phase === 'completion' && !l.active.invalid && l.active.opened)) void this.pump(l);
    }); return l.pumping;
  }
  private async captureOperation(l: Lane, next: Pending, expected: Slot | null, action: () => void): Promise<boolean> {
    const scope = this.scope!, epoch = this.epoch;
    let invoked = false, applied = false, accepting = true;
    const capture = () => {
      if (!accepting || invoked) throw new Error('Capture operation must run exactly once within its lease');
      invoked = true;
      if (this.disposed || scope !== this.scope || epoch !== this.epoch || l.active !== expected || !this.current(next.snapshot)) return;
      action(); applied = true;
    };
    try {
      if (this.options.factory.withCaptureLease) await this.options.factory.withCaptureLease(scope, next.snapshot, capture);
      else capture(); // Legacy factory compatibility, never selected-cache production fallback.
      if (!invoked) throw new Error('Capture lease omitted synchronous ownership transfer');
      return applied;
    } finally { accepting = false; }
  }
  private async run(l: Lane): Promise<void> {
    if (l.phase === 'completion' && l.active && !l.active.invalid && l.pending && l.ready) {
      const s = l.active, next = l.pending; l.pending = null;
      if (this.current(next.snapshot)) {
        try {
          const previous = s.snapshot;
          let refreshed = false;
          const applied = await this.captureOperation(l, next, s, () => {
            refreshed = this.options.factory.refreshCompletion(this.scope!, next.snapshot, s.launch);
            if (refreshed) { s.snapshot = next.snapshot; s.epoch = this.epoch; }
            else { s.invalid = true; if (!l.pending) l.pending = next; }
          });
          if (applied && refreshed) {
            for (const old of previous.documents) {
              if (!this.valid(l, s)) break;
              const replacement = next.snapshot.documents.find(d => d.stamp.path === old.stamp.path);
              if (!replacement || replacement.stamp.modelLifetime !== old.stamp.modelLifetime) await s.launch.session.close(old.stamp);
            }
            for (const doc of next.snapshot.documents) {
              if (!this.valid(l, s)) break;
              const old = previous.documents.find(d => d.stamp.path === doc.stamp.path && d.stamp.modelLifetime === doc.stamp.modelLifetime);
              if (!old) await s.launch.session.open(doc); else if (!same(old, doc)) await s.launch.session.change(doc);
            }
          }
        } catch (e) { s.invalid = true; s.launch.session.invalidate(String(e)); this.failed(String(e)); }
      }
    }
    if (l.active?.invalid && !await this.stop(l)) return;
    while (!l.active && l.pending && l.ready && !this.disposed) {
      const next = l.pending; l.pending = null;
      if (!this.current(next.snapshot)) continue;
      const slot: Slot = { launch: null!, snapshot: next.snapshot, epoch: this.epoch, invalid: false, retiring: false, stopping: null, started: Promise.resolve(), opened: false, cancellation: new AbortController(), analysisTimer: null };
      try {
        const applied = await this.captureOperation(l, next, null, () => {
          slot.launch = this.options.factory.create(this.scope!, l.phase, next.snapshot, this.callbacks(l, () => slot), next.requested);
          l.active = slot; // Retain BEFORE descriptor copying or async callback/final-release can fail.
          slot.launch = { session: slot.launch.session, generation: slot.launch.generation ? copy(slot.launch.generation) : null };
        });
        if (!applied) continue;
        if (!this.valid(l, slot)) throw new Error('Capture superseded before provider start');
        if (l.phase === 'diagnostics') {
          slot.analysisTimer = this.clock.set(LANGUAGE_LIMITS.diagnosticAnalysisMs, () => {
            if (l.active !== slot || slot.retiring) return;
            slot.invalid = true; slot.cancellation.abort(); slot.launch.session.invalidate('Immutable diagnostic analysis deadline'); this.clear(); this.failed('Immutable diagnostic analysis deadline'); void this.stop(l);
          });
          this.checkGeneration(slot.launch.generation, slot); if (next.requested && !same(next.requested, slot.launch.generation)) throw new Error('Requested generation differs from actual owned launch'); }
        slot.started = (async () => {
          await slot.launch.session.start();
          for (const d of next.snapshot.documents) { if (!this.valid(l, slot)) return; await slot.launch.session.open(d); }
        })();
        await Promise.race([slot.started, new Promise<void>(resolve => {
          if (slot.cancellation.signal.aborted) resolve();
          else slot.cancellation.signal.addEventListener('abort', () => resolve(), { once: true });
        })]); slot.opened = !slot.cancellation.signal.aborted;
        if (!this.valid(l, slot)) slot.invalid = true;
      } catch (e) {
        if (!slot.launch) throw e; // Factory contract: no admitted process before ownership transfer.
        slot.invalid = true; slot.launch.session.invalidate(String(e)); this.clear(); this.failed(String(e));
      }
      if (slot.invalid && l.active === slot && !await this.stop(l)) return;
    }
  }
  private async boundedStop(slot: Slot): Promise<LanguageProcessRetirement> {
    if (!slot.stopping) slot.stopping = slot.launch.session.retire().catch(e => ({ confirmed: false, removed: false, problem: String(e) })).finally(() => { slot.stopping = null; });
    let timer: unknown;
    try { return await Promise.race([slot.stopping, new Promise<LanguageProcessRetirement>(resolve => {
      timer = this.clock.set(LANGUAGE_LIMITS.diagnosticRetirementMs, () => resolve({ confirmed: false, removed: false, problem: 'Language retirement deadline exceeded' }));
    })]); } finally { if (timer !== undefined) this.clock.clear(timer); }
  }
  private async stop(l: Lane): Promise<boolean> {
    const s = l.active; if (!s) return true;
    s.retiring = true; s.cancellation.abort(); if (s.analysisTimer !== null) this.clock.clear(s.analysisTimer); s.analysisTimer = null; s.launch.session.invalidate('Language process retiring');
    const r = await this.boundedStop(s);
    if (!r.confirmed || !r.removed) { s.invalid = true; l.state = 'FAILED'; this.failed(r.problem ?? 'PROCESS_STOP_UNCONFIRMED', 'PROCESS_STOP_UNCONFIRMED'); return false; }
    if (l.phase === 'diagnostics') this.retiredDiagnostics.add(s.launch.session.launchId);
    if (l.active === s) l.active = null;
    if (l.state === 'FAILED') l.state = 'INDEXING';
    if (this.problem?.code === 'PROCESS_STOP_UNCONFIRMED' && this.completion.state !== 'FAILED' && this.diagnostics.state !== 'FAILED') this.problem = null;
    return true;
  }
  async complete(request: CompleteRequest, signal?: AbortSignal): Promise<CompleteResult> {
    this.stamp(request.stamp); if (!validateCompleteRequest(request)) throw new Error('Invalid completion request');
    const captured = copy(request), epoch = this.epoch, s = this.completion.active;
    if (!s || !this.valid(this.completion, s)) throw new Error('Completion still indexing');
    if (!s.snapshot.documents.some(d => same(d.stamp, captured.stamp))) throw new Error('Completion not in captured source');
    const result = await s.launch.session.complete(captured, signal);
    if (!validateCompleteResult(result) || result.requestId !== captured.requestId || !same(result.stamp, captured.stamp)) throw new Error('Unbound completion result');
    if (epoch !== this.epoch || !this.valid(this.completion, s) || signal?.aborted) throw new Error('Late completion result');
    return result;
  }
  cancel(request: CancelRequest): void { this.stamp(request.stamp); this.completion.active?.launch.session.cancel(request.requestId); }
  startDiagnostics(scope: LanguageProjectScope, generation: ImmutableDiagnosticGeneration): Promise<void> {
    this.assertScope(scope); this.invalidate();
    try { this.schedule(this.captured(), copy(generation)); } catch (e) { void this.pump(this.completion); void this.pump(this.diagnostics); return Promise.reject(e); }
    return Promise.resolve();
  }
  async retireDiagnostics(scope: LanguageProjectScope, launchId: string): Promise<{ confirmed: boolean; status: LanguageView }> {
    this.assertScope(scope); const l = this.diagnostics;
    if (this.retiredDiagnostics.has(launchId)) return { confirmed: true, status: this.view() };
    if (!l.active) throw new Error('Unknown diagnostic process');
    if (l.active && l.active.launch.session.launchId !== launchId) throw new Error('Foreign diagnostic process');
    if (l.timer !== null) this.clock.clear(l.timer); l.timer = null; l.pending = null; l.ready = false;
    if (l.active) l.active.retiring = true;
    const confirmed = await this.stop(l); // Keep exact immutable evidence after CONFIRMED retirement while full vector current.
    if (!confirmed) this.clear(); return { confirmed, status: this.view() };
  }
  async disposeProject(scope: LanguageProjectScope): Promise<{ confirmed: boolean; status: LanguageView }> {
    if (!this.scope || !same(this.scope, scope)) throw new Error('Foreign language scope disposal');
    this.disposed = true; this.invalidate(); this.listeners.clear();
    const confirmed = (await Promise.all([this.stop(this.completion), this.stop(this.diagnostics)])).every(Boolean);
    if (confirmed) this.problem = null;
    return { confirmed, status: this.view() };
  }
}
