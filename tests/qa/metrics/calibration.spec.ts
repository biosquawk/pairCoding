import { test, expect } from '@playwright/test';
import { writeFileSync, rmSync } from 'node:fs';
import { append, chat, disk, openEditor, editorInput, manifest } from '../e2e/browser-helpers';
import { observeMetrics } from './observer';
import { MetricRecorder, digest, sourceHashes } from './observer-recorder';

const receiptPath = 'tests/qa/.runtime/AC027-native-calibration.json';
test('AC027 native calibration: COACH rejects real input; same input accepts after real veto + ACK + disk', async ({ page, browser }, info) => {
  rmSync(receiptPath, { force: true }); // A failed new calibration must not leave an old PASS gate.
  const recorder = new MetricRecorder(info);
  const marker = 'qa_calibration_student', blocked = 'qa_calibration_blocked';
  const report: any = { status: 'FAIL', phase: 'setup', revision: process.env.PAIRCOACH_QA_REVISION,
    platform: process.platform, node: process.version, chromium: browser.version(), sourceHashes: sourceHashes(),
    reference: manifest().reference, observed: null, recordingErrors: recorder.errors };
  try {
    expect(process.platform, 'Native Windows calibration required').toBe('win32');
    expect(report.revision).toMatch(/^[0-9a-f]{40}$/);
    expect(report.reference).toBe(true);
    await recorder.install(page); await observeMetrics(page); await openEditor(page);
    await chat(page, 'QA:DEMO');
    await expect(page.getByText('Pisze Trener AI', { exact: true })).toBeVisible();
    await editorInput(page).focus();
    report.phase = 'COACH control';
    report.baseline = await page.evaluate(() => (window as any).__qaMetric.arm(-1, 'qa_calibration_student'));
    await page.keyboard.insertText(`# ${blocked}\n`); // Real native input, never a model write.
    report.blockedControl = await page.evaluate(blocked => {
      const r = (window as any).__qaMetric;
      return { after: r.snapshot(), visibleMarker: document.querySelector('.monaco-editor .view-lines')?.textContent?.includes(blocked),
        outgoingMarker: r.writes.some((w: any) => w.content.includes(blocked)) };
    }, blocked);
    expect(report.blockedControl.visibleMarker).toBe(false);
    expect(report.blockedControl.outgoingMarker).toBe(false);
    expect(report.blockedControl.after.owner).toBe('COACH');
    expect(report.blockedControl.after.autocomplete).toBe('none');
    expect(report.blockedControl.after.inputId).toBe(report.baseline.inputId);
    report.phase = 'veto';
    await page.keyboard.press('Escape'); await page.keyboard.press('Escape');
    await expect.poll(() => page.evaluate(() => {
      const v = (window as any).__qaMetric.output.vetoes[0];
      return v.localMs !== null && v.ackMs !== null;
    })).toBe(true);
    report.phase = 'STUDENT control';
    await append(page, `# ${marker}\n`);
    const keep = page.getByRole('button', { name: 'Zachowaj mój lokalny draft', exact: true });
    await expect.poll(async () => disk().includes(`# ${marker}\n`) || await keep.isVisible()).toBe(true);
    let expected: string | null = null, after = 0;
    if (await keep.isVisible()) {
      await page.getByText('Porównaj zachowane wersje', { exact: true }).click();
      const local = await page.getByLabel('Draft lokalny konfliktu', { exact: true }).inputValue();
      const currentDisk = await page.getByLabel('Wersja z dysku konfliktu', { exact: true }).inputValue();
      expect(local).toContain(`# ${marker}\n`); expect(local).not.toContain(blocked);
      expect(currentDisk).toBe(disk()); expect(local).not.toBe(currentDisk); expected = local;
      await info.attach('calibration-AC011-preserved-versions', {
        body: JSON.stringify({ localDraft: local, diskBeforeDecision: currentDisk }), contentType: 'application/json' });
      await keep.click();
      await recorder.snapshot(page); // Flush actual click evidence before inspecting its timestamp.
      const decision = recorder.pairs([{ trial: -1, marker }])[0];
      expect(decision.choice).toBe('KEEP_LOCAL'); after = decision.after;
      report.conflict = { choice: decision.choice, after, localSHA256: digest(local), diskBeforeSHA256: digest(currentDisk) };
    }
    await expect.poll(() => recorder.pairs([{ trial: -1, marker }])[0].writes.some(w =>
      w.filters.path && w.filters.exactMarker && w.filters.sentAfterDecision && w.filters.expectedContent && w.acknowledgements.some(a => Object.values(a.filters).every(Boolean)))).toBe(true);
    const written = await page.evaluate(({ marker, after, expected }) => (window as any).__qaMetric.writes.findLast((w: any) =>
      w.path === 'main.py' && w.at >= after && w.content.includes(`# ${marker}\n`)
      && (expected === null || w.content === expected))?.content, { marker, after, expected });
    expect(typeof written).toBe('string');
    await expect.poll(() => disk()).toBe(written);
    expect(disk()).not.toContain(blocked);
    expect(await page.evaluate(blocked => (window as any).__qaMetric.writes.some((w: any) => w.content.includes(blocked)), blocked)).toBe(false);
    recorder.save(-1, disk(), true);
    expect(await keep.isVisible()).toBe(false);
    report.positiveContentSHA256 = digest(written);
    report.phase = 'complete';
  } finally {
    try { report.observed = await recorder.snapshot(page); }
    catch (e) { recorder.errors.push({ stage: 'calibrationSnapshot', name: (e as Error).name }); }
    report.pairs = recorder.pairs([{ trial: -1, marker }]);
    const errors = [...recorder.errors, ...(report.observed?.recordingErrors || [])];
    report.recordingErrors = errors;
    report.status = report.phase === 'complete' && errors.length === 0 ? 'PASS' : 'FAIL';
    await recorder.report('AC027-native-calibration', report);
    await info.attach('AC027 calibration structural stream', { path: recorder.streamPath, contentType: 'application/x-ndjson' });
  }
  expect(report.recordingErrors).toEqual([]);
  expect(report.status).toBe('PASS');
  // Only a genuinely successful native calibration produces the gate for the separate 100 campaign.
  writeFileSync(receiptPath, JSON.stringify(report, null, 2));
});
