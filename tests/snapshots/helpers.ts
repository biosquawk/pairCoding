import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { syncBuiltinESMExports } from 'node:module';
import { WorkspaceService } from '../../src/server/WorkspaceService';
import { SessionController } from '../../src/server/SessionController';
import { WriteGate, type MutationAuth } from '../../src/server/WriteGate';

export const code = (expected: string) => (error: any) => error?.code === expected;
export function open(root: string, data: string) {
  const workspace = new WorkspaceService(root, data);
  const session = new SessionController(workspace);
  let gate: WriteGate;
  try { gate = new WriteGate(workspace, session); } catch (e) { session.close(); workspace.close(); throw e; }
  session.claimLease('tab');
  const auth = (): MutationAuth => ({ clientId: 'tab', sessionId: session.state.sessionId, controlEpoch: session.state.controlEpoch, actor: 'STUDENT' });
  const restore = (id: string, paths: string[], version = workspace.workspaceVersion) => gate.restoreSnapshot({ ...auth(), snapshotId: id, paths, expectedWorkspaceVersion: version });
  return { workspace, session, gate, auth, restore, close: () => { session.close(); workspace.close(); } };
}
export function fixture(t: any, files: Record<string, Buffer | string> = { 'a.ts': 'SNAP A\n', 'b.ts': 'SNAP B\n' }) {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'snapshot-g3-'));
  const root = path.join(parent, 'project'), data = path.join(parent, 'data'); fs.mkdirSync(root);
  for (const [p, bytes] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(root, p)), { recursive: true }); fs.writeFileSync(path.join(root, p), bytes); }
  const f = open(root, data);
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); f.close(); fs.rmSync(parent, { recursive: true, force: true }); });
  const write = (p: string, content: string) => f.gate.write({ ...f.auth(), path: p, content, baseVersion: f.workspace.getDocument(p).version });
  return { ...f, parent, root, data, write, bytes: (p: string) => fs.readFileSync(path.join(root, p)), file: (p: string) => path.join(root, p) };
}
