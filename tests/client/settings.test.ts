import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseContextPatterns, parseRunProfiles } from '../../src/services/settingsValidation';
const profile = { kind: 'RUN_MAIN', executable: 'node', args: ['main.js'], cwd: '.', timeoutMs: 1000, testReportFormat: 'NONE', testReportGlob: null };
test('structured profiles preserve separate executable/args and explicit no-profile choice', () => {
  assert.deepEqual(parseRunProfiles(JSON.stringify([profile])), [profile]); assert.deepEqual(parseRunProfiles('[]'), []);
  assert.deepEqual(parseContextPatterns('["**/*.ts","**/*.md"]'), ['**/*.ts', '**/*.md']); assert.deepEqual(parseContextPatterns('[]'), []);
});
test('settings validation rejects malformed/shell-string profiles, duplicates, bad timeouts and report formats', () => {
  for (const value of ['bad json', 'null', '{}', '["node main.js"]', JSON.stringify([{ ...profile, args: 'main.js' }]), JSON.stringify([{ ...profile, timeoutMs: true }]), JSON.stringify([{ ...profile, timeoutMs: 999 }]), JSON.stringify([{ ...profile, timeoutMs: 300001 }]), JSON.stringify([{ ...profile, testReportFormat: 'JUNIT_XML' }]), JSON.stringify([profile, profile]), JSON.stringify([{ ...profile, shell: true }])]) assert.throws(() => parseRunProfiles(value));
  for (const value of ['null', '[1]', '[""]', '"**/*.ts"', '[', JSON.stringify(Array(101).fill('*.ts'))]) assert.throws(() => parseContextPatterns(value));
});
