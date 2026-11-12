/** Actual backend source FIFO + canonical WriteGate + accepted selected binding/issuer/registry.
 * UNIT injected Docker/process/preparation evidence only. Not HTTP/LIVE/native proof. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fixture} from '../runtime-language-binding/fixture';
import {createRuntimeWorkspace} from '../../src/server/runtime-coordinator/RuntimeWorkspace';
import {RuntimeLanguageSource} from '../../src/server/runtime-coordinator/RuntimeLanguageSource';
import {createRuntimeLanguageBinding} from '../../src/server/runtime-coordinator/RuntimeLanguageBinding';
import type {LanguageClientMessage,OpenOrChange} from '../../src/shared/language-v2';
import type {SelectedLanguageLease} from '../../src/server/language/SelectedCacheLanguageAuthority';
import * as codec from '../../src/language/uriCodec';
// Backend source assertions scan real disk and durable kernel-held state at each boundary;
// the helper fixture's 5s fake-authority observation budget is not a backend startup SLA.
async function until(check:()=>boolean,detail:string){const deadline=Date.now()+20000;while(!check()&&Date.now()<deadline)await new Promise(r=>setTimeout(r,10));assert.ok(check(),detail);}
async function composed(t:Parameters<typeof fixture>[0]) {
  let cleanup=async()=>{};t.after(()=>cleanup());
  const f=await fixture(t,'java-maven'),runtime=f.lease().runtime,run=f.lease().run;
  fs.mkdirSync(path.join(f.workspace,'.paircoach'),{mode:0o700});
  fs.writeFileSync(path.join(f.workspace,'.paircoach','settings.json'),JSON.stringify({schemaVersion:2,taskFilePath:null,taskMode:'IMPLEMENTATION',reviewNotesPath:'review.md',runProfiles:[run],aiConsent:false,contextPatterns:[]}));
  const core=await createRuntimeWorkspace({rootPath:f.workspace});core.session.claimLease('tab');
  const scope={...f.options.scope,projectId:core.workspace.projectId,sessionId:core.session.state.sessionId};
  let alive=true,published=0;
  const source=new RuntimeLanguageSource({core,runtime,scope,installationId:'binding-unit-install',assertCurrent(){if(!alive || core.session.state.sessionId!==scope.sessionId || core.workspace.rootPath!==runtime.workspaceRoot)throw Error('actual source owner retired');},assertPeer(p,m){assert.equal(p,'real-transport');assert.equal(m.clientId,'tab');core.session.assertClient(m.clientId,m.sessionId);}});
  const document:OpenOrChange={...f.document,content:codec.normalizeContent(f.document.content),stamp:{...f.document.stamp,projectId:scope.projectId,sessionId:scope.sessionId,controlEpoch:core.session.state.controlEpoch}};
  const wire=(id:string,d=document):LanguageClientMessage=>({protocolVersion:'3.0',messageId:id,sessionId:scope.sessionId,clientId:'tab',type:'LANGUAGE_OPEN',payload:d});
  const events:typeof f.events=[],leases:SelectedLanguageLease[]=[],launchLeases=new Map<string,SelectedLanguageLease>();
  const binding=createRuntimeLanguageBinding({...f.options,scope,sourceAuthority:source,saveAuthority:source,
    assertCurrent(){if(!alive)throw Error('actual owner retired');},assertPeer(p,m){assert.equal(p,'real-transport');core.session.assertClient(m.clientId,m.sessionId);},emit(e){events.push(e);},
    selected:{...f.options.selected,withSourceLease:async(s,snapshot,action)=>{try {await source.withSourceLease(s,snapshot,async token=>{leases.push(token);await action(token);for(const id of fs.readdirSync(f.owned))if(!launchLeases.has(id))launchLeases.set(id,token);});}catch(error){console.error('NEW_SOURCE_CAPTURE_ERROR',error);throw error;}}}});
  // Actual start/copy callback must have released the SAME root/gate token before any provider start.
  f.driver.beforeCreate=args=>{const id=args.find(v=>v.startsWith('paircoach.launch='))!.split('=')[1],token=launchLeases.get(id);try{assert.ok(token);assert.throws(()=>token.assertCurrent(),{code:'LANGUAGE_LEASE_RELEASED'});}catch(error){console.error('NEW_START_TOKEN_ERROR',id,[...launchLeases.keys()],error);throw error;}};
  cleanup=async()=>{f.driver.unreachable=false;try{const result=await binding.retire();assert.equal(result.confirmed,true);}finally{alive=false;source.retire();core.close();}};
  await source.admit('real-transport',wire('original-language'));await binding.start();await binding.handle('real-transport',wire('original-language'));
  try {await until(()=>f.driver.frames.filter(v=>v.method==='textDocument/didOpen').length===2,'Actual real-gate language owners opened');} catch(error){console.error('NEW_COMPOSITION_OBSERVATION',JSON.stringify({view:binding.view(),commands:f.driver.commands.length,frames:f.driver.frames.map(v=>v.method)}));throw error;}
  const save=(id='save',languageDocumentMessageId:string|null='original-language',publish=()=>{published++;})=>source.writeWithAck({clientId:'tab',sessionId:scope.sessionId,controlEpoch:core.session.state.controlEpoch,actor:'STUDENT',path:f.path,baseVersion:1,content:document.content},
    {peerId:'real-transport',transactionMessageId:id,languageDocumentMessageId,receiptId:'receipt-'+id},binding,()=>core.session.assertClient('tab',scope.sessionId),publish);
  return {f,core,scope,source,binding,document,events,leases,save,get published(){return published;}};
}
test('COMPOSE authentic real WriteGate pending→commit→fresh held prepare→original ACK precedes association; original source/provenance and provider commands unchanged',async t=>{
  const c=await composed(t);c.f.driver.diagnostics(c.f.path);
  await until(()=>c.events.some(e=>e.type==='DIAGNOSTICS'&&e.result.items.length===1),'Published real diagnostic result');
  // Diagnostics owner naturally stop/log/rm before zero-new-command ACK interval.
  await until(()=>![...c.f.driver.containers.values()].some(v=>v.labels['paircoach.phase']==='diagnostics'),'Diagnostic owner actually removed');
  const original=c.events.find(e=>e.type==='DIAGNOSTICS'&&e.result.items.length===1);assert.ok(original&&original.type==='DIAGNOSTICS');
  const commands=c.f.driver.commands.length,frames=c.f.driver.frames.length;let duringAssociation=false,publishes=0;
  const document=await c.save('real', 'original-language',()=>{publishes++;duringAssociation=c.events.some(e=>e.type==='DIAGNOSTICS'&&e.result.association?.saveReceiptId==='receipt-real');});
  assert.equal(document.version,2);assert.equal(c.core.workspace.workspaceVersion,1);assert.equal(publishes,1);assert.equal(duringAssociation,false);
  const associated=c.events.find(e=>e.type==='DIAGNOSTICS'&&e.result.association?.saveReceiptId==='receipt-real');assert.ok(associated&&associated.type==='DIAGNOSTICS');
  assert.deepEqual(associated.result.sourceStamp,original.result.sourceStamp);assert.deepEqual(associated.result.provenance,original.result.provenance);assert.equal(associated.result.presentationStamp.documentVersion,2);
  assert.equal(c.f.driver.commands.length,commands);assert.equal(c.f.driver.frames.length,frames);assert.equal(c.source.readCurrent('real-transport',c.f.path)?.stamp.documentVersion,2);
  assert.equal(c.leases[0].source.leaseId===c.source.capture(c.scope).revision,false);
});
test('COMPOSE missing/foreign language capture cannot block ordinary real save or mint an association',async t=>{
  const c=await composed(t);await c.save('missing','foreign-document');assert.equal(c.published,1);assert.equal(c.core.workspace.getDocument(c.f.path).version,2);
  assert.equal(c.events.some(e=>e.type==='DIAGNOSTICS'&&e.result.association!==null),false);
});
test('COMPOSE actual inactive source mutation during postcommit prepare preserves committed ordinary ACK but cannot associate',async t=>{
  const c=await composed(t);let changed=false;c.f.hook(args=>{if(!changed && args[0]==='info'){changed=true;fs.writeFileSync(path.join(c.f.workspace,'inactive.txt'),'ACTUAL EXTERNAL DURING PREPARE');}});
  await c.save('external');assert.equal(changed,true);assert.equal(c.published,1);assert.equal(c.core.workspace.getDocument(c.f.path).version,2);
  assert.equal(c.events.some(e=>e.type==='DIAGNOSTICS'&&e.result.association!==null),false);
});
test('COMPOSE authentic ACK callback throws after real commit: no rebroadcast/no association and original disk effect remains',async t=>{
  const c=await composed(t);let calls=0;await assert.rejects(c.save('throws','original-language',()=>{calls++;throw Error('actual publication failed');}),/actual publication failed/);
  assert.equal(calls,1);assert.equal(c.core.workspace.getDocument(c.f.path).version,2);assert.equal(c.events.some(e=>e.type==='DIAGNOSTICS'&&e.result.association!==null),false);
});

test('COMPOSE postcommit source capture failure is not an ordinary-save failure and publishes once without association',async t=>{
  const c=await composed(t);
  const failed=()=>fs.symlinkSync(path.join(c.f.workspace,'inactive.txt'),path.join(c.f.workspace,'unexpected-link'));
  c.core.workspace.once('changed',failed);
  try {await c.save('capture-fails');assert.equal(c.published,1);}
  finally {fs.unlinkSync(path.join(c.f.workspace,'unexpected-link'));}
  assert.equal(c.core.workspace.getDocument(c.f.path).version,2);assert.equal(c.events.some(e=>e.type==='DIAGNOSTICS'&&e.result.association!==null),false);
});
