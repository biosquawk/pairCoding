// Deferred real Monaco -> real HTTP/WS -> CoachAdapter provider capture proof.
// No model injection, fabricated ACK, WS interception or externally billed model.
// Execute on integrated stage5+ with the agreed final9 browser environment.
import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fork, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';

test('keyboard Monaco selection reaches next question provider with current ACK version; motion alone never calls provider', async ({ page }, info) => {
  fs.mkdirSync(info.outputDir, { recursive: true });
  const base = fs.mkdtempSync(path.join(info.outputDir, 'editor-view-project-'));
  const root = path.join(base, 'workspace'); fs.mkdirSync(root);
  fs.writeFileSync(path.join(root, 'solution.ts'), 'const selected = "A😀B";\nconst other = 1;\n');
  fs.writeFileSync(path.join(root, 'challenge.md'), '# Context proof\n');
  const token = `editor-view-${randomUUID()}`, captures: any[] = [], frames: any[] = [], errors: string[] = [];
  let child: ChildProcess | undefined, ready: any, stderr = '';
  try {
    child = fork(fileURLToPath(new URL('./server.ts', import.meta.url)), [root, path.join(base, 'data'), token],
      { execArgv: ['--import', 'tsx'], stdio: ['ignore', 'ignore', 'pipe', 'ipc'], windowsHide: true });
    child.stderr!.on('data', data => { stderr += data; });
    child.on('message', (message: any) => { if (message.ready) ready = message.ready; if (message.capture) captures.push(message.capture); });
    await expect.poll(() => ready ?? (child!.exitCode !== null ? `EXIT:${stderr}` : undefined)).toEqual(expect.objectContaining({ port: expect.any(Number) }));
    expect([8080, 8081, 8765, 8766, 8767, 8768]).not.toContain(ready.port);
    page.on('pageerror', error => errors.push(error.message));
    page.on('websocket', socket => socket.on('framesent', frame => frames.push(JSON.parse(String(frame.payload)))));
    const url = `http://127.0.0.1:${ready.port}`;
    await page.goto(`${url}/#token=${token}`);
    await expect(page.getByText('Połączono z backendem.', { exact: true })).toBeVisible();
    await page.getByTitle('Start sesji', { exact: true }).click();
    await expect.poll(() => captures.length).toBeGreaterThan(0);
    await page.getByText('solution.ts', { exact: true }).first().click();
    const editor = page.getByRole('textbox', { name: 'Edytor pliku solution.ts', exact: true });
    await editor.focus(); await page.keyboard.press('ControlOrMeta+Home');
    const before = captures.length;
    await page.keyboard.press('Home'); await page.keyboard.press('Shift+End');
    await expect.poll(() => frames.filter(frame => frame.type === 'VIEW_CHANGED' && frame.payload.path === 'solution.ts').at(-1)?.payload.selection)
      .toEqual({ startLine: 1, startColumn: 1, endLine: 1, endColumn: 25 });
    // Deliberate short idle beyond the existing edit debounce: pure selection is not an edit trigger.
    await page.waitForTimeout(400); expect(captures.length).toBe(before);
    await page.getByRole('button', { name: /^Czat$/ }).click();
    const input = page.getByPlaceholder(/^Napisz do Trenera AI/);
    await input.fill('Explain the selected line'); await input.press('Enter');
    await expect.poll(() => captures.filter(context => context.trigger?.reason === 'CHAT').length).toBe(1);
    const captured = captures.filter(context => context.trigger?.reason === 'CHAT')[0];
    const document = await (await page.request.get(`${url}/api/file?path=solution.ts`, { headers: { Authorization: `Bearer ${token}` } })).json();
    expect(captured.view).toEqual({ projectId: ready.projectId, path: 'solution.ts', documentVersion: document.version,
      cursor: { line: 1, column: 25 }, selection: { startLine: 1, startColumn: 1, endLine: 1, endColumn: 25 },
      selectedText: 'const selected = "A😀B";', selectionTruncated: false });
    expect(frames.filter(frame => frame.type === 'CHAT_MESSAGE')).toHaveLength(1);
    const chatIndex = frames.findIndex(frame => frame.type === 'CHAT_MESSAGE');
    const previousView = frames.slice(0, chatIndex).filter(frame => frame.type === 'VIEW_CHANGED').at(-1);
    expect(previousView.payload.documentVersion).toBe(document.version); expect(previousView.payload.selection).toEqual(captured.view.selection);
    expect(errors).toEqual([]);
    await editor.focus(); await page.keyboard.press('ControlOrMeta+End'); await page.keyboard.insertText('// undo proof');
    await expect.poll(async () => (await (await page.request.get(`${url}/api/file?path=solution.ts`, { headers: { Authorization: `Bearer ${token}` } })).json()).content).toContain('// undo proof');
    await page.keyboard.press('ControlOrMeta+z');
    await expect.poll(async () => (await (await page.request.get(`${url}/api/file?path=solution.ts`, { headers: { Authorization: `Bearer ${token}` } })).json()).content).toBe(document.content);
    await page.screenshot({ path: info.outputPath('editor-selection-context.png') });
    await info.attach('provider-proof', { body: JSON.stringify({ revision: process.env.PAIRCOACH_QA_REVISION ?? 'UNSPECIFIED', captured, frames: frames.map(frame => frame.type), stderr,
      boundary: 'Real Monaco/backend/provider capture; deterministic response, NOT real model/native/final QA.' }, null, 2), contentType: 'application/json' });
  } finally {
    await page.goto('about:blank');
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit'); child.send('close'); const timer = setTimeout(() => child?.kill('SIGKILL'), 2000);
      try { await exited; } finally { clearTimeout(timer); }
    }
  }
});
