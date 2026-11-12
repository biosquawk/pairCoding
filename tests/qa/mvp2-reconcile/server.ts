// Test-only latency, never substituted persistence/gate/HTTP/WS or client timers.
// A separate process is essential: blocking this checkpoint must not block the UI.
import fs from 'node:fs';
import path from 'node:path';
import { createPairCoachServer } from '../../../src/server/http';

const [rootPath, dataDir, token, portArg] = process.argv.slice(2);
const app = createPairCoachServer({ rootPath, dataDir, token, port: Number(portArg),
  devBootstrap: true, staticDir: path.resolve('dist'), enableCoach: false, enableExecution: true,
  reportGenerate: async () => 'MVP2 GUI reconciliation: deterministic report boundary, NOT real AI.',
});
app.workspace.updateSettings({ ...app.workspace.settings, taskFilePath: 'challenge.md', aiConsent: true });
const metaPath = path.join(dataDir, 'fixture-meta.json');
const source = fs.existsSync(metaPath) ? JSON.parse(fs.readFileSync(metaPath, 'utf8'))
  : app.workspace.createSnapshot('MVP2 original', ['main.py']);
fs.writeFileSync(metaPath, JSON.stringify(source));
let armed: 'restore' | 'finish' | 'crash' | null = null;
app.workspace.on('snapshotCheckpoint', event => {
  fs.appendFileSync(path.join(dataDir, 'events.jsonl'), JSON.stringify({ ...event, at: Date.now(), pid: process.pid }) + '\n');
  if (!armed) return;
  const expected = armed === 'finish' ? 'SNAPSHOT_FILE_CAPTURED' : 'BEFORE_PUBLICATION';
  if (event.phase !== expected) return;
  const kind = armed; armed = null;
  const checkpoint = { kind, ...event, at: Date.now(), pid: process.pid };
  fs.appendFileSync(path.join(dataDir, 'checkpoints.jsonl'), JSON.stringify(checkpoint) + '\n');
  process.send?.({ checkpoint });
  // 6500ms deterministic latency; crash parks here until the parent SIGKILLs us.
  // NOT a scaled restore benchmark, production 5000ms deadlines are untouched.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, kind === 'crash' ? 30000 : 6500);
});
const port = await app.listen();
process.send?.({ ready: { port, snapshotId: source.snapshotId, sessionId: app.session.state.sessionId } });
process.on('message', (message: any) => {
  if (message?.arm) { armed = message.arm; process.send?.({ armed }); }
  if (message === 'close') void app.close().then(() => process.exit(0));
});
