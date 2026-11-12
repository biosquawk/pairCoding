/** Actual postcommit HTTP consumer races, not a helper replay or synthetic ACK authority. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {httpLanguage,until} from './http-language-owner-fixture';
const barrier=()=>{let resolve!:()=>void;return {promise:new Promise<void>(r=>{resolve=r;}),resolve:()=>resolve()};};
async function pending(t:Parameters<typeof httpLanguage>[0]) {
  const entered=barrier(),resume=barrier();t.after(()=>resume.resolve());
  const f=await httpLanguage(t),p=f.peer,d=f.document(p),documentId=p.send('LANGUAGE_OPEN',d);
  await until(()=>f.driver.frames.filter(m=>m.method==='textDocument/didOpen').length>=2,'Both original HTTP lanes sent the model');
  f.driver.diagnostics(f.path);await p.wait(m=>m.type==='DIAGNOSTICS'&&m.payload.items.length===1);
  let once=false;
  f.hook(async()=>{if(!once&&f.app.workspace.workspaceVersion===1){once=true;entered.resolve();await resume.promise;}});
  const payload={path:f.path,baseVersion:1,content:d.content,editKind:'TYPING',controlEpoch:0,languageDocumentMessageId:documentId};
  const id=p.send('CODE_CHANGED',payload);await until(()=>once,'Actual postcommit transport entered');await entered.promise;
  assert.equal(p.frames.some(m=>m.type==='ACK'&&m.payload.replyTo===id),false);
  return {...f,p,d,payload,id,resume};
}

test('HTTP LANG Veto during actual postcommit prepare withholds language join, not original committed ACK/result',async t=>{
  const f=await pending(t),{p}=f;
  try {
    const veto=p.send('VETO_ESCAPE',{controlEpoch:0,activeInterventionId:null,lastAppliedSeq:p.frames.at(-1).seq});
    const cutoff=await p.wait(m=>m.type==='ACK'&&m.payload.replyTo===veto);assert.equal(cutoff.payload.controlEpoch,1);
    f.resume.resolve();const ack=await p.wait(m=>m.type==='ACK'&&m.payload.replyTo===f.id);
    assert.equal(ack.payload.status,'OK');assert.equal(ack.payload.documentVersion,2);assert.equal(ack.payload.controlEpoch,0,'Actual original commit-time epoch, never late current-state guess');
    assert.equal(p.frames.some(m=>m.type==='DIAGNOSTICS'&&m.payload.association?.saveReceiptId===ack.messageId),false);
    const fresh=await p.wait(m=>m.type==='SESSION_SNAPSHOT'&&m.payload.languageBootstrap?.shadowGeneration!==p.snapshot.payload.languageBootstrap.shadowGeneration);
    assert.equal(fresh.payload.session.controlEpoch,1,'Explicit new bootstrap without a fresh language overlay');
    p.send('CODE_CHANGED',f.payload,f.id);const replay=await p.wait(m=>m.type==='ACK'&&m.payload.replyTo===f.id&&m.seq>ack.seq);
    assert.equal(replay.payload.status,'DUPLICATE');assert.equal(replay.messageId,ack.messageId);assert.equal(replay.payload.controlEpoch,0);
  } finally {f.resume.resolve();}
});

test('HTTP LANG reconnect during actual postcommit prepare retains original commit/receipt for new authenticated peer replay',async t=>{
  const f=await pending(t);
  try {
    const reconnect=f.connect();await until(()=>f.peer.ws.readyState!==1,'Original authenticated peer revoked');
    f.resume.resolve();const next=await reconnect;
    next.send('CODE_CHANGED',f.payload,f.id);const replay=await next.wait(m=>m.type==='ACK'&&m.payload.replyTo===f.id);
    assert.equal(replay.payload.status,'DUPLICATE');assert.equal(replay.payload.documentVersion,2);assert.equal(replay.payload.workspaceVersion,1);
    assert.equal(replay.payload.controlEpoch,0);assert.equal(f.app.workspace.workspaceVersion,1);
    next.send('CODE_CHANGED',f.payload,f.id);const again=await next.wait(m=>m.type==='ACK'&&m.payload.replyTo===f.id&&m.seq>replay.seq);
    assert.equal(again.messageId,replay.messageId);assert.deepEqual(again.payload,replay.payload);
    assert.equal(next.frames.some(m=>m.type==='DIAGNOSTICS'&&m.payload.association!==null),false);
  } finally {f.resume.resolve();}
});
