import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { RuntimeSettingsV2 } from '../../src/components/RuntimeSettingsV2';
import { buildRuntimeSettingsV2, type RuntimeSettingsDraftV2 } from '../../src/services/RuntimeClientV2';
import { RuntimeStatusV2 } from '../../src/components/RuntimeStatusV2';
import { execution, fields, project, run, settings } from './fixtures';
const draft=():RuntimeSettingsDraftV2=>({RUN_MAIN:{enabled:false,fields:{}},RUN_TESTS:{enabled:true,fields:{workingDirectory:'.','entry.kind':'TESTS','tests.paths':'tests/spec.txt','tests.names':'',timeoutMs:'1000'}}});
test('descriptor exact-key settings builder supports tests-only, empty disable and preserves metadata',()=>{
  assert.deepEqual(buildRuntimeSettingsV2(settings(),draft(),fields()),settings());
  const d=draft();d.RUN_TESTS.enabled=false;const disabled=buildRuntimeSettingsV2(settings(),d,fields());assert.deepEqual(disabled.runProfiles,[]);assert.deepEqual(disabled.contextPatterns,['src/**']);assert.equal(disabled.aiConsent,false);
});
test('builder rejects hidden fields, prototype key, invalid selector, bounds, choice and tests-only main',()=>{
  const cases=[(d:any)=>d.RUN_TESTS.fields.timeoutMs='999',(d:any)=>d.RUN_TESTS.fields['entry.kind']='COMMAND',(d:any)=>d.RUN_TESTS.fields['tests.paths']='../escape',(d:any)=>d.RUN_MAIN={...d.RUN_TESTS,enabled:true},(d:any)=>d.RUN_TESTS.fields['entry.className']='hidden'];
  for(const mutate of cases){const d=draft();mutate(d);assert.throws(()=>buildRuntimeSettingsV2(settings(),d,fields()));}
  assert.throws(()=>buildRuntimeSettingsV2(settings(),draft(),[{...fields()[0],key:'__proto__.polluted'} as any]));assert.equal(({} as any).polluted,undefined);
});
test('SSR status loading/empty/error/unconfirmed same-run retry and mode recovery are explicit, neutral',()=>{
  const props={execution:execution(),language:project().capabilities.language,run:run(),connected:true,canExecute:true,onRun:()=>{},onStop:()=>{},onSettings:()=>{}};
  const html=renderToStaticMarkup(React.createElement(RuntimeStatusV2,props));assert.match(html,/Włącz program w ustawieniach/);assert.match(html,/Profil zadania/);assert.match(html,/Docs: N\/A/);
  const uncertain=renderToStaticMarkup(React.createElement(RuntimeStatusV2,{...props,run:{...run(),status:'PROCESS_STOP_UNCONFIRMED'}}));assert.match(uncertain,/Ponów Stop/);assert.match(uncertain,/nowe uruchomienie zablokowane/);
  const loading=renderToStaticMarkup(React.createElement(RuntimeStatusV2,{...props,execution:null,run:null}));assert.match(loading,/Ładowanie/);
  const failed=renderToStaticMarkup(React.createElement(RuntimeStatusV2,{...props,connected:false,error:'Błąd połączenia'}));assert.match(failed,/role="alert"/);assert.match(failed,/ręczna edycja i draft/);
});
test('SSR dialog uses labels, tests-only descriptor, [] instructions and non-destructive migration UX',()=>{
  const props={open:true,settings:settings(),expectedWorkspaceVersion:1,execution:execution(),connected:true,canSave:true,onSave:async()=>({ok:false as const,message:'conflict'}),onClose:()=>{}};
  const html=renderToStaticMarkup(React.createElement(RuntimeSettingsV2,props));assert.match(html,/role="dialog"/);assert.match(html,/htmlFor|for=/);assert.match(html,/Tylko testy/);assert.match(html,/pustą listę \[\]/);
  const legacy={runProfiles:[{executable:'legacy-not-interpreted'}],privateUnrelated:{value:'retain'}};
  const migration=renderToStaticMarkup(React.createElement(RuntimeSettingsV2,{...props,settings:legacy,migrationDraft:settings()}));assert.match(migration,/LEGACY_RUN_PROFILE_REQUIRES_MIGRATION/);assert.match(migration,/Przygotuj migrację V2/);assert.equal(JSON.stringify(legacy).includes('legacy-not-interpreted'),true);
});
test('GUI components have no runtime family/image/command/executor selection branches',async()=>{
  const {readFile}=await import('node:fs/promises');
  for(const file of ['RuntimeSettingsV2.tsx','RuntimeStatusV2.tsx']){
    const source=await readFile(new URL(`../../src/components/${file}`,import.meta.url),'utf8');
    assert.doesNotMatch(source,/adapterFamily|SPRING_BOOT|java-maven|pylsp|jdt|Docker|imageLock|executable|dockerArgs|\.command\b/);
  }
});
