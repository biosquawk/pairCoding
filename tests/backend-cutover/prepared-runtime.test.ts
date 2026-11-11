/** UNIT controlled read-only engine/image ports, never Docker or proof of measured production preparation. */
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { PreparedRuntimeResolver, createPreparedRuntimeInspection, type PreparedRuntimeDependencies } from '../../src/server/runtime-coordinator/PreparedRuntimeResolver';
import type { ResolvedRuntime } from '../../src/server/runtime-config';
import type { RunProfileV2, RuntimeProfile } from '../../src/shared/runtime-v2';
const hash = (b: string | Buffer) => createHash('sha256').update(b).digest('hex');
const dependencyHash = (files: { path: string; sha256: string }[]) => hash(JSON.stringify(files.filter(f => f.path === 'package.json'))); // UNIT policy, not producer implementation.
const profile: RuntimeProfile = { id: 'javascript-node', label: 'Node', adapterFamily: 'node', imageLockKey: 'node', expectedTools: [{ name: 'node', version: '22.22.0' }],
  compilerRelease: null, analysis: { languageLevel: 'es2022', preview: false }, language: { provider: 'builtin', imageLockKey: null, serverJvm: null }, taskFields: [] };
const run: RunProfileV2 = { kind: 'RUN_MAIN', timeoutMs: 1000, task: { workingDirectory: '.', entry: { kind: 'SCRIPT', path: 'main.js' }, tests: { paths: [], names: [] } } };
function fixture(t: TestContext) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'prepared-unit-'));
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
  const receipt: any = { schemaVersion: 1, status: 'PREPARED_REQUIRES_OFFLINE_AND_TOOL_VALIDATION', engine, request: { key: profile.id, family: profile.adapterFamily,
    project: { root: workspace, files: [] }, workingDirectory: '.', outputRoot: root, imageTag: image.image, dependencySha256: d, expectedTools: profile.expectedTools, installationId: 'unit-install' },
    toolchainHash: identity.toolchainHash, dispatcherFiles: identity.dispatcherFiles, imageId: image.imageId, imageInspect: inspected,
    container: { Id: 'e'.repeat(64), State: { Running: false, ExitCode: 0 }, Config: { Image: image.imageId, Labels: { 'paircoach.installation': 'unit-install', 'paircoach.role': 'prepare' } } } };
  const write = () => { receipt.observedImage = { Id: receipt.imageInspect.Id, RepoDigests: receipt.imageInspect.RepoDigests ?? [], Descriptor: receipt.imageInspect.Descriptor ?? null }; receipt.cacheEvidence = { root: cache, tools: { path: 'tools.json', sha256: hash(JSON.stringify(actualTools)), actual: actualTools }, dependencies: { path: 'dependencies-prepared.json', sha256: hash(JSON.stringify(prepared)), actual: prepared } }; fs.writeFileSync(path.join(root, 'receipt.json'), JSON.stringify(receipt)); fs.writeFileSync(path.join(cache, 'tools.json'), JSON.stringify(actualTools)); fs.writeFileSync(path.join(cache, 'dependencies-prepared.json'), JSON.stringify(prepared)); };
  write();
  const runtime: ResolvedRuntime = { configurationGeneration: 'cfg', configPath: path.join(temp, 'paircoach.runtime.json'), workspaceRoot: workspace, profile: structuredClone(profile), image,
    languageImage: null, catalog: { schemaVersion: 1, profiles: [profile] }, imageLock: { schemaVersion: 1, images: [image] }, config: { schemaVersion: 1, activeProfile: profile.id, workspaceRoot: workspace,
      runtimeCatalog: 'catalog.json', imageLock: 'images.lock.json', languageFeatures: { completion: true, diagnostics: true }, execution: { backend: 'docker', pullPolicy: 'never' } } };
  const calls: string[] = [];
  const dependencies: PreparedRuntimeDependencies = { readRunSourceInventory: inventory, dependencyHash,
    resolvePreparedToolchainIdentity: () => { calls.push('identity'); return structuredClone(identity); },
    inspectEngine: async () => { calls.push('engine'); return structuredClone(engine); }, inspectImage: async () => { calls.push('image'); return [structuredClone(inspected)]; } };
  const resolver = (roots = [root]) => new PreparedRuntimeResolver({ outputRoots: roots }, dependencies);
  return { temp, workspace, root, runtime, engine, image, inspected, receipt, prepared, actualTools, identity, cache, calls, dependencies, write, resolver };
}
const denied = async (f: ReturnType<typeof fixture>) => { const result = await f.resolver().probe(f.runtime, 'RUN_MAIN', run); assert.equal(result.canRun, false); assert.equal(result.problem?.code, 'PREPARE_REQUIRED'); };

test('UNIT current exact measured identity selects immutable RO cache, no host operation, no READY cache', async t => {
  const f = fixture(t), original = fs.readFileSync(path.join(f.workspace, 'main.js'));
  const result = await f.resolver().resolve(f.runtime, 'RUN_MAIN', run);
  assert.equal(result.outputRoot, f.root); assert.equal(result.engineId, 'unit-engine'); assert.equal(result.caches[0].directory, f.cache); assert.equal(result.caches[0].readOnly, true);
  assert.ok(Object.isFrozen(result.caches[0])); assert.ok(Object.isFrozen(result.image.tools));
  assert.deepEqual(f.calls, ['engine', 'identity', 'image', 'engine', 'image', 'identity']);
  assert.deepEqual(fs.readFileSync(path.join(f.workspace, 'main.js')), original);
  fs.writeFileSync(path.join(f.workspace, 'package.json'), '{"changedDependency":true}'); await denied(f);
});
test('UNIT no roots and malformed/duplicate/nested/relative/oversized roots fail closed', async t => {
  const f = fixture(t); assert.equal((await f.resolver([]).probe(f.runtime, 'RUN_MAIN', run)).canRun, false);
  for (const roots of [['relative'], [f.root, f.root], [f.root, path.join(f.root, 'nested')], Array.from({ length: 17 }, (_, i) => '/root' + i), [f.root + '/']]) assert.throws(() => f.resolver(roots));
});
test('UNIT ordinary source edits reuse dependency cache; raw dependency CRLF changes invalidate', async t => {
  const f = fixture(t); fs.writeFileSync(path.join(f.workspace, 'main.js'), 'console.log(999)\n');
  assert.equal((await f.resolver().probe(f.runtime, 'RUN_MAIN', run)).canRun, true);
  fs.writeFileSync(path.join(f.workspace, 'package.json'), '{"name":"unit"}\n'); await denied(f);
});
test('UNIT image config Id is NEVER accepted as OCI digest, even when inspect/lock agree', async t => {
  const f = fixture(t); f.image.digest = f.image.imageId; f.inspected.RepoDigests = []; f.write(); await denied(f);
});
test('UNIT real Descriptor manifest identity is usable, image Id or unrelated descriptor is not', async t => {
  const f = fixture(t); const inspected: any = f.inspected; inspected.RepoDigests = []; inspected.Descriptor = { digest: f.image.digest, mediaType: 'application/vnd.oci.image.manifest.v1+json', size: 1024 }; f.write();
  assert.equal((await f.resolver().probe(f.runtime, 'RUN_MAIN', run)).canRun, true);
  inspected.Descriptor.mediaType = 'application/vnd.oci.image.config.v1+json'; f.write(); await denied(f);
});
for (const field of ['engine', 'image', 'tools', 'dependency', 'dispatcher', 'helper', 'status', 'project', 'cwd', 'family', 'profile', 'ownership', 'exit', 'cache']) {
  test('UNIT rejects stale/missing actual evidence: ' + field, async t => {
    const f = fixture(t);
    switch (field) {
      case 'engine': f.engine.ID = 'different-now'; break;
      case 'image': f.inspected.Id = 'sha256:' + 'f'.repeat(64); break;
      case 'tools': f.actualTools[0].version = 'wrong'; break;
      case 'dependency': f.prepared.dependencySha256 = 'f'.repeat(64); break;
      case 'dispatcher': f.receipt.dispatcherFiles = [{ path: 'scripts/runtime-task.mjs', sha256: 'f'.repeat(64) }]; break;
      case 'helper': f.dependencies.resolvePreparedToolchainIdentity = () => { throw Error('installed pins changed'); }; break;
      case 'status': f.receipt.status = 'PLAN_ONLY_NOT_PREPARED'; break;
      case 'project': f.receipt.request.project.root = '../untrusted-relative-root'; break;
      case 'cwd': f.receipt.request.workingDirectory = 'other'; break;
      case 'family': f.receipt.request.family = 'python'; break;
      case 'profile': f.receipt.request.key = 'unselected'; break;
      case 'ownership': f.receipt.container.Config.Labels['paircoach.role'] = 'execution'; break;
      case 'exit': f.receipt.container.State.Running = true; break;
      case 'cache': fs.renameSync(f.cache, f.cache + '-old'); break;
    }
    if (field !== 'cache') f.write();
    if (field === 'engine' || field === 'image') {
      // Preserve prepare-time evidence, change ONLY actual current observer.
      if (field === 'engine') f.receipt.engine = { ...f.engine, ID: 'unit-engine' };
      else f.receipt.imageInspect = { ...f.inspected, Id: f.image.imageId };
      f.write();
    }
    await denied(f);
  });
}
test('UNIT detects dependency change while awaiting read-only image observer', async t => {
  const f = fixture(t), original = f.dependencies.inspectImage;
  f.dependencies.inspectImage = async id => { fs.writeFileSync(path.join(f.workspace, 'package.json'), '{"raced":true}'); return original(id); };
  await denied(f);
});
test('UNIT detects engine rotation and output replacement during awaited observation', async t => {
  const f = fixture(t); let count = 0; f.dependencies.inspectEngine = async () => ({ ...f.engine, ID: ++count === 1 ? 'unit-engine' : 'replacement' }); await denied(f);
  f.dependencies.inspectEngine = async () => f.engine;
  f.dependencies.inspectImage = async () => { f.receipt.extra = 'replacement'; f.write(); return [f.inspected]; }; await denied(f);
});
test('UNIT receipt/cache hardlink and symlink substitutions never confer authority', async t => {
  const f = fixture(t), receipt = path.join(f.root, 'receipt.json');
  fs.linkSync(receipt, path.join(f.temp, 'alias')); await denied(f); fs.unlinkSync(path.join(f.temp, 'alias'));
  const tools = path.join(f.cache, 'tools.json'); fs.renameSync(tools, tools + '-old'); fs.symlinkSync(tools + '-old', tools); await denied(f);
});
test('UNIT ambiguous two matching outputs fail; private diagnostics never echo local secrets', async t => {
  const f = fixture(t), second = path.join(f.temp, 'second'); fs.cpSync(f.root, second, { recursive: true }); fs.chmodSync(second, 0o700);
  const r = structuredClone(f.receipt); r.request.outputRoot = second; fs.writeFileSync(path.join(second, 'receipt.json'), JSON.stringify(r));
  await assert.rejects(f.resolver([f.root, second]).resolve(f.runtime, 'RUN_MAIN', run), { code: 'PREPARE_REQUIRED' });
  f.dependencies.inspectEngine = async () => { throw Error('/private/secret-token'); };
  assert.ok(!JSON.stringify(await f.resolver().probe(f.runtime, 'RUN_MAIN', run)).includes('secret-token'));
});


test('UNIT accepted transport observer permits only bounded read-only engine/image commands', async () => {
  const calls: { args: readonly string[]; options: unknown }[] = [];
  const observer = createPreparedRuntimeInspection({ run: async (args, options) => { calls.push({ args, options }); return { exitCode: 0, stdout: '{"unit":true}', stderr: '' }; } });
  assert.deepEqual(await observer.inspectEngine(), { unit: true });
  assert.deepEqual(await observer.inspectImage('sha256:' + 'a'.repeat(64)), { unit: true });
  assert.deepEqual(calls.map(c => c.args), [['info', '--format', '{{json .}}'], ['image', 'inspect', 'sha256:' + 'a'.repeat(64)]]);
  assert.ok(calls.every(c => JSON.stringify(c.options) === JSON.stringify({ timeoutMs: 3000, maxBytes: 1024 * 1024 })));
  assert.throws(() => observer.inspectImage('--privileged')); assert.equal(calls.length, 2);
  const failed = createPreparedRuntimeInspection({ run: async () => ({ exitCode: 1, stdout: '{}', stderr: '/private/do-not-publish' }) });
  await assert.rejects(failed.inspectEngine());
});


test('UNIT cache marker bytes must still match producer evidence, not just self-consistent current claims', async t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.cache, 'tools.json'), JSON.stringify([{ ...f.actualTools[0], raw: 'forged-but-same-version' }]));
  await denied(f);
});
test('UNIT malformed RepoDigest strings or incomplete OCI descriptors never confer readiness', async t => {
  const f = fixture(t);
  f.inspected.RepoDigests = ['not a repository@' + f.image.digest]; f.write(); await denied(f);
  const inspected: any = f.inspected;
  inspected.RepoDigests = []; inspected.Descriptor = { digest: f.image.digest, mediaType: 'application/vnd.oci.image.manifest.v1+json' }; f.write(); await denied(f);
});


test('UNIT explicitly selected staging output keeps provenance, CURRENT raw dependency proof remains mandatory', async t => {
  const f = fixture(t), staging = path.join(f.temp, 'former-staging-root');
  // Staging no longer exists and its receipt inventory is not current source authority.
  f.receipt.request.project = { root: staging, files: [{ path: 'main.js', sha256: 'f'.repeat(64) }] }; f.write();
  const seen: string[] = [], inventory = f.dependencies.readRunSourceInventory;
  f.dependencies.readRunSourceInventory = async root => { seen.push(root); return inventory(root); };
  const result = await f.resolver().resolve(f.runtime, 'RUN_MAIN', run);
  assert.equal(result.preparationProjectRoot, staging);
  assert.deepEqual(seen, [f.workspace, f.workspace]);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.root, 'receipt.json'), 'utf8')).request.project.root, staging);
  fs.writeFileSync(path.join(f.workspace, 'package.json'), '{"new":"dependency"}'); await denied(f);
});


test('UNIT staging provenance never rewrites a root-sensitive producer identity', async t => {
  const f = fixture(t), staging = path.join(f.temp, 'staged');
  f.receipt.request.project.root = staging; f.write();
  f.dependencies.resolvePreparedToolchainIdentity = request => {
    assert.equal((request as any).project.root, staging);
    return { ...f.identity, toolchainHash: 'f'.repeat(64) };
  };
  await denied(f);
});


test('UNIT nonlocal native staging provenance is metadata, not a path to resolve or open', async t => {
  const f = fixture(t);
  f.receipt.request.project.root = 'C:\\staging\\old project'; f.write();
  assert.equal((await f.resolver().resolve(f.runtime, 'RUN_MAIN', run)).preparationProjectRoot, 'C:\\staging\\old project');
});

test('UNIT config Id may equal genuine OCI index digest; independent measured proof is still mandatory', async t => {
  const f = fixture(t), inspected: any = f.inspected;
  f.image.digest = f.image.imageId; inspected.RepoDigests = [];
  inspected.Descriptor = { digest: f.image.digest, mediaType: 'application/vnd.oci.image.index.v1+json', size: 856 }; f.write();
  assert.equal((await f.resolver().probe(f.runtime, 'RUN_MAIN', run)).canRun, true);
  inspected.Descriptor = null; f.write(); await denied(f);
  inspected.RepoDigests = ['paircoach/runtime-node@' + f.image.digest]; f.write();
  assert.equal((await f.resolver().probe(f.runtime, 'RUN_MAIN', run)).canRun, true);
});

test('UNIT selected cache seam returns COMPLETE binary+dotfile inventory under retained explicit lease', async t => {
  const f = fixture(t); fs.mkdirSync(path.join(f.cache, 'm2'));
  const binary = Buffer.from([0, 255, 13, 10, 128]); fs.writeFileSync(path.join(f.cache, 'm2', 'dependency.jar'), binary);
  fs.writeFileSync(path.join(f.cache, 'm2', '.repositories'), 'metadata\r\n');
  let checks = 0;
  const result = await f.resolver().resolveCache(f.runtime, 'RUN_MAIN', run, { assertCurrent: () => { checks++; } });
  assert.equal(result.cacheRoot, f.cache); assert.equal(result.family, 'node'); assert.equal(result.workingDirectory, '.');
  assert.equal(result.dependencySha256, f.receipt.request.dependencySha256); assert.equal(result.toolchainSha256, f.identity.toolchainHash);
  assert.deepEqual(result.files.map(f => f.path), ['dependencies-prepared.json', 'm2/.repositories', 'm2/dependency.jar', 'tools.json']);
  assert.equal(result.files.find(f => f.path === 'm2/dependency.jar')?.sha256, hash(binary));
  assert.equal(result.files.find(f => f.path === 'm2/dependency.jar')?.bytes, binary.length); assert.equal(checks, 4);
  assert.ok(Object.isFrozen(result.files[0])); assert.match(result.inventorySha256, /^[a-f0-9]{64}$/);
});
for (const invalid of ['symlink', 'hardlink', 'alias', 'oversized', 'lease', 'race'] as const)
  test('UNIT complete cache seam rejects rather than excludes ' + invalid, async t => {
    const f = fixture(t), file = path.join(f.cache, 'artifact.bin'); fs.writeFileSync(file, 'original');
    if (invalid === 'symlink') fs.symlinkSync(file, path.join(f.cache, 'linked'));
    if (invalid === 'hardlink') fs.linkSync(file, path.join(f.cache, 'linked'));
    if (invalid === 'alias') fs.writeFileSync(path.join(f.cache, 'ARTIFACT.bin'), 'collision');
    if (invalid === 'oversized') fs.truncateSync(file, 32*1024*1024 + 1);
    if (invalid === 'race') { let count = 0; f.dependencies.inspectEngine = async () => { if (++count === 3) fs.writeFileSync(file, 'raced'); return f.engine; }; }
    await assert.rejects(f.resolver().resolveCache(f.runtime, 'RUN_MAIN', run, { assertCurrent: () => { if (invalid === 'lease') throw Error('revoked'); } }), { code: 'PREPARE_REQUIRED' });
  });

test('UNIT actual inspect may omit empty Entrypoint; nonempty or malformed entrypoint still refused', async t => {
  const f = fixture(t), config: any = f.inspected.Config; delete config.Entrypoint; f.write();
  assert.equal((await f.resolver().probe(f.runtime, 'RUN_MAIN', run)).canRun, true);
  for (const entrypoint of [['/unreviewed'], '']) { config.Entrypoint = entrypoint; f.write(); await denied(f); }
});

/** New roots have their OWN exact output/cache evidence; positive controls prove each is valid.
 * No old malformed ambiguity fixture is treated as proof of two actual matches. */
function clonePreparedRoot(f: ReturnType<typeof fixture>, name: string, dependency?: string) {
  const root = path.join(f.temp, name); fs.cpSync(f.root, root, { recursive: true }); fs.chmodSync(root, 0o700);
  const receipt = structuredClone(f.receipt);
  receipt.request.outputRoot = root;
  const oldCache = path.join(root, 'cache', profile.adapterFamily, f.identity.toolchainHash, receipt.request.dependencySha256);
  const cache = path.join(root, 'cache', profile.adapterFamily, f.identity.toolchainHash, dependency ?? receipt.request.dependencySha256);
  if (cache !== oldCache) fs.renameSync(oldCache, cache);
  receipt.request.dependencySha256 = dependency ?? receipt.request.dependencySha256;
  const prepared = { ...f.prepared, dependencySha256: receipt.request.dependencySha256 };
  const bytes = Buffer.from(JSON.stringify(prepared)); fs.writeFileSync(path.join(cache, 'dependencies-prepared.json'), bytes);
  receipt.cacheEvidence.root = cache;
  receipt.cacheEvidence.dependencies = { path: 'dependencies-prepared.json', sha256: hash(bytes), actual: prepared };
  const write = () => fs.writeFileSync(path.join(root, 'receipt.json'), JSON.stringify(receipt)); write();
  return { root, cache, receipt, write };
}
async function unrelatedPreparedRoot(f: ReturnType<typeof fixture>) {
  const workspace = path.join(f.temp, 'other-project'); fs.cpSync(f.workspace, workspace, { recursive: true });
  fs.writeFileSync(path.join(workspace, 'package.json'), '{"name":"another-valid-project"}');
  f.dependencies.readRunSourceInventory = async root => ['main.js', 'package.json'].map(p => {
    const bytes = fs.readFileSync(path.join(root, p)); return { path: p, sha256: hash(bytes), bytes: bytes.length };
  });
  const dependency = dependencyHash((await f.dependencies.readRunSourceInventory(workspace)).map(({path,sha256}) => ({path,sha256})));
  const other = clonePreparedRoot(f, 'other-prepared', dependency);
  other.receipt.request.project.root = workspace; other.write();
  const runtime = { ...f.runtime, workspaceRoot: workspace };
  assert.equal((await f.resolver([other.root]).probe(runtime, 'RUN_MAIN', run)).canRun, true, 'valid unrelated positive control');
  assert.equal((await f.resolver([f.root]).probe(f.runtime, 'RUN_MAIN', run)).canRun, true, 'valid current positive control');
  return { ...other, runtime };
}
test('UNIT multioutput valid unrelated dependency output never poisons the unique current match (both orders and full cache)', async t => {
  const f = fixture(t), other = await unrelatedPreparedRoot(f);
  for (const roots of [[other.root, f.root], [f.root, other.root]]) {
    const resolver = f.resolver(roots);
    assert.equal((await resolver.probe(f.runtime, 'RUN_MAIN', run)).canRun, true);
    const selected = await resolver.resolveCache(f.runtime, 'RUN_MAIN', run, { assertCurrent() {} });
    assert.equal(selected.outputRoot, f.root); assert.equal(selected.cacheRoot, f.cache);
    assert.equal(selected.dependencySha256, f.receipt.request.dependencySha256);
    assert.deepEqual(selected.files.map(f => f.path), ['dependencies-prepared.json', 'tools.json']);
  }
});
test('UNIT multioutput valid unrelated dependency output alone yields zero current matches, not false readiness', async t => {
  const f = fixture(t), other = await unrelatedPreparedRoot(f);
  assert.equal((await f.resolver([other.root]).probe(f.runtime, 'RUN_MAIN', run)).canRun, false);
});
test('UNIT multioutput TWO genuinely valid current roots are ambiguous, both single-root positive controls pass', async t => {
  const f = fixture(t), second = clonePreparedRoot(f, 'valid-second');
  for (const root of [f.root, second.root]) assert.equal((await f.resolver([root]).probe(f.runtime, 'RUN_MAIN', run)).canRun, true);
  for (const roots of [[f.root, second.root], [second.root, f.root]])
    await assert.rejects(f.resolver(roots).resolveCache(f.runtime, 'RUN_MAIN', run, { assertCurrent() {} }), { code: 'PREPARE_REQUIRED' });
});
test('UNIT multioutput matching bad cache evidence is never bypassed by a valid unrelated root', async t => {
  const f = fixture(t), other = await unrelatedPreparedRoot(f);
  f.receipt.cacheEvidence.root = other.cache; fs.writeFileSync(path.join(f.root, 'receipt.json'), JSON.stringify(f.receipt));
  for (const roots of [[other.root, f.root], [f.root, other.root]]) assert.equal((await f.resolver(roots).probe(f.runtime, 'RUN_MAIN', run)).canRun, false);
});
test('UNIT multioutput malformed dependency selector is not silently ignored beside a valid current root', async t => {
  const f = fixture(t), second = clonePreparedRoot(f, 'malformed-second');
  delete second.receipt.request.dependencySha256; second.write();
  assert.equal((await f.resolver([second.root, f.root]).probe(f.runtime, 'RUN_MAIN', run)).canRun, false);
});
test('UNIT multioutput invalid matching candidate is not skipped even beside another VALID current candidate', async t => {
  const f = fixture(t), second = clonePreparedRoot(f, 'initially-valid-second');
  assert.equal((await f.resolver([f.root]).probe(f.runtime, 'RUN_MAIN', run)).canRun, true);
  assert.equal((await f.resolver([second.root]).probe(f.runtime, 'RUN_MAIN', run)).canRun, true);
  second.receipt.cacheEvidence.tools.sha256 = 'f'.repeat(64); second.write();
  for (const roots of [[second.root, f.root], [f.root, second.root]])
    assert.equal((await f.resolver(roots).probe(f.runtime, 'RUN_MAIN', run)).canRun, false);
});
