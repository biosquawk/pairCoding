/** UNIT: genuine installed resolver/producer hashes + actual private filesystem/factory.
 * Docker info/image/tool-probe receipts below are SYNTHETIC, not measured runtime/native proof.
 */
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { createSelectedCacheLanguageFactory, type SelectedLanguageLease } from '../../src/server/language/SelectedCacheLanguageAuthority';
import { LanguageProcessAdmission } from '../../src/server/language/DockerLanguageProcess';
import { DiskLanguageProcessJournal } from '../../src/server/language/LanguageProcessJournal';
import type { LanguageDockerDriver } from '../../src/server/language/DockerLanguageDriver';
import type { LanguageProjectScope } from '../../src/server/language/ports';
import type { RegistrySnapshot } from '../../src/server/language/LanguageFeatureRegistry';
import type { DockerTransport } from '../../src/server/execution/DockerTransport';
import { readRunSourceInventory } from '../../src/server/execution/ImmutableInput';
import { dependencyHash } from '../../scripts/runtime-dependencies.mjs';
import { resolvePreparedToolchainIdentity } from '../../scripts/runtime-prepare.mjs';
import type { ResolvedRuntime } from '../../src/server/runtime-config';
import type { ImageLockEntry, RunProfileV2, RuntimeCatalog, RuntimeProfile } from '../../src/shared/runtime-v2';
import catalogData from '../../runtimes/catalog.json';
import pins from '../../runtimes/production-inputs.lock.json';
import * as codec from '../../src/language/uriCodec';
const hash = (b: string | Buffer) => createHash('sha256').update(b).digest('hex');
const callbacks = { onState: () => {}, onSourceSent: () => {}, onDiagnostics: () => {} };
async function fixture(t: TestContext, family: 'python' | 'java-maven' = 'python') {
  const root = fs.mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'selected-language-'));
  const clear = (dir: string) => { for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const p = join(dir, e.name); if (e.isDirectory()) clear(p); else if (e.isFile()) fs.chmodSync(p, 0o600); } };
  t.after(() => { clear(root); fs.rmSync(root, { recursive: true, force: true }); });
  const workspace = join(root, 'current-project'), prepared = join(root, 'prepared'), owned = join(root, 'owned'), journal = join(root, 'journal');
  for (const p of [workspace, prepared, owned, journal]) fs.mkdirSync(p, { mode: 0o700 });
  const catalog = structuredClone(catalogData) as RuntimeCatalog, profile = catalog.profiles.find(p => p.id === (family === 'python' ? 'python-3.13' : 'java-maven-21'))!;
  const path = family === 'python' ? 'main.py' : 'Main.java';
  fs.writeFileSync(join(workspace, path), 'disk before ACK\r\n'); fs.writeFileSync(join(workspace, 'inactive.txt'), 'inactive'); fs.mkdirSync(join(workspace, 'empty'));
  fs.writeFileSync(join(workspace, family === 'python' ? 'requirements.txt' : 'pom.xml'), family === 'python' ? 'dependency==1\r\n' : '<project/>\r\n');
  const raw = await readRunSourceInventory(workspace), dep = dependencyHash(raw);
  const run: RunProfileV2 = { kind: 'RUN_TESTS', timeoutMs: 1000, task: { workingDirectory: '.', entry: { kind: 'TESTS' }, tests: { paths: family === 'python' ? ['main.py'] : [], names: [] } } };
  const base = family === 'python' ? pins.images.python.reference : pins.images.java21.reference;
  const request = { schemaVersion: 1, key: profile.id, family, workingDirectory: '.', installationId: 'unit-install', outputRoot: prepared,
    imageTag: 'paircoach/runtime-' + profile.id + ':stage09', baseImage: base, nodeImage: pins.images.node.reference,
    project: { root: join(root, 'historical-preparation-root'), files: raw.map(({ path, sha256 }) => ({ path, sha256 })) },
    expectedTools: profile.expectedTools, dependencySha256: dep,
    tools: { root: join(root, 'historical-tools'), files: pins.artifacts.filter(a => a.kind === 'npm').flatMap(a => a.files!.map(f => ({ path: 'node_modules/' + a.name + '/' + f.path, sha256: f.sha256 }))).sort((a,b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0) } };
  const identity = resolvePreparedToolchainIdentity(request), cache = join(prepared, 'cache', family, identity.toolchainHash, dep); fs.mkdirSync(cache, { recursive: true });
  const actualTools = profile.expectedTools.map(t => ({ ...t, raw: t.name + ' ' + t.version + '\n' }));
  const deps = { family, workingDirectory: '.', dependencySha256: dep, tools: actualTools, preparedAt: '2026-11-11T22:00:00Z' };
  const artifacts: Record<string, string | Buffer> = { 'tools.json': JSON.stringify(actualTools), 'dependencies-prepared.json': JSON.stringify(deps),
    ...(family === 'python' ? { 'site-packages/dependency.py': Buffer.from([0,255,10,13,128]) } : { 'effective-pom.xml': '<project/>', 'm2/dependency.jar': Buffer.from([0,255,10,13,128]) }) };
  for (const [p,b] of Object.entries(artifacts)) { fs.mkdirSync(join(cache, p, '..'), { recursive: true }); fs.writeFileSync(join(cache,p), b); }
  const image: ImageLockEntry = { key: profile.imageLockKey, image: request.imageTag, imageId: 'sha256:' + 'a'.repeat(64), digest: 'sha256:' + 'b'.repeat(64), tools: profile.expectedTools };
  const pythonPackages = Object.fromEntries(pins.language.artifacts.filter(a => a.kind === 'language-wheel').map(a => [a.name, a.version]));
  const languageTools = family === 'python' ? [{ name: 'python', version: pins.language.pylsp.pythonVersion }, ...['python-lsp-server','jedi','pyflakes'].map(name => ({ name, version: pythonPackages[name] }))] :
    [{ name: 'java', version: profile.language.serverJvm! }, ...[11,17,21,27].map(r => ({ name: 'target-javac-' + r, version: catalog.profiles.find(p => p.compilerRelease === r)!.expectedTools.find(t => t.name === 'javac')!.version }))];
  const lang: ImageLockEntry = { key: profile.language.imageLockKey!, image: family === 'python' ? 'paircoach/language-pylsp:stage09' : 'paircoach/language-jdt:stage09', imageId: 'sha256:' + 'c'.repeat(64), digest: 'sha256:' + 'd'.repeat(64), tools: languageTools };
  const engine = { ID: 'unit-engine', ServerVersion: '29.7.2', OSType: 'linux', Architecture: 'x86_64' };
  const inspect = (i: ImageLockEntry): any => ({ Id: i.imageId, Os: 'linux', Architecture: 'amd64', Config: { User: '10001:10001', Entrypoint: null }, RepoDigests: [i.image.split(':')[0] + '@' + i.digest] });
  const inspected = inspect(image), inspectedLang = inspect(lang);
  const container = (imageId: string, role: string, suffix: string): any => ({ Id: hash(suffix), State: { Running: false, ExitCode: 0 }, Config: { Image: imageId, Labels: { 'paircoach.installation': role === 'prepare' ? 'unit-install' : 'stage09-runtime-assets', 'paircoach.role': role } } });
  const receipt: any = { schemaVersion: 1, status: 'PREPARED_REQUIRES_OFFLINE_AND_TOOL_VALIDATION', request, engine, imageId: image.imageId, ...identity, imageInspect: inspected,
    observedImage: { Id: image.imageId, RepoDigests: inspected.RepoDigests, Descriptor: null }, container: container(image.imageId, 'prepare', 'prepare'),
    cacheEvidence: { root: cache, tools: { path: 'tools.json', sha256: hash(artifacts['tools.json']), actual: actualTools }, dependencies: { path: 'dependencies-prepared.json', sha256: hash(artifacts['dependencies-prepared.json']), actual: deps } } };
  const probes = family === 'python' ? [{ name: 'python-pylsp-inventory', stdout: JSON.stringify({ python: pins.language.pylsp.pythonVersion, packages: pythonPackages }), stderr: '', inventory: { python: pins.language.pylsp.pythonVersion, packages: pythonPackages } }] : languageTools.map(p => ({ name: p.name === 'java' ? 'jdt-server-java' : p.name, stdout: p.name === 'java' ? '' : 'javac ' + p.version + '\n', stderr: p.name === 'java' ? 'openjdk version "' + p.version + '"\n' : '', version: p.version }));
  const languageReceipt: any = { language: [{ key: lang.key, imageTag: lang.image, engine: structuredClone(engine), observedImage: { Id: lang.imageId, RepoDigests: inspectedLang.RepoDigests, Descriptor: null }, status: 'BUILT_TOOLS_CHECKED_NOT_LSP_FUNCTIONAL_ACCEPTANCE',
    tools: probes.map(p => ({ ...p, name: 'paircoach-stage09-language-' + p.name, container: container(lang.imageId, 'language-tool-probe', p.name), status: 'TOOL_PROBE_PASS_REMOVED' })) }] };
  const languageReceiptPath = join(root, 'language-receipt.json');
  const write = () => { fs.writeFileSync(join(prepared, 'receipt.json'), JSON.stringify(receipt)); fs.writeFileSync(languageReceiptPath, JSON.stringify(languageReceipt)); }; write();
  const runtime: ResolvedRuntime = { configurationGeneration: 'cfg', configPath: join(root, 'config.json'), workspaceRoot: workspace, catalog, profile, image, languageImage: lang, imageLock: { schemaVersion: 1, images: [image, lang] },
    config: { schemaVersion: 1, activeProfile: profile.id, workspaceRoot: workspace, runtimeCatalog: 'catalog.json', imageLock: 'images.lock.json', languageFeatures: { completion: true, diagnostics: true }, execution: { backend: 'docker', pullPolicy: 'never' } } };
  const calls: string[][] = []; let hook: ((args: readonly string[]) => void | Promise<void>) | null = null;
  const transport: DockerTransport = { run: async args => { calls.push([...args]); await hook?.(args); return { exitCode: 0, stderr: '', stdout: JSON.stringify(args[0] === 'info' ? engine : [args[2] === lang.imageId ? inspectedLang : inspected]) }; } };
  const mutations: string[][] = []; const driver: LanguageDockerDriver = { engineId: async () => engine.ID, inspect: async () => null, command: async a => { mutations.push([...a]); throw Error('No Docker mutation expected'); }, attach: () => { throw Error('No attach expected'); } };
  const joined = createSelectedCacheLanguageFactory({ ownedRoot: owned, journal: new DiskLanguageProcessJournal(journal), admission: new LanguageProcessAdmission(), driver, transport, preparedOutputRoots: [prepared], languageReceiptPath });
  const scope: LanguageProjectScope = { projectId: 'p', sessionId: 's', profile, configurationGeneration: 'cfg', providerGeneration: 'provider', shadowGeneration: 'shadow', connectionGeneration: 'connection', shadowDirectory: owned };
  const content = 'draft before ACK\n', document = { stamp: { projectId: 'p', sessionId: 's', profileId: profile.id, path, configurationGeneration: 'cfg', providerGeneration: 'provider', shadowGeneration: 'shadow', connectionGeneration: 'connection', modelLifetime: 'model', localModelVersion: 1, requestGeneration: 1, controlEpoch: 0, baseDocumentVersion: 1, documentVersion: null, contentSha256: codec.contentSha256(content) }, content, reason: 'OPEN' as const };
  const snapshot: RegistrySnapshot = { revision: 'revision1', documents: [document] }; let held = true, current = true, checks = 0;
  const source = { leaseId: snapshot.revision, projectRoot: workspace, files: joined.captureSource(workspace).files, overlays: [{ stamp: document.stamp, content }] };
  const lease: SelectedLanguageLease = { installationId: 'install', runtime, run, source, assertCurrent() { checks++; if (!held || !current) throw Error('Actual serialized control/settings lease revoked'); }, assertRetainedCurrent() { checks++; if (!current) throw Error('Retained source/control/settings lease revoked'); } };
  return { ...joined, root, owned, workspace, cache, path, snapshot, document, scope, lease, receipt, languageReceipt, languageReceiptPath, image, lang, engine, inspectedLang, calls, mutations, write,
    prepare: () => joined.authority.prepare(scope, snapshot, lease), create: () => joined.factory.create(scope, 'diagnostics', snapshot, callbacks),
    hook: (value: typeof hook) => { hook = value; }, revoke: () => { held = false; current = false; }, release: () => { held = false; }, get checks() { return checks; } };
}
test('production constructor uses exact actual resolver/producer policies, complete binary cache, current source and SEPARATE language image', async t => {
  const f = await fixture(t); assert.throws(() => f.create(), /No current/); await f.prepare();
  const binding = f.authority.capture(structuredClone(f.scope), structuredClone(f.snapshot));
  assert.equal(binding.imageId, f.lang.imageId); assert.notEqual(binding.imageId, f.image.imageId); assert.equal(binding.source.projectRoot, f.workspace);
  assert.notEqual(binding.source.projectRoot, f.receipt.request.project.root); assert.ok(Object.isFrozen(binding.prepared.files));
  const launch = f.create(), manifest: any = JSON.parse(fs.readFileSync(launch.generation!.wholeProjectManifestPath, 'utf8'));
  const dependency = 'site-packages/dependency.py', copied = join(launch.generation!.immutableShadowDirectory, '.paircoach-dependencies', dependency);
  assert.deepEqual(fs.readFileSync(copied), fs.readFileSync(join(f.cache, dependency))); assert.equal(binding.prepared.files.length, 3);
  assert.equal(fs.readFileSync(join(launch.generation!.immutableShadowDirectory, f.path), 'utf8'), f.document.content);
  assert.equal(fs.readFileSync(join(f.workspace, f.path), 'utf8'), 'disk before ACK\r\n'); assert.equal(manifest.identity.imageId, f.lang.imageId);
  assert.ok(f.calls.some(a => a[2] === f.image.imageId)); assert.ok(f.calls.some(a => a[2] === f.lang.imageId)); assert.ok(f.checks > 10); assert.deepEqual(f.mutations, []);
  assert.deepEqual(await launch.session.retire(), { confirmed: true, removed: true, problem: null });
});
test('same real lease revoked DURING actual resolver await cannot prepare, copy or mutate', async t => {
  const f = await fixture(t); f.hook(() => f.revoke()); await assert.rejects(f.prepare()); assert.throws(() => f.create()); assert.deepEqual(f.mutations, []);
});
test('new inactive source during LANGUAGE inspect is detected without a watcher/version event', async t => {
  const f = await fixture(t); f.hook(a => { if (a[2] === f.lang.imageId) fs.writeFileSync(join(f.workspace, 'new-inactive.txt'), 'external'); });
  await assert.rejects(f.prepare(), /inventory changed/); assert.throws(() => f.create()); assert.deepEqual(f.mutations, []);
});
for (const change of ['inactive-delete','empty-dir','dependency-raw','root-replaced','settings-input','scope','overlay','release'] as const) {
  test('retained sync currentness rejects after fresh selection: ' + change, async t => {
    const f = await fixture(t); await f.prepare(); const b = f.authority.capture(f.scope, f.snapshot);
    if (change === 'inactive-delete') fs.unlinkSync(join(f.workspace, 'inactive.txt'));
    if (change === 'empty-dir') fs.mkdirSync(join(f.workspace, 'new-empty'));
    if (change === 'dependency-raw') fs.writeFileSync(join(f.workspace, 'requirements.txt'), 'dependency==1\n');
    if (change === 'root-replaced') { fs.renameSync(f.workspace, f.workspace + '-old'); fs.cpSync(f.workspace + '-old', f.workspace, { recursive: true }); }
    if (change === 'settings-input') f.lease.run.timeoutMs++;
    if (change === 'scope') f.scope.connectionGeneration = 'foreign';
    if (change === 'overlay') f.lease.source.overlays[0].content = 'new draft';
    if (change === 'release') f.revoke();
    assert.equal(f.authority.isCurrent(f.scope, f.snapshot, b), false); assert.throws(() => f.create()); assert.deepEqual(f.mutations, []);
  });
}
test('selected complete cache is re-hashed by real ShadowStore: byte tamper is never truncated/fallback', async t => {
  const f = await fixture(t); await f.prepare(); fs.writeFileSync(join(f.cache, 'site-packages/dependency.py'), 'tampered'); assert.throws(() => f.create(), /inventory\/manifest mismatch/); assert.deepEqual(f.mutations, []);
});
for (const change of ['missing','config-id','digest','user','entrypoint','engine','tool-version','probe-owner','probe-running','receipt-replaced','run-as-language'] as const) {
  test('separate LANGUAGE proof refuses ' + change, async t => {
    const f = await fixture(t);
    if (change === 'missing') f.languageReceipt.language = [];
    if (change === 'config-id') f.inspectedLang.Id = f.image.imageId;
    if (change === 'digest') f.inspectedLang.RepoDigests = [];
    if (change === 'user') f.inspectedLang.Config.User = '0';
    if (change === 'entrypoint') f.inspectedLang.Config.Entrypoint = ['/evil'];
    if (change === 'engine') f.languageReceipt.language[0].engine.ID = 'foreign';
    if (change === 'tool-version') f.languageReceipt.language[0].tools[0].inventory.packages.jedi = 'wrong';
    if (change === 'probe-owner') f.languageReceipt.language[0].tools[0].container.Config.Labels['paircoach.role'] = 'execution';
    if (change === 'probe-running') f.languageReceipt.language[0].tools[0].container.State.Running = true;
    if (change === 'run-as-language') f.lang.imageId = f.image.imageId;
    f.write();
    if (change === 'receipt-replaced') f.hook(a => { if (a[2] === f.lang.imageId) fs.appendFileSync(f.languageReceiptPath, ' '); });
    await assert.rejects(f.prepare()); assert.throws(() => f.create()); assert.deepEqual(f.mutations, []);
  });
}
test('Java target21 and independent server27 versions come from ACTUAL selected catalog and measured probe records', async t => {
  const f = await fixture(t, 'java-maven'); await f.prepare(); const launch = f.create();
  const config: any = JSON.parse(fs.readFileSync(join(f.owned, launch.session.launchId, 'boot/language-launch.json'), 'utf8'));
  assert.equal(f.scope.profile.compilerRelease, 21); assert.equal(f.lang.tools.find(t => t.name === 'java')?.version, f.scope.profile.language.serverJvm);
  assert.ok(JSON.stringify(config).includes('/opt/jdk27/bin/java')); assert.equal(launch.generation!.sources[0].sourceStamp.path, 'Main.java');
  await launch.session.retire();
});
test('prepare is not a permanent READY grant: explicit invalidation erases current authority', async t => {
  const f = await fixture(t); await f.prepare(); const binding = structuredClone(f.authority.capture(f.scope, f.snapshot));
  assert.equal(f.authority.isCurrent(structuredClone(f.scope), structuredClone(f.snapshot), binding), true);
  binding.prepared.files = []; assert.equal(f.authority.isCurrent(f.scope, f.snapshot, binding), false);
  f.authority.invalidate(); assert.throws(() => f.create());
});
test('an accidentally ASYNC ACK lease is refused before resolver IO, not mistaken for sync authority', async t => {
  const f = await fixture(t); const invalid = { ...f.lease, assertCurrent: async () => {} };
  await assert.rejects(f.authority.prepare(f.scope, f.snapshot, invalid), /Synchronous current lease/);
  assert.equal(f.calls.length, 0); assert.deepEqual(f.mutations, []);
});
test('newer explicit prepare supersedes an older pending observer; the old result cannot overwrite it', async t => {
  const f = await fixture(t); let arrived!: () => void, release!: () => void, first = true;
  const waiting = new Promise<void>(resolve => { arrived = resolve; }), unblock = new Promise<void>(resolve => { release = resolve; });
  f.hook(async () => { if (first) { first = false; arrived(); await unblock; } });
  const old = f.prepare(); await waiting; await f.prepare(); const b = f.authority.capture(f.scope, f.snapshot);
  release(); await assert.rejects(old); assert.equal(f.authority.isCurrent(f.scope, f.snapshot, b), true);
});
test('complete selected cache exceeding stricter language depth is visibly refused, never silently excluded', async t => {
  const f = await fixture(t); const nested = Array.from({ length: 34 }, () => 'd').join('/');
  fs.mkdirSync(join(f.cache, nested), { recursive: true }); fs.writeFileSync(join(f.cache, nested, 'raw.bin'), Buffer.from([0,255]));
  await f.prepare(); const binding = f.authority.capture(f.scope, f.snapshot); assert.equal(binding.prepared.files.length, 4);
  assert.throws(() => f.create(), /depth limit/); assert.deepEqual(f.mutations, []);
});
test('retained source proof fences startup after sync factory copy, before any actual Docker effect', async t => {
  const f = await fixture(t); await f.prepare(); const launch = f.create(); fs.writeFileSync(join(f.workspace, 'inactive.txt'), 'externally changed');
  await assert.rejects(launch.session.start(), /Stale production language binding/); assert.deepEqual(f.mutations, []);
  assert.deepEqual(await launch.session.retire(), { confirmed: true, removed: true, problem: null });
});
test('FIFO release after actual copy retains full-vector dispatch proof but cannot authorize another copy', async t => {
  const f = await fixture(t); await f.prepare(); const binding = f.authority.capture(f.scope, f.snapshot), launch = f.create(); f.release();
  assert.equal(f.authority.isCurrent(f.scope, f.snapshot, structuredClone(binding)), true);
  assert.throws(() => f.create(), /serialized control\/settings lease revoked/);
  await assert.rejects(launch.session.start(), /No Docker mutation expected/);
  assert.equal(f.mutations[0]?.[0], 'create'); // FAKE driver was reached, not refused by an expired held lock.
  await launch.session.retire();
});
test('FIFO release DURING selected preparation cannot publish authority or transfer a process owner', async t => {
  const f = await fixture(t); f.hook(a => { if (a[2] === f.lang.imageId) f.release(); });
  await assert.rejects(f.prepare(), /serialized control\/settings lease revoked/); assert.throws(() => f.create()); assert.deepEqual(f.mutations, []);
});

for (const input of ['malformed-receipt','observer-error'] as const) {
  test('LANGUAGE admission redacts private parser/transport errors: ' + input, async t => {
    const f = await fixture(t);
    if (input === 'malformed-receipt') fs.writeFileSync(f.languageReceiptPath, '{"private":"SENTINEL-private-path",bad}');
    else f.hook(a => { if (a[2] === f.lang.imageId) throw Error('SENTINEL-private-path transport stderr'); });
    await assert.rejects(f.prepare(), e => e instanceof Error && !e.message.includes('SENTINEL') && /explicit verified preparation/.test(e.message));
    assert.deepEqual(f.mutations, []);
  });
}
