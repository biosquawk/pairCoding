/** Genuine e982 constructor/write/settings/signed history, not a hand-built versions record. */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { deviceSeam } from './dev-seam';
const [root, mode, dev] = process.argv.slice(2);
if (!process.env.PAIRCOACH_IDENTITY_BASELINE) throw Error('Pinned e982 baseline source required');
const load = (file: string) => import(pathToFileURL(path.join(process.env.PAIRCOACH_IDENTITY_BASELINE!, file)).href);
const restore = deviceSeam(BigInt(dev));
const { createRuntimeWorkspace } = await load('src/server/runtime-coordinator/RuntimeWorkspace.ts');
const core = await createRuntimeWorkspace({ rootPath: root });
const { workspace: w, session, gate } = core;
session.claimLease('identity-old');
const auth = { clientId: 'identity-old', sessionId: session.state.sessionId, actor: 'STUDENT' as const, controlEpoch: session.state.controlEpoch };
gate.write({ ...auth, path: 'a.ts', baseVersion: 1, content: 'ACK old\n' });
const settings = { schemaVersion: 2, taskFilePath: 'task.md', taskMode: 'CODE_REVIEW', reviewNotesPath: 'notes.md', runProfiles: [], aiConsent: false, contextPatterns: ['**/*.ts'] };
const receipt = await core.settingsStore.save({ request: { requestId: 'old-settings', clientId: auth.clientId, sessionId: auth.sessionId,
  expectedWorkspaceVersion: w.workspaceVersion, settings }, humanConfirmed: true, expectedSourceSha256: core.readSettings().sourceSha256 });
const identity = { requestId: receipt.requestId, clientId: receipt.clientId, sessionId: receipt.sessionId, expectedWorkspaceVersion: receipt.expectedWorkspaceVersion, payloadSha256: receipt.payloadSha256 };
const aborted = { ...identity, requestId: 'aborted-settings', expectedWorkspaceVersion: w.workspaceVersion };
await core.settingsAuthority.reconcile(aborted, (o: unknown) => o);
let snapshotId: string | null = null;
if (mode === 'signed' || mode === 'pending') {
  snapshotId = w.createSnapshot('genuine old signed').snapshotId;
  gate.write({ ...auth, path: 'a.ts', baseVersion: w.getDocument('a.ts').version, content: 'WORK old\n' });
  if (mode === 'pending') {
    fs.writeSync(1, JSON.stringify({ snapshotId }) + '\n');
    w.on('snapshotCheckpoint', ({ phase }: {phase: string}) => { if (phase === 'PUBLISHED') process.kill(process.pid, 'SIGKILL'); });
  }
  await gate.restoreSnapshot({ ...auth, snapshotId, paths: ['a.ts'], expectedWorkspaceVersion: w.workspaceVersion });
}
const { DurableMutationJournal } = await load('src/server/runtime-coordinator/MutationJournal.ts');
const journal = new DurableMutationJournal(path.join(w.dataDir, 'runtime-mutations'));
const mutation = (requestId: string) => ({ projectId: w.projectId, sessionId: auth.sessionId, clientId: auth.clientId, requestId, kind: 'SAVE', payload: { expectedWorkspaceVersion: w.workspaceVersion, original: requestId } });
const committed = mutation('committed'), absent = mutation('absent'), unknown = mutation('unknown');
const result = { projectId: w.projectId, settings, receipt, original: ['bytes', 7] };
await journal.execute(committed, async () => ({ state: 'COMMITTED', result }));
await journal.reconcile(absent);
await journal.execute(unknown, async () => { throw Error('ambiguous original effect'); });
await journal.close();
const evidence = { projectId: w.projectId, workspaceVersion: w.workspaceVersion, version: w.getDocument('a.ts').version, snapshotId, receipt, identity, aborted,
  mutations: { committed, absent, unknown, result } };
core.close(); restore();
fs.writeSync(1, JSON.stringify(evidence) + '\n');
