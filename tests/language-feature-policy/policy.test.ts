/** UNIT only: actual binding/registry/selected factory, immutable shadows and FIFO.
 * Docker I/O + prepared receipt data and outer source/save authority are synthetic. */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import {join} from 'node:path';
import {fixture,complete,wire,until,tick} from './fixture';
import {LANGUAGE_LIMITS} from '../../src/shared/language-v2';
const manifests=(f:Awaited<ReturnType<typeof fixture>>)=>fs.readdirSync(f.owned).map(id=>JSON.parse(fs.readFileSync(join(f.owned,id,'manifest.json'),'utf8')));
const phases=(f:Awaited<ReturnType<typeof fixture>>)=>f.driver.commands.filter(c=>c[0]==='create').map(c=>c.find(v=>v.startsWith('paircoach.phase='))!.split('=')[1]).sort();
const settleDisabled=()=>new Promise(r=>setTimeout(r,LANGUAGE_LIMITS.diagnosticCoalesceMs+30));

for(const [completion,diagnostics] of [[true,true],[true,false],[false,true],[false,false]])test(`actual binding policy ${completion}/${diagnostics}: per-lane launch, requests, refresh and ACK prepare`,async t=>{
  const policy={completion,diagnostics},f=await fixture(t,'python',policy,!completion&&!diagnostics);
  const expected=[...(completion?['completion']:[]),...(diagnostics?['diagnostics']:[])].sort();
  await f.start();await settleDisabled();
  assert.deepEqual(phases(f),expected);
  assert.equal(f.acquisitions,expected.length,'No disabled capture lease');
  assert.equal(fs.readdirSync(f.owned).length,expected.length,'No disabled private shadow');
  assert.equal(f.binding.bootstrap().provider,'remote','Real selected profile retained, not fabricated off/builtin');
  if(completion){
    const result=await f.binding.handle('authenticated-peer',wire('LANGUAGE_COMPLETE',complete(f.document),'request'));
    assert.ok(result&&result.items.some(i=>i.label==='safeMethod'));
  }else{
    const before=f.driver.frames.length;
    await assert.rejects(f.binding.handle('authenticated-peer',wire('LANGUAGE_COMPLETE',complete(f.document),'request')),/disabled/i);
    assert.equal(f.driver.frames.length,before,'Disabled completion never calls provider or returns list');
    assert.equal(f.binding.view().autocomplete,'OFF');
  }
  if(diagnostics){
    f.driver.diagnostics(f.path);await until(()=>f.events.some(e=>e.type==='DIAGNOSTICS'&&e.result.items.length>0));
    const result=f.events.find(e=>e.type==='DIAGNOSTICS'&&e.result.items.length>0)!;
    assert.equal(result.type,'DIAGNOSTICS');
    if(result.type==='DIAGNOSTICS')assert.equal(result.result.provenance.kind,'IMMUTABLE_GENERATION');
  }else assert.equal(f.events.some(e=>e.type==='DIAGNOSTICS'),false);
  assert.equal(f.binding.view().state,expected.length?'ON':'OFF');
  assert.equal(f.binding.view().problem,null);
  // Config object is caller-owned. Mutation cannot upgrade ANY disabled lane.
  policy.completion=true;policy.diagnostics=true;
  fs.writeFileSync(join(f.workspace,'inactive.txt'),'NEW CLOSED B');
  f.setSnapshot({...f.snapshot,revision:'fresh-policy-source'});
  f.binding.invalidateSource();await f.binding.refreshSource();
  await until(()=>manifests(f).length===expected.length*2);await settleDisabled();
  assert.deepEqual(phases(f),[...expected,...expected].sort());
  assert.equal(f.acquisitions,expected.length*2);
  for(const m of manifests(f).filter(m=>m.leaseId==='fresh-policy-source'))assert.equal(fs.readFileSync(join(f.owned,m.launchId,'workspace','inactive.txt'),'utf8'),'NEW CLOSED B');
  assert.equal(f.binding.beginSave(f.input),null,'No fake analysis/correlation from refresh');
  await until(()=>f.driver.frames.filter(fr=>fr.method==='textDocument/didOpen').length===expected.length*2);
  if(!diagnostics)assert.equal(f.events.some(e=>e.type==='DIAGNOSTICS'),false);
  if(!completion&&!diagnostics){
    f.failCapture(true);await assert.rejects(f.binding.refreshSource(),/source capture failed/);
    assert.equal(f.binding.view().state,'OFF');assert.equal(f.binding.view().problem,null);
    f.failCapture(false);
  }
  // NEW admitted document remains ordinary-save eligible even when there is no language proof.
  await f.binding.handle('authenticated-peer',wire('LANGUAGE_OPEN',f.document));
  const pending=f.binding.beginSave(f.input);if(!diagnostics)assert.equal(pending,null,'No diagnostic evidence minted');
  const beforeCalls=f.calls.length,beforeAcquisitions=f.acquisitions;
  let publishes=0;
  await f.underLease(async lease=>{
    await f.binding.prepareSaveAcknowledgement(lease);
    assert.equal(f.binding.publishSaveAck(null,'ordinary-save',()=>{publishes++;}),false);
  });
  assert.equal(publishes,1,'Authentic ordinary ACK exactly once, no fake association');
  if(!completion&&!diagnostics){
    assert.equal(f.calls.length,0,'No remote receipt/cache/image verification, even for missing receipt');
    assert.equal(beforeCalls,0);assert.equal(f.driver.commands.length,0);
    assert.equal(beforeAcquisitions,0,'Only test outer manual-save lease, no registry lease');
    assert.equal(f.binding.view().state,'OFF');assert.equal(f.binding.view().autocomplete,'OFF');assert.equal(f.binding.view().problem,null);
    f.setAlive(false);
    assert.throws(()=>f.binding.publishSaveAck(null,'not-authorized',()=>{publishes++;}),/revoked/);
    assert.equal(publishes,1,'OFF does not bypass actual owner/save publication guard');f.setAlive(true);
  }else assert.ok(f.calls.length>beforeCalls,'Enabled lane retains real selected ACK verification');
});

for(const policy of [{completion:true,diagnostics:false},{completion:false,diagnostics:true}])test(`missing real receipt fails closed for enabled sibling ${JSON.stringify(policy)}`,async t=>{
  const f=await fixture(t,'python',policy,true);
  await f.binding.start();await until(()=>f.binding.view().state==='FAILED');
  assert.equal(f.driver.commands.length,0);assert.equal(f.events.some(e=>e.type==='DIAGNOSTICS'),false);
  await assert.rejects(f.prepare(),/receipt/i);
  assert.equal(f.binding.view().state,'FAILED');
});

test('legacy absent binding policy preserves both lanes',async t=>{
  const f=await fixture(t);await f.start();assert.deepEqual(phases(f),['completion','diagnostics']);
});

for(const policy of [{completion:true,diagnostics:false},{completion:false,diagnostics:true}])test(`source operations and failed real owner guard cannot upgrade disabled sibling ${JSON.stringify(policy)}`,async t=>{
  const f=await fixture(t,'python',policy);await f.start();
  const expected=policy.completion?'completion':'diagnostics';
  // Exercise distinct normal feed APIs, not just the nonACK refresh path.
  await f.binding.handle('authenticated-peer',wire('LANGUAGE_OPEN',f.document));
  const changed={...f.document,reason:'TYPING' as const,stamp:{...f.document.stamp,localModelVersion:4}};
  f.setSnapshot({revision:'changed-input',documents:[changed]});
  await f.binding.handle('authenticated-peer',wire('LANGUAGE_CHANGE',changed,'changed-document'));
  f.setSnapshot({revision:'closed-input',documents:[]});
  await f.binding.handle('authenticated-peer',wire('LANGUAGE_CLOSE',{stamp:changed.stamp},'closed-document'));
  await f.binding.fileOperation({kind:'DELETE',path:'inactive.txt'});
  await settleDisabled();await tick();
  // Feed revocations legitimately retire old owners. Await the actual current owner/initialize
  // before measuring that a subsequent FAILED guard cannot cause new provider effects.
  await until(()=>manifests(f).some(m=>m.leaseId==='closed-input'));
  const fresh=manifests(f).find(m=>m.leaseId==='closed-input')!;
  await until(()=>f.driver.phaseFrames.some(fr=>fr.launchId===fresh.launchId&&fr.request.method==='initialized'));
  await tick();
  assert.ok(phases(f).every(p=>p===expected));
  assert.equal(f.events.some(e=>e.type==='DIAGNOSTICS'),false,'No fake analysed-empty evidence');
  const calls=f.calls.length,commands=f.driver.commands.length,leases=f.acquisitions;
  f.setAlive(false);
  await assert.rejects(f.binding.refreshSource(),/revoked/);
  await assert.rejects(f.prepare(),/revoked/);
  assert.equal(f.calls.length,calls);assert.equal(f.driver.commands.length,commands);
  assert.equal(f.acquisitions,leases+1,'Only explicit test save FIFO entry, no registry/provider effect');
  f.setAlive(true);
});

test('diagnostics-only authentic SAME-ledger ACK retains immutable provenance and never starts completion',async t=>{
  const f=await fixture(t,'python',{completion:false,diagnostics:true});await f.start();
  await f.binding.handle('authenticated-peer',wire('LANGUAGE_OPEN',f.document));
  await until(()=>f.driver.frames.filter(fr=>fr.method==='textDocument/didOpen').length===2);
  f.driver.diagnostics(f.path);await until(()=>f.events.some(e=>e.type==='DIAGNOSTICS'&&e.result.items.length>0));
  const original=f.events.find(e=>e.type==='DIAGNOSTICS'&&e.result.items.length>0)!;
  const pending=f.binding.beginSave(f.input);assert.ok(pending,'Actual immutable sent source joined by real issuer');
  f.stageCommit();let publishes=0;const before=phases(f).length;
  await f.underLease(async token=>{
    await f.binding.prepareSaveAcknowledgement(token);
    assert.equal(f.binding.publishSaveAck(pending,'save-receipt',()=>{publishes++;}),true);
  });
  assert.equal(publishes,1);assert.equal(phases(f).length,before,'ACK never launches disabled completion or a new analysis');
  assert.ok(phases(f).every(p=>p==='diagnostics'));
  const joined=f.events.find(e=>e.type==='DIAGNOSTICS'&&e.result.association?.saveReceiptId==='save-receipt');assert.ok(joined);
  if(original.type!=='DIAGNOSTICS'||joined.type!=='DIAGNOSTICS')throw Error('Real diagnostic events required');
  assert.deepEqual(joined.result.provenance,original.result.provenance);assert.deepEqual(joined.result.sourceStamp,original.result.sourceStamp);
  assert.equal(joined.result.presentationStamp.documentVersion,2);assert.equal(f.binding.view().autocomplete,'OFF');
});
