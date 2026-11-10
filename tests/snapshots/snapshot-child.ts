// A real process with real I/O. Checkpoints ONLY coordinate the parent's hard kill.
import fs from 'node:fs';
import childProcess from 'node:child_process';
import path from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import { WorkspaceService } from '../../src/server/WorkspaceService';
import { SessionController } from '../../src/server/SessionController';
import { WriteGate } from '../../src/server/WriteGate';
const [root, data, action, snapshotId, phase, targetIndex] = process.argv.slice(2);
const pause = (p: string, index: number) => {
  if (p !== phase || (targetIndex !== '*' && index !== Number(targetIndex))) return;
  const point = { phase: p, index, pid: process.pid };
  process.stdout.write('CHECKPOINT ' + JSON.stringify(point) + '\n');
  process.send?.(point);
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0); // killed by parent, never catches/continues
};
if (phase === 'FORWARD_LINKED' || phase === 'ROLLBACK_LINKED') {
  const realLink = fs.linkSync;
  fs.linkSync = ((from: fs.PathLike, to: fs.PathLike) => {
    realLink(from, to);
    const source = String(from);
    if (String(to) === path.join(root, 'a.ts') && source.endsWith(phase === 'FORWARD_LINKED' ? '.forward' : '.rollback')) pause(phase, 0);
  }) as typeof fs.linkSync;
  syncBuiltinESMExports();
}
if (phase === 'HELPER_LIVE' && process.platform === 'linux') {
  const real = childProcess.spawnSync;
  let injected = false;
  childProcess.spawnSync = ((exe: any, args: any, options: any) => {
    const move = JSON.parse(options.input);
    if (!injected && move.from === path.join(root, 'a.ts') && move.to.endsWith('.captured')) {
      injected = true;
      const marker = JSON.stringify(path.join(root, '.paircoach', 'helper-live'));
      const changed = [...args];
      // Only scheduling around the REAL renameat2 is added. The orphan performs the
      // actual syscall after its Node parent dies; it never receives new authorization.
      changed[3] = `import os,time;open(${marker},'w').write(str(os.getpid()));time.sleep(1.5)\n` + changed[3] + `\nopen(${marker},'w').write('DONE')\n`;
      process.send?.({phase, index: 0, pid: process.pid});
      return real(exe, changed, options);
    }
    return real(exe, args, options);
  }) as typeof childProcess.spawnSync;
  syncBuiltinESMExports();
}
let workspace: WorkspaceService | undefined, session: SessionController | undefined;
try {
  workspace = new WorkspaceService(root, data);
  workspace.on('snapshotCheckpoint', e => pause(e.phase, e.index));
  session = new SessionController(workspace);
  const gate = new WriteGate(workspace, session);
  session.claimLease('new-child-lease');
  if (action === 'restore') gate.restoreSnapshot({ clientId: 'new-child-lease', sessionId: session.state.sessionId,
    controlEpoch: session.state.controlEpoch, actor: 'STUDENT', snapshotId, paths: ['a.ts', 'b.ts'], expectedWorkspaceVersion: workspace.workspaceVersion });
  const result = { status: 'OK', action, projectId: workspace.projectId, workspaceVersion: workspace.workspaceVersion };
  process.stdout.write('RESULT ' + JSON.stringify(result) + '\n');
  session.close(); workspace.close(); process.disconnect?.();
} catch (error: any) {
  process.stdout.write('RESULT ' + JSON.stringify({ status: 'ERROR', code: error.code, message: error.message }) + '\n');
  session?.close(); workspace?.close(); process.exitCode = 2;
  process.disconnect?.();
}
