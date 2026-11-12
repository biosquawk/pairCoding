// Kept as a real integration harness. Only the provider response is deterministic.
// The IPC capture comes from the actual CoachAdapter.decide boundary, not a mock WS.
import path from 'node:path';
import { createPairCoachServer } from '../../../src/server/http';
const [rootPath, dataDir, token] = process.argv.slice(2);
const app = createPairCoachServer({ rootPath, dataDir, token, port: 0, staticDir: path.resolve('dist'), enableCoach: true,
  coachProvider: { name: 'editor-view-p2-capture', decide: async context => {
    process.send?.({ capture: context });
    return { kind: 'REPLY', text: 'Deterministic capture response — not external AI.' };
  } } });
app.workspace.updateSettings({ ...app.workspace.settings, aiConsent: true, contextPatterns: ['**/*.ts', '**/*.md'] });
const port = await app.listen();
process.send?.({ ready: { port, projectId: app.workspace.projectId, sessionId: app.session.state.sessionId, pid: process.pid } });
process.on('message', message => { if (message === 'close') void app.close().then(() => process.exit(0)); });
