/** UNIT controlled read-only engine/image ports, never Docker or proof of measured production preparation. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
// Pin PAIRCOACH_TEST_FROZEN_CONSUMER_ROOT to the reviewed immutable consumer export (31ef).
// Consumer is deliberately NOT copied into the CLI's older base or replaced by a selector mock.
import { measuredImageEntry } from '../../scripts/runtime-prepare-cli.mjs';
const frozen = process.env.PAIRCOACH_TEST_FROZEN_CONSUMER_ROOT;
assert.ok(frozen && path.isAbsolute(frozen), 'Explicit frozen consumer export required');
const { PreparedRuntimeResolver } = await import(pathToFileURL(path.join(frozen, 'src/server/runtime-coordinator/PreparedRuntimeResolver.ts')).href);
const { validateImageLock } = await import(pathToFileURL(path.join(frozen, 'src/shared/validation-v2.ts')).href);
const hash = b => createHash('sha256').update(b).digest('hex');
const dependencyHash = files => hash(JSON.stringify(files.filter(f => f.path === 'package.json'))); // UNIT policy, not producer implementation.
const profile = { id: 'javascript-node', label: 'Node', adapterFamily: 'node', imageLockKey: 'node', expectedTools: [{ name: 'node', version: '22.22.0' }],
  compilerRelease: null, analysis: { languageLevel: 'es2022', preview: false }, language: { provider: 'builtin', imageLockKey: null, serverJvm: null }, taskFields: [] };
const run = { kind: 'RUN_MAIN', timeoutMs: 1000, task: { workingDirectory: '.', entry: { kind: 'SCRIPT', path: 'main.js' }, tests: { paths: [], names: [] } } };
function fixture(t) {
  const temp = fs.mkdtempSync(path.join(process.env.TMPDIR ?? path.dirname(process.cwd()), 'prepared-unit-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const workspace = path.join(temp, 'project'), root = path.join(temp, 'prepared');
  fs.mkdirSync(workspace); fs.mkdirSync(root, { mode: 0o700 });
  fs.writeFileSync(path.join(workspace, 'package.json'), '{"name":"unit"}\r\n');
  fs.writeFileSync(path.join(workspace, 'main.js'), '\ufeffconsole.log(1);\r\n');
  const inventory = async () => ['main.js', 'package.json'].map(p => { const bytes = fs.readFileSync(path.join(workspace, p)); return { path: p, sha256: hash(bytes), bytes: bytes.length }; });
  const image = { key: 'node', image: 'paircoach/runtime-node:22-v1', imageId: 'sha256:' + 'a'.repeat(64), digest: 'sha256:' + 'b'.repeat(64), tools: structuredClone(profile.expectedTools) };
  const engine = { ID: 'unit-engine', ServerVersion: '29.7.2', OSType: 'linux', Architecture: 'x86_64' };
  const inspected = { Id: image.imageId, Os: 'linux', Architecture: 'amd64', Config: { User: '10001:10001', Entrypoint: null }, RepoDigests: ['paircoach/runtime-node@' + image.digest] };
  const identity = { toolchainHash: 'c'.repeat(64), dispatcherFiles: [{ path: 'scripts/runtime-task.mjs', sha256: 'd'.repeat(64) }] };
  const d = dependencyHash(['main.js', 'package.json'].map(p => ({ path: p, sha256: hash(fs.readFileSync(path.join(workspace, p))) })));
  const cache = path.join(root, 'cache', 'node', identity.toolchainHash, d); fs.mkdirSync(cache, { recursive: true });
  const actualTools = [{ name: 'node', version: '22.22.0', raw: 'v22.22.0\n' }];
  const prepared = { family: 'node', workingDirectory: '.', dependencySha256: d, tools: actualTools, preparedAt: '2026-11-11T22:00:00.000Z' };
  const receipt = { schemaVersion: 1, status: 'PREPARED_REQUIRES_OFFLINE_AND_TOOL_VALIDATION', engine, request: { key: profile.id, family: profile.adapterFamily,
    project: { root: workspace, files: [] }, workingDirectory: '.', outputRoot: root, imageTag: image.image, dependencySha256: d, expectedTools: profile.expectedTools, installationId: 'unit-install' },
    toolchainHash: identity.toolchainHash, dispatcherFiles: identity.dispatcherFiles, imageId: image.imageId, imageInspect: inspected,
    container: { Id: 'e'.repeat(64), State: { Running: false, ExitCode: 0 }, Config: { Image: image.imageId, Labels: { 'paircoach.installation': 'unit-install', 'paircoach.role': 'prepare' } } } };
  const write = () => { receipt.observedImage = { Id: receipt.imageInspect.Id, RepoDigests: receipt.imageInspect.RepoDigests ?? [], Descriptor: receipt.imageInspect.Descriptor ?? null }; receipt.cacheEvidence = { root: cache, tools: { path: 'tools.json', sha256: hash(JSON.stringify(actualTools)), actual: actualTools }, dependencies: { path: 'dependencies-prepared.json', sha256: hash(JSON.stringify(prepared)), actual: prepared } }; fs.writeFileSync(path.join(root, 'receipt.json'), JSON.stringify(receipt)); fs.writeFileSync(path.join(cache, 'tools.json'), JSON.stringify(actualTools)); fs.writeFileSync(path.join(cache, 'dependencies-prepared.json'), JSON.stringify(prepared)); };
  write();
  const runtime = { configurationGeneration: 'cfg', configPath: path.join(temp, 'paircoach.runtime.json'), workspaceRoot: workspace, profile: structuredClone(profile), image,
    languageImage: null, catalog: { schemaVersion: 1, profiles: [profile] }, imageLock: { schemaVersion: 1, images: [image] }, config: { schemaVersion: 1, activeProfile: profile.id, workspaceRoot: workspace,
      runtimeCatalog: 'catalog.json', imageLock: 'images.lock.json', languageFeatures: { completion: true, diagnostics: true }, execution: { backend: 'docker', pullPolicy: 'never' } } };
  const calls = [];
  const dependencies = { readRunSourceInventory: inventory, dependencyHash,
    resolvePreparedToolchainIdentity: () => { calls.push('identity'); return structuredClone(identity); },
    inspectEngine: async () => { calls.push('engine'); return structuredClone(engine); }, inspectImage: async () => { calls.push('image'); return [structuredClone(inspected)]; } };
  const resolver = (roots = [root]) => new PreparedRuntimeResolver({ outputRoots: roots }, dependencies);
  return { temp, workspace, root, runtime, engine, image, inspected, receipt, prepared, actualTools, identity, cache, calls, dependencies, write, resolver };
}
const descriptor = digest => ({ mediaType: 'application/vnd.oci.image.index.v1+json', size: 856, digest });
function generated(f) {
  const entry = measuredImageEntry(f.image.key, f.receipt.request.imageTag,
    { Id: f.inspected.Id, RepoDigests: f.inspected.RepoDigests, Descriptor: f.inspected.Descriptor ?? null }, f.image.imageId, f.actualTools);
  assert.equal(validateImageLock({ schemaVersion: 1, images: [entry] }), true);
  return entry;
}
test('UNIT actual frozen consumer positive control before producer projection', async t => {
  const f = fixture(t);
  assert.equal((await f.resolver().probe(f.runtime, 'RUN_MAIN', run)).canRun, true);
});
for (const mode of ['repo-only', 'descriptor-only', 'descriptor-and-repo', 'genuine-equal-id-and-digest']) {
  test('UNIT actual CLI producer -> frozen actual consumer: ' + mode, async t => {
    const f = fixture(t);
    if (mode === 'genuine-equal-id-and-digest') f.image.digest = f.image.imageId;
    f.inspected.RepoDigests = mode === 'descriptor-only' ? [] : ['paircoach/runtime-node@' + f.image.digest];
    if (mode !== 'repo-only') f.inspected.Descriptor = descriptor(f.image.digest);
    f.write();
    assert.equal((await f.resolver().probe(f.runtime, 'RUN_MAIN', run)).canRun, true, 'fixture positive control');
    const entry = generated(f);
    assert.equal(entry.image, f.receipt.request.imageTag, 'approved readable selector retained; never substitute RepoDigest');
    assert.equal(entry.digest, f.image.digest);
    assert.equal(entry.imageId, f.image.imageId);
    assert.deepEqual(entry.tools, f.image.tools, 'raw producer tool evidence projected without schema weakening');
    const result = await f.resolver().probe({ ...f.runtime, image: entry }, 'RUN_MAIN', run);
    assert.equal(result.canRun, true, JSON.stringify(result));
  });
}
test('UNIT producer strict OCI/config negatives retained with nonempty RepoDigests and descriptor-only', t => {
  const f = fixture(t), id = f.image.imageId, digest = f.image.digest;
  for (const observed of [
    { Id: id, RepoDigests: [], Descriptor: null }, // no config-ID promotion
    { Id: digest, RepoDigests: ['paircoach/runtime-node@' + digest], Descriptor: null }, // wrong config
    { Id: id, RepoDigests: ['paircoach/runtime-node@sha256:bad'], Descriptor: null },
    { Id: id, RepoDigests: ['paircoach/runtime-node@' + id], Descriptor: descriptor(digest) },
    { Id: id, RepoDigests: [], Descriptor: { ...descriptor(digest), size: 0 } },
    { Id: id, RepoDigests: [], Descriptor: { ...descriptor(digest), mediaType: 'application/json' } },
  ]) assert.throws(() => measuredImageEntry(f.image.key, f.receipt.request.imageTag, observed, id, f.actualTools), /NOTREADY/);
});
for (const mutation of ['selector', 'digest', 'config-id', 'missing-live-proof', 'engine', 'tools']) {
  test('UNIT actual frozen consumer refuses after valid projection: ' + mutation, async t => {
    const f = fixture(t), entry = generated(f);
    // Establish that this exact lock/receipt pair works before mutating one condition.
    const runtime = { ...f.runtime, image: entry };
    assert.equal((await f.resolver().probe(runtime, 'RUN_MAIN', run)).canRun, true);
    if (mutation === 'selector') entry.image = 'paircoach/unapproved-alias:stage09';
    if (mutation === 'digest') entry.digest = 'sha256:' + 'f'.repeat(64);
    if (mutation === 'config-id') entry.imageId = 'sha256:' + 'f'.repeat(64);
    if (mutation === 'missing-live-proof') f.dependencies.inspectImage = async () => [{ ...f.inspected, RepoDigests: [], Descriptor: null }];
    if (mutation === 'engine') f.dependencies.inspectEngine = async () => ({ ...f.engine, ID: 'other-engine' });
    if (mutation === 'tools') entry.tools[0].version = '0.0.0';
    const result = await f.resolver().probe(runtime, 'RUN_MAIN', run);
    assert.equal(result.canRun, false); assert.equal(result.problem.code, 'PREPARE_REQUIRED');
  });
}
