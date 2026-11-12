/** Structural public-surface Monaco/DOM harness; emphatically NOT a real Monaco/browser proof. */
import { URI } from 'monaco-editor/esm/vs/base/common/uri.js';
import { MonacoLspBridge, toModelUri } from '../../src/services/monacoLspBridge';
import type { BridgeEvent, BridgeAuthority, EditorLanguageBinding } from '../../src/services/monacoLspBridge';
import type { CompleteRequest, CompleteResult } from '../../src/shared/language-v2';
import { result, stamp } from './fixtures';
export class Event<T=void> {
  callbacks=new Set<(e:T)=>void>();
  on=(cb:(e:T)=>void)=>{this.callbacks.add(cb);return {dispose:()=>{this.callbacks.delete(cb);}};};
  fire(e:T){[...this.callbacks].forEach(cb=>cb(e));}
}
class Node {
  id='';style:any={};attrs=new Map<string,string>();children:Node[]=[];textContent='';title='';onmousedown?: (e:any)=>void;
  setAttribute(k:string,v:string){this.attrs.set(k,v);}removeAttribute(k:string){this.attrs.delete(k);}
  append(n:Node){this.children.push(n);}replaceChildren(){this.children=[];}remove(){}scrollIntoView(){}
}
(globalThis as any).document={createElement:()=>new Node()};
class Range {
  constructor(public startLineNumber:number,public startColumn:number,public endLineNumber:number,public endColumn:number){}
  getEndPosition(){return {lineNumber:this.endLineNumber,column:this.endColumn};}
}
class Selection extends Range {}
export class Model {
  readonly event=new Event<any>(); uri:URI;version=1;disposed=false;pushes=0;boundaries=0;history:string[]=[];
  constructor(readonly path:string,public content='obj.') {this.uri=URI.parse(toModelUri('projekt',path));}
  getValue(){return this.content;}getVersionId(){return this.version;}isDisposed(){return this.disposed;}
  onDidChangeContent=this.event.on;
  getLineContent(line:number){return this.content.split('\n')[line-1] ?? '';}
  getValueLength(){return this.content.length;}
  getOffsetAt(p:{lineNumber:number;column:number}){const lines=this.content.split('\n');return lines.slice(0,p.lineNumber-1).reduce((s,l)=>s+l.length+1,0)+p.column-1;}
  getPositionAt(n:number){const before=this.content.slice(0,n).split('\n');return {lineNumber:before.length,column:before.at(-1)!.length+1};}
  getWordUntilPosition(p:any){return {startColumn:p.column,endColumn:p.column};}
  pushStackElement(){this.boundaries++;}
  pushEditOperations(_selections:any,edits:any[],cursor:any){
    this.pushes++;this.history.push(this.content);
    const offsets=edits.map(e=>({...e,start:this.getOffsetAt({lineNumber:e.range.startLineNumber,column:e.range.startColumn}),end:this.getOffsetAt({lineNumber:e.range.endLineNumber,column:e.range.endColumn})})).sort((a,b)=>b.start-a.start);
    for(const e of offsets)this.content=this.content.slice(0,e.start)+e.text+this.content.slice(e.end);
    this.version++;this.event.fire({isUndoing:false,isRedoing:false,changes:edits.map(e=>({text:e.text}))});
    cursor(edits.map(e=>({range:e.range})));return null;
  }
  change(content:string,flags:any={}){this.content=content;this.version++;this.event.fire({isUndoing:false,isRedoing:false,...flags,changes:[{text:content,rangeOffset:0,rangeLength:0}]});}
  undo(){this.change(this.history.pop()!,{isUndoing:true});}
}
export function harness() {
  const create=new Event<any>(),dispose=new Event<any>(),modelEvent=new Event<any>(),cursor=new Event<any>(),key=new Event<any>(),editorDispose=new Event<any>();
  const primary=new Model('src/Zażółć space 😀.ts'),inactive=new Model('other.ts','other');let active:Model|null=primary;let position={lineNumber:1,column:5};
  const models=[primary,inactive],markers=new Map<Model,any[]>(),widgets:any[]=[],sync:any[]=[],cancelled:any[]=[],requests:CompleteRequest[]=[],problems:string[]=[];
  let listener:(event:BridgeEvent)=>void=()=>{},revision=1,authorityStamp=stamp();
  const flags:any={writeOwner:'STUDENT',connected:true,synced:true,controlPrepare:false,vetoPending:false,conflict:false,readOnly:false};
  let complete:(request:CompleteRequest,signal:AbortSignal)=>Promise<CompleteResult>=async r=>result(r.stamp,r.requestId);
  let verify:EditorLanguageBinding['verifyDiagnostics']=()=>true;
  const readAuthority=():BridgeAuthority=>{
    const {path,modelLifetime,localModelVersion,contentSha256,...scope}=authorityStamp;
    return {...flags,revision,stamp:scope};
  };
  const binding:EditorLanguageBinding={projectId:'projekt',readAuthority,sendDocument:(kind,document)=>sync.push({kind,document:structuredClone(document)}),
    features:()=>({completion:true,diagnostics:true}),
    builtin:(model,request,signal)=>{requests.push(structuredClone(request));return complete(request,signal);},
    complete:(request,signal)=>{requests.push(structuredClone(request));return complete(request,signal);},cancel:r=>cancelled.push(r),
    subscribe:cb=>{listener=cb;return()=>{listener=()=>{};};},verifyDiagnostics:(...a)=>verify(...a),onProblem:message=>problems.push(message)};
  const dom=new Node();
  const editor:any={getModel:()=>active,getPosition:()=>position,getSelections:()=>[],getDomNode:()=>dom,
    updateOptions:(o:any)=>{editor.options={...editor.options,...o};},addContentWidget:(w:any)=>widgets.push(w),removeContentWidget:(w:any)=>widgets.splice(widgets.indexOf(w),1),layoutContentWidget:()=>{},
    onDidChangeModel:modelEvent.on,onDidChangeCursorPosition:cursor.on,onKeyDown:key.on,onDidDispose:editorDispose.on};
  const mode=()=>({modeConfiguration:{completionItems:true,hovers:true},setModeConfiguration(c:any){this.modeConfiguration=c;}});
  const monaco:any={typescript:{typescriptDefaults:mode(),javascriptDefaults:mode()},json:{jsonDefaults:mode()},css:{cssDefaults:mode(),lessDefaults:mode(),scssDefaults:mode()},html:{htmlDefaults:mode(),handlebarDefaults:mode(),razorDefaults:mode()},Range,Selection,KeyCode:{Escape:9,Enter:3,Tab:2,DownArrow:18,UpArrow:16},MarkerSeverity:{Error:8,Warning:4,Info:2,Hint:1},
    editor:{getModels:()=>models,onDidCreateModel:create.on,onWillDisposeModel:dispose.on,setModelMarkers:(m:Model,_owner:string,items:any[])=>markers.set(m,items),CursorChangeReason:{ContentFlush:1},ContentWidgetPositionPreference:{BELOW:2,ABOVE:1}}};
  const bridge=new MonacoLspBridge(monaco,editor,binding);
  return {bridge,binding,monaco,primary,inactive,models,markers,widgets,sync,cancelled,requests,problems,flags,dom,editor,
    emit:(event:BridgeEvent)=>listener(event),key:(keyCode:number)=>{const event={keyCode,preventDefault(){},stopPropagation(){},code:'',ctrlKey:false,metaKey:false};key.fire(event);},
    add:(model:Model)=>{models.push(model);create.fire(model);},switch:(model:Model)=>{active=model;modelEvent.fire({});},
    get position(){return position;},set position(p){position=p;cursor.fire({reason:3});},
    get revision(){return revision;},set revision(v){revision=v;},get authorityStamp(){return authorityStamp;},set authorityStamp(v){authorityStamp=v;},
    set complete(fn:typeof complete){complete=fn;},set verify(fn:typeof verify){verify=fn;},
  };
}
