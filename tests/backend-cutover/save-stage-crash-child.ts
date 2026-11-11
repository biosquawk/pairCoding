/** Own tiny process SIGKILL at actual fsynced stage / Store replace / authentic receipt commit. */
import fs from 'node:fs';
import { open } from './save-stage-fixture';
const [root, boundary] = process.argv.slice(2);
const f = await open(root, phase => { if (phase === boundary) process.kill(process.pid, 'SIGKILL'); });
if (boundary === 'COMMITTED') f.core.workspace.on('changed', change => { if (change.actor === 'SETTINGS') process.kill(process.pid, 'SIGKILL'); });
if (boundary === 'STAGED') {
  const actual = f.journal.stageSettings.bind(f.journal);
  f.journal.stageSettings = (...args) => { actual(...args); process.kill(process.pid, 'SIGKILL'); };
}
const input = f.input(), originalProject = f.project(input);
fs.writeSync(1, JSON.stringify({ input, originalProject }) + '\n');
await f.mutations.execute(input, lease => { lease.assertCurrent(); return originalProject; });
throw Error('Actual crash boundary not reached');
