/** Real process witness; never substitutes/mock-patches native FFI. */
import path from 'node:path';
const [mode, target] = process.argv.slice(2);
const send = (value: object) => { process.stdout.write(JSON.stringify(value) + '\n'); process.send?.(value); };
send({ event: 'NODE_STARTED', pid: process.pid, platform: process.platform, node: process.version });
if (mode === 'factory') {
  const { createPairCoachServer } = await import('../../src/server/http');
  send({ event: 'HTTP_IMPORTED' });
  const app = createPairCoachServer({ rootPath: target, port: 0, enableCoach: false, enableExecution: false,
    runtimeArguments: ['--runtime-config', path.join(target, 'absent-runtime.json')], runtimeEnvironment: {} });
  send({ event: 'FACTORY_RETURNED' });
  try {
    const port = await app.listen();
    send({ event: 'FACTORY_LISTENED', port, projectId: app.workspace.projectId, workspaceVersion: app.workspace.workspaceVersion });
  } finally { await app.close(); }
  send({ event: 'CLOSED' });
  process.disconnect?.();
} else {
  const { JournalLease } = await import('../../src/server/runtime-coordinator/JournalLease');
  let lease: InstanceType<typeof JournalLease>;
  try { lease = new JournalLease(target); lease.assertCurrent(); }
  catch (error) {
    send({ event: 'REFUSED', message: String(error) });
    process.disconnect?.(); process.exit(2);
  }
  send({ event: 'OWNED' });
  if (mode === 'once') {
    lease.close(); lease.close(); send({ event: 'CLOSED' }); process.disconnect?.();
  } else if (mode === 'hold') {
    process.on('message', (message: string) => {
      if (message === 'close') { lease.close(); lease.close(); send({ event: 'CLOSED' }); process.disconnect?.(); }
      else if (message === 'assert') { lease.assertCurrent(); send({ event: 'CURRENT' }); }
      else throw Error('Unknown lease child command');
    });
  } else throw Error('Unknown lease child mode');
}
