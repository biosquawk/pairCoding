/** UNIT controlled read-only engine/image ports, never Docker or proof of measured production preparation. */
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { PreparedRuntimeResolver, type PreparedRuntimeDependencies } from '../../src/server/runtime-coordinator/PreparedRuntimeResolver';
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
  const write = () => { fs.writeFileSync(path.join(root, 'receipt.json'), JSON.stringify(receipt)); fs.writeFileSync(path.join(cache, 'tools.json'), JSON.stringify(actualTools)); fs.writeFileSync(path.join(cache, 'dependencies-prepared.json'), JSON.stringify(prepared)); };
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
  const f = fixture(t); const inspected: any = f.inspected; inspected.RepoDigests = []; inspected.Descriptor = { digest: f.image.digest, mediaType: 'application/vnd.oci.image.manifest.v1+json' }; f.write();
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
      case 'project': f.receipt.request.project.root = path.join(f.temp, 'other-project'); break;
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
