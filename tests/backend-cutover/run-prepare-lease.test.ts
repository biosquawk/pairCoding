/** Actual gate/kernel/copy ordering with controlled preparation observer; not Docker readiness. */
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRuntimeWorkspace } from '../../src/server/runtime-coordinator/RuntimeWorkspace';
import { copyAcknowledgedInput, readRunSourceInventory } from '../../src/server/execution/ImmutableInput';
async function fixture(t: TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'run-prepare-lease-')), project = path.join(root, 'project'), runs = path.join(root, 'runs');
  fs.mkdirSync(project); fs.mkdirSync(runs); fs.writeFileSync(path.join(project, 'source.js'), '\ufeffORIGINAL\r\n');
  const core = await createRuntimeWorkspace({ rootPath: project }); core.session.claimLease('tab');
  const auth = { clientId: 'tab', sessionId: core.session.state.sessionId, controlEpoch: core.session.state.controlEpoch, actor: 'STUDENT' as const };
  const input = { ...auth, runId: 'actual-run', profileId: 'javascript-node', configurationGeneration: 'cfg', expectedWorkspaceVersion: core.workspace.workspaceVersion, runDirectory: path.join(runs, 'actual-run') };
  function unlock(p: string) { if (!fs.lstatSync(p).isSymbolicLink() && fs.statSync(p).isDirectory()) { fs.chmodSync(p, 0o700); for (const n of fs.readdirSync(p)) unlock(path.join(p, n)); } }
  t.after(() => { core.close(); unlock(root); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, project, runs, core, auth, input };
}
test('SEAM SAME fresh prepare token spans actual inventory and immutable copy, queues later writes and refuses after release', async t => {
  const f = await fixture(t), order: string[] = []; let held!: { assertCurrent(): void }, queued!: Promise<unknown>;
  const copied = await f.core.gate.captureRun(f.input, {
    prepare: async lease => {
      held = lease; order.push('prepare'); lease.assertCurrent();
      assert.throws(() => f.core.gate.write({ ...f.auth, path: 'source.js', baseVersion: 1, content: 'leapfrog' }), { code: 'WORKSPACE_BUSY' });
      queued = f.core.gate.writeAsync({ ...f.auth, path: 'source.js', baseVersion: 1, content: 'later' });
      await new Promise<void>(r => setImmediate(r)); lease.assertCurrent();
    },
    inventory: async root => { held.assertCurrent(); order.push('inventory'); return readRunSourceInventory(root); },
    copy: async options => { held.assertCurrent(); order.push('copy'); const input = await copyAcknowledgedInput(options); held.assertCurrent(); order.push('after-copy'); return input; },
  });
  assert.throws(() => held.assertCurrent(), { code: 'RUN_INPUT_CHANGED' }); await queued;
  assert.ok(order.indexOf('prepare') < order.indexOf('inventory')); assert.ok(order.indexOf('copy') < order.indexOf('after-copy'));
  assert.equal(fs.readFileSync(path.join(copied.immutableDirectory, 'source.js'), 'utf8'), '\ufeffORIGINAL\r\n');
  assert.equal(f.core.workspace.getDocument('source.js').content, 'later');
});
test('SEAM preparation refusal/control revocation cannot copy or start and releases editor FIFO', async t => {
  const f = await fixture(t); let copied = false, held!: { assertCurrent(): void };
  await assert.rejects(f.core.gate.captureRun(f.input, { inventory: readRunSourceInventory,
    prepare: async lease => { held = lease; f.core.session.veto(); lease.assertCurrent(); },
    copy: async options => { copied = true; return copyAcknowledgedInput(options); },
  }), { code: 'STALE_EPOCH' });
  assert.equal(copied, false); assert.equal(fs.existsSync(f.input.runDirectory), false);
  assert.throws(() => held.assertCurrent(), { code: 'RUN_INPUT_CHANGED' });
  const doc = await f.core.gate.writeAsync({ ...f.auth, controlEpoch: f.core.session.state.controlEpoch, path: 'source.js', baseVersion: 1, content: 'editable' });
  assert.equal(doc.content, 'editable');
});
test('SEAM actual binding guard is rechecked after awaited preparation and before helper effect', async t => {
  const f = await fixture(t); let current = true, copied = false;
  await assert.rejects(f.core.gate.captureRun(f.input, { inventory: readRunSourceInventory,
    assertCurrent: () => { if (!current) throw Error('binding revoked'); }, prepare: async () => { current = false; },
    copy: async options => { copied = true; return copyAcknowledgedInput(options); },
  }), /binding revoked/);
  assert.equal(copied, false); assert.equal(fs.existsSync(f.input.runDirectory), false);
});
