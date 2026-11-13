import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {loadCharacter,copyCharacter,CHARACTERS_PATH} from '../../src/server/coach/character';
import {DEFAULT_CONFIG_PATH} from '../../src/server/coach/codexConfig';

test('character selection is application-wide; staged native AGENTS/skills are independent copies, not student files',async t=>{
  const base=fs.mkdtempSync(path.join(os.tmpdir(),'paircoach-character-'));t.after(()=>fs.rmSync(base,{recursive:true,force:true}));
  const config=path.join(base,'config.json');fs.writeFileSync(config,JSON.stringify({character:'halloween-theme'}));
  const selected=loadCharacter(config);assert.equal(selected.name,'halloween-theme');
  assert.ok(selected.files.some(file=>file.path===path.join('.agents','skills','lesson-feedback','SKILL.md')));
  const cwd=path.join(base,'private');fs.mkdirSync(cwd);
  await copyCharacter(selected,cwd);
  assert.equal(fs.readFileSync(path.join(cwd,'AGENTS.md'),'utf8'),fs.readFileSync(path.join(CHARACTERS_PATH,'halloween-theme/AGENTS.md'),'utf8'));
  assert.equal(fs.lstatSync(path.join(cwd,'AGENTS.md')).isSymbolicLink(),false);
  const original=fs.readFileSync(path.join(CHARACTERS_PATH,'halloween-theme/AGENTS.md'),'utf8');
  fs.writeFileSync(path.join(cwd,'AGENTS.md'),'private copy changed');
  assert.equal(fs.readFileSync(path.join(CHARACTERS_PATH,'halloween-theme/AGENTS.md'),'utf8'),original);
  await assert.rejects(copyCharacter(selected,cwd),{code:'EEXIST'});
  assert.equal(loadCharacter(DEFAULT_CONFIG_PATH).name,'default');
});

test('character config refuses traversal, missing profiles, symlinks and oversized AGENTS',t=>{
  const base=fs.mkdtempSync(path.join(os.tmpdir(),'paircoach-character-invalid-'));t.after(()=>fs.rmSync(base,{recursive:true,force:true}));
  const config=path.join(base,'config.json'),root=path.join(base,'characters'),profile=path.join(root,'own');fs.mkdirSync(profile,{recursive:true});
  fs.writeFileSync(path.join(profile,'AGENTS.md'),'teacher');
  for(const character of ['../own','/own','own/child','',true]) {
    fs.writeFileSync(config,JSON.stringify({character}));assert.throws(()=>loadCharacter(config,root),/COACH_CHARACTER_INVALID/);
  }
  fs.writeFileSync(config,JSON.stringify({character:'absent'}));assert.throws(()=>loadCharacter(config,root));
  fs.writeFileSync(config,JSON.stringify({character:'own'}));
  fs.writeFileSync(path.join(profile,'AGENTS.md'),'a'.repeat(32769));assert.throws(()=>loadCharacter(config,root),/COACH_CHARACTER_AGENTS_LIMIT/);
  fs.unlinkSync(path.join(profile,'AGENTS.md'));fs.writeFileSync(path.join(base,'foreign.md'),'not a copied profile');fs.symlinkSync(path.join(base,'foreign.md'),path.join(profile,'AGENTS.md'));
  assert.throws(()=>loadCharacter(config,root),/COACH_CHARACTER_UNSAFE/);
});
