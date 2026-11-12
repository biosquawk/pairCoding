import test from 'node:test';
import assert from 'node:assert/strict';
import {httpLanguage,until} from './http-language-owner-fixture';
import {validateV2WireShape} from '../../src/shared/validation-v2';

test('HTTP LANG actual retained HELLO owner bootstraps trusted generations; source admission and targeted ordered completion use real binding',async t=>{
  const f=await httpLanguage(t),p=f.peer,d=f.document(p);
  const open=p.send('LANGUAGE_OPEN',d);
  try {await until(()=>f.driver.frames.filter(m=>m.method==='textDocument/didOpen').length>=2,'Both real HTTP-composed lanes admitted source');}
  catch(error){console.error(JSON.stringify({frames:p.frames,calls:f.calls,commands:f.driver.commands,rpc:f.driver.frames},null,2));throw error;}
  const completion=p.send('LANGUAGE_COMPLETE',{requestId:'complete-http',stamp:d.stamp,position:{line:1,column:5},trigger:'.'});
  const result=await p.wait(m=>m.type==='COMPLETE_RESULT'&&m.payload.requestId==='complete-http');
  await p.wait(m=>m.type==='LANGUAGE_STATUS'&&m.payload.autocomplete==='ON');
  assert.ok(validateV2WireShape('ServerMessage',result));assert.equal(result.payload.items[0].label,'safeMethod');
  assert.equal(JSON.stringify(result).includes('SENTINEL'),false);assert.deepEqual(result.payload.stamp,d.stamp);
  assert.ok(p.frames.every((m,i,a)=>i===0||m.seq>a[i-1].seq));
  assert.equal(p.frames.some(m=>m.type==='ACK'&&[open,completion].includes(m.payload.replyTo)),false,'Language traffic is not a source write or autosave ACK');
  const before=f.driver.frames.filter(m=>m.method==='textDocument/didOpen').length;
  const foreign=structuredClone(d);foreign.stamp.connectionGeneration='foreign';const bad=p.send('LANGUAGE_CHANGE',{...foreign,reason:'TYPING'});
  const rejected=await p.wait(m=>m.type==='ACK'&&m.payload.replyTo===bad);
  assert.equal(rejected.payload.status,'REJECTED');assert.equal(f.driver.frames.filter(m=>m.method==='textDocument/didOpen').length,before);
  const project=await f.http('/api/project');assert.equal(project.status,200);assert.equal(project.value.capabilities.language.autocomplete,'ON');
});

test('HTTP LANG absent explicit receipt is truthful failure, manual editing remains authentic and no provider starts',async t=>{
  const f=await httpLanguage(t,false),p=f.peer;
  assert.equal(p.snapshot.payload.languageBootstrap,null);assert.equal(p.snapshot.payload.project.capabilities.language.state,'FAILED');
  assert.equal(p.snapshot.payload.project.capabilities.language.problem.code,'LANGUAGE_RECEIPT_REQUIRED');
  const id=p.send('CODE_CHANGED',{path:f.path,baseVersion:1,content:'ordinary edit\n',editKind:'TYPING',controlEpoch:0});
  const ack=await p.wait(m=>m.type==='ACK'&&m.payload.replyTo===id);assert.equal(ack.payload.status,'OK');assert.equal(ack.payload.documentVersion,2);
  assert.equal(f.driver.commands.length,0);
});

test('HTTP LANG actual CODE_CHANGED joins exact admitted model after original ACK; replay keeps receipt and never restarts analysis',async t=>{
  const f=await httpLanguage(t),p=f.peer,d=f.document(p),documentId=p.send('LANGUAGE_OPEN',d);
  await until(()=>f.driver.frames.filter(m=>m.method==='textDocument/didOpen').length>=2,'Both authentic HTTP lanes sent the admitted model');
  f.driver.diagnostics(f.path);
  const original=await p.wait(m=>m.type==='DIAGNOSTICS'&&m.payload.items.length===1);
  const before=f.driver.commands.filter(a=>a[0]==='create').length,changes=f.driver.frames.filter(m=>m.method==='textDocument/didChange').length;
  const payload={path:f.path,baseVersion:1,content:d.content,editKind:'TYPING',controlEpoch:f.app.session.state.controlEpoch,languageDocumentMessageId:documentId};
  const id=p.send('CODE_CHANGED',payload),ack=await p.wait(m=>m.type==='ACK'&&m.payload.replyTo===id);
  assert.equal(ack.payload.status,'OK');assert.equal(ack.payload.documentVersion,2);
  const joined=await p.wait(m=>m.type==='DIAGNOSTICS'&&m.payload.association?.saveReceiptId===ack.messageId);
  assert.ok(ack.seq<joined.seq,'The original real ACK broadcasts BEFORE private issuer association');
  assert.deepEqual(joined.payload.sourceStamp,original.payload.sourceStamp);assert.deepEqual(joined.payload.provenance,original.payload.provenance);
  assert.equal(joined.payload.presentationStamp.documentVersion,2);assert.equal(joined.payload.presentationStamp.baseDocumentVersion,2);
  assert.equal(f.driver.commands.filter(a=>a[0]==='create').length,before);assert.equal(f.driver.frames.filter(m=>m.method==='textDocument/didChange').length,changes);
  p.send('CODE_CHANGED',payload,id);const replay=await p.wait(m=>m.type==='ACK'&&m.payload.replyTo===id&&m.seq>ack.seq);
  assert.equal(replay.payload.status,'DUPLICATE');assert.equal(replay.messageId,ack.messageId);assert.equal(replay.payload.documentVersion,2);
  assert.equal(f.app.workspace.workspaceVersion,1);assert.equal(p.frames.some(m=>m.type==='ACK'&&m.payload.replyTo===id&&m.payload.status==='REJECTED'),false);
});
