import fs from 'node:fs';
import path from 'node:path';
import { fork, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { expect, type Page, type WebSocketRoute } from '@playwright/test';
import { filesBelow } from '../g3/fixture';
import type { Proposal, Snapshot, Session, Report } from '../../../src/shared/protocol';
export const seed = 'value = 0\n', human = seed + '# human before restore\n';

export class Backend {
  readonly base: string; readonly rootPath: string; readonly dataDir: string;
  readonly token = 'mvp2-qa-' + randomUUID();
  child?: ChildProcess; messages: any[] = []; stderr = ''; baseURL = '';
  ready!: { port: number; snapshotId: string; sessionId: string };
  constructor() {
    const root = path.resolve('artifacts/mvp2-reconcile'); fs.mkdirSync(root, { recursive: true });
    this.base = fs.mkdtempSync(path.join(root, 'case-'));
    this.rootPath = path.join(this.base, 'project'); this.dataDir = path.join(this.rootPath, '.paircoach');
    fs.mkdirSync(this.rootPath); fs.mkdirSync(this.dataDir);
    fs.writeFileSync(path.join(this.rootPath, 'main.py'), seed);
    fs.writeFileSync(path.join(this.rootPath, 'challenge.md'), '# Reconcile a real snapshot\n');
  }
  async start(port = 0) {
    if (!fs.existsSync('dist/index.html')) throw new Error('Run npm run build before real GUI tests');
    const offset = this.messages.length;
    this.child = fork(fileURLToPath(new URL('./server.ts', import.meta.url)),
      [this.rootPath, this.dataDir, this.token, String(port)],
      { execArgv: ['--import', 'tsx'], stdio: ['ignore', 'ignore', 'pipe', 'ipc'], windowsHide: true });
    this.child.stderr!.on('data', b => { this.stderr += b; });
    this.child.on('message', m => this.messages.push(m));
    await expect.poll(() => this.messages.slice(offset).find(m => m.ready) ??
      ((this.child!.exitCode !== null || this.child!.signalCode !== null) ? `EXIT:${this.stderr}` : undefined),
      { timeout: 10000 }).toEqual(expect.objectContaining({ ready: expect.any(Object) }));
    this.ready = this.messages.slice(offset).find(m => m.ready).ready;
    expect([8080, 8765, 8766, 8767, 8768]).not.toContain(this.ready.port);
    this.baseURL = `http://127.0.0.1:${this.ready.port}`;
    return this;
  }
  async arm(kind: 'restore' | 'finish' | 'crash') {
    const offset = this.messages.length; this.child!.send({ arm: kind });
    await expect.poll(() => this.messages.slice(offset).some(m => m.armed === kind)).toBe(true);
  }
  async kill() {
    if (this.child && this.child.exitCode === null && this.child.signalCode === null) {
      const exited = once(this.child, 'exit'); this.child.kill('SIGKILL'); await exited;
    }
  }
  async close() {
    if (!this.child || this.child.exitCode !== null || this.child.signalCode !== null) return;
    const exited = once(this.child, 'exit'); this.child.send('close');
    const timer = setTimeout(() => this.child?.kill('SIGKILL'), 2000);
    try { await exited; } finally { clearTimeout(timer); }
  }
  read() { return fs.readFileSync(path.join(this.rootPath, 'main.py'), 'utf8'); }
  checkpoints(): any[] {
    const p = path.join(this.dataDir, 'checkpoints.jsonl');
    return fs.existsSync(p) ? fs.readFileSync(p, 'utf8').trim().split('\n').map(l => JSON.parse(l)) : [];
  }
  events(): any[] {
    const p = path.join(this.dataDir, 'events.jsonl');
    return fs.existsSync(p) ? fs.readFileSync(p, 'utf8').trim().split('\n').map(l => JSON.parse(l)) : [];
  }
  evidence() { return { platform: process.platform, node: process.version, revision: process.env.PAIRCOACH_QA_REVISION ?? 'UNSPECIFIED',
    base: this.base, files: filesBelow(this.base), checkpoints: this.checkpoints(), events: this.events(), messages: this.messages, stderr: this.stderr,
    boundary: 'Real child backend/FS/HTTP/WS/React/Monaco. Explicit 6500ms latency; deterministic report text only. NOT scaled/native/real AI proof.' }; }
}

/** Transparent observation by default. The conflict scenario explicitly parks real
 * network deliveries; it never invents ACK/snapshot/error/content or calls Monaco APIs. */
export class Wire {
  sent: any[] = []; received: any[] = []; delivered: any[] = []; http: any[] = [];
  holdServer = false; holdSaves = false;
  private queued: { route: WebSocketRoute; raw: string | Buffer; message: any }[] = [];
  heldSaves: any[] = [];
  async install(page: Page) {
    page.on('request', r => {
      if (r.url().includes('/api/')) this.http.push({ at: Date.now(), method: r.method(), url: r.url(), body: r.postDataJSON(),
        authorized: /^Bearer .+/.test(r.headers()['authorization'] ?? '') });
    });
    await page.routeWebSocket('**/ws/session', route => {
      const backend = route.connectToServer();
      route.onMessage(raw => {
        const message = JSON.parse(raw.toString()); this.sent.push({ ...message, observedAt: Date.now() });
        if (this.holdSaves && message.type === 'CODE_CHANGED') { this.heldSaves.push(message); return; }
        backend.send(raw);
      });
      backend.onMessage(raw => {
        const message = JSON.parse(raw.toString()); this.received.push({ ...message, observedAt: Date.now() });
        if (this.holdServer) this.queued.push({ route, raw, message });
        else { this.delivered.push({ ...message, observedAt: Date.now() }); route.send(raw); }
      });
      backend.onClose((code, reason) => route.close({ code, reason }));
      route.onClose((code, reason) => backend.close({ code, reason }));
    });
  }
  release() {
    this.holdServer = false;
    for (const { route, raw, message } of this.queued) { this.delivered.push({ ...message, observedAt: Date.now() }); route.send(raw); }
    this.queued = [];
  }
  decisions() { return this.sent.filter(m => m.type === 'PROPOSAL_RESPONSE'); }
  ack(message: any) { return this.received.find(m => m.type === 'ACK' && m.payload.replyTo === message.messageId); }
  dump() {
    const redact = (m: any) => m.type === 'HELLO' ? { ...m, payload: { ...m.payload, token: '[EPHEMERAL_QA_REDACTED]' } } : m;
    return { sent: this.sent.map(redact), received: this.received, delivered: this.delivered, http: this.http,
      heldSaves: this.heldSaves, queuedCount: this.queued.length };
  }
}
export async function get<T>(p: Page, f: Backend, endpoint: string): Promise<T> {
  const response = await p.request.get(f.baseURL + '/api' + endpoint, { headers: { Authorization: `Bearer ${f.token}` } });
  expect(response.status(), await response.text()).toBe(200); return response.json();
}
export const snapshots = (p: Page, f: Backend) => get<Snapshot[]>(p, f, '/snapshots');
export const session = (p: Page, f: Backend) => get<Session>(p, f, '/session');
export const report = (p: Page, f: Backend, sessionId: string) => get<Report>(p, f, '/session/report?sessionId=' + sessionId);
export async function open(p: Page, f: Backend, w: Wire) {
  await w.install(p); await p.goto(f.baseURL);
  await p.getByText('main.py', { exact: true }).first().click();
  await expect(p.getByRole('textbox', { name: 'Edytor pliku main.py', exact: true })).toBeVisible();
  const [response] = await Promise.all([p.waitForResponse(r => r.url().endsWith('/api/session/start') && r.request().method() === 'POST'),
    p.getByRole('button', { name: 'Start sesji', exact: true }).click()]);
  expect(response.status()).toBe(200);
}
export async function requestRestore(p: Page, w: Wire): Promise<Proposal> {
  await p.getByTitle('Ustawienia projektu (AI Consent, Task Mode, Profile)', { exact: true }).click();
  const dialog = p.getByRole('dialog', { name: 'Ustawienia Projektu i Trenera AI', exact: true });
  const row = dialog.getByText('MVP2 original', { exact: true }).locator('..').locator('..');
  await row.getByRole('button', { name: 'Poproś o przywrócenie', exact: true }).click();
  await expect.poll(() => w.received.find(m => m.type === 'ACTION_PROPOSAL')).toBeTruthy();
  return w.received.find(m => m.type === 'ACTION_PROPOSAL').payload;
}
export async function saved(p: Page, f: Backend, w: Wire, content: string) {
  await expect.poll(() => w.sent.some(m => m.type === 'CODE_CHANGED' && m.payload.content === content &&
    w.ack(m)?.payload.status === 'OK' && w.ack(m)?.payload.error === null &&
    w.ack(m)?.payload.documentVersion > m.payload.baseVersion)).toBe(true);
  expect(f.read()).toBe(content);
}
