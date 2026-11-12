/** UNIT: actual local filesystem/Node children + real producer functions, injected Docker only.
 * The synthetic metadata writer is NOT Docker/build/native proof; ROOT actual before/control retained. */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import * as helper from '../../scripts/runtime-prepare.mjs';
import { buildPublicPreparePlan, executePublicPreparePlan } from '../../scripts/runtime-prepare-cli.mjs';
import { executeRemainderPlan } from '../../scripts/runtime-operator-remainder.mjs';
const repo = process.cwd(), hash = b => createHash('sha256').update(b).digest('hex');
const engine = { ID: 'UNIT-engine', ServerVersion: '29.7.2', OSType: 'linux', Architecture: 'x86_64' };
const put = (p, v) => fs.writeFileSync(p, typeof v === 'string' ? v : JSON.stringify(v), { mode: 0o600 });
const json = p => JSON.parse(fs.readFileSync(p, 'utf8'));
function fixture(t) {
  const root = fs.mkdtempSync(path.join(path.dirname(repo), 'client-unit-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
// Real child process and filesystem writes reproduce client metadata placement, without calling Docker.
function metadataChild(config, options, marker, seeds = false) {
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import * as fs from 'node:fs'; import path from 'node:path';
    const dir=process.env.BUILDX_CONFIG??path.join(process.argv[1],'buildx');
    fs.mkdirSync(dir,{recursive:true,mode:0o700});
    fs.writeFileSync(path.join(dir,process.argv[2]),'UNIT client metadata',{mode:0o600});
    if (process.argv[3]==='seeds') for (const name of ['.token_seed','.token_seed.lock']) fs.writeFileSync(path.join(process.argv[1],name),'UNIT opaque own metadata',{mode:0o000});
  `, config, marker, seeds ? 'seeds' : 'none'], { ...options, env: { ...options.env }, timeout: 5000 });
  assert.equal(child.status, 0, child.stderr); return child;
}
function publicFixture(t) {
  const root = fixture(t), project = path.join(root, 'project'), output = path.join(root, 'output');
  fs.mkdirSync(project, { mode: 0o700 }); fs.cpSync(path.join(repo, 'examples/javascript-counter'), project, { recursive: true });
  fs.mkdirSync(path.join(project, '.paircoach'), { mode: 0o700 });
  put(path.join(project, '.paircoach/settings.json'), { schemaVersion: 2, taskFilePath: null, taskMode: 'IMPLEMENTATION', reviewNotesPath: 'notes.md', aiConsent: false, contextPatterns: [], runProfiles: json(path.join(project, 'task.v2.json')).runProfiles });
  return { root, project, output, argv: ['--project', project, '--profile', 'javascript-node', '--output', output] };
}
function childTransport(calls, { dirty = false, unknown = false, link = false } = {}) {
  return (exe, argv, options) => {
    assert.equal(exe, 'docker'); assert.equal(options.shell, false); assert.ok(options.timeout > 0 && options.timeout <= 480000);
    assert.deepEqual(Object.keys(options.env).sort(), ['BUILDX_CONFIG', 'HOME', 'PATH']);
    assert.equal(argv[0], '--host'); assert.equal(argv[2], '--config');
    const config = argv[3]; assert.deepEqual(fs.readdirSync(config), []);
    assert.notEqual(config, options.env.BUILDX_CONFIG); assert.notEqual(options.env.HOME, options.env.BUILDX_CONFIG);
    calls.push({ argv, options }); metadataChild(config, options, 'command-' + calls.length, true);
    if (dirty) put(path.join(config, 'unexpected-config.json'), '{}');
    if (link) fs.symlinkSync(config, path.join(options.env.BUILDX_CONFIG, 'escape'));
    return { status: unknown ? null : 0, signal: null, error: unknown ? new Error('UNIT unknown effects') : undefined, stdout: JSON.stringify(engine), stderr: '' };
  };
}

test('actual public CLI survives consecutive metadata-writing children and forwards SAME owned state to nested prepare', async t => {
  const f = publicFixture(t), plan = await buildPublicPreparePlan(f.argv), calls = [];
  let nested = false;
  const before = fs.readFileSync(path.join(f.project, 'main.js'));
  await assert.rejects(executePublicPreparePlan(plan, { spawnSync: childTransport(calls), stageInputs: async () => {}, prepare: (request, execute, deadline, expected, transport) => {
    nested = true; assert.equal(execute, true); assert.deepEqual(expected, engine);
    assert.equal(transport.configDirectory, path.dirname(calls[0].argv[3]));
    assert.deepEqual(helper.dockerClientEnvironment(transport.clientState), calls[0].options.env);
    // Use REAL nested prepare (unchanged validation). Deliberately unavailable tools abort before Docker.
    assert.throws(() => helper.prepare(request, true, deadline, expected, transport), /ENOENT/);
    throw new Error('UNIT stop after nested ownership check');
  } }), /UNIT stop after nested/);
  assert.equal(nested, true); assert.equal(calls.length, 2);
  assert.equal(fs.readdirSync(path.join(f.output, 'docker-config')).length, 2);
  assert.equal(fs.readdirSync(path.join(f.output, 'docker-buildx')).length, 2);
  assert.equal(new Set(calls.map(c => c.argv[3])).size, calls.length);
  for (const c of calls) assert.deepEqual(fs.readdirSync(c.argv[3]).sort(), ['.token_seed', '.token_seed.lock']);
  assert.deepEqual(fs.readFileSync(path.join(f.project, 'main.js')), before);
  const r = json(path.join(f.output, 'receipt.json')); assert.equal(r.status, 'FAILED_RETAIN_AND_RECONCILE'); assert.equal(r.commands.length, 2);
});

test('hostile inherited env ignored by actual CLI; no process/global env mutation', async t => {
  const names = ['BUILDX_CONFIG', 'DOCKER_CONFIG', 'DOCKER_HOST', 'HOME', 'USERPROFILE', 'AWS_SECRET_ACCESS_KEY', 'DOCKER_AUTH_CONFIG'];
  const original = Object.fromEntries(names.map(k => [k, process.env[k]]));
  for (const k of names) process.env[k] = '/UNIT-HOSTILE-' + k;
  try {
    const f = publicFixture(t), p = await buildPublicPreparePlan(f.argv), calls = [];
    await assert.rejects(executePublicPreparePlan(p, { spawnSync: childTransport(calls, { unknown: true }) }), /Unknown\/failed/);
    assert.equal(calls.length, 1); assert.ok(Object.values(calls[0].options.env).every(v => !v?.startsWith('/UNIT-HOSTILE-')));
    for (const k of names) assert.equal(process.env[k], '/UNIT-HOSTILE-' + k);
    assert.equal(json(path.join(f.output, 'receipt.json')).commands[0].error, 'UNIT unknown effects');
  } finally { for (const k of names) original[k] === undefined ? delete process.env[k] : process.env[k] = original[k]; }
});

for (const [name, mode] of [['nonempty credential config', { dirty: true }], ['metadata symlink', { link: true }]]) {
  test('actual CLI rejects post-child ' + name + ', retains effects, no next child/retry', async t => {
    const f = publicFixture(t), calls = [], p = await buildPublicPreparePlan(f.argv);
    await assert.rejects(executePublicPreparePlan(p, { spawnSync: childTransport(calls, mode) }), /config write|link/);
    assert.equal(calls.length, 1); const r = json(path.join(f.output, 'receipt.json'));
    assert.equal(r.status, 'FAILED_RETAIN_AND_RECONCILE'); assert.equal(r.commands.length, 1); assert.equal(r.commands[0].exit, 0);
    assert.ok(fs.existsSync(path.join(f.output, 'docker-buildx', 'command-1')));
    if (mode.dirty) assert.ok(fs.existsSync(path.join(calls[0].argv[3], 'unexpected-config.json')));
  });
}

test('owned state metadata persists; config content never allowlisted and forged/aliased/outside state refused', t => {
  const root = fixture(t), state = helper.createDockerClientState(root);
  assert.ok(Object.isFrozen(state)); const env = helper.dockerClientEnvironment(state);
  assert.equal(env.BUILDX_CONFIG, path.join(root, 'docker-buildx'));
  metadataChild(state.configDirectory, { env }, 'kept'); helper.dockerClientEnvironment(state);
  assert.ok(fs.existsSync(path.join(state.buildxDirectory, 'kept')));
  for (const value of [null, {}, { ...state }, { ...state, buildxDirectory: state.configDirectory }, { ...state, buildxDirectory: path.dirname(root) }]) assert.throws(() => helper.dockerClientEnvironment(value), /Unowned/);
  assert.throws(() => helper.createDockerClientState(root), /already exists/);
  put(path.join(state.configDirectory, 'buildx'), 'not credentials is NOT an exemption');
  assert.throws(() => helper.dockerClientEnvironment(state), /credential pool/);
});

test('pre-existing directory/file/symlink and root aliases refused without adoption/deletion', t => {
  for (const kind of ['dir', 'file', 'symlink']) {
    const root = fixture(t), target = path.join(root, 'docker-buildx');
    if (kind === 'dir') fs.mkdirSync(target, { mode: 0o700 });
    if (kind === 'file') put(target, 'keep');
    if (kind === 'symlink') fs.symlinkSync(path.dirname(root), target);
    assert.throws(() => helper.createDockerClientState(root), /already exists/);
    assert.equal(fs.existsSync(path.join(root, 'docker-config')), false); assert.ok(fs.lstatSync(target));
  }
  const root = fixture(t), alias = path.join(root, 'alias'); fs.symlinkSync(root, alias);
  assert.throws(() => helper.createDockerClientState(alias), /ancestry/);
  assert.throws(() => helper.createDockerClientState(root + '/x/..'), /Canonical/);
  if (process.platform !== 'win32') { fs.chmodSync(root, 0o755); assert.throws(() => helper.createDockerClientState(root), /private/); }
});

for (const kind of ['directory replacement', 'top symlink', 'nested symlink', 'hardlink', 'public mode']) {
  test('state rejects ' + kind + ' after creation before next child', t => {
    const root = fixture(t), s = helper.createDockerClientState(root);
    if (kind === 'directory replacement') { fs.renameSync(s.buildxDirectory, s.buildxDirectory + '-retained'); fs.mkdirSync(s.buildxDirectory, { mode: 0o700 }); }
    if (kind === 'top symlink') { fs.renameSync(s.buildxDirectory, s.buildxDirectory + '-retained'); fs.symlinkSync(s.configDirectory, s.buildxDirectory); }
    if (kind === 'nested symlink') fs.symlinkSync(root, path.join(s.buildxDirectory, 'link'));
    if (kind === 'hardlink') { put(path.join(root, 'outside'), 'keep'); fs.linkSync(path.join(root, 'outside'), path.join(s.buildxDirectory, 'link')); }
    if (kind === 'public mode') { if (process.platform === 'win32') { assert.ok(helper.dockerClientEnvironment(s)); return; } fs.chmodSync(s.homeDirectory, 0o755); }
    assert.throws(() => helper.dockerClientEnvironment(s), /identity|ancestry|link/);
  });
}

// Same real nested prepare with tiny installed metadata sandbox: production validation unchanged;
// fake pinned metadata is UNIT only, not a production dependency/tool/OCI proof.
async function installedHelper(t) {
  const root = fixture(t), install = path.join(root, 'install');
  for (const dir of ['scripts', 'docker', 'runtimes']) fs.mkdirSync(path.join(install, dir), { recursive: true, mode: 0o700 });
  for (const name of ['runtime-prepare','runtime-files','runtime-spec','runtime-dependencies','runtime-task','runtime-pom','runtime-cache','runtime-tools','runtime-artifacts']) fs.copyFileSync(path.join(repo, 'scripts', name + '.mjs'), path.join(install, 'scripts', name + '.mjs'));
  fs.copyFileSync(path.join(repo, 'docker/runtime.Dockerfile'), path.join(install, 'docker/runtime.Dockerfile'));
  const tools = path.join(root, 'tools'); fs.mkdirSync(path.join(tools, 'node_modules/unit'), { recursive: true, mode: 0o700 }); put(path.join(tools, 'node_modules/unit/x'), 'unit');
  const project = path.join(root, 'project'); fs.mkdirSync(project, { mode: 0o700 }); put(path.join(project, 'main.js'), 'unit');
  const profile = json('runtimes/catalog.json').profiles[0], pin = 'node@sha256:' + '1'.repeat(64);
  put(path.join(install, 'runtimes/catalog.json'), { profiles: [profile] });
  put(path.join(install, 'runtimes/production-inputs.lock.json'), { images: { node: { reference: pin }, maven: { reference: 'maven@sha256:be898b0cf3929205778d61b2841aa36733513a79b0404f9cac67837863c8641f' } }, artifacts: [{ kind: 'npm', name: 'unit', files: [{ path: 'x', sha256: hash('unit') }] }] });
  const mod = await import(pathToFileURL(path.join(install, 'scripts/runtime-prepare.mjs')));
  const request = { schemaVersion: 1, workingDirectory: '.', installationId: 'unit', family: 'node', key: profile.id, imageTag: 'paircoach/runtime-unit:unit', baseImage: pin, nodeImage: pin, tools: { root: tools, files: [{ path: 'node_modules/unit/x', sha256: hash('unit') }] }, project: { root: project, files: [{ path: 'main.js', sha256: hash('unit') }] }, expectedTools: profile.expectedTools, dependencySha256: hash('[]'), outputRoot: path.join(root, 'job') };
  const state = mod.createDockerClientState(root);
  return { root, mod, request, state };
}

test('actual nested helper shares owned client env through build and later commands; unknown result retained', async t => {
  const { root, mod, request, state } = await installedHelper(t), calls = []; let built = false;
  const invoke = (exe, argv, options) => {
    assert.deepEqual(options.env, mod.dockerClientEnvironment(state));
    assert.equal(path.dirname(argv[3]), state.configDirectory); assert.equal(options.env.HOME, state.homeDirectory);
    metadataChild(argv[3], options, 'nested-' + calls.length, argv[4] === 'build'); calls.push(argv);
    const cmd = argv.slice(4);
    if (cmd[0] === 'build') built = true;
    if (cmd[0] === 'image') return { status: null, error: new Error('UNIT unknown after build'), stdout: '', stderr: '' };
    return { status: 0, stdout: cmd[0] === 'info' ? JSON.stringify(engine) : '', stderr: '' };
  };
  assert.throws(() => mod.prepare(request, true, Date.now() + 10000, engine, { endpoint: 'unix:///var/run/docker.sock', configDirectory: state.configDirectory, clientState: state, spawnSync: invoke }), /failed/);
  assert.equal(built, true); assert.ok(calls.length >= 9); assert.equal(fs.readdirSync(state.configDirectory).length, calls.length);
  assert.equal(new Set(calls.map(c => c[3])).size, calls.length);
  const r = json(path.join(request.outputRoot, 'receipt.json')); assert.equal(r.status, 'FAILED_RETAIN_AND_RECONCILE'); assert.match(r.commands.at(-1).error, /unknown after build/);
  assert.equal(r.clientState.buildxDirectory, state.buildxDirectory); assert.equal(fs.readdirSync(state.buildxDirectory).length, calls.length);
});

test('nested helper refuses external config/forged capability/nonempty config before output or child', async t => {
  for (const kind of ['external', 'alias', 'forged', 'nonempty']) {
    const { root, mod, request, state } = await installedHelper(t);
    const transport = { endpoint: 'unix:///var/run/docker.sock', configDirectory: state.configDirectory, clientState: state, spawnSync: () => assert.fail('no child permitted') };
    if (kind === 'external') transport.configDirectory = path.dirname(root);
    if (kind === 'alias') transport.configDirectory += '/.';
    if (kind === 'forged') transport.clientState = { ...state, homeDirectory: path.dirname(root) };
    if (kind === 'nonempty') put(path.join(state.configDirectory, 'config.json'), '{}');
    assert.throws(() => mod.prepare(request, true, Infinity, engine, transport), /alias|Unowned|credential pool/); assert.equal(fs.existsSync(request.outputRoot), false);
  }
});

test('actual remainder outer sequence retains writes and propagates same capability to nested entry; no old cleanup', t => {
  const root = fixture(t), output = path.join(root, 'output'), calls = [];
  const plan = { options: { outputRoot: output }, phase: 'PREPARE_ONLY_REMAINDER_AFTER_REVIEWED_FAILURE', engine, maxElapsedMs: 10000, maxCommandMs: 480000, sourceInventory: [], reuse: [], staging: { files: [] }, jobs: [{ id: 'unit', request: { project: { root: path.join(output, 'project') } }, assets: [] }], failure: { exactContainerId: 'c'.repeat(64) } };
  let nested = false;
  assert.throws(() => executeRemainderPlan(plan, { buildPlan: () => structuredClone(plan), spawnSync: (exe, argv, options) => {
    const result = childTransport(calls)(exe, argv, options);
    if (argv[4] === 'container') return { status: 1, stdout: '', stderr: 'No such container: ' + plan.failure.exactContainerId };
    return result;
  }, prepare: (request, execute, deadline, expected, transport) => {
    nested = true; assert.deepEqual(helper.dockerClientEnvironment(transport.clientState), calls[0].options.env); assert.equal(transport.configDirectory, path.dirname(calls[0].argv[3]));
    throw new Error('UNIT nested stop');
  } }), /UNIT nested stop/);
  assert.equal(nested, true); assert.equal(calls.length, 2); assert.ok(calls.every(c => !c.argv.includes('rm')));
  assert.equal(fs.readdirSync(path.join(output, 'docker-config')).length, calls.length);
  assert.equal(json(path.join(output, 'receipt.json')).status, 'FAILED_RETAIN_AND_RECONCILE');
});

test('BUILD-time seed/lock metadata outside buildx is retired unread; each following config is NEW and empty', t => {
  const root = fixture(t), state = helper.createDockerClientState(root), used = [];
  for (let i = 0; i < 3; i++) {
    const issued = helper.beginDockerCommand(state); assert.deepEqual(fs.readdirSync(issued.configDirectory), []);
    assert.equal(used.includes(issued.configDirectory), false); used.push(issued.configDirectory);
    metadataChild(issued.configDirectory, { env: issued.env }, 'build-' + i, true);
    helper.finishDockerCommand(state, issued);
    assert.deepEqual(fs.readdirSync(issued.configDirectory).sort(), ['.token_seed', '.token_seed.lock']);
  }
  assert.ok(helper.dockerClientEnvironment(state));
  // Retired paths are proof only, never handed to a later child. Drift fails, not silently dropped.
  fs.chmodSync(path.join(used[0], '.token_seed'), 0o600);
  assert.throws(() => helper.beginDockerCommand(state), /Retired/);
  assert.equal(fs.readdirSync(state.configDirectory).length, 3);
});

test('fresh command refuses overlap, pre-child credential writes, seed links and config.json even after successful child', t => {
  for (const mode of ['prewrite', 'config.json', 'seed-link', 'seed-hardlink']) {
    const root = fixture(t), state = helper.createDockerClientState(root), issued = helper.beginDockerCommand(state);
    assert.throws(() => helper.beginDockerCommand(state), /overlap/);
    if (mode === 'prewrite') {
      put(path.join(issued.configDirectory, '.token_seed'), 'unexpected before child');
      assert.throws(() => helper.dockerClientEnvironment(state), /empty/); continue;
    }
    if (mode === 'config.json') put(path.join(issued.configDirectory, 'config.json'), '{}');
    if (mode === 'seed-link') fs.symlinkSync(root, path.join(issued.configDirectory, '.token_seed'));
    if (mode === 'seed-hardlink') { put(path.join(root, 'outside'), 'opaque'); fs.linkSync(path.join(root, 'outside'), path.join(issued.configDirectory, '.token_seed')); }
    assert.throws(() => helper.finishDockerCommand(state, issued), /config write|metadata link/);
    assert.ok(fs.lstatSync(path.join(issued.configDirectory, mode === 'config.json' ? 'config.json' : '.token_seed')));
  }
});

test('unchanged sequence oracle: public command metadata must not block next engine command or nested handoff', async t => {
  const f = publicFixture(t), plan = await buildPublicPreparePlan(f.argv); let children = 0, nested = false;
  const spawn = (exe, args, options) => {
    children++; metadataChild(args[3], options, 'sequence-' + children);
    return { status: 0, stdout: JSON.stringify(engine), stderr: '' };
  };
  await assert.rejects(executePublicPreparePlan(plan, { spawnSync: spawn, stageInputs: async () => {}, prepare: () => { nested = true; throw new Error('EXPECTED_NESTED_HANDOFF'); } }), /EXPECTED_NESTED_HANDOFF/);
  assert.equal(nested, true); assert.equal(children, 2);
});
