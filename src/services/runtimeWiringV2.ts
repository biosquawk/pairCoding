/** Local editor authority composed with the ordinary runtime/save controller. No language transport. */
import type * as M from 'monaco-editor';
import type { CompleteRequest, AcceptanceState, DiagnosticsResult, DocumentStamp, LanguageClientMessage, LanguageServerMessage, LanguageView } from '../shared/language-v2';
import type { BridgeAuthority, BridgeEvent, EditorLanguageBinding, LocalFeatureState, ModelSnapshot } from './monacoLspBridge';
import { contentSha256, normalizeContent } from '../language/uriCodec';
import { RuntimeClientV2, type RuntimeClientV2Dependencies } from './RuntimeClientV2';
export interface LanguageAuthorityV2 {
  projectId:string; sessionId:string; profileId:string; connectionGeneration:string;
  configurationGeneration:string; providerGeneration:string; shadowGeneration:string;
  provider:'builtin'|'remote'|'off'; features?:{completion:boolean;diagnostics:boolean};
}
export interface WiringControllerV2 {
  projectId:string; sessionId:string; clientId:string; connectionGeneration:string;
  connected:boolean; synced:boolean; writeOwner:'STUDENT'|'COACH'; controlEpoch:number;
  preparing:boolean; vetoPending:boolean; language:LanguageAuthorityV2|null;
  sourceVector?:string; workspaceVersion?:number;
  drafts?:readonly {path:string;content:string;baseVersion:number;conflict:boolean}[];
  document(path:string):{content:string;version:number;readOnly:boolean;conflict:boolean}|null;
}
/** Ordinary ACK stays verified by LiveBackend's existing ordered save-flight controller. */
export interface AutosaveAckEnvelope {
  messageId:string; sessionId:string; replyTo:string; status:'OK'|'DUPLICATE'|'REJECTED';
  documentVersion:number|null; workspaceVersion:number; controlEpoch:number;
}
export class RuntimeWiringV2 {
  readonly runtime:RuntimeClientV2;
  private revision=0;
  private requestGeneration=0;
  private models=new Map<string,ModelSnapshot>();
  private listeners=new Set<(event:BridgeEvent)=>void>();
  private binding?:EditorLanguageBinding;
  private bindingScope='';
  private invalidating=false;
  private prepareEpoch:number|null=null;
  private builtin?:EditorLanguageBinding['builtin'];
  constructor(private readonly deps:{current():WiringControllerV2|null;runtime:RuntimeClientV2Dependencies;
    send(message:LanguageClientMessage):void;messageId():string;problem(message:string):void;status(view:LanguageView):void;
    localStatus?(completion:LocalFeatureState,diagnostics:LocalFeatureState|'N/A',problem:string|null):void;
  }) {this.runtime=new RuntimeClientV2(deps.runtime);}
  setBuiltin(provider:EditorLanguageBinding['builtin']) {this.builtin=provider;this.emit({type:'AUTHORITY_CHANGED'});}
  private emit(event:BridgeEvent) {for(const listener of this.listeners)listener(event);}
  invalidate(type:'CONTROL_PREPARE'|'VETO'|'DISCONNECTED'|'SCOPE'|'CONFLICT') {
    if(this.invalidating)return;this.invalidating=true;
    try {
      this.revision++;this.requestGeneration++;
      if(type==='CONTROL_PREPARE')this.prepareEpoch=this.deps.current()?.controlEpoch??0;
      this.emit({type});
      if(type==='DISCONNECTED'||type==='SCOPE')this.models.clear();
      if(type==='DISCONNECTED'){this.retireBinding();this.runtime.invalidate();}
    }finally{this.invalidating=false;}
  }
  sourceChanged(){this.revision++;this.requestGeneration++;this.emit({type:'AUTHORITY_CHANGED'});}
  authoritativeState(epoch:number){
    if(this.binding&&this.bindingContext(this.binding.projectId)!==this.bindingScope)this.retireBinding();
    if(this.prepareEpoch!==null&&epoch>this.prepareEpoch)this.prepareEpoch=null;
    this.revision++;this.emit({type:'AUTHORITY_CHANGED'});
  }
  draftChanged(_path:string,_content:string){ /* Actual Monaco bytes, not the autosave mirror, identify a local request. */ }
  /** Historical API is inert; language frames/receipts never grant ordinary save authority. */
  beginAutosave(_id:string,_path:string,_content:string,_version:number,_epoch:number):undefined{return undefined;}
  cancelAutosave(_id:string){}
  prepareAutosaveAck(_ack:AutosaveAckEnvelope){}
  ackTransition(_ack?:AutosaveAckEnvelope){this.revision++;this.requestGeneration++;this.emit({type:'AUTHORITY_CHANGED'});}
  fileOperation(operation:'CREATE'|'RENAME'|'DELETE',path:string,newPath?:string){
    this.revision++;this.requestGeneration++;
    this.emit({type:'FILE_OPERATION',operation,path,newPath});if(operation!=='CREATE')this.models.delete(path);
  }
  private readAuthority(model:Readonly<ModelSnapshot>):BridgeAuthority|null {
    const c=this.deps.current(),s=c?.language;
    if(!c||!s||s.provider!=='builtin'||s.projectId!==c.projectId||s.sessionId!==c.sessionId||
      model.content!==normalizeContent(model.content)||contentSha256(model.content)!==model.contentSha256)return null;
    const doc=c.document(model.path);if(!doc)return null;
    const previous=this.models.get(model.path);
    if(!previous||previous.modelLifetime!==model.modelLifetime||previous.localModelVersion!==model.localModelVersion||previous.content!==model.content){
      this.models.set(model.path,structuredClone(model));this.requestGeneration++;this.revision++;
    }
    return {revision:this.revision,stamp:{projectId:c.projectId,sessionId:c.sessionId,profileId:s.profileId,
      connectionGeneration:s.connectionGeneration,configurationGeneration:s.configurationGeneration,providerGeneration:s.providerGeneration,
      shadowGeneration:s.shadowGeneration,baseDocumentVersion:doc.version,documentVersion:normalizeContent(doc.content)===model.content?doc.version:null,
      controlEpoch:c.controlEpoch,requestGeneration:this.requestGeneration},connected:c.connected,synced:c.synced,writeOwner:c.writeOwner,
      controlPrepare:c.preparing||this.prepareEpoch!==null,vetoPending:c.vetoPending,conflict:doc.conflict,readOnly:doc.readOnly};
  }
  /** Retired remote server frames are never consumed by the local editor. */
  verifyDiagnostics(_r:DiagnosticsResult,_models?:readonly ModelSnapshot[]):boolean{return false;}
  receive(_message:LanguageServerMessage){return false;}
  private bindingContext(projectId:string){const c=this.deps.current();return c?.projectId===projectId?
    JSON.stringify([c.projectId,c.sessionId,c.clientId,c.connectionGeneration,c.language?.configurationGeneration,c.language?.providerGeneration,c.language?.shadowGeneration]):'';}
  private retireBinding(){this.binding=undefined;this.bindingScope='';this.listeners.clear();}
  getBinding(projectId:string):EditorLanguageBinding {
    const scope=this.bindingContext(projectId);
    if(this.binding?.projectId===projectId&&this.bindingScope===scope)return this.binding;
    this.retireBinding();
    const active=()=>{
      if(!scope||this.binding!==binding||this.bindingScope!==scope)return false;
      if(this.bindingContext(projectId)!==scope){this.retireBinding();return false;}return true;
    };
    const mutable=()=>active()&&!this.invalidating;
    const binding:EditorLanguageBinding={projectId,
      readAuthority:m=>mutable()?this.readAuthority(m):null,
      sendDocument:()=>{},complete:()=>Promise.reject(new Error('Zdalne podpowiedzi wyłączone.')),cancel:()=>{},
      subscribe:fn=>{if(!active())return()=>{};const listener=(e:BridgeEvent)=>{if(active())fn(e);};this.listeners.add(listener);return()=>{this.listeners.delete(listener);};},
      verifyDiagnostics:()=>false,
      features:()=>mutable()&&this.deps.current()?.language?.provider==='builtin'?this.deps.current()?.language?.features??null:null,
      builtin:Object.assign((m:M.editor.ITextModel,r:CompleteRequest,s:AbortSignal)=>{
        if(!mutable()||this.deps.current()?.language?.provider!=='builtin'||this.deps.current()?.language?.features?.completion!==true)return null;
        const provided=this.builtin?.(m,r,s);
        return provided?provided.then(value=>{if(!mutable())throw Error('Wycofane powiązanie lokalnego modelu.');return value;}):null;
      },{
        ready:async (m:M.editor.ITextModel)=>mutable()?await this.builtin?.ready?.(m)??false:false,
        hasDiagnostics:(m:M.editor.ITextModel)=>mutable()&&!!this.builtin?.hasDiagnostics?.(m),
        diagnostics:async (m:M.editor.ITextModel)=>mutable()&&this.deps.current()?.language?.features?.diagnostics===true?await this.builtin?.diagnostics?.(m)??null:null,
      }) as NonNullable<EditorLanguageBinding['builtin']>,
      localStatus:(c,d,p)=>{if(mutable())this.deps.localStatus?.(c,d,p);},
      onProblem:m=>{if(mutable())this.deps.problem(m);},
    };
    this.bindingScope=scope;return this.binding=binding;
  }
}
