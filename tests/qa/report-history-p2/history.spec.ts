// Short developer integration proof, NOT final campaign/native/model acceptance.
// Real production HTTP/WS/FS/report persistence + built React. Only generated text
// is a deterministic provider boundary; no forged history responses or model API.
import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fork, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';

test('history A survives B and another restart, stays read-only, current report is separate', async ({ page, browser }, info) => {
  const base = fs.mkdtempSync(path.resolve('artifacts/report-history-p2-fixture-'));
  const rootPath = path.join(base, 'project'), dataDir = path.join(base, 'data');
  fs.mkdirSync(rootPath); fs.writeFileSync(path.join(rootPath, 'main.py'), 'value = 1\n');
  fs.writeFileSync(path.join(rootPath, 'challenge.md'), '# History proof\n');
  const token = `history-test-${randomUUID()}`;
  let child: ChildProcess | undefined, url = '', sessionId = '', stderr = '';
  const starts: { port: number; sessionId: string; pid: number }[] = [];
  async function close() {
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    const exited = once(child, 'exit'); child.send('close');
    const timer = setTimeout(() => child?.kill('SIGKILL'), 2000);
    try { await exited; } finally { clearTimeout(timer); }
  }
  const requests: { method: string; path: string; authorized: boolean }[] = [];
  page.on('request', r => { if (new URL(r.url()).pathname.startsWith('/api/session/report')) requests.push({
    method: r.method(), path: new URL(r.url()).pathname, authorized: r.headers().authorization === `Bearer ${token}` }); });
  async function open() {
    let ready: { port: number; sessionId: string; pid: number } | undefined;
    child = fork(fileURLToPath(new URL('./server.ts', import.meta.url)), [rootPath, dataDir, token],
      { execArgv: ['--import', 'tsx'], stdio: ['ignore', 'ignore', 'pipe', 'ipc'], windowsHide: true });
    child.stderr!.on('data', b => { stderr += b; });
    child.on('message', (m: any) => { if (m.ready) ready = m.ready; });
    await expect.poll(() => ready ?? (child!.exitCode !== null ? `EXIT:${stderr}` : undefined))
      .toEqual(expect.objectContaining({ port: expect.any(Number) }));
    const { port } = ready!; sessionId = ready!.sessionId; starts.push(ready!);
    expect([8080, 8081, 8765, 8766, 8767, 8768]).not.toContain(port);
    url = `http://127.0.0.1:${port}`;
    await page.goto(`${url}/#token=${token}`);
    await expect(page.getByText('Połączono z backendem.', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: /^Raport$/ }).click();
  }
  const list = () => page.getByRole('button', { name: 'Odśwież listę', exact: true }).click();
  const selector = () => page.getByLabel('Poprzednie raporty', { exact: true });
  const reportBody = () => page.getByRole('region', { name: 'Raporty sesji' });
  async function finishCurrent() {
    await page.getByRole('button', { name: '🏁 Zakończ', exact: true }).click();
    await page.getByRole('button', { name: 'Potwierdź i Wygeneruj Raport', exact: true }).click();
    await expect(reportBody().getByRole('heading', { name: `Saved report ${sessionId}`, exact: true })).toBeVisible();
  }
  try {
    await open(); const sessionA = sessionId;
    await list(); await expect(page.getByText('Brak zapisanych raportów w tym projekcie.', { exact: true })).toBeVisible();
    await finishCurrent();
    await page.goto('about:blank'); await close(); await open();
    const sessionB = sessionId; expect(sessionB).not.toBe(sessionA);
    await list();
    // Keyboard-accessible native selector; no injected React state or Monaco API.
    await selector().focus(); await page.keyboard.press('ArrowDown'); await page.keyboard.press('Enter');
    await expect(selector()).toHaveValue(sessionA);
    await page.keyboard.press('Tab'); // Close native popup before desktop rendering evidence.
    await expect(page.getByRole('heading', { name: 'Poprzedni raport — tylko odczyt', exact: true })).toBeVisible();
    await expect(reportBody().getByRole('heading', { name: `Saved report ${sessionA}`, exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Ponów generowanie raportu', exact: true })).toHaveCount(0);
    expect(sessionId).toBe(sessionB); const current = await (await page.request.get(`${url}/api/session`, { headers: { Authorization: `Bearer ${token}` } })).json();
    expect(current.sessionId).toBe(sessionB); expect(current.lifecycle).not.toBe('FINISHED');
    await page.screenshot({ path: info.outputPath('historical-desktop.png') });
    await page.getByRole('button', { name: 'Bieżący raport', exact: true }).click();
    await expect(reportBody()).toContainText('Raport końcowy zostanie wygenerowany');
    await finishCurrent();
    await selector().selectOption(sessionA);
    await expect(reportBody()).toContainText(`Saved report ${sessionA}`);
    await page.getByRole('button', { name: 'Bieżący raport', exact: true }).click();
    await expect(reportBody()).toContainText(`Saved report ${sessionB}`);
    await page.goto('about:blank'); await close(); await open();
    expect(sessionId).not.toBe(sessionB); await list(); await selector().selectOption(sessionA);
    await expect(reportBody()).toContainText(`Saved report ${sessionA}`);
    await page.setViewportSize({ width: 390, height: 844 });
    // Existing panel maximize is a normal user action to inspect long reports.
    await page.getByRole('button', { name: 'Maksymalizuj dolny panel', exact: true }).click();
    await expect(selector()).toBeVisible();
    const bounds = await selector().boundingBox(); expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(390);
    await page.screenshot({ path: info.outputPath('historical-mobile.png') });
    // Visibility alone misses content horizontally scrolled beneath the file tree.
    for (const target of [page.locator('label[for="report-history-session"]'),
      reportBody().getByRole('heading', { name: 'Poprzedni raport — tylko odczyt', exact: true }),
      page.getByRole('button', { name: 'Odśwież listę', exact: true })]) {
      const box = await target.boundingBox(); expect(box).not.toBeNull();
      expect(box!.x).toBeGreaterThanOrEqual(0); expect(box!.x + box!.width).toBeLessThanOrEqual(390);
      expect(await target.evaluate(el => { const r = el.getBoundingClientRect();
        return el.contains(document.elementFromPoint(r.x + 2, r.y + r.height / 2)); })).toBe(true);
    }

    await page.getByRole('button', { name: 'Bieżący raport', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Bieżący raport', exact: true })).toBeVisible();
    expect(requests.filter(r => r.path === '/api/session/report/retry')).toHaveLength(0);
    expect(requests.every(r => r.authorized)).toBe(true);
    const proof = JSON.stringify({
      revision: process.env.PAIRCOACH_QA_REVISION ?? 'UNSPECIFIED', node: process.version, platform: process.platform,
      browser: browser.version(), viewports: ['1365x900', '390x844'], sessionA, sessionB, sessionAfterRestart: sessionId,
      starts, stderr, requests, boundary: 'Real backend/persistence/UI; deterministic report text provider, NOT real AI/native/final QA.' }, null, 2);
    fs.writeFileSync(info.outputPath('history-proof.json'), proof);
    await info.attach('history-proof', { contentType: 'application/json', body: Buffer.from(proof) });
  } finally { await page.goto('about:blank'); await close(); }
});
