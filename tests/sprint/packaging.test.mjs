import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {allowedSource,requiredFiles} from '../../scripts/verify-source-revision.mjs';

test('Sprint shipped authored resources have a finite source closure; private books and state stay excluded',()=>{
 const base='learning-packs/rest-spring/';
 const ids=['get-item','create-item','update-item','map-dto','validate-input','missing-item','name-conflict','cors-preflight','filter-items','page-items','idempotent-create','conditional-delete'];
 const curriculum=JSON.parse(fs.readFileSync(new URL('../../'+base+'curriculum.json',import.meta.url),'utf8'));
 assert.deepEqual(curriculum.tasks.map(t=>t.id).sort(),[...ids].sort());
 assert.equal(new Set(curriculum.tasks.map(t=>t.topicId)).size,5);
 for(const name of ['curriculum.json','knowledge-index.json','material.md',...ids.flatMap(id=>[
  ...['challenge.md','settings.v2.json','pom.xml','src/main/java/demo/ApiApplication.java','src/test/java/demo/ApiContractTest.java'].map(file=>'tasks/'+id+'/'+file),
  'references/'+id+'/ApiApplication.java'])]) {
  assert(allowedSource(base+name),name);assert(requiredFiles.includes(base+name),name);
  assert(fs.existsSync(new URL('../../'+base+name,import.meta.url)),name);
 }
 for(const file of ['characters/banc-mentor/AGENTS.md','characters/banc-mentor/skills/lesson-feedback/SKILL.md']) {
  assert(requiredFiles.includes(file));assert(allowedSource(file));assert(fs.existsSync(new URL('../../'+file,import.meta.url)));
 }
 assert(requiredFiles.includes('scripts/verify-learning-pack.mjs'));
 for(const name of ['user-book.pdf','user-book.md','tasks/get-item/.paircoach/settings.json',
  'tasks/get-item/.pairCoding/state.json','tasks/get-item/target/stale.xml','tasks/get-item/.env',
  'tasks/get-item/my-solution.java','references/private/token.key'])assert.equal(allowedSource(base+name),false,name);
 assert.equal(allowedSource('learning-packs/private-book/material.md'),false);
});
