import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
// Import the real module too: extraction below tests the exact production guard,
// not a copied algorithm; no execute/plan/Docker operation is invoked.
await import('../../scripts/runtime-operator-remainder.mjs');
const source = fs.readFileSync(new URL('../../scripts/runtime-operator-remainder.mjs', import.meta.url), 'utf8');
const expression = source.match(/check\((values\.length[^\n]+), 'Reused image identity\/manifest changed'\);/);
assert.ok(expression, 'exact image guard located');
const guard = new Function('values', 'reused', 'equal', 'isDeepStrictEqual', 'return ' + expression[1]);
const exactBytes = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const fixture = JSON.parse(fs.readFileSync(new URL('./captured-r2-image.json', import.meta.url), 'utf8'));
const copy = () => structuredClone(fixture);
const accepted = ({ values, reused }) => guard(values, reused, exactBytes, isDeepStrictEqual);
const reverseKeys = value => Array.isArray(value) ? value.map(reverseKeys)
  : value !== null && typeof value === 'object' ? Object.fromEntries(Object.entries(value).reverse().map(([k, v]) => [k, reverseKeys(v)])) : value;

test('captured actual r2 receipt: reordered JSON objects are the same image', () => {
  const { values, reused } = copy();
  const projection = { Id: values[0].Id, Descriptor: values[0].Descriptor, RepoDigests: values[0].RepoDigests };
  assert.equal(exactBytes(projection, reused.observedImage), false, 'preserve original false-negative evidence');
  assert.equal(isDeepStrictEqual(projection, reused.observedImage), true);
  assert.equal(accepted({ values, reused }), true);
});
test('recursive order-insensitivity is not a one-off top-level key rearrangement', () => {
  const data = copy();
  data.values[0].Descriptor.annotations = { first: { one: 1, two: null }, second: { yes: true, list: [{ a: 1, b: 2 }] } };
  data.reused.observedImage.Descriptor.annotations = reverseKeys(data.values[0].Descriptor.annotations);
  data.reused.observedImage = reverseKeys(data.reused.observedImage);
  assert.equal(accepted(data), true);
});
test('same ordered image remains accepted', () => {
  const data = copy();
  data.reused.observedImage = { Id: data.values[0].Id, Descriptor: data.values[0].Descriptor, RepoDigests: data.values[0].RepoDigests };
  assert.equal(accepted(data), true);
});
const negatives = [
  ['actual image Id changed', d => { d.values[0].Id = 'sha256:' + 'a'.repeat(64); }],
  ['saved image Id changed', d => { d.reused.observedImage.Id = 'sha256:' + 'b'.repeat(64); }],
  ['expected image Id changed', d => { d.reused.imageId = 'sha256:' + 'c'.repeat(64); }],
  ['descriptor digest changed', d => { d.values[0].Descriptor.digest = 'sha256:' + 'd'.repeat(64); }],
  ['descriptor size changed', d => { d.values[0].Descriptor.size++; }],
  ['descriptor size type changed', d => { d.values[0].Descriptor.size = String(d.values[0].Descriptor.size); }],
  ['descriptor mediaType changed', d => { d.values[0].Descriptor.mediaType = 'application/vnd.oci.image.manifest.v1+json'; }],
  ['descriptor missing', d => { delete d.values[0].Descriptor; }],
  ['descriptor null', d => { d.values[0].Descriptor = null; }],
  ['descriptor field missing', d => { delete d.values[0].Descriptor.size; }],
  ['saved descriptor field missing', d => { delete d.reused.observedImage.Descriptor.size; }],
  ['extra descriptor field', d => { d.values[0].Descriptor.extra = null; }],
  ['extra saved projection field', d => { d.reused.observedImage.extra = null; }],
  ['missing is not null', d => { d.reused.observedImage.Descriptor.extra = null; }],
  ['RepoDigests value changed', d => { d.values[0].RepoDigests[0] += 'x'; }],
  ['RepoDigests order changed', d => {
    const a = d.values[0].RepoDigests[0], b = 'other@sha256:' + 'e'.repeat(64);
    d.values[0].RepoDigests = [a, b]; d.reused.observedImage.RepoDigests = [b, a];
  }],
  ['nested array order changed', d => {
    d.values[0].Descriptor.extra = [{ first: 1 }, { second: 2 }];
    d.reused.observedImage.Descriptor.extra = [{ second: 2 }, { first: 1 }];
  }],
  ['array is not object', d => { d.values[0].RepoDigests = { 0: d.values[0].RepoDigests[0] }; }],
  ['non-root user changed', d => { d.values[0].Config.User = '0:0'; }],
  ['missing user', d => { delete d.values[0].Config.User; }],
  ['unexpected entrypoint', d => { d.values[0].Config.Entrypoint = ['/bin/sh']; }],
  ['duplicate image inspect entries', d => { d.values.push(structuredClone(d.values[0])); }],
  ['no image inspect entries', d => { d.values = []; }],
];
for (const [name, mutate] of negatives) test('reject ' + name, () => { const data = copy(); mutate(data); assert.equal(accepted(data), false); });
