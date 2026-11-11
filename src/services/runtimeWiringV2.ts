/** Composition over the existing controller; no socket, persistence or finality inference. */
import type { AcceptanceState, CompleteRequest, CompleteResult, DiagnosticsResult, DocumentStamp, LanguageClientMessage, LanguageServerMessage, LanguageView, OpenOrChange } from '../shared/language-v2';
import type { BridgeAuthority, BridgeEvent, EditorLanguageBinding, ModelSnapshot } from './monacoLspBridge';
import { contentSha256, normalizeContent } from '../language/uriCodec';
import { validateDiagnosticsResult, validateDocumentStamp } from '../shared/validation-v2';
import { LanguageClientV2, sameDocumentStamp } from './LanguageClientV2';
import { RuntimeClientV2, type RuntimeClientV2Dependencies } from './RuntimeClientV2';
/** LOCAL seam, NOT wire DTO. Only authenticated backend bootstrap can supply these server-owned
 * generations and approved provider, from the validated coherent SessionBundleV2. */
export interface LanguageAuthorityV2 {
  projectId: string; sessionId: string; profileId: string; connectionGeneration: string;
  configurationGeneration: string; providerGeneration: string; shadowGeneration: string;
  provider: 'builtin' | 'remote' | 'off';
}
export interface WiringControllerV2 {
  projectId: string; sessionId: string; clientId: string; connectionGeneration: string;
  connected: boolean; synced: boolean; writeOwner: 'STUDENT' | 'COACH'; controlEpoch: number;
  preparing: boolean; vetoPending: boolean; language: LanguageAuthorityV2 | null;
  /** Current whole project/file/dependency and retained-draft vector, never inferred from diagnostics. */
  sourceVector?: string; workspaceVersion?: number;
  drafts?: readonly {path:string;content:string;baseVersion:number;conflict:boolean}[];
  document(path: string): { content: string; version: number; readOnly: boolean; conflict: boolean } | null;
}
const clone = <T,>(v: T): T => structuredClone(v);
interface SentDocument {
  readonly messageId: string; readonly document: OpenOrChange; readonly vector: number;
  readonly overlays: string; readonly scope: string;
}
interface AutosaveTransaction {
  readonly source: SentDocument; readonly content: string; readonly baseVersion: number;
  readonly controlEpoch: number; readonly draftGeneration: number; readonly workspaceVersion: number;
}
/** LOCAL verified receive seam, not a wire DTO, endpoint or server-branded authority. */
export interface AutosaveAckEnvelope {
  messageId: string; sessionId: string; replyTo: string; status: 'OK'|'DUPLICATE'|'REJECTED';
  documentVersion: number|null; workspaceVersion: number; controlEpoch: number;
}

export class RuntimeWiringV2 {
  readonly runtime: RuntimeClientV2;
  readonly language: LanguageClientV2;
  private revision = 0;
  private vector = 0;
  private requestGeneration = 0;
  private models = new Map<string, ModelSnapshot>();
  private sent = new Map<string, SentDocument>();
  private autosaves = new Map<string, AutosaveTransaction>();
  private preparedAck: { ack: AutosaveAckEnvelope; transaction: AutosaveTransaction } | null = null;
  private receipts = new Map<string, { source: SentDocument; presentation: DocumentStamp; scope: string; vector: number; overlays: string }>();
  private draftGeneration = 0;
  private listeners = new Set<(event: BridgeEvent) => void>();
  private pending = new Map<string, { resolve: (r: CompleteResult) => void; reject: (e: Error) => void; dispose(): void }>();
  private binding?: EditorLanguageBinding;
  private invalidating = false;
  private prepareEpoch: number | null = null;
  private builtin?: EditorLanguageBinding['builtin'];
  constructor(private readonly deps: {
    current(): WiringControllerV2 | null; runtime: RuntimeClientV2Dependencies;
    send(message: LanguageClientMessage): void; messageId(): string;
    problem(message: string): void; status(view: LanguageView): void;
  }) {
    this.runtime = new RuntimeClientV2(deps.runtime);
    this.language = new LanguageClientV2({send: m => this.sendLanguage(m),messageId:deps.messageId,contentSha256,
      identity: () => { const c=deps.current(); return c?.connected && c.language ? {sessionId:c.sessionId,clientId:c.clientId,connectionGeneration:c.language.connectionGeneration} : null; },
      current:path=>this.current(path),verifyDiagnostics:r=>this.verifyDiagnostics(r),invalidate:()=>this.rejectPending()});
    this.language.subscribe(event=>{
      if(event.type==='completion') { const p=this.pending.get(event.result.requestId); if(p) {this.pending.delete(event.result.requestId);p.dispose();p.resolve(event.result);} }
      else if(event.type==='diagnostics') this.emit({type:'DIAGNOSTICS',result:event.result});
      else if(event.type==='status') deps.status(event.view);
    });
  }
  setBuiltin(provider: EditorLanguageBinding['builtin']) { this.builtin=provider; }
  private emit(e: BridgeEvent) { for(const listener of this.listeners) listener(e); }
  private rejectPending() { const entries=[...this.pending.values()];this.pending.clear();for(const p of entries) {p.dispose();p.reject(new Error('Żądanie utraciło aktualną autoryzację.'));} }
  /** Sole receive controller calls this FIRST, before flush/load/READY/React; cancel is advisory. */
  invalidate(type: 'CONTROL_PREPARE'|'VETO'|'DISCONNECTED'|'SCOPE'|'CONFLICT') {
    if(this.invalidating) return;this.invalidating=true;
    try {
      this.revision++;this.vector++;this.requestGeneration++;this.clearLedger();
      if(type==='CONTROL_PREPARE') this.prepareEpoch=this.deps.current()?.controlEpoch ?? 0;
      this.emit({type});this.rejectPending();
      try {this.language.invalidate(type);} catch(e) {this.deps.problem(String(e));}
      if(type==='DISCONNECTED'||type==='SCOPE') this.models.clear();
      if(type==='DISCONNECTED') this.runtime.invalidate();
    } finally {this.invalidating=false;}
  }
  sourceChanged() {
    this.vector++;this.requestGeneration++;this.revision++;this.clearLedger();this.rejectPending();
    try {this.language.invalidate('PROJECT_CHANGED');} catch(e) {this.deps.problem(String(e));}
    this.emit({type:'AUTHORITY_CHANGED'});
  }
  authoritativeState(epoch:number) {
    if(this.prepareEpoch!==null && epoch>this.prepareEpoch) this.prepareEpoch=null;
    this.revision++;this.emit({type:'AUTHORITY_CHANGED'});
  }
  private clearLedger() { this.sent.clear(); this.autosaves.clear(); this.receipts.clear(); this.preparedAck=null; }
  private scope() {
    const c=this.deps.current();
    return c ? JSON.stringify([c.projectId,c.sessionId,c.clientId,c.connectionGeneration,c.controlEpoch,c.language,c.sourceVector ?? '',
      // A live model is the source of truth, not its redundant transient React/autosave mirror.
      // Unopened retained drafts remain part of the input vector; no invented unopened hash.
      (c.drafts??[]).filter(d=>!this.models.has(d.path)),
      [...this.models.keys()].sort().map(path=>{const d=c.document(path);return [path,d?.version,d?.readOnly,d?.conflict];})]) : '';
  }
  /** A newer draft anywhere invalidates an earlier save, even A->B->A with equal bytes. */
  draftChanged(path:string,content:string) {
    this.draftGeneration++;this.autosaves.clear();this.receipts.clear();this.preparedAck=null;
    // Model and React onChange may be ordered either way. Matching mirrors are NOT another
    // input; a real unobserved/openless draft change must retire the entire old source ledger.
    if((this.sent.size||this.models.has(path))&&this.models.get(path)?.content!==normalizeContent(content))this.sourceChanged();
  }
  private sendLanguage(message: LanguageClientMessage) {
    if(message.type==='LANGUAGE_OPEN'||message.type==='LANGUAGE_CHANGE') {
      const source:SentDocument={messageId:message.messageId,document:clone(message.payload),vector:this.vector,overlays:this.overlays(),scope:this.scope()};
      const key=this.key(message.payload.stamp);
      // Capture BEFORE dispatch, never select the latest equal-content document at ACK time.
      this.sent.set(key,source);
      try {this.deps.send(message);} catch(e) {this.sent.delete(key);throw e;}
      if(this.sent.size>256)this.sent.delete(this.sent.keys().next().value!);
    } else this.deps.send(message);
  }
  /** Sole singleflight autosave captures an already-sent exact language message, before CODE_CHANGED. */
  beginAutosave(messageId:string,path:string,content:string,baseVersion:number,controlEpoch:number):string|undefined {
    const a=this.current(path),c=this.deps.current();if(!a||!c||!a.connected||!a.synced||a.conflict||a.readOnly||a.controlPrepare||a.vetoPending||a.writeOwner!=='STUDENT'||c.workspaceVersion===undefined)return;
    const source=this.sent.get(this.key(a.stamp));
    if(!source||source.document.content!==content||a.content!==content||source.scope!==this.scope()||source.vector!==this.vector||source.overlays!==this.overlays()||
      a.stamp.baseDocumentVersion!==baseVersion||a.stamp.controlEpoch!==controlEpoch||normalizeContent(content)!==content)return;
    this.autosaves.set(messageId,{source:clone(source),content,baseVersion,controlEpoch,draftGeneration:this.draftGeneration,workspaceVersion:c.workspaceVersion});
    return source.messageId;
  }
  cancelAutosave(messageId:string) {this.autosaves.delete(messageId);this.preparedAck=null;}
  /** Called ONLY by the authenticated ordered receiver, BEFORE changing local disk metadata. */
  prepareAutosaveAck(ack:AutosaveAckEnvelope) {
    this.preparedAck=null;
    const transaction=this.autosaves.get(ack.replyTo);this.autosaves.delete(ack.replyTo);
    if(!transaction)return;
    const s=transaction.source,a=this.current(s.document.stamp.path),c=this.deps.current();
    if(!a||!c||!c.connected||!c.synced||c.preparing||c.vetoPending||a.conflict||a.readOnly||
      a.controlPrepare||a.vetoPending||a.writeOwner!=='STUDENT'||ack.workspaceVersion<=transaction.workspaceVersion||c.workspaceVersion!==transaction.workspaceVersion||
      ack.sessionId!==c.sessionId||ack.status==='REJECTED'||ack.documentVersion===null||ack.documentVersion<=transaction.baseVersion||
      ack.controlEpoch!==transaction.controlEpoch||c.controlEpoch!==transaction.controlEpoch||transaction.draftGeneration!==this.draftGeneration||
      !sameDocumentStamp(a.stamp,s.document.stamp)||a.content!==transaction.content||normalizeContent(a.content)!==a.content||
      contentSha256(a.content)!==s.document.stamp.contentSha256||s.scope!==this.scope()||s.vector!==this.vector||s.overlays!==this.overlays())return;
    this.preparedAck={ack:clone(ack),transaction};
  }
  /** Immediately after that SAME verified save's synchronous disk-only update. Never didChange/setValue/save. */
  ackTransition(ack?:AutosaveAckEnvelope) {
    const prepared=this.preparedAck;this.preparedAck=null;
    this.receipts.clear();this.autosaves.clear();
    this.revision++;this.emit({type:'AUTHORITY_CHANGED'});this.rejectPending();
    try {this.language.invalidate('ACK_TRANSITION');} catch(e) {this.deps.problem(String(e));}
    if(!ack||!prepared||JSON.stringify(prepared.ack)!==JSON.stringify(ack))return;
    const s=prepared.transaction.source,a=this.current(s.document.stamp.path),c=this.deps.current();
    if(!a||!c||!a.connected||!a.synced||a.conflict||c.vetoPending||c.preparing||a.content!==prepared.transaction.content||
      prepared.transaction.draftGeneration!==this.draftGeneration||s.vector!==this.vector||s.overlays!==this.overlays())return;
    const expected={...s.document.stamp,baseDocumentVersion:ack.documentVersion!,documentVersion:ack.documentVersion!};
    if(!sameDocumentStamp(a.stamp,expected))return;
    this.receipts.set(ack.messageId,{source:s,presentation:clone(a.stamp),scope:this.scope(),vector:this.vector,overlays:this.overlays()});
  }
  fileOperation(operation:'CREATE'|'RENAME'|'DELETE',path:string,newPath?:string) {
    this.vector++;this.requestGeneration++;this.revision++;this.clearLedger();
    this.emit({type:'FILE_OPERATION',operation,path,newPath});if(operation!=='CREATE') this.models.delete(path);
    this.language.invalidate('FILE_OPERATION');
  }
  private overlays() {return JSON.stringify([...this.models.values()].map(m=>[m.path,m.modelLifetime,m.localModelVersion,m.contentSha256]).sort((a,b)=>String(a[0]).localeCompare(String(b[0]))));}
  private readAuthority(model:Readonly<ModelSnapshot>):BridgeAuthority|null {
    const c=this.deps.current(),s=c?.language;
    if(!c||!s||s.provider==='off'||s.projectId!==c.projectId||s.sessionId!==c.sessionId||model.content!==normalizeContent(model.content)||contentSha256(model.content)!==model.contentSha256) return null;
    const doc=c.document(model.path);if(!doc) return null;
    const previous=this.models.get(model.path);
    if(!previous||previous.modelLifetime!==model.modelLifetime||previous.localModelVersion!==model.localModelVersion||previous.content!==model.content) {
      this.models.set(model.path,clone(model));this.vector++;this.requestGeneration++;this.revision++;this.clearLedger();
    }
    return {revision:this.revision,stamp:{projectId:c.projectId,sessionId:c.sessionId,profileId:s.profileId,
      connectionGeneration:s.connectionGeneration,configurationGeneration:s.configurationGeneration,providerGeneration:s.providerGeneration,shadowGeneration:s.shadowGeneration,
      baseDocumentVersion:doc.version,documentVersion:normalizeContent(doc.content)===model.content?doc.version:null,controlEpoch:c.controlEpoch,requestGeneration:this.requestGeneration},
      connected:c.connected,synced:c.synced,writeOwner:c.writeOwner,controlPrepare:c.preparing||this.prepareEpoch!==null,vetoPending:c.vetoPending,conflict:doc.conflict,readOnly:doc.readOnly};
  }
  private current(path:string):AcceptanceState|null {const m=this.models.get(path);if(!m)return null;const a=this.readAuthority(m);return a?{...a,stamp:{...a.stamp,path,modelLifetime:m.modelLifetime,localModelVersion:m.localModelVersion,contentSha256:m.contentSha256},content:m.content}:null;}
  private key(s:DocumentStamp) {return JSON.stringify(Object.entries(s).sort(([a],[b])=>a.localeCompare(b)));}
  private sendDocument(kind:'OPEN'|'CHANGE'|'CLOSE',doc:OpenOrChange) {
    if(kind==='CLOSE') {try {this.language.close(doc.stamp);} finally {this.models.delete(doc.stamp.path);this.vector++;this.clearLedger();}return;}
    if(!validateDocumentStamp(doc.stamp))return;
    const a=this.current(doc.stamp.path);if(!a||!sameDocumentStamp(a.stamp,doc.stamp)||a.content!==doc.content)return;
    const key=this.key(doc.stamp);
    try {if(!(kind==='OPEN'?this.language.open(doc):this.language.change(doc)))this.sent.delete(key);} catch(e) {this.sent.delete(key);throw e;}
    if(this.sent.size>256)this.sent.delete(this.sent.keys().next().value!);
  }
  private complete(r:CompleteRequest,signal:AbortSignal):Promise<CompleteResult> {
    if(signal.aborted)return Promise.reject(new Error('Anulowano.'));
    return new Promise((resolve,reject)=>{
      const abort=()=>{this.pending.delete(r.requestId);dispose();reject(new Error('Anulowano żądanie.'));};
      const timer=setTimeout(()=>{abort();this.language.cancel();},5000);
      const dispose=()=>{clearTimeout(timer);signal.removeEventListener('abort',abort);};
      signal.addEventListener('abort',abort,{once:true});this.pending.set(r.requestId,{resolve,reject,dispose});
      try {if(!this.language.complete(r)){this.pending.delete(r.requestId);dispose();reject(new Error('Brak aktualnej autoryzacji językowej.'));}} catch(e){this.pending.delete(r.requestId);dispose();reject(e);}
    });
  }
  verifyDiagnostics(r:DiagnosticsResult,models?:readonly ModelSnapshot[]):boolean {
    if(!validateDiagnosticsResult(r))return false;
    const a=this.current(r.presentationStamp.path),sent=this.sent.get(this.key(r.sourceStamp));
    if(!a||!a.connected||!a.synced||a.conflict||!sent||!sameDocumentStamp(a.stamp,r.presentationStamp)||a.content!==sent.document.content)return false;
    if(r.association===null) {
      if(!sameDocumentStamp(r.sourceStamp,r.presentationStamp)||sent.scope!==this.scope()||sent.vector!==this.vector||sent.overlays!==this.overlays())return false;
    } else {
      const receipt=this.receipts.get(r.association.saveReceiptId);
      if(!receipt||receipt.source.messageId!==sent.messageId||!sameDocumentStamp(receipt.source.document.stamp,r.sourceStamp)||
        !sameDocumentStamp(receipt.presentation,r.presentationStamp)||receipt.scope!==this.scope()||receipt.vector!==this.vector||receipt.overlays!==this.overlays())return false;
    }
    if(models&&(models.length!==this.models.size||models.some(m=>{const p=this.models.get(m.path);return !p||p.modelLifetime!==m.modelLifetime||p.localModelVersion!==m.localModelVersion||p.content!==m.content||p.contentSha256!==m.contentSha256;})))return false;
    // Authenticated backend attestation retained unchanged. Never reconstruct unopened hashes,
    // launch identity or receipt mapping at arrival. Exact source must already be in sent ledger.
    return true;
  }
  receive(message:LanguageServerMessage) {return this.language.receive(message);}
  getBinding(projectId:string):EditorLanguageBinding {
    if(this.binding?.projectId===projectId)return this.binding;
    return this.binding={projectId,readAuthority:m=>this.readAuthority(m),sendDocument:(k,d)=>this.sendDocument(k,d),complete:(r,s)=>this.complete(r,s),cancel:()=>this.language.cancel(),
      subscribe:fn=>{this.listeners.add(fn);return()=>{this.listeners.delete(fn);};},verifyDiagnostics:(r,m)=>this.verifyDiagnostics(r,m),
      builtin:(m,r,s)=>this.deps.current()?.language?.provider==='builtin'?this.builtin?.(m,r,s)??null:null,onProblem:m=>this.deps.problem(m)};
  }
}
