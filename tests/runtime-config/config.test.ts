import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadRuntimeConfiguration, aggregateRuntimeReadiness, type RuntimeConfiguration } from '../../src/server/runtime-config';
import { validateExecutionView } from '../../src/shared/validation-v2';
import type { ModeReadiness, RuntimeProfile, SettingsV2 } from '../../src/shared/runtime-v2';

const image = (key: string) => ({ key, image: 'paircoach/runtime-node:22-v1', imageId: 'sha256:' + 'a'.repeat(64), digest: 'sha256:' + 'b'.repeat(64), tools: [{ name: 'node', version: '22.22.0' }] });
const profile = (id = 'javascript-node'): RuntimeProfile => ({ id, label: 'Node', adapterFamily: 'node', imageLockKey: 'node', expectedTools: [{ name: 'node', version: '22.22.0' }], compilerRelease: null,
  analysis: { languageLevel: 'es2022', preview: false }, language: { provider: 'builtin', imageLockKey: null, serverJvm: null }, taskFields: [] });
const settings = (): SettingsV2 => ({ schemaVersion: 2, taskFilePath: 'task.md', taskMode: 'IMPLEMENTATION', reviewNotesPath: 'review.md', contextPatterns: ['**/*.js'], aiConsent: false, runProfiles: [
  { kind: 'RUN_MAIN', timeoutMs: 1000, task: { workingDirectory: '.', entry: { kind: 'SCRIPT', path: 'src/other.js' }, tests: { paths: [], names: [] } } },
  { kind: 'RUN_TESTS', timeoutMs: 1000, task: { workingDirectory: '.', entry: { kind: 'TESTS' }, tests: { paths: ['different.test.js'], names: [] } } },
] });
const okay: ModeReadiness = { canRun: true, problem: null };
const bad = (code: string): ModeReadiness => ({ canRun: false, problem: { code, message: 'Unavailable', recovery: 'Prepare or repair.', retryable: true } });
function fixture(t: TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-config-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'config'));
  const configPath = path.join(root, 'config', 'paircoach.runtime.json');
  const config = { schemaVersion: 1, activeProfile: 'javascript-node', workspaceRoot: '../workspace', runtimeCatalog: './catalog.json', imageLock: './images.lock.json', languageFeatures: { completion: true, diagnostics: true }, execution: { backend: 'docker', pullPolicy: 'never' } };
  const write = (name: string, value: unknown) => fs.writeFileSync(path.join(root, 'config', name), JSON.stringify(value));
  write('paircoach.runtime.json', config); write('catalog.json', { schemaVersion: 1, profiles: [profile(), profile('other-node')] }); write('images.lock.json', { schemaVersion: 1, images: [image('node')] });
  return { root, configPath, config, write, load: () => loadRuntimeConfiguration({ configPath }) };
}
function deps(configuration: RuntimeConfiguration, main = okay, tests = okay) {
  return { execution: { readiness: async () => ({ configurationGeneration: configuration.configurationGeneration, modes: { RUN_MAIN: main, RUN_TESTS: tests } }) }, probe: { probe: async () => okay } };
}
test('all config paths are config-relative, not cwd; generation is fresh and resolved state immutable', t => {
  const f = fixture(t), a = f.load(), b = f.load();
  assert.ok(a.resolved); assert.notEqual(a.configurationGeneration, b.configurationGeneration);
  assert.equal(a.resolved.workspaceRoot, path.join(f.root, 'workspace'));
  assert.equal(a.resolved.image.imageId, 'sha256:' + 'a'.repeat(64));
  assert.ok(Object.isFrozen(a.resolved.profile.expectedTools));
  assert.throws(() => { a.resolved!.profile.label = 'changed'; });
});
test('explicitGUI > env > config workspace, env > config profile; no commands guessed', t => {
  const f = fixture(t);
  const load = (explicitWorkspaceRoot?: string) => loadRuntimeConfiguration({ configPath: f.configPath, explicitWorkspaceRoot, environment: { PAIRCOACH_RUNTIME_PROFILE: 'other-node', PAIRCOACH_WORKSPACE_DIR: '../env' } });
  assert.equal(load().resolved?.profile.id, 'other-node'); assert.equal(load().resolved?.workspaceRoot, path.join(f.root, 'env'));
  assert.equal(load('../GUI').resolved?.workspaceRoot, path.join(f.root, 'GUI'));
  assert.equal(loadRuntimeConfiguration({ configPath: f.configPath, environment: { PAIRCOACH_RUNTIME_PROFILE: '' } }).problem?.code, 'RUNTIME_PROFILE_UNKNOWN');
});
test('missing/unknown config, host backend, mutable image, tools mismatch fail closed without mutating config', t => {
  const f = fixture(t), original = fs.readFileSync(f.configPath);
  assert.equal(loadRuntimeConfiguration({ configPath: '/not-present/runtime.json' }).resolved, null);
  assert.equal(loadRuntimeConfiguration({ configPath: 'relative.json' }).resolved, null);
  assert.equal(loadRuntimeConfiguration({ configPath: f.configPath, environment: { PAIRCOACH_RUNTIME_PROFILE: 'unknown' } }).problem?.code, 'RUNTIME_PROFILE_UNKNOWN');
  assert.deepEqual(fs.readFileSync(f.configPath), original);
  f.write('paircoach.runtime.json', { ...f.config, execution: { backend: 'host', pullPolicy: 'never' } }); assert.equal(f.load().resolved, null);
  f.write('paircoach.runtime.json', f.config);
  f.write('images.lock.json', { schemaVersion: 1, images: [{ ...image('node'), imageId: 'latest' }] }); assert.equal(f.load().resolved, null);
  f.write('images.lock.json', { schemaVersion: 1, images: [{ ...image('node'), tools: [{ name: 'node', version: 'wrong' }] }] }); assert.equal(f.load().resolved, null);
});
test('missing lock keys and Python builtin are rejected even on frozen shared base', t => {
  const f = fixture(t);
  f.write('catalog.json', { schemaVersion: 1, profiles: [{ ...profile(), imageLockKey: 'absent' }] }); assert.equal(f.load().resolved, null);
  f.write('catalog.json', { schemaVersion: 1, profiles: [{ ...profile(), adapterFamily: 'python' }] }); assert.equal(f.load().resolved, null);
});
test('symlink and oversized config files fail without echoing config secrets', t => {
  const f = fixture(t); fs.unlinkSync(f.configPath); fs.symlinkSync(path.join(f.root, 'secret-json'), f.configPath);
  fs.writeFileSync(path.join(f.root, 'secret-json'), '{"secret":"do-not-echo"}');
  assert.equal(f.load().resolved, null); assert.ok(!JSON.stringify(f.load()).includes('do-not-echo'));
  fs.unlinkSync(f.configPath); fs.writeFileSync(f.configPath, ' '.repeat(4 * 1024 * 1024 + 1)); assert.equal(f.load().resolved, null);
});
test('invalid config and legacy/mixed/unknown settings fail per modes without execution calls', async t => {
  const f = fixture(t), c = f.load(); let called = 0;
  const d = { execution: { readiness: async () => { called++; throw Error(); } }, probe: { probe: async () => { called++; return okay; } } };
  for (const value of [{ runProfiles: [{ executable: 'node' }] }, { ...settings(), schemaVersion: 3 }, { ...settings(), runProfiles: [{ ...settings().runProfiles[0], executable: 'node' }] }]) {
    const view = await aggregateRuntimeReadiness(c, value, d); assert.equal(view.modes.RUN_MAIN.canRun, false); assert.equal(view.modes.RUN_TESTS.problem?.code, 'LEGACY_RUN_PROFILE_REQUIRES_MIGRATION'); assert.ok(validateExecutionView(view));
  }
  const invalid = loadRuntimeConfiguration({ configPath: path.join(f.root, 'missing') });
  assert.equal((await aggregateRuntimeReadiness(invalid, settings(), d)).runtime.state, 'CONFIG_ERROR'); assert.equal(called, 0);
});
test('per-mode aggregation preserves one available mode and returns actionable missing-image problem', async t => {
  const c = fixture(t).load(), d = deps(c, okay, bad('IMAGE_MISSING'));
  const view = await aggregateRuntimeReadiness(c, settings(), d);
  assert.equal(view.runtime.state, 'READY'); assert.equal(view.modes.RUN_MAIN.canRun, true); assert.equal(view.modes.RUN_TESTS.problem?.code, 'IMAGE_MISSING'); assert.ok(validateExecutionView(view));
});
test('no configured modes and task incompatibility do not probe tasks or infer host commands', async t => {
  const c = fixture(t).load(), s = settings(), d = deps(c); let called = 0; d.probe.probe = async () => { called++; return okay; };
  s.runProfiles = []; const v = await aggregateRuntimeReadiness(c, s, d); assert.equal(v.modes.RUN_MAIN.canRun, false); assert.equal(called, 0);
  s.runProfiles = [{ kind: 'RUN_MAIN', timeoutMs: 1000, task: { workingDirectory: '.', entry: { kind: 'JAVA_MAIN', className: 'Other' }, tests: { paths: [], names: [] } } }];
  assert.equal((await aggregateRuntimeReadiness(c, s, d)).modes.RUN_MAIN.problem?.code, 'TASK_CONFIG_INVALID'); assert.equal(called, 0);
});
test('daemon errors, stale generation, malformed port and bounded timeout all fail closed', async t => {
  const c = fixture(t).load();
  for (const readiness of [async () => { throw Error('private-details'); }, async () => ({ configurationGeneration: 'stale', modes: { RUN_MAIN: okay, RUN_TESTS: okay } }), async () => ({ configurationGeneration: c.configurationGeneration, modes: { RUN_MAIN: { canRun: true, problem: {} }, RUN_TESTS: okay } }), () => new Promise<never>(() => {})]) {
    const view = await aggregateRuntimeReadiness(c, settings(), { execution: { readiness: readiness as any }, probe: { probe: async () => okay }, timeoutMs: 5 });
    assert.equal(view.runtime.state, 'DAEMON_OFF'); assert.equal(view.modes.RUN_MAIN.problem?.code, 'DAEMON_UNAVAILABLE'); assert.ok(validateExecutionView(view)); assert.ok(!JSON.stringify(view).includes('private-details'));
  }
});
test('dependency readiness is recomputed every time; one mode probe failure is isolated', async t => {
  const c = fixture(t).load(), d = deps(c); let ready = false, calls = 0;
  d.probe.probe = async (_r?: any, mode?: any) => { calls++; if (mode === 'RUN_MAIN') throw Error(); return ready ? okay : bad('PREPARE_REQUIRED'); };
  let view = await aggregateRuntimeReadiness(c, settings(), d); assert.equal(view.runtime.state, 'PREPARE_REQUIRED');
  ready = true; view = await aggregateRuntimeReadiness(c, settings(), d); assert.equal(view.modes.RUN_TESTS.canRun, true); assert.equal(view.modes.RUN_MAIN.canRun, false); assert.equal(calls, 4); assert.ok(validateExecutionView(view));
});
