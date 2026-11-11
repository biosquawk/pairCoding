import { test, expect, type Page, type TestInfo } from '@playwright/test';
import { createHash } from 'node:crypto';
import os from 'node:os';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { append, chat, disk, focusEditor, manifest, openEditor, Relay } from '../e2e/browser-helpers';
import { metricObserverSource } from './observer';
import { MetricRecorder, percentile, sourceHashes } from './observer-recorder';

/** Observe native traffic only. Neither send() arguments nor received frames are changed. */
function installStudentSaveObserver() {
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
}

async function observeStudentSaves(page: Page, prefix = '') {
  // One init script: deterministic listener order (metric listener timestamps BEFORE the save parser).
  await page.addInitScript({ content: `(() => { const __name = (fn, _name) => fn; ${prefix} (${installStudentSaveObserver.toString()})(); })();` });
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

/** PW1.65 trace is worker-scoped: a distinct test type, not invalid describe.use(trace).
 * Override the option by a fixture function so the base retain-on-failure default cannot re-enable it.
 * Only AC027 uses this type; AC011 controls remain the original test type and options. */
const metricTest = test.extend({ trace: async ({}, use) => { await use('off'); } });
metricTest('AC-027 TEST-027: Windows Chromium, 100 veto + hint trials, METRIC001..004 p95/max', async ({ page, browser }, info) => {
    const recorder = new MetricRecorder(info), conflicts: any[] = [], cutoffPairs: any[] = [];
    let initial: any = null, cutoffStart: number | null = null, observed: any = null, phase = 'setup', startedTrial = -1;
    let completedTrials = 0, calibration: any = null, report: any = null, failure: any = null;
    const sameFixture = (m: any) => Boolean(initial && m.rootPath === initial.rootPath && m.dataDir === initial.dataDir
      && m.base === initial.base && m.reference === true && m.mainBytes === initial.mainBytes);
    try {
      expect(process.platform, 'Reference evidence MUST be executed on Windows, not WSL').toBe('win32');
      initial = manifest(); expect(initial.reference).toBe(true);
      expect(readdirSync(initial.rootPath)).toHaveLength(100);
      expect(initial.mainBytes).toBeLessThanOrEqual(100 * 1024);
      calibration = JSON.parse(readFileSync('tests/qa/.runtime/AC027-native-calibration.json', 'utf8'));
      expect(calibration.status, 'Native calibration must PASS first, not a synthetic predicate test').toBe('PASS');
      expect(calibration.platform).toBe('win32'); expect(calibration.revision).toBe(process.env.PAIRCOACH_QA_REVISION);
      expect(calibration.chromium).toBe(browser.version()); expect(calibration.node).toBe(process.version);
      expect(calibration.sourceHashes).toEqual(sourceHashes());
      await recorder.install(page); await observeStudentSaves(page, metricObserverSource()); await openEditor(page);
      observed = await recorder.snapshot(page);
      expect(path.resolve(observed.identity.rootPath)).toBe(path.resolve(initial.rootPath));
      cutoffStart = manifest().vetoCutoffMs.length;
      for (let i = 0; i < 100; i++) {
        startedTrial = i; phase = 'coach';
        recorder.record([{ kind: 'trialStart', trial: i, marker: `qa_probe_${i}`, atWall: new Date().toISOString() }]);
        await chat(page, 'QA:DEMO');
        await expect(page.getByText('Pisze Trener AI', { exact: true })).toBeVisible();
        const before = manifest(); expect(sameFixture(before)).toBe(true);
        const marker = `qa_probe_${i}`;
        await focusEditor(page);
        phase = 'arm';
        await page.evaluate(({ i, marker }) => (window as any).__qaMetric.arm(i, marker), { i, marker });
        phase = 'veto';
        await page.keyboard.press('Escape'); await page.keyboard.press('Escape');
        await expect.poll(() => page.evaluate(() => {
          const v = (window as any).__qaMetric.output.vetoes.at(-1);
          return v && v.localMs !== null && v.ackMs !== null;
        })).toBe(true);
        // 001 is now complete independently of this driver's actual later marker/autosave roundtrips.
        phase = 'functional write';
        await append(page, `# ${marker}\n`);
        const resolution = await finishStudentWrite(page, marker, info, i); // Unchanged exact functional oracle.
        if (resolution) conflicts.push(resolution);
        recorder.save(i, disk(), true);
        const after = manifest(); expect(sameFixture(after)).toBe(true);
        const values = after.vetoCutoffMs.slice(before.vetoCutoffMs.length);
        observed = await recorder.snapshot(page);
        const v = observed.vetoes.at(-1);
        const pair = { trial: i, sessionId: v.veto?.sessionId, connection: v.veto?.connection,
          projectId: observed.identity.projectId, rootPath: after.rootPath, vetoId: v.messageId,
          startIndex: before.vetoCutoffMs.length, endIndex: after.vetoCutoffMs.length, values };
        cutoffPairs.push(pair); recorder.record([{ kind: 'cutoffPair', ...pair }]);
        expect(values, 'Exactly one cutoff from this trial in the same isolated server fixture').toHaveLength(1);
        expect(pair.sessionId).toBe(observed.identity.sessionId); expect(pair.connection).toBe(observed.identity.connection);
        phase = 'hint';
        await page.evaluate(i => (window as any).__qaMetric.expectHint(i), i);
        await chat(page, 'QA:HINT');
        await expect.poll(() => page.evaluate(() => (window as any).__qaMetric.output.hints.filter((h: any) => h.renderMs !== null).length)).toBe(i + 1);
        completedTrials++;
      }
      phase = 'complete';
    } catch (e) {
      failure = { phase, trial: startedTrial, name: (e as Error).name, detail: 'See unmodified Playwright error/screenshot; no auth-bearing exception text copied to structural records.' };
      throw e;
    } finally {
      // Independent of assertion success. Streaming events already survive a closed/crashed page.
      try { observed = await recorder.snapshot(page); }
      catch (e) { recorder.errors.push({ stage: 'finalSnapshot', name: (e as Error).name }); }
      let end: any = null;
      try { end = manifest(); if (!sameFixture(end)) throw new Error('Fixture identity changed'); }
      catch (e) { recorder.errors.push({ stage: 'finalManifest', name: (e as Error).name }); }
      if (startedTrial >= 0 && !recorder.saves.some(s => s.trial === startedTrial)) {
        try { recorder.save(startedTrial, disk(), false); }
        catch (e) { recorder.errors.push({ stage: 'partialDisk', name: (e as Error).name }); }
      }
      observed = recorder.recoverObserved(observed);
      const vetoes = Array.from({ length: startedTrial + 1 }, (_, trial) => observed.vetoes.find((v: any) => v.trial === trial)
        || { trial, marker: `qa_probe_${trial}`, stage: 'started but not armed', localMs: null, ackMs: null, veto: null, ownerWasCoach: false });
      observed.vetoes = vetoes;
      const hints = observed.hints;
      const pairedFixture = sameFixture(end) && observed?.identity
        && path.resolve(observed.identity.rootPath) === path.resolve(end.rootPath)
        && vetoes.every((v: any) => !v.veto || (v.veto.sessionId === observed.identity.sessionId && v.veto.connection === observed.identity.connection));
      const manifestCutoffRaw = pairedFixture && cutoffStart !== null ? end.vetoCutoffMs.slice(cutoffStart) : [];
      const hintSlots = vetoes.map(v => hints.find((h: any) => h.trial === v.trial));
      const extraHints = hints.filter((h: any) => !hintSlots.includes(h));
      const raw = {
        metric001: vetoes.map((v: any) => v.localMs),
        metric002: Array.from({ length: Math.max(vetoes.length, manifestCutoffRaw.length) }, (_, i) => manifestCutoffRaw[i] ?? null),
        metric003: vetoes.map((v: any) => v.ackMs), metric004: [...hintSlots, ...extraHints].map((h: any) => h?.renderMs ?? null),
      };
      let profile: any = { fileCount: null, activeDocumentBytesAfter: null };
      try {
        if (end) profile = { fileCount: readdirSync(end.rootPath).length,
          activeDocumentBytesAfter: statSync(path.join(end.rootPath, 'main.py')).size };
      } catch (e) { recorder.errors.push({ stage: 'finalProfile', name: (e as Error).name }); }
      report = {
        revision: process.env.PAIRCOACH_QA_REVISION || 'UNRECORDED — set exact integrated commit before acceptance',
        platform: process.platform, node: process.version, chromium: browser.version(),
        cpu: os.cpus()[0]?.model, cpuCount: os.cpus().length, totalRAMBytes: os.totalmem(), loadAverage: os.loadavg(),
        hostLoadNote: process.env.PAIRCOACH_QA_LOAD_NOTE || 'UNRECORDED', recordedAt: new Date().toISOString(),
        ...profile,
        fixture: 'real product backend/frontend; explicit deterministic coach coordinator via K in-process factory; NOT Gemini evidence',
        definitions: {
          metric001: 'second authentic Escape to native same loaded visible input none→both + COACH→STUDENT + actual VETO, observed after RAF; later real marker/write/ACK/disk separate',
          metric002: 'wrapper entry through real synchronous SessionController.veto return; same fixture/root/session and per-trial manifest range',
          metric003: 'second authentic Escape to native veto ACK OK/error=null + same-session/connection STUDENT epoch+1; timestamp before parse',
          metric004: 'complete valid current hint receipt to exact visible bubble after coalesced RAF; timestamp before parse',
          percentiles: 'nearest-rank ceil(.95*n)-1; all 100 finite samples required below strict limits; invalid/null samples retained',
          AI_generation: 'NOT_RUN here; rendering, not Gemini generation. 20-event real-AI pilot remains separate.',
        },
        requestedTrials: 100, startedTrial, completedTrials, phase, partial: phase !== 'complete', failure,
        calibration: calibration ? { status: calibration.status, revision: calibration.revision, sourceHashes: calibration.sourceHashes } : null,
        sourceHashes: sourceHashes(), raw,
        summary: Object.fromEntries(Object.entries(raw).map(([name, values]) => [name, percentile(values)])),
        cutoffStart, cutoffPairs, manifestCutoffRaw, pairedFixture, observed, conflicts, savePairs: recorder.pairs(vetoes),
        staleRendered: recorder.staleRendered(vetoes),
        recordingErrors: [...recorder.errors, ...(observed?.recordingErrors || [])],
      };
      await recorder.report('AC027-reference', report);
      await info.attach('AC027 structural stream', { path: recorder.streamPath, contentType: 'application/x-ndjson' });
    }
    const { observed: finalObserved, raw, cutoffPairs: finalCutoffPairs } = report;
    // Final assertions execute only after final serialization. Original trial errors propagate unchanged.
    expect(report.recordingErrors).toEqual([]);
    expect(report.revision).toMatch(/^[0-9a-f]{40}$/);
    expect(report.hostLoadNote, 'record actual reference-host load, not an assumed idle host').not.toBe('UNRECORDED');
    expect(report.activeDocumentBytesAfter).toBeLessThanOrEqual(100 * 1024);
    expect(report.pairedFixture).toBe(true); expect(completedTrials).toBe(100); expect(finalCutoffPairs).toHaveLength(100);
    expect(finalObserved.vetoes).toHaveLength(100); expect(finalObserved.hints).toHaveLength(100);
    expect(finalObserved.vetoes.every((v: any) => v.ownerWasCoach && v.validAtEscape
      && v.keys.length === 2 && v.keys.every((k: any) => k.isTrusted && !k.repeat))).toBe(true);
    expect(report.staleRendered).toEqual([]);
    expect(finalObserved.connections).toHaveLength(1); // Healthy, non-reconnecting loopback reference.
    for (const [name, values] of Object.entries(raw)) {
      expect(values, name).toHaveLength(100);
      expect((values as any[]).every((value: any) => Number.isFinite(value) && value >= 0), name).toBe(true);
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
