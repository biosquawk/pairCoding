/** Retained backend HTTP owner. Not a provider/registry/receipt implementation.
 * One server shares process admission across every connection and project replacement. */
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Document } from '../../shared/protocol';
import type { LanguageClientMessage, LanguageView } from '../../shared/language-v2';
import type { LanguageBootstrapV2 } from '../../shared/language-authority-v2';
import type { LanguageEvent, LanguageProjectScope } from '../language/ports';
import { DockerLanguageProcess, LanguageProcessAdmission } from '../language/DockerLanguageProcess';
import { DiskLanguageProcessJournal } from '../language/LanguageProcessJournal';
import type { LanguageDockerDriver } from '../language/DockerLanguageDriver';
import type { DockerTransport } from '../execution/DockerTransport';
import type { MutationAuth } from '../WriteGate';
import type { RuntimeExecutionLayout } from './RuntimeExecutionLayout';
import type { RuntimeStartup } from './RuntimeStartup';
import { RuntimeLanguageSource } from './RuntimeLanguageSource';
import { createRuntimeLanguageBinding } from './RuntimeLanguageBinding';
import { privateDirectory } from './storage';
import { AppError } from '../errors';

export interface RuntimeLanguagePeer {
  readonly id:string; readonly clientId:string; readonly connectionGeneration:string;
  assertCurrent():void;
  emit(event:LanguageEvent):void;
}
export class RuntimeLanguageOwner {
  private active: {peer:RuntimeLanguagePeer;scope:LanguageProjectScope;source:RuntimeLanguageSource;
    binding:ReturnType<typeof createRuntimeLanguageBinding>;epoch:number;owner:string;settings:string;retired:boolean;publishBootstrap():void}|null=null;
  private readonly recovered=new Map<string,DockerLanguageProcess>();
  private recoveryLoaded=false;
  private recoveryIntents:ReturnType<DiskLanguageProcessJournal['listIntents']>=[];
  private operation:Promise<void>=Promise.resolve();
  private refresh:Promise<void>|null=null;
  private revision=0;
  private readonly captures=new Set<Promise<void>>();
  private readers=0;private readBarrier:Promise<void>|null=null;private releaseRead:(()=>void)|null=null;
  /** Short transport read exclusion ONLY for language captures, not a second write authority.
   * Source copy still acquires the SAME actual gate; snapshots never hold that gate across I/O. */
  async readProjection<T>(read:()=>Promise<T>):Promise<T> {
    if(this.readers++===0)this.readBarrier=new Promise(resolve=>{this.releaseRead=resolve;});
    try {await Promise.allSettled([...this.captures]);await this.options.startup.core!.workspace._withQueuedMutation(async()=>{});return await read();}
    finally {if(--this.readers===0){const release=this.releaseRead;this.readBarrier=null;this.releaseRead=null;release?.();}}
  }
  private failure:LanguageView['problem']=null;
  private readonly root:string;
  private readonly journal:DiskLanguageProcessJournal;
  constructor(private readonly options:{startup:RuntimeStartup;layout:RuntimeExecutionLayout;driver:LanguageDockerDriver;
    transport:DockerTransport;admission:LanguageProcessAdmission;assertCurrent():void;onBootstrapReady?():Promise<void>}) {
    this.root=path.join(options.layout.stateDirectory,'language');privateDirectory(this.root);
    const journal=path.join(this.root,'journal');privateDirectory(journal);this.journal=new DiskLanguageProcessJournal(journal);
    privateDirectory(path.join(this.root,'shadows'));
  }
  private unavailable(code:string,message:string):void {
    this.failure={code,message,recovery:'Keep editing; reconcile the retained language owner or select verified language preparation, then reconnect.',retryable:true};
  }
  view():LanguageView {
    const s=this.options.startup,runtime=s.configuration.resolved;
    if(this.active && !this.failure){const status=this.active.binding.view();return this.active.retired?{...status,state:'INDEXING',autocomplete:'INDEXING'}:status;}
    return {projectId:s.core!.workspace.projectId,profileId:runtime?.profile.id??'unconfigured',
      configurationGeneration:s.configuration.configurationGeneration,providerGeneration:this.active?.scope.providerGeneration??'unavailable',
      state:this.failure?'FAILED':'OFF',autocomplete:this.failure?'FAILED':'OFF',docs:'N/A',problem:this.failure};
  }
  bootstrap():LanguageBootstrapV2|null {return this.active&&!this.active.retired&&!this.failure?this.active.binding.bootstrap():null;}
  private async recover():Promise<boolean> {
    const {layout,driver,admission}=this.options;
    if(!this.recoveryLoaded) {
      // Read ONLY the installation's durable journal; never inspect/list unrelated containers.
      for(const intent of this.journal.listIntents()) {
        const ownedRoot=path.dirname(path.dirname(intent.workspaceDirectory));
        if(intent.installationId!==layout.installationId || intent.projectId!==layout.projectId ||
          path.dirname(ownedRoot)!==path.join(this.root,'shadows'))throw Error('Foreign retained language intent');
        this.recoveryIntents.push(intent);
      }
      this.recoveryLoaded=true;
    }
    for(const intent of [...this.recoveryIntents]) {
      const id=intent.launchId;let process=this.recovered.get(id);
      if(!process){process=DockerLanguageProcess.recover(id,{ownedRoot:path.dirname(path.dirname(intent.workspaceDirectory)),driver,journal:this.journal,admission});this.recovered.set(id,process);}
      const result=await process.retire();
      if(!result.confirmed || !result.removed){this.unavailable('PROCESS_STOP_UNCONFIRMED','Retained language process retirement is unconfirmed.');return false;}
      this.recovered.delete(id);this.recoveryIntents=this.recoveryIntents.filter(i=>i.launchId!==id);
    }
    return true;
  }
  private async retireActive():Promise<boolean> {
    const held=this.active;if(!held)return true;
    held.retired=true;held.publishBootstrap();held.source.retire(); // synchronous revocation BEFORE dispose's first await
    const result=await held.binding.retire();
    if(!result.confirmed){this.unavailable('PROCESS_STOP_UNCONFIRMED','Language process retirement is unconfirmed.');return false;}
    if(this.active===held)this.active=null;
    return true;
  }
  /** Explicit HELLO/bootstrap, singleflight across same-client reconnects. Failed Stop retains SAME owner. */
  connect(peer:RuntimeLanguagePeer):Promise<void> {
    this.revoke();const revision=++this.revision;
    const operation=this.operation.then(async()=>{
      if(!await this.retireActive() || !await this.recover())return;
      this.options.assertCurrent();peer.assertCurrent();if(revision!==this.revision)return;
      const {startup,layout,driver,transport,admission}=this.options,core=startup.core!,runtime=startup.configuration.resolved;
      if(!runtime){this.unavailable('LANGUAGE_CONFIGURATION_REQUIRED','Select a valid runtime configuration for language features.');return;}
      if(['jdt','pylsp'].includes(runtime.profile.language.provider) && !startup.arguments.languageReceiptPath){
        this.unavailable('LANGUAGE_RECEIPT_REQUIRED','Select an explicit trusted language receipt at startup.');return;
      }
      const shadow=path.join(this.root,'shadows',randomUUID());privateDirectory(shadow);
      const scope:LanguageProjectScope={projectId:core.workspace.projectId,sessionId:core.session.state.sessionId,profile:runtime.profile,
        configurationGeneration:runtime.configurationGeneration,connectionGeneration:peer.connectionGeneration,
        providerGeneration:randomUUID(),shadowGeneration:randomUUID(),shadowDirectory:shadow};
      const epoch=core.session.state.controlEpoch,owner=core.session.state.writeOwner,settings=core.readSettings().sourceSha256;
      let held:NonNullable<RuntimeLanguageOwner['active']>;
      let publishBootstrap!:()=>void;const publication=new Promise<void>(resolve=>{publishBootstrap=resolve;});
      const assertCurrent=()=>{
        this.options.assertCurrent();peer.assertCurrent();
        if(!held || held.retired || this.active!==held || core.session.state.controlEpoch!==epoch ||
          core.session.state.writeOwner!==owner || core.readSettings().sourceSha256!==settings)
          throw new AppError(409,'LANGUAGE_OWNER_REVOKED','Actual language scope/control/settings changed.');
      };
      const assertPeer=(id:string,message:Readonly<LanguageClientMessage>)=>{
        assertCurrent();if(id!==peer.id || message.clientId!==peer.clientId)throw Error('Foreign language transport');
        core.session.assertClient(message.clientId,message.sessionId);
      };
      const source=new RuntimeLanguageSource({core,runtime,scope,installationId:layout.installationId,assertCurrent,assertPeer,onUnassociatedCommit:path=>{
        if(source.hasOverlay(path))void this.rebootstrap().then(()=>this.options.onBootstrapReady?.()).catch(()=>this.unavailable('LANGUAGE_OWNER_UNAVAILABLE','Language scope requires reconnect.'));
        else this.sourceChanged();
      }});
      const binding=createRuntimeLanguageBinding({scope,sourceAuthority:source,saveAuthority:source,assertCurrent,assertPeer,
        selected:{ownedRoot:shadow,driver,journal:this.journal,admission,transport,preparedOutputRoots:startup.arguments.preparedRuntimeRoots,
          // Nonremote providers do not read the receipt. No fabricated remote readiness/receipt.
          ...(startup.arguments.languageReceiptPath===undefined?{}:{languageReceiptPath:startup.arguments.languageReceiptPath}),withSourceLease:async(s,v,action)=>{
            // Actual first snapshot must publish before the provider's capture can occupy FIFO.
            // This waits OUTSIDE the source queue, and is released on revocation too.
            await publication;while(this.readBarrier)await this.readBarrier;assertCurrent();
            const operation=source.withSourceLease(s,v,action);this.captures.add(operation);
            try{await operation;}finally{this.captures.delete(operation);}
          }},
        emit:event=>peer.emit(event)});
      held={peer,scope,source,binding,epoch,owner,settings,retired:false,publishBootstrap};this.active=held;this.failure=null;
      await binding.start();assertCurrent();
    });
    this.operation=operation.catch(()=>{});
    return operation.catch(()=>{this.unavailable('LANGUAGE_OWNER_UNAVAILABLE','Language owner initialization is unavailable.');});
  }
  published():void {const held=this.active;if(held&&!held.retired)held.publishBootstrap();}
  async handle(peerId:string,message:LanguageClientMessage) {
    const held=this.active;if(!held||held.retired||held.peer.id!==peerId)throw new AppError(409,'LANGUAGE_OWNER_REQUIRED','Reconnect to bootstrap the current language owner.');
    held.peer.assertCurrent();
    if(['LANGUAGE_OPEN','LANGUAGE_CHANGE','LANGUAGE_CLOSE'].includes(message.type))await held.source.admit(peerId,message);
    if(this.active!==held||held.retired)throw Error('Language admission superseded');
    return held.binding.handle(peerId,message);
  }
  writeWithAck(input:MutationAuth & {path:string;baseVersion:number;content:string},
    correlation:{peerId:string;transactionMessageId:string;languageDocumentMessageId:string|null;receiptId:string},
    assertPeer:()=>void,publish:(document:Readonly<Document>)=>void,captureCommit:(document:Readonly<Document>)=>void):Promise<Document> {
    const held=this.active;
    if(!held||held.retired||held.peer.id!==correlation.peerId) {
      return this.options.startup.core!.gate._writeWithLanguageCommit(input,{assertCurrent:assertPeer,beforeCommit:()=>null,
        afterCommit:async document=>{captureCommit(document);publish(document);}});
    }
    return held.source.writeWithAck(input,correlation,held.binding,assertPeer,publish,captureCommit);
  }
  /** Exact synchronous WriteGate event exclusion, NEVER an async save-wide suppression flag. */
  ownsCommit(change:{path?:string;workspaceVersion:number;actor:string}):boolean {return this.active?.source.ownsCommit(change)??false;}
  sourceChanged():void {
    const held=this.active;if(!held||held.retired)return;
    held.source.invalidate();held.binding.invalidateSource(); // SAME synchronous event stack, no capture/await
    if(this.refresh)return;
    // Enter the SAME FIFO after the emitting mutation, then RELEASE it before registry scheduling.
    // The selected factory reacquires and fences its actual source lease before copy/owner transfer.
    const operation=this.options.startup.core!.workspace._withQueuedMutation(async()=>{}).then(async()=>{
      this.refresh=null;if(this.active!==held||held.retired)return;
      this.options.assertCurrent();held.peer.assertCurrent();await held.binding.refreshSource();
    }).catch(()=>{if(this.active===held&&!held.retired)this.unavailable('LANGUAGE_SOURCE_REFRESH_FAILED','Current complete source could not be refreshed.');});
    this.refresh=operation;
  }
  hasOverlay(path:string):boolean {return this.active?.source.hasOverlay(path)??false;}
  scopeChanged():boolean {
    const held=this.active;if(!held||held.retired)return false;
    const core=this.options.startup.core!;
    return held.epoch!==core.session.state.controlEpoch || held.owner!==core.session.state.writeOwner || held.settings!==core.readSettings().sourceSha256;
  }
  /** Caller publishes a fresh bootstrap after this explicit control/scope transition finishes. */
  rebootstrap():Promise<void> {const peer=this.active?.peer;return peer?this.connect(peer):Promise.resolve();}
  revoke():void {
    this.revision++;const held=this.active;if(!held||held.retired)return;
    held.retired=true;held.publishBootstrap();held.source.retire();void held.binding.retire().then(result=>{
      if(!result.confirmed)this.unavailable('PROCESS_STOP_UNCONFIRMED','Language process retirement is unconfirmed.');
    }).catch(()=>this.unavailable('PROCESS_STOP_UNCONFIRMED','Language process retirement is unconfirmed.'));
  }
  async retire():Promise<boolean> {this.revision++;await this.operation;return await this.retireActive() && await this.recover();}
}
