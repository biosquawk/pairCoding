import type * as M from 'monaco-editor';
import type { AcceptanceState, CompleteRequest, CompleteResult, CompletionAcceptanceFacade, CompletionCandidate, DiagnosticsResult, DocumentStamp, MutationReason, OpenOrChange } from '../shared/language-v2';
import { validateCompletionEdits, validateDiagnosticsResult, validateDocumentStamp } from '../shared/validation-v2';
import { disableNativeCompletionProviders } from './editor-language/native';
export { disableNativeCompletionProviders } from './editor-language/native';
import { createCompletionAcceptance, mayAccept, sameStamp } from './editor-language/acceptance';
import { contentSha256, fromModelUri, normalizeContent } from '../language/uriCodec';
export { toModelUri, fromModelUri, toWorkspaceUri, fromWorkspaceUri, normalizeContent, contentSha256 } from '../language/uriCodec';
export { createCompletionAcceptance } from './editor-language/acceptance';

export interface ModelSnapshot {
  path: string; modelLifetime: string; localModelVersion: number; content: string; contentSha256: string;
}
export interface BridgeAuthority extends Omit<AcceptanceState, 'stamp' | 'content'> {
  /** Monotonic authoritative control/scope revision, not a React render counter. */
  revision: number;
  stamp: Omit<DocumentStamp, 'path' | 'modelLifetime' | 'localModelVersion' | 'contentSha256'>;
}
export type BridgeEvent = { type: 'CONTROL_PREPARE' | 'VETO' | 'DISCONNECTED' | 'SCOPE' | 'CONFLICT' }
  | { type: 'AUTHORITY_CHANGED' }
  | { type: 'DIAGNOSTICS'; result: DiagnosticsResult }
  | { type: 'FILE_OPERATION'; operation: 'CREATE' | 'RENAME' | 'DELETE'; path: string; newPath?: string };
/**
 * Injection over the SAME authenticated ordered transport; no constructor/peer imports or socket/save API.
 * CONTROL_PREPARE MUST be emitted synchronously as the FIRST receive action, before any await/flush/React.
 * A newer authoritative revision is required to release its local latch, including a denied prepare.
 * Authority reads must inspect current client state (not render-time captures). sendDocument enqueues in order.
 */
export interface EditorLanguageBinding {
  readonly projectId: string;
  readAuthority(model: Readonly<ModelSnapshot>): BridgeAuthority | null;
  sendDocument(kind: 'OPEN' | 'CHANGE' | 'CLOSE', document: OpenOrChange): void;
  complete(request: CompleteRequest, signal: AbortSignal): Promise<CompleteResult>;
  cancel(request: { requestId: string; stamp: DocumentStamp }): void;
  subscribe(listener: (event: BridgeEvent) => void): () => void;
  /** Exact immutable sent-source/provenance ledger and verified ACK receipt; presence of association is NOT proof.
   * Must also verify ALL current open overlays/dependencies, not just this file. Never receipt-time association. */
  verifyDiagnostics(result: DiagnosticsResult, currentModels: readonly ModelSnapshot[]): boolean;
  /** Optional worker provider uses the SAME request/facade as server completion, never Monaco's native widget. */
  builtin?: (model: M.editor.ITextModel, request: CompleteRequest, signal: AbortSignal) => Promise<CompleteResult> | null;
  onProblem?(message: string): void;
}
interface Entry {
  model: M.editor.ITextModel; path: string; lifetime: string;
  listener: M.IDisposable; reason?: MutationReason; sent?: OpenOrChange;
  tombstone: boolean;
}
const sameScope = (a:DocumentStamp,b:DocumentStamp) => (['projectId','sessionId','path','profileId','connectionGeneration','configurationGeneration','providerGeneration','shadowGeneration','modelLifetime','controlEpoch'] as const).every(k=>a[k]===b[k]);
interface Flight { request: CompleteRequest; abort: AbortController; entry: Entry }
/** Defense in depth: native registered providers are separately disabled via public mode configuration. */
export const SAFE_SUGGEST_OPTIONS: M.editor.IStandaloneEditorConstructionOptions = {
  quickSuggestions:false, suggestOnTriggerCharacters:false, acceptSuggestionOnEnter:'off',
  acceptSuggestionOnCommitCharacter:false, tabCompletion:'off', wordBasedSuggestions:'off',
  snippetSuggestions:'none', inlineSuggest:{enabled:false},
  suggest:{ preview:false, showMethods:false, showFunctions:false, showConstructors:false,
    showFields:false, showVariables:false, showClasses:false, showStructs:false, showInterfaces:false,
    showModules:false, showProperties:false, showEvents:false, showOperators:false, showUnits:false,
    showValues:false, showConstants:false, showEnums:false, showEnumMembers:false, showKeywords:false,
    showWords:false, showColors:false, showFiles:false, showReferences:false, showFolders:false,
    showTypeParameters:false, showSnippets:false, showUsers:false, showIssues:false },
};
/** One instance per editor/binding lifetime. Observe every project model, including inactive buffers. */
export class MonacoLspBridge {
  readonly acceptance: CompletionAcceptanceFacade;
  private readonly entries = new Map<M.editor.ITextModel,Entry>();
  private readonly disposables: M.IDisposable[] = [];
  private unsubscribe: () => void = () => {};
  private readonly widget: CompletionWidget;
  private readonly baseAcceptance: CompletionAcceptanceFacade;
  private flight?: Flight;
  private dead = false;
  private workGeneration = 0;
  private prepareFloor: number | null = null;
  private blocked = false;
  private lastAuthorityRevision = -1;
  private readonly markerOwner = `paircoach-language-${crypto.randomUUID()}`;
  constructor(private readonly monaco: typeof M, private readonly editor: M.editor.IStandaloneCodeEditor,
    private readonly binding: EditorLanguageBinding) {
    disableNativeCompletionProviders(monaco);
    this.widget = new CompletionWidget(monaco,editor,c => this.acceptance.accept(c));
    this.baseAcceptance = createCompletionAcceptance({
      current: () => this.current(),
      push: candidate => {
        const entry = this.active();
        if (!entry) throw new Error('No live model');
        const edits = [candidate.item.primary,...candidate.item.additionalTextEdits].map(edit => ({
          range: new monaco.Range(edit.range.startLine,edit.range.startColumn,edit.range.endLine,edit.range.endColumn),
          text:edit.text,forceMoveMarkers:true,
        }));
        entry.reason = 'COMPLETION';
        entry.model.pushStackElement();
        try { entry.model.pushEditOperations(editor.getSelections() ?? [],edits,inverse => {
          const p = inverse[0]?.range.getEndPosition();
          return p ? [new monaco.Selection(p.lineNumber,p.column,p.lineNumber,p.column)] : null;
        }); } finally { entry.model.pushStackElement(); entry.reason = undefined; }
      },
      show: items => this.widget.show(items), hide: () => this.widget.hide(), cancelRequests: () => this.cancelFlight(),
    });
    this.acceptance = {
      current: () => this.baseAcceptance.current(), present: r => this.baseAcceptance.present(r),
      accept: c => this.baseAcceptance.accept(c), cancel: () => this.baseAcceptance.cancel(),
      invalidate: reason => this.invalidate(reason),
    };
    // These options remain fail-closed even while unbound or if a provider fails.
    editor.updateOptions(SAFE_SUGGEST_OPTIONS);
    this.disposables.push(monaco.editor.onDidCreateModel(model => this.attach(model)),
      monaco.editor.onWillDisposeModel(model => this.detach(model)),
      editor.onDidChangeModel(() => this.invalidate('SCOPE')),
      editor.onDidChangeCursorPosition(e => { if (e.reason !== monaco.editor.CursorChangeReason.ContentFlush) this.acceptance.cancel(); }),
      editor.onKeyDown(e => {
        if ((e.ctrlKey || e.metaKey) && e.code === 'Space') { e.preventDefault(); e.stopPropagation(); void this.requestCompletion(null); return; }
        if (e.keyCode === monaco.KeyCode.Escape) { this.acceptance.cancel(); return; }
        if (this.widget.key(e.keyCode)) { e.preventDefault(); e.stopPropagation(); }
      }), editor.onDidDispose(() => this.dispose()));
    this.unsubscribe = binding.subscribe(event => this.receive(event));
    monaco.editor.getModels().forEach(model => this.attach(model));
  }
  private snapshot(entry: Entry): ModelSnapshot {
    const content = normalizeContent(entry.model.getValue());
    return { path:entry.path,modelLifetime:entry.lifetime,localModelVersion:entry.model.getVersionId(),content,contentSha256:contentSha256(content) };
  }
  private state(entry: Entry): AcceptanceState {
    if (this.dead || entry.tombstone || entry.model.isDisposed()) throw new Error('Retired model');
    const snapshot = this.snapshot(entry), auth = this.binding.readAuthority(snapshot);
    if (!auth || !Number.isSafeInteger(auth.revision) || auth.revision < 0 || auth.revision < this.lastAuthorityRevision || auth.stamp.projectId !== this.binding.projectId || snapshot.content.length > 1048576) throw new Error('No current authority');
    const stamp:DocumentStamp={ ...auth.stamp,path:entry.path,modelLifetime:entry.lifetime,localModelVersion:snapshot.localModelVersion,contentSha256:snapshot.contentSha256 };
    if (!validateDocumentStamp(stamp)) throw new Error('Invalid document authority');
    this.lastAuthorityRevision=Math.max(this.lastAuthorityRevision,auth.revision);
    return { ...auth, stamp, content:snapshot.content,
      controlPrepare:auth.controlPrepare || this.prepareFloor !== null, connected:auth.connected && !this.blocked };
  }
  private active() { const model = this.editor.getModel(); return model ? this.entries.get(model) : undefined; }
  private current() { const entry = this.active(); if (!entry) throw new Error('No active project model'); return this.state(entry); }
  private attach(model: M.editor.ITextModel) {
    if (this.dead || model.isDisposed() || this.entries.has(model)) return;
    let path: string; try { path = fromModelUri(this.binding.projectId,model.uri.toString()); } catch { return; }
    const entry: Entry = { model,path,lifetime:crypto.randomUUID(),listener:{dispose(){}},tombstone:false };
    this.entries.set(model,entry);
    entry.listener = model.onDidChangeContent(event => {
      const reason = entry.reason ?? (event.isUndoing ? 'UNDO' : event.isRedoing ? 'REDO' : 'TYPING');
      this.invalidate('MODEL_CHANGED'); // immediately clears ALL project markers, before transport or debounce.
      this.sync(entry,'CHANGE',reason);
      // Monaco's public content event precedes its final cursor update. Capture, never rebind a stale queue.
      const ticket=this.workGeneration,version=model.getVersionId(),change=event.changes.length===1 ? event.changes[0] : null;
      const text=change?.text ?? '',offset=change ? change.rangeOffset+text.length : -1;
      if (reason === 'TYPING' && model===this.editor.getModel() && Number.isSafeInteger(offset) && offset>=0 &&
        offset<=model.getValueLength() && /[\p{L}\p{N}_.$]$/u.test(text)) {
        try {
          const expected={stamp:{...this.state(entry).stamp},position:model.getPositionAt(offset)};
          queueMicrotask(() => {
            if (!this.dead && ticket===this.workGeneration && this.active()===entry && model.getVersionId()===version)
              void this.requestAt(text.endsWith('.') ? '.' : null,expected);
          });
        } catch { /* No authoritative document yet: typing remains available, completion stays closed. */ }
      }

    });
    this.sync(entry,'OPEN','OPEN');
  }
  private detach(model: M.editor.ITextModel) {
    const entry = this.entries.get(model); if (!entry) return;
    this.invalidate('SCOPE');
    if (!entry.tombstone && entry.sent) {
      try { this.binding.sendDocument('CLOSE',{ ...entry.sent,reason:'OPEN' }); } catch (e) { this.problem(e); }
    }
    entry.listener.dispose(); this.entries.delete(model);
    this.monaco.editor.setModelMarkers(model,this.markerOwner,[]);
  }
  private sync(entry: Entry, kind: 'OPEN'|'CHANGE', reason: MutationReason) {
    try {
      if (entry.tombstone) return;
      const state = this.state(entry);
      if (!state.connected || !state.synced) return;
      const document: OpenOrChange = {stamp:state.stamp,content:state.content,reason};
      this.binding.sendDocument(entry.sent ? kind : 'OPEN',entry.sent ? document : {...document,reason:'OPEN'});
      entry.sent = JSON.parse(JSON.stringify(document));
    } catch (e) { this.problem(e); }
  }
  /** Scope/model invalidation is synchronous; no cancellation acknowledgement is required for correctness. */
  private invalidate(reason: Parameters<CompletionAcceptanceFacade['invalidate']>[0]) {
    this.workGeneration++;
    if (['CONTROL_PREPARE','VETO','DISCONNECTED','CONFLICT'].includes(reason)) {
      let revision = -1;
      for (const entry of this.entries.values()) { try { revision = Math.max(revision,this.binding.readAuthority(this.snapshot(entry))?.revision ?? -1); } catch {} }
      this.prepareFloor = revision;
    }
    if (reason === 'DISCONNECTED' || reason === 'VETO' || reason === 'CONFLICT') this.blocked = true;
    this.entries.forEach(entry => { this.monaco.editor.setModelMarkers(entry.model,this.markerOwner,[]); });
    this.baseAcceptance.invalidate(reason);
  }
  private cancelFlight() {
    const flight = this.flight; this.flight = undefined;
    if (!flight) return;
    flight.abort.abort();
    try { this.binding.cancel({requestId:flight.request.requestId,stamp:flight.request.stamp}); } catch (e) { this.problem(e); }
  }
  private problem(e: unknown) { try { this.binding.onProblem?.(e instanceof Error ? e.message : String(e)); } catch { /* UI error cannot mutate a model or bypass the gate. */ } }
  /** Public Ctrl+Space/dot request; captured request never rebound to newer models, ACKs or authority. */
  requestCompletion(trigger: string | null): Promise<void> { return this.requestAt(trigger); }
  private async requestAt(trigger: string | null, expected?: {stamp:DocumentStamp;position:M.IPosition}): Promise<void> {
    this.acceptance.cancel();
    try {
      const entry = this.active(); if (!entry) return;
      const state = this.state(entry), pos = this.editor.getPosition();
      if (!mayAccept(state) || !pos || !entry.sent ||
        (!sameScope(entry.sent.stamp,state.stamp) || entry.sent.content !== state.content || entry.sent.stamp.localModelVersion !== state.stamp.localModelVersion)) return;
      if (expected && (!sameStamp(state.stamp,expected.stamp) || pos.lineNumber!==expected.position.lineNumber || pos.column!==expected.position.column)) return;
      const request: CompleteRequest = {requestId:crypto.randomUUID(),stamp:{...state.stamp},position:{line:pos.lineNumber,column:pos.column},trigger};
      const flight: Flight = {request,abort:new AbortController(),entry}; this.flight = flight;
      const response = await (this.binding.builtin?.(entry.model,request,flight.abort.signal) ?? this.binding.complete(request,flight.abort.signal));
      if (this.dead || this.flight !== flight || flight.abort.signal.aborted || this.active() !== entry ||
        response.requestId !== request.requestId || !sameStamp(response.stamp,request.stamp)) return;
      this.flight = undefined;
      this.acceptance.present(response);
    } catch (e) { this.cancelFlight(); this.problem(e); }
  }
  getModelSnapshots(): readonly ModelSnapshot[] { return [...this.entries.values()].filter(e => !e.tombstone && !e.model.isDisposed()).map(e => this.snapshot(e)); }
  /** Tags a real Monaco mutation, never performs a second persistence write. */
  withMutationReason<T>(model: M.editor.ITextModel, reason: MutationReason, mutate: () => T): T {
    const entry = this.entries.get(model); if (!entry) return mutate();
    const previous = entry.reason; entry.reason = reason;
    try { return mutate(); } finally { entry.reason = previous; }
  }
  private receive(event: BridgeEvent) {
    if (this.dead) return;
    if (event.type === 'DIAGNOSTICS') { this.diagnostics(event.result); return; }
    if (event.type === 'AUTHORITY_CHANGED') {
      this.workGeneration++;
      // ACK-only: clear/cancel, but NO didChange/setValue/save/provider restart. New envelope retains source.
      this.entries.forEach(entry => { this.monaco.editor.setModelMarkers(entry.model,this.markerOwner,[]); });
      this.baseAcceptance.invalidate('SCOPE');
      const states = [...this.entries.values()].filter(e => !e.tombstone).map(e => { try { return this.binding.readAuthority(this.snapshot(e)); } catch { return null; } });
      if (states.length && states.every(s => s && (this.prepareFloor === null || s.revision > this.prepareFloor) && !s.controlPrepare && !s.vetoPending && s.connected && s.synced && s.writeOwner === 'STUDENT' && !s.conflict)) {
        this.prepareFloor = null; this.blocked = false;
      }
      // New server scope opens CURRENT buffers, never replays mutations. ACK metadata alone is NOT a new scope.
      this.entries.forEach(entry => {
        if (entry.tombstone) return;
        try { if (entry.sent && !sameScope(entry.sent.stamp,this.state(entry).stamp)) entry.sent=undefined; }
        catch { return; }
        if (!entry.sent) this.sync(entry,'OPEN','OPEN');
      });
      return;
    }
    if (event.type === 'FILE_OPERATION') {
      this.invalidate('SCOPE');
      // Successful authorized feed only. Keep old model bytes as a tombstone until UI retires/migrates it.
      if (event.operation !== 'CREATE') this.entries.forEach(entry => {
        if (entry.path === event.path) { if (entry.sent) { try { this.binding.sendDocument('CLOSE',{...entry.sent,reason:'OPEN'}); } catch (e) { this.problem(e); } } entry.tombstone = true; }
      });
      return;
    }
    if (event.type === 'DISCONNECTED' || event.type === 'SCOPE') {
      if (event.type === 'SCOPE') this.invalidate('DISCONNECTED');
      this.blocked = true; this.entries.forEach(entry => { entry.sent = undefined; }); }
    this.invalidate(event.type);
  }
  private diagnostics(result: DiagnosticsResult) {
    try {
      if (!validateDiagnosticsResult(result)) return;
      const entry = [...this.entries.values()].find(e => !e.tombstone && e.path === result.presentationStamp.path);
      if (!entry) return;
      const state = this.state(entry);
      if (!mayAccept(state) ||
        !sameStamp(result.presentationStamp,state.stamp) || !this.binding.verifyDiagnostics(result,[...this.entries.values()].filter(e => !e.tombstone).map(e => this.snapshot(e)))) return;
      const items: M.editor.IMarkerData[] = [];
      for (const item of result.items) {
        // Shared edit validator enforces exact UTF16 boundaries, without silently clamping marker positions.
        if (!validateCompletionEdits({id:'marker',label:'marker',detail:null,primary:{path:entry.path,range:item.range,text:''},additionalTextEdits:[]},state.stamp,state.content)) return;
        items.push({startLineNumber:item.range.startLine,startColumn:item.range.startColumn,endLineNumber:item.range.endLine,endColumn:item.range.endColumn,
          message:item.message,severity:this.monaco.MarkerSeverity[item.severity === 'ERROR' ? 'Error' : item.severity === 'WARNING' ? 'Warning' : item.severity === 'INFO' ? 'Info' : 'Hint'],code:item.code ?? undefined});
      }
      this.monaco.editor.setModelMarkers(entry.model,this.markerOwner,items);
    } catch (e) { this.problem(e); }
  }
  dispose() {
    if (this.dead) return;
    this.acceptance.cancel();
    [...this.entries.keys()].forEach(model => this.detach(model));
    this.dead = true; this.unsubscribe?.(); this.disposables.forEach(d => d.dispose()); this.widget.dispose();
  }
}

/** Own public content widget, not Monaco SuggestController/private APIs or post-edit compensation. */
class CompletionWidget implements M.editor.IContentWidget {
  readonly allowEditorOverflow = false;
  private node: HTMLDivElement;
  private items: readonly CompletionCandidate[] = [];
  private selected = 0;
  private position: M.IPosition | null = null;
  constructor(private readonly monaco: typeof M, private readonly editor: M.editor.IStandaloneCodeEditor,
    private readonly accept: (candidate: CompletionCandidate) => unknown) {
    this.node = document.createElement('div'); this.node.id = `pc-complete-${crypto.randomUUID()}`;
    this.node.setAttribute('role','listbox'); this.node.setAttribute('aria-label','Podpowiedzi kodu — strzałki wybierają, Enter lub Tab akceptuje, Escape zamyka');
    this.node.setAttribute('aria-live','polite'); this.node.setAttribute('aria-atomic','true');
    Object.assign(this.node.style,{display:'none',maxWidth:'min(360px, 80vw)',maxHeight:'200px',overflow:'auto',background:'#073642',color:'#839496',border:'1px solid #586e75',boxShadow:'0 3px 8px #002b36',fontSize:'13px'});
    this.editor.addContentWidget(this);
  }
  getId() { return this.node.id; }
  getDomNode() { return this.node; }
  getPosition(): M.editor.IContentWidgetPosition | null { return this.position ? {position:this.position,preference:[this.monaco.editor.ContentWidgetPositionPreference.BELOW,this.monaco.editor.ContentWidgetPositionPreference.ABOVE]} : null; }
  show(items: readonly CompletionCandidate[]) {
    this.items = items; this.selected = 0; this.position = this.editor.getPosition();
    this.render();
  }
  private render() {
    this.node.replaceChildren();
    this.node.style.display = this.items.length ? 'block' : 'none';
    this.items.forEach((candidate,i) => {
      const row = document.createElement('div'); row.id = `${this.node.id}-${i}`; row.setAttribute('role','option');
      row.setAttribute('aria-selected',String(i === this.selected)); row.textContent = candidate.item.label;
      row.title = candidate.item.detail ?? candidate.item.label; row.style.padding = '3px 8px'; row.style.cursor = 'pointer';
      if (i === this.selected) row.style.background = '#285460';
      // Keep editor focus; click is an independent synchronous acceptance check, never native acceptance.
      row.onmousedown = e => { e.preventDefault(); this.accept(candidate); };
      this.node.append(row);
    });
    const editorNode = this.editor.getDomNode();
    if (this.items.length) { editorNode?.setAttribute('aria-controls',this.node.id); editorNode?.setAttribute('aria-activedescendant',`${this.node.id}-${this.selected}`); }
    this.editor.layoutContentWidget(this);
  }
  key(keyCode: M.KeyCode): boolean {
    if (!this.items.length) return false;
    if (keyCode === this.monaco.KeyCode.Escape) { this.hide(); return false; } // preserve global double-Esc Veto.
    if (keyCode === this.monaco.KeyCode.Enter || keyCode === this.monaco.KeyCode.Tab) { const candidate=this.items[this.selected]; this.accept(candidate); return true; }
    if (keyCode === this.monaco.KeyCode.DownArrow || keyCode === this.monaco.KeyCode.UpArrow) {
      this.selected = (this.selected + (keyCode === this.monaco.KeyCode.DownArrow ? 1 : this.items.length-1)) % this.items.length;
      this.render(); this.node.children[this.selected]?.scrollIntoView({block:'nearest'}); return true;
    }
    return false;
  }
  hide() {
    this.items=[];this.position=null;this.node.style.display='none';this.node.replaceChildren();
    this.editor.getDomNode()?.removeAttribute('aria-controls');this.editor.getDomNode()?.removeAttribute('aria-activedescendant');
    this.editor.layoutContentWidget(this);
  }
  dispose() { this.hide(); this.editor.removeContentWidget(this); this.node.remove(); }
}
