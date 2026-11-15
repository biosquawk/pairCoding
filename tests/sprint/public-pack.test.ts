import test from 'node:test';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {publicServerOptions} from '../../src/server/index';
import {readLearningPack} from '../../src/server/sprint/LearningPack';

test('public startup defaults to REST and explicitly selects the authored Java pack',()=>{
  assert.deepEqual(publicServerOptions({}),{port:8080,learningPackPath:undefined});
  assert.equal(readLearningPack().id,'rest-spring');
  const learningPackPath=fileURLToPath(new URL('../../learning-packs/java-concurrency/',import.meta.url));
  assert.deepEqual(publicServerOptions({PAIRCOACH_HTTP_PORT:'18131',PAIRCOACH_LEARNING_PACK_PATH:learningPackPath}),{port:18131,learningPackPath});
  assert.equal(readLearningPack(learningPackPath).id,'java-concurrency');
});
test('explicit invalid pack never silently starts a REST lesson',()=>{
  assert.throws(()=>publicServerOptions({PAIRCOACH_LEARNING_PACK_PATH:''}));
  assert.throws(()=>publicServerOptions({PAIRCOACH_LEARNING_PACK_PATH:'/missing-concurrency-pack'}));
});
