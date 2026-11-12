import type { LanguageAckLedger } from './LanguageAckLedger';
import type { VerifiedLanguageAck } from './ports';
import { isDeepStrictEqual } from 'node:util';
import type { AnalysisSource, CompleteRequest, CompleteResult, DiagnosticsResult, DocumentStamp, LanguageState, OpenOrChange } from '../../shared/language-v2';
import { LANGUAGE_LIMITS } from '../../shared/language-v2';
import { validateCompleteRequest, validateOpenOrChange } from '../../shared/validation-v2';
import { projectCompletion, type CompletionProjectionCodec } from './CompletionProjection';
import { normalizePylspCompletion } from './PylspCompletionProjection';
import { projectDiagnostics } from './DiagnosticProjection';
import type { DockerLanguageProcess, LanguageProcessRetirement } from './DockerLanguageProcess';
import type { JsonRpcTransport, RpcNotification } from './JsonRpcTransport';
import type { LanguageShadow } from './LanguageShadowStore';
export interface SessionCodec extends CompletionProjectionCodec { fromWorkspaceUri(uri: string): string }
export interface LanguageServerSessionOptions {
  process: Pick<DockerLanguageProcess, 'intent' | 'start' | 'retire'>;
  shadow: LanguageShadow; codec: SessionCodec;
  /** Actual backend full-source/dependency/overlay scope lease + shadow integrity. Throws on stale state. */
  assertCurrent(shadow: LanguageShadow): void;
  /** Pinned backend provider settings (offline imports/dependency layout), NEVER client/LSP authority. */
  settings: Readonly<Record<string, unknown>>;
  /** Internal factory composition identity, never supplied by a wire ACK. */
  ackLedger?: LanguageAckLedger;
  /** Canonical trusted imported Java task/project URI, NOT a client-provided path. */
  expectedProjectUri?: string;
  onState?: (state: LanguageState, problem: string | null) => void;
  onDiagnostics?: (result: DiagnosticsResult) => void;
  /** Exact source becomes available ONLY at didOpen/didChange send, before any reply. */
  onSourceSent?: (stamp: Readonly<DocumentStamp>, source: Readonly<AnalysisSource>) => void;
}
interface SentDocument { document: Readonly<OpenOrChange>; uri: string; lspVersion: number; source: Readonly<AnalysisSource> }
interface SentRequest { request: Readonly<CompleteRequest>; document: SentDocument; controller: AbortController; rpcId: string | null }
const copy = <T>(v: T): T => structuredClone(v);
const freeze = <T>(v: T): T => { if (v && typeof v === 'object') { Object.values(v).forEach(freeze); Object.freeze(v); } return v; };
const same = isDeepStrictEqual;
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const scopeKeys = ['projectId', 'sessionId', 'profileId', 'configurationGeneration', 'providerGeneration', 'shadowGeneration', 'connectionGeneration'] as const;
/**
 * ONE container/connection; no original-source writes and no save authority. Immutable diagnostic connections
 * open fixed manifest overlays once; mutable completion pushes NEVER supply diagnostics. Retirement always
 * belongs to the real process, including failed initialize, pipe failure and cancelled/late replies.
 */
export class LanguageServerSession {
  private shadow: LanguageShadow;
  private rpc: JsonRpcTransport | null = null;
  private startOperation: Promise<void> | null = null;
  private unsubscribe: (() => void) | null = null;
  private unsubscribeClosed: (() => void) | null = null;
  private earlyDiagnostics = new Map<string, DiagnosticsResult>();
  private queue: Promise<void> = Promise.resolve();
  private documents = new Map<string, SentDocument>();
  private presentations = new Map<string, { previous: Readonly<DocumentStamp>; stamp: Readonly<DocumentStamp> }>();
  private versions = new Map<string, number>();
  private requests = new Map<string, SentRequest>();
  private seenRequests = new Set<string>();
  private cancelledRequests = new Set<string>();
  private accepting = true;
  private documentRevision = 0;
  private initialized = false;
  private started = false;
  private statusStarted = false;
  private importOperation: Promise<void> | null = null;
  private stateValue: LanguageState = 'INDEXING';
  private retirement: Promise<LanguageProcessRetirement> | null = null;
  private analysisTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly settings: Readonly<Record<string, unknown>>;
  constructor(private readonly options: LanguageServerSessionOptions) {
    this.shadow = options.shadow; this.settings = freeze(copy(options.settings));
    const intent = options.process.intent, identity = this.shadow.manifest.identity;
    if (intent.launchId !== this.shadow.launchId || intent.phase !== this.shadow.phase || intent.provider !== identity.provider ||
      intent.imageId !== identity.imageId || scopeKeys.some(k => intent[k] !== identity[k])) throw new Error('Session/process/shadow identity mismatch');
  }
  get state(): LanguageState { return this.stateValue; }
  get launchId(): string { return this.shadow.launchId; }
  private stateTo(state: LanguageState, problem: string | null = null): void {
    this.stateValue = state; try { this.options.onState?.(state, problem); } catch { /* Observer cannot acquire process authority. */ }
  }
  private current(): void {
    if (!this.accepting) throw new Error('Language session retired/failed');
    if (this.rpc?.closed) throw new Error('Language transport closed; actual process retirement required');
    this.options.assertCurrent(this.shadow);
  }
  private cancelAll(): void { this.documentRevision++; for (const r of this.requests.values()) r.controller.abort(); this.requests.clear(); }
  /** Revoke queued/in-flight completions synchronously before a controlled mutable shadow refresh. */
  cancelCompletions(): void { this.cancelAll(); }
  /** Synchronous revoke BEFORE any await. Unknown Stop keeps this SAME actual process owner for reconcile. */
  invalidate(problem = 'Language source/scope changed'): void {
    if (!this.accepting) return;
    this.accepting = false; this.initialized = false; this.cancelAll(); this.documents.clear(); this.presentations.clear();
    if (this.analysisTimer) clearTimeout(this.analysisTimer); this.analysisTimer = null;
    this.unsubscribe?.(); this.unsubscribe = null; this.unsubscribeClosed?.(); this.unsubscribeClosed = null; this.earlyDiagnostics.clear();
    this.rpc?.close(new Error(problem)); this.stateTo('FAILED', problem);
  }
  private failure(error: unknown): void {
    this.invalidate(error instanceof Error ? error.message : String(error));
    // Observe rejection: process.retire returns explicit uncertainty, never let a rejection erase ownership.
    void this.retire().catch(() => {});
  }
  start(): Promise<void> {
    if (this.startOperation) return this.startOperation;
    this.startOperation = this.initialize().catch(error => { this.failure(error); throw error; });
    return this.startOperation;
  }
  private async initialize(): Promise<void> {
    this.current(); this.stateTo('INDEXING');
    if (this.shadow.phase === 'diagnostics') this.analysisTimer = setTimeout(() => this.failure(new Error('Immutable diagnostic analysis deadline')), LANGUAGE_LIMITS.diagnosticAnalysisMs);
    this.rpc = await this.options.process.start(); this.current();
    this.unsubscribe = this.rpc.subscribe(this.notification);
    this.unsubscribeClosed = this.rpc.subscribeClosed(error => this.failure(error));
    const raw = await this.rpc.request('initialize', {
      processId: null, rootUri: 'file:///workspace', workspaceFolders: [{ uri: 'file:///workspace', name: 'PairCoach' }],
      capabilities: { general: { positionEncodings: ['utf-16'] }, workspace: { configuration: true, workspaceFolders: true, applyEdit: false },
        textDocument: { synchronization: { didSave: false, willSave: false, willSaveWaitUntil: false },
          completion: { completionItem: { snippetSupport: false, commitCharactersSupport: false, deprecatedSupport: false,
            insertReplaceSupport: false, labelDetailsSupport: false }, completionList: { itemDefaults: [] } },
          publishDiagnostics: { versionSupport: true, relatedInformation: false } } },
      initializationOptions: { settings: this.settings, extendedClientCapabilities: { classFileContentsSupport: false } },
    }, { timeoutMs: LANGUAGE_LIMITS.diagnosticAnalysisMs });
    this.current();
    if (!record(raw) || !record(raw.capabilities)) throw new Error('Invalid initialize response');
    const caps = raw.capabilities, sync = caps.textDocumentSync;
    if (caps.positionEncoding !== undefined && caps.positionEncoding !== 'utf-16') throw new Error('Provider does not use UTF16');
    if (!record(caps.completionProvider) || !(sync === 1 || sync === 2 ||
      record(sync) && sync.openClose === true && (sync.change === 1 || sync.change === 2))) throw new Error('Provider lacks full-content open/change/completion capabilities');
    await this.rpc.notify('initialized', {}); this.current();
    await this.rpc.notify('workspace/didChangeConfiguration', { settings: this.settings }); this.current();
    this.initialized = true;
    if (this.statusStarted) this.verifyJdtImport();
    // Initialize alone is NOT semantic readiness. JDT Started additionally gates completion; pylsp proves
    // real response on its first completion/diagnostic. Empty/malformed/unsupported replies never turn ON.
  }
  private verifyJdtImport(): void {
    if (!this.initialized || this.importOperation || this.shadow.manifest.identity.provider !== 'jdt') return;
    this.importOperation = (async () => {
      this.current();
      const uri = this.options.expectedProjectUri ?? 'file:///workspace';
      if (uri !== 'file:///workspace' && this.options.codec.toWorkspaceUri(this.options.codec.fromWorkspaceUri(uri)) !== uri) throw new Error('Invalid trusted Java project URI');
      const projects = await this.rpc!.request('workspace/executeCommand', { command: 'java.project.getAll', arguments: [] }, { timeoutMs: 10000 });
      this.current();
      if (!Array.isArray(projects) || projects.length > 1000 || projects.some(v => typeof v !== 'string') || !projects.some(v => v === uri || v === uri + '/')) throw new Error('JDT did not import exact semantic project');
      this.started = true;
      for (const result of this.earlyDiagnostics.values()) { this.current(); this.stateTo('ON'); this.options.onDiagnostics?.(result); }
      this.earlyDiagnostics.clear();
    })().catch(error => { this.failure(error); });
  }
  private validateDocument(input: OpenOrChange): Readonly<OpenOrChange> {
    if (!validateOpenOrChange(input)) throw new Error('Invalid language document');
    const doc = freeze(copy(input)), identity = this.shadow.manifest.identity;
    if (scopeKeys.some(k => doc.stamp[k] !== identity[k]) || this.options.codec.contentSha256(doc.content) !== doc.stamp.contentSha256)
      throw new Error('Document not in exact language scope/hash');
    const overlay = this.shadow.manifest.overlays.find(s => s.path === doc.stamp.path);
    if (!overlay || !same(overlay, doc.stamp)) throw new Error('Document not in captured shadow overlay');
    const file = this.shadow.manifest.files.find(f => f.path === doc.stamp.path);
    if (!file || file.origin !== 'overlay' || file.sha256 !== doc.stamp.contentSha256 || file.uri !== this.options.codec.toWorkspaceUri(doc.stamp.path))
      throw new Error('Document missing from exact shadow bytes');
    return freeze({ ...doc, content: this.options.codec.normalizeContent(doc.content) });
  }
  /** Only after owned completion shadow refresh succeeds; NOT allowed for an immutable diagnostic launch. */
  replaceCompletionShadow(next: LanguageShadow): void {
    if (!this.accepting || this.rpc?.closed) throw new Error('Language session retired/failed');
    if (this.shadow.phase !== 'completion' || next.phase !== 'completion' || next.launchId !== this.launchId ||
      !same(next.manifest.identity, this.shadow.manifest.identity) || next.manifest.dependencyInventorySha256 !== this.shadow.manifest.dependencyInventorySha256)
      throw new Error('Cannot replace immutable/foreign language shadow');
    this.options.assertCurrent(next); this.cancelAll(); this.shadow = next;
  }
  /** Internal factory handoff only, after its SAME-issuer before/after whole-project check. Retains every
   * sent document/source/provenance and returned result unchanged. Only NEW requests see presentation.
   */
  acknowledgePresentation(proof: VerifiedLanguageAck, ledger: LanguageAckLedger): void {
    if (this.options.ackLedger !== ledger || this.shadow.phase !== 'completion' || !ledger.isVerified(proof)) throw new Error('Unverified completion presentation');
    const original = this.shadow.manifest.overlays.find(s => s.path === proof.previous.path);
    if (!original || !same(original, proof.previous)) throw new Error('ACK not in sent completion shadow');
    this.current();
    if (same(this.presentations.get(original.path)?.stamp, proof.presentation)) return;
    this.cancelAll(); this.presentations.set(original.path, freeze(copy({ previous: proof.previous, stamp: proof.presentation })));
  }
  private presentation(doc: SentDocument): Readonly<DocumentStamp> {
    const entry = this.presentations.get(doc.document.stamp.path);
    return entry && same(entry.previous, doc.document.stamp) ? entry.stamp : doc.document.stamp;
  }
  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation); this.queue = result.then(() => {}, () => {}); return result;
  }
  open(input: OpenOrChange): Promise<void> { this.cancelAll(); return this.sendDocument(input, false); }
  change(input: OpenOrChange): Promise<void> {
    if (this.shadow.phase === 'diagnostics') return Promise.reject(new Error('Immutable diagnostics never didChange'));
    this.cancelAll(); return this.sendDocument(input, true);
  }
  private sendDocument(input: OpenOrChange, change: boolean): Promise<void> {
    const captured = this.validateDocument(input);
    return this.enqueue(async () => {
      try {
        await this.start(); this.current();
        // Recheck captured source AFTER queued initialize/previous mutation, never read receipt-time latest.
        this.validateDocument(captured);
        if (!this.initialized || !this.rpc) throw new Error('Language session not initialized');
        const path = captured.stamp.path, prior = this.documents.get(path), uri = this.options.codec.toWorkspaceUri(path);
        if (change && !prior || !change && prior) throw new Error('didOpen/didChange lifecycle mismatch');
        const activeBytes = [...this.documents.values()].reduce((n, d) => n + d.document.content.length * 2, 0);
        if (activeBytes - (prior?.document.content.length ?? 0) * 2 + captured.content.length * 2 > 32 * 1024 * 1024) throw new Error('Language document memory bound');
        if (prior && (captured.stamp.modelLifetime !== prior.document.stamp.modelLifetime ||
          captured.stamp.localModelVersion <= prior.document.stamp.localModelVersion || captured.stamp.requestGeneration < prior.document.stamp.requestGeneration))
          throw new Error('Nonmonotonic language model; close old lifetime before reopen');
        const version = (this.versions.get(path) ?? 0) + 1;
        if (this.versions.size >= 1000 && !this.versions.has(path) || version >= Number.MAX_SAFE_INTEGER) throw new Error('Language version ledger limit');
        const source: Readonly<AnalysisSource> = freeze({ sourceStamp: copy(captured.stamp), provenance: this.shadow.phase === 'diagnostics'
          ? { kind: 'IMMUTABLE_GENERATION', launchId: this.launchId, lspVersion: version, inputManifestSha256: this.shadow.inputManifestSha256 }
          : { kind: 'VERSIONED_PUSH', lspVersion: version, inputManifestSha256: this.shadow.inputManifestSha256 } });
        const sent: SentDocument = freeze({ document: captured, uri, lspVersion: version, source });
        const sentHook = () => {
          this.current();
          const presentation = this.presentations.get(path);
          if (presentation && !same(presentation.previous, captured.stamp)) this.presentations.delete(path);
          this.versions.set(path, version); this.documents.set(path, sent);
          this.options.onSourceSent?.(captured.stamp, source);
        };
        if (change) await this.rpc.notify('textDocument/didChange', { textDocument: { uri, version }, contentChanges: [{ text: captured.content }] }, sentHook);
        else await this.rpc.notify('textDocument/didOpen', { textDocument: { uri, version, languageId: this.shadow.manifest.identity.provider === 'jdt' ? 'java' : 'python', text: captured.content } }, sentHook);
        this.current();
      } catch (error) { this.failure(error); throw error; }
    });
  }
  close(stamp: DocumentStamp): Promise<void> {
    if (this.shadow.phase === 'diagnostics') return Promise.reject(new Error('Immutable diagnostics close only by process retirement'));
    this.cancelAll(); const captured = freeze(copy(stamp));
    return this.enqueue(async () => {
      try {
        this.current(); const sent = this.documents.get(captured.path);
        if (!sent || !same(this.presentation(sent), captured) || !this.rpc) throw new Error('Close does not match exact sent model');
        await this.rpc.notify('textDocument/didClose', { textDocument: { uri: sent.uri } }, () => { this.current(); this.documents.delete(captured.path); this.presentations.delete(captured.path); });
        this.current();
      } catch (error) { this.failure(error); throw error; }
    });
  }
  async complete(input: CompleteRequest, signal?: AbortSignal): Promise<CompleteResult> {
    if (!validateCompleteRequest(input) || this.shadow.phase !== 'completion') throw new Error('Invalid completion session/request');
    const request = freeze(copy(input)), revision = this.documentRevision;
    if (this.seenRequests.has(request.requestId) || this.seenRequests.size >= 8192) throw new Error('Duplicate/overflow completion request id');
    this.seenRequests.add(request.requestId);
    await this.queue; this.current();
    if (revision !== this.documentRevision || this.cancelledRequests.has(request.requestId) || signal?.aborted) throw new Error('Cancelled completion before send');
    const doc = this.documents.get(request.stamp.path);
    if (!this.initialized || !this.rpc || !doc || !same(this.presentation(doc), request.stamp) ||
      this.shadow.manifest.identity.provider === 'jdt' && !this.started) throw new Error('Completion source not sent/semantic server still indexing');
    this.validateDocument(doc.document);
    // Validate cursor against exact captured normalized UTF16 content before ANY RPC request.
    projectCompletion(null, { request, content: doc.document.content, workspaceUri: doc.uri }, this.options.codec);
    const controller = new AbortController(), abort = () => controller.abort();
    if (signal?.aborted) controller.abort(); else signal?.addEventListener('abort', abort, { once: true });
    const entry: SentRequest = { request, document: doc, controller, rpcId: null }; this.requests.set(request.requestId, entry);
    try {
      const raw = await this.rpc.request('textDocument/completion', { textDocument: { uri: doc.uri },
        position: { line: request.position.line - 1, character: request.position.column - 1 },
        context: request.trigger === null ? { triggerKind: 1 } : { triggerKind: 2, triggerCharacter: request.trigger } },
      { signal: controller.signal, timeoutMs: 10000, onSent: id => {
        this.current(); if (controller.signal.aborted || this.documents.get(request.stamp.path) !== doc) throw new Error('Completion invalidated before actual send');
        entry.rpcId = id;
      } });
      this.current();
      if (revision !== this.documentRevision || controller.signal.aborted || this.requests.get(request.requestId) !== entry || this.documents.get(request.stamp.path) !== doc || !entry.rpcId)
        throw new Error('Late/replaced completion');
      const capturedInput = { request: entry.request, content: entry.document.document.content, workspaceUri: entry.document.uri };
      const normalized = this.shadow.manifest.identity.provider === 'pylsp' ? normalizePylspCompletion(raw, capturedInput, this.options.codec) : raw;
      const result = projectCompletion(normalized, capturedInput, this.options.codec);
      if (result.items.length > 0) this.stateTo('ON');
      return result;
    } finally { signal?.removeEventListener('abort', abort); if (this.requests.get(request.requestId) === entry) this.requests.delete(request.requestId); }
  }
  cancel(requestId: string): void {
    if (this.seenRequests.has(requestId)) this.cancelledRequests.add(requestId);
    this.requests.get(requestId)?.controller.abort(); this.requests.delete(requestId);
  }
  /** Fixed launch/sent-source reader; never stamps a received diagnostic with the current active model. */
  readSource(stamp: Readonly<DocumentStamp>): Readonly<AnalysisSource> | null {
    try { this.current(); const doc = this.documents.get(stamp.path);
      if (!doc || !same(doc.document.stamp, stamp)) return null; this.validateDocument(doc.document); return doc.source; }
    catch { return null; }
  }
  private notification = (event: RpcNotification): void => {
    try {
      this.current();
      if (event.method === 'language/status' && record(event.params)) {
        if (event.params.type === 'Error') throw new Error('JDT reported startup/index failure');
        if (event.params.type === 'Started') { this.statusStarted = true; this.verifyJdtImport(); }
      }
      if ((event.method === 'window/logMessage' || event.method === 'window/showMessage') && record(event.params) &&
        typeof event.params.message === 'string' && /non-project|not (?:on|in) (?:the )?class.?path|syntax errors? only/i.test(event.params.message))
        throw new Error('Provider did not import semantic project');
      if (event.method === 'textDocument/publishDiagnostics' && this.shadow.manifest.identity.provider === 'jdt' && record(event.params) &&
        Array.isArray(event.params.diagnostics) && event.params.diagnostics.some(d => record(d) && typeof d.message === 'string' &&
          /non-project file|not (?:on|in) (?:the )?class.?path|only syntax errors|syntax errors? only/i.test(d.message))) throw new Error('JDT non-project/classpath diagnostic; semantic import failed');
      if (event.method !== 'textDocument/publishDiagnostics' || this.shadow.phase !== 'diagnostics' || !record(event.params)) return;
      const params = event.params; if (typeof params.uri !== 'string') return;
      let path: string; try { path = this.options.codec.fromWorkspaceUri(params.uri); } catch { return; }
      const doc = this.documents.get(path);
      if (!doc || doc.uri !== params.uri || params.version !== undefined && params.version !== null && params.version !== doc.lspVersion) return;
      const result = projectDiagnostics(params.diagnostics, doc.source, doc.document.content); if (!result) return;
      // Even unversioned messages retain the ORIGINAL fixed sent launch source/provenance unchanged.
      this.current(); freeze(result);
      if (this.shadow.manifest.identity.provider === 'jdt' && !this.started) { this.earlyDiagnostics.set(path, result); return; }
      this.stateTo('ON'); this.options.onDiagnostics?.(result);
    } catch (error) { this.failure(error); }
  };
  retire(): Promise<LanguageProcessRetirement> {
    this.invalidate('Language session retiring; process Stop pending');
    if (this.retirement) return this.retirement;
    this.retirement = this.options.process.retire().then(result => {
      if (!result.confirmed || !result.removed) this.stateTo('FAILED', result.problem ?? 'PROCESS_STOP_UNCONFIRMED');
      return result;
    }).finally(() => { this.retirement = null; });
    return this.retirement;
  }
}
