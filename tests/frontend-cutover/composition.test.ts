/** Structural public Monaco harness + actual accepted bridge/client composition: UNIT, not real Monaco. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { RuntimeWiringV2, type WiringControllerV2 } from '../../src/services/runtimeWiringV2';
import { MonacoLspBridge } from '../../src/services/monacoLspBridge';
import { harness, Model } from '../editor-language/harness';
import { contentSha256 } from '../../src/language/uriCodec';
import type { DocumentStamp } from '../../src/shared/language-v2';
function setup(t:any) {
  const h=harness();h.bridge.dispose();
  const docs=new Map(h.models.map(m=>[m.path,{content:m.content,version:1,readOnly:false,conflict:false}]));
  const controller:WiringControllerV2={projectId:'projekt',sessionId:'s1',clientId:'c1',connectionGeneration:'transport1',connected:true,synced:true,writeOwner:'STUDENT',controlEpoch:0,preparing:false,vetoPending:false,
    language:{projectId:'projekt',sessionId:'s1',profileId:'profile',connectionGeneration:'server1',configurationGeneration:'cfg1',providerGeneration:'provider1',shadowGeneration:'shadow1',provider:'remote'},document:p=>docs.get(p)??null};
  const sent:any[]=[],problems:string[]=[];
  const wiring=new RuntimeWiringV2({current:()=>controller,messageId:()=>crypto.randomUUID(),send:m=>sent.push(m),problem:m=>problems.push(m),status:()=>{},runtime:{current:()=>null,requestId:()=>crypto.randomUUID(),http:{run:async()=>null,stop:async()=>null,saveSettings:async()=>null}}});
  const bridge=new MonacoLspBridge(h.monaco,h.editor,wiring.getBinding('projekt'));t.after(()=>{bridge.dispose();wiring.invalidate('DISCONNECTED');});
  const result=(stamp:DocumentStamp,requestId:string)=>({stamp,requestId,items:[{id:'item1',label:'safe',detail:null,primary:{path:stamp.path,range:{startLine:1,startColumn:5,endLine:1,endColumn:5},text:'safe'},additionalTextEdits:[]}],isIncomplete:false});
  let seq=0;const receive=(type:string,payload:any)=>wiring.receive({protocolVersion:'3.0',messageId:`m${++seq}`,seq,sessionId:'s1',type,payload} as any);
  return {h,docs,controller,wiring,bridge,sent,result,receive,problems};
}
test('remote completion uses actual current model/lifetime and one undoable edit; inactive changes/Undo observed',async t=>{
  const f=setup(t);const request=f.bridge.requestCompletion('.');const message=f.sent.find(m=>m.type==='LANGUAGE_COMPLETE');assert.ok(message);
  assert.equal(message.payload.stamp.localModelVersion,f.h.primary.getVersionId());assert.equal(message.payload.stamp.contentSha256,contentSha256(f.h.primary.content));
  assert.equal(f.receive('COMPLETE_RESULT',f.result(message.payload.stamp,message.payload.requestId)),true);await request;
  assert.equal(f.bridge.acceptance.accept({requestId:message.payload.requestId,stamp:message.payload.stamp,item:f.result(message.payload.stamp,message.payload.requestId).items[0]}).accepted,true);
  assert.equal(f.h.primary.pushes,1);assert.equal(f.h.primary.content,'obj.safe');
  f.h.primary.undo();assert.equal(f.h.primary.content,'obj.');
  f.h.inactive.change('other changed');assert.ok(f.sent.some(m=>m.type==='LANGUAGE_CHANGE'&&m.payload.stamp.path==='other.ts'));
  assert.equal(f.sent.some(m=>m.type==='CODE_CHANGED'),false,'composition has no second persistence path');
});
test('open widget -> denied PREPARE -> Enter is fenced synchronously until genuinely newer epoch',async t=>{
  const f=setup(t),promise=f.bridge.requestCompletion('.'),m=f.sent.find(m=>m.type==='LANGUAGE_COMPLETE');
  f.receive('COMPLETE_RESULT',f.result(m.payload.stamp,m.payload.requestId));await promise;assert.equal(f.h.widgets[0].getDomNode().style.display,'block');
  f.wiring.invalidate('CONTROL_PREPARE');assert.equal(f.h.widgets[0].getDomNode().style.display,'none');f.wiring.authoritativeState(0);
  assert.equal(f.bridge.acceptance.current().controlPrepare,true);assert.equal(f.bridge.acceptance.accept({requestId:m.payload.requestId,stamp:m.payload.stamp,item:f.result(m.payload.stamp,m.payload.requestId).items[0]}).accepted,false);assert.equal(f.h.primary.pushes,0);
  f.controller.controlEpoch=1;f.wiring.authoritativeState(1);assert.equal(f.bridge.acceptance.current().controlPrepare,false);
});
test('immutable source ledger rejects receipt alias, mutated unopened overlay/dependencies and retired lifetime',t=>{
  const f=setup(t);const current=f.bridge.acceptance.current();
  // Send primary after all inactive models have been observed, establishing this whole overlay vector.
  f.h.primary.change('obj.');const stamp=f.bridge.acceptance.current().stamp;
  const r={sourceStamp:stamp,presentationStamp:stamp,association:null,provenance:{kind:'IMMUTABLE_GENERATION' as const,launchId:'launch',lspVersion:null,inputManifestSha256:contentSha256('server manifest')},items:[],truncated:false};
  assert.equal(f.wiring.verifyDiagnostics(r,f.bridge.getModelSnapshots()),true);
  assert.equal(f.wiring.verifyDiagnostics({...r,association:{saveReceiptId:'present-is-not-proof'}}),false);
  f.h.inactive.change('new dependency');assert.equal(f.wiring.verifyDiagnostics(r),false);
  f.wiring.sourceChanged();assert.equal(f.wiring.verifyDiagnostics(r),false);
  f.wiring.fileOperation('RENAME',f.h.primary.path,'renamed.ts');assert.equal(f.bridge.getModelSnapshots().some(m=>m.path===f.h.primary.path),false);
});
test('ACK-only transitions clear/cancel without model mutation/didChange or alias permission',t=>{
  const f=setup(t);f.h.primary.change('obj.');const before=f.sent.filter(m=>m.type==='LANGUAGE_CHANGE').length,version=f.h.primary.version;
  f.docs.set(f.h.primary.path,{content:f.h.primary.content,version:2,readOnly:false,conflict:false});f.wiring.ackTransition();
  assert.equal(f.h.primary.version,version);assert.equal(f.sent.filter(m=>m.type==='LANGUAGE_CHANGE').length,before);
  assert.equal(f.bridge.acceptance.current().stamp.documentVersion,2);
});
test('same synchronous facade handles approved builtin; offline/COACH/veto invalidate late candidates',async t=>{
  const f=setup(t);f.controller.language!.provider='builtin';
  let calls=0;f.wiring.setBuiltin(async(_model,r)=>{calls++;return f.result(r.stamp,r.requestId);});await f.bridge.requestCompletion('.');
  assert.equal(calls,1);assert.equal(f.sent.some(m=>m.type==='LANGUAGE_COMPLETE'),false);
  const node=f.h.widgets[0].getDomNode();assert.equal(node.style.display,'block');f.wiring.invalidate('VETO');assert.equal(node.style.display,'none');
  f.controller.vetoPending=true;await f.bridge.requestCompletion('.');assert.equal(calls,1);f.controller.vetoPending=false;f.controller.writeOwner='COACH';f.wiring.authoritativeState(1);await f.bridge.requestCompletion('.');assert.equal(calls,1);
  f.controller.connected=false;f.wiring.invalidate('DISCONNECTED');assert.equal(f.h.primary.content,'obj.');
});
test('no server bootstrap means OFF and no synthesized LANGUAGE_OPEN even with actual models',t=>{
  const f=setup(t);f.controller.language=null;f.wiring.invalidate('SCOPE');f.wiring.authoritativeState(1);
  const n=f.sent.length;f.h.primary.change('manual draft');assert.equal(f.sent.length,n);assert.equal(f.h.primary.content,'manual draft');
});
