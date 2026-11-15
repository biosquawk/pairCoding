import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {allowedSource,requiredFiles} from '../../scripts/verify-source-revision.mjs';

test('Sprint shipped authored resources have a finite source closure; private books and state stay excluded',()=>{
 const base='learning-packs/rest-spring/';
 for(const name of ['curriculum.json','knowledge-index.json','material.md',
  'tasks/get-item/challenge.md','tasks/get-item/settings.v2.json','tasks/get-item/pom.xml',
  'tasks/get-item/src/main/java/demo/ApiApplication.java','tasks/get-item/src/test/java/demo/ApiContractTest.java',
  'references/get-item/ApiApplication.java']) {
  assert(allowedSource(base+name),name);assert(requiredFiles.includes(base+name),name);
  assert(fs.existsSync(new URL('../../'+base+name,import.meta.url)),name);
 }
 assert(requiredFiles.includes('characters/banc-mentor/AGENTS.md'));
 assert(requiredFiles.includes('scripts/verify-learning-pack.mjs'));
 for(const name of ['user-book.pdf','user-book.md','tasks/get-item/.paircoach/settings.json',
  'tasks/get-item/.pairCoding/state.json','tasks/get-item/target/stale.xml','tasks/get-item/.env',
  'tasks/get-item/my-solution.java','references/private/token.key'])assert.equal(allowedSource(base+name),false,name);
 assert.equal(allowedSource('learning-packs/private-book/material.md'),false);
});
