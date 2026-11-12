/** Actual LiveBackend receive/save-flight + RuntimeWiring + bridge; controlled HTTP/WS only. */
import test from 'node:test';import assert from 'node:assert/strict';import {setImmediate} from 'node:timers/promises';
import {URI} from 'monaco-editor/esm/vs/base/common/uri.js';
import {LiveBackend} from '../../src/services/LiveBackend';
import {MonacoLspBridge,toModelUri} from '../../src/services/monacoLspBridge';
import {harness} from '../editor-language/harness';import {result} from '../editor-language/fixtures';import {bundle,doc} from '../frontend-cutover/fixtures';
async function setup(t:any){
 const b=bundle();(b as any).languageBootstrap={connectionGeneration:'local',shadowGeneration:'lifetime',provider:'builtin',features:{completion:true,diagnostics:false}};
 const sent:any[]=[];const socket:any={readyState:1,send(raw:string){sent.push(JSON.parse(raw));},close(){this.readyState=3;}};
 const live=new LiveBackend({token:'unit-only',clientId:'c1',socket:()=>socket,fetch:(async(input)=>{const u=new URL(String(input));return Response.json(u.pathname==='/api/project'?b.project:u.pathname==='/api/session'?b.session:u.pathname==='/api/snapshots'?[]:doc(u.searchParams.get('path')??'main.txt'));}) as typeof fetch});
 let seq=0;const receive=(payload:any,extra:any={})=>live.receive({protocolVersion:'3.0',messageId:'reply'+ ++seq,sessionId:'s1',seq,type:'ACK',payload,...extra} as any);
 await live.connect();live.receive({protocolVersion:'3.0',messageId:'snapshot',sessionId:'s1',seq:++seq,type:'SESSION_SNAPSHOT',payload:b} as any);await setImmediate();assert.equal(live.getState().isOffline,false);
 const h=harness();h.bridge.dispose();h.primary.uri=URI.parse(toModelUri('p1','main.txt'));const requests:any[]=[];
 live.setBuiltinLanguageProvider(async(_m,r)=>{requests.push(r);return result(r.stamp,r.requestId);});
 const binding=live.getEditorLanguageBinding()!;const bridge=new MonacoLspBridge(h.monaco,h.editor,binding);t.after(()=>{bridge.dispose();live.close();});
 t.mock.timers.enable({apis:['setTimeout']});live.saveFileContent('main.txt','obj.');t.mock.timers.tick(150);const save=sent.find(m=>m.type==='CODE_CHANGED');assert.ok(save);await bridge.requestCompletion(null);assert.equal(h.widgets[0].getDomNode().children.length,1);
 return {live,h,bridge,receive,requests,sent,save,ack:{replyTo:save.messageId,status:'OK',documentVersion:2,workspaceVersion:2,controlEpoch:0,error:null}};
}
test('only original verified successful save ACK refreshes through the actual LiveBackend caller',async t=>{
 const f=await setup(t);const original=f.requests[0];f.receive(f.ack);await setImmediate();assert.equal(f.requests.length,2);assert.notEqual(f.requests[1].requestId,original.requestId);assert.equal(f.requests[1].stamp.documentVersion,2);assert.equal(f.h.widgets[0].getDomNode().children.length,1);assert.equal(f.sent.filter(m=>m.type==='CODE_CHANGED').length,1);assert.equal(f.sent.some(m=>m.type.startsWith('LANGUAGE_')),false);
});
for(const kind of ['foreign-reply','foreign-session','stale','rejected'])test('actual caller rejects '+kind+' save without a new local request',async t=>{
  const f=await setup(t),ack={...f.ack};if(kind==='foreign-reply')ack.replyTo='another-save';if(kind==='stale'){ack.status='DUPLICATE';ack.documentVersion=1;}if(kind==='rejected'){ack.status='REJECTED';ack.documentVersion=null as any;}
  if(kind==='foreign-session')assert.throws(()=>f.receive(ack,{sessionId:'other-session'}),/Niepoprawna koperta protokołu/);else f.receive(ack);await setImmediate();assert.equal(f.requests.length,1,kind);assert.equal(f.h.primary.pushes,0,kind);assert.equal(f.sent.filter(m=>m.type==='CODE_CHANGED').length,1,kind);
});
