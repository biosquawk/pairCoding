/** Backend-owned complete source authority. Every overlay mutation and selected copy uses the
 * SAME real workspace FIFO. This is not a provider, scanner, receipt parser or wire issuer. */
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual as same } from 'node:util';
import * as codec from '../../language/uriCodec';
import type { Document } from '../../shared/protocol';
import type { LanguageClientMessage, OpenOrChange } from '../../shared/language-v2';
import { validateLanguageClientMessage } from '../../shared/validation-v2';
import type { LanguageProjectScope } from '../language/ports';
import type { RegistryAuthority, RegistrySnapshot } from '../language/LanguageFeatureRegistry';
import { LanguageShadowStore, type LanguageSourceCapture } from '../language/LanguageShadowStore';
import type { SelectedLanguageLease } from '../language/SelectedCacheLanguageAuthority';
import type { LanguageSourceLease, MutationAuth } from '../WriteGate';
import type { createRuntimeLanguageBinding } from './RuntimeLanguageBinding';
import type { LanguageSaveInput, LanguageSaveCommit, LanguageAckCurrent } from '../language/LanguageAckLedger';
import type { ResolvedRuntime } from '../runtime-config';
import type { RuntimeWorkspace } from './RuntimeWorkspace';
import { AppError } from '../errors';
import {canonical,sha256} from './storage';
import { dependencyHash } from '../../../scripts/runtime-dependencies.mjs';

const copy = <T>(v:T):T => { const result=structuredClone(v); const freeze=(x:unknown):void=>{
  if(x && typeof x==='object'){Object.values(x).forEach(freeze);Object.freeze(x);}
};freeze(result);return result; };
const denied = (message:string):never => {throw new AppError(409,'LANGUAGE_SOURCE_CHANGED',message);};
type Overlay = {peerId:string;messageId:string;document:Readonly<OpenOrChange>};
type Vector = {snapshot:RegistrySnapshot;disk:LanguageSourceCapture;context:unknown};
export interface RuntimeLanguageSourceOptions {
  core:RuntimeWorkspace; runtime:Readonly<ResolvedRuntime>; scope:Readonly<LanguageProjectScope>;
  installationId:string;
  /** Backend binding/config/transport currentness, not an always-current test policy. */
  assertCurrent():void;
  assertPeer(peerId:string,message:Readonly<LanguageClientMessage>):void;
  onUnassociatedCommit?(path:string):void;
}
export class RuntimeLanguageSource implements RegistryAuthority {
  private readonly options:RuntimeLanguageSourceOptions;
  private readonly scope:Readonly<LanguageProjectScope>;
  private readonly scanner:LanguageShadowStore;
  private readonly generation=randomUUID(); private revision=0; private mutation=0; private retired=false;
  private vector:Vector|null=null;
  private readonly overlays=new Map<string,Overlay>();
  private readonly commits=new Map<string,Readonly<LanguageSaveCommit>>();
  private readonly seen=new Map<string,string>();
  private committing:{path:string;workspaceVersion:number}|null=null;
  ownsCommit(change:{path?:string;workspaceVersion:number;actor:string}):boolean {
    return change.actor==='STUDENT' && this.committing!==null && change.path===this.committing.path && change.workspaceVersion===this.committing.workspaceVersion;
  }
  constructor(options:RuntimeLanguageSourceOptions) {
    if(typeof options.assertCurrent!=='function' || typeof options.assertPeer!=='function')throw Error('Actual source/peer authority callbacks required');
    this.options={...options,runtime:copy(options.runtime),scope:copy(options.scope),assertCurrent:options.assertCurrent.bind(options),assertPeer:options.assertPeer.bind(options)};this.scope=copy(options.scope);
    const {core,runtime,scope}=options;
    if(runtime.workspaceRoot!==core.workspace.rootPath || scope.projectId!==core.workspace.projectId ||
      scope.sessionId!==core.session.state.sessionId || scope.configurationGeneration!==runtime.configurationGeneration || !same(scope.profile,runtime.profile))
      denied('Language source must belong to the actual canonical runtime/core.');
    this.scanner=new LanguageShadowStore(scope.shadowDirectory,codec);
  }
  private guard(scope:Readonly<LanguageProjectScope>=this.scope):void {
    if(this.retired || !same(scope,this.scope))denied('Language source scope is retired or foreign.');
    this.options.assertCurrent();
    const {core,runtime}=this.options;
    core.workspace._settingsVersionStore().assertCurrent();
    if(core.session.state.sessionId!==this.scope.sessionId || runtime.workspaceRoot!==core.workspace.rootPath ||
      core.workspace.projectId!==this.scope.projectId)denied('Canonical language source changed.');
  }
  private context() {
    const {core}=this.options;
    return {workspaceVersion:core.workspace.workspaceVersion,settings:core.readSettings().sourceSha256,
      epoch:core.session.state.controlEpoch,owner:core.session.state.writeOwner,client:core.session.leaseClientId,
      mutation:this.mutation,documents:[...this.overlays.values()].sort((a,b)=>a.document.stamp.path.localeCompare(b.document.stamp.path))};
  }
  /** Synchronous monotonic invalidation for actual changed/external/control/reconnect feeds. */
  invalidate():void {if(this.mutation===Number.MAX_SAFE_INTEGER)denied('Language mutation budget exhausted.');this.mutation++;this.vector=null;}
  retire():void {this.retired=true;this.invalidate();this.overlays.clear();this.seen.clear();this.commits.clear();}
  capture(scope:Readonly<LanguageProjectScope>):RegistrySnapshot {
    this.guard(scope);const context=this.context();
    if(context.documents.some(o=>o.document.stamp.controlEpoch!==context.epoch))denied('Overlay control epoch is no longer current.');
    if(this.vector && same(context,this.vector.context)) {
      try {this.vector.disk.assertCurrent();this.guard(scope);return this.vector.snapshot;}
      catch {this.vector=null;} // changed disk is a NEW vector, never resurrection of equal bytes
    }
    const disk=this.scanner.captureSource(this.options.core.workspace.rootPath);this.guard(scope);
    if(!same(context,this.context()))denied('Language source changed during synchronous capture.');
    if(this.revision===Number.MAX_SAFE_INTEGER)denied('Language revision budget exhausted.');
    const snapshot=copy({revision:this.generation+':'+(++this.revision),documents:context.documents.map(o=>o.document)});
    this.vector={snapshot,disk,context};return snapshot;
  }
  isCurrent(scope:Readonly<LanguageProjectScope>,snapshot:RegistrySnapshot):boolean {
    try {this.guard(scope);const v=this.vector;if(!v || !same(snapshot,v.snapshot) || !same(v.context,this.context()))return false;
      v.disk.assertCurrent();this.guard(scope);return v===this.vector && same(v.context,this.context());
    } catch {return false;}
  }
  /** Capture ingress before queueing. Only source-model messages enter this API; no save/write. */
  admit(peerId:string,original:LanguageClientMessage):Promise<void> {
    const message=copy(original);
    if(!validateLanguageClientMessage(message) || !['LANGUAGE_OPEN','LANGUAGE_CHANGE','LANGUAGE_CLOSE'].includes(message.type))
      return Promise.reject(new AppError(400,'INVALID_LANGUAGE_SOURCE','Expected a strict language document operation.'));
    return this.options.core.workspace._withQueuedMutation(async()=>{
      this.guard();this.options.assertPeer(peerId,message);
      const {core}=this.options,stamp=message.payload.stamp;
      core.session.assertClient(message.clientId,message.sessionId);
      const expected={projectId:this.scope.projectId,sessionId:this.scope.sessionId,profileId:this.scope.profile.id,
        connectionGeneration:this.scope.connectionGeneration,configurationGeneration:this.scope.configurationGeneration,
        providerGeneration:this.scope.providerGeneration,shadowGeneration:this.scope.shadowGeneration,controlEpoch:core.session.state.controlEpoch};
      if(Object.entries(expected).some(([k,v])=>stamp[k as keyof typeof stamp]!==v))denied('Foreign or stale language document scope.');
      const key=JSON.stringify([peerId,message.messageId]),digest=sha256(canonical(message)),seen=this.seen.get(key);
      if(seen){if(seen!==digest)denied('Language message identity collision.');return;}
      if(this.seen.size>=8192)denied('Language source message capacity exhausted; reconnect.');
      const diskCapture=this.scanner.captureSource(core.workspace.rootPath);
      const previous=this.overlays.get(stamp.path);
      if(previous && previous.peerId!==peerId)denied('Another transport owns this model.');
      if(message.type==='LANGUAGE_CLOSE') {
        if(!previous || !same(previous.document.stamp,stamp))denied('Close does not match the admitted model.');
        diskCapture.assertCurrent();this.overlays.delete(stamp.path);
      } else if(message.type==='LANGUAGE_OPEN' || message.type==='LANGUAGE_CHANGE') {
        const document=message.payload;
        codec.assertRelativePath(stamp.path);
        const disk=core.workspace._fresh(stamp.path,stamp.baseDocumentVersion).document;
        if(!disk || stamp.documentVersion!==null && (stamp.documentVersion!==disk.version || document.content!==disk.content) ||
          codec.normalizeContent(document.content)!==document.content || codec.contentSha256(document.content)!==stamp.contentSha256)
          denied('Document is not an exact normalized current model/base.');
        if(message.type==='LANGUAGE_CHANGE' && (!previous || previous.document.stamp.modelLifetime!==stamp.modelLifetime))
          denied('Change requires the original admitted model lifetime.');
        if(previous && previous.document.stamp.modelLifetime===stamp.modelLifetime &&
          (stamp.localModelVersion<=previous.document.stamp.localModelVersion || stamp.requestGeneration<=previous.document.stamp.requestGeneration))
          denied('Language model/request generation must advance, including equal-byte drafts.');
        const nextBytes=Buffer.byteLength(document.content)+[...this.overlays.values()].filter(o=>o!==previous).reduce((n,o)=>n+Buffer.byteLength(o.document.content),0);
        if((!previous && this.overlays.size>=1000) || nextBytes>32*1024*1024)denied('Complete overlay budget exceeded; no partial project.');
        diskCapture.assertCurrent();this.overlays.set(stamp.path,{peerId,messageId:message.messageId,document:copy(document)});
      }
      this.seen.set(key,digest);this.invalidate();
    });
  }
  /** Full snapshot must still be current AFTER acquiring the SAME actual source FIFO. */
  async withSourceLease(scope:Readonly<LanguageProjectScope>,snapshot:RegistrySnapshot,
    action:(lease:SelectedLanguageLease)=>Promise<void>):Promise<void> {
    this.guard(scope);const {core,runtime}=this.options;
    const clientId=core.session.leaseClientId;
    if(!clientId)return denied('Language preparation requires the actual authenticated session lease.');
    const settings=core.readSettings(),run=settings.settings?.runProfiles.find(r=>r.kind==='RUN_MAIN') ?? settings.settings?.runProfiles[0];
    if(!run)return denied('Explicit current V2 task is required for language preparation.');
    const input={clientId,sessionId:core.session.state.sessionId,controlEpoch:core.session.state.controlEpoch,
      actor:core.session.state.writeOwner,expectedWorkspaceVersion:core.workspace.workspaceVersion};
    await core.gate._withLanguageSourceLease(input,()=>{
      this.guard(scope);if(!this.isCurrent(scope,snapshot) || core.readSettings().sourceSha256!==settings.sourceSha256)
        denied('Complete current source/ALL-overlay/settings vector changed.');
    },async gateLease=>{
      const lease=this.selectedLease(scope,snapshot,gateLease,run);
      lease.assertCurrent();await action(lease);lease.assertCurrent();
    });
  }
  private selectedLease(scope:Readonly<LanguageProjectScope>,snapshot:RegistrySnapshot,gateLease:LanguageSourceLease,
      run:SelectedLanguageLease['run']):SelectedLanguageLease {
    const {core,runtime}=this.options,disk=this.vector!.disk;
    const check=()=>{this.guard(scope);disk.assertCurrent();if(!this.isCurrent(scope,snapshot))denied('Source token revoked.');};
    return Object.freeze({installationId:this.options.installationId,runtime:copy(runtime),run:copy(run),
      source:copy({leaseId:snapshot.revision,projectRoot:core.workspace.rootPath,files:disk.files,
        overlays:snapshot.documents.map(d=>({stamp:d.stamp,content:d.content}))}),
      assertCurrent:()=>{gateLease.assertCurrent();check();},assertRetainedCurrent:()=>{gateLease.assertRetainedCurrent();check();}});
  }
  hasOverlay(path:string):boolean {return this.overlays.has(path);}
  readCommittedSave(request:Readonly<LanguageSaveInput>,receiptId:string):LanguageSaveCommit|null {
    try {this.guard();const result=this.commits.get(receiptId);return result && same(result.request,request)?copy(result):null;}
    catch{return null;}
  }
  /** Real gate transaction, private original result reader and authentic original envelope callback.
   * No latest-equal-byte provenance lookup; the retained documentMessageId is required before commit.
   * Preparation failure withholds association only, never rolls back a successful ordinary save. */
  writeWithAck(input:MutationAuth & {path:string;baseVersion:number;content:string},
      correlation:{peerId:string;transactionMessageId:string;languageDocumentMessageId:string|null;receiptId:string},
      binding:ReturnType<typeof createRuntimeLanguageBinding>,assertPeerCurrent:()=>void,publish:(document:Readonly<Document>)=>void,captureCommit?:(document:Readonly<Document>)=>void):Promise<Document> {
    const accepted=copy(input),ids=copy(correlation);
    const request:LanguageSaveInput={peerId:ids.peerId,transactionMessageId:ids.transactionMessageId,
      languageDocumentMessageId:ids.languageDocumentMessageId ?? '',path:accepted.path,baseVersion:accepted.baseVersion,
      controlEpoch:accepted.controlEpoch,content:codec.normalizeContent(accepted.content)};
    return this.options.core.gate._writeWithLanguageCommit(accepted,{assertCurrent:assertPeerCurrent,beforeCommit:()=>{
      let pending:ReturnType<typeof binding.beginSave>=null,before:RegistrySnapshot|null=null;
      try {before=this.capture(this.scope);pending=binding.beginSave(request);}catch{/* ordinary save needs no language capture */}
      this.committing={path:accepted.path,workspaceVersion:this.options.core.workspace.workspaceVersion+1};
      return {pending,before};
    },afterCommit:async(document,capture,gateLease)=>{
      this.committing=null;captureCommit?.(copy(document));
      const overlay=this.overlays.get(accepted.path);
      // Only this exact original admitted model may advance ACK presentation versions. No new draft,
      // scope or dependency identity is inferred from its content being equal to a later model.
      let pending=capture.pending;
      try {if(capture.pending && capture.before && overlay && overlay.peerId===ids.peerId && overlay.messageId===ids.languageDocumentMessageId &&
          overlay.document.stamp.baseDocumentVersion===accepted.baseVersion && overlay.document.content===document.content && this.commits.size<8192) {
        this.overlays.set(accepted.path,{...overlay,document:copy({...overlay.document,stamp:{...overlay.document.stamp,
          baseDocumentVersion:document.version,documentVersion:document.version}})});
        this.invalidate();
        const after=this.capture(this.scope);
        this.commits.set(ids.receiptId,copy({request,saveReceiptId:ids.receiptId,replyTo:ids.transactionMessageId,status:'OK',
          documentVersion:document.version,workspaceVersion:this.options.core.workspace.workspaceVersion,committedContent:document.content,
          beforeProjectRevision:capture.before.revision,afterProjectRevision:after.revision}));
        const settings=this.options.core.readSettings().settings;
        const run=settings?.runProfiles.find(r=>r.kind==='RUN_MAIN') ?? settings?.runProfiles[0];
        if(run) {
          try {await binding.prepareSaveAcknowledgement(this.selectedLease(this.scope,after,gateLease,run));}
          catch {/* unavailable language cannot withhold the original successful ordinary ACK */}
        }
      } else this.invalidate();
      } catch {pending=null;this.invalidate();} // only language preparation; NEVER catch/retry publication
      let current=true;try{this.guard();}catch{current=false;}
      // A control/reconnect can revoke ONLY the language join while postcommit preparation awaits.
      // The genuine already committed ordinary result/receipt must still publish/retain exactly once.
      if(!current){publish(copy(document));return;}
      const associated=binding.publishSaveAck(pending,ids.receiptId,()=>publish(copy(document)));
      if(!associated){this.invalidate();binding.invalidateSource();this.options.onUnassociatedCommit?.(accepted.path);}
    }}).finally(()=>{this.committing=null;});
  }
  readCurrent(peerId:string,path:string):LanguageAckCurrent|null {
    try {this.guard();const o=this.overlays.get(path);if(!o || o.peerId!==peerId)return null;
      const snapshot=this.capture(this.scope);
      return copy({documentMessageId:o.messageId,stamp:o.document.stamp,content:o.document.content,
        projectRevision:snapshot.revision,dependencyManifestSha256:dependencyHash([...this.vector!.disk.files])});
    }catch{return null;}
  }
}
