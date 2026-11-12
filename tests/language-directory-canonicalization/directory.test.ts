import test from 'node:test';
import assert from 'node:assert/strict';
import { lstatSync, mkdirSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, parse } from 'node:path';
import { performance } from 'node:perf_hooks';
import { assertRealDirectory, readRegular } from '../../src/server/language/LanguageProcessJournal';
import { ancestors, deep, directoryKind, fixture, nativeIO } from './fixture';
import { proposedFinalOnly } from './proposed-final-only';

test('actual deep canonical path: original checks root and EVERY ancestor with fresh native calls', t => {
  const path = deep(fixture(t)), r = nativeIO(), ls = r.lstat, rp = r.realpath;
  const stats: string[] = [], canonical: string[] = [];
  r.lstat = p => { stats.push(p); return ls(p); };
  r.realpath = p => { canonical.push(p); return rp(p); };
  assertRealDirectory(path, r);
  assert.deepEqual(stats, ancestors(path)); assert.deepEqual(canonical, ancestors(path));
  assertRealDirectory(parse(path).root, r);
  assert.equal(stats.at(-1), parse(path).root); assert.equal(canonical.at(-1), parse(path).root);
});

test('lexically noncanonical and relative paths reject before IO', () => {
  const r = { lstat: () => { throw Error('unexpected IO'); }, realpath: () => { throw Error('unexpected IO'); } };
  for (const path of ['relative', `${process.cwd()}/.`, `${process.cwd()}//child`])
    assert.throws(() => assertRealDirectory(path, r), /absolute\/canonical/);
});

test('UNIT alias at root, middle ancestor, or final path is rejected by ORIGINAL prefix guards', t => {
  const path = deep(fixture(t)), chain = ancestors(path);
  for (const target of [chain[0], dirname(path), path]) {
    const r = nativeIO(), rp = r.realpath; let hit = false;
    r.realpath = p => { const actual = rp(p); if (p === target) { hit = true; return `${actual}-alias`; } return actual; };
    assert.throws(() => assertRealDirectory(path, r), /canonical alias/); assert.equal(hit, true);
  }
});

test('UNIT root/middle/final type and junction metadata all fail closed before canonical lookup', t => {
  const path = deep(fixture(t)), chain = ancestors(path);
  for (const target of [chain[0], dirname(path), path]) for (const [directory, link] of [[false, false], [true, true]]) {
    const r = nativeIO(), ls = r.lstat, rp = r.realpath; let lookup = false;
    r.lstat = p => { const actual = ls(p); return p === target ? directoryKind(actual, directory, link) : actual; };
    r.realpath = p => { if (p === target) lookup = true; return rp(p); };
    assert.throws(() => assertRealDirectory(path, r), /Unsafe directory\/link/); assert.equal(lookup, false);
  }
});

test('actual symlink at middle/final and actual nondirectory ancestor are rejected', t => {
  const root = fixture(t), target = join(root, 'target'); mkdirSync(target); mkdirSync(join(target, 'child'));
  const link = join(root, 'link'); symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal(lstatSync(link).isSymbolicLink(), true);
  assert.throws(() => assertRealDirectory(link), /Unsafe directory\/link/);
  assert.throws(() => assertRealDirectory(join(link, 'child')), /Unsafe directory\/link/);
  const file = join(root, 'file'); writeFileSync(file, 'x');
  assert.throws(() => assertRealDirectory(join(file, 'child')), /Unsafe directory\/link/);
});

test('actual disappearance between native lstat and native realpath fails closed', t => {
  const root = fixture(t), path = join(root, 'gone'); mkdirSync(path);
  const r = nativeIO(), ls = r.lstat;
  r.lstat = p => { const actual = ls(p); if (p === path) rmSync(path, { recursive: true }); return actual; };
  assert.throws(() => assertRealDirectory(path, r), { code: 'ENOENT' });
});

test('no cached verification authority: later call observes actual new ancestor symlink', t => {
  const root = fixture(t), path = deep(root), middle = join(root, 'middle'), saved = join(root, 'saved');
  assertRealDirectory(path); renameSync(middle, saved);
  symlinkSync(saved, middle, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => assertRealDirectory(path), /Unsafe directory\/link/);
});

test('native filesystem counterexample: transient ancestor alias defeats final-only, ORIGINAL rejects', t => {
  const observations: unknown[] = [];
  for (const [name, guard] of [['original', assertRealDirectory], ['proposed-final-only', proposedFinalOnly]] as const) {
    const root = fixture(t), path = deep(root), middle = join(root, 'middle'), saved = join(root, 'saved');
    const r = nativeIO(), ls = r.lstat, rp = r.realpath, events: unknown[] = []; let swapped = false, restored = false;
    const restore = () => { if (swapped && !restored) { unlinkSync(middle); renameSync(saved, middle); restored = true; events.push({ restore: middle }); } };
    r.lstat = p => {
      const actual = ls(p); events.push({ lstat: p });
      if (p === middle) {
        renameSync(middle, saved); symlinkSync(saved, middle, process.platform === 'win32' ? 'junction' : 'dir');
        swapped = true; events.push({ swapAfterFreshLstat: middle, target: saved });
      }
      // Descendant lstats have actually traversed the new link. Restore just before final realpath.
      if (p === path) restore();
      return actual;
    };
    r.realpath = p => { const actual = rp(p); events.push({ realpath: p, actual }); return actual; };
    let rejection: unknown;
    try { guard(path, r); } catch (error) { rejection = error; } finally { restore(); }
    if (name === 'original') assert.match(String(rejection), /canonical alias/);
    else { assert.equal(rejection, undefined); assert.equal(restored, true); }
    assertRealDirectory(path); // actual tree restored; no leaked symlink or stale IO answer
    observations.push({ name, outcome: rejection ? 'REJECT' : 'ACCEPT', events });
  }
  console.log('NATIVE_SCHEDULED_COUNTEREXAMPLE ' + JSON.stringify({ platform: process.platform,
    scope: 'actual native primitives, UNIT deterministic mutation scheduling; no native Windows claim', observations }));
});

test('persistent ancestor alias introduced during actual file read still rejects and closes FD', t => {
  const root = fixture(t), parent = join(root, 'parent'), saved = join(root, 'saved'); mkdirSync(parent);
  const path = join(parent, 'file'); writeFileSync(path, 'abc');
  const r = nativeIO(), read = r.read, close = r.close; let swapped = false, closed = 0;
  r.read = (fd, b, o, l, p) => {
    const bytes = read(fd, b, o, l, p);
    if (!swapped) { renameSync(parent, saved); symlinkSync(saved, parent, process.platform === 'win32' ? 'junction' : 'dir'); swapped = true; }
    return bytes;
  };
  r.close = fd => { closed++; close(fd); };
  try { assert.throws(() => readRegular(path, 3, r), /Unsafe directory\/link/); assert.equal(closed, 1); }
  finally { if (swapped) { unlinkSync(parent); renameSync(saved, parent); } }
  assert.equal(readRegular(path, 3).toString(), 'abc');
});

test('bounded identical-workload primitive observation, not a performance acceptance threshold', t => {
  const path = deep(fixture(t)), iterations = 100, report: unknown[] = [];
  for (const [name, guard] of [['original-retained', assertRealDirectory], ['rejected-hypothesis', proposedFinalOnly]] as const) {
    const r = nativeIO(), ls = r.lstat, rp = r.realpath;
    let lstat = 0, realpath = 0, lstatMs = 0, realpathMs = 0;
    r.lstat = p => { const at = performance.now(); try { lstat++; return ls(p); } finally { lstatMs += performance.now() - at; } };
    r.realpath = p => { const at = performance.now(); try { realpath++; return rp(p); } finally { realpathMs += performance.now() - at; } };
    const at = performance.now(); for (let n = 0; n < iterations; n++) guard(path, r); const ms = performance.now() - at;
    assert.equal(lstat, ancestors(path).length * iterations);
    assert.equal(realpath, (name === 'original-retained' ? ancestors(path).length : 1) * iterations);
    report.push({ name, path, iterations, ms, lstat, realpath, perCall: { lstat: lstat / iterations, realpath: realpath / iterations }, primitiveMs: { lstat: lstatMs, realpath: realpathMs } });
  }
  console.log('BOUNDED_PRIMITIVE_OBSERVATION ' + JSON.stringify({ platform: process.platform, report,
    status: 'OBSERVATION_ONLY; rejected hypothesis is not a product performance PASS; no factory/import/RSS claim' }));
});
