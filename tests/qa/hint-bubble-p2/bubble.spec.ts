import { test, expect } from '@playwright/test';
import { createServer, type ViteDevServer } from 'vite';
import fs from 'node:fs';
let server: ViteDevServer, url: string;
test.beforeAll(async () => {
  server = await createServer({ configLoader: 'runner', server: { host: '127.0.0.1', port: 0, strictPort: false, hmr: false, watch: null } });
  await server.listen(); const address = server.httpServer!.address();
  if (!address || typeof address === 'string') throw new Error('No ephemeral listener');
  expect([8081, 8765, 8766, 8767, 8768]).not.toContain(address.port);
  url = `http://127.0.0.1:${address.port}/tests/qa/hint-bubble-p2/index.html?mock=1`;
});
test.afterAll(async () => { await server?.close(); });
test('measured actual EditorPanel: drag/resize, parent split, selection fallback, mobile close', async ({ page, browser }, info) => {
  const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto(url);
  const editor = page.getByRole('textbox', { name: 'Edytor pliku main.py' });
  await expect(editor).toBeVisible();
  await page.getByRole('button', { name: 'Pokaż wskazówkę', exact: true }).click();
  const bubble = page.getByRole('region', { name: 'Wskazówka trenera', exact: true });
  const body = page.getByTestId('editor-content-container');
  const close = page.getByRole('button', { name: 'Zamknij dymek', exact: true });
  async function contained() {
    await expect.poll(async () => {
      const b = await bubble.boundingBox(), c = await body.boundingBox();
      return !!b && !!c && b.x >= c.x - 1 && b.y >= c.y - 1 && b.x + b.width <= c.x + c.width + 1 && b.y + b.height <= c.y + c.height + 1;
    }).toBe(true);
    await expect(close).toBeVisible();
    expect(await close.evaluate(el => { const r = el.getBoundingClientRect(); return el.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)); })).toBe(true);
  }
  await expect(bubble).toHaveAttribute('data-hint-mode', 'overlay'); await contained();
  // The active first line must not be obscured; Monaco renders it, not a fake code block.
  async function activeLineUncovered() {
    const line = await page.locator('.view-line').first().boundingBox(), b = await bubble.boundingBox();
    expect(b!.y >= line!.y + line!.height || b!.y + b!.height <= line!.y).toBe(true);
  }
  await activeLineUncovered();
  await page.screenshot({ path: info.outputPath('desktop-1440x1000.png') });
  const handle = page.getByRole('button', { name: 'Przenieś wskazówkę (strzałki)', exact: true });
  const h = (await handle.boundingBox())!;
  await page.mouse.move(h.x + 8, h.y + 8); await page.mouse.down(); await page.mouse.move(20, 930, { steps: 6 }); await page.mouse.up();
  await contained(); await activeLineUncovered();
  await handle.focus(); await page.keyboard.press('ArrowRight'); await page.keyboard.press('ArrowUp'); await contained();
  const resize = page.getByRole('button', { name: 'Zmień rozmiar wskazówki (strzałki)', exact: true });
  const r = (await resize.boundingBox())!;
  await page.mouse.move(r.x + 5, r.y + 5); await page.mouse.down(); await page.mouse.move(r.x + 55, r.y + 45, { steps: 3 }); await page.mouse.up();
  await contained();
  await resize.focus(); await page.keyboard.press('ArrowRight'); await page.keyboard.press('ArrowDown');
  await editor.focus(); await page.keyboard.press('Control+End'); await page.keyboard.type(' # UNDO_PROBE');
  await expect(page.locator('.view-lines')).toContainText('UNDO_PROBE');
  await page.keyboard.press('Control+z'); await expect(page.locator('.view-lines')).not.toContainText('UNDO_PROBE');
  await page.keyboard.press('Control+Home');
  await page.getByRole('button', { name: 'Długi tekst', exact: true }).click(); await contained();
  await page.getByLabel('Szerokość kontenera', { exact: true }).fill('240');
  await page.getByLabel('Wysokość kontenera', { exact: true }).fill('190');
  await contained(); await activeLineUncovered();
  await page.screenshot({ path: info.outputPath('split-container-longtext.png') });
  // Select all real Monaco code: overlay cannot fit, so the fallback reserves a row.
  await editor.focus(); await page.keyboard.press('Control+Home'); await page.keyboard.press('Control+a');
  await expect(bubble).toHaveAttribute('data-hint-mode', 'parked');
  await expect(bubble).toContainText('Brak miejsca nad kodem'); await contained();
  const b = (await bubble.boundingBox())!, m = (await page.locator('.monaco-editor').first().boundingBox())!;
  expect(b.y + b.height).toBeLessThanOrEqual(m.y + 1);
  await page.screenshot({ path: info.outputPath('selection-parked.png') });
  await page.setViewportSize({ width: 390, height: 844 }); await contained();
  await close.focus(); await page.keyboard.press('Enter'); await expect(bubble).toHaveCount(0);
  await page.getByRole('button', { name: 'Pokaż wskazówkę', exact: true }).click(); await contained();
  await page.screenshot({ path: info.outputPath('mobile-390x844.png') });
  // Tiny parent, not tiny window; docked header and close still fit.
  await page.getByLabel('Szerokość kontenera', { exact: true }).fill('100');
  await page.getByLabel('Wysokość kontenera', { exact: true }).fill('90'); await contained();
  await page.screenshot({ path: info.outputPath('tiny-container.png') });
  await close.click(); await expect(bubble).toHaveCount(0);
  expect(errors).toEqual([]);
  fs.writeFileSync(info.outputPath('proof.json'), JSON.stringify({ revision: process.env.PAIRCOACH_QA_REVISION, node: process.version, browser: browser.version(), viewports: ['1440x1000', '390x844'], url, errors, boundary: 'Actual EditorPanel + actual Monaco; fixture props/local callbacks and parent size controls, NOT App splitter/backend/realAI/native/finalQA.' }, null, 2));
});

// Frozen regression uses only selectors present on the old product, too.
test('regression: long hint stays inside reduced editor parent, not window', async ({ page }, info) => {
  await page.goto(url);
  await expect(page.getByRole('textbox', { name: 'Edytor pliku main.py' })).toBeVisible();
  await page.getByRole('button', { name: 'Długi tekst', exact: true }).click();
  await page.getByRole('button', { name: 'Pokaż wskazówkę', exact: true }).click();
  await page.getByLabel('Szerokość kontenera', { exact: true }).fill('240');
  await page.getByLabel('Wysokość kontenera', { exact: true }).fill('300');
  const close = page.getByTitle('Zamknij dymek', { exact: true });
  const contentContainer = page.getByRole('region', { name: 'Kontener edytora', exact: true }).locator(':scope > div > div').last();
  await expect(close).toBeVisible();
  await expect.poll(async () => {
    const c = (await contentContainer.boundingBox())!;
    // Outer bubble is the nearest ancestor that contains both header and content.
    const b = await close.evaluate(el => {
      const region = el.closest('[data-hint-mode]') ?? el.parentElement!.parentElement!.parentElement!;
      const r = region.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height };
    });
    return b.x >= c.x - 1 && b.y >= c.y - 1 && b.x + b.width <= c.x + c.width + 1 && b.y + b.height <= c.y + c.height + 1;
  }).toBe(true);
  await page.screenshot({ path: info.outputPath('regression-contained.png') });
});
