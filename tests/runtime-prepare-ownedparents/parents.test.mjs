/** Source-bound UNIT: actual functions, Win32 path/IO simulation + real native FS.
 * No prepare(), Docker, downloads, or application launch. Simulation is NOT native Windows.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validatePrepareRequest } from '../../scripts/runtime-prepare.mjs';
import { dependencyHash } from '../../scripts/runtime-dependencies.mjs';

const repo = fileURLToPath(new URL('../../', import.meta.url));
// Override only permits running the SAME regression against an immutable baseline source.
const sourceFile = process.env.PAIRCOACH_OWNEDPARENTS_SOURCE ?? path.join(repo, 'scripts/runtime-prepare.mjs');
const source = fs.readFileSync(sourceFile, 'utf8');
function between(text, start, end) {
  assert.equal(text.split(start).length, 2, 'one actual source function');
  const from = text.indexOf(start), to = text.indexOf(end, from);
  assert.ok(to > from, 'source boundary exists');
  return text.slice(from, to);
}
const ownedSource = between(source, 'function ownedParents(', '\nfunction inventory(');
const filesSource = fs.readFileSync(path.join(repo, 'scripts/runtime-files.mjs'), 'utf8');
const canonicalSource = between(filesSource, 'export function canonicalDirectory(', '\nexport function syncDirectory(').replace(/^export /, '');
function bind(paths, io) {
  // Compile exact production function bodies; only native path and filesystem dependencies vary.
  return new Function('path', 'fs', 'mkdirSync', `${canonicalSource}\n${ownedSource}\nreturn ownedParents;`)(paths, io, io.mkdirSync);
}
const error = code => Object.assign(new Error(code), { code });
function windows() {
  const p = path.win32, root = 'C:\\owned', nodes = new Map([[root, { type: 'directory' }]]), calls = [], checked = [];
  const io = {
    mkdirSync(child, options) {
      calls.push(child);
      assert.deepEqual(options, { mode: 0o700 }, 'nonrecursive, private component creation');
      if (nodes.has(child)) throw error('EEXIST');
      const parent = nodes.get(p.dirname(child));
      if (!parent) throw error('ENOENT');
      if (parent.type !== 'directory') throw error('ENOTDIR');
      nodes.set(child, { type: 'directory' });
    },
    lstatSync(child, options) {
      checked.push(child); assert.deepEqual(options, { bigint: true });
      const n = nodes.get(child); if (!n) throw error('ENOENT');
      return { isDirectory: () => n.type === 'directory' || n.type === 'junction', isSymbolicLink: () => ['symlink', 'junction'].includes(n.type) };
    },
    realpathSync: { native(child) { return nodes.get(child)?.canonical ?? child; } },
  };
  return { p, root, nodes, calls, checked, io, run: bind(p, io) };
}
function native(t) {
  const root = fs.mkdtempSync(path.join(process.env.TMPDIR ?? path.dirname(repo), 'ownedparents-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, run: bind(path, fs) };
}

test('Win32 manifest regression: every POSIX parent is created before its child', () => {
  const w = windows();
  // Same input expression as actual manifest caller; win32.dirname preserves POSIX slashes.
  const relative = w.p.dirname('node_modules/fast-xml-parser/src/fxp.js');
  assert.equal(relative, 'node_modules/fast-xml-parser/src');
  assert.equal(w.run(w.root, relative), w.p.join(w.root, 'node_modules', 'fast-xml-parser', 'src'));
  assert.deepEqual(w.calls, ['node_modules', 'node_modules/fast-xml-parser', relative].map(s => w.p.join(w.root, s)));
  for (const created of w.calls) assert.ok(w.checked.includes(created), 'actual canonicalDirectory checks each component');
});

test('Win32 native cache-relative backslashes retain native joining', () => {
  const w = windows(), relative = w.p.relative(w.root, w.p.join(w.root, 'cache', 'java-maven', 'hash'));
  assert.equal(relative, 'cache\\java-maven\\hash');
  assert.equal(w.run(w.root, relative), w.p.join(w.root, relative));
  assert.equal(w.calls.length, 3);
});

test('Win32 EEXIST only reuses canonically checked directories', () => {
  const w = windows(), first = w.p.join(w.root, 'node_modules');
  w.nodes.set(first, { type: 'directory' });
  assert.equal(w.run(w.root, 'node_modules/fast-xml-parser/src'), w.p.join(first, 'fast-xml-parser', 'src'));
  assert.deepEqual(w.calls, [first, w.p.join(first, 'fast-xml-parser'), w.p.join(first, 'fast-xml-parser', 'src')]);
});

for (const relative of ['..', '../escape', 'safe/../escape', '..\\escape', 'safe\\..\\escape', 'safe/..\\escape', 'safe\\../escape']) {
  test(`Win32 traversal refused without normalization: ${relative}`, () => {
    const w = windows();
    assert.throws(() => w.run(w.root, relative), /Unsafe owned directory/);
    assert.ok(w.calls.every(s => s === w.p.join(w.root, 'safe')), 'never writes escaped or collapsed target');
    assert.equal(w.nodes.has('C:\\escape'), false);
  });
}
for (const type of ['file', 'symlink', 'junction', 'fifo']) {
  test(`Win32 EEXIST ${type} obstruction fails closed`, () => {
    const w = windows(), obstacle = w.p.join(w.root, 'node_modules');
    w.nodes.set(obstacle, { type });
    assert.throws(() => w.run(w.root, 'node_modules/fast-xml-parser/src'), /Unsafe prepare directory ancestry/);
    assert.deepEqual(w.calls, [obstacle], 'no descendant mkdir');
  });
}

test('Win32 canonical alias/escape fails before descendants', () => {
  const w = windows(), obstacle = w.p.join(w.root, 'node_modules');
  w.nodes.set(obstacle, { type: 'directory', canonical: 'C:\\foreign' });
  assert.throws(() => w.run(w.root, 'node_modules/fast-xml-parser/src'), /Unsafe prepare directory ancestry/);
  assert.deepEqual(w.calls, [obstacle]);
});

test('Win32 unsafe root is refused before any mkdir', () => {
  const w = windows(); w.nodes.set(w.root, { type: 'junction' });
  assert.throws(() => w.run(w.root, 'node_modules/src'), /Unsafe prepare directory ancestry/);
  assert.deepEqual(w.calls, []);
});

for (const code of ['EACCES', 'EPERM', 'EIO', 'ENOENT']) {
  test(`non-EEXIST mkdir ${code} propagates unchanged`, () => {
    const w = windows(), failure = error(code);
    w.io.mkdirSync = () => { throw failure; };
    assert.throws(() => bind(w.p, w.io)(w.root, 'node_modules/src'), e => e === failure);
  });
}

test('root-only dot retains canonical root without mkdir on Win32 and native FS', t => {
  const w = windows(); assert.equal(w.run(w.root, '.'), w.root); assert.deepEqual(w.calls, []);
  const n = native(t); assert.equal(n.run(n.root, '.'), n.root); assert.deepEqual(fs.readdirSync(n.root), []);
});

test('native FS creates POSIX manifest parents, safely reuses directories, and allows file copy', t => {
  const n = native(t), relative = path.dirname('node_modules/fast-xml-parser/src/fxp.js');
  const leaf = n.run(n.root, relative);
  assert.equal(leaf, path.join(n.root, 'node_modules', 'fast-xml-parser', 'src'));
  assert.equal(n.run(n.root, relative), leaf);
  for (const dir of ['node_modules', 'node_modules/fast-xml-parser', relative]) {
    const st = fs.lstatSync(path.join(n.root, dir)); assert.ok(st.isDirectory()); assert.equal(st.isSymbolicLink(), false);
    if (process.platform !== 'win32') assert.equal(st.mode & 0o777, 0o700);
  }
  fs.writeFileSync(path.join(leaf, 'fxp.js'), 'fixture');
  assert.equal(fs.readFileSync(path.join(leaf, 'fxp.js'), 'utf8'), 'fixture');
});

test('native FS rejects file obstruction and slash traversal', t => {
  const n = native(t); fs.writeFileSync(path.join(n.root, 'blocked'), 'retain');
  assert.throws(() => n.run(n.root, 'blocked/child'), /Unsafe prepare directory ancestry/);
  assert.equal(fs.readFileSync(path.join(n.root, 'blocked'), 'utf8'), 'retain');
  assert.throws(() => n.run(n.root, 'safe/../escape'), /Unsafe owned directory/);
  assert.equal(fs.existsSync(path.join(n.root, 'escape')), false);
});

test('native FS rejects directory symlink/junction and unsafe root alias', t => {
  const n = native(t), target = path.join(n.root, 'target'), alias = path.join(n.root, 'alias');
  fs.mkdirSync(target); fs.symlinkSync(target, alias, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => n.run(n.root, 'alias/child'), /Unsafe prepare directory ancestry/);
  assert.throws(() => n.run(alias, 'child'), /Unsafe prepare directory ancestry/);
  assert.deepEqual(fs.readdirSync(target), []);
});

test('actual inventory validation still rejects backslashes, mixed traversal, absolute/secret/empty components', () => {
  const h = 'a'.repeat(64), files = [{ path: 'main.js', sha256: h }];
  const r = { schemaVersion: 1, workingDirectory: '.', installationId: 'fixture', family: 'node', key: 'node', imageTag: 'paircoach/runtime-node:fixture',
    baseImage: 'fixture/base@sha256:' + h, nodeImage: 'fixture/node@sha256:' + h,
    tools: { root: path.resolve(repo, 'tools-fixture'), files: [{ path: 'node_modules/fast-xml-parser/src/fxp.js', sha256: h }] },
    project: { root: path.resolve(repo, 'project-fixture'), files }, expectedTools: [{ name: 'node', version: 'fixture' }],
    dependencySha256: dependencyHash(files), outputRoot: path.resolve(repo, 'output-fixture') };
  assert.equal(validatePrepareRequest(r), r);
  for (const unsafe of ['../escape', 'safe/../escape', 'safe\\..\\escape', 'safe/..\\escape', 'node_modules\\fxp\\src', '/absolute', 'a//b', 'a/./b', '.env', '.ssh/key']) {
    const bad = structuredClone(r); bad.tools.files[0].path = unsafe;
    assert.throws(() => validatePrepareRequest(bad), /unsafe inventory path/, unsafe);
  }
});
