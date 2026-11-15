import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {loadCharacter,copyCharacter,CHARACTERS_PATH} from '../../src/server/coach/character';

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
  fs.writeFileSync(config,JSON.stringify({codex:{model:'gpt-6.1-sol',reasoning_effort:'medium'}}));
  assert.equal(loadCharacter(config).name,'default','omitted character selects default independently of the owner selection');
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


test('Banc Mentor installs its own lesson-feedback through the unchanged native character loader',async t=>{
  const base=fs.mkdtempSync(path.join(os.tmpdir(),'paircoach-banc-character-'));t.after(()=>fs.rmSync(base,{recursive:true,force:true}));
  const config=path.join(base,'config.json');fs.writeFileSync(config,JSON.stringify({character:'banc-mentor'}));
  const selected=loadCharacter(config);assert.equal(selected.name,'banc-mentor');
  const skill=path.join('.agents','skills','lesson-feedback','SKILL.md');
  assert.deepEqual(selected.files.map(f=>f.path).sort(),['AGENTS.md',skill].sort());
  const expected=fs.readFileSync(path.join(CHARACTERS_PATH,'banc-mentor/skills/lesson-feedback/SKILL.md'));
  assert.deepEqual(selected.files.find(f=>f.path===skill)!.content,expected);
  assert.notDeepEqual(expected,fs.readFileSync(path.join(CHARACTERS_PATH,'default/skills/lesson-feedback/SKILL.md')),'Banc has its own skill, not fallback to default');
  const destination=path.join(base,'private');await copyCharacter(selected,destination);
  assert.deepEqual(fs.readFileSync(path.join(destination,skill)),expected);
  assert.equal(fs.lstatSync(path.join(destination,skill)).isSymbolicLink(),false);
  fs.writeFileSync(path.join(destination,skill),'changed private copy');
  assert.deepEqual(fs.readFileSync(path.join(CHARACTERS_PATH,'banc-mentor/skills/lesson-feedback/SKILL.md')),expected);
  await assert.rejects(copyCharacter(selected,destination),{code:'EEXIST'});
});
