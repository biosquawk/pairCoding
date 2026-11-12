/** Pure compatibility vectors; no filesystem, Docker or execution fixture authority. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalJson, sha256 } from '../../src/server/runtimeIdentity';
import { canonicalJson as executionJson, sha256 as executionHash } from '../../src/server/execution/files';

test('execution compatibility exports share the exact neutral functions, not copied implementations', () => {
  assert.equal(executionJson, canonicalJson);
  assert.equal(executionHash, sha256);
});

test('fixed JSON bytes and SHA identity stay stable across insertion order and nested records', () => {
  const expected = '{"a":[true,null,"Zażółć 😀"],"z":1}';
  const digest = 'c4d88707321d5b48af167ff8de78bf4af5841e514ec4297a4e6e2a90cc8fd87b';
  for (const value of [{ z: 1, a: [true, null, 'Zażółć 😀'] }, { a: [true, null, 'Zażółć 😀'], z: 1 }]) {
    assert.equal(canonicalJson(value), expected);
    assert.equal(sha256(canonicalJson(value)), digest);
  }
  assert.equal(canonicalJson({ z: { b: 2, a: 1 }, a: 0 }), '{"a":0,"z":{"a":1,"b":2}}');
});

test('null-prototype and __proto__ keys remain data; native numeric-key ordering is unchanged', () => {
  const value = Object.assign(Object.create(null), JSON.parse('{"z":3,"__proto__":{"b":2,"a":1}}'));
  assert.equal(canonicalJson(value), '{"__proto__":{"a":1,"b":2},"z":3}');
  assert.equal(canonicalJson({ '10': 'ten', '2': 'two', a: -0 }), '{"2":"two","10":"ten","a":0}');
});

test('enumerable getters are read once; ignored symbol/non-enumerable keys and sparse arrays keep prior semantics', () => {
  let calls = 0;
  const value = { get a() { calls++; return 'v'; }, [Symbol('ignored')]: undefined };
  Object.defineProperty(value, 'hidden', { value: undefined });
  assert.equal(canonicalJson(value), '{"a":"v"}'); assert.equal(calls, 1);
  const sparse = new Array(3); sparse[1] = 'middle';
  assert.equal(canonicalJson(sparse), '[null,"middle",null]');
  assert.throws(() => canonicalJson([undefined]), { message: 'Non-JSON value' });
});

test('primitives, escaping and array order retain exact JSON serialization', () => {
  for (const value of [null, true, false, 0, -0, 1e30, '"\\\n\t\u0000', '😀', '\ud800'])
    assert.equal(canonicalJson(value), JSON.stringify(value));
  assert.equal(canonicalJson([2, 1]), '[2,1]');
  assert.notEqual(sha256(canonicalJson([2, 1])), sha256(canonicalJson([1, 2])));
});

for (const [label, value, message] of [
  ['NaN', NaN, 'Nonfinite JSON number'], ['Infinity', Infinity, 'Nonfinite JSON number'],
  ['negative Infinity', -Infinity, 'Nonfinite JSON number'],
  ['undefined', undefined, 'Non-JSON value'], ['function', () => 1, 'Non-JSON value'],
  ['symbol', Symbol('bad'), 'Non-JSON value'], ['bigint', 1n, 'Non-JSON value'],
  ['Date', new Date(0), 'Nonplain JSON data'], ['Map', new Map(), 'Nonplain JSON data'],
  ['Set', new Set(), 'Nonplain JSON data'], ['Buffer', Buffer.from('x'), 'Nonplain JSON data'],
  ['custom prototype', Object.create({ custom: true }), 'Nonplain JSON data'],
] as const) test('reject unchanged: ' + label, () => {
  assert.throws(() => canonicalJson(value), { message });
  assert.throws(() => canonicalJson({ nested: value }), { message });
});

test('depth 64 passes and depth 65/cycles fail with the original structure-limit error', () => {
  const nested = (depth: number) => { let value: unknown = null; while (depth--) value = [value]; return value; };
  assert.equal(canonicalJson(nested(64)), '['.repeat(64) + 'null' + ']'.repeat(64));
  assert.throws(() => canonicalJson(nested(65)), { message: 'JSON structure limit' });
  const cycle: unknown[] = []; cycle.push(cycle);
  assert.throws(() => canonicalJson(cycle), { message: 'JSON structure limit' });
});

test('100000 total visited nodes pass; the next node is rejected with no budget increase', () => {
  const allowed = Array(99999).fill(null);
  assert.equal(canonicalJson(allowed), '[' + Array(99999).fill('null').join(',') + ']');
  assert.throws(() => canonicalJson([...allowed, null]), { message: 'JSON structure limit' });
});

test('SHA256 known vectors preserve UTF8 string and raw Buffer behavior', () => {
  assert.equal(sha256(''), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  assert.equal(sha256('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.equal(sha256(Buffer.from('abc')), sha256('abc'));
  assert.equal(sha256('Zażółć 😀'), sha256(Buffer.from('Zażółć 😀', 'utf8')));
  assert.equal(sha256('\ud800'), sha256('\ufffd'));
  assert.equal(sha256(Buffer.from([0, 255, 128, 1])), '6509423fd9da5c225d2f8619ffae394b40f9f7686fee55a38c54b1424ac65f46');
});
