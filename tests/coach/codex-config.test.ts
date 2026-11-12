import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {loadCodexConfig,DEFAULT_CONFIG_PATH} from '../../src/server/coach/codexConfig';
import {codexCoachArgs} from '../../src/server/coach/CodexProvider';

test('shipped config pins gpt-6.1-sol medium in explicit local CLI arguments',()=>{
  const config=loadCodexConfig(DEFAULT_CONFIG_PATH,{});
  assert.deepEqual(config,{model:'gpt-6.1-sol',reasoning_effort:'medium'});
  assert(Object.isFrozen(config));
  const args=codexCoachArgs('schema.json','instruction',config);
  assert.equal(args[args.indexOf('--model')+1],'gpt-6.1-sol');
  assert(args.includes('model_reasoning_effort="medium"'));
  assert(args.includes('--ignore-user-config'));
  assert(!args.some(a=>/api_key|base_url|--oss/.test(a)));
});

test('config file and environment overrides preserve exact model and effort',t=>{
  const dir=mkdtempSync(path.join(os.tmpdir(),'codex-config-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const file=path.join(dir,'config.json');writeFileSync(file,'\uFEFF'+JSON.stringify({codex:{model:'gpt-6.1-sol',reasoning_effort:'high'}}));
  assert.equal(loadCodexConfig(file,{}).reasoning_effort,'high');
  const c=loadCodexConfig(file,{PAIRCOACH_CODEX_MODEL:'gpt-6.1-sol',PAIRCOACH_CODEX_REASONING_EFFORT:'medium'});
  assert.equal(c.reasoning_effort,'medium');
  assert(codexCoachArgs('schema.json','instruction',c).includes('model_reasoning_effort="medium"'));
});

test('invalid or missing configuration fails explicitly rather than silently switching models',t=>{
  const dir=mkdtempSync(path.join(os.tmpdir(),'codex-config-bad-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const file=path.join(dir,'config.json');
  assert.throws(()=>loadCodexConfig(file,{}),/CODEX_CONFIG_UNREADABLE/);
  assert.throws(()=>loadCodexConfig('relative.json',{}),/ABSOLUTE_PATH_REQUIRED/);
  for(const value of ['{', 'null', '[]','{}',JSON.stringify({codex:[]}),JSON.stringify({codex:{model:'--other-model',reasoning_effort:'medium'}}),JSON.stringify({codex:{model:'gpt-6.1-sol',reasoning_effort:'wrong'}}),JSON.stringify({codex:{model:'gpt-6.1-sol',reasoning_effort:'medium',api_key:'not-supported'}})]){
    writeFileSync(file,value);assert.throws(()=>loadCodexConfig(file,{}),/CODEX_CONFIG_/);
  }
  writeFileSync(file,JSON.stringify({codex:{model:'gpt-6.1-sol',reasoning_effort:'medium'}}));
  assert.throws(()=>loadCodexConfig(file,{PAIRCOACH_CODEX_MODEL:''}),/MODEL_INVALID/);
  assert.throws(()=>loadCodexConfig(file,{PAIRCOACH_CODEX_REASONING_EFFORT:'invalid'}),/REASONING_INVALID/);
});
