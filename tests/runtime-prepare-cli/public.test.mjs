/** UNIT: real isolated filesystem + explicit injected producers/Docker. No real acquisition/daemon. */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { parseArguments, buildPublicPreparePlan, executePublicPreparePlan, measuredImageEntry } from '../../scripts/runtime-prepare-cli.mjs';
import { resolvePreparedToolchainIdentity, prepare } from '../../scripts/runtime-prepare.mjs';
import { receiptWriter } from '../../scripts/runtime-files.mjs';
const repo = process.cwd();
const hash = b => createHash('sha256').update(b).digest('hex');
const digest = 'sha256:' + 'b'.repeat(64), id = 'sha256:' + 'a'.repeat(64);
const engine = { ID: 'unit-only-engine', ServerVersion: '29.7.2', OSType: 'linux', Architecture: 'x86_64' };
const descriptor = { mediaType: 'application/vnd.oci.image.index.v1+json', size: 856, digest };
const put = (f, b) => fs.writeFileSync(f, b, { mode: 0o600 });
const json = p => JSON.parse(fs.readFileSync(p, 'utf8'));
function fixture(t, { profile = 'javascript-node', example = 'javascript-counter', dir = 'app' } = {}) {
  const root = fs.mkdtempSync(path.join(process.env.TMPDIR ?? path.dirname(repo), 'public-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const project = path.join(root, 'project'), work = dir === '.' ? project : path.join(project, dir), output = path.join(root, 'output');
  fs.mkdirSync(project, { mode: 0o700 });
  if (dir !== '.') fs.mkdirSync(work, { mode: 0o700 });
  fs.cpSync(path.join(repo, 'examples', example), work, { recursive: true });
  const fragment = json(path.join(work, 'task.v2.json'));
  const settings = { schemaVersion: 2, taskFilePath: null, taskMode: 'IMPLEMENTATION', reviewNotesPath: 'notes.md', aiConsent: false, contextPatterns: [], runProfiles: fragment.runProfiles.map(p => ({ ...p, task: { ...p.task, workingDirectory: dir } })) };
  fs.mkdirSync(path.join(project, '.paircoach'), { mode: 0o700 });
  const file = path.join(project, '.paircoach/settings.json');
  put(file, JSON.stringify(settings));
  return { root, project, output, work, file, settings, argv: ['--project', project, '--profile', profile, '--output', output] };
}
function tree(root) {
  return fs.readdirSync(root, { recursive: true }).sort().map(r => { const f = path.join(root, r), s = fs.lstatSync(f); return [r, s.isFile() ? hash(fs.readFileSync(f)) : 'dir']; });
}
// Actual createDockerClientState/beginDockerCommand contract: ONLY these three keys,
// private per-output home/buildx and a fresh empty per-command credential directory.
function assertClient(exe, args, options, root, used) {
  assert.equal(exe, 'docker'); assert.equal(options.shell, false);
  assert.deepEqual(Object.keys(options.env).sort(), ['BUILDX_CONFIG', 'HOME', 'PATH']);
  assert.equal(options.env.PATH, process.env.PATH);
  assert.equal(options.env.HOME, path.join(root, 'docker-home'));
  assert.equal(options.env.BUILDX_CONFIG, path.join(root, 'docker-buildx'));
  assert.equal(args[0], '--host');
  assert.equal(args[1], process.platform === 'win32' ? 'npipe:////./pipe/docker_engine' : 'unix:///var/run/docker.sock');
  assert.equal(args[2], '--config');
  const config = args[3];
  assert.equal(path.dirname(config), path.join(root, 'docker-config'));
  assert.match(path.basename(config), /^command-[0-9]{6}$/);
  assert.equal(used.has(config), false, 'credential directory must never be reused');
  for (const dir of [root, options.env.HOME, options.env.BUILDX_CONFIG, path.dirname(config), config]) {
    const st = fs.lstatSync(dir);
    assert.equal(st.isSymbolicLink(), false); assert.equal(st.isDirectory(), true);
    assert.equal(fs.realpathSync(dir), dir);
    if (process.platform !== 'win32') { assert.equal(st.mode & 0o777, 0o700); assert.equal(st.uid, process.getuid()); }
  }
  assert.deepEqual(fs.readdirSync(config), []);
  used.add(config);
}
function unitTransport(root, observed = { Id: id, Descriptor: descriptor, RepoDigests: [] }) {
  const calls = [], used = new Set();
  let inspections = 0;
  const invoke = (exe, args, options) => {
    calls.push({ exe, args, options });
    assertClient(exe, args, options, root, used);
    assert.ok(options.timeout > 0 && options.timeout <= 480000);
    const cmd = args.slice(4);
    if (cmd[0] === 'info') return { status: 0, signal: null, stdout: JSON.stringify(engine), stderr: '' };
    if (cmd[0] === 'image') return { status: 0, signal: null, stdout: JSON.stringify([{ ...(typeof observed === 'function' ? observed(cmd, ++inspections) : observed), Config: { User: '10001:10001', Entrypoint: null } }]), stderr: '' };
    throw new Error('Unexpected UNIT Docker operation');
  };
  return { invoke, calls };
}
function unitProducers() {
  const calls = [];
  return { calls,
    stageInputs: async root => { calls.push('stage'); fs.mkdirSync(root, { mode: 0o700 }); },
    prepare: (request, execute, deadline, actualEngine, transport) => {
      calls.push('prepare'); assert.equal(execute, true); assert.deepEqual(actualEngine, engine); assert.ok(deadline > Date.now()); assert.ok(transport.endpoint); assert.ok(transport.configDirectory);
      const publish = receiptWriter(request.outputRoot);
      const identity = resolvePreparedToolchainIdentity(request), tools = request.expectedTools.map(t => ({ ...t, raw: 'UNIT actual probe stdout ' + t.version }));
      const cache = path.join(request.outputRoot, 'cache', request.family, identity.toolchainHash, request.dependencySha256);
      fs.mkdirSync(cache, { recursive: true, mode: 0o700 });
      const deps = { family: request.family, workingDirectory: request.workingDirectory, dependencySha256: request.dependencySha256, tools, preparedAt: '2026-11-11T00:00:00Z' };
      put(path.join(cache, 'tools.json'), JSON.stringify(tools)); put(path.join(cache, 'dependencies-prepared.json'), JSON.stringify(deps));
      const r = { schemaVersion: 1, status: 'PREPARED_REQUIRES_OFFLINE_AND_TOOL_VALIDATION', request, ...identity, engine: actualEngine, imageId: id, observedImage: { Id: id, Descriptor: descriptor, RepoDigests: [] },
        imageInspect: { Id: id, Descriptor: descriptor, RepoDigests: [], Config: { User: '10001:10001', Entrypoint: null } }, imageRetention: { pins: [] },
        cacheEvidence: { root: cache, tools: { path: 'tools.json', sha256: hash(JSON.stringify(tools)), actual: tools }, dependencies: { path: 'dependencies-prepared.json', sha256: hash(JSON.stringify(deps)), actual: deps } } };
      publish(r); return r;
    },
    prepareLanguageImages: () => { throw new Error('Builtin must not prepare language images'); },
  };
}

test('strict argv refuses duplicates, unsafe/relative paths and all unrecognized flags', () => {
  for (const a of [[], ['--execute'], ['--project', '/x', '--profile', 'p', '--output', '/y', '--execute', '--execute'], ['--project', 'relative', '--profile', 'p', '--output', '/y'], ['--project', '/x', '--profile', 'p', '--output', '/y', '--host', 'x'], ['--project', '/x', '--profile', 'bad;p', '--output', '/y'], ['--project', '/x/../x', '--profile', 'p', '--output', '/y'], ['--project', '/x', '--project', '/x', '--output', '/y']]) assert.throws(() => parseArguments(a));
});

test('actual default argv reads full V2/non-dot/current raw; deterministic with zero writes, network or children', async t => {
  const f = fixture(t), before = tree(f.root);
  // Poison global fetch: executing download in the exported default path fails this test.
  const fetch = globalThis.fetch; globalThis.fetch = () => { throw new Error('PLAN attempted network'); };
  try {
    const p = await buildPublicPreparePlan(f.argv), again = await buildPublicPreparePlan(f.argv);
    assert.deepEqual(p, again); assert.equal(p.status, 'PLAN_ONLY'); assert.equal(p.workingDirectory, 'app');
    assert.ok(p.sourceInventory.some(f => f.path === 'app/main.js')); assert.ok(!p.sourceInventory.some(f => f.path.startsWith('.paircoach')));
    assert.equal(p.request.workingDirectory, 'app'); assert.equal(p.offlineFixtureContainers, 0); assert.deepEqual(tree(f.root), before);
    const child = spawnSync(process.execPath, ['--permission', '--allow-fs-read=*', 'scripts/runtime-prepare-cli.mjs', ...f.argv], { cwd: repo, env: { PATH: '', HOME: f.root }, encoding: 'utf8' });
    assert.equal(child.status, 0, child.stderr); assert.equal(JSON.parse(child.stdout).status, 'PLAN_ONLY'); assert.deepEqual(tree(f.root), before);
  } finally { globalThis.fetch = fetch; }
});

test('legacy/mixed/missing/settings link/fragment refused unchanged; no migration', async t => {
  for (const value of [{ runProfiles: [] }, { ...fixtureSettings(), commands: [] }, { schemaVersion: 2 }]) {
    const f = fixture(t); put(f.file, JSON.stringify(value)); const before = tree(f.root);
    await assert.rejects(buildPublicPreparePlan(f.argv)); assert.deepEqual(tree(f.root), before);
  }
  const f = fixture(t); fs.unlinkSync(f.file); await assert.rejects(buildPublicPreparePlan(f.argv), /Save full V2/);
  put(path.join(f.root, 'external.json'), JSON.stringify(f.settings)); fs.symlinkSync(path.join(f.root, 'external.json'), f.file);
  await assert.rejects(buildPublicPreparePlan(f.argv), /Save full V2/);
});
function fixtureSettings() { return { schemaVersion: 2, runProfiles: [], taskFilePath: null, taskMode: 'IMPLEMENTATION', reviewNotesPath: 'notes.md', aiConsent: false, contextPatterns: [] }; }

test('profile/source conflict, different per-mode directories, unsafe/private selectors and unknown profile refused', async t => {
  const f = fixture(t); f.settings.runProfiles[1].task.workingDirectory = '.'; put(f.file, JSON.stringify(f.settings));
  await assert.rejects(buildPublicPreparePlan(f.argv), /Different per-mode/);
  for (const entry of [{ kind: 'SCRIPT', path: '../main.js' }, { kind: 'SCRIPT', path: '.paircoach/settings.json' }, { kind: 'SCRIPT', path: 'absent.js' }]) {
    const f = fixture(t); f.settings.runProfiles[0].task.entry = entry; put(f.file, JSON.stringify(f.settings)); await assert.rejects(buildPublicPreparePlan(f.argv));
  }
  const g = fixture(t); await assert.rejects(buildPublicPreparePlan(g.argv.map(a => a === 'javascript-node' ? 'unknown' : a)), /Unknown approved/);
  fs.symlinkSync(path.join(g.work, 'main.js'), path.join(g.work, 'link.js')); await assert.rejects(buildPublicPreparePlan(g.argv), /symlink/i);
});

test('selected Java JDK independent of source target; preview/unsafe guards retained without rewrite/network', async t => {
  const f = fixture(t, { profile: 'java-maven-11', example: 'java-pattern' });
  const good = await buildPublicPreparePlan(f.argv); assert.match(good.pom, /EFFECTIVE_POM_PENDING/);
  const pom = path.join(f.work, 'pom.xml'), original = fs.readFileSync(pom, 'utf8');
  for (const profile of ['java-maven-11','java-maven-17','java-maven-21','java-maven-27']) {
    const plan = await buildPublicPreparePlan(f.argv.map(a => a === 'java-maven-11' ? profile : a));
    assert.equal(plan.profile.id, profile);assert.equal(fs.readFileSync(pom,'utf8'),original);
  }
  const newerTarget=original.replace('<maven.compiler.release>11','<maven.compiler.release>21');
  put(pom,newerTarget);await buildPublicPreparePlan(f.argv);assert.equal(fs.readFileSync(pom,'utf8'),newerTarget);
  for (const text of [original.replace('<maven.compiler.release>11','<maven.compiler.release>bad'), original.replace('</properties>', '<maven.compiler.enablePreview>true</maven.compiler.enablePreview></properties>'), '<!DOCTYPE x><project/>']) {
    put(pom, text); await assert.rejects(buildPublicPreparePlan(f.argv)); assert.equal(fs.readFileSync(pom, 'utf8'), text);
  }
});

test('output existing/private ancestry/overlap and symlink project rejected before mutation', async t => {
  const f = fixture(t); fs.mkdirSync(f.output); await assert.rejects(buildPublicPreparePlan(f.argv), /already exists/); fs.rmdirSync(f.output);
  await assert.rejects(buildPublicPreparePlan([...f.argv.slice(0, -1), path.join(f.project, 'new')]), /separate|private parent/);
  const alias = path.join(f.root, 'alias'); fs.symlinkSync(f.project, alias); await assert.rejects(buildPublicPreparePlan(f.argv.map(a => a === f.project ? alias : a)), /ancestry/);
  if (process.platform !== 'win32') { fs.chmodSync(f.root, 0o755); await assert.rejects(buildPublicPreparePlan(f.argv), /private parent/); }
});

test('source/settings drift and tampered plan refused before output or injected producers', async t => {
  for (const kind of ['source', 'settings', 'plan']) {
    const f = fixture(t), plan = await buildPublicPreparePlan(f.argv);
    if (kind === 'source') put(path.join(f.work, 'main.js'), '// changed');
    if (kind === 'settings') put(f.file, JSON.stringify({ ...f.settings, aiConsent: true }));
    if (kind === 'plan') plan.request.workingDirectory = '.';
    await assert.rejects(executePublicPreparePlan(plan, { spawnSync: () => { throw Error('must not run'); } }), /changed/);
    assert.equal(fs.existsSync(f.output), false);
  }
});

test('genuine Descriptor/index and RepoDigest accepted, including genuine Id=digest; missing/malformed/configId/mismatch refused', () => {
  const tools = [{ name: 'node', version: '22.22.0' }];
  assert.equal(measuredImageEntry('runtime', 'paircoach/runtime:stage09', { Id: id, Descriptor: descriptor, RepoDigests: [] }, id, tools).digest, digest);
  assert.equal(measuredImageEntry('runtime', 'paircoach/runtime:stage09', { Id: id, Descriptor: { ...descriptor, digest: id }, RepoDigests: [] }, id, tools).digest, id);
  assert.equal(measuredImageEntry('runtime', 'paircoach/runtime:stage09', { Id: id, Descriptor: null, RepoDigests: ['paircoach/runtime@' + digest] }, id, tools).digest, digest);
  for (const value of [{ Id: id, Descriptor: null, RepoDigests: [] }, { Id: id, Descriptor: { digest }, RepoDigests: [] }, { Id: id, Descriptor: { ...descriptor, size: 0 }, RepoDigests: [] }, { Id: id, Descriptor: descriptor, RepoDigests: ['repo@' + id] }, { Id: digest, Descriptor: descriptor, RepoDigests: [] }, { Id: id, Descriptor: null, RepoDigests: ['bad@sha256:xyz'] }]) assert.throws(() => measuredImageEntry('runtime', 'paircoach/runtime:stage09', value, id, tools), /NOTREADY/);
});

test('UNIT execute reuses actual receipt/helper, selected one-profile lock/config passes actual guards+loader, exact output stdout selectors', async t => {
  const f = fixture(t), plan = await buildPublicPreparePlan(f.argv), transport = unitTransport(f.output), producers = unitProducers();
  const beforeProject = tree(f.project), result = await executePublicPreparePlan(plan, { ...producers, spawnSync: transport.invoke });
  assert.equal(result.status, 'PREPARED_CONFIG_GENERATED_NOT_ACCEPTANCE'); assert.deepEqual(producers.calls, ['stage', 'prepare']);
  assert.equal(result.preparedRuntime, plan.preparedRuntime); assert.equal(result.runtimeConfig, plan.runtimeConfig);
  assert.deepEqual(result.startupArgs, ['--prepared-runtime', plan.preparedRuntime, '--runtime-config', plan.runtimeConfig]);
  assert.deepEqual(tree(f.project), beforeProject);
  assert.equal(json(path.join(f.output, 'catalog.json')).profiles.length, 1); assert.equal(json(path.join(f.output, 'images.lock.json')).images.length, 1);
  assert.equal(json(plan.runtimeConfig).workspaceRoot, f.project); assert.equal(json(path.join(f.output, 'receipt.json')).finalQa, 'NOT_RUN');
  assert.ok(transport.calls.length >= 3);
});

test('UNIT absent manifest leaves explicit NOTREADY and no usable generated artifacts/config; raw receipt retained', async t => {
  const f = fixture(t), p = await buildPublicPreparePlan(f.argv);
  // First two real retention reads (ID/reference) remain valid. The third is
  // the actual publication observation: its missing manifest MUST stay NOTREADY.
  const transport = unitTransport(f.output, (cmd, n) => {
    assert.equal(cmd[0], 'image'); assert.equal(cmd[1], 'inspect');
    if (n === 3) { assert.equal(cmd[2], id); return { Id: id, Descriptor: null, RepoDigests: [] }; }
    assert.ok(n < 3); return { Id: id, Descriptor: descriptor, RepoDigests: [] };
  });
  const result = await executePublicPreparePlan(p, { ...unitProducers(), spawnSync: transport.invoke });
  assert.equal(result.status, 'NOTREADY'); assert.equal(result.runtimeConfig, null);
  assert.match(result.problem, /genuine matching manifest\/index Descriptor or RepoDigest required/);
  assert.equal(transport.calls.filter(c => c.args[4] === 'image').length, 3);
  for (const name of ['runtime-config.json', 'images.lock.json', 'catalog.json']) assert.equal(fs.existsSync(path.join(f.output, name)), false);
  assert.equal(json(path.join(p.preparedRuntime, 'receipt.json')).imageId, id);
});

test('UNIT failed/unknown transport or same-engine drift retains durable error, no retry/config', async t => {
  for (const failure of ['timeout', 'switch']) {
    const f = fixture(t), p = await buildPublicPreparePlan(f.argv); let calls = 0;
    const producers = unitProducers();
    await assert.rejects(executePublicPreparePlan(p, { ...producers, spawnSync: () => { calls++; return failure === 'timeout' ? { status: null, error: new Error('timeout'), stdout: '', stderr: '' } : { status: 0, stdout: JSON.stringify({ ...engine, ID: calls === 1 ? engine.ID : 'switched' }), stderr: '' }; } }));
    assert.equal(calls, failure === 'timeout' ? 1 : 2); assert.equal(json(path.join(f.output, 'receipt.json')).status, 'FAILED_RETAIN_AND_RECONCILE'); assert.equal(fs.existsSync(p.runtimeConfig), false);
  }
});

// Task1 owner064364a7: removed test of retired LSP producer; history stays in Git.

test('actual producer default plan compatible; optional explicit transport logs argv, propagates unknown failure without retry', async t => {
  const f = fixture(t), install = path.join(f.root, 'install');
  fs.mkdirSync(install); fs.mkdirSync(path.join(install, 'scripts')); fs.mkdirSync(path.join(install, 'runtimes'));
  // Unchanged actual source in a small UNIT installed-metadata sandbox, not a production pin proof.
  for (const name of ['runtime-prepare.mjs', 'runtime-files.mjs', 'runtime-spec.mjs', 'runtime-dependencies.mjs', 'runtime-task.mjs', 'runtime-pom.mjs', 'runtime-cache.mjs', 'runtime-tools.mjs', 'runtime-artifacts.mjs', 'runtime-image-retention.mjs']) fs.copyFileSync(path.join(repo, 'scripts', name), path.join(install, 'scripts', name));
  fs.mkdirSync(path.join(install, 'docker')); fs.copyFileSync(path.join(repo, 'docker/runtime.Dockerfile'), path.join(install, 'docker/runtime.Dockerfile'));
  const profile = json(path.join(repo, 'runtimes/catalog.json')).profiles.find(p => p.id === 'javascript-node'), pin = 'node@sha256:' + '1'.repeat(64);
  const toolsRoot = path.join(f.root, 'tools'); fs.mkdirSync(toolsRoot); fs.mkdirSync(path.join(toolsRoot, 'node_modules')); fs.mkdirSync(path.join(toolsRoot, 'node_modules/unit')); put(path.join(toolsRoot, 'node_modules/unit/x'), 'unit');
  put(path.join(install, 'runtimes/catalog.json'), JSON.stringify({ profiles: [profile] }));
  put(path.join(install, 'runtimes/production-inputs.lock.json'), JSON.stringify({ images: { node: { reference: pin }, maven: { reference: 'maven@sha256:be898b0cf3929205778d61b2841aa36733513a79b0404f9cac67837863c8641f' } }, artifacts: [{ kind: 'npm', name: 'unit', files: [{ path: 'x', sha256: hash('unit') }] }] }));
  const projectRoot = path.join(f.root, 'only-input'); fs.mkdirSync(projectRoot); put(path.join(projectRoot, 'main.js'), 'unit');
  const req = { schemaVersion: 1, workingDirectory: '.', installationId: 'unit', family: 'node', key: profile.id, imageTag: 'paircoach/runtime-unit:unit', baseImage: pin, nodeImage: pin,
    tools: { root: toolsRoot, files: [{ path: 'node_modules/unit/x', sha256: hash('unit') }] }, project: { root: projectRoot, files: [{ path: 'main.js', sha256: hash('unit') }] }, expectedTools: profile.expectedTools, dependencySha256: hash('[]'), outputRoot: path.join(f.root, 'default') };
  const { prepare: actual, createDockerClientState: actualClient } = await import(new URL('file://' + path.join(install, 'scripts/runtime-prepare.mjs')));
  const planned = actual(req); assert.equal(planned.status, 'PLAN_ONLY_NOT_PREPARED'); assert.deepEqual(planned.commands, []); assert.equal(planned.endpoint, undefined);
  const clientRoot = path.join(f.root, 'client'); fs.mkdirSync(clientRoot, { mode: 0o700 });
  const clientState = actualClient(clientRoot), configDirectory = clientState.configDirectory, used = new Set();
  let calls = 0; const endpoint = process.platform === 'win32' ? 'npipe:////./pipe/docker_engine' : 'unix:///var/run/docker.sock'; req.outputRoot = path.join(f.root, 'transport');
  assert.throws(() => actual(req, true, Date.now() + 10000, null, { endpoint, configDirectory, clientState, spawnSync: (exe, argv, options) => {
    calls++; assertClient(exe, argv, options, clientRoot, used);
    return { status: null, error: new Error('UNIT transport unknown'), stdout: '', stderr: '' };
  } }), /failed|reconcile/);
  assert.equal(calls, 1); const failed = json(path.join(req.outputRoot, 'receipt.json'));
  assert.equal(failed.status, 'FAILED_RETAIN_AND_RECONCILE'); assert.deepEqual(failed.commands[0].argv.slice(0, 5), ['docker', '--host', endpoint, '--config', [...used][0]]);
  assert.equal(failed.commands[0].configDirectory, configDirectory);
  // A structurally identical object is NOT the actual issuer's in-process capability.
  for (const [name, transport, error] of [
    ['forged', { endpoint, configDirectory, clientState: { ...clientState } }, /Unowned Docker client/],
    ['alias', { endpoint, configDirectory: clientState.homeDirectory, clientState }, /alias\/outside/],
  ]) {
    req.outputRoot = path.join(f.root, name);
    assert.throws(() => actual(req, true, Infinity, null, { ...transport, spawnSync: () => assert.fail('unsafe transport must not spawn') }), error);
    assert.equal(fs.existsSync(req.outputRoot), false);
  }
  req.outputRoot = path.join(f.root, 'unsafe'); put(path.join(configDirectory, 'config.json'), '{}');
  assert.throws(() => actual(req, true, Infinity, null, { endpoint, configDirectory, clientState }), /credential pool entry/); assert.equal(fs.existsSync(req.outputRoot), false);
});

test('actual language primitive selected-only and default BOTH complete real FS/injected Docker probes', { skip: 'SUPERSEDED_BY_OWNER_LIGHTWEIGHT_POLICY c905 §2: JDT/pylsp acquisition/probes withdrawn; body/history retained, not PASS' }, t => {
  const f = fixture(t), jdt = Buffer.from('UNIT jdt artifact'), wheel = Buffer.from('UNIT wheel artifact');
  const lock = { images: Object.fromEntries(['java11', 'java17', 'java21', 'java27', 'python'].map(k => [k, { reference: k + '@' + digest }])), language: {
    pylsp: { pythonVersion: '3.13.9' }, artifacts: [{ kind: 'jdt', bytes: jdt.length, sha256: hash(jdt) }, { kind: 'language-wheel', name: 'unit-package', version: '1.0.0', filename: 'unit.whl', bytes: wheel.length, sha256: hash(wheel) }],
  } };
  const javaVersion = json(path.join(repo, 'runtimes/catalog.json')).profiles.find(p => p.id === 'java-maven-27').language.serverJvm;
  for (const kinds of [['python'], ['java'], undefined]) {
    const root = path.join(f.root, 'language-' + (kinds?.join('-') ?? 'default')); fs.mkdirSync(root); fs.mkdirSync(path.join(root, 'stage')); fs.mkdirSync(path.join(root, 'stage/language')); fs.mkdirSync(path.join(root, 'stage/wheels'));
    put(path.join(root, 'stage/language/jdt.tar.gz'), jdt); put(path.join(root, 'stage/wheels/unit.whl'), wheel);
    const commands = [], created = new Map(); let current;
    const run = args => {
      commands.push(args);
      if (args[0] === 'image') return { stdout: JSON.stringify([{ Id: id, Descriptor: descriptor, RepoDigests: [], Config: { User: '10001:10001' } }]), stderr: '' };
      if (args[0] === 'create') { current = args[args.indexOf('--name') + 1]; created.set(current, args); }
      if (args[0] === 'start') {
        const name = args.at(-1), version = name.includes('jdt-server-java') || name.endsWith('-27') ? javaVersion : name.endsWith('-11') ? '11.0.33' : name.endsWith('-17') ? '17.0.21' : '21.0.13';
        return { stdout: name.includes('python') ? JSON.stringify({ python: '3.13.9', packages: { 'unit-package': '1.0.0' } }) : name.includes('jdt-server-java') ? 'openjdk version "' + version + '"\n' : 'javac ' + version + '\n', stderr: '' };
      }
      if (args[0] === 'inspect') return { stdout: JSON.stringify([{ Id: 'c'.repeat(64), State: { Running: false, ExitCode: 0 }, Config: { Image: id, Labels: { 'paircoach.installation': 'stage09-runtime-assets', 'paircoach.role': 'language-tool-probe' } } }]), stderr: '' };
      if (args[0] === 'rm') assert.equal(args[1], 'c'.repeat(64));
      return { stdout: '', stderr: '' };
    };
    const receipt = { engine }, result = prepareLanguageImages(root, lock, { run, save: () => {}, receipt }, kinds);
    assert.deepEqual(result.map(i => i.key), (kinds ?? ['java', 'python']).map(k => k === 'java' ? 'jdt-runtime-27' : 'pylsp-runtime-3.13'));
    assert.ok(result.every(i => i.tools.every(t => t.status === 'TOOL_PROBE_PASS_REMOVED')));
    assert.equal(commands.filter(a => a[0] === 'build').length, kinds?.length ?? 2);
  }
});

// This case was mixed: remove ONLY the withdrawn pylsp requirement, keeping actual
// publication, observed-tool inventory and config-loader checks ACTIVE for Python.
test('UNIT Python builtin prepares only selected runtime tools and passes existing config loader without language acquisition', async t => {
  const f = fixture(t, { profile: 'python-3.13', example: 'python-calculator' }), p = await buildPublicPreparePlan(f.argv), producers = unitProducers(), transport = unitTransport(f.output);
  assert.equal(p.profile.language.provider, 'builtin'); assert.equal(p.languageRequired, null);
  assert.equal(p.profile.language.imageLockKey, null); assert.equal(p.profile.language.serverJvm, null);
  const result = await executePublicPreparePlan(p, { ...producers, spawnSync: transport.invoke });
  assert.equal(result.status, 'PREPARED_CONFIG_GENERATED_NOT_ACCEPTANCE');
  assert.deepEqual(producers.calls, ['stage', 'prepare']); // language producer throws if reached
  const images = json(path.join(f.output, 'images.lock.json')).images;
  assert.equal(images.length, 1); assert.equal(images[0].key, p.profile.imageLockKey);
  assert.deepEqual(images[0].tools, p.profile.expectedTools);
  assert.deepEqual(images[0].tools.map(t => t.name).sort(), ['node', 'pytest', 'python']);
  assert.deepEqual(json(path.join(f.output, 'receipt.json')).language, []);
  assert.deepEqual(json(path.join(f.output, 'catalog.json')).profiles, [p.profile]);
  assert.equal(json(result.runtimeConfig).activeProfile, 'python-3.13');
});

// Active negative controls for the revised fixture: BUILDX_CONFIG must not mean
// forwarding caller credentials, adopting nonempty config or hiding transport errors.
test('UNIT public transport isolates hostile inherited env without widening child keys or mutating caller env', async t => {
  const f = fixture(t), p = await buildPublicPreparePlan(f.argv), transport = unitTransport(f.output);
  const names = ['HOME', 'USERPROFILE', 'BUILDX_CONFIG', 'DOCKER_HOST', 'DOCKER_CONFIG', 'DOCKER_AUTH_CONFIG', 'AWS_SECRET_ACCESS_KEY', 'HTTP_PROXY', 'HTTPS_PROXY'];
  const original = Object.fromEntries(names.map(k => [k, process.env[k]]));
  const hostile = Object.fromEntries(names.map(k => [k, '/UNIT-HOSTILE-' + k]));
  try {
    Object.assign(process.env, hostile);
    const result = await executePublicPreparePlan(p, { ...unitProducers(), spawnSync: transport.invoke });
    assert.equal(result.status, 'PREPARED_CONFIG_GENERATED_NOT_ACCEPTANCE');
    assert.ok(transport.calls.length >= 3);
    for (const c of transport.calls) assert.equal(Object.values(c.options.env).some(v => Object.values(hostile).includes(v)), false);
    for (const k of names) assert.equal(process.env[k], hostile[k]);
  } finally { for (const k of names) { if (original[k] === undefined) delete process.env[k]; else process.env[k] = original[k]; } }
});

test('UNIT unexpected command credential write fails closed before producers without retry or usable config', async t => {
  const f = fixture(t), p = await buildPublicPreparePlan(f.argv), producers = unitProducers(), transport = unitTransport(f.output);
  await assert.rejects(executePublicPreparePlan(p, { ...producers, spawnSync: (exe, args, options) => {
    const reply = transport.invoke(exe, args, options);
    put(path.join(args[3], 'config.json'), '{}'); // simulated forbidden Docker child write
    return reply;
  } }), /Unexpected Docker credential config write/);
  assert.equal(transport.calls.length, 1); assert.deepEqual(producers.calls, []);
  const receipt = json(path.join(f.output, 'receipt.json'));
  assert.equal(receipt.status, 'FAILED_RETAIN_AND_RECONCILE'); assert.equal(receipt.commands.length, 1);
  for (const name of ['runtime-config.json', 'images.lock.json', 'catalog.json']) assert.equal(fs.existsSync(path.join(f.output, name)), false);
  assert.equal(fs.readFileSync(path.join(transport.calls[0].args[3], 'config.json'), 'utf8'), '{}', 'unknown state retained, never removed/reused');
});
