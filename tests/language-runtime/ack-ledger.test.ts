import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { LanguageAckLedger, type LanguageAckCurrent, type LanguageSaveCommit, type LanguageSaveInput } from '../../src/server/language/LanguageAckLedger';
import type { AnalysisSource, DocumentStamp, OpenOrChange } from '../../src/shared/language-v2';
import type { VerifiedLanguageAck } from '../../src/server/language/ports';
const clone=<T>(v:T):T=>JSON.parse(JSON.stringify(v));
// Fixture-only codec: finite LF and the one CRLF fixture. NOT URI/normalization integration evidence.
const normalizeContent=(s:string)=>s==='x\r\ny'?'x\ny':s;
const codec={normalizeContent,contentSha256:(s:string)=>createHash('sha256').update(normalizeContent(s)).digest('hex')};
function fixture() {
  const stamp:DocumentStamp={projectId:'project',sessionId:'session',path:'Main.java',profileId:'java21',connectionGeneration:'connection',
    configurationGeneration:'config',providerGeneration:'provider',shadowGeneration:'shadow',modelLifetime:'model',localModelVersion:2,
    baseDocumentVersion:1,documentVersion:null,contentSha256:codec.contentSha256('x\r\ny'),controlEpoch:0,requestGeneration:2};
  const document:OpenOrChange={stamp:clone(stamp),content:'x\r\ny',reason:'TYPING'};
  let current:LanguageAckCurrent|null={documentMessageId:'open2',stamp:clone(stamp),content:'x\ny',projectRevision:'vector:2',dependencyManifestSha256:'d'.repeat(64)};
  let source:AnalysisSource|null={sourceStamp:clone(stamp),provenance:{kind:'IMMUTABLE_GENERATION',launchId:'launch',lspVersion:1,inputManifestSha256:'a'.repeat(64)}};
  let commit:LanguageSaveCommit|null=null;
  const input:LanguageSaveInput={peerId:'peer',transactionMessageId:'save2',languageDocumentMessageId:'open2',path:'Main.java',baseVersion:1,controlEpoch:0,content:'x\r\ny'};
  const authority={readCurrent:(peer:string,path:string)=>peer==='peer'&&path==='Main.java'?current:null,
    readAnalysisSource:(peer:string,id:string)=>peer==='peer'&&id==='open2'?source:null,readCommittedSave:(_request:unknown,id:string)=>commit?.saveReceiptId===id?commit:null};
  const ledger=new LanguageAckLedger(authority,codec);ledger.observeDocument('peer','open2',document);
  const settle=(status:'OK'|'DUPLICATE'='OK')=>{
    current={...current!,projectRevision:'vector:3',stamp:{...current!.stamp,baseDocumentVersion:2,documentVersion:2}};
    commit={request:clone(input),saveReceiptId:'ack2',replyTo:'save2',status,documentVersion:2,workspaceVersion:7,
      committedContent:'x\ny',beforeProjectRevision:'vector:2',afterProjectRevision:'vector:3'};
  };
  return {ledger,authority,document,stamp,input,settle,get current(){return current;},set current(v){current=v;},
    get commit(){return commit;},set commit(v){commit=v;},get source(){return source;},set source(v){source=v;}};
}
test('exact beforeWriteGate capture -> actual OK commit -> privately issued frozen ACK, source never rebound',()=>{
  const f=fixture(),h=f.ledger.beginSave(f.input)!;assert.ok(h);assert.equal(f.ledger.commitSave(h,'ack2'),null);f.settle();
  const proof=f.ledger.commitSave(h,'ack2')!;assert.ok(proof);assert.equal(proof.saveReceiptId,'ack2');assert.equal(proof.replyTo,'save2');
  assert.deepEqual(proof.previous,f.stamp);assert.deepEqual(proof.source,f.source);assert.equal(proof.source.sourceStamp.documentVersion,null);
  assert.equal(proof.presentation.documentVersion,2);assert.equal(f.ledger.isVerified(proof),true);
  assert.throws(()=>{(proof.presentation as any).localModelVersion=99;},TypeError);
  assert.equal(f.ledger.commitSave(h,'ack2'),proof);assert.equal(f.ledger.isVerified(clone(proof)),false);
  assert.equal(new LanguageAckLedger(f.authority,codec).isVerified(proof),false);
});
test('DUPLICATE uses original capture and genuine ACK for original transaction, never recaptures',()=>{
  const f=fixture(),h=f.ledger.beginSave(f.input)!;f.settle('DUPLICATE');assert.equal(f.ledger.beginSave(clone(f.input)),h);
  assert.equal(f.ledger.commitSave(h,'ack2')!.status,'DUPLICATE');assert.equal(f.ledger.beginSave({...f.input,content:'collision'}),null);
});
test('missing/foreign/stale source or transaction fields never grant proof or disable ordinary save',()=>{
  for(const patch of [{languageDocumentMessageId:''},{languageDocumentMessageId:'foreign'},{peerId:'other'},{path:'Other.java'},
    {baseVersion:2},{controlEpoch:1},{content:'new draft'},{transactionMessageId:''}]) {
    const f=fixture();assert.equal(f.ledger.beginSave({...f.input,...patch}),null);assert.equal(f.commit,null);
  }
  const f=fixture();assert.equal(f.ledger.commitSave({} as any,'ack2'),null);assert.equal(f.ledger.isVerified({} as VerifiedLanguageAck),false);
});
test('ABA/equal bytes recreated model, newer local version and latest message cannot bind older queued save',()=>{
  for(const patch of [{modelLifetime:'newModel'},{localModelVersion:3},{requestGeneration:4}]) {
    const f=fixture();f.current={...f.current!,stamp:{...f.current!.stamp,...patch}};
    assert.equal(f.ledger.beginSave(f.input),null);
  }
  const f=fixture(),h=f.ledger.beginSave(f.input)!;
  const newer={...f.document,stamp:{...f.stamp,modelLifetime:'newModel'}};
  f.ledger.observeDocument('peer','open3',newer);f.current={...f.current!,documentMessageId:'open3',stamp:newer.stamp};
  f.settle();assert.equal(f.ledger.commitSave(h,'ack2'),null);
  // Replaying the original source ID does not re-admit the retired original lifetime.
  f.ledger.observeDocument('peer','open2',f.document);f.current={...f.current!,documentMessageId:'open2',stamp:{...f.stamp,baseDocumentVersion:2,documentVersion:2}};
  assert.equal(f.ledger.commitSave(h,'ack2'),null);
});
test('document record is immutable and conflicting messageId replay rejected',()=>{
  const f=fixture();f.document.stamp.modelLifetime='mutated';f.document.content='mutated';f.document.stamp.contentSha256=codec.contentSha256('mutated');
  assert.ok(f.ledger.beginSave(f.input));assert.throws(()=>f.ledger.observeDocument('peer','open2',f.document),/collision/);
});
test('scope/epoch/profile/lifetime/hash changes at commit invalidate pending proof even with equal content',()=>{
  const patches=[{projectId:'other'},{sessionId:'other'},{profileId:'other'},{connectionGeneration:'old'},
    {configurationGeneration:'old'},{providerGeneration:'old'},{shadowGeneration:'old'},{modelLifetime:'new'},
    {localModelVersion:3},{controlEpoch:1},{requestGeneration:1},{contentSha256:'e'.repeat(64)},
    {baseDocumentVersion:3},{documentVersion:null}];
  for(const patch of patches) {const f=fixture(),h=f.ledger.beginSave(f.input)!;f.settle();f.current={...f.current!,stamp:{...f.current!.stamp,...patch}};
    assert.equal(f.ledger.commitSave(h,'ack2'),null,JSON.stringify(patch));}
});
test('all-project dependency/overlay/external mutation and later ACK invalidate issued proof synchronously',()=>{
  for(const mutate of [(f:ReturnType<typeof fixture>)=>{f.current={...f.current!,projectRevision:'vector:4'};},
    (f:ReturnType<typeof fixture>)=>{f.current={...f.current!,dependencyManifestSha256:'e'.repeat(64)};},
    (f:ReturnType<typeof fixture>)=>{f.commit={...f.commit!,beforeProjectRevision:'unaccounted'};},
    (f:ReturnType<typeof fixture>)=>{f.current={...f.current!,stamp:{...f.current!.stamp,requestGeneration:4}};},
    (f:ReturnType<typeof fixture>)=>{f.current={...f.current!,content:'changed'};}]) {
    const f=fixture(),h=f.ledger.beginSave(f.input)!;f.settle();const proof=f.ledger.commitSave(h,'ack2')!;assert.ok(proof);mutate(f);
    assert.equal(f.ledger.isVerified(proof),false);assert.equal(f.ledger.commitSave(h,'ack2'),null);
  }
});
test('unknown/rejected/wrong ACK/replyTo/request/commit versions/content cannot mint a brand',()=>{
  for(const patch of [{status:'REJECTED'},{replyTo:'otherSave'},{saveReceiptId:''},{documentVersion:1},
    {documentVersion:3},{workspaceVersion:0},{committedContent:'foreign'},
    {beforeProjectRevision:'other'},{afterProjectRevision:'other'},
    {request:{peerId:'attacker'}}]) {
    const f=fixture(),h=f.ledger.beginSave(f.input)!;f.settle();f.commit={...f.commit!,...patch} as LanguageSaveCommit;
    assert.equal(f.ledger.commitSave(h,'ack2'),null,JSON.stringify(patch));
  }
});
test('provenance comes only from captured exact analysis ledger, absent/replaced sources cannot be aliased',()=>{
  const f=fixture();f.source=null;assert.equal(f.ledger.beginSave(f.input),null);
  for(const mutate of [(f:ReturnType<typeof fixture>)=>{f.source={...f.source!,sourceStamp:{...f.stamp,localModelVersion:7}};},
    (f:ReturnType<typeof fixture>)=>{f.source={...f.source!,provenance:{kind:'IMMUTABLE_GENERATION',launchId:'other',lspVersion:1,inputManifestSha256:'a'.repeat(64)}};}]) {
    const f=fixture(),h=f.ledger.beginSave(f.input)!;f.settle();mutate(f);assert.equal(f.ledger.commitSave(h,'ack2'),null);
  }
});
test('retiring server peer revokes pending and issued proof; same clientId/new transport cannot recover it',()=>{
  const f=fixture(),h=f.ledger.beginSave(f.input)!;f.settle();const proof=f.ledger.commitSave(h,'ack2')!;f.ledger.retirePeer('peer');
  assert.equal(f.ledger.isVerified(proof),false);assert.equal(f.ledger.commitSave(h,'ack2'),null);
  assert.equal(f.ledger.beginSave(f.input),null);assert.equal(f.ledger.beginSave({...f.input,peerId:'newTransport'}),null);
});
test('trusted readers throwing or malformed source/current fail closed without affecting save implementation',()=>{
  const f=fixture();f.current={...f.current!,projectRevision:''};assert.equal(f.ledger.beginSave(f.input),null);
  const l=new LanguageAckLedger({readCurrent:()=>{throw new Error('offline');},readAnalysisSource:()=>null,readCommittedSave:()=>null},codec);
  l.observeDocument('peer','open2',fixture().document);assert.equal(l.beginSave(f.input),null);
});

test('each emitted duplicate ACK id joins original transaction, unknown/forged receipt never mints proof',()=>{
  const f=fixture(),h=f.ledger.beginSave(f.input)!;f.settle();
  const commits=new Map([['ack2',clone(f.commit!)]]);
  f.authority.readCommittedSave=(_request:unknown,id:string)=>commits.get(id)??null;
  const first=f.ledger.commitSave(h,'ack2')!;assert.ok(first);
  assert.equal(f.ledger.commitSave(h,'forged'),null);
  commits.set('ack3',{...clone(f.commit!),status:'DUPLICATE',saveReceiptId:'ack3'});
  const duplicate=f.ledger.commitSave(h,'ack3')!;assert.ok(duplicate);assert.equal(duplicate.status,'DUPLICATE');
  assert.equal(duplicate.transactionMessageId,first.transactionMessageId);assert.deepEqual(duplicate.source,first.source);
  assert.equal(f.ledger.isVerified(first),true);assert.equal(f.ledger.isVerified(duplicate),true);
});

// K impact-read approval339d2495: ACK-only keeps the admitted requestGeneration exactly.
// These are separate new counter cases, not changes to the original twelve assertion bodies.
test('ACK-only equal requestGeneration issues and retains proof without rebinding immutable source',()=>{
  const f=fixture(),h=f.ledger.beginSave(f.input)!;f.settle();
  assert.equal(f.current!.stamp.requestGeneration,f.stamp.requestGeneration);
  const original=clone(f.source),proof=f.ledger.commitSave(h,'ack2')!;assert.ok(proof);
  assert.equal(proof.presentation.requestGeneration,proof.source.sourceStamp.requestGeneration);
  assert.deepEqual(proof.source,original);assert.equal(f.ledger.isVerified(proof),true);
});
for(const offset of [-1,1]) {
  test(`ACK-only requestGeneration ${offset>0?'+1':'-1'} cannot issue proof`,()=>{
    const f=fixture(),h=f.ledger.beginSave(f.input)!;f.settle();
    f.current={...f.current!,stamp:{...f.current!.stamp,requestGeneration:f.stamp.requestGeneration+offset}};
    assert.equal(f.ledger.commitSave(h,'ack2'),null);
  });
  test(`ACK-only requestGeneration ${offset>0?'+1':'-1'} cannot retain already issued proof`,()=>{
    const f=fixture(),h=f.ledger.beginSave(f.input)!;f.settle();
    const proof=f.ledger.commitSave(h,'ack2')!;assert.ok(proof);
    f.current={...f.current!,stamp:{...f.current!.stamp,requestGeneration:f.stamp.requestGeneration+offset}};
    assert.equal(f.ledger.isVerified(proof),false);assert.equal(f.ledger.commitSave(h,'ack2'),null);
  });
}
