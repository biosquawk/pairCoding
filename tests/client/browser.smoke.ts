/** Real browser + real backend smoke. No simulator, fabricated ACK or mock server. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { chromium } from 'playwright';
import { createPairCoachServer } from '../../src/server/http';

const output = process.env.PAIRCOACH_SMOKE_OUT;
if (!output) throw new Error('Set PAIRCOACH_SMOKE_OUT to a writable evidence directory.');
fs.mkdirSync(output, { recursive: true });
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'p2-browser-real-'));
const root = path.join(tmp, 'workspace'); fs.mkdirSync(root);
fs.writeFileSync(path.join(root, 'challenge.md'), '# Zadanie testowe\nZmień kod i sprawdź zapis.\n');
fs.writeFileSync(path.join(root, 'solution.ts'), 'const value = 0;\n');
fs.writeFileSync(path.join(root, 'other.py'), 'value = 1\n');
const app = createPairCoachServer({ rootPath: root, dataDir: path.join(tmp, 'data'), port: 0, devBootstrap: true, staticDir: path.resolve('dist') });
const port = await app.listen();
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
const observations: string[] = [];
const until = async (condition: () => boolean | Promise<boolean>, label: string) => {
  const end = Date.now() + 7000;
  while (!await condition()) { if (Date.now() > end) throw new Error(`Timeout: ${label}`); await new Promise(r => setTimeout(r, 25)); }
};
try {
  browser = await chromium.launch({ headless: true, executablePath: process.env.PAIRCOACH_BROWSER });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto(`http://127.0.0.1:${port}/`);
  await until(() => page.getByText('Połączono z backendem.', { exact: true }).isVisible(), 'LIVE backend connection');
  const started = page.waitForResponse(response => response.url().endsWith('/api/session/start') && response.request().method() === 'POST');
  await page.getByTitle('Start sesji', { exact: true }).click();
  assert.equal((await started).status(), 200);
  await until(() => app.session.getSession().lifecycle === 'RUNNING', 'Start changes lifecycle to RUNNING');
  await page.getByTitle('Pauza czasu', { exact: true }).click();
  await page.getByTitle('Wznów czas', { exact: true }).waitFor({ state: 'visible' });
  await page.getByTitle('Wznów czas', { exact: true }).click();
  await page.getByTitle('Pauza czasu', { exact: true }).waitFor({ state: 'visible' });
  observations.push('actual Start click POST200/lifecycle RUNNING; Pause and Resume PASS');
  await page.getByText('solution.ts', { exact: true }).first().click();
  const editor = page.getByRole('textbox', { name: 'Edytor pliku solution.ts', exact: true });
  await editor.waitFor({ state: 'visible' });
  await editor.focus(); await page.keyboard.press('ControlOrMeta+End'); await page.keyboard.insertText('// browser smoke\n');
  await until(() => fs.readFileSync(path.join(root, 'solution.ts'), 'utf8').includes('browser smoke'), 'autosave writes real file');
  observations.push('LIVE default, actual Monaco typing, POST/WS bootstrap and disk write PASS');
  await page.reload(); await page.getByText('solution.ts', { exact: true }).first().click();
  await until(async () => (await page.locator('.monaco-editor .view-lines').innerText()).includes('browser smoke'), 'reload persisted disk');
  observations.push('reload shows confirmed disk content PASS');
  await page.getByTitle('Ustawienia projektu (AI Consent, Task Mode, Profile)').click();
  await page.getByText('Konfiguracja Run/Test i kontekstu AI', { exact: true }).click();
  await page.getByLabel('Profile uruchamiania (JSON, [] = brak)').fill('["node main.js"]');
  await page.getByRole('button', { name: 'Zapisz Ustawienia', exact: true }).click();
  await until(() => page.getByRole('alert').filter({ hasText: /Profil 1:/ }).isVisible(), 'invalid profiles validation');
  assert.deepEqual(app.workspace.settings.runProfiles, []);
  const approved = [{ kind: 'RUN_MAIN', executable: 'node', args: ['main.js'], cwd: '.', timeoutMs: 1000, testReportFormat: 'NONE', testReportGlob: null }];
  await page.getByLabel('Profile uruchamiania (JSON, [] = brak)').fill(JSON.stringify(approved));
  await page.getByLabel('Wzorce plików kontekstu AI (JSON)').fill('["**/*.ts"]');
  await page.getByRole('button', { name: 'Zapisz Ustawienia', exact: true }).click();
  await until(() => app.workspace.settings.runProfiles.length === 1, 'real settings PUT');
  await until(async () => !await page.getByRole('dialog').isVisible(), 'settings confirmed and closed');
  assert.deepEqual(app.workspace.settings.runProfiles, approved);
  observations.push('settings invalid profile blocked; valid structured executable/args saved to real backend PASS');
  await page.getByTitle('Ustawienia projektu (AI Consent, Task Mode, Profile)').click();
  assert.match(await page.getByLabel('Profile uruchamiania (JSON, [] = brak)').inputValue(), /main.js/);
  await page.getByLabel('Zamknij ustawienia').click();
  await page.screenshot({ path: path.join(output, 'live-desktop.png') });
  // Explicitly delay the real CODE_CHANGED network send, not a fake service.
  let held = false;
  await page.routeWebSocket('**/ws/session', route => {
    const backend = route.connectToServer();
    route.onMessage(raw => { const frame = JSON.parse(raw.toString()); if (frame.type === 'CODE_CHANGED') held = true; else backend.send(raw); });
    backend.onMessage(raw => route.send(raw));
  });
  await page.reload(); await page.getByText('solution.ts', { exact: true }).first().click();
  await editor.waitFor({ state: 'visible' }); await editor.focus(); await page.keyboard.press('ControlOrMeta+End'); await page.keyboard.insertText('// local protected\n');
  await until(() => held, 'pending real network edit');
  fs.writeFileSync(path.join(root, 'solution.ts'), 'const external = 5;\n'); app.workspace.scanExternal();
  await until(() => page.getByText('Konflikt synchronizacji:', { exact: false }).isVisible(), 'conflict banner');
  assert.match(await page.locator('.monaco-editor .view-lines').innerText(), /local protected/);
  assert.match(fs.readFileSync(path.join(root, 'solution.ts'), 'utf8'), /external/);
  await page.getByText('Porównaj zachowane wersje', { exact: true }).click();
  assert.match(await page.getByLabel('Draft lokalny konfliktu').inputValue(), /local protected/);
  assert.match(await page.getByLabel('Wersja z dysku konfliktu').inputValue(), /external/);
  observations.push('real external file update + delayed WS preserves both conflict versions PASS');
  await page.screenshot({ path: path.join(output, 'live-conflict.png') });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: path.join(output, 'live-mobile-conflict.png') });
  observations.push('390x844 rendered screenshot; not a complete mobile usability certification');
  assert.deepEqual(errors, []);
  fs.writeFileSync(path.join(output, 'browser-observations.json'), JSON.stringify({ browserVersion: browser.version(), platform: process.platform, viewports: ['1440x1000', '390x844'], observations, pageErrors: errors }, null, 2));
  console.log(JSON.stringify({ result: 'PASS', observations, browser: browser.version() }));
} finally {
  await browser?.close(); await app.close(); fs.rmSync(tmp, { recursive: true, force: true });
}
