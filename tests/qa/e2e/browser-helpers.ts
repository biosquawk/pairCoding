import { expect, type Page, type WebSocketRoute } from '@playwright/test';
import { readFileSync } from 'node:fs';
import path from 'node:path';

export const manifest = () => JSON.parse(readFileSync('tests/qa/.runtime/browser-manifest.json', 'utf8'));
export const disk = () => readFileSync(path.join(manifest().rootPath, 'main.py'), 'utf8').replace(/\r\n/g, '\n');
export const editorText = async (page: Page) => (await page.locator('.monaco-editor .view-lines').innerText()).replace(/\u00a0/g, ' ');
export const editorInput = (page: Page) => page.locator('.monaco-editor textarea.inputarea');

export async function openEditor(page: Page) {
  await page.goto('/');
  await page.getByText('main.py', { exact: true }).first().click();
  await expect(page.locator('.monaco-editor')).toBeVisible();
  await expect.poll(() => editorText(page)).toContain('value = 0');
  const start = page.getByRole('button', { name: 'Start sesji', exact: true });
  if (await start.isVisible()) await start.click();
}
export async function append(page: Page, text: string) {
  await editorInput(page).click(); await page.keyboard.press('ControlOrMeta+End');
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
