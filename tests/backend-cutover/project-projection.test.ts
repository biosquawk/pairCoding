/** Actual filesystem/Store/gate projection seams; fake read-only execution/language ports, not LIVE. */
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRuntimeWorkspace, type RuntimeWorkspace } from '../../src/server/runtime-coordinator/RuntimeWorkspace';
import { readRuntimeProject, readRuntimeProjectSettings } from '../../src/server/runtime-coordinator/RuntimeProject';
import { loadRuntimeConfiguration } from '../../src/server/runtime-config';
import { validateSettingsV2, validateV2WireShape } from '../../src/shared/validation-v2';
import type { SettingsV2 } from '../../src/shared/runtime-v2';
import type { LanguageView } from '../../src/shared/language-v2';
import { sha256 } from '../../src/server/runtime-coordinator/storage';

const metadata = { taskFilePath: 'instructions.md', taskMode: 'CODE_REVIEW' as const, reviewNotesPath: 'notes.md', aiConsent: true, contextPatterns: ['**/*.js', '**/*.md'] };
const runProfiles: SettingsV2['runProfiles'] = [{ kind: 'RUN_MAIN', timeoutMs: 1000,
  task: { workingDirectory: '.', entry: { kind: 'SCRIPT', path: 'source.js' }, tests: { paths: [], names: [] } } }];
async function fixture(t: TestContext, raw?: string) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-project-projection-')), project = path.join(root, 'project'), opened: RuntimeWorkspace[] = [];
  fs.mkdirSync(project); fs.mkdirSync(path.join(project, '.paircoach'), { mode: 0o700 }); fs.writeFileSync(path.join(project, 'source.js'), 'ORIGINAL\n');
  const settingsFile = path.join(project, '.paircoach', 'settings.json'); if (raw !== undefined) fs.writeFileSync(settingsFile, raw);
  const write = (name: string, value: unknown) => fs.writeFileSync(path.join(root, name), JSON.stringify(value));
  write('runtime.json', { schemaVersion: 1, activeProfile: 'node', workspaceRoot: './project', runtimeCatalog: './catalog.json', imageLock: './images.json',
    languageFeatures: { completion: true, diagnostics: true }, execution: { backend: 'docker', pullPolicy: 'never' } });
  write('catalog.json', { schemaVersion: 1, profiles: [{ id: 'node', label: 'Node', adapterFamily: 'node', imageLockKey: 'node', expectedTools: [{ name: 'node', version: '22.22.0' }],
    compilerRelease: null, analysis: { languageLevel: 'es2022', preview: false }, language: { provider: 'builtin', imageLockKey: null, serverJvm: null }, taskFields: [] }] });
  write('images.json', { schemaVersion: 1, images: [{ key: 'node', image: 'paircoach/runtime-node:22-v1', imageId: 'sha256:' + 'a'.repeat(64), digest: 'sha256:' + 'b'.repeat(64), tools: [{ name: 'node', version: '22.22.0' }] }] });
  const configuration = loadRuntimeConfiguration({ configPath: path.join(root, 'runtime.json') }); assert.ok(configuration.resolved);
  const open = async () => { const c = await createRuntimeWorkspace({ rootPath: project }); opened.push(c); return c; };
  t.after(() => { for (const c of opened) c.close(); fs.rmSync(root, { recursive: true, force: true }); });
  let calls = 0;
  const readiness = { execution: { readiness: async () => { calls++; return { configurationGeneration: configuration.configurationGeneration,
    modes: { RUN_MAIN: { canRun: true, problem: null }, RUN_TESTS: { canRun: true, problem: null } } }; } },
    probe: { probe: async () => { calls++; return { canRun: true, problem: null }; } } };
  const view = (c: RuntimeWorkspace) => readRuntimeProject({ core: c, configuration, readiness, sessionId: c.session.state.sessionId,
    assertCurrent: () => { assert.equal(c.session.state.projectId, c.workspace.projectId); },
    readLanguage: (): LanguageView => ({ projectId: c.workspace.projectId, profileId: 'node', configurationGeneration: configuration.configurationGeneration,
      providerGeneration: 'fake-language-generation', state: 'ON', autocomplete: 'ON', docs: 'N/A', problem: null }) });
  return { root, project, settingsFile, open, view, configuration, readiness, calls: () => calls };
}
function auth(c: RuntimeWorkspace) {
  c.session.claimLease('projection-tab');
  return { clientId: 'projection-tab', sessionId: c.session.state.sessionId, controlEpoch: c.session.state.controlEpoch, actor: 'STUDENT' as const };
}
const sources = {
  missing: undefined,
  malformed: '{"PRIVATE original": unparseable\r\n',
  legacy: JSON.stringify({ schemaVersion: 1, ...metadata, customMetadata: { untouched: true }, runProfiles: [{ kind: 'RUN_MAIN', executable: 'forbidden-host-task', args: [], cwd: '.' }] }, null, 3) + '\r\n',
  mixed: JSON.stringify({ schemaVersion: 2, ...metadata, customMetadata: { untouched: true }, runProfiles, executable: 'forbidden-host-task' }, null, 3) + '\r\n',
};
for (const kind of ['missing', 'malformed', 'legacy', 'mixed'] as const) test('SEAM ' + kind + ' settings: shape-valid FORM never grants READY/language or writes raw; explicit save/restart preserves real outcome', async t => {
  const raw = sources[kind], f = await fixture(t, raw), c = await f.open(), before = c.readSettings();
  assert.equal(before.settings, null); assert.equal(before.kind, 'MIGRATION_REQUIRED');
  const project = await f.view(c); assert.ok(validateV2WireShape('Project', project)); assert.ok(validateSettingsV2(project.settings));
  assert.deepEqual(project.settings.runProfiles, []);
  assert.equal(project.capabilities.execution.runtime.state, 'CONFIG_ERROR');
  assert.equal(project.capabilities.execution.runtime.problem?.code, 'LEGACY_RUN_PROFILE_REQUIRES_MIGRATION');
  assert.equal(project.capabilities.execution.modes.RUN_MAIN.canRun, false); assert.equal(project.capabilities.execution.modes.RUN_TESTS.canRun, false);
  assert.equal(project.capabilities.language.state, 'OFF'); assert.equal(project.capabilities.language.autocomplete, 'OFF'); assert.equal(f.calls(), 0);
  if (kind === 'legacy' || kind === 'mixed') {
    const { schemaVersion: _version, runProfiles: _profiles, ...fields } = project.settings;
    assert.deepEqual(fields, metadata); assert.equal(c.workspace.settings.taskMode, metadata.taskMode); assert.equal(c.workspace.settings.aiConsent, true);
  } else { assert.equal(project.settings.aiConsent, false); assert.equal(project.settings.taskFilePath, null); }
  c.gate.write({ ...auth(c), path: 'source.js', baseVersion: 1, content: 'STUDENT\n' });
  if (raw === undefined) assert.equal(fs.existsSync(f.settingsFile), false); else assert.equal(fs.readFileSync(f.settingsFile, 'utf8'), raw);
  assert.equal(fs.existsSync(f.settingsFile + '.v2-state'), false);
  const request = { requestId: 'explicit-human-save', clientId: 'projection-tab', sessionId: c.session.state.sessionId,
    expectedWorkspaceVersion: c.workspace.workspaceVersion, settings: { ...project.settings, runProfiles } };
  if (kind === 'malformed') {
    // Existing accepted Store deliberately refuses lossy merge/overwrite of malformed bytes.
    await assert.rejects(c.settingsStore.save({ request, humanConfirmed: true, expectedSourceSha256: before.sourceSha256 }), { code: 'UNMERGEABLE_SETTINGS' });
    assert.equal(fs.readFileSync(f.settingsFile, 'utf8'), raw); assert.equal(c.workspace.workspaceVersion, 1); c.close();
    const again = await f.open(); assert.equal(again.readSettings().kind, 'MIGRATION_REQUIRED'); assert.equal(again.workspace.workspaceVersion, 1);
    assert.equal(fs.readFileSync(f.settingsFile, 'utf8'), raw); return;
  }
  const receipt = await c.settingsStore.save({ request, humanConfirmed: true, expectedSourceSha256: before.sourceSha256 });
  assert.equal(receipt.status, 'OK'); assert.equal(receipt.workspaceVersion, 2); assert.equal(c.readSettings().kind, 'V2');
  if (raw !== undefined) {
    assert.equal(fs.readFileSync(path.join(f.settingsFile + '.v2-state', 'backup-' + sha256(raw) + '.json'), 'utf8'), raw);
    const stored = JSON.parse(fs.readFileSync(f.settingsFile, 'utf8')); assert.deepEqual(stored.customMetadata, { untouched: true }); assert.equal(Object.hasOwn(stored, 'executable'), false);
  }
  const accepted = await f.view(c); assert.equal(accepted.capabilities.execution.modes.RUN_MAIN.canRun, true); assert.ok(f.calls() > 0);
  // This readiness uses FAKE read-only ports; only proving the Store/form distinction, not Docker.
  c.close(); const again = await f.open(); assert.deepEqual(again.readSettings().settings, request.settings);
  assert.equal(again.workspace.workspaceVersion, 2); assert.equal(again.workspace.getDocument('source.js').content, 'STUDENT\n');
  assert.equal(again.workspace.settings.runProfiles.length, 0);
});
test('SEAM invalid nonexecution fields use explicit neutral defaults; no inferred consent/paths/profiles', async t => {
  const raw = JSON.stringify({ schemaVersion: 1, taskFilePath: '../private', taskMode: 'SHELL', reviewNotesPath: '/private', aiConsent: 'true', contextPatterns: [123], runProfiles: [{ executable: 'private task' }] });
  const f = await fixture(t, raw), c = await f.open(), projection = readRuntimeProjectSettings(c);
  assert.deepEqual(projection.form, { schemaVersion: 2, taskFilePath: null, taskMode: 'IMPLEMENTATION', reviewNotesPath: 'review.md', aiConsent: false, contextPatterns: [], runProfiles: [] });
  assert.equal(c.workspace.settings.aiConsent, false); assert.equal(c.readSettings().settings, null); assert.equal(fs.readFileSync(f.settingsFile, 'utf8'), raw);
});
test('SEAM Store migration problem is not hidden by a concurrent invalid runtime config', async t => {
  const f = await fixture(t, sources.legacy), c = await f.open();
  const project = await readRuntimeProject({ core: c, sessionId: c.session.state.sessionId,
    configuration: loadRuntimeConfiguration({ configPath: path.join(f.root, 'missing') }), readiness: f.readiness, assertCurrent: () => {},
    readLanguage: () => ({ projectId: c.workspace.projectId, profileId: 'unconfigured', configurationGeneration: 'replace-in-callback', providerGeneration: 'provider', state: 'OFF', autocomplete: 'OFF', docs: 'N/A', problem: null }) }).catch(e => e);
  // Wrong language generation must refuse; a config-error path cannot bypass scope validation.
  assert.equal(project.code, 'PROJECT_STATE_CHANGED'); assert.equal(f.calls(), 0);
  const configuration = loadRuntimeConfiguration({ configPath: path.join(f.root, 'missing') });
  const current = await readRuntimeProject({ core: c, sessionId: c.session.state.sessionId, configuration, readiness: f.readiness, assertCurrent: () => {},
    readLanguage: () => ({ projectId: c.workspace.projectId, profileId: 'unconfigured', configurationGeneration: configuration.configurationGeneration, providerGeneration: 'provider', state: 'OFF', autocomplete: 'OFF', docs: 'N/A', problem: null }) });
  assert.equal(current.capabilities.execution.runtime.problem?.code, 'LEGACY_RUN_PROFILE_REQUIRES_MIGRATION'); assert.equal(f.calls(), 0);
});
test('SEAM async readiness does not publish mixed current project/settings after an intervening real edit', async t => {
  const f = await fixture(t, JSON.stringify({ schemaVersion: 2, ...metadata, runProfiles })), c = await f.open();
  let entered!: () => void, resume!: () => void;
  const atReadiness = new Promise<void>(r => entered = r), pause = new Promise<void>(r => resume = r);
  const pending = readRuntimeProject({ core: c, sessionId: c.session.state.sessionId, configuration: f.configuration,
    readiness: { ...f.readiness, execution: { readiness: async () => { entered(); await pause; return f.readiness.execution.readiness(); } } }, assertCurrent: () => {},
    readLanguage: () => { throw Error('Stale project must refuse before reading language'); } });
  await atReadiness; c.gate.write({ ...auth(c), path: 'source.js', baseVersion: 1, content: 'NEWER\n' }); resume();
  await assert.rejects(pending, { code: 'PROJECT_STATE_CHANGED' });
});
