/** Actual executor/registry + private real FS. Injected Docker transport ONLY, not a Docker/runtime proof. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fixture } from '../runtime-executor/fixtures';
import { createTaskRuntimeAdapterRegistry } from '../../src/server/runtime-adapters';
import type { CollectedArtifacts, ExecutionExit, ExecutionPlan } from '../../src/server/execution/ports';

const passing = '<testsuite tests="1" failures="0" errors="0" skipped="0"><testcase name="fresh"/></testsuite>';
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const registry = createTaskRuntimeAdapterRegistry();
type Context = Awaited<ReturnType<typeof collected>>;
async function collected(xml = passing, code = 0, relative = 'junit.xml') {
  const f = await fixture();
  try {
    const planBefore = structuredClone(f.plan);
    const handle = await f.executor.start(f.plan);
    const live = path.join(f.input.artifactsDirectory, relative);
    await fs.mkdir(path.dirname(live), { recursive: true });
    await fs.writeFile(live, xml);
    f.fake.finish(code);
    const exit = await f.executor.wait(handle);
    const collection = await f.executor.collect(handle, exit);
    assert.deepEqual(f.plan, planBefore, 'start/collect never rewrites caller plan');
    assert.deepEqual(collection.handle, handle);
    assert.equal(collection.inputManifestSha256, f.plan.input.identity.manifestSha256);
    assert.equal(collection.files.length, 1);
    assert.equal(collection.files[0].path, path.join(f.runs, handle.runId, 'collected', 'files', relative));
    assert.equal(await fs.readFile(collection.files[0].path, 'utf8'), xml);
    assert.equal(collection.files[0].sha256, hash(xml));
    assert.equal(collection.files[0].freshForRun, true);
    return { f, exit, collection, live };
  } catch (error) { await f.cleanup(); throw error; }
}
const interpret = (c: Context, plan: ExecutionPlan = c.f.plan, exit: ExecutionExit = c.exit, artifacts: CollectedArtifacts = c.collection) => registry.get(plan.profile).interpret(plan, exit, artifacts);
async function withCollection(fn: (c: Context) => Promise<void>, xml = passing, code = 0, relative = 'junit.xml') {
  const c = await collected(xml, code, relative);
  try { await fn(c); } finally { await c.f.cleanup(); }
}
async function unknown(c: Context, plan = c.f.plan, exit = c.exit, artifacts = c.collection) {
  const result = await interpret(c, plan, exit, artifacts);
  assert.equal(result.testOutcome, 'UNKNOWN');
  assert.equal(result.status, 'FAILED');
  assert.equal(result.testCount, null);
}

test('genuine collect -> registry: fresh JUnit succeeds without path/plan rewrite, same journal collection', () => withCollection(async c => {
  assert.deepEqual(await interpret(c), { status: 'SUCCEEDED', testOutcome: 'PASSED', testCount: 1, skipped: 0, failures: 0, errors: 0, problem: null });
  assert.deepEqual(await c.f.executor.collect(c.exit.handle, c.exit), c.collection, 'same durable collection is reusable');
}));
test('genuine nested Unicode JUnit descendant accepted', () => withCollection(async c => {
  assert.equal((await interpret(c)).testOutcome, 'PASSED');
}, passing, 0, 'nested/zażółć 😀/TEST-fresh.xml'));
test('only durable collection authoritative: replacing live report cannot replace passed evidence', () => withCollection(async c => {
  await fs.writeFile(c.live, '<testsuite><testcase name="late"><failure/></testcase></testsuite>');
  assert.equal((await interpret(c)).testOutcome, 'PASSED');
}));
test('only durable collection authoritative: removing live artifacts cannot remove collected evidence', () => withCollection(async c => {
  await fs.rm(c.live);
  assert.equal((await interpret(c)).testOutcome, 'PASSED');
}));

const pathCases: [string, (c: Context) => string][] = [
  ['live artifacts', c => c.live],
  ['foreign run', c => path.join(c.f.runs, 'run2', 'collected', 'files', 'junit.xml')],
  ['collected sibling', c => path.join(c.f.runs, 'run1', 'collected', 'junit.xml')],
  ['prefix sibling', c => path.join(c.f.runs, 'run1', 'collected', 'files-foreign', 'junit.xml')],
  ['build sibling', c => path.join(c.f.input.buildDirectory, 'junit.xml')],
  ['outside run root', c => path.join(c.f.root, 'outside', 'junit.xml')],
  ['relative', () => 'run1/collected/files/junit.xml'],
  ['noncanonical dot', c => path.dirname(c.collection.files[0].path) + path.sep + '.' + path.sep + 'junit.xml'],
  ['noncanonical traversal', c => path.dirname(c.collection.files[0].path) + path.sep + 'nested' + path.sep + '..' + path.sep + 'junit.xml'],
];
for (const [name, location] of pathCases) test('reject collection path: ' + name, () => withCollection(async c => {
  const file = location(c);
  if (path.isAbsolute(file) && path.resolve(file) === file && file !== c.live) {
    await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, passing);
  }
  await unknown(c, c.f.plan, c.exit, { ...c.collection, files: [{ ...c.collection.files[0], path: file }] });
}));

const mutations: [string, (p: ExecutionPlan, e: ExecutionExit, a: CollectedArtifacts) => void][] = [
  ['foreign collection run', (_p, _e, a) => { a.handle.runId = 'run2'; }],
  ['foreign exit run', (_p, e) => { e.handle.runId = 'run2'; }],
  ['foreign opaque handle', (_p, _e, a) => { a.handle.opaqueId = 'foreign'; }],
  ['foreign input manifest', (_p, _e, a) => { a.inputManifestSha256 = 'a'.repeat(64); }],
  ['foreign plan input run', p => { p.input = { ...p.input, identity: { ...p.input.identity, runId: 'run2' } }; }],
  ['different plan ownership run', p => { p.ownership = { ...p.ownership, runId: 'run2' }; }],
  ['mismatched input sibling', p => { p.input = { ...p.input, immutableDirectory: path.join(path.dirname(p.input.immutableDirectory), 'other-input') }; }],
  ['mismatched build sibling', p => { p.input = { ...p.input, buildDirectory: path.join(path.dirname(p.input.buildDirectory), 'other-build') }; }],
  ['mismatched artifacts sibling', p => { p.input = { ...p.input, artifactsDirectory: path.join(path.dirname(p.input.artifactsDirectory), 'other-artifacts') }; }],
  ['noncanonical input', p => { p.input = { ...p.input, immutableDirectory: p.input.immutableDirectory + path.sep + '.' }; }],
  ['relative input', p => { p.input = { ...p.input, immutableDirectory: 'runs/run1/input' }; }],
  ['stale report', (_p, _e, a) => { a.files = [{ ...a.files[0], freshForRun: false }]; }],
  ['wrong hash', (_p, _e, a) => { a.files = [{ ...a.files[0], sha256: '0'.repeat(64) }]; }],
  ['wrong byte length', (_p, _e, a) => { a.files = [{ ...a.files[0], bytes: a.files[0].bytes + 1 }]; }],
  ['oversized declared length', (_p, _e, a) => { a.files = [{ ...a.files[0], bytes: 4 * 1024 * 1024 + 1 }]; }],
  ['duplicate report', (_p, _e, a) => { a.files = [...a.files, ...a.files]; }],
  ['no report', (_p, _e, a) => { a.files = []; }],
  ['noninteger exit', (_p, e) => { e.exitCode = null as unknown as number; }],
];
for (const [name, mutate] of mutations) test('reject handoff authority/metadata: ' + name, () => withCollection(async c => {
  const p = structuredClone(c.f.plan), e = structuredClone(c.exit), a = structuredClone(c.collection);
  mutate(p, e, a); await unknown(c, p, e, a);
}));

test('reject collected file mutated after durable collection', () => withCollection(async c => {
  await fs.writeFile(c.collection.files[0].path, passing.replace('fresh', 'other'));
  await unknown(c);
  await assert.rejects(c.f.executor.collect(c.exit.handle, c.exit), /Artifact digest mismatch/);
}));
test('reject final file symlink despite matching bytes/hash', () => withCollection(async c => {
  const file = c.collection.files[0].path;
  await fs.rm(file); await fs.symlink(c.live, file); await unknown(c);
}));
test('reject symlinked collected parent despite matching bytes/hash', () => withCollection(async c => {
  const dir = path.dirname(c.collection.files[0].path);
  await fs.rename(dir, dir + '-real'); await fs.symlink(dir + '-real', dir, 'dir');
  try { await unknown(c); } finally { await fs.rm(dir); await fs.rename(dir + '-real', dir); }
}));
test('reject same-run hardlink to live artifact, not executor-owned collected file', () => withCollection(async c => {
  const file = c.collection.files[0].path;
  await fs.rm(file); await fs.link(c.live, file); await unknown(c);
}));

const reports: [string, string, number, string, number][] = [
  ['all skipped', '<testsuite tests="1" skipped="1"><testcase name="s"><skipped/></testcase></testsuite>', 0, 'FAILED', 1],
  ['zero tests', '<testsuite tests="0"/>', 0, 'NO_TESTS', 0],
  ['failed test', '<testsuite tests="1" failures="1"><testcase name="f"><failure/></testcase></testsuite>', 0, 'FAILED', 1],
  ['error test', '<testsuite tests="1" errors="1"><testcase name="e"><error/></testcase></testsuite>', 0, 'FAILED', 1],
  ['nonzero process exit with passing report', passing, 1, 'FAILED', 1],
];
for (const [name, xml, code, expected, count] of reports) test('genuine collection negative: ' + name, () => withCollection(async c => {
  const outcome = await interpret(c);
  assert.equal(outcome.testOutcome, expected); assert.equal(outcome.status, 'FAILED'); assert.equal(outcome.testCount, count);
}, xml, code));
test('genuine collection malformed JUnit is UNKNOWN', () => withCollection(c => unknown(c), '<not-xml'));
