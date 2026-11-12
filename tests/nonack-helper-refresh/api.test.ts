import test from 'node:test';
import assert from 'node:assert/strict';
import { LanguageFeatureRegistry } from '../../src/server/language/LanguageFeatureRegistry';
import {fixture} from './fixture';
test('frozen helper API exists on actual registry and binding, without pre-start authority fabrication',async t=>{
  const f=await fixture(t);
  assert.equal(typeof LanguageFeatureRegistry.prototype.invalidateSource,'function');
  assert.equal(typeof LanguageFeatureRegistry.prototype.refreshSource,'function');
  assert.equal(typeof f.binding.invalidateSource,'function');assert.equal(typeof f.binding.refreshSource,'function');
  assert.equal(f.binding.invalidateSource(),undefined);
  await assert.rejects(f.binding.refreshSource(),/not started/);
  assert.throws(()=>f.binding.view(),/actual language status/);
  assert.equal(f.driver.commands.length,0);assert.equal(f.calls.length,0);assert.equal(f.acquisitions,0);
  await f.binding.retire();f.binding.invalidateSource();await assert.rejects(f.binding.refreshSource(),/retired/);
  assert.equal(f.driver.commands.length,0);assert.equal(f.calls.length,0);
});
