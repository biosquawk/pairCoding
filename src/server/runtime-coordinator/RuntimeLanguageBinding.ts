import { isDeepStrictEqual as same } from 'node:util';
import * as codec from '../../language/uriCodec';
import type { CompleteResult, DocumentStamp, LanguageClientMessage, LanguageFileOperation, LanguageView } from '../../shared/language-v2';
import type { LanguageBootstrapV2 } from '../../shared/language-authority-v2';
import { validateCompleteResult, validateDiagnosticsResult, validateLanguageClientMessage, validateLanguageFileOperation, validateLanguageView } from '../../shared/validation-v2';
import { LanguageAckLedger, type LanguageAckAuthority, type LanguageSaveInput, type PendingLanguageSave } from '../language/LanguageAckLedger';
import { LanguageFeatureRegistry, type RegistryAuthority, type RegistrySnapshot } from '../language/LanguageFeatureRegistry';
import { createSelectedCacheLanguageFactory, type SelectedCacheLanguageFactoryOptions, type SelectedLanguageLease } from '../language/SelectedCacheLanguageAuthority';
import type { LanguageEvent, LanguageProjectScope } from '../language/ports';

export interface RuntimeLanguageBindingOptions {
  readonly scope: Readonly<LanguageProjectScope>;
  readonly selected: SelectedCacheLanguageFactoryOptions & {
    withSourceLease: NonNullable<SelectedCacheLanguageFactoryOptions['withSourceLease']>;
  };
  readonly sourceAuthority: RegistryAuthority;
  readonly saveAuthority: Pick<LanguageAckAuthority, 'readCurrent' | 'readCommittedSave'>;
  assertCurrent(): void;
  assertPeer(peerId: string, message: Readonly<LanguageClientMessage>): void;
  emit(event: LanguageEvent): void;
}
const copy = <T>(value: T): T => {
  const cloned = structuredClone(value);
  const freeze = (v: unknown): void => { if (v && typeof v === 'object') { Object.values(v).forEach(freeze); Object.freeze(v); } };
  freeze(cloned); return cloned;
};
const key = (peer: string, message: string) => JSON.stringify([peer, message]);
const id = (v: string) => typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(v);
// Preserve actual lifecycle/code/retryability, but never publish transport stderr or private filesystem
// exception text carried by registry problem.message. Diagnostics still use the central allowlist.
const publicStatus = (status: LanguageView): LanguageView => copy({ ...status, problem: status.problem ? {
  ...status.problem,
  message: status.problem.code === 'PROCESS_STOP_UNCONFIRMED' ? 'Language process retirement is unconfirmed.' : 'Language service is unavailable.',
  recovery: 'Reconcile the retained language owner or verify the selected runtime preparation, then retry.',
} : null });
const sync = (result: unknown): void => { if (result !== undefined) throw new Error('Synchronous language authority required'); };

/** A single backend consumer, not a wire issuer or source writer. All asynchronous source capture is
 * delegated to the existing selected factory; the backend retains its SAME gate through ACK joining.
 */
export function createRuntimeLanguageBinding(options: RuntimeLanguageBindingOptions): {
  start(): Promise<LanguageView>;
  view(): LanguageView;
  bootstrap(): LanguageBootstrapV2;
  handle(peerId: string, message: LanguageClientMessage): Promise<CompleteResult | null>;
  beginSave(input: LanguageSaveInput): PendingLanguageSave | null;
  prepareSaveAcknowledgement(lease: SelectedLanguageLease): Promise<void>;
  publishSaveAck(pending: PendingLanguageSave | null, receiptId: string, publish: () => void): boolean;
  fileOperation(operation: LanguageFileOperation): Promise<void>;
  invalidateSource(): void;
  refreshSource(): Promise<void>;
  retire(): Promise<{ confirmed: boolean; status: LanguageView }>;
} {
  for (const callback of [options.assertCurrent, options.assertPeer, options.emit, options.sourceAuthority?.capture,
    options.sourceAuthority?.isCurrent, options.saveAuthority?.readCurrent, options.saveAuthority?.readCommittedSave,
    options.selected?.withSourceLease]) if (typeof callback !== 'function') throw new Error('Missing actual language authority callback');
  const scope = copy(options.scope), assertOwner = options.assertCurrent.bind(options), assertPeer = options.assertPeer.bind(options), emit = options.emit.bind(options);
  const source = { capture: options.sourceAuthority.capture.bind(options.sourceAuthority), isCurrent: options.sourceAuthority.isCurrent.bind(options.sourceAuthority) };
  const save = { readCurrent: options.saveAuthority.readCurrent.bind(options.saveAuthority), readCommittedSave: options.saveAuthority.readCommittedSave.bind(options.saveAuthority) };
  let retired = false, clearing = false, started: Promise<LanguageView> | null = null, retirement: Promise<{ confirmed: boolean; status: LanguageView }> | null = null;
  let unsubscribe: (() => void) | null = null, latest: LanguageView | null = null;
  let sourceRevocation = 0;
  let prepared: { snapshot: RegistrySnapshot; lease: SelectedLanguageLease } | null = null, preparation = 0;
  const documents = new Map<string, { peer: string; message: Readonly<LanguageClientMessage>; stamp: Readonly<DocumentStamp> }>();
  const peers = new Set<string>();
  const guard = () => { if (retired) throw new Error('Language binding retired; retained owner may only retire'); sync(assertOwner()); };
  const inScope = (stamp: Readonly<DocumentStamp>) => stamp.projectId === scope.projectId && stamp.sessionId === scope.sessionId && stamp.profileId === scope.profile.id &&
    stamp.configurationGeneration === scope.configurationGeneration && stamp.connectionGeneration === scope.connectionGeneration &&
    stamp.providerGeneration === scope.providerGeneration && stamp.shadowGeneration === scope.shadowGeneration;
  const snapshot = (): RegistrySnapshot => {
    guard(); const captured = copy(source.capture(scope)); guard();
    if (source.isCurrent(scope, captured) !== true) throw new Error('Stale complete language source vector');
    guard(); return captured;
  };
  const current = (captured: RegistrySnapshot): boolean => {
    try { guard(); const valid = source.isCurrent(scope, captured) === true; guard(); return valid; } catch { return false; }
  };
  const selected = createSelectedCacheLanguageFactory({ ...options.selected, preparedOutputRoots: [...options.selected.preparedOutputRoots] });
  let registry!: LanguageFeatureRegistry;
  const ledger = new LanguageAckLedger({
    readCurrent(peer, path) {
      guard(); const value = save.readCurrent(peer, path); guard();
      if (!value || !documents.has(key(peer, value.documentMessageId)) || !inScope(value.stamp)) return null;
      const original = documents.get(key(peer, value.documentMessageId))!;
      sync(assertPeer(peer, original.message)); guard();
      if (original.stamp.path !== path) return null;
      const captured = snapshot();
      return captured.revision === value.projectRevision && captured.documents.some(d => same(d.stamp, value.stamp) && d.content === value.content) ? copy(value) : null;
    },
    readAnalysisSource(peer, message) {
      guard(); const captured = documents.get(key(peer, message));
      if (!captured) return null;
      sync(assertPeer(peer, captured.message)); guard(); return registry.readSentAnalysisSource(captured.stamp);
    },
    readCommittedSave(request, receipt) { guard(); const commit = save.readCommittedSave(request, receipt); guard(); return commit ? copy(commit) : null; },
  }, codec);
  registry = new LanguageFeatureRegistry({ factory: selected.factory, ackLedger: ledger,
    authority: { capture: () => snapshot(), isCurrent: (_scope, captured) => current(captured) } });
  const forward = (event: LanguageEvent) => {
    // disposeProject synchronously clears real published diagnostics BEFORE its first await. Only that
    // exact invalidation may pass after revocation; late callbacks cannot reopen retired decorations.
    if (!clearing) { try { guard(); } catch { return; } }
    if (clearing && event.type !== 'DIAGNOSTICS') return;
    const captured = copy(event);
    if (captured.type === 'STATUS') {
      if (!validateLanguageView(captured.status) || captured.status.projectId !== scope.projectId || captured.status.profileId !== scope.profile.id ||
        captured.status.configurationGeneration !== scope.configurationGeneration || captured.status.providerGeneration !== scope.providerGeneration) return;
      latest = publicStatus(captured.status);
    } else if (!validateDiagnosticsResult(captured.result) || !inScope(captured.result.sourceStamp) || !inScope(captured.result.presentationStamp) ||
      clearing && captured.result.items.length !== 0) return;
    try { emit(captured.type === 'STATUS' ? copy({ type: 'STATUS', status: latest! }) : captured); } catch { /* Publication observers confer neither ownership nor save authority. */ }
  };
  const requireStarted = () => { guard(); if (!started || !registry.getProjectScope()) throw new Error('Language binding not started'); };
  const revokePreparation = () => { preparation++; prepared = null; };
  const revokeSource = () => {
    sourceRevocation++; revokePreparation();
    for (const peer of peers) ledger.retirePeer(peer);
    peers.clear(); documents.clear(); selected.authority.invalidate();
    // Pre-start and retired bindings have no new scope to manufacture. A just-revoked
    // current-owner guard must NOT suppress the real synchronous marker invalidation.
    if (!retired && registry.getProjectScope()) {
      const wasClearing = clearing; clearing = true;
      try { registry.invalidateSource(scope); } finally { clearing = wasClearing; }
    }
  };
  const preparedCurrent = (value: NonNullable<typeof prepared>): boolean => {
    try { guard(); sync(value.lease.assertCurrent()); sync(value.lease.assertRetainedCurrent());
      if (!current(value.snapshot) || value.lease.source.leaseId !== value.snapshot.revision) return false;
      selected.authority.capture(scope, value.snapshot); guard(); return true;
    } catch { return false; }
  };
  return {
    start() {
      guard();
      if (!started) {
        const starting = registry.startProject(scope);
        // First project admission is synchronous; subscribe before any scheduled provider await.
        unsubscribe = registry.subscribe(scope, forward);
        started = starting.then(status => { guard(); if (!latest) forward({ type: 'STATUS', status }); return copy(latest ?? publicStatus(status)); });
      }
      return started;
    },
    view() { if (!latest) throw new Error('No actual language status yet'); return copy(latest); },
    bootstrap() { guard(); return copy({ connectionGeneration: scope.connectionGeneration, shadowGeneration: scope.shadowGeneration,
      provider: scope.profile.language.provider === 'builtin' ? 'builtin' : scope.profile.language.provider === 'off' ? 'off' : 'remote' }); },
    async handle(peer, message) {
      const captured = copy(message); requireStarted();
      const revocation = sourceRevocation;
      if (!id(peer) || !validateLanguageClientMessage(captured) || !inScope(captured.payload.stamp) || captured.sessionId !== scope.sessionId)
        throw new Error('Invalid language message/scope');
      sync(assertPeer(peer, captured)); guard();
      const before = snapshot();
      if (captured.type === 'LANGUAGE_OPEN' || captured.type === 'LANGUAGE_CHANGE') {
        const document = captured.payload;
        if (!before.documents.some(d => same(d, document))) throw new Error('Language overlay not admitted by backend authority');
        // Check capacity before effects. Existing ledger separately enforces byte/transaction limits.
        if (!documents.has(key(peer, captured.messageId)) && documents.size >= 8192) throw new Error('Language correlation capacity; retire scope');
        revokePreparation();
        await (captured.type === 'LANGUAGE_OPEN' ? registry.open(document) : registry.change(document));
        guard(); sync(assertPeer(peer, captured));
        if (revocation !== sourceRevocation) throw new Error('Language source admission revoked');
        if (!current(before)) throw new Error('Language admission superseded');
        ledger.observeDocument(peer, captured.messageId, document);
        for (const [k, old] of documents) if (old.peer === peer && old.stamp.path === document.stamp.path) documents.delete(k);
        documents.set(key(peer, captured.messageId), { peer, message: captured, stamp: copy(document.stamp) }); peers.add(peer);
      } else if (captured.type === 'LANGUAGE_CLOSE') {
        if (before.documents.some(d => d.stamp.path === captured.payload.stamp.path)) throw new Error('Language close not admitted by backend authority');
        revokePreparation();
        for (const [k, old] of documents) if (old.stamp.path === captured.payload.stamp.path) documents.delete(k);
        await registry.close(captured.payload.stamp);
      } else if (captured.type === 'LANGUAGE_COMPLETE') {
        const result = copy(await registry.complete(captured.payload));
        guard(); sync(assertPeer(peer, captured));
        if (revocation !== sourceRevocation || !current(before) || !validateCompleteResult(result) || !same(result.stamp, captured.payload.stamp) || result.requestId !== captured.payload.requestId)
          throw new Error('Stale/unbound language completion');
        return result;
      } else registry.cancel(captured.payload);
      guard(); sync(assertPeer(peer, captured));
      if (revocation !== sourceRevocation || !current(before)) throw new Error('Language operation superseded');
      return null;
    },
    beginSave(input) {
      guard();
      try {
        const captured = copy(input), document = documents.get(key(captured.peerId, captured.languageDocumentMessageId));
        if (!started || !document || document.stamp.path !== captured.path) return null;
        sync(assertPeer(captured.peerId, document.message)); guard();
        return ledger.beginSave(captured);
      } catch { return null; } // No language capture must never block an ordinary authorized save.
    },
    async prepareSaveAcknowledgement(lease) {
      requireStarted(); const request = ++preparation; prepared = null;
      const captured = snapshot();
      try {
        sync(lease.assertCurrent()); sync(lease.assertRetainedCurrent()); guard();
        await selected.authority.prepare(scope, captured, lease);
        guard(); sync(lease.assertCurrent()); sync(lease.assertRetainedCurrent());
        if (request !== preparation || !current(captured)) throw new Error('Language ACK preparation superseded');
        prepared = { snapshot: captured, lease };
      } catch (error) { if (request === preparation) prepared = null; throw error; }
    },
    publishSaveAck(pending, receipt, publish) {
      guard(); if (typeof publish !== 'function') throw new Error('Missing authentic save publication');
      const held = prepared;
      const proof = pending && held && preparedCurrent(held) ? ledger.commitSave(pending, receipt) : null;
      guard(); sync(publish()); // Exactly once; failures propagate, no ACK association or hidden rebroadcast.
      guard();
      if (!proof || !held || held !== prepared || !preparedCurrent(held) || !ledger.isVerified(proof)) return false;
      registry.acknowledge(proof); return true; // Valid same-issuer join attempt, NOT a new analysis claim.
    },
    invalidateSource: revokeSource,
    async refreshSource() {
      requireStarted(); revokeSource();
      const revocation = sourceRevocation, before = snapshot();
      await registry.refreshSource(scope);
      guard();
      if (revocation !== sourceRevocation || !current(before)) throw new Error('Language source refresh superseded');
    },
    async fileOperation(operation) {
      const captured = copy(operation); requireStarted();
      if (!validateLanguageFileOperation(captured)) throw new Error('Invalid successful file operation feed');
      const before = snapshot(); revokePreparation();
      await registry.fileOperation(scope, captured); guard();
      if (!current(before)) throw new Error('File operation superseded');
    },
    retire() {
      if (retirement) return retirement;
      retired = true; revokeSource();
      if (!registry.getProjectScope()) {
        // Establish the actual registry scope solely for disposal; no scheduled provider can run before
        // dispose's synchronous invalidation below. Do not fabricate a successful empty status.
        void registry.startProject(scope);
      }
      const wasClearing = clearing; clearing = true;
      let disposing: ReturnType<LanguageFeatureRegistry['disposeProject']>;
      try { disposing = registry.disposeProject(scope); } // synchronous invalidate/clear before first await
      finally { clearing = wasClearing; }
      unsubscribe?.(); unsubscribe = null;
      retirement = disposing.then(result => { latest = publicStatus(result.status); return copy({ confirmed: result.confirmed, status: latest }); }).finally(() => { retirement = null; });
      return retirement; // On false retain SAME registry/selected/admission; only explicit retire retries.
    },
  };
}
