/** Actual gate/root FIFO seams. No language scanner/registry/HTTP/Docker readiness claim. */
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRuntimeWorkspace } from '../../src/server/runtime-coordinator/RuntimeWorkspace';
import type { LanguageSourceLease } from '../../src/server/WriteGate';
const barrier = () => {
  let resolve!: () => void;
  const promise = new Promise<void>(r => resolve = r);
  return { promise, resolve };
};
async function fixture(t: TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'language-source-lease-'));
  fs.writeFileSync(path.join(root, 'source.js'), 'ORIGINAL\n');
  const core = await createRuntimeWorkspace({ rootPath: root }); core.session.claimLease('language-tab');
  t.after(() => { core.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const input = { clientId: 'language-tab', sessionId: core.session.state.sessionId, actor: 'STUDENT' as const,
    controlEpoch: core.session.state.controlEpoch, expectedWorkspaceVersion: core.workspace.workspaceVersion };
  return { root, core, input };
}
test('SEAM same language lease spans awaited preparation and synchronous dispatch, holds actual FIFO/root exclusion, then is permanently released', async t => {
  const { core, input } = await fixture(t), entered = barrier(), resume = barrier();
  let retained!: LanguageSourceLease, checks = 0, phase = '';
  const operation = core.gate._withLanguageSourceLease(input, () => { checks++; }, async lease => {
    retained = lease; phase = 'PREPARE'; lease.assertCurrent(); entered.resolve(); await resume.promise;
    lease.assertCurrent(); phase = 'MATERIALIZE'; lease.assertCurrent(); phase = 'DISPATCH'; return 'RESULT';
  });
  await entered.promise;
  assert.throws(() => core.gate.write({ ...input, path: 'source.js', baseVersion: 1, content: 'LEAPFROG\n' }), { code: 'WORKSPACE_BUSY' });
  let settled = false;
  const queued = core.gate.writeAsync({ ...input, path: 'source.js', baseVersion: 1, content: 'QUEUED\n' }).then(v => { settled = true; return v; });
  await new Promise<void>(r => setImmediate(r)); assert.equal(settled, false); assert.equal(phase, 'PREPARE');
  resume.resolve(); assert.equal(await operation, 'RESULT'); assert.equal(phase, 'DISPATCH'); assert.ok(checks >= 5);
  assert.throws(() => retained.assertCurrent(), { code: 'LANGUAGE_LEASE_RELEASED' });
  assert.equal((await queued).version, 2); assert.equal(core.workspace.getDocument('source.js').content, 'QUEUED\n');
});
test('SEAM failed async preparation releases gate but never leaves a usable retained proof', async t => {
  const { core, input } = await fixture(t); let retained!: LanguageSourceLease;
  await assert.rejects(core.gate._withLanguageSourceLease(input, () => {}, async lease => {
    retained = lease; await new Promise<void>(r => setImmediate(r)); throw Error('prepare failed');
  }), /prepare failed/);
  assert.throws(() => retained.assertCurrent(), { code: 'LANGUAGE_LEASE_RELEASED' });
  assert.throws(() => retained.assertRetainedCurrent(), { code: 'LANGUAGE_LEASE_RELEASED' });
  assert.equal(core.gate.write({ ...input, path: 'source.js', baseVersion: 1, content: 'EDITABLE\n' }).version, 2);
});
test('SEAM actual client/control revocation during async preparation refuses synchronous dispatch and final return', async t => {
  const { core, input } = await fixture(t), entered = barrier(), resume = barrier(); let dispatched = false;
  const operation = core.gate._withLanguageSourceLease(input, () => {}, async lease => {
    entered.resolve(); await resume.promise; lease.assertCurrent(); dispatched = true;
  });
  await entered.promise; core.session.releaseLease(input.clientId); resume.resolve();
  await assert.rejects(operation); assert.equal(dispatched, false);
  core.session.claimLease(input.clientId);
  assert.equal(core.gate.write({ ...input, controlEpoch: core.session.state.controlEpoch, path: 'source.js', baseVersion: 1, content: 'NEW EPOCH\n' }).version, 2);
});
test('SEAM coordinator scope/settings/prepare revocation remains synchronously checked on retained actual gate lease', async t => {
  const { core, input } = await fixture(t), entered = barrier(), resume = barrier();
  const settingsPath = core.settingsStore.settingsPath, before = core.readSettings().sourceSha256;
  let currentScope = true, materialized = false;
  const operation = core.gate._withLanguageSourceLease(input, () => {
    if (!currentScope || core.readSettings().sourceSha256 !== before) throw Error('actual scope/settings revoked');
  }, async lease => { entered.resolve(); await resume.promise; lease.assertCurrent(); materialized = true; });
  await entered.promise; fs.writeFileSync(settingsPath, '{external settings'); currentScope = false; resume.resolve();
  await assert.rejects(operation, /scope\/settings revoked/); assert.equal(materialized, false);
  assert.equal(fs.readFileSync(settingsPath, 'utf8'), '{external settings');
});
test('SEAM stale admission waits for earlier admitted writes then refuses; no language action executes on guessed source versions', async t => {
  const { core, input } = await fixture(t); let called = false;
  const earlierWrite = core.gate.writeAsync({ ...input, path: 'source.js', baseVersion: 1, content: 'EARLIER\n' });
  const laterLanguage = core.gate._withLanguageSourceLease(input, () => {}, async () => { called = true; });
  await earlierWrite; await assert.rejects(laterLanguage, { code: 'WORKSPACE_VERSION_CONFLICT' }); assert.equal(called, false);
});
test('SEAM gate lease alone does NOT certify external raw source; caller must retain owner scanner proof', async t => {
  const { core, input, root } = await fixture(t);
  await core.gate._withLanguageSourceLease(input, () => {}, async lease => {
    fs.writeFileSync(path.join(root, 'source.js'), 'EXTERNAL BEFORE WATCHER\n');
    // Explicit negative authority boundary. A full synchronous scan must be composed by language
    // owner; neither this successful gate assertion nor workspaceVersion is source evidence.
    lease.assertCurrent(); assert.equal(core.workspace.workspaceVersion, input.expectedWorkspaceVersion);
  });
});
test('SEAM SAME token distinguishes held copy lease from retained current scope, never extends copy ownership to LSP lifetime', async t => {
  const { core, input } = await fixture(t); let retained!: LanguageSourceLease, currentScope = true;
  await core.gate._withLanguageSourceLease(input, () => { if (!currentScope) throw Error('scope revoked'); }, async lease => {
    retained = lease; lease.assertCurrent(); lease.assertRetainedCurrent();
  });
  assert.throws(() => retained.assertCurrent(), { code: 'LANGUAGE_LEASE_RELEASED' });
  retained.assertRetainedCurrent(); currentScope = false;
  assert.throws(() => retained.assertRetainedCurrent(), /scope revoked/); currentScope = true;
  core.gate.write({ ...input, path: 'source.js', baseVersion: 1, content: 'NEW SOURCE\n' });
  assert.throws(() => retained.assertRetainedCurrent(), { code: 'WORKSPACE_VERSION_CONFLICT' });
});
