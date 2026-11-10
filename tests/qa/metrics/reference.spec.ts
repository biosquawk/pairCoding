import { test, expect } from '@playwright/test';
import os from 'node:os';
import { writeFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { append, chat, disk, focusEditor, manifest, openEditor } from '../e2e/browser-helpers';

/** Measurements observe actual native WebSocket and rendered DOM; no reply fabrication. */
test('AC-027 TEST-027: Windows Chromium, 100 veto + hint trials, METRIC001..004 p95/max', async ({ page, browser }, info) => {
  expect(process.platform, 'Reference evidence MUST be executed on Windows, not WSL').toBe('win32');
  const initial = manifest(); expect(initial.reference).toBe(true);
  expect(readdirSync(initial.rootPath)).toHaveLength(100);
  expect(initial.mainBytes).toBeLessThanOrEqual(100 * 1024);
  await page.addInitScript(() => {
    const output: any = { vetoes: [], hints: [], marker: '', lastEscape: 0 };
    (window as any).__qaTimings = output;
    window.addEventListener('keydown', event => {
      if (event.key !== 'Escape' || event.repeat) return;
      const now = performance.now();
      if (output.lastEscape && now - output.lastEscape <= 400) {
        output.vetoes.push({ secondEscapeAt: now, marker: output.marker, localMs: null, ackMs: null,
          messageId: null, ownerWasCoach: document.body.innerText.includes('Pisze Trener') });
        output.lastEscape = 0;
      } else output.lastEscape = now;
    }, true);
    const NativeSocket = window.WebSocket;
    class ObservedSocket extends NativeSocket {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols);
        this.addEventListener('message', event => {
          const now = performance.now(); let frame: any;
          try { frame = JSON.parse(event.data); } catch { return; }
          if (frame.type === 'ACK') {
            const entry = output.vetoes.find((v: any) => v.messageId === frame.payload.replyTo);
            if (entry && entry.ackMs === null) entry.ackMs = now - entry.secondEscapeAt;
          }
          if (frame.type === 'COACH_HINT_BUBBLE') output.hints.push({ id: frame.payload.id, text: frame.payload.text, receivedAt: now, renderMs: null });
        });
      }
      send(data: Parameters<WebSocket['send']>[0]) {
        if (typeof data === 'string') {
          try {
            const frame = JSON.parse(data), entry = output.vetoes.at(-1);
            if (frame.type === 'VETO_ESCAPE' && entry) entry.messageId = frame.messageId;
          } catch { /* actual transport still receives original data */ }
        }
        return super.send(data);
      }
    }
    window.WebSocket = ObservedSocket;
    function sampleDOM() {
      requestAnimationFrame(() => {
        const now = performance.now();
        const entry = output.vetoes.at(-1);
        if (entry && entry.localMs === null && document.body.innerText.includes('Piszesz Ty') &&
            document.querySelector('.monaco-editor .view-lines')?.textContent?.includes(entry.marker)) {
          entry.localMs = now - entry.secondEscapeAt;
        }
        for (const hint of output.hints) if (hint.renderMs === null) {
          const bubble = Array.from(document.querySelectorAll('.leading-relaxed.select-text.font-sans'))
            .find(element => element.textContent === hint.text) as HTMLElement | undefined;
          if (bubble && bubble.getBoundingClientRect().height > 0) hint.renderMs = now - hint.receivedAt;
        }
      });
    }
    const observer = new MutationObserver(sampleDOM);
    observer.observe(document, { subtree: true, childList: true, characterData: true });
  });
  await openEditor(page);
  const cutoffStart = manifest().vetoCutoffMs.length;
  for (let i = 0; i < 100; i++) {
    await chat(page, 'QA:DEMO');
    await expect(page.getByText('Pisze Trener AI', { exact: true })).toBeVisible();
    const marker = `qa_probe_${i}`;
    await page.evaluate(value => { (window as any).__qaTimings.marker = value; }, marker);
    await focusEditor(page); await page.keyboard.press('Escape'); await page.keyboard.press('Escape');
    await append(page, `# ${marker}\n`);
    await expect.poll(() => page.evaluate(() => {
      const v = (window as any).__qaTimings.vetoes.at(-1);
      return v && v.localMs !== null && v.ackMs !== null;
    })).toBe(true);
    await expect.poll(() => disk()).toContain(marker); // confirmed write, not a local-only draft
    await chat(page, 'QA:HINT');
    await expect.poll(() => page.evaluate(() => (window as any).__qaTimings.hints.filter((h: any) => h.renderMs !== null).length)).toBe(i + 1);
  }
  const observed = await page.evaluate(() => (window as any).__qaTimings);
  const end = manifest();
  const raw = {
    metric001: observed.vetoes.map((v: any) => v.localMs),
    metric002: end.vetoCutoffMs.slice(cutoffStart),
    metric003: observed.vetoes.map((v: any) => v.ackMs),
    metric004: observed.hints.map((h: any) => h.renderMs),
  };
  const percentile = (values: number[]) => {
    const sorted = [...values].sort((a, b) => a - b);
    return { count: sorted.length, p95: sorted[Math.ceil(sorted.length * .95) - 1], max: sorted.at(-1) };
  };
  const report = {
    revision: process.env.PAIRCOACH_QA_REVISION || 'UNRECORDED — set exact integrated commit before acceptance',
    platform: process.platform, node: process.version, chromium: browser.version(),
    cpu: os.cpus()[0]?.model, cpuCount: os.cpus().length, totalRAMBytes: os.totalmem(), loadAverage: os.loadavg(),
    hostLoadNote: process.env.PAIRCOACH_QA_LOAD_NOTE || 'UNRECORDED',
    recordedAt: new Date().toISOString(), fileCount: readdirSync(end.rootPath).length,
    activeDocumentBytesAfter: statSync(path.join(end.rootPath, 'main.py')).size,
    fixture: 'real product backend/frontend; explicit deterministic coach coordinator via K in-process factory; NOT Gemini evidence',
    definitions: {
      metric001: 'second Escape keydown to actually rendered student probe + student ownership (upper bound on local stop/draft enabling)',
      metric002: 'wrapper entry through real synchronous SessionController.veto return (upper bound on epoch cutoff)',
      metric003: 'second Escape keydown through real native WebSocket veto ACK receipt',
      metric004: 'complete actual hint frame receipt through visible bubble DOM + next animation frame',
      percentiles: 'nearest-rank ceil(.95*n)-1; all 100 samples required below strict limits',
      AI_generation: 'NOT_RUN here; this measures rendering, not Gemini generation. 20-event real-AI pilot remains separate.',
    },
    raw, summary: Object.fromEntries(Object.entries(raw).map(([name, values]) => [name, percentile(values)])),
    observed,
  };
  const artifact = info.outputPath('AC027-reference.json');
  writeFileSync(artifact, JSON.stringify(report, null, 2)); await info.attach('AC027 raw+summary', { path: artifact, contentType: 'application/json' });
  expect(report.revision).not.toMatch(/^UNRECORDED/);
  expect(report.hostLoadNote, 'record actual reference-host load, not an assumed idle host').not.toBe('UNRECORDED');
  expect(report.activeDocumentBytesAfter).toBeLessThanOrEqual(100 * 1024);
  expect(observed.vetoes).toHaveLength(100); expect(observed.hints).toHaveLength(100);
  expect(observed.vetoes.every((v: any) => v.ownerWasCoach)).toBe(true);
  for (const [name, values] of Object.entries(raw)) {
    expect(values, name).toHaveLength(100);
    expect(values.every((value: any) => Number.isFinite(value) && value >= 0), name).toBe(true);
  }
  expect(Math.max(...raw.metric001)).toBeLessThan(100);
  expect(Math.max(...raw.metric002)).toBeLessThan(50);
  expect(Math.max(...raw.metric003)).toBeLessThan(200);
  expect(Math.max(...raw.metric004)).toBeLessThan(200);
});
