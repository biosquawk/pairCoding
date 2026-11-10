import { test, expect, type Page, type TestInfo } from '@playwright/test';
import { createHash } from 'node:crypto';
import os from 'node:os';
import { writeFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { append, chat, disk, focusEditor, manifest, openEditor, Relay } from '../e2e/browser-helpers';

/** Observe native traffic only. Neither send() arguments nor received frames are changed. */
async function observeStudentSaves(page: Page) {
  await page.addInitScript(() => {
    const observed: any = { writes: [], acks: [], choices: [] };
    (window as any).__qaStudentSaves = observed;
    document.addEventListener('click', event => {
      const label = (event.target as Element)?.closest('button')?.textContent?.trim();
      if (label === 'Zachowaj mój lokalny draft' || label === 'Załaduj wersję z dysku') {
        observed.choices.push({ choice: label === 'Zachowaj mój lokalny draft' ? 'KEEP_LOCAL' : 'LOAD_DISK', at: performance.now() });
      }
    }, true);
    const NativeSocket = window.WebSocket;
    class SaveObserver extends NativeSocket {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols);
        this.addEventListener('message', event => {
          try {
            const frame = JSON.parse(event.data);
            if (frame.type === 'ACK') observed.acks.push({ ...frame.payload, receivedAt: performance.now() });
          } catch { /* observation never suppresses real traffic */ }
        });
      }
      send(data: Parameters<WebSocket['send']>[0]) {
        if (typeof data === 'string') {
          try {
            const frame = JSON.parse(data);
            if (frame.type === 'CODE_CHANGED') observed.writes.push({ messageId: frame.messageId, ...frame.payload, sentAt: performance.now() });
          } catch { /* original data still goes to the actual server */ }
        }
        return super.send(data);
      }
    }
    window.WebSocket = SaveObserver;
  });
}

// A disk marker alone, a veto ACK, a rejected save or a pre-decision write is NOT confirmation.
async function confirmedSave(page: Page, marker: string, after: number, expected: string | null) {
  return page.evaluate(({ marker, after, expected }) => {
    const observed = (window as any).__qaStudentSaves;
    const write = observed.writes.findLast((w: any) => w.path === 'main.py' && w.sentAt >= after
      && w.content.includes(`# ${marker}\n`) && (expected === null || w.content === expected)
      && observed.acks.some((a: any) => a.replyTo === w.messageId && a.status === 'OK' && a.error === null
        && a.documentVersion > w.baseVersion && a.controlEpoch === w.controlEpoch && a.receivedAt >= w.sentAt));
    if (!write) return null;
    return { ...write, ack: observed.acks.find((a: any) => a.replyTo === write.messageId && a.status === 'OK') };
  }, { marker, after, expected });
}

/** AC005/011 permits a conflict, not silent loss or overwrite. Resolve only by the real UI. */
async function finishStudentWrite(page: Page, marker: string, info: TestInfo, iteration: number) {
  const keep = page.getByRole('button', { name: 'Zachowaj mój lokalny draft', exact: true });
  // Race-aware: wait for either the actual autosave or an actionable conflict, within the original expect timeout.
  await expect.poll(async () => disk().includes(`# ${marker}\n`) || await keep.isVisible()).toBe(true);
  let expected: string | null = null, after = 0;
  let conflict: any = null;
  try {
    if (await keep.isVisible()) {
      await page.getByText('Porównaj zachowane wersje', { exact: true }).click();
      const local = await page.getByLabel('Draft lokalny konfliktu', { exact: true }).inputValue();
      const onDisk = await page.getByLabel('Wersja z dysku konfliktu', { exact: true }).inputValue();
      conflict = { iteration, marker, localDraft: local, diskBeforeDecision: onDisk, requestedChoice: 'KEEP_LOCAL', choice: null };
      expect(local, 'The human draft survives before any decision').toContain(`# ${marker}\n`);
      expect(onDisk, 'Conflict comparison shows the actual current disk bytes (wire LF)').toBe(disk());
      expect(local).not.toBe(onDisk);
      expected = local;
      await keep.click(); // Explicit human decision, never model mutation, REST write or fake ACK.
      const choice = await page.evaluate(() => (window as any).__qaStudentSaves.choices.at(-1));
      expect(choice.choice).toBe('KEEP_LOCAL'); after = choice.at;
      conflict.choice = choice.choice; conflict.decision = choice;
    }
    await expect.poll(async () => Boolean(await confirmedSave(page, marker, after, expected)),
      { message: 'Require a real CODE_CHANGED / successful correlated ACK (after KEEP_LOCAL when conflicted)' }).toBe(true);
    const saved = await confirmedSave(page, marker, after, expected);
    expect(saved).not.toBeNull();
    await expect.poll(() => disk()).toBe(saved.content);
    await expect(keep).not.toBeVisible();
    if (conflict) conflict.confirmedWrite = { messageId: saved.messageId, baseVersion: saved.baseVersion,
      controlEpoch: saved.controlEpoch, sentAt: saved.sentAt, ack: saved.ack,
      diskAfterSha256: createHash('sha256').update(disk()).digest('hex') };
    return conflict;
  } finally {
    // Preserve each decision even if later confirmation/metrics fail; not just at the final100 report.
    if (conflict) await info.attach(`AC011-conflict-${iteration}`, {
      body: JSON.stringify(conflict, null, 2), contentType: 'application/json',
    });
  }
}

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
  await observeStudentSaves(page);
  await openEditor(page);
  const conflicts: any[] = [];
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
    // Original timing samples are already complete above; never restart/reclassify a difficult trial.
    const resolution = await finishStudentWrite(page, marker, info, i);
    if (resolution) conflicts.push(resolution);
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
    observed, conflicts,
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

/** Focused controls only: real pre-cutoff second step delayed in transit, never fabricated. */
async function committedLateConflict(page: Page, marker: string) {
  const relay = new Relay(); let stepCount = 0, withholding = false, vetoId: string | undefined;
  relay.holdIn = frame => {
    if (frame.type === 'COACH_STEP_EDIT' && ++stepCount === 2) withholding = true;
    return withholding; // retain following frames in their original seq order
  };
  relay.holdOut = frame => { if (frame.type === 'VETO_ESCAPE') vetoId = frame.messageId; return false; };
  await relay.install(page); await observeStudentSaves(page); await openEditor(page);
  await chat(page, 'QA:DEMO');
  await expect.poll(() => relay.heldIncoming.some(f => f.data.type === 'COACH_STEP_EDIT')).toBe(true);
  const late = relay.heldIncoming.find(f => f.data.type === 'COACH_STEP_EDIT')!.data;
  expect(manifest().committedSteps.some((s: any) => s.id === late.payload.stepId)).toBe(true);
  const diskAtCutoff = disk();
  await expect(page.getByText('Pisze Trener AI', { exact: true })).toBeVisible();
  await focusEditor(page); await page.keyboard.press('Escape'); await page.keyboard.press('Escape');
  await append(page, `# ${marker}\n`);
  await expect.poll(() => relay.heldIncoming.some(f => f.data.type === 'ACK' && f.data.payload.replyTo === vetoId)).toBe(true);
  const commitsAtCutoff = manifest().committedSteps.length;
  relay.holdIn = () => false; relay.releaseIncoming();
  await expect(page.getByRole('button', { name: 'Zachowaj mój lokalny draft', exact: true })).toBeVisible();
  expect(await page.getByLabel('Draft lokalny konfliktu', { exact: true }).inputValue()).toContain(`# ${marker}\n`);
  expect(disk()).toBe(diskAtCutoff); expect(disk()).not.toContain(marker);
  return { relay, commitsAtCutoff, diskAtCutoff };
}

test('AC011 control POSITIVE: explicit KEEP_LOCAL writes the preserved draft with real correlated ACK', async ({ page }, info) => {
  const marker = `qa_keep_local_${Date.now()}`;
  const { commitsAtCutoff } = await committedLateConflict(page, marker);
  const result = await finishStudentWrite(page, marker, info, -1);
  expect(result.choice).toBe('KEEP_LOCAL');
  expect(result.confirmedWrite.ack.status).toBe('OK');
  expect(result.confirmedWrite.sentAt).toBeGreaterThanOrEqual(result.decision.at);
  expect(disk()).toBe(result.localDraft);
  expect(manifest().committedSteps).toHaveLength(commitsAtCutoff); // no stale-step write after veto
});

test('AC011 control NEGATIVE: no decision cannot commit; LOAD_DISK is not a successful KEEP_LOCAL save', async ({ page }, info) => {
  const marker = `qa_no_decision_${Date.now()}`;
  const { relay, commitsAtCutoff, diskAtCutoff } = await committedLateConflict(page, marker);
  const writesBeforeDecision = relay.sent.filter(f => f.type === 'CODE_CHANGED').length;
  await page.waitForTimeout(200); // > autosave150ms; deliberate negative observation, not a relaxed timeout
  expect(disk()).toBe(diskAtCutoff);
  expect(relay.sent.filter(f => f.type === 'CODE_CHANGED')).toHaveLength(writesBeforeDecision);
  expect(await confirmedSave(page, marker, 0, null)).toBeNull();
  const localBefore = await page.getByLabel('Draft lokalny konfliktu', { exact: true }).inputValue();
  expect(localBefore).toContain(`# ${marker}\n`);
  await page.getByRole('button', { name: 'Załaduj wersję z dysku', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Zachowaj mój lokalny draft', exact: true })).not.toBeVisible();
  expect(disk()).toBe(diskAtCutoff);
  expect(await confirmedSave(page, marker, 0, null)).toBeNull();
  const recovery = await page.evaluate(({ marker, localBefore, diskAtCutoff }) =>
    Object.entries(localStorage).some(([key, value]) => {
      if (!key.includes(':conflict:main.py:')) return false;
      const retained = JSON.parse(value);
      return retained.localDraftContent === localBefore && retained.localDraftContent.includes(marker)
        && retained.diskContent === diskAtCutoff;
    }), { marker, localBefore, diskAtCutoff });
  expect(recovery, 'The explicit LOAD_DISK choice must still retain both conflict versions').toBe(true);
  expect(manifest().committedSteps).toHaveLength(commitsAtCutoff);
  await info.attach('AC011-negative-control', { body: JSON.stringify({ marker, writesBeforeDecision,
    noDecisionDidNotCommit: true, choice: 'LOAD_DISK', keepLocalOracle: false, recovery,
    diskSha256: createHash('sha256').update(disk()).digest('hex') }), contentType: 'application/json' });
});
