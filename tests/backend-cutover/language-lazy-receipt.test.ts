import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from '../runtime-language-binding/fixture';
import {createSelectedCacheLanguageFactory,type SelectedCacheLanguageFactoryOptions} from '../../src/server/language/SelectedCacheLanguageAuthority';

test('LAZY real remote verifier refuses missing/relative selector before any process; caller option mutation cannot supply authority',async t=>{
  const f=await fixture(t);const missing:SelectedCacheLanguageFactoryOptions={...f.options.selected,languageReceiptPath:undefined};
  const selected=createSelectedCacheLanguageFactory(missing);
  missing.languageReceiptPath=f.options.selected.languageReceiptPath;
  await assert.rejects(f.underLease(token=>selected.authority.prepare(f.options.scope,f.snapshot,token)),/Explicit trusted language receipt is required/);
  const invalid=createSelectedCacheLanguageFactory({...f.options.selected,languageReceiptPath:'relative-receipt.json'});
  await assert.rejects(f.underLease(token=>invalid.authority.prepare(f.options.scope,f.snapshot,token)),/explicit verified preparation/);
  assert.equal(f.driver.commands.length,0);assert.equal(f.driver.frames.length,0);
});
