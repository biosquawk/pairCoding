/** Real source + gate + accepted binding/ledger. No provider is started; no mocked commit. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fixture} from '../runtime-language-binding/fixture';
import {createRuntimeWorkspace} from '../../src/server/runtime-coordinator/RuntimeWorkspace';
import {RuntimeLanguageSource} from '../../src/server/runtime-coordinator/RuntimeLanguageSource';
import {createRuntimeLanguageBinding} from '../../src/server/runtime-coordinator/RuntimeLanguageBinding';
import type {Document} from '../../src/shared/protocol';
async function composed(t:Parameters<typeof fixture>[0]) {
  let cleanup=()=>{};t.after(()=>cleanup());
  const f=await fixture(t,'java-maven'),runtime=f.lease().runtime;
  const core=await createRuntimeWorkspace({rootPath:f.workspace});core.session.claimLease('tab');
  const scope={...f.options.scope,projectId:core.workspace.projectId,sessionId:core.session.state.sessionId};let live=true;
  const assertCurrent=()=>{assert.equal(live,true);core.session.assertClient('tab',scope.sessionId);};
  const assertPeer=(peer:string)=>{assert.equal(peer,'actual-peer');assertCurrent();};
  const source=new RuntimeLanguageSource({core,runtime,scope,installationId:'binding-unit-install',assertCurrent,assertPeer});
  const binding=createRuntimeLanguageBinding({...f.options,scope,assertCurrent,assertPeer,sourceAuthority:source,saveAuthority:source,
    selected:{...f.options.selected,withSourceLease:(s,vector,action)=>source.withSourceLease(s,vector,action)}});
  cleanup=()=>{live=false;source.retire();core.close();};
  const save=(publish:(document:Readonly<Document>)=>void)=>source.writeWithAck({clientId:'tab',sessionId:scope.sessionId,
    controlEpoch:core.session.state.controlEpoch,actor:'STUDENT',path:f.path,baseVersion:1,content:'class Main { int committed; }\n'},
    {peerId:'actual-peer',transactionMessageId:'save',languageDocumentMessageId:null,receiptId:'receipt'},binding,assertCurrent,publish);
  return {f,core,save};
}
test('PUBLISH source sends immutable actual committed Document under SAME held FIFO, not undefined/base+1/readback guess',async t=>{
  const c=await composed(t);let seen:Readonly<Document>|undefined,second:Promise<Document>|undefined;
  const order:string[]=[];
  c.core.workspace.once('changed',()=>{
    second=c.core.gate.writeAsync({clientId:'tab',sessionId:c.core.session.state.sessionId,controlEpoch:0,actor:'STUDENT',
      path:c.f.path,baseVersion:2,content:'class Main { int later; }\n'}).then(doc=>{order.push('next');return doc;});
  });
  const returned=await c.save(document=>{
    seen=document;assert.ok(document,'Publisher requires actual commit');assert.ok(Object.isFrozen(document));
    assert.equal(document.version,2);assert.equal(document.content,'class Main { int committed; }\n');
    assert.equal(c.core.workspace.workspaceVersion,1);assert.equal(order.length,0);
    assert.throws(()=>{(document as Document).content='CALLER MUTATED';},TypeError);
    order.push('ACK');
  });
  assert.deepEqual(seen,returned);assert.notEqual(seen,returned);await second;
  assert.deepEqual(order,['ACK','next']);assert.equal(seen?.content,'class Main { int committed; }\n');
  assert.equal(c.f.driver.commands.length,0);
});
test('PUBLISH callback throw after actual commit is not retried and never rolls back committed bytes',async t=>{
  const c=await composed(t);let calls=0;
  await assert.rejects(c.save(document=>{calls++;assert.equal(document.version,2);throw Error('original publisher failed');}),/original publisher failed/);
  assert.equal(calls,1);assert.equal(c.core.workspace.getDocument(c.f.path).version,2);
  assert.equal(fs.readFileSync(path.join(c.f.workspace,c.f.path),'utf8').includes('committed'),true);
  assert.equal(c.f.driver.commands.length,0);
});
