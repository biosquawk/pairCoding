import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import { performance } from 'node:perf_hooks';
import { fixture, code } from '../snapshots/helpers';
import type { WorkspaceService, ExternalSync } from '../../src/server/WorkspaceService';

type Internals = {
  watchScan(): void;
  collectSteps(): Generator<void, { files: string[]; dirs: string[] }, void>;
  backgroundScan: object | null;
  poll: ReturnType<typeof setInterval>;
  scanTimer: ReturnType<typeof setTimeout> | null;
  watchers: Map<string, fs.FSWatcher>;
};
const internal = (w: WorkspaceService) => w as unknown as Internals;
const turn = () => new Promise<void>(resolve => setImmediate(resolve));
async function until(predicate: () => boolean) {
  const end = performance.now() + 5000;
  while (!predicate() && performance.now() < end) await turn();
  assert.ok(predicate(), 'production background scan did not converge');
}
function observe(w: WorkspaceService) {
  const errors: string[] = [], external: ExternalSync[] = [];
  w.on('watcherError', e => errors.push(e.code));
  w.on('external', e => external.push(e));
  return { errors, external };
}
function openedPaths(t: TestContext) {
  const opened: string[] = [], original = fs.openSync;
  t.mock.method(fs, 'openSync', (...args: Parameters<typeof fs.openSync>) => {
    opened.push(String(args[0])); return original(...args);
  });
  syncBuiltinESMExports();
  return opened;
}
const entries = (w: WorkspaceService) => w.listFiles().map(e => `${e.kind}:${e.path}`).sort();
// Guard/interleaving controls use the real scan and filesystem, controlling only scheduling.
function quiet(w: WorkspaceService) {
  const i = internal(w);
  clearInterval(i.poll);
  if (i.scanTimer) clearTimeout(i.scanTimer);
  i.scanTimer = null;
  for (const watcher of i.watchers.values()) watcher.close();
  i.watchers.clear();
}
async function scan(w: WorkspaceService) {
  internal(w).watchScan();
  await until(() => !internal(w).backgroundScan);
}

test('natural watcher/poll converges deep directory→file, deletes old descendants once and keeps tail progress', async t => {
  const f = fixture(t, { 'outer/inner/deep/a.ts': 'OLD A', 'outer/inner/b.ts': 'OLD B', 'z.ts': 'BASE' });
  const obs = observe(f.workspace);
  fs.rmSync(f.file('outer/inner'), { recursive: true });
  fs.writeFileSync(f.file('outer/inner'), 'NEW REGULAR');
  fs.writeFileSync(f.file('z.ts'), 'NEW TAIL');
  const expected = ['DIRECTORY:outer', 'FILE:outer/inner', 'FILE:z.ts'];
  await until(() => JSON.stringify(entries(f.workspace)) === JSON.stringify(expected) && !internal(f.workspace).backgroundScan);
  assert.equal(f.workspace.getDocument('z.ts').content, 'NEW TAIL');
  assert.deepEqual(obs.errors, []);
  assert.deepEqual(obs.external.filter(e => e.operation === 'DELETED').map(e => e.path).sort(),
    ['outer/inner/b.ts', 'outer/inner/deep/a.ts']);
  assert.equal(f.bytes('outer/inner').toString(), 'NEW REGULAR');
  // Public direct reads still reject blocked parents; this is not a new path bypass.
  assert.throws(() => f.workspace.getDocument('outer/inner/b.ts'), code('UNSAFE_PATH'));
  const version = f.workspace.workspaceVersion;
  f.workspace.scanExternal();
  assert.deepEqual(entries(f.workspace), expected);
  assert.equal(f.workspace.workspaceVersion, version, 'explicit sync scan must not replay topology events');
});

test('natural watcher/poll converges file→directory without a phantom file entry', async t => {
  const f = fixture(t, { 'nested.ts': 'OLD FILE', 'z.ts': 'BASE' }), obs = observe(f.workspace);
  fs.unlinkSync(f.file('nested.ts'));
  fs.mkdirSync(f.file('nested.ts'));
  fs.writeFileSync(f.file('nested.ts/child.ts'), 'NEW CHILD');
  const expected = ['DIRECTORY:nested.ts', 'FILE:nested.ts/child.ts', 'FILE:z.ts'];
  await until(() => JSON.stringify(entries(f.workspace)) === JSON.stringify(expected) && !internal(f.workspace).backgroundScan);
  assert.deepEqual(obs.errors, []);
  assert.equal(obs.external.filter(e => e.path === 'nested.ts' && e.operation === 'DELETED').length, 1);
  assert.throws(() => f.workspace.getDocument('nested.ts'), code('NOT_A_FILE'));
  assert.equal(f.workspace.getDocument('nested.ts/child.ts').content, 'NEW CHILD');
  const version = f.workspace.workspaceVersion;
  f.workspace.scanExternal();
  assert.equal(f.workspace.workspaceVersion, version);
  assert.deepEqual(entries(f.workspace), expected);
});

test('type replacement after collection uses fresh topology and later observes recreated descendants', async t => {
  const f = fixture(t, { 'nested/child.ts': 'OLD CHILD', 'z.ts': 'BASE' }), w = f.workspace;
  quiet(w);
  const i = internal(w), obs = observe(w), collect = i.collectSteps.bind(w);
  let collected = false;
  i.collectSteps = function* () { const result = yield* collect(); collected = true; yield; return result; };
  i.watchScan(); await until(() => collected);
  fs.rmSync(f.file('nested'), { recursive: true }); fs.writeFileSync(f.file('nested'), 'REGULAR');
  await until(() => !i.backgroundScan);
  assert.equal(obs.external.filter(e => e.path === 'nested/child.ts' && e.operation === 'DELETED').length, 1);
  await scan(w);
  assert.deepEqual(entries(w), ['FILE:nested', 'FILE:z.ts']);
  fs.unlinkSync(f.file('nested')); fs.mkdirSync(f.file('nested'));
  fs.writeFileSync(f.file('nested/child.ts'), 'RECREATED');
  await scan(w); await scan(w);
  assert.equal(w.getDocument('nested/child.ts').content, 'RECREATED');
  assert.deepEqual(entries(w), ['DIRECTORY:nested', 'FILE:nested/child.ts', 'FILE:z.ts']);
  assert.deepEqual(obs.errors, []);
});

for (const linkType of ['dir', 'junction'] as const) {
  test(`replaced ancestor ${linkType} link is not deletion evidence and exposes no foreign bytes`, async t => {
    const f = fixture(t, { 'nested/child.ts': 'OLD CHILD', 'z.ts': 'BASE' }), w = f.workspace;
    quiet(w); const obs = observe(w), opened = openedPaths(t);
    const foreign = path.join(f.parent, 'foreign'); fs.mkdirSync(foreign);
    fs.writeFileSync(path.join(foreign, 'child.ts'), 'FOREIGN SECRET');
    fs.rmSync(f.file('nested'), { recursive: true }); fs.symlinkSync(foreign, f.file('nested'), linkType);
    await scan(w); await scan(w);
    assert.deepEqual(obs.errors, ['UNSAFE_PATH', 'UNSAFE_PATH']);
    assert.ok(!obs.external.some(e => e.path === 'nested/child.ts'));
    assert.ok(!JSON.stringify(obs.external).includes('FOREIGN SECRET'));
    assert.throws(() => w.getDocument('nested/child.ts'), code('UNSAFE_PATH'));
    assert.ok(opened.every(p => !p.includes('nested') && !p.includes('foreign')), 'no descriptor may open foreign bytes');
    assert.equal(fs.readFileSync(path.join(foreign, 'child.ts'), 'utf8'), 'FOREIGN SECRET');
    // Repair: a fresh safe ordinary ancestor now proves that the old child disappeared.
    fs.unlinkSync(f.file('nested')); fs.writeFileSync(f.file('nested'), 'SAFE REGULAR');
    await scan(w);
    assert.deepEqual(entries(w), ['FILE:nested', 'FILE:z.ts']);
  });
}

test('hardlinked regular ancestor cannot turn an UNSAFE_PATH into a child deletion', async t => {
  const f = fixture(t, { 'nested/child.ts': 'OLD CHILD', 'z.ts': 'BASE' }), w = f.workspace;
  quiet(w); const obs = observe(w), opened = openedPaths(t), foreign = path.join(f.parent, 'foreign.ts');
  fs.writeFileSync(foreign, 'FOREIGN SECRET');
  fs.rmSync(f.file('nested'), { recursive: true }); fs.linkSync(foreign, f.file('nested'));
  opened.length = 0; // exclude creation of the synthetic foreign fixture itself
  await scan(w); await scan(w);
  assert.deepEqual(obs.errors, ['UNSAFE_PATH', 'UNSAFE_PATH']);
  assert.ok(!obs.external.some(e => e.path === 'nested/child.ts'));
  assert.ok(!JSON.stringify(obs.external).includes('FOREIGN SECRET'));
  assert.throws(() => w.getDocument('nested'), code('UNSAFE_PATH'));
  assert.ok(opened.every(p => !p.includes('nested') && !p.includes('foreign')), 'hardlinked ancestor bytes must not be opened');
  assert.equal(fs.readFileSync(foreign, 'utf8'), 'FOREIGN SECRET');
  fs.unlinkSync(f.file('nested')); fs.writeFileSync(f.file('nested'), 'SAFE REGULAR');
  await scan(w);
  assert.deepEqual(entries(w), ['FILE:nested', 'FILE:z.ts']);
});

test('root replaced by a foreign directory link remains fail-closed, not a mass deletion', async t => {
  const f = fixture(t, { 'nested/child.ts': 'OLD CHILD' }), w = f.workspace;
  quiet(w); const obs = observe(w), opened = openedPaths(t), foreign = path.join(f.parent, 'foreign');
  fs.mkdirSync(foreign); fs.writeFileSync(path.join(foreign, 'secret.ts'), 'FOREIGN ROOT SECRET');
  fs.renameSync(f.root, path.join(f.parent, 'original-root'));
  fs.symlinkSync(foreign, f.root, 'junction');
  opened.length = 0;
  await scan(w); await scan(w);
  assert.deepEqual(obs.errors, ['UNSAFE_PATH', 'UNSAFE_PATH']);
  assert.deepEqual(obs.external, []);
  // Private snapshot ancestry now fences metadata reads as well as source reads.
  assert.throws(() => entries(w), code('RECOVERY_REQUIRED'));
  assert.throws(() => w.getDocument('secret.ts'), code('RECOVERY_REQUIRED'));
  fs.unlinkSync(f.root);fs.renameSync(path.join(f.parent,'original-root'),f.root);
  assert.ok(entries(w).includes('FILE:nested/child.ts'));
  assert.deepEqual(opened, [], 'a replaced root must not produce even one file descriptor');
  assert.equal(fs.readFileSync(path.join(foreign, 'secret.ts'), 'utf8'), 'FOREIGN ROOT SECRET');
});

test('case-aliased ancestor is still PATH_CASE_CONFLICT, never inferred deletion', async t => {
  const f = fixture(t, { 'nested/child.ts': 'OLD CHILD' }), w = f.workspace;
  quiet(w); const obs = observe(w);
  // The two-step rename also performs an actual case change on case-insensitive Windows.
  fs.renameSync(f.file('nested'), f.file('temporary')); fs.renameSync(f.file('temporary'), f.file('Nested'));
  await scan(w);
  assert.deepEqual(obs.errors, ['PATH_CASE_CONFLICT']);
  assert.ok(!obs.external.some(e => e.path === 'nested/child.ts'));
  assert.throws(() => w.getDocument('nested/child.ts'), code('PATH_CASE_CONFLICT'));
  assert.equal(f.bytes('Nested/child.ts').toString(), 'OLD CHILD');
});
