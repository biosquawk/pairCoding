import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,until,tick,complete} from './fixture';
import {LanguageFeatureRegistry} from '../../src/server/language/LanguageFeatureRegistry';
import {createRuntimeLanguageBinding} from '../../src/server/runtime-coordinator/RuntimeLanguageBinding';
import {createSelectedCacheLanguageFactory} from '../../src/server/language/SelectedCacheLanguageAuthority';
import {LanguageAckLedger} from '../../src/server/language/LanguageAckLedger';
import * as codec from '../../src/language/uriCodec';
import type {ImmutableDiagnosticGeneration} from '../../src/server/language/ports';
import {LANGUAGE_LIMITS} from '../../src/shared/language-v2';

test('disabled direct diagnostics rejects BEFORE invalidating or restarting enabled completion; immutable registry input',async t=>{
  const policy={completion:true,diagnostics:false},f=await fixture(t,'python',policy);
  const selected=createSelectedCacheLanguageFactory(f.options.selected);
  const ledger=new LanguageAckLedger({readCurrent:()=>null,readAnalysisSource:()=>null,readCommittedSave:()=>null},codec);
  const timers:number[]=[];
  const clock={set(ms:number,callback:()=>void){timers.push(ms);return setTimeout(callback,ms);},clear(handle:unknown){clearTimeout(handle as ReturnType<typeof setTimeout>);}};
  const registry=new LanguageFeatureRegistry({factory:selected.factory,authority:f.options.sourceAuthority,ackLedger:ledger,languageFeatures:policy,clock});
  f.retainCleanup(async()=>{assert.equal((await registry.disposeProject(f.options.scope)).confirmed,true);});
  await registry.startProject(f.options.scope);await until(()=>f.driver.frames.some(fr=>fr.method==='textDocument/didOpen'));
  assert.deepEqual(timers,[],'Disabled diagnostic coalescing/analysis installs NO timers');
  policy.completion=false;policy.diagnostics=true;
  const commands=f.driver.commands.length,leases=f.acquisitions,frames=f.driver.frames.length;
  await assert.rejects(registry.startDiagnostics(f.options.scope,{} as ImmutableDiagnosticGeneration),/disabled/i);
  await tick();assert.equal(f.driver.commands.length,commands);assert.equal(f.acquisitions,leases);
  assert.equal(f.driver.frames.length,frames,'No cancellation/invalidation/restart of completion sibling');
  assert.equal(registry.readAnalysisSource(f.document.stamp),null);assert.equal(registry.readSentAnalysisSource(f.document.stamp),null);
  assert.ok((await registry.complete(complete(f.document))).items.length>0);
  await registry.refreshSource(f.options.scope);await tick();
  await new Promise(r=>setTimeout(r,LANGUAGE_LIMITS.diagnosticCoalesceMs+30));
  assert.ok(f.driver.commands.filter(c=>c[0]==='create').every(c=>c.includes('paircoach.phase=completion')));
  assert.equal(registry.readSentAnalysisSource(f.document.stamp),null);
});

test('malformed/partial policy rejected synchronously before callbacks, bindLedger, timers or selected preparation',async t=>{
  const f=await fixture(t);let effects=0;
  const authority={capture(){effects++;throw Error('unexpected capture');},isCurrent(){effects++;return true;}};
  const factory={bindAckLedger(){effects++;},create(){effects++;throw Error('unexpected create');},refreshCompletion(){effects++;return false;}};
  const clock={set(){effects++;return 1;},clear(){effects++;}};
  for(const policy of [null,{},[],true,'true',{completion:true},{diagnostics:false},{completion:1,diagnostics:true},{completion:false,diagnostics:'false'}]){
    assert.throws(()=>new LanguageFeatureRegistry({authority,factory,clock,ackLedger:{} as LanguageAckLedger,languageFeatures:policy as any}),/policy/i);
    assert.equal(effects,0);
    const options={...f.options,languageFeatures:policy as any,assertCurrent(){effects++;}};
    assert.throws(()=>createRuntimeLanguageBinding(options),/policy/i);assert.equal(effects,0);
  }
  assert.equal(f.acquisitions,0);assert.equal(f.calls.length,0);assert.equal(f.driver.commands.length,0);
});

test('BOTH disabled registry cannot acquire capture lease, create, refresh, timer or direct provider work',async t=>{
  const f=await fixture(t,'python',{completion:false,diagnostics:false},true);let effects=0;
  const forbidden=()=>{effects++;throw Error('Disabled provider effect');};
  const ledger=new LanguageAckLedger({readCurrent:()=>null,readAnalysisSource:()=>null,readCommittedSave:()=>null},codec);
  const registry=new LanguageFeatureRegistry({authority:f.options.sourceAuthority,ackLedger:ledger,languageFeatures:{completion:false,diagnostics:false},
    clock:{set:forbidden,clear:forbidden},factory:{withCaptureLease:forbidden,create:forbidden,refreshCompletion:forbidden}});
  const scope=f.options.scope;
  assert.equal((await registry.startProject(scope)).state,'OFF');
  await registry.open(f.document);await registry.change(f.document);
  registry.invalidateSource(scope);await registry.refreshSource(scope);
  await registry.fileOperation(scope,{kind:'DELETE',path:'inactive.txt'});
  f.setSnapshot({revision:'closed',documents:[]});await registry.close(f.document.stamp);
  await assert.rejects(registry.complete(complete(f.document)),/disabled/i);
  await assert.rejects(registry.startDiagnostics(scope,{} as ImmutableDiagnosticGeneration),/disabled/i);
  assert.equal(registry.readSentAnalysisSource(f.document.stamp),null);assert.equal(effects,0);
  const result=await registry.disposeProject(scope);assert.equal(result.confirmed,true);
  assert.equal(result.status.state,'OFF');assert.equal(result.status.autocomplete,'OFF');assert.equal(result.status.problem,null);assert.equal(effects,0);
});
