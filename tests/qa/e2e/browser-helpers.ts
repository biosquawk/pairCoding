import { expect, type Page, type WebSocketRoute } from '@playwright/test';
import { readFileSync } from 'node:fs';
import path from 'node:path';

export const manifest = () => JSON.parse(readFileSync('tests/qa/.runtime/browser-manifest.json', 'utf8'));
export const disk = () => readFileSync(path.join(manifest().rootPath, 'main.py'), 'utf8').replace(/\r\n/g, '\n');
export const editorText = async (page: Page) => (await page.locator('.monaco-editor .view-lines').innerText()).replace(/\u00a0/g, ' ');
// Monaco can use either native EditContext DIV or legacy textarea; both expose this role/name.
export const editorInput = (page: Page) => page.locator('.monaco-editor')
  .getByRole('textbox', { name: 'Edytor pliku main.py', exact: true });

/** Focus the accessible input; native EditContext's DIV sits under Monaco's view-lines. */
export async function focusEditor(page: Page) {
  const input = editorInput(page);
  await expect(input).toBeVisible();
  await input.focus();
  await expect(input).toBeFocused();
}

export async function openEditor(page: Page) {
  await page.goto('/');
  await page.getByText('main.py', { exact: true }).first().click();
  await expect(page.locator('.monaco-editor')).toBeVisible();
  await expect.poll(() => editorText(page)).toContain('value = 0');
  const start = page.getByRole('button', { name: 'Start sesji', exact: true });
  if (await start.isVisible()) {
    // Register before clicking; a timer RESUME frame is not a successful session START.
    const [response] = await Promise.all([
      page.waitForResponse(reply => new URL(reply.url()).pathname === '/api/session/start'
        && reply.request().method() === 'POST'),
      start.click(),
    ]);
    expect(response.status()).toBe(200);
    const session = await response.json();
    expect(session.lifecycle).toBe('RUNNING');
    expect(session.timer.status).toBe('RUNNING');
  }
  // Later tests can reconnect to an already-running real fixture session.
  await expect(page.getByRole('button', { name: 'Pauza czasu', exact: true })).toBeVisible();
  await expect(start).not.toBeVisible();
}
export async function append(page: Page, text: string) {
  await focusEditor(page); await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.insertText(text);
}
export async function chat(page: Page, text: string) {
  await page.getByRole('button', { name: /^Czat/ }).click();
  const input = page.getByPlaceholder(/wiadomość|zapytaj|pytanie|trenera/i);
  await input.fill(text); await input.press('Enter');
}

/** Transparent real WS relay: network delay only, never fabricated payloads/ACKs. */
export class Relay {
  sent: any[] = []; received: any[] = [];
  heldIncoming: { raw: string | Buffer; route: WebSocketRoute; data: any }[] = [];
  heldOutgoing: { raw: string | Buffer; send: (raw: string | Buffer) => void; data: any }[] = [];
  holdIn: (frame: any) => boolean = () => false;
  holdOut: (frame: any) => boolean = () => false;
  async install(page: Page) {
    await page.routeWebSocket('**/ws/session', route => {
      const backend = route.connectToServer();
      route.onMessage(raw => {
        const data = JSON.parse(raw.toString()); this.sent.push(data);
        if (this.holdOut(data)) this.heldOutgoing.push({ raw, send: x => backend.send(x), data });
        else backend.send(raw);
      });
      backend.onMessage(raw => {
        const data = JSON.parse(raw.toString()); this.received.push(data);
        if (this.holdIn(data)) this.heldIncoming.push({ raw, route, data });
        else route.send(raw);
      });
    });
  }
  releaseIncoming() { for (const frame of this.heldIncoming.splice(0)) frame.route.send(frame.raw); }
  releaseOutgoing() { for (const frame of this.heldOutgoing.splice(0)) frame.send(frame.raw); }
}
