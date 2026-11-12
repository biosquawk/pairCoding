import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {selectTests,testArguments} from '../../scripts/runtime-test.mjs';

test('LIGHT selection: exact remote-only directories and file/title pairs; mixed/current language guards remain active; both lanes present',()=>{
  const selection=selectTests();
  for(const file of ['tests/runtime-contract/language.test.ts','tests/backend-cutover/http-language-owner.test.ts','tests/backend-cutover/language-startup-selector.test.ts','tests/editor-language/bridge.test.ts','tests/frontend-cutover/live.test.ts','tests/client-v2/language.test.ts'])assert.ok(selection.active.includes(file),file);
  assert.ok(selection.superseded.some(file=>file.startsWith('tests/language-runtime/')));
  assert.equal(selection.superseded.some(file=>file.startsWith('tests/editor-language/')),false);
  assert.ok(selection.nativeMjs.includes('tests/runtime-prepare-cli/public.test.mjs'));
  assert.ok(selection.tsx.includes('tests/runtime-prepare-cli/prepared-selector.test.mjs'));
  const groups=testArguments(selection),mixed=groups.find(g=>g.args.includes('tests/runtime-prepare-cli/public.test.mjs'));
  assert.equal(mixed.args.includes('--import'),false);
  const pattern=new RegExp(mixed.args[mixed.args.indexOf('--test-skip-pattern')+1]);
  assert.equal(pattern.test('actual default argv reads full V2/non-dot/current raw; deterministic with zero writes, network or children'),false);
  assert.equal(pattern.test('language kinds strict BEFORE any write/run; default BOTH preserved (source), selected-only failure does not enter other kind'),true);
});

test('LIGHT selection runner: same title in ordinary file runs; exact retired pair skips; a real failing active TS/MJS makes exit nonzero',t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'light-selection-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  fs.mkdirSync(path.join(root,'tests/backend-cutover'),{recursive:true});fs.writeFileSync(path.join(root,'package.json'),'{"type":"module"}');
  fs.symlinkSync(fs.realpathSync('node_modules'),path.join(root,'node_modules'),process.platform==='win32'?'junction':'dir');
  const title='HTTP LANG actual retained HELLO owner bootstraps trusted generations; source admission and targeted ordered completion use real binding';
  fs.writeFileSync(path.join(root,'tests/backend-cutover/http-language-owner.test.ts'),`import test from 'node:test';test(${JSON.stringify(title)},()=>{throw Error('RETIRED_EXECUTED')});`);
  fs.writeFileSync(path.join(root,'tests/current.test.ts'),`import test from 'node:test';test(${JSON.stringify(title)},()=>{throw Error('ACTIVE_SAME_TITLE_EXECUTED')});`);
  fs.writeFileSync(path.join(root,'tests/current.test.mjs'),"import test from 'node:test';test('active MJS failure',()=>{throw Error('ACTIVE_MJS_EXECUTED')});");
  // Exact same exported runTests used by npm; worker marker removed for this nested fixture only.
  const env={...process.env};delete env.NODE_TEST_CONTEXT;
  const child=spawnSync(process.execPath,['--input-type=module','-e',`import {runTests} from ${JSON.stringify(new URL('../../scripts/runtime-test.mjs',import.meta.url).href)};process.exitCode=runTests(${JSON.stringify(root)});`],{cwd:root,env,encoding:'utf8'});
  assert.equal(child.status,1,child.stderr);assert.match(child.stdout,/ACTIVE_SAME_TITLE_EXECUTED/);assert.match(child.stdout,/ACTIVE_MJS_EXECUTED/);assert.doesNotMatch(child.stdout,/error: 'RETIRED_EXECUTED'/);
  fs.unlinkSync(path.join(root,'tests/current.test.mjs'));assert.throws(()=>selectTests(root),/No active mjs/);
});
