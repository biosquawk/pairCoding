import { expect, type Page, type CDPSession } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Fixture } from './fixture';
import type { Proposal, Report, Run, Session, Snapshot } from '../../../src/shared/protocol';

/** Transparent real transport observation. Only retransmission/stale commands originate
 * here; normal user decisions, settings, run, stop, finish and retry originate in GUI. */
export class Wire {
  sent: any[] = []; received: any[] = [];
  private transmit?: (frame: any) => void;
  async install(page: Page) {
    await page.routeWebSocket('**/ws/session', route => {
      const backend = route.connectToServer();
      this.transmit = frame => { this.sent.push(frame); backend.send(JSON.stringify(frame)); };
      route.onMessage(raw => { const m = JSON.parse(raw.toString()); this.sent.push(m); backend.send(raw); });
      backend.onMessage(raw => { this.received.push(JSON.parse(raw.toString())); route.send(raw); });
    });
  }
  identity() {
    const hello = this.sent.find(m => m.type === 'HELLO');
    if (!hello) throw new Error('No real browser HELLO');
    return { clientId: hello.clientId as string, sessionId: hello.sessionId as string };
  }
  command(type: string, payload: unknown) {
    if (!this.transmit) throw new Error('Real WS not connected');
    const frame = { protocolVersion: '3.0', messageId: randomUUID(), ...this.identity(), type, payload };
    this.transmit(frame); return frame;
  }
  async ack(frame: any) {
    await expect.poll(() => this.received.find(m => m.type === 'ACK' && m.payload.replyTo === frame.messageId)).toBeTruthy();
    return this.received.find(m => m.type === 'ACK' && m.payload.replyTo === frame.messageId).payload;
  }
  async ok(frame: any) { const ack = await this.ack(frame); expect(ack.status).toBe('OK'); expect(ack.error).toBeNull(); return ack; }
  proposals(): Proposal[] { return this.received.filter(m => m.type === 'ACTION_PROPOSAL').map(m => m.payload); }
}
export async function get<T>(page: Page, f: Fixture, url: string): Promise<T> {
  const r = await page.request.get(f.baseURL + '/api' + url, { headers: { Authorization: `Bearer ${f.token}` } });
  expect(r.status(), await r.text()).toBe(200); return r.json();
}
export const session = (p: Page, f: Fixture) => get<Session>(p, f, '/session');
export const snapshots = (p: Page, f: Fixture) => get<Snapshot[]>(p, f, '/snapshots');
export const report = (p: Page, f: Fixture, w: Wire) => get<Report>(p, f, '/session/report?sessionId=' + w.identity().sessionId);
export const editor = (p: Page, file = 'main.py') => p.locator('.monaco-editor').getByRole('textbox', { name: `Edytor pliku ${file}`, exact: true });
export async function open(page: Page, f: Fixture, wire: Wire, start = true) {
  await wire.install(page); await page.goto(f.baseURL); await page.getByText('main.py', { exact: true }).first().click();
  await expect(editor(page)).toBeVisible();
  await expect.poll(() => wire.sent.some(m => m.type === 'HELLO')).toBe(true);
  if (start) {
    const [r] = await Promise.all([page.waitForResponse(r => r.url().endsWith('/api/session/start') && r.request().method() === 'POST'),
      page.getByRole('button', { name: 'Start sesji', exact: true }).click()]);
    expect(r.status()).toBe(200); expect((await r.json()).lifecycle).toBe('RUNNING');
  }
}
export async function append(page: Page, text: string, file = 'main.py') {
  await editor(page, file).focus(); await page.keyboard.press('ControlOrMeta+End'); await page.keyboard.insertText(text);
}
export function acknowledged(wire: Wire, expected: string, file: string) {
  return wire.sent.some(m => m.type === 'CODE_CHANGED' && m.payload.path === file && m.payload.content === expected &&
    wire.received.some(a => a.type === 'ACK' && a.payload.replyTo === m.messageId && a.payload.status === 'OK' &&
      a.payload.error === null && a.payload.controlEpoch === m.payload.controlEpoch && a.payload.documentVersion > m.payload.baseVersion));
}
export async function saved(f: Fixture, w: Wire, expected: string, file = 'main.py') {
  await expect.poll(() => acknowledged(w, expected, file)).toBe(true); expect(f.read(file)).toBe(expected);
}
export async function settings(page: Page) {
  await page.getByTitle('Ustawienia projektu (AI Consent, Task Mode, Profile)', { exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Ustawienia Projektu i Trenera AI', exact: true });
  await expect(dialog).toBeVisible(); return dialog;
}
export async function configureProfiles(page: Page, f: Fixture, profiles: unknown[]) {
  const dialog = await settings(page);
  await dialog.getByText('Konfiguracja Run/Test i kontekstu AI', { exact: true }).click();
  // Existing delivered fullclient public labels. Missing UI is a real FAIL, never REST fallback.
  await dialog.getByLabel('Profile uruchamiania (JSON, [] = brak)', { exact: true }).fill(JSON.stringify(profiles));
  const [r] = await Promise.all([page.waitForResponse(r => r.url().endsWith('/api/project/settings') && r.request().method() === 'PUT'),
    dialog.getByRole('button', { name: 'Zapisz Ustawienia', exact: true }).click()]);
  expect(r.status(), await r.text()).toBe(200);
  expect((await r.json()).settings.runProfiles).toEqual(profiles);
  await expect(dialog).toHaveCount(0);
  expect((await get<any>(page, f, '/project')).settings.runProfiles).toEqual(profiles);
}
export async function requestRestore(page: Page, w: Wire, label: string): Promise<Proposal> {
  const before = w.proposals().length, dialog = await settings(page);
  const row = dialog.getByText(label, { exact: true }).locator('..').locator('..');
  await row.getByRole('button', { name: 'Poproś o przywrócenie', exact: true }).click();
  await expect.poll(() => w.proposals().length).toBe(before + 1);
  const p = w.proposals().at(-1)!;
  expect(p.resetTimer).toBe(false); expect(p.snapshotId).not.toBeNull();
  return p;
}
export async function chat(page: Page, text: string) {
  await page.getByRole('button', { name: /^Czat/ }).click();
  const input = page.getByPlaceholder(/wiadomość|zapytaj|pytanie|trenera/i);
  await input.fill(text); await input.press('Enter');
}
export async function pause(page: Page, f: Fixture) {
  await page.getByRole('button', { name: 'Pauza czasu', exact: true }).click();
  await expect.poll(async () => (await session(page, f)).timer.manualPaused).toBe(true);
}
export async function veto(page: Page, f: Fixture) {
  await editor(page).focus(); await page.keyboard.press('Escape'); await page.keyboard.press('Escape');
  await expect.poll(async () => (await session(page, f)).cooldownAfterVeto).toBe(true);
}
export async function run(page: Page, mode: 'RUN_MAIN' | 'RUN_TESTS'): Promise<Run> {
  const [r] = await Promise.all([page.waitForResponse(r => r.url().endsWith('/api/run') && r.request().method() === 'POST'),
    page.getByRole('button', { name: mode === 'RUN_MAIN' ? 'Run Main' : 'Run Tests', exact: true }).click()]);
  expect(r.status(), await r.text()).toBe(202); return r.json();
}
export async function terminal(page: Page, f: Fixture, id: string): Promise<Run> {
  await expect.poll(async () => (await get<Run>(page, f, '/run/' + id)).finishedAt).not.toBeNull();
  return get<Run>(page, f, '/run/' + id);
}
export async function finish(page: Page, reason: 'COMPLETED' | 'ABANDONED'): Promise<Report> {
  await page.getByRole('button', { name: reason === 'COMPLETED' ? '🏁 Zakończ' : 'Porzuć', exact: true }).click();
  const [r] = await Promise.all([page.waitForResponse(r => r.url().endsWith('/api/session/finish') && r.request().method() === 'POST'),
    page.getByRole('button', { name: 'Potwierdź i Wygeneruj Raport', exact: true }).click()]);
  expect(r.status(), await r.text()).toBe(202); const result = await r.json();
  expect(result.status).toBe('PENDING'); expect(result.reason).toBe(reason); return result;
}
/** Actual browser minimize/restore, not a forged visibilitychange or WS WINDOW_STATE.
 * Headed Chromium is mandatory. Scope: only this Playwright-launched browser window. */
export async function hide(page: Page, f: Fixture, w: Wire) {
  const cdp: CDPSession = await page.context().newCDPSession(page);
  const { windowId } = await cdp.send('Browser.getWindowForTarget');
  await cdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'minimized' } });
  const restore = async () => { await cdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } }); await page.bringToFront(); await cdp.detach(); };
  try {
    await expect.poll(() => page.evaluate(() => document.visibilityState)).toBe('hidden');
    await expect.poll(async () => (await session(page, f)).presence).toBe('HIDDEN');
    expect(w.sent.some(m => m.type === 'WINDOW_STATE' && m.payload.presence === 'HIDDEN')).toBe(true);
    return restore;
  } catch (e) { await restore(); throw e; }
}
export function snapshotText(f: Fixture, id: string, p: string) {
  const file = f.frozen(id).files.find(x => x.path === p);
  if (!file || file.rawBase64 === null) throw new Error('Missing real frozen file: ' + p);
  return Buffer.from(file.rawBase64, 'base64').toString('utf8');
}
export function treePids(f: Fixture) {
  return ['parent.pid', 'child.pid'].map(p => Number(fs.readFileSync(path.join(f.rootPath, p), 'utf8')));
}
