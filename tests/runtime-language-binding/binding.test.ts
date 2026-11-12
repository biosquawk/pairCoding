import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { createRuntimeLanguageBinding } from '../../src/server/runtime-coordinator/RuntimeLanguageBinding';
import type { DocumentStamp, LanguageClientMessage, OpenOrChange } from '../../src/shared/language-v2';
import type { PendingLanguageSave } from '../../src/server/language/LanguageAckLedger';
import { validateCompleteResult, validateDiagnosticsResult } from '../../src/shared/validation-v2';
import { fixture, wire, complete, tick, until, codec } from './fixture';

for (const family of ['python','java-maven'] as const) test(`${family}: actual consumer start/forward/bootstrap + fresh held authentic ACK, unchanged provenance/no restart`, async t => {
  const f=await fixture(t,family);
  assert.equal(f.driver.commands.length,0);assert.equal(f.calls.length,0);assert.throws(()=>f.binding.view(),/actual language status/);
  const first=f.binding.start();assert.equal(f.binding.start(),first,'start is singleflight');await first;
  assert.deepEqual(f.binding.bootstrap(),{connectionGeneration:'connection',shadowGeneration:'shadow',provider:'remote'});
  await f.binding.handle('authenticated-peer',wire('LANGUAGE_OPEN',f.document));
  await until(()=>f.driver.frames.filter(frame=>frame.method==='textDocument/didOpen').length===2,'Both real factory owners opened');
  assert.equal(f.binding.view().state,'INDEXING','Initialize alone is not semantic readiness');
  assert.ok(Object.isFrozen(f.binding.view()));
  const before=await f.binding.handle('authenticated-peer',wire('LANGUAGE_COMPLETE',complete(f.document,'before'),'request'));
  assert.ok(before&&validateCompleteResult(before));assert.equal(f.binding.view().state,'ON');assert.equal(f.binding.view().autocomplete,'ON');assert.equal(before.items.length,1,'Actual projection rejects non-allowlisted foreign edit');assert.equal(before.items[0].label,'safeMethod');assert.equal(JSON.stringify(before).includes('SENTINEL'),false,'Command/private data never crosses actual projection');
  const pending=f.binding.beginSave(f.input);assert.ok(pending);
  const opens=f.driver.frames.filter(frame=>/didOpen|didChange|didSave|didClose|initialize/.test(frame.method??''));
  const commands=f.driver.commands.length,oldLease=f.leases.at(-1)!,order:string[]=[];
  const manifests=fs.readdirSync(f.owned).flatMap(id=>['manifest.json','boot/language-launch.json'].map(p=>({path:join(f.owned,id,p),bytes:fs.readFileSync(join(f.owned,id,p))})));
  f.stageCommit();order.push('commit');assert.throws(()=>oldLease.assertRetainedCurrent());
  const original=f.document.stamp;
  await f.underLease(async token=>{
    assert.notEqual(token,oldLease);assert.equal(token.source.leaseId,'vector-after');
    await f.binding.prepareSaveAcknowledgement(token);order.push('fresh-prepared-held');
    assert.equal(f.binding.publishSaveAck(pending,'save-receipt',()=>{assert.equal(f.held,true);order.push('publish');assert.equal(f.events.filter(e=>e.type==='DIAGNOSTICS'&&e.result.association).length,0);}),true);
    order.push('joined');
  });order.push('release');
  assert.deepEqual(order,['commit','fresh-prepared-held','publish','joined','release']);
  const fresh=await f.binding.handle('authenticated-peer',wire('LANGUAGE_COMPLETE',complete(f.snapshot.documents[0],'fresh'),'request-fresh'));
  assert.ok(fresh);assert.deepEqual(fresh.stamp,f.snapshot.documents[0].stamp);
  await assert.rejects(f.binding.handle('authenticated-peer',wire('LANGUAGE_COMPLETE',complete(f.document,'old'),'request-old')));
  assert.equal(f.driver.commands.length,commands);assert.deepEqual(f.driver.frames.filter(frame=>/didOpen|didChange|didSave|didClose|initialize/.test(frame.method??'')),opens);
  for(const item of manifests)assert.deepEqual(fs.readFileSync(item.path),item.bytes,'ACK cannot rewrite source/manifest');
  f.driver.diagnostics(f.path);await until(()=>f.events.some(e=>e.type==='DIAGNOSTICS'&&!!e.result.association));
  const event=f.events.find(e=>e.type==='DIAGNOSTICS'&&!!e.result.association)!;assert.equal(event.type,'DIAGNOSTICS');if(event.type!=='DIAGNOSTICS')throw Error();
  assert.ok(validateDiagnosticsResult(event.result));assert.deepEqual(event.result.sourceStamp,original);assert.equal(event.result.provenance.kind,'IMMUTABLE_GENERATION');assert.equal(event.result.association?.saveReceiptId,'save-receipt');
  assert.deepEqual(event.result.presentationStamp,f.snapshot.documents[0].stamp);assert.equal(fs.readFileSync(join(f.workspace,f.path),'utf8'),f.input.content);
  const count=f.events.length,retiring=f.binding.retire();
  assert.ok(f.events.slice(count).some(e=>e.type==='DIAGNOSTICS'&&e.result.items.length===0),'Synchronous retirement clear BEFORE awaiting stop');
  assert.equal((await retiring).confirmed,true);assert.equal(f.binding.view().state,'OFF');assert.throws(()=>f.binding.beginSave(f.input));
});

for(const missing of ['assertCurrent','assertPeer','emit','withSourceLease','readCommittedSave','capture'] as const)test(`mandatory callback ${missing} cannot become always-current/OFF success`,async t=>{
  const f=await fixture(t),o:any={...f.options,selected:{...f.options.selected},sourceAuthority:{...f.options.sourceAuthority},saveAuthority:{...f.options.saveAuthority}};
  if(missing==='withSourceLease')delete o.selected[missing];else if(missing==='readCommittedSave')delete o.saveAuthority[missing];else if(missing==='capture')delete o.sourceAuthority[missing];else delete o[missing];
  assert.throws(()=>createRuntimeLanguageBinding(o),/actual language authority/);assert.equal(f.calls.length,0);assert.equal(f.driver.commands.length,0);
});

for(const field of ['projectId','sessionId','profileId','connectionGeneration','configurationGeneration','providerGeneration','shadowGeneration'] as const)test(`foreign fullstamp ${field} rejected before provider/admission`,async t=>{
  const f=await fixture(t);await f.binding.start();const message=wire('LANGUAGE_OPEN',{...f.document,stamp:{...f.document.stamp,[field]:'foreign'}});
  const count=f.driver.commands.length;
  await assert.rejects(f.binding.handle('authenticated-peer',message),/scope/);assert.equal(f.binding.beginSave(f.input),null);assert.equal(f.driver.commands.length,count);
});

test('foreign peer and wire clientId cannot authorize or pollute private capture',async t=>{
  const f=await fixture(t);await f.binding.start();
  await assert.rejects(f.binding.handle('wire-client-NOT-peer',wire('LANGUAGE_OPEN',f.document)),/peer refused/);
  await until(()=>f.driver.frames.filter(frame=>frame.method==='textDocument/didOpen').length===2);
  assert.equal(f.binding.beginSave(f.input),null);
  await f.binding.handle('authenticated-peer',wire('LANGUAGE_OPEN',f.document));await until(()=>f.driver.frames.filter(frame=>frame.method==='textDocument/didOpen').length===3,'Fresh post-admission immutable source sent');
  assert.ok(f.binding.beginSave(f.input));assert.equal(f.binding.beginSave({...f.input,peerId:'wire-client-NOT-peer'}),null);
});

for(const mutation of ['reason','unknown-field','unadmitted-overlay','hash'] as const)test(`wire validation rejects ${mutation} without save association`,async t=>{
  const f=await fixture(t);await f.binding.start();const message:any=structuredClone(wire('LANGUAGE_OPEN',f.document));
  if(mutation==='reason')message.payload.reason='TYPING';if(mutation==='unknown-field')message.payload.proof={saveReceiptId:'fake'};
  if(mutation==='unadmitted-overlay')message.payload.content='not in authority';if(mutation==='hash')message.payload.stamp.contentSha256='0'.repeat(64);
  await assert.rejects(f.binding.handle('authenticated-peer',message));assert.equal(f.binding.beginSave(f.input),null);
});

test('caller mutation after handle dispatch cannot change authentic retained document identity',async t=>{
  const f=await fixture(t);await f.binding.start();const message=structuredClone(wire('LANGUAGE_OPEN',f.document));
  const handled=f.binding.handle('authenticated-peer',message);message.payload.stamp.modelLifetime='mutated';await handled;
  await until(()=>f.driver.frames.filter(frame=>frame.method==='textDocument/didOpen').length===2);
  assert.ok(f.binding.beginSave(f.input));assert.equal(f.binding.beginSave({...f.input,languageDocumentMessageId:'mutated'}),null);
});

test('CLOSE removes exact path correlation, revokes old pending, ordinary save still publishes once',async t=>{
  const f=await fixture(t);await f.start();const pending=f.binding.beginSave(f.input);assert.ok(pending);
  f.setSnapshot({revision:'closed',documents:[]});await f.binding.handle('authenticated-peer',wire('LANGUAGE_CLOSE',{stamp:f.document.stamp},'close'));
  assert.equal(f.binding.beginSave(f.input),null);let publications=0;assert.equal(f.binding.publishSaveAck(pending,'save-receipt',()=>{publications++;}),false);assert.equal(publications,1);
});

test('actual file feed and draft CHANGE clear diagnostics and original private captures',async t=>{
  const f=await fixture(t);await f.start();f.driver.diagnostics(f.path);await until(()=>f.events.some(e=>e.type==='DIAGNOSTICS'&&e.result.items.length>0));
  fs.writeFileSync(join(f.workspace,'added.txt'),'file feed');f.setSnapshot({...f.snapshot,revision:'file-vector'});
  const operation=f.binding.fileOperation({kind:'CREATE',path:'added.txt',content:'file feed'});
  assert.ok(f.events.some(e=>e.type==='DIAGNOSTICS'&&e.result.items.length===0));await operation;
  assert.equal(f.binding.beginSave(f.input),null);
  const next:OpenOrChange={...f.document,content:'new draft',reason:'UNDO',stamp:{...f.document.stamp,contentSha256:codec.contentSha256('new draft'),localModelVersion:4,requestGeneration:3}};
  f.setSnapshot({revision:'draft-vector',documents:[next]});await f.binding.handle('authenticated-peer',wire('LANGUAGE_CHANGE',next,'new-document'));
  assert.equal(f.binding.beginSave(f.input),null);
});

for(const variant of ['missing','forged','no-prepare','released','failed-prepare','stale-lease','unrelated-source'] as const)test(`ACK ${variant}: ordinary valid publish once but no association`,async t=>{
  const f=await fixture(t);await f.start();let pending:PendingLanguageSave|null=f.binding.beginSave(f.input);assert.ok(pending);f.stageCommit();
  if(variant==='missing')pending=null;if(variant==='forged')pending=Object.freeze({}) as PendingLanguageSave;
  if(variant==='released')await f.prepare();
  if(variant==='failed-prepare'){
    await f.prepare();f.hook(()=>{throw Error('UNIT prepare observer failed');});await assert.rejects(f.prepare());f.hook(null);
  }
  if(variant==='stale-lease')await assert.rejects(f.binding.prepareSaveAcknowledgement(f.leases[0]));
  let publications=0;
  const publish=()=>{publications++;};
  if(variant==='missing'||variant==='forged'||variant==='unrelated-source')await f.underLease(async token=>{
    await f.binding.prepareSaveAcknowledgement(token);
    if(variant==='unrelated-source')fs.writeFileSync(join(f.workspace,'inactive.txt'),'external-after-prepare');
    assert.equal(f.binding.publishSaveAck(pending,'save-receipt',publish),false);
  });else assert.equal(f.binding.publishSaveAck(pending,'save-receipt',publish),false);
  assert.equal(publications,1);assert.equal(f.events.some(e=>e.type==='DIAGNOSTICS'&&e.result.association),false);
});

test('foreign binding pending handle cannot mint association in same-scope replacement issuer',async t=>{
  const f=await fixture(t);await f.start();const pending=f.binding.beginSave(f.input);assert.ok(pending);
  await f.binding.retire();const replacement=f.replace();await replacement.start();await replacement.handle('authenticated-peer',wire('LANGUAGE_OPEN',f.document));
  await until(()=>f.driver.frames.filter(frame=>frame.method==='textDocument/didOpen').length===4);
  f.stageCommit();let publications=0;
  await f.underLease(async token=>{await replacement.prepareSaveAcknowledgement(token);assert.equal(replacement.publishSaveAck(pending,'save-receipt',()=>{publications++;}),false);});
  assert.equal(publications,1);
});

for(const variant of ['callback-throws','callback-revokes','callback-releases','newer-draft'] as const)test(`ACK ${variant}: no alias/rebroadcast/provider restart`,async t=>{
  const f=await fixture(t);await f.start();const pending=f.binding.beginSave(f.input);assert.ok(pending);f.stageCommit();let publications=0;
  await f.underLease(async token=>{
    await f.binding.prepareSaveAcknowledgement(token);
    const publish=()=>{publications++;if(variant==='callback-throws')throw Error('UNIT publish failed');if(variant==='callback-revokes')f.setAlive(false);if(variant==='callback-releases')f.releaseNow();
      if(variant==='newer-draft')f.setSnapshot({...f.snapshot,revision:'newer-vector'});};
    if(variant==='callback-throws'||variant==='callback-revokes')assert.throws(()=>f.binding.publishSaveAck(pending,'save-receipt',publish));
    else assert.equal(f.binding.publishSaveAck(pending,'save-receipt',publish),false);
  });
  assert.equal(publications,1);assert.equal(f.events.some(e=>e.type==='DIAGNOSTICS'&&e.result.association),false);
});

test('completion returned asynchronously is rejected after peer loss; no late result/provenance rebind',async t=>{
  const f=await fixture(t);await f.start();f.driver.hold=true;
  const result=f.binding.handle('authenticated-peer',wire('LANGUAGE_COMPLETE',complete(f.document),'request'));
  const rejected=assert.rejects(result,/peer refused/);await until(()=>f.driver.pending.length===1);f.setPeer(false);f.driver.release();await rejected;
});

test('CANCEL forwards actual cancellation; retired pending completion/events drop',async t=>{
  const f=await fixture(t);await f.start();f.driver.hold=true;
  const result=f.binding.handle('authenticated-peer',wire('LANGUAGE_COMPLETE',complete(f.document,'cancel-me'),'request'));const rejected=assert.rejects(result);
  await until(()=>f.driver.pending.length===1);
  await f.binding.handle('authenticated-peer',wire('LANGUAGE_CANCEL',{requestId:'cancel-me',stamp:f.document.stamp},'cancel'));
  assert.ok(f.driver.frames.some(frame=>frame.method==='$/cancelRequest'));await rejected;
  const result2=f.binding.handle('authenticated-peer',wire('LANGUAGE_COMPLETE',complete(f.document,'retire-me'),'request2'));const rejected2=assert.rejects(result2);
  await until(()=>f.driver.pending.length===2);const count=f.events.length;const retired=f.binding.retire();f.driver.release();await rejected2;await retired;
  assert.equal(f.events.slice(count).some(e=>e.type==='DIAGNOSTICS'&&e.result.items.length>0),false);
});

for(const variant of ['source-loss','released','final-release'] as const)test(`capture ${variant}: actual delayed selected factory never grants fresh provider authority`,async t=>{
  const f=await fixture(t);
  if(variant==='final-release')f.failFinalRelease();else f.hook(()=>{if(variant==='source-loss')f.setAlive(false);else f.releaseNow();});
  await f.binding.start();
  if(variant==='source-loss'){await until(()=>f.calls.length>0);await new Promise(resolve=>setTimeout(resolve,250));await assert.rejects(f.binding.handle('authenticated-peer',wire('LANGUAGE_OPEN',f.document)),/authority revoked/);}
  else await until(()=>f.binding.view().state==='FAILED');
  assert.equal(f.driver.commands.filter(a=>a[0]==='create').length,0);
});

test('uncertain retirement retains durable owner/admission, forbids replacement; same owner explicit retry succeeds',async t=>{
  const f=await fixture(t);await f.start();const creates=f.driver.commands.filter(a=>a[0]==='create').length;
  const intents=fs.readdirSync(join(f.root,'journal'));assert.ok(intents.length>0);
  f.driver.unreachable=true;const a=f.binding.retire();assert.equal(f.binding.retire(),a);
  const failed=await a;assert.equal(failed.confirmed,false);assert.equal(failed.status.problem?.code,'PROCESS_STOP_UNCONFIRMED');
  assert.ok(f.driver.containers.size>0);assert.deepEqual(fs.readdirSync(join(f.root,'journal')),intents);
  assert.throws(()=>f.binding.start(),/retired/);assert.throws(()=>f.binding.bootstrap(),/retired/);
  f.driver.unreachable=false;const replacement=f.replace();await replacement.start();await until(()=>replacement.view().state==='FAILED');
  assert.equal(f.driver.commands.filter(a=>a[0]==='create').length,creates,'Shared admission blocks replacement even if scope matches');
  assert.equal((await f.binding.retire()).confirmed,true);assert.equal(f.driver.containers.size,0);
  assert.ok(fs.readdirSync(join(f.root,'journal')).length>=intents.length,'Durable lifecycle records never deleted');
});

test('observer exception confers no ownership and cannot stop normal actual source start',async t=>{
  const f=await fixture(t);f.observer(()=>{throw Error('UNIT observer');});await f.start();assert.ok(await f.binding.handle('authenticated-peer',wire('LANGUAGE_COMPLETE',complete(f.document),'request')));assert.equal(f.binding.view().state,'ON');
  assert.equal((await f.binding.retire()).confirmed,true);
});

test('retire before start is real disposed registry status, zero process/preparation calls',async t=>{
  const f=await fixture(t);assert.equal((await f.binding.retire()).confirmed,true);assert.equal(f.binding.view().state,'OFF');assert.equal(f.calls.length,0);assert.equal(f.driver.commands.length,0);
});


test('private issuer rechecks the exact admitted peer/message on disconnect, without blocking ordinary save',async t=>{
  const f=await fixture(t);await f.start();const pending=f.binding.beginSave(f.input);assert.ok(pending);f.setPeer(false);
  assert.equal(f.binding.beginSave({...f.input,transactionMessageId:'later'}),null);f.stageCommit();let publications=0;
  await f.underLease(async token=>{await f.binding.prepareSaveAcknowledgement(token);assert.equal(f.binding.publishSaveAck(pending,'save-receipt',()=>{publications++;}),false);});
  assert.equal(publications,1);assert.equal(f.events.some(e=>e.type==='DIAGNOSTICS'&&e.result.association),false);
});


test('ordinary save before language startup stays null-safe and publishes once without preparation/provider work',async t=>{
  const f=await fixture(t);assert.equal(f.binding.beginSave(f.input),null);let published=0;
  assert.equal(f.binding.publishSaveAck(null,'ordinary',()=>{published++;}),false);assert.equal(published,1);
  assert.equal(f.driver.commands.length,0);assert.equal(f.calls.length,0);
});

for(const provider of ['builtin','off'] as const)test(`bootstrap ${provider} is identity only, actual registry status OFF is not invented remote ON`,async t=>{
  const f=await fixture(t);const options={...f.options,scope:{...f.options.scope,profile:{...f.options.scope.profile,language:{...f.options.scope.profile.language,provider}}}};
  const binding=createRuntimeLanguageBinding(options);
  assert.equal(binding.bootstrap().provider,provider);assert.equal((await binding.start()).state,'OFF');assert.equal(binding.view().autocomplete,'OFF');
  assert.equal(f.calls.length,0);assert.equal(f.driver.commands.length,0);assert.equal((await binding.retire()).confirmed,true);
});

test('already-published immutable diagnostics acquire ACK association only AFTER authentic broadcast, retaining exact original provenance',async t=>{
  const f=await fixture(t);await f.start();f.driver.diagnostics(f.path);
  await until(()=>f.events.some(e=>e.type==='DIAGNOSTICS'&&e.result.items.length>0));
  await until(()=>![...f.driver.containers.values()].some(c=>c.labels['paircoach.phase']==='diagnostics'),'Immutable diagnostic owner terminal/collected/removed');
  const original=f.events.find(e=>e.type==='DIAGNOSTICS'&&e.result.items.length>0)!;assert.equal(original.type,'DIAGNOSTICS');if(original.type!=='DIAGNOSTICS')throw Error();
  const pending=f.binding.beginSave(f.input);assert.ok(pending);f.stageCommit();
  const commands=f.driver.commands.length,frames=f.driver.frames.length;let publications=0;
  await f.underLease(async token=>{
    await f.binding.prepareSaveAcknowledgement(token);
    assert.equal(f.binding.publishSaveAck(pending,'save-receipt',()=>{publications++;assert.equal(f.events.some(e=>e.type==='DIAGNOSTICS'&&!!e.result.association),false);}),true);
  });
  assert.equal(publications,1);const associated=f.events.find(e=>e.type==='DIAGNOSTICS'&&!!e.result.association)!;
  assert.equal(associated.type,'DIAGNOSTICS');if(associated.type!=='DIAGNOSTICS')throw Error();
  assert.deepEqual(associated.result.sourceStamp,original.result.sourceStamp);assert.deepEqual(associated.result.provenance,original.result.provenance);
  assert.deepEqual(associated.result.items,original.result.items);assert.equal(associated.result.association?.saveReceiptId,'save-receipt');
  assert.equal(f.driver.commands.length,commands);assert.equal(f.driver.frames.slice(frames).some(frame=>/didOpen|didChange|didSave|initialize/.test(frame.method??'')),false);
});

for(const variant of ['wrong-receipt','clone-pending','changed-run-input','changed-dependency','reconnect'] as const)test(`held ACK join refuses ${variant} without suppressing ordinary publish`,async t=>{
  const f=await fixture(t);await f.start();const pending=f.binding.beginSave(f.input);assert.ok(pending);f.stageCommit();let publications=0;
  await f.underLease(async token=>{
    await f.binding.prepareSaveAcknowledgement(token);
    if(variant==='changed-run-input')token.run.timeoutMs++;
    if(variant==='changed-dependency')fs.appendFileSync(join(f.workspace,'requirements.txt'),'changed==2\n');
    if(variant==='reconnect')f.setSnapshot({...f.snapshot,revision:'reconnect',documents:f.snapshot.documents.map(d=>({...d,stamp:{...d.stamp,connectionGeneration:'new-connection'}}))});
    assert.equal(f.binding.publishSaveAck(variant==='clone-pending'?structuredClone(pending):pending,variant==='wrong-receipt'?'foreign-receipt':'save-receipt',()=>{publications++;}),false);
  });
  assert.equal(publications,1);assert.equal(f.events.some(e=>e.type==='DIAGNOSTICS'&&!!e.result.association),false);
});


test('actual failure status retains uncertainty/code, never publishes transport/private exception text',async t=>{
  const f=await fixture(t);await f.start();f.driver.failureMessage='SENTINEL-private-path/token/stderr';f.driver.unreachable=true;
  const result=await f.binding.retire();assert.equal(result.confirmed,false);assert.equal(result.status.problem?.code,'PROCESS_STOP_UNCONFIRMED');
  assert.equal(JSON.stringify({result,view:f.binding.view(),events:f.events}).includes('SENTINEL'),false);
});
