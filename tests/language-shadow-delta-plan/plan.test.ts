import test from 'node:test';
import assert from 'node:assert/strict';
import { planLanguageShadowDelta } from '../../src/server/language/LanguageShadowDeltaPlan';
import type { ShadowManifest } from '../../src/server/language/LanguageShadowStore';
import { toWorkspaceUri } from '../../src/language/uriCodec';

const a = 'a'.repeat(64), b = 'b'.repeat(64);
const file = (path: string, sha256 = a, bytes = 1, origin: 'disk' | 'overlay' | 'dependency' = 'disk') =>
  ({ path, sha256, bytes, origin, uri: toWorkspaceUri(path) });
function manifest(files: ShadowManifest['files'] = [], directories: readonly string[] = []): ShadowManifest {
  return { schemaVersion: 1, phase: 'completion', launchId: 'launch', leaseId: 'lease',
    identity: { projectId: 'p', sessionId: 's', profileId: 'r', configurationGeneration: 'c',
      providerGeneration: 'g', shadowGeneration: 'sh', connectionGeneration: 'co', provider: 'jdt',
      imageId: `sha256:${a}`, toolchainSha256: a, dependencyManifestSha256: a, analysisSettingsSha256: a },
    sourceInventorySha256: a, dependencyInventorySha256: a, files, directories, overlays: [] };
}
const emptyPlan = { retainFiles: [], writeFiles: [], removeFiles: [], createDirectories: [], removeDirectories: [] };
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value;
}

test('overlay-only edit retains unchanged dependency bytes, never an authority token', () => {
  const deps = [file('.paircoach-dependencies/junit.jar', a, 99, 'dependency'),
    file('.paircoach-dependencies/other.jar', b, 14, 'dependency')];
  const old = manifest([...deps, file('Main.java')], ['.paircoach-dependencies']);
  const next = manifest([...deps, file('Main.java', b, 2, 'overlay')], ['.paircoach-dependencies']);
  next.leaseId = 'new-lease'; next.identity = { ...next.identity, shadowGeneration: 'new' };
  assert.deepEqual(planLanguageShadowDelta(old, next), { ...emptyPlan,
    retainFiles: deps.map(f => f.path), writeFiles: ['Main.java'] });
  assert.deepEqual(Object.keys(planLanguageShadowDelta(old, next)).sort(), Object.keys(emptyPlan).sort());
});
test('same bytes despite origin, overlay-generation, phase and scope changes still require Store manifest authority', () => {
  const old = manifest([file('Main.java')]);
  const next = manifest([file('Main.java', a, 1, 'overlay')]);
  next.leaseId = 'new'; next.launchId = 'other'; next.phase = 'diagnostics';
  next.identity = { ...next.identity, shadowGeneration: 'new', projectId: 'different' };
  next.sourceInventorySha256 = b;
  assert.deepEqual(planLanguageShadowDelta(old, next), { ...emptyPlan, retainFiles: ['Main.java'] });
});
test('add/remove/edit/inactive source changes; no remove-before-atomic-replace for a same path', () => {
  const old = manifest([file('active'), file('inactive'), file('removed'), file('size-only')]);
  const next = manifest([file('active'), file('inactive', b), file('added'), file('size-only', a, 2)]);
  assert.deepEqual(planLanguageShadowDelta(old, next), { ...emptyPlan, retainFiles: ['active'],
    writeFiles: ['added', 'inactive', 'size-only'], removeFiles: ['removed'] });
});
test('dependency filename never permits changed bytes to be retained', () => {
  assert.deepEqual(planLanguageShadowDelta(manifest([file('.paircoach-dependencies/a.jar')], ['.paircoach-dependencies']),
    manifest([file('.paircoach-dependencies/a.jar', b)], ['.paircoach-dependencies'])),
  { ...emptyPlan, writeFiles: ['.paircoach-dependencies/a.jar'] });
});
test('no-content delta, empty inventories and output immutability', () => {
  assert.deepEqual(planLanguageShadowDelta(manifest(), manifest()), emptyPlan);
  const m = freeze(manifest([file('a')], ['empty']));
  const plan = planLanguageShadowDelta(m, m);
  assert.deepEqual(plan, { ...emptyPlan, retainFiles: ['a'] });
  assert.ok(Object.isFrozen(plan)); Object.values(plan).forEach(list => assert.ok(Object.isFrozen(list)));
  assert.throws(() => (plan.writeFiles as string[]).push('tamper'));
});
test('empty directories, parent-first creates/deepest-first removes and lexical depth ties', () => {
  const old = manifest([], ['old', 'old/z', 'old/z/deep', 'old/a', 'same']);
  const next = manifest([], ['new/z/deep', 'new/z', 'new/a', 'same', 'new']);
  assert.deepEqual(planLanguageShadowDelta(old, next), { ...emptyPlan,
    createDirectories: ['new', 'new/a', 'new/z', 'new/z/deep'],
    removeDirectories: ['old/z/deep', 'old/a', 'old/z', 'old'] });
  assert.ok(!planLanguageShadowDelta(old, next).removeDirectories.includes(''));
});
test('file to directory and directory to file transitions are explicit, children not lost', () => {
  const old = manifest([file('x'), file('y/child')], ['y', 'y/empty']);
  const next = manifest([file('x/child'), file('y')], ['x', 'x/empty']);
  assert.deepEqual(planLanguageShadowDelta(old, next), { ...emptyPlan,
    writeFiles: ['x/child', 'y'], removeFiles: ['x', 'y/child'],
    createDirectories: ['x', 'x/empty'], removeDirectories: ['y/empty', 'y'] });
});
test('permutations are deterministic and inputs unchanged, including Unicode spellings', () => {
  const old = freeze(manifest([file('ż space/😀'), file('a'), file('z')], ['ż space', 'empty']));
  const next = freeze(manifest([file('ż space/😀'), file('new'), file('a', b)], ['empty', 'ż space']));
  const before = JSON.stringify([old, next]);
  const expected = planLanguageShadowDelta(old, next);
  for (let i = 0; i < 6; i++) {
    const rotate = <T>(v: readonly T[]) => [...v.slice(i % (v.length || 1)), ...v.slice(0, i % (v.length || 1))];
    assert.deepEqual(planLanguageShadowDelta({ ...old, files: rotate(old.files), directories: rotate(old.directories) },
      { ...next, files: rotate(next.files), directories: rotate(next.directories) }), expected);
  }
  assert.equal(JSON.stringify([old, next]), before);
});

for (const path of ['', '/', '../x', 'a/../x', './x', 'a//x', 'a/', 'a\\b', 'C:x', 'a. ',
  'a\u0000b', 'x/CON', 'clock$', 'com¹.txt', 'a*', 'a?', 'a<', 'a|', 'a"', '\ud800', 'a'.repeat(241),
  Array(6).fill('x'.repeat(200)).join('/')]) {
  test(`reject unsafe path ${JSON.stringify(path)}`, () => {
    const invalid = manifest([{ path, bytes: 1, sha256: a, uri: '', origin: 'disk' }]);
    assert.throws(() => planLanguageShadowDelta(invalid, manifest()));
    assert.throws(() => planLanguageShadowDelta(manifest(), invalid));
    assert.throws(() => planLanguageShadowDelta(manifest(), manifest([], [path])));
  });
}
for (const bytes of [-1, 1.2, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
  test(`reject malformed size ${bytes}`, () => assert.throws(() =>
    planLanguageShadowDelta(manifest([file('x', a, bytes)]), manifest())));
}
for (const sha of ['', 'a'.repeat(63), 'G'.repeat(64), 'A'.repeat(64), `${a}x`]) {
  test(`reject malformed hash ${sha.slice(0, 8)}/${sha.length}`, () => assert.throws(() =>
    planLanguageShadowDelta(manifest(), manifest([file('x', sha)]))));
}
test('reject duplicate and target case/NFC collisions, including file/directory and parent aliases', () => {
  const invalid = [manifest([file('x'), file('x')]), manifest([file('x'), file('X')]),
    manifest([file('é'), file('e\u0301')]), manifest([file('x')], ['x']), manifest([], ['x', 'x']),
    manifest([], ['x', 'X']), manifest([file('x/a')], ['X']), manifest([file('x/a')]),
    manifest([file('x'), file('x/a')])];
  for (const m of invalid) {
    assert.throws(() => planLanguageShadowDelta(m, manifest()));
    assert.throws(() => planLanguageShadowDelta(manifest(), m));
  }
  assert.throws(() => planLanguageShadowDelta(manifest([file('x')]), manifest([file('X')])));
  assert.throws(() => planLanguageShadowDelta(manifest([], ['é']), manifest([], ['e\u0301'])));
});
test('16000 total entries allowed; 16001 and malformed array containers refused', () => {
  const dirs = Array.from({ length: 16000 }, (_, i) => `d${i}`);
  assert.equal(planLanguageShadowDelta(manifest(), manifest([], dirs)).createDirectories.length, 16000);
  assert.throws(() => planLanguageShadowDelta(manifest(), manifest([file('extra')], dirs)));
  const malformed = [{ files: null, directories: [] }, { files: [], directories: {} }, null];
  for (const m of malformed) assert.throws(() => planLanguageShadowDelta(m as unknown as ShadowManifest, manifest()));
});
