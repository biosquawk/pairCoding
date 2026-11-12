// Separate tsx process avoids mixing the Playwright loader with production JSON schema imports.
import path from 'node:path';
import { createPairCoachServer } from '../../../src/server/http';
const [rootPath, dataDir, token] = process.argv.slice(2);
const app = createPairCoachServer({ rootPath, dataDir, token, port: 0,
  staticDir: path.resolve('dist'), enableCoach: false, enableExecution: true,
  reportGenerate: async facts => `# Saved report ${facts.session.sessionId}\n\nDeterministic provider boundary — not real AI.` });
app.workspace.updateSettings({ ...app.workspace.settings, aiConsent: true });
const port = await app.listen();
process.send?.({ ready: { port, sessionId: app.session.state.sessionId, pid: process.pid } });
process.on('message', message => {
  if (message === 'close') void app.close().then(() => process.exit(0));
});
