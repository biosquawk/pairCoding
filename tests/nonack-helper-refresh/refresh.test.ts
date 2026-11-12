/** NEW finite helper proof. Actual registry/binding/selected/issuer/codec/private FS and workspace
 * FIFO. Docker process/transport + prepared receipts + outer source/save authority UNIT-injected.
 * No HTTP caller, real Docker, host readiness, native or full-backend acceptance claim. */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { fixture, complete, wire, until, tick, codec } from './fixture';
import type { ShadowManifest } from '../../src/server/language/LanguageShadowStore';
import type { OpenOrChange } from '../../src/shared/language-v2';
import { LanguageFeatureRegistry } from '../../src/server/language/LanguageFeatureRegistry';
import { createSelectedCacheLanguageFactory } from '../../src/server/language/SelectedCacheLanguageAuthority';
import { LanguageAckLedger } from '../../src/server/language/LanguageAckLedger';
const deferred = () => {let resolve!:()=>void;const promise=new Promise<void>(r=>{resolve=r;});return {promise,resolve};};
const manifests = (root:string):ShadowManifest[] => fs.readdirSync(root).map(id=>JSON.parse(fs.readFileSync(join(root,id,'manifest.json'),'utf8')));
const creates = (f:Awaited<ReturnType<typeof fixture>>) => f.driver.commands.filter(c=>c[0]==='create').length;
const diagnosticCount = (f:Awaited<ReturnType<typeof fixture>>) => f.events.filter(e=>e.type==='DIAGNOSTICS'&&e.result.items.length>0).length;

for(const family of ['python','java-maven'] as const)test(`${family}: synchronous revoke bypasses just-revoked guard, clears real markers, old pending and completion before await`,async t=>{
  const f=await fixture(t,family);await f.start();
  f.driver.diagnostics(f.path);await until(()=>diagnosticCount(f)===1);
  // Actual completed diagnostic owner may retire naturally. Keep the completion pending.
  f.driver.hold=true;
  const completing=f.binding.handle('authenticated-peer',wire('LANGUAGE_COMPLETE',complete(f.document,'old'),'old-request'));
  const rejected=assert.rejects(completing);await until(()=>f.driver.pending.length===1);
  const pending=f.binding.beginSave(f.input);assert.ok(pending);
  const before=f.events.length,calls=f.calls.length,commands=f.driver.commands.length;
  f.setAlive(false); // Normal async owner guard has ALREADY been synchronously revoked.
  assert.doesNotThrow(()=>f.binding.invalidateSource());
  const cleared=f.events.slice(before);
  assert.ok(cleared.some(e=>e.type==='DIAGNOSTICS'&&e.result.items.length===0));
  assert.ok(cleared.every(e=>e.type==='DIAGNOSTICS'&&e.result.items.length===0),'No STATUS/analysed result from clearing bypass');
  assert.equal(f.calls.length,calls,'No capture/preparation at synchronous invalidation');
  assert.equal(f.driver.commands.length,commands,'Retirement runs only after synchronous revoke');
  f.setAlive(true);assert.equal(f.binding.beginSave(f.input),null);
  f.driver.release();await rejected;
  f.stageCommit();let published=0;
  await f.underLease(async token=>{
    await f.binding.prepareSaveAcknowledgement(token);
    assert.equal(f.binding.publishSaveAck(pending,'save-receipt',()=>{published++;}),false,'Old private pending cannot mint alias after equal-byte source return');
  });
  assert.equal(published,1);assert.equal(f.events.some(e=>e.type==='DIAGNOSTICS'&&e.result.association),false);
});

for(const family of ['python','java-maven'] as const)test(`${family}: refresh captures complete changed closed B + ALL retained overlays in BOTH actual fresh shadows, without client message`,async t=>{
  const f=await fixture(t,family);
  const inactive:OpenOrChange={...f.document,stamp:{...f.document.stamp,path:family==='python'?'Inactive.py':'Inactive.java',modelLifetime:'inactive-model'},content:f.document.content};
  fs.writeFileSync(join(f.workspace,inactive.stamp.path),'inactive original disk');
  f.setSnapshot({...f.snapshot,documents:[f.document,inactive]});
  await f.binding.start();await f.binding.handle('authenticated-peer',wire('LANGUAGE_OPEN',f.document));
  await until(()=>f.driver.frames.filter(fr=>fr.method==='textDocument/didOpen').length===4);
  f.driver.diagnostics(f.path);await until(()=>diagnosticCount(f)===1);
  const oldEvent=f.events.find(e=>e.type==='DIAGNOSTICS'&&e.result.items.length>0)!;assert.equal(oldEvent.type,'DIAGNOSTICS');
  if(oldEvent.type!=='DIAGNOSTICS')throw Error();
  const oldIds=new Set(manifests(f.owned).map(m=>m.launchId));
  const original=fs.readFileSync(join(f.workspace,f.path)),allDocuments=structuredClone(f.snapshot.documents);
  fs.writeFileSync(join(f.workspace,'inactive.txt'),'CLOSED-B NEW CONTENT\r\n');
  f.setSnapshot({revision:'nonack-full-current',documents:allDocuments});
  f.binding.invalidateSource();
  await f.binding.refreshSource();
  assert.equal(f.binding.beginSave(f.input),null,'Refresh must not resurrect old client correlation');
  // Promise means accepted scheduling, not ON/semantic diagnostics.
  assert.equal(f.binding.view().state,'INDEXING');
  await until(()=>manifests(f.owned).filter(m=>!oldIds.has(m.launchId)).length===2);
  const fresh=manifests(f.owned).filter(m=>!oldIds.has(m.launchId));
  assert.deepEqual(fresh.map(m=>m.phase).sort(),['completion','diagnostics']);
  for(const m of fresh){
    assert.equal(m.leaseId,'nonack-full-current');assert.deepEqual(m.overlays,allDocuments.map(d=>d.stamp).sort((a,b)=>a.path<b.path?-1:1));
    const b=m.files.find(file=>file.path==='inactive.txt');assert.ok(b);assert.equal(b.origin,'disk');
    assert.equal(fs.readFileSync(join(f.owned,m.launchId,'workspace','inactive.txt'),'utf8'),'CLOSED-B NEW CONTENT\r\n');
    for(const d of allDocuments){assert.equal(m.files.find(file=>file.path===d.stamp.path)?.origin,'overlay');assert.equal(fs.readFileSync(join(f.owned,m.launchId,'workspace',d.stamp.path),'utf8'),codec.normalizeContent(d.content));}
  }
  assert.deepEqual(fs.readFileSync(join(f.workspace,f.path)),original,'No original/draft save');
  await until(()=>f.driver.frames.filter(fr=>fr.method==='textDocument/didOpen').length===8);
  f.driver.diagnostics(f.path);await until(()=>diagnosticCount(f)===2);
  const next=f.events.filter(e=>e.type==='DIAGNOSTICS'&&e.result.items.length>0).at(-1)!;assert.equal(next.type,'DIAGNOSTICS');
  if(next.type!=='DIAGNOSTICS')throw Error();
  assert.equal(next.result.provenance.kind,'IMMUTABLE_GENERATION');assert.equal(oldEvent.result.provenance.kind,'IMMUTABLE_GENERATION');
  if(next.result.provenance.kind!=='IMMUTABLE_GENERATION'||oldEvent.result.provenance.kind!=='IMMUTABLE_GENERATION')throw Error('Actual immutable provenance required');
  assert.notEqual(next.result.provenance.launchId,oldEvent.result.provenance.launchId);
  assert.notEqual(next.result.provenance.inputManifestSha256,oldEvent.result.provenance.inputManifestSha256);
  assert.equal(next.result.association,null);assert.deepEqual(next.result.sourceStamp,f.document.stamp);
  assert.equal(f.binding.beginSave(f.input),null,'Real source analysis needs no re-open and cannot reconstruct ACK ledger');
});

test('actual occupied workspace FIFO: accepted refresh does not await nested gate or start provider while mutation owns source',async t=>{
  const f=await fixture(t);await f.start();const oldIds=new Set(manifests(f.owned).map(m=>m.launchId));
  const entered=deferred(),release=deferred();
  const mutation=f.fifo._withQueuedMutation(async()=>{
    fs.writeFileSync(join(f.workspace,'inactive.txt'),'held-current B');f.setSnapshot({...f.snapshot,revision:'under-real-FIFO'});
    f.binding.invalidateSource();entered.resolve();await release.promise;
  });
  await entered.promise;
  try {
    const count=creates(f),calls=f.calls.length;
    await f.binding.refreshSource();await tick();
    assert.equal(creates(f),count);assert.equal(f.calls.length,calls,'Selected preparation waits SAME real FIFO');
    assert.equal(manifests(f.owned).filter(m=>!oldIds.has(m.launchId)).length,0);
  } finally {release.resolve();await mutation;}
  await until(()=>manifests(f.owned).filter(m=>!oldIds.has(m.launchId)).length===2);
  await until(()=>creates(f)===4);
  // Fixture beforeCreate asserts each actual retained copy token was released before every start.
});

test('actual FIFO queued old vector is fenced; fresh finite refresh after release is not lost',async t=>{
  const f=await fixture(t);await f.start();const oldIds=new Set(manifests(f.owned).map(m=>m.launchId));
  const entered=deferred(),release=deferred();
  const mutation=f.fifo._withQueuedMutation(async()=>{entered.resolve();await release.promise;});await entered.promise;
  await f.binding.refreshSource();await tick();
  fs.writeFileSync(join(f.workspace,'inactive.txt'),'superseding B');f.setSnapshot({...f.snapshot,revision:'queued-vector-NEW'});f.binding.invalidateSource();
  release.resolve();await mutation;await tick();
  assert.equal(manifests(f.owned).filter(m=>!oldIds.has(m.launchId)).length,0,'Stale queue entry never transfers owner');
  await f.binding.refreshSource();
  await until(()=>manifests(f.owned).filter(m=>!oldIds.has(m.launchId)).length===2);
  assert.ok(manifests(f.owned).filter(m=>!oldIds.has(m.launchId)).every(m=>m.leaseId==='queued-vector-NEW'));
});

test('refresh superseded during async selected preparation cannot launch or recreate document correlation',async t=>{
  const f=await fixture(t);await f.start();const oldIds=new Set(manifests(f.owned).map(m=>m.launchId));
  const entered=deferred(),release=deferred();let first=true;
  f.hook(async()=>{if(first){first=false;entered.resolve();await release.promise;}});
  await f.binding.refreshSource();await entered.promise;
  fs.writeFileSync(join(f.workspace,'inactive.txt'),'during-prepare');f.setSnapshot({...f.snapshot,revision:'prepare-REVOKED'});f.binding.invalidateSource();
  release.resolve();await tick();
  assert.equal(manifests(f.owned).filter(m=>!oldIds.has(m.launchId)).length,0);
  assert.equal(f.binding.beginSave(f.input),null);f.hook(null);
  await f.binding.refreshSource();await until(()=>manifests(f.owned).filter(m=>!oldIds.has(m.launchId)).length===2);
});

test('refresh Promise rejects synchronous source capture failure truthfully; invalidation not analysed-empty success',async t=>{
  const f=await fixture(t);await f.start();f.driver.diagnostics(f.path);await until(()=>diagnosticCount(f)===1);
  f.setSnapshot({...f.snapshot,revision:'broken-vector',documents:[f.document,f.document]});
  const before=creates(f);await assert.rejects(f.binding.refreshSource(),/captured language overlays/);
  assert.equal(f.binding.view().state,'FAILED');assert.equal(diagnosticCount(f),1);await tick();assert.equal(creates(f),before);
});

test('refresh and newly admitted OPEN are asynchronously fenced against equal-vector revoke before continuation',async t=>{
  const f=await fixture(t);await f.start();
  const opening=f.binding.handle('authenticated-peer',wire('LANGUAGE_OPEN',f.document));
  const rejected=assert.rejects(opening,/revoked|superseded/);
  f.binding.invalidateSource();await rejected;assert.equal(f.binding.beginSave(f.input),null);
  const refresh=f.binding.refreshSource(),refreshRejected=assert.rejects(refresh,/superseded/);f.binding.invalidateSource();await refreshRejected;
  await f.binding.refreshSource();assert.equal(f.binding.beginSave(f.input),null);
  // Only a NEW genuinely admitted message can establish correlation through the normal API.
  await f.binding.handle('authenticated-peer',wire('LANGUAGE_OPEN',f.document));
  await until(()=>f.driver.frames.filter(fr=>fr.method==='textDocument/didOpen').length>=4);
  assert.ok(f.binding.beginSave(f.input));
});

test('retired queued refresh never transfers a replacement and clear after retirement is harmless',async t=>{
  const f=await fixture(t);await f.start();const before=creates(f),oldIds=new Set(manifests(f.owned).map(m=>m.launchId));
  const entered=deferred(),release=deferred();const mutation=f.fifo._withQueuedMutation(async()=>{entered.resolve();await release.promise;});await entered.promise;
  await f.binding.refreshSource();await tick();const retired=f.binding.retire();f.binding.invalidateSource();
  release.resolve();await mutation;assert.equal((await retired).confirmed,true);await tick();
  assert.equal(creates(f),before);assert.equal(manifests(f.owned).filter(m=>!oldIds.has(m.launchId)).length,0);
  await assert.rejects(f.binding.refreshSource(),/retired/);
});

test('uncertain nonACK Stop retains exact durable owners/admission; refresh is not retry/replacement, explicit same-owner retire reconciles',async t=>{
  const f=await fixture(t);await f.start();const before=creates(f),journal=fs.readdirSync(join(f.root,'journal'));
  const names=[...f.driver.containers.values()].map(c=>c.id).sort();f.driver.unreachable=true;f.binding.invalidateSource();
  await until(()=>f.binding.view().problem?.code==='PROCESS_STOP_UNCONFIRMED');await tick();
  const commands=f.driver.commands.length,observations=f.driver.observations.length;
  f.binding.invalidateSource();await assert.rejects(f.binding.refreshSource(),/ownership unresolved/);await tick();
  assert.equal(creates(f),before);assert.equal(f.driver.commands.length,commands,'No automatic Stop retry');assert.equal(f.driver.observations.length,observations,'No hidden daemon/retirement retry either');
  assert.deepEqual([...f.driver.containers.values()].map(c=>c.id).sort(),names);
  assert.ok(journal.every(name=>fs.existsSync(join(f.root,'journal',name))));
  f.driver.unreachable=false;assert.equal((await f.binding.retire()).confirmed,true);assert.equal(creates(f),before);
});

test('registry exact scope and actual sent-source archive are synchronously revoked, stale late diagnostic cannot republish',async t=>{
  const f=await fixture(t),selected=createSelectedCacheLanguageFactory(f.options.selected);
  let registry!:LanguageFeatureRegistry;
  const ledger=new LanguageAckLedger({readCurrent:f.options.saveAuthority.readCurrent,readCommittedSave:f.options.saveAuthority.readCommittedSave,
    readAnalysisSource:(_peer,_message)=>registry.readSentAnalysisSource(f.document.stamp)},codec);
  registry=new LanguageFeatureRegistry({factory:selected.factory,ackLedger:ledger,authority:f.options.sourceAuthority});
  f.retainCleanup(async()=>{assert.equal((await registry.disposeProject(f.options.scope)).confirmed,true);});
  await registry.startProject(f.options.scope);const events:typeof f.events=[];registry.subscribe(f.options.scope,e=>events.push(e));
  await until(()=>f.driver.frames.filter(fr=>fr.method==='textDocument/didOpen').length===2);
  assert.ok(registry.readSentAnalysisSource(f.document.stamp));
  assert.throws(()=>registry.invalidateSource({...f.options.scope,providerGeneration:'foreign'}),/Obsolete/);
  assert.ok(registry.readSentAnalysisSource(f.document.stamp),'Foreign revoke cannot clear real scope');
  const old=[...f.driver.containers.values()].find(c=>c.labels['paircoach.phase']==='diagnostics')!;
  registry.invalidateSource(f.options.scope);
  assert.equal(registry.readSentAnalysisSource(f.document.stamp),null);assert.equal(registry.readAnalysisSource(f.document.stamp),null);
  f.driver.send(old.id,{jsonrpc:'2.0',method:'textDocument/publishDiagnostics',params:{uri:codec.toWorkspaceUri(f.path),diagnostics:[{range:{start:{line:0,character:0},end:{line:0,character:2}},severity:1,message:'LATE'}]}});
  assert.equal(events.some(e=>e.type==='DIAGNOSTICS'&&e.result.items.length>0),false);
  await assert.rejects(registry.refreshSource({...f.options.scope,shadowGeneration:'foreign'}),/Obsolete/);
});


test('genuine pre-existing private ACK alias is erased; fresh equal-overlay analysis cannot inherit old receipt or preparation',async t=>{
  const f=await fixture(t);await f.start();const pending=f.binding.beginSave(f.input);assert.ok(pending);
  f.stageCommit();let publishes=0;
  await f.underLease(async token=>{await f.binding.prepareSaveAcknowledgement(token);assert.equal(f.binding.publishSaveAck(pending,'save-receipt',()=>{publishes++;}),true);});
  f.driver.diagnostics(f.path);await until(()=>f.events.some(e=>e.type==='DIAGNOSTICS'&&e.result.items.length>0&&e.result.association?.saveReceiptId==='save-receipt'));
  assert.equal(publishes,1);const before=f.events.length;
  f.binding.invalidateSource();assert.ok(f.events.slice(before).some(e=>e.type==='DIAGNOSTICS'&&e.result.items.length===0));
  await f.binding.refreshSource();
  await until(()=>f.driver.frames.filter(fr=>fr.method==='textDocument/didOpen').length===4);
  assert.equal(f.binding.beginSave({...f.input,baseVersion:2}),null);
  // Old held save preparation was revoked; ordinary ACK still publishes, NEVER re-associates.
  assert.equal(f.binding.publishSaveAck(pending,'save-receipt',()=>{publishes++;}),false);assert.equal(publishes,2);
  f.driver.diagnostics(f.path);await until(()=>f.events.slice(before).some(e=>e.type==='DIAGNOSTICS'&&e.result.items.length>0));
  assert.ok(f.events.slice(before).filter(e=>e.type==='DIAGNOSTICS'&&e.result.items.length>0).every(e=>e.type==='DIAGNOSTICS'&&e.result.association===null));
});


test('completion already resolved by registry is still fenced at binding continuation by equal-vector revoke',async t=>{
  const f=await fixture(t);await f.start();let checked=0;
  f.peerHook(message=>{if(message.type==='LANGUAGE_COMPLETE' && ++checked===2)f.binding.invalidateSource();});
  await assert.rejects(f.binding.handle('authenticated-peer',wire('LANGUAGE_COMPLETE',complete(f.document,'resolved-but-revoked'),'race')),/Stale\/unbound/);
  assert.equal(checked,2,'Inbound and post-result authentic peer checks both occurred');
  f.peerHook(null);assert.equal(f.binding.beginSave(f.input),null);
});
