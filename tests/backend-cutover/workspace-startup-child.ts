/** Actual private factory/store/journal child, killed at a durable boundary. No Docker/task process. */
import fs from 'node:fs';
import { createRuntimeWorkspace } from '../../src/server/runtime-coordinator/RuntimeWorkspace';
import { SettingsV2Store } from '../../src/server/settings-v2';
const [root, action, boundary, snapshotId] = process.argv.slice(2);
const core = await createRuntimeWorkspace({ rootPath: root });
const { workspace, session, gate } = core;
const clientId = 'startup-child'; session.claimLease(clientId);
const kill = () => process.kill(process.pid, 'SIGKILL');
if (action === 'snapshot') {
  workspace.on('snapshotCheckpoint', ({ phase }) => { if (phase === boundary) kill(); });
  await gate.restoreSnapshot({ clientId, sessionId: session.state.sessionId, actor: 'STUDENT', controlEpoch: session.state.controlEpoch,
    snapshotId, paths: ['a.ts', 'b.ts'], expectedWorkspaceVersion: workspace.workspaceVersion });
} else {
  const store = new SettingsV2Store({ settingsPath: core.settingsStore.settingsPath, authority: core.settingsAuthority,
    checkpoint: phase => { if (phase === boundary) kill(); } });
  if (boundary === 'COMMITTED') workspace.on('changed', change => { if (change.actor === 'SETTINGS') kill(); });
  const current = store.read(), settings = { ...current.settings!, aiConsent: true };
  const request = { requestId: 'canonical-crash-save', clientId, sessionId: session.state.sessionId,
    expectedWorkspaceVersion: workspace.workspaceVersion, settings };
  fs.writeSync(1, JSON.stringify({ request, expectedSourceSha256: current.sourceSha256 }) + '\n');
  await store.save({ request, expectedSourceSha256: current.sourceSha256, humanConfirmed: true });
}
core.close(); throw Error('Expected crash boundary was not reached');
