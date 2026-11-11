import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createRuntimeStartup, parseRuntimeStartupArguments, requireRuntimeWorkspace, DEFAULT_RUNTIME_CONFIG_PATH, RuntimeStartupArgumentError,
  type RuntimeStartup } from '../../src/server/runtime-coordinator/RuntimeStartup';
import { aggregateRuntimeReadiness } from '../../src/server/runtime-config';
import { validateExecutionView } from '../../src/shared/validation-v2';
import type { RuntimeProfile, SettingsV2 } from '../../src/shared/runtime-v2';

const absolute = (...parts: string[]) => path.join(os.tmpdir(), ...parts);
test('UNIT startup arguments use installed application config, not cwd, and retain immutable selected roots', () => {
  const expected = fileURLToPath(new URL('../../paircoach.runtime.json', import.meta.url));
  assert.equal(DEFAULT_RUNTIME_CONFIG_PATH, expected);
  const defaults = parseRuntimeStartupArguments([]);
  assert.equal(defaults.runtimeConfigPath, expected); assert.deepEqual(defaults.preparedRuntimeRoots, []);
  const argv = ['--prepared-runtime', absolute('prepare A'), '--runtime-config', absolute('configuration', '..', 'measured.json'), '--prepared-runtime', absolute('prepare B')];
  const parsed = parseRuntimeStartupArguments(argv); argv[1] = absolute('replaced');
  assert.equal(parsed.runtimeConfigPath, absolute('measured.json'));
  assert.deepEqual(parsed.preparedRuntimeRoots, [absolute('prepare A'), absolute('prepare B')]);
  assert.ok(Object.isFrozen(parsed)); assert.ok(Object.isFrozen(parsed.preparedRuntimeRoots));
});
test('UNIT unknown/partial/repeated flags and relative/control paths fail without echoing caller values', () => {
  for (const argv of [ ['--runtime-config'], ['--prepared-runtime'], ['--unexpected', absolute('secret')], ['positional'],
    ['--runtime-config=secret'], ['--runtime-config', 'relative.json'], ['--prepared-runtime', 'relative'],
    ['--runtime-config', absolute('private\nsecret')], ['--prepared-runtime', absolute('private\x7fsecret')],
    ['--runtime-config', absolute('a'), '--runtime-config', absolute('b')],
    ['--runtime-config', absolute('x'.repeat(1025))], ['--prepared-runtime', absolute('x'.repeat(1025))],
  ]) assert.throws(() => parseRuntimeStartupArguments(argv), error => error instanceof RuntimeStartupArgumentError && !error.message.includes('secret'));
});
test('UNIT selected roots are bounded16, unique, canonical and nonoverlapping without filesystem discovery', () => {
  const roots = Array.from({ length: 16 }, (_, i) => absolute('not-existing-private-output-' + i));
  assert.deepEqual(parseRuntimeStartupArguments(roots.flatMap(p => ['--prepared-runtime', p])).preparedRuntimeRoots, roots);
  const invalid = [ [...roots, absolute('seventeenth')], [roots[0], roots[0]], [absolute('parent'), absolute('parent', 'nested')],
    [absolute('parent', 'nested'), absolute('parent')], [absolute('trailing') + path.sep], [absolute('a,b')],
    [path.join(os.tmpdir(), 'parent') + path.sep + '..' + path.sep + 'output'], [path.parse(os.tmpdir()).root, absolute('nested')],
  ];
  if (process.platform === 'win32') invalid.push([absolute('CASE'), absolute('case')]);
  for (const paths of invalid) assert.throws(() => parseRuntimeStartupArguments(paths.flatMap(p => ['--prepared-runtime', p])), RuntimeStartupArgumentError);
  assert.equal(parseRuntimeStartupArguments(['--prepared-runtime', absolute('parent'), '--prepared-runtime', absolute('parent-sibling')]).preparedRuntimeRoots.length, 2);
});

const profile = (id: string): RuntimeProfile => ({ id, label: id, adapterFamily: 'node', imageLockKey: 'node',
  expectedTools: [{ name: 'node', version: '22.22.0' }], compilerRelease: null, analysis: { languageLevel: 'es2022', preview: false },
  language: { provider: 'builtin', imageLockKey: null, serverJvm: null }, taskFields: [] });
const settings: SettingsV2 = { schemaVersion: 2, taskFilePath: 'task.md', taskMode: 'IMPLEMENTATION', reviewNotesPath: 'notes.md',
  aiConsent: false, contextPatterns: ['**/*.js'], runProfiles: [{ kind: 'RUN_MAIN', timeoutMs: 1000,
    task: { workingDirectory: '.', entry: { kind: 'SCRIPT', path: 'different.js' }, tests: { paths: [], names: [] } } }] };
function fixture(t: TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-startup-options-')), opened: RuntimeStartup[] = [];
  const configDir = path.join(root, 'config'), configPath = path.join(configDir, 'runtime.json');
  fs.mkdirSync(configDir);
  for (const dir of ['configured', 'environment', 'explicit']) {
    fs.mkdirSync(path.join(root, dir)); fs.writeFileSync(path.join(root, dir, 'different.js'), '\ufeffORIGINAL\r\n');
  }
  const config = { schemaVersion: 1, activeProfile: 'javascript-node', workspaceRoot: '../configured', runtimeCatalog: './catalog.json', imageLock: './images.json',
    languageFeatures: { completion: true, diagnostics: true }, execution: { backend: 'docker', pullPolicy: 'never' } };
  const write = (p: string, value: unknown) => fs.writeFileSync(path.join(configDir, p), JSON.stringify(value));
  write('runtime.json', config); write('catalog.json', { schemaVersion: 1, profiles: [profile('javascript-node'), profile('other-node')] });
  write('images.json', { schemaVersion: 1, images: [{ key: 'node', image: 'paircoach/runtime-node:22-v1', imageId: 'sha256:' + 'a'.repeat(64),
    digest: 'sha256:' + 'b'.repeat(64), tools: [{ name: 'node', version: '22.22.0' }] }] });
  let calls = 0;
  const transport = { run: async () => { calls++; throw Error('No Docker operation admitted by this seam test'); } };
  const open = async (extra: Partial<Parameters<typeof createRuntimeStartup>[0]> = {}) => {
    const s = await createRuntimeStartup({ argv: ['--runtime-config', configPath], environment: {}, transport, ...extra }); opened.push(s); return s;
  };
  t.after(() => { for (const s of opened) s.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, configPath, config, write, open, calls: () => calls };
}
const auth = (s: RuntimeStartup) => {
  assert.ok(s.core);
  s.core.session.claimLease('startup-options-tab');
  return { clientId: 'startup-options-tab', sessionId: s.core.session.state.sessionId, controlEpoch: s.core.session.state.controlEpoch, actor: 'STUDENT' as const };
};
test('SEAM startup composes accepted config and real canonical durable core without implicit prepare or settings creation', async t => {
  const f = fixture(t), original = fs.readFileSync(f.configPath);
  const s = await f.open({ argv: ['--runtime-config', f.configPath, '--prepared-runtime', absolute('not-yet-prepared')] }); assert.ok(s.core);
  assert.equal(s.rootSource, 'CONFIGURATION'); assert.equal(s.core.workspace.rootPath, path.join(f.root, 'configured'));
  assert.equal(s.configuration.resolved?.workspaceRoot, s.core.workspace.rootPath);
  assert.equal(s.core.settingsStore.settingsPath, path.join(s.core.workspace.rootPath, '.paircoach', 'settings.json'));
  assert.equal(s.core.readSettings().kind, 'MIGRATION_REQUIRED'); assert.equal(fs.existsSync(s.core.settingsStore.settingsPath), false);
  const doc = s.core.gate.write({ ...auth(s), path: 'different.js', baseVersion: 1, content: 'STUDENT\n' });
  assert.equal(doc.version, 2); assert.equal(s.core.workspace.workspaceVersion, 1);
  assert.equal(fs.readFileSync(path.join(s.core.workspace.rootPath, 'different.js'), 'utf8'), '\ufeffSTUDENT\r\n');
  assert.deepEqual(fs.readFileSync(f.configPath), original); assert.equal(f.calls(), 0);
});
test('SEAM startup actual precedence explicit GUI > env > config and environment profile > file, no cwd lookup', async t => {
  const f = fixture(t), environment = { PAIRCOACH_WORKSPACE_DIR: '../environment', PAIRCOACH_RUNTIME_PROFILE: 'other-node' };
  const env = await f.open({ environment }); assert.ok(env.core);
  assert.equal(env.rootSource, 'ENVIRONMENT'); assert.equal(env.core.workspace.rootPath, path.join(f.root, 'environment'));
  assert.equal(env.configuration.resolved?.profile.id, 'other-node');
  const explicit = await f.open({ environment, explicitWorkspaceRoot: path.join(f.root, 'explicit') }); assert.ok(explicit.core);
  assert.equal(explicit.rootSource, 'EXPLICIT'); assert.equal(explicit.core.workspace.rootPath, path.join(f.root, 'explicit'));
  environment.PAIRCOACH_WORKSPACE_DIR = '../configured'; environment.PAIRCOACH_RUNTIME_PROFILE = 'invalid-after-admission';
  assert.equal(explicit.configuration.resolved?.profile.id, 'other-node'); assert.equal(f.calls(), 0);
});
for (const failure of ['profile', 'image', 'configuration'] as const) test('SEAM ' + failure + ' failure leaves explicit/env-selected project editable with config error, not a host fallback', async t => {
  const f = fixture(t);
  if (failure === 'image') f.write('images.json', { schemaVersion: 1, images: [] });
  if (failure === 'configuration') fs.writeFileSync(f.configPath, '{MALFORMED private config');
  const environment = { PAIRCOACH_WORKSPACE_DIR: '../environment', PAIRCOACH_RUNTIME_PROFILE: failure === 'profile' ? 'unknown' : 'javascript-node' };
  const s = await f.open({ environment }); assert.ok(s.core); assert.equal(s.rootSource, 'ENVIRONMENT');
  assert.equal(s.configuration.resolved, null); assert.ok(s.configuration.problem);
  s.core.gate.write({ ...auth(s), path: 'different.js', baseVersion: 1, content: 'EDIT\n' });
  const view = await aggregateRuntimeReadiness(s.configuration, s.core.readSettings().settings, {
    execution: { readiness: async () => { throw Error('Must not be called'); } }, probe: s.prepared,
  });
  assert.equal(view.runtime.state, 'CONFIG_ERROR'); assert.equal(view.modes.RUN_MAIN.canRun, false); assert.ok(validateExecutionView(view)); assert.equal(f.calls(), 0);
});
test('SEAM missing config without explicit/env root remains UNBOUND, creates no workspace and publishes no fake core', async t => {
  const f = fixture(t), before = fs.readdirSync(os.tmpdir()).filter(p => p.startsWith('paircoach-workspace-')).sort();
  const s = await f.open({ argv: ['--runtime-config', path.join(f.root, 'missing-runtime.json')] });
  assert.equal(s.rootSource, 'UNBOUND'); assert.equal(s.configuration.resolved, null); assert.equal(s.core, null);
  assert.throws(() => requireRuntimeWorkspace(s), { code: 'PROJECT_OPEN_REQUIRED', status: 409 });
  assert.equal(fs.existsSync(path.join(f.root, 'configured', '.paircoach')), false);
  assert.deepEqual(fs.readdirSync(os.tmpdir()).filter(p => p.startsWith('paircoach-workspace-')).sort(), before);
  s.close(); assert.equal(f.calls(), 0);
});
test('SEAM UNBOUND can bind only an explicit existing root after canonical recovery despite missing runtime config', async t => {
  const f = fixture(t), argv = ['--runtime-config', path.join(f.root, 'missing-runtime.json')];
  const unbound = await f.open({ argv }); assert.equal(unbound.core, null);
  const bound = await f.open({ argv, explicitWorkspaceRoot: path.join(f.root, 'explicit') });
  const core = requireRuntimeWorkspace(bound); assert.equal(bound.rootSource, 'EXPLICIT'); assert.equal(core.settingsRecovery, 'NONE');
  assert.equal(bound.configuration.problem?.code, 'RUNTIME_CONFIG_INVALID');
  core.gate.write({ ...auth(bound), path: 'different.js', baseVersion: 1, content: 'EXPLICIT MANUAL\n' });
  assert.equal(core.workspace.getDocument('different.js').content, 'EXPLICIT MANUAL\n');
  assert.equal(fs.existsSync(path.join(f.root, 'configured', '.paircoach')), false); assert.equal(f.calls(), 0);
});
test('SEAM malformed canonical settings are retained byte-exact at startup; execution remains migration-required', async t => {
  const f = fixture(t), root = path.join(f.root, 'configured'); fs.mkdirSync(path.join(root, '.paircoach'));
  const file = path.join(root, '.paircoach', 'settings.json'), original = Buffer.from('{broken original\r\n'); fs.writeFileSync(file, original);
  const s = await f.open(); assert.ok(s.core); assert.equal(s.core.readSettings().kind, 'MIGRATION_REQUIRED');
  const view = await aggregateRuntimeReadiness(s.configuration, s.core.readSettings().settings, {
    execution: { readiness: async () => { throw Error('Must not be called'); } }, probe: s.prepared,
  });
  assert.equal(view.modes.RUN_TESTS.problem?.code, 'LEGACY_RUN_PROFILE_REQUIRES_MIGRATION');
  s.core.gate.write({ ...auth(s), path: 'different.js', baseVersion: 1, content: 'MANUAL\n' });
  assert.deepEqual(fs.readFileSync(file), original); assert.equal(f.calls(), 0);
});
test('SEAM actual prepared consumer with no selected roots never grants READY from valid V2 settings/image metadata', async t => {
  const f = fixture(t), root = path.join(f.root, 'configured'); fs.mkdirSync(path.join(root, '.paircoach'));
  fs.writeFileSync(path.join(root, '.paircoach', 'settings.json'), JSON.stringify(settings));
  const s = await f.open(); assert.ok(s.core); assert.equal(s.core.readSettings().kind, 'V2');
  const ready = { canRun: true, problem: null }, view = await aggregateRuntimeReadiness(s.configuration, s.core.readSettings().settings, {
    execution: { readiness: async () => ({ configurationGeneration: s.configuration.configurationGeneration, modes: { RUN_MAIN: ready, RUN_TESTS: ready } }) }, probe: s.prepared,
  });
  assert.equal(view.modes.RUN_MAIN.canRun, false); assert.equal(view.modes.RUN_MAIN.problem?.code, 'PREPARE_REQUIRED'); assert.equal(f.calls(), 0);
});
test('SEAM each startup mints fresh config/session generation but reuses ONE durable canonical project history', async t => {
  const f = fixture(t), a = await f.open(); assert.ok(a.core); const projectId = a.core.workspace.projectId;
  a.core.gate.write({ ...auth(a), path: 'different.js', baseVersion: 1, content: 'PERSISTED\n' });
  await assert.rejects(f.open(), /own|busy|lease/i); a.close();
  const b = await f.open(); assert.ok(b.core); assert.equal(b.core.workspace.projectId, projectId); assert.equal(b.core.workspace.workspaceVersion, 1);
  assert.equal(b.core.workspace.getDocument('different.js').version, 2);
  assert.notEqual(a.configuration.configurationGeneration, b.configuration.configurationGeneration);
  assert.notEqual(a.core.session.state.sessionId, b.core.session.state.sessionId); assert.equal(f.calls(), 0);
});
test('SEAM invalid selectors, missing explicit roots and linked env roots refuse without silently choosing another project', async t => {
  const f = fixture(t), link = path.join(f.root, 'linked'); fs.symlinkSync(path.join(f.root, 'environment'), link, 'dir');
  await assert.rejects(f.open({ explicitWorkspaceRoot: 'relative' }), RuntimeStartupArgumentError);
  await assert.rejects(f.open({ explicitWorkspaceRoot: path.join(f.root, 'missing') }));
  await assert.rejects(f.open({ environment: { PAIRCOACH_WORKSPACE_DIR: '../linked' } }));
  await assert.rejects(f.open({ argv: ['--runtime-config', f.configPath, '--prepared-runtime', absolute('duplicate'), '--prepared-runtime', absolute('duplicate')] }), RuntimeStartupArgumentError);
  // Failed attempts never initialized the unrelated configured project.
  assert.equal(fs.existsSync(path.join(f.root, 'configured', '.paircoach')), false); assert.equal(f.calls(), 0);
});
