/** UNIT: real isolated filesystem + explicit injected producers/Docker. No real acquisition/daemon. */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { parseArguments, buildPublicPreparePlan, executePublicPreparePlan, measuredImageEntry } from '../../scripts/runtime-prepare-cli.mjs';
import { resolvePreparedToolchainIdentity, prepare } from '../../scripts/runtime-prepare.mjs';
import { prepareLanguageImages } from '../../scripts/runtime-language-prepare.mjs';
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
function unitTransport(observed = { Id: id, Descriptor: descriptor, RepoDigests: [] }) {
  const calls = [];
  const invoke = (exe, args, options) => {
    calls.push({ exe, args, options });
    assert.equal(exe, 'docker'); assert.equal(options.shell, false);
    assert.deepEqual(Object.keys(options.env).sort(), ['HOME', 'PATH']);
    assert.ok(options.timeout > 0 && options.timeout <= 480000);
    assert.equal(args[0], '--host'); assert.equal(args[2], '--config');
    assert.deepEqual(fs.readdirSync(args[3]), []);
    const cmd = args.slice(4);
    if (cmd[0] === 'info') return { status: 0, signal: null, stdout: JSON.stringify(engine), stderr: '' };
    if (cmd[0] === 'image') return { status: 0, signal: null, stdout: JSON.stringify([{ ...observed, Config: { User: '10001:10001', Entrypoint: null } }]), stderr: '' };
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

test('actual selected Java source POM/release/preview conflicts refused without rewrite or network', async t => {
  const f = fixture(t, { profile: 'java-maven-11', example: 'java-pattern' });
  const good = await buildPublicPreparePlan(f.argv); assert.match(good.pom, /EFFECTIVE_POM_PENDING/);
  const pom = path.join(f.work, 'pom.xml'), original = fs.readFileSync(pom, 'utf8');
  for (const text of [original.replace('<maven.compiler.release>11', '<maven.compiler.release>21'), original.replace('</properties>', '<maven.compiler.enablePreview>true</maven.compiler.enablePreview></properties>'), '<!DOCTYPE x><project/>']) {
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
  const f = fixture(t), plan = await buildPublicPreparePlan(f.argv), transport = unitTransport(), producers = unitProducers();
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
  const f = fixture(t), p = await buildPublicPreparePlan(f.argv), transport = unitTransport({ Id: id, Descriptor: null, RepoDigests: [] });
  const result = await executePublicPreparePlan(p, { ...unitProducers(), spawnSync: transport.invoke });
  assert.equal(result.status, 'NOTREADY'); assert.equal(result.runtimeConfig, null);
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

test('language kinds strict BEFORE any write/run; default BOTH preserved (source), selected-only failure does not enter other kind', t => {
  const f = fixture(t);
  for (const kinds of [[], ['java', 'java'], ['bogus'], ['java', 'python', 'java'], 'java']) {
    assert.throws(() => prepareLanguageImages(f.output, {}, { run: () => assert.fail(), save: () => assert.fail(), receipt: {} }, kinds), /language kinds/); assert.equal(fs.existsSync(f.output), false);
  }
  const root = path.join(f.root, 'languages'); fs.mkdirSync(root);
  let saved = 0;
  assert.throws(() => prepareLanguageImages(root, {}, { run: () => assert.fail(), save: () => saved++, receipt: {} }, ['python']));
  assert.ok(saved > 0); assert.equal(fs.existsSync(path.join(root, 'language-contexts/java')), false); assert.equal(fs.existsSync(path.join(root, 'language-contexts/python')), true);
  assert.match(fs.readFileSync('scripts/runtime-language-prepare.mjs', 'utf8'), /kinds=\['java','python'\]/);
});

test('actual producer default plan compatible; optional explicit transport logs argv, propagates unknown failure without retry', async t => {
  const f = fixture(t), install = path.join(f.root, 'install');
  fs.mkdirSync(install); fs.mkdirSync(path.join(install, 'scripts')); fs.mkdirSync(path.join(install, 'runtimes'));
  // Unchanged actual source in a small UNIT installed-metadata sandbox, not a production pin proof.
  for (const name of ['runtime-prepare.mjs', 'runtime-files.mjs', 'runtime-spec.mjs', 'runtime-dependencies.mjs', 'runtime-task.mjs', 'runtime-pom.mjs', 'runtime-cache.mjs', 'runtime-tools.mjs', 'runtime-artifacts.mjs']) fs.copyFileSync(path.join(repo, 'scripts', name), path.join(install, 'scripts', name));
  fs.mkdirSync(path.join(install, 'docker')); fs.copyFileSync(path.join(repo, 'docker/runtime.Dockerfile'), path.join(install, 'docker/runtime.Dockerfile'));
  const profile = json(path.join(repo, 'runtimes/catalog.json')).profiles[0], pin = 'node@sha256:' + '1'.repeat(64);
  const toolsRoot = path.join(f.root, 'tools'); fs.mkdirSync(toolsRoot); fs.mkdirSync(path.join(toolsRoot, 'node_modules')); fs.mkdirSync(path.join(toolsRoot, 'node_modules/unit')); put(path.join(toolsRoot, 'node_modules/unit/x'), 'unit');
  put(path.join(install, 'runtimes/catalog.json'), JSON.stringify({ profiles: [profile] }));
  put(path.join(install, 'runtimes/production-inputs.lock.json'), JSON.stringify({ images: { node: { reference: pin }, maven: { reference: 'maven@sha256:be898b0cf3929205778d61b2841aa36733513a79b0404f9cac67837863c8641f' } }, artifacts: [{ kind: 'npm', name: 'unit', files: [{ path: 'x', sha256: hash('unit') }] }] }));
  const projectRoot = path.join(f.root, 'only-input'); fs.mkdirSync(projectRoot); put(path.join(projectRoot, 'main.js'), 'unit');
  const req = { schemaVersion: 1, workingDirectory: '.', installationId: 'unit', family: 'node', key: profile.id, imageTag: 'paircoach/runtime-unit:unit', baseImage: pin, nodeImage: pin,
    tools: { root: toolsRoot, files: [{ path: 'node_modules/unit/x', sha256: hash('unit') }] }, project: { root: projectRoot, files: [{ path: 'main.js', sha256: hash('unit') }] }, expectedTools: profile.expectedTools, dependencySha256: hash('[]'), outputRoot: path.join(f.root, 'default') };
  const { prepare: actual } = await import(new URL('file://' + path.join(install, 'scripts/runtime-prepare.mjs')));
  const planned = actual(req); assert.equal(planned.status, 'PLAN_ONLY_NOT_PREPARED'); assert.deepEqual(planned.commands, []); assert.equal(planned.endpoint, undefined);
  const configDirectory = path.join(f.root, 'emptyconfig'); fs.mkdirSync(configDirectory);
  let calls = 0; const endpoint = 'unix:///var/run/docker.sock'; req.outputRoot = path.join(f.root, 'transport');
  assert.throws(() => actual(req, true, Date.now() + 10000, null, { endpoint, configDirectory, spawnSync: (exe, argv, options) => {
    calls++; assert.equal(exe, 'docker'); assert.deepEqual(argv.slice(0, 4), ['--host', endpoint, '--config', configDirectory]); assert.equal(options.shell, false); assert.deepEqual(Object.keys(options.env).sort(), ['HOME', 'PATH']);
    return { status: null, error: new Error('UNIT transport unknown'), stdout: '', stderr: '' };
  } }), /failed|reconcile/);
  assert.equal(calls, 1); const failed = json(path.join(req.outputRoot, 'receipt.json'));
  assert.equal(failed.status, 'FAILED_RETAIN_AND_RECONCILE'); assert.deepEqual(failed.commands[0].argv.slice(0, 5), ['docker', '--host', endpoint, '--config', configDirectory]);
  req.outputRoot = path.join(f.root, 'unsafe'); put(path.join(configDirectory, 'config.json'), '{}');
  assert.throws(() => actual(req, true, Infinity, null, { endpoint, configDirectory }), /empty/); assert.equal(fs.existsSync(req.outputRoot), false);
});

test('actual language primitive selected-only and default BOTH complete real FS/injected Docker probes', t => {
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

test('UNIT Python required language produces only observed selected language tools and passes existing config loader', async t => {
  const f = fixture(t, { profile: 'python-3.13', example: 'python-calculator' }), p = await buildPublicPreparePlan(f.argv), producers = unitProducers(), transport = unitTransport();
  const production = json('runtimes/production-inputs.lock.json');
  let selected;
  const result = await executePublicPreparePlan(p, { ...producers, spawnSync: transport.invoke, prepareLanguageImages: (root, lock, { receipt, save }, kinds) => {
    selected = kinds;
    const actual = { python: lock.language.pylsp.pythonVersion, packages: Object.fromEntries(lock.language.artifacts.filter(a => a.kind === 'language-wheel').map(a => [a.name, a.version])) };
    receipt.language = [{ key: 'pylsp-runtime-3.13', imageTag: 'paircoach/language-pylsp:stage09', engine, observedImage: { Id: id, Descriptor: descriptor, RepoDigests: [] }, status: 'BUILT_TOOLS_CHECKED_NOT_LSP_FUNCTIONAL_ACCEPTANCE', tools: [
      { name: 'paircoach-stage09-language-python-pylsp-inventory', status: 'TOOL_PROBE_PASS_REMOVED', inventory: actual, stdout: JSON.stringify(actual), stderr: '', container: { Id: 'c'.repeat(64), State: { Running: false, ExitCode: 0 }, Config: { Image: id, Labels: { 'paircoach.installation': 'stage09-runtime-assets', 'paircoach.role': 'language-tool-probe' } } } },
    ] }]; save(); return receipt.language;
  } });
  assert.equal(result.status, 'PREPARED_CONFIG_GENERATED_NOT_ACCEPTANCE'); assert.deepEqual(selected, ['python']);
  const images = json(path.join(f.output, 'images.lock.json')).images; assert.equal(images.length, 2);
  assert.deepEqual(images[1].tools.map(t => t.name), ['python', 'python-lsp-server', 'jedi', 'pyflakes']);
  assert.equal(images[1].tools.find(t => t.name === 'python-lsp-server').version, production.language.pylsp.version);
});
