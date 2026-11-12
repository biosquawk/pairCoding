/** Deliberately FAILING one-shot proposal, not a passing test or supported JSON key.
 * Run separately only to record absence; final test discovery uses *.test.ts.
 * The justified result is a negative investigation, NOT a product fix. */
import assert from 'node:assert/strict';
import {buildLanguageProviderConfiguration as build} from '../../src/server/language/LanguageProviderConfiguration';
import {profile,cache} from './fixture';
const disabled=profile(), enabled=profile(); enabled.analysis.preview=true;
assert.notEqual(build(disabled,cache()).analysisSettingsSha256,build(enabled,cache()).analysisSettingsSha256,
  'MISSING CONTRACT: distinct requested preview policies are not represented in configuration/hash (not evidence JDT repair exists)');
