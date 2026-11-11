import test from 'node:test';
import assert from 'node:assert/strict';
import {Decoder, encode, Rpc} from './rpc.mjs';
import {sameContext, acceptCompletion, acceptDiagnostic, safeItem, linkAckOnly} from './correlation.mjs';
import {PassThrough} from 'node:stream';
import {EventEmitter} from 'node:events';

test('UTF8 framing fragmented/coalesced and nonBMP payload', () => {
  const messages = [{id:1,result:'żółć 😀\r\n'}, {id:2,result:['test']}];
  const bytes = Buffer.concat(messages.map(encode)); const decoder = new Decoder(); const received=[];
  for(const byte of bytes) received.push(...decoder.feed(Buffer.from([byte])));
  assert.deepEqual(received,messages);
  assert.deepEqual(new Decoder().feed(bytes),messages);
});
test('malformed/oversize frame fail closed', () => {
  for(const value of ['No-Length: 1\r\n\r\nx','Content-Length: 99999999\r\n\r\n','Content-Length: 1\r\nContent-Length: 1\r\n\r\nx'])
    assert.throws(()=>new Decoder().feed(Buffer.from(value)));
});
const current={projectId:'p',path:'spacja/żółć 😀.java',localModelVersion:4,documentVersion:2,profileId:'java-maven-27',requestGeneration:10,providerGeneration:8,ownershipEpoch:3,snapshotHash:'sha256:snapshot4'};
test('all completion fences and CONTROL_PREPARE/COACH rejection',()=>{
  assert.equal(acceptCompletion(current,{...current},'STUDENT'),true);
  for(const key of ['projectId','path','localModelVersion','documentVersion','profileId','requestGeneration','providerGeneration','ownershipEpoch'])
    assert.equal(sameContext(current,{...current,[key]:'old'}),false,key);
  assert.equal(acceptCompletion({...current,controlPrepare:true},current,'STUDENT'),false);
  assert.equal(acceptCompletion(current,current,'COACH'),false);
  assert.equal(acceptCompletion({...current,ownershipEpoch:4},current,'STUDENT'),false);
});
test('late unversioned push never receives current model version',()=>{
  const old={context:current,publishVersion:undefined,sourceKind:'MUTABLE_COMPLETION_PROVIDER',sourceSnapshotHash:current.snapshotHash,sourceProviderGeneration:8};
  assert.equal(acceptDiagnostic(current,old),false);
  const frozen={...old,sourceKind:'IMMUTABLE_DIAGNOSTIC_SNAPSHOT'};
  assert.equal(acceptDiagnostic(current,frozen),true);
  assert.equal(acceptDiagnostic({...current,localModelVersion:5,snapshotHash:'new'},frozen),false);
  assert.equal(acceptDiagnostic(current,{...frozen,sourceProviderGeneration:7}),false);
  assert.equal(acceptDiagnostic(current,{...old,publishVersion:3}),false);
  assert.equal(acceptDiagnostic(current,{...old,publishVersion:4}),true);
});
test('reject unsafe items (not full Monaco acceptance proof)',()=>{
  assert.equal(safeItem({command:{command:'edit'}},'a'),false);
  assert.equal(safeItem({additionalTextEdits:[{uri:'b'}]},'a'),false);
});
test('wire capture retains absent version; responds to applyEdit with denial',()=>{
  const child=new EventEmitter(); child.stdout=new PassThrough(); child.stdin=new PassThrough();
  const output=[]; child.stdin.on('data',chunk=>output.push(chunk));
  const rpc=new Rpc(child,()=>{});
  child.stdout.write(encode({jsonrpc:'2.0',method:'textDocument/publishDiagnostics',params:{uri:'a',diagnostics:[]}}));
  assert.equal(Object.hasOwn(rpc.history[0].message.params,'version'),false);
  child.stdout.write(encode({jsonrpc:'2.0',id:8,method:'workspace/applyEdit',params:{}}));
  assert.equal(new Decoder().feed(Buffer.concat(output))[0].result.applied,false);
});

test('ACK-only links proven identical content without rewriting source or sending didChange',()=>{
  const sent={...current,modelLifetime:'m1',configurationGeneration:2,shadowGeneration:3,contentSha256:'sha256:buffer4'};
  const now={...sent,documentVersion:9,requestGeneration:11};
  const association={contentSha256:sent.contentSha256,localModelVersion:4,documentVersion:9};
  const link=linkAckOnly(sent,now,association);
  assert.ok(link);assert.equal(link.sourceContext,sent);assert.equal(sent.documentVersion,2);
  assert.equal(link.presentationContext.documentVersion,9);
  for(const key of ['localModelVersion','modelLifetime','shadowGeneration','contentSha256','profileId','ownershipEpoch'])
    assert.equal(linkAckOnly(sent,{...now,[key]:'changed'},association),null,key);
  assert.equal(linkAckOnly(sent,now,{...association,contentSha256:'another'}),null);
});
