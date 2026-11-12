import type { AcceptanceState, CompleteRequest, CompleteResult, DiagnosticsResult, DocumentStamp, LanguageClientMessage, LanguageServerMessage, LanguageView, OpenOrChange } from '../shared/language-v2';
import { validateCompleteRequest, validateDocumentStamp, validateLanguageClientMessage, validateLanguageServerMessage } from '../shared/validation-v2';

export interface LanguageClientV2Dependencies {
  /** The existing authenticated ordered session transport; this class never opens a socket. */
  send(message: LanguageClientMessage): void;
  identity(): { sessionId: string; clientId: string; connectionGeneration: string } | null;
  current(path: string): Readonly<AcceptanceState> | null;
  /** Synchronous hash of actual normalized current model bytes, supplied by model authority. */
  contentSha256(content: string): string;
  /** Verify authenticated analysis generation/source and the ordered save-transaction proof for ACK aliases.
   * A public saveReceiptId is never proof; no ACK/file-write endpoint is called here. */
  verifyDiagnostics(result: Readonly<DiagnosticsResult>, current: Readonly<AcceptanceState>): boolean;
  messageId(): string;
  /** Synchronously hide/invalidate the public acceptance widget before any send/await. */
  invalidate(reason: string): void;
}
export type LanguageClientV2Event =
  | { type: 'completion'; result: CompleteResult }
  | { type: 'diagnostics'; result: DiagnosticsResult }
  | { type: 'status'; view: LanguageView }
  | { type: 'clear'; reason: string };
const copy = <T,>(v: T): T => structuredClone(v);
export function sameDocumentStamp(a: Readonly<DocumentStamp>, b: Readonly<DocumentStamp>): boolean {
  return Object.keys(a).length === Object.keys(b).length && Object.keys(a).every(k => a[k as keyof DocumentStamp] === b[k as keyof DocumentStamp]);
}
/** No persistence/ACK/file-write API. Cancellation is advisory; exact current authority is the fence. */
export class LanguageClientV2 {
  private listeners = new Set<(event: LanguageClientV2Event) => void>();
  private pending = new Map<string, CompleteRequest>();
  private sent: DocumentStamp[] = [];
  private usedRequests = new Set<string>();
  private sequence = -1;
  private connection: string | null = null;
  private disposed = false;
  constructor(private readonly dependencies: LanguageClientV2Dependencies) {}
  subscribe(listener: (event: LanguageClientV2Event) => void): () => void {
    this.listeners.add(listener); return () => this.listeners.delete(listener);
  }
  current(path: string): Readonly<AcceptanceState> | null { return this.dependencies.current(path); }
  private emit(event: LanguageClientV2Event) { for (const listener of this.listeners) listener(copy(event)); }
  private authority(stamp: DocumentStamp, forCompletion = false): Readonly<AcceptanceState> | null {
    const id = this.dependencies.identity(), a = this.current(stamp.path);
    if (this.disposed || !id || !a || !validateDocumentStamp(stamp) || id.sessionId !== stamp.sessionId ||
      id.connectionGeneration !== stamp.connectionGeneration || !a.connected || !a.synced ||
      !sameDocumentStamp(a.stamp, stamp) || /\r\n/.test(a.content) || this.dependencies.contentSha256(a.content) !== stamp.contentSha256) return null;
    if (forCompletion && (a.writeOwner !== 'STUDENT' || a.controlPrepare || a.vetoPending || a.conflict || a.readOnly)) return null;
    return a;
  }
  private send(type: LanguageClientMessage['type'], payload: LanguageClientMessage['payload']): boolean {
    // Historical compatibility surface only. Lightweight never emits remote language frames.
    return false;
  }

  private syncConnection() {
    const connection = this.dependencies.identity()?.connectionGeneration ?? null;
    if (connection !== this.connection) {
      this.invalidate('CONNECTION_CHANGED'); this.sequence = -1; this.sent = []; this.usedRequests.clear(); this.connection = connection;
    }
  }
  open(change: OpenOrChange): boolean { return this.changeOrOpen('LANGUAGE_OPEN', change); }
  change(change: OpenOrChange): boolean { return this.changeOrOpen('LANGUAGE_CHANGE', change); }
  private changeOrOpen(type: 'LANGUAGE_OPEN' | 'LANGUAGE_CHANGE', change: OpenOrChange): boolean {
    this.syncConnection();
    const a = this.authority(change.stamp); if (!a || a.content !== change.content) return false;
    this.invalidate('MODEL_CHANGED');
    this.sent.push(copy(change.stamp)); if (this.sent.length > 256) this.sent.shift();
    try { if (this.send(type, change)) return true; }
    catch (error) { this.sent = []; throw error; }
    this.sent = []; return false;
  }
  complete(request: CompleteRequest): boolean {
    this.syncConnection();
    if (!validateCompleteRequest(request) || !this.authority(request.stamp, true) || this.usedRequests.has(request.requestId) || this.usedRequests.size >= 4096) return false;
    this.cancel();
    // Register before synchronous injected send, which may deliver an immediate response.
    this.usedRequests.add(request.requestId);
    this.pending.set(request.requestId, copy(request));
    try { if (this.send('LANGUAGE_COMPLETE', request)) return true; }
    catch (error) { this.pending.delete(request.requestId); throw error; }
    this.pending.delete(request.requestId); return false;
  }
  cancel(): void {
    const requests = [...this.pending.values()]; this.pending.clear();
    for (const request of requests) {
      if (request.stamp.connectionGeneration === this.dependencies.identity()?.connectionGeneration)
        this.send('LANGUAGE_CANCEL', { requestId: request.requestId, stamp: request.stamp });
    }
  }
  /** Call FIRST on CONTROL_PREPARE (even denied), Veto, conflict, ACK transition, scope or disconnect. */
  invalidate(reason: string): void {
    if (reason !== 'ACK_TRANSITION') this.sent = [];
    this.dependencies.invalidate(reason); this.emit({ type: 'clear', reason }); this.cancel();
  }
  close(stamp: DocumentStamp): boolean {
    this.invalidate('MODEL_CLOSED'); this.sent = this.sent.filter(s => s.path !== stamp.path || s.modelLifetime !== stamp.modelLifetime);
    return this.authority(stamp) !== null && this.send('LANGUAGE_CLOSE', { stamp });
  }
  /** Feed only messages dispatched by the existing authenticated, ordered transport. */
  receive(input: unknown): boolean {
    this.syncConnection();
    if (this.disposed || !validateLanguageServerMessage(input)) return false;
    const message: LanguageServerMessage = input, id = this.dependencies.identity();
    if (!id || message.sessionId !== id.sessionId || message.seq <= this.sequence) return false;
    this.sequence = message.seq;
    if (message.type === 'COMPLETE_RESULT') {
      const r = message.payload, request = this.pending.get(r.requestId);
      if (!request || !sameDocumentStamp(request.stamp, r.stamp)) return false;
      this.pending.delete(r.requestId);
      if (!this.authority(r.stamp, true)) return false;
      this.emit({ type: 'completion', result: r }); return true;
    }
    if (message.type === 'DIAGNOSTICS') {
      const r = message.payload, a = this.authority(r.presentationStamp);
      if (!a || !this.sent.some(s => sameDocumentStamp(s, r.sourceStamp)) ||
        !this.dependencies.verifyDiagnostics(copy(r), a)) return false;
      this.emit({ type: 'diagnostics', result: r }); return true;
    }
    // Language status has no connection/shadow stamp: caller must scope its authenticated dispatch.
    const view = message.payload;
    if (!this.sent.some(s => this.authority(s) && s.projectId === view.projectId && s.profileId === view.profileId &&
      s.configurationGeneration === view.configurationGeneration && s.providerGeneration === view.providerGeneration)) return false;
    this.emit({ type: 'status', view }); return true;
  }
  dispose(): void { this.invalidate('DISPOSED'); this.disposed = true; this.sent = []; this.listeners.clear(); }
}
