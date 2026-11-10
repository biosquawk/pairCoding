import { test as base, expect } from '@playwright/test';
import { Backend, Wire, open, saved, requestRestore, snapshots, session, report, seed, human } from './harness';
import { append, editor } from '../g3/helpers';
import { filesBelow } from '../g3/fixture';

const test = base.extend<{ backend: Backend; wire: Wire }>({
  backend: async ({}, use, info) => {
    const f = new Backend();
    try { await f.start(); await use(f); }
    finally {
      await f.close();
      await info.attach('backend-real-fs', { contentType: 'application/json', body: Buffer.from(JSON.stringify(f.evidence(), null, 2)) });
    }
  },
  wire: async ({ page }, use, info) => {
    const w = new Wire();
    try { await use(w); }
    finally {
      await info.attach('real-http-ws', { contentType: 'application/json', body: Buffer.from(JSON.stringify(w.dump(), null, 2)) });
      await info.attach('browser-version-viewport', { contentType: 'application/json', body: Buffer.from(JSON.stringify({
        version: page.context().browser()?.version(), viewport: page.viewportSize(),
        revision: process.env.PAIRCOACH_QA_REVISION ?? 'UNSPECIFIED',
      })) });
    }
  },
});
const unknownRestore = /Brak ACK decyzji; wynik nieznany/;
const unknownFinish = /Wynik zakończenia jest nieznany/;
const alert = (page: Parameters<typeof open>[0], text: RegExp) => page.getByRole('alert').filter({ hasText: text });
async function prepare(page: Parameters<typeof open>[0], f: Backend, w: Wire) {
  await open(page, f, w); await append(page, '# human before restore\n'); await saved(page, f, w, human);
  return requestRestore(page, w);
}

test('MVP2-1: production 5s UNKNOWN → late restore ACK and late finish READY; one request/effect each', async ({ page, backend: f, wire: w }, info) => {
  const proposal = await prepare(page, f, w), before = await snapshots(page, f), beforeSession = await session(page, f);
  await f.arm('restore');
  await page.getByRole('button', { name: proposal.yesLabel, exact: true }).click();
  await expect.poll(() => w.decisions().length).toBe(1);
  const decision = w.decisions()[0];
  await expect(alert(page, unknownRestore)).toBeVisible({ timeout: 6200 });
  const unknownAt = Date.now();
  expect(unknownAt - decision.observedAt).toBeGreaterThanOrEqual(4900);
  expect(w.ack(decision)).toBeUndefined(); // UNKNOWN precedes terminal, not a retrospective guess
  await page.screenshot({ path: info.outputPath('restore-unknown.png') });
  await expect.poll(() => w.ack(decision)?.payload.status, { timeout: 20000 }).toBe('OK');
  expect(w.ack(decision).payload.error).toBeNull();
  expect(w.ack(decision).observedAt).toBeGreaterThan(unknownAt);
  await expect(alert(page, unknownRestore)).toHaveCount(0);
  await expect(page.getByRole('button', { name: proposal.yesLabel, exact: true })).toHaveCount(0);
  await expect.poll(() => f.read()).toBe(seed);
  const restored = await snapshots(page, f);
  expect(restored.length - before.length).toBe(1); expect(w.decisions()).toHaveLength(1);
  expect((await session(page, f)).timer.elapsedMs).toBeGreaterThanOrEqual(beforeSession.timer.elapsedMs);
  expect(f.checkpoints().filter(e => e.kind === 'restore')).toHaveLength(1);
  expect(f.events().filter(e => e.phase === 'PUBLISHED')).toHaveLength(1);
  expect(f.events().filter(e => e.phase === 'COMMITTED')).toHaveLength(1);
  // Explicit reconnect AFTER terminal: no pending consent, no duplicate mutation.
  const hellos = w.sent.filter(m => m.type === 'HELLO').length;
  await page.getByRole('button', { name: 'Połącz ponownie', exact: true }).click();
  await expect.poll(() => w.sent.filter(m => m.type === 'HELLO').length).toBeGreaterThan(hellos);
  await expect(page.getByText('Połączono z backendem.', { exact: true })).toBeVisible();
  expect(w.decisions()).toHaveLength(1); expect(await snapshots(page, f)).toEqual(restored);
  await page.screenshot({ path: info.outputPath('restore-settled.png') });

  await f.arm('finish');
  await page.getByRole('button', { name: '🏁 Zakończ', exact: true }).click();
  await page.getByRole('button', { name: 'Potwierdź i Wygeneruj Raport', exact: true }).click();
  await expect.poll(() => w.http.filter(r => r.method === 'POST' && r.url.endsWith('/api/session/finish')).length).toBe(1);
  const finish = w.http.find(r => r.method === 'POST' && r.url.endsWith('/api/session/finish'));
  await expect(alert(page, unknownFinish)).toBeVisible({ timeout: 6200 });
  await expect(alert(page, unknownFinish)).toContainText(finish.body.requestId);
  const finishUnknownAt = Date.now(); expect(finishUnknownAt - finish.at).toBeGreaterThanOrEqual(4900);
  expect(w.received.some(m => m.type === 'SESSION_REPORT')).toBe(false);
  await page.screenshot({ path: info.outputPath('finish-unknown.png') });
  // Only the TEST's late-result wait is longer. Client keeps its production 5000ms.
  await expect.poll(() => w.received.find(m => m.type === 'SESSION_REPORT' && m.payload.status === 'READY'), { timeout: 20000 }).toBeTruthy();
  await expect(alert(page, unknownFinish)).toHaveCount(0);
  const final = await report(page, f, finish.body.sessionId), state = await session(page, f);
  expect(final.status).toBe('READY'); expect(final.reason).toBe('COMPLETED');
  expect(final.sourceWorkspaceVersion).toBe(finish.body.expectedWorkspaceVersion);
  expect(state.lifecycle).toBe('FINISHED'); expect(final.sessionId).toBe(finish.body.sessionId);
  expect((await snapshots(page, f)).length - restored.length).toBe(1);
  expect(w.http.filter(r => r.method === 'POST' && r.url.endsWith('/api/session/finish'))).toHaveLength(1);
  expect(f.checkpoints().filter(e => e.kind === 'finish')).toHaveLength(1);
  expect(w.http.every(r => r.authorized)).toBe(true);
  await page.getByRole('button', { name: /^Raport/ }).click();
  await expect(page.getByText('MVP2 GUI reconciliation: deterministic report boundary, NOT real AI.', { exact: true })).toBeVisible();
  await page.screenshot({ path: info.outputPath('finish-settled.png') });
});

test('MVP2-2: real restore conflicts with legal Monaco typing; no silent save, both versions before LOAD_DISK', async ({ page, backend: f, wire: w }, info) => {
  const proposal = await prepare(page, f, w);
  // Delay real delivery, NOT fake state. Restore really finishes while this GUI has
  // the old document. Normal keyboard typing is still legally STUDENT-owned.
  w.holdServer = true; w.holdSaves = true;
  await page.getByRole('button', { name: proposal.yesLabel, exact: true }).click();
  await expect.poll(() => w.decisions().length).toBe(1);
  await expect.poll(() => w.ack(w.decisions()[0])?.payload.status).toBe('OK'); expect(f.read()).toBe(seed);
  const local = human + '# retained draft races restore\n';
  await append(page, '# retained draft races restore\n');
  await expect.poll(() => w.heldSaves.some(m => m.payload.content === local)).toBe(true);
  expect(w.heldSaves.every(m => !w.ack(m))).toBe(true); expect(f.read()).toBe(seed);
  w.release();
  await expect(page.getByText('Konflikt synchronizacji:', { exact: true })).toBeVisible();
  await page.getByText('Porównaj zachowane wersje', { exact: true }).click();
  await expect(page.getByLabel('Draft lokalny konfliktu', { exact: true })).toHaveValue(local);
  await expect(page.getByLabel('Wersja z dysku konfliktu', { exact: true })).toHaveValue(seed);
  const archive = { local, disk: f.read(), at: Date.now(), retainedUnsentEnvelope: w.heldSaves };
  await info.attach('both-versions-before-explicit-decision', { contentType: 'application/json', body: Buffer.from(JSON.stringify(archive, null, 2)) });
  await page.screenshot({ path: info.outputPath('restore-conflict.png') });
  const changedBeforeDecision = w.sent.filter(m => m.type === 'CODE_CHANGED').length;
  await page.waitForTimeout(300); // > production150ms autosave: no decision must not commit
  expect(f.read()).toBe(seed); expect(w.sent.filter(m => m.type === 'CODE_CHANGED')).toHaveLength(changedBeforeDecision);
  // Fresh authorized snapshot clears the intentionally held old flight, never sends it.
  await page.getByRole('button', { name: 'Połącz ponownie', exact: true }).click();
  await expect(page.getByText('Zapis oczekuje na ACK.', { exact: true })).toBeVisible(); // synchronized but protected pending draft
  await expect(page.getByLabel('Draft lokalny konfliktu', { exact: true })).toHaveValue(local);
  await page.getByRole('button', { name: 'Załaduj wersję z dysku', exact: true }).click();
  await expect(page.getByText('Konflikt synchronizacji:', { exact: true })).toHaveCount(0);
  expect(f.read()).toBe(seed); expect(w.decisions()).toHaveLength(1);
  const recovered = await page.evaluate(() => Object.entries(localStorage).filter(([k]) => k.includes(':conflict:')).map(([,v]) => JSON.parse(v)));
  expect(recovered.some(c => c.localDraftContent === local && c.diskContent === seed)).toBe(true);
  await info.attach('persisted-both-versions-after-load-disk', { contentType: 'application/json', body: Buffer.from(JSON.stringify(recovered)) });
  await page.screenshot({ path: info.outputPath('restore-conflict-resolved.png') });
});

test('MVP2-3: real child hard-kill → rollback/restart; GUI never replays old consent, second restart stable', async ({ page, backend: f, wire: w }, info) => {
  const proposal = await prepare(page, f, w), oldSessionId = f.ready.sessionId, port = f.ready.port;
  await f.arm('crash');
  await page.getByRole('button', { name: proposal.yesLabel, exact: true }).click();
  await expect.poll(() => f.checkpoints().some(e => e.kind === 'crash')).toBe(true);
  expect(w.decisions()).toHaveLength(1); const decision = w.decisions()[0];
  expect(w.ack(decision)).toBeUndefined();
  await f.kill(); // actual owned server process; no graceful cleanup before kill
  await expect(page.getByRole('status').getByText(/Synchronizacja \/ Offline/)).toBeVisible();
  await f.start(port); expect(f.ready.sessionId).not.toBe(oldSessionId);
  expect(f.read()).toBe(human); // technical rollback is required, NOT a forward restore
  await page.getByRole('button', { name: 'Połącz ponownie', exact: true }).click();
  await expect(alert(page, /SESSION_REPLACED/)).toBeVisible();
  await expect(alert(page, /SESSION_REPLACED/)).toContainText('Nie ponowiono operacji');
  await expect.poll(() => w.sent.filter(m => m.type === 'HELLO').length).toBeGreaterThan(1);
  expect(w.decisions()).toHaveLength(1); expect(f.checkpoints()).toHaveLength(1);
  expect(f.events().filter(e => e.phase === 'PUBLISHED')).toHaveLength(0);
  const list = await snapshots(page, f); expect(list).toHaveLength(2); // source + retained backup
  const stable = filesBelow(f.dataDir);
  expect(Object.keys(stable).filter(p => p.endsWith('/ROLLED_BACK'))).toHaveLength(1);
  expect(Object.keys(stable).filter(p => p.endsWith('/COMMITTED'))).toHaveLength(0);
  await page.screenshot({ path: info.outputPath('restart-unknown-not-replayed.png') });
  await f.kill(); await f.start(port); // second startup must not forward/re-rollback again
  expect(f.read()).toBe(human); expect(filesBelow(f.dataDir)).toEqual(stable);
  await page.getByRole('button', { name: 'Połącz ponownie', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Edytor pliku main.py', exact: true })).toBeVisible();
  expect(w.decisions()).toHaveLength(1); expect(f.checkpoints()).toHaveLength(1);
  expect(f.events().filter(e => e.phase === 'PUBLISHED')).toHaveLength(0);
  expect(await snapshots(page, f)).toEqual(list);
  await info.attach('forward-vs-rollback', { contentType: 'application/json', body: Buffer.from(JSON.stringify({
    originalDecision: decision, forwardPublications: 0, technicalRollbackMarkers: 1,
    oldSessionId, restartSessionId: f.ready.sessionId, stableDataHashes: stable,
  }, null, 2)) });
});
