import { test as base, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { fixture, seed, reviewSeed, brokenSource, profile, silent, filesBelow, factsFiles, alive, sentinel, denySnapshotWrites, type Fixture } from './fixture';
import { Wire, open, editor, append, saved, settings, configureProfiles, requestRestore, snapshots, session, get, chat, pause, veto, run, terminal, finish, report, hide, snapshotText, treePids } from './helpers';
import type { CoachContext } from '../../../src/server/coach/context';
import type { Run } from '../../../src/shared/protocol';

const test = base.extend<{ make: (options?: Parameters<typeof fixture>[0]) => Promise<Fixture>; wire: Wire }>({
  wire: async ({}, use, info) => {
    const w = new Wire();
    try { await use(w); }
    finally { await info.attach('real-rest-ws', { contentType: 'application/json', body: Buffer.from(JSON.stringify({
      sent: w.sent.map(m => m.type === 'HELLO' ? { ...m, payload: { ...m.payload, token: '[QA_EPHEMERAL_REDACTED]' } } : m), received: w.received,
    }, null, 2)) }); }
  },
  make: async ({}, use, info) => {
    const all: Fixture[] = [];
    try {
      await use(async options => {
        if (!fs.existsSync('dist/index.html')) throw new Error('Build real frontend first: npm run build');
        const f = await fixture(options); all.push(f); return f;
      });
    } finally {
      for (const f of all) {
        await f.close(); // real runner stopAll; never leave owned children after a failed assertion
        await info.attach('g3-real-files-and-provider-boundary', { contentType: 'application/json', body: Buffer.from(JSON.stringify({
          revision: process.env.PAIRCOACH_QA_REVISION ?? 'UNSPECIFIED', platform: process.platform, node: process.version,
          base: f.base, files: filesBelow(f.base),
          coachCalls: f.provider.calls.map(c => ({ context: c.context, aborted: c.signal.aborted })),
          boundary: 'Real server/gate/snapshots/runner/report; deterministic AI ONLY, NOT Gemini',
        }, null, 2)) });
      }
    }
  },
});
const responseFor = (w: Wire, id: string) => w.sent.find(m => m.type === 'PROPOSAL_RESPONSE' && m.payload.proposalId === id);
const editDecision = (c: Readonly<CoachContext>, p: string, text: string) => ({ kind: 'EDIT', purpose: 'G3 controlled AI boundary',
  path: p, documentVersion: c.documents.find(d => d.path === p)!.version, workspaceVersion: c.workspaceVersion,
  steps: [{ range: { startLine: 1, startColumn: 1, endLine: 1, endColumn: 1 }, textBlock: text }] });

// BUC005: literal expected content is derived from fixture input, never live output goldens.
test('TEST-013: Nie closes chat and floating decision without restoring files or changing paused timer', async ({ page, make, wire }) => {
  const f = await make({ snapshot: true }); await open(page, f, wire);
  await append(page, '# human work\n'); await saved(f, wire, seed + '# human work\n');
  await pause(page, f); const before = await session(page, f), list = await snapshots(page, f);
  const p = await requestRestore(page, wire, 'G3 original');
  expect(f.read()).toBe(seed + '# human work\n'); expect(await snapshots(page, f)).toEqual(list); // no autonomous action
  await expect(page.getByRole('button', { name: p.noLabel, exact: true })).toBeVisible(); // floating view
  await page.getByRole('button', { name: /^Czat/ }).click();
  await expect(page.getByRole('button', { name: p.noLabel, exact: true })).toBeVisible(); // same decision in chat
  await page.getByRole('button', { name: p.noLabel, exact: true }).click();
  await expect.poll(() => !!responseFor(wire, p.proposalId)).toBe(true);
  expect(responseFor(wire, p.proposalId).payload).toEqual({ proposalId: p.proposalId, accepted: false, basedOnWorkspaceVersion: p.basedOnWorkspaceVersion });
  await wire.ok(responseFor(wire, p.proposalId));
  await expect(page.getByRole('button', { name: p.noLabel, exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: /^Zadanie/ }).click();
  await expect(page.getByRole('button', { name: p.noLabel, exact: true })).toHaveCount(0);
  const after = await session(page, f);
  expect(after.timer.elapsedMs).toBe(before.timer.elapsedMs); expect(after.timer.manualPaused).toBe(true);
  expect(after.workspaceVersion).toBe(before.workspaceVersion); expect(await snapshots(page, f)).toEqual(list);
  expect(f.read()).toBe(seed + '# human work\n');
});

test('TEST-014: same proposalId with different messageId restores once, retains usable backup, never resets timer', async ({ page, make, wire }) => {
  const f = await make({ snapshot: true }); await open(page, f, wire);
  const human = seed + '# before restore\n'; await append(page, '# before restore\n'); await saved(f, wire, human);
  await page.waitForTimeout(1100); const before = await session(page, f), list = await snapshots(page, f);
  const p = await requestRestore(page, wire, 'G3 original');
  await page.getByRole('button', { name: p.yesLabel, exact: true }).click();
  await expect.poll(() => !!responseFor(wire, p.proposalId)).toBe(true);
  const first = responseFor(wire, p.proposalId); await wire.ok(first); await expect.poll(() => f.read()).toBe(seed);
  const once = await session(page, f), backups = (await snapshots(page, f)).filter(s => !list.some(old => old.snapshotId === s.snapshotId));
  expect(backups).toHaveLength(1); expect(snapshotText(f, backups[0].snapshotId, 'main.py')).toBe(human);
  const duplicate = wire.command('PROPOSAL_RESPONSE', first.payload); expect(duplicate.messageId).not.toBe(first.messageId);
  const ack = await wire.ack(duplicate); expect(ack.status).toBe('DUPLICATE'); expect(ack.error).toBeNull();
  expect((await session(page, f)).workspaceVersion).toBe(once.workspaceVersion);
  expect(await snapshots(page, f)).toHaveLength(list.length + 1); expect(f.read()).toBe(seed);
  const after = await session(page, f);
  expect(after.timer.elapsedMs).toBeGreaterThanOrEqual(before.timer.elapsedMs);
  expect(after.timer.limitMs).toBe(before.timer.limitMs); expect(after.timer.manualPaused).toBe(before.timer.manualPaused);
  // Availability means the user can actually recover the pre-restore copy, not just see an ID.
  const recover = await requestRestore(page, wire, backups[0].label);
  await page.getByRole('button', { name: recover.yesLabel, exact: true }).click();
  await expect.poll(() => !!responseFor(wire, recover.proposalId)).toBe(true); await wire.ok(responseFor(wire, recover.proposalId));
  await expect.poll(() => f.read()).toBe(human);
});

for (const invalid of ['expired', 'stale', 'backup-write-denied'] as const) {
  test(`TEST-015: ${invalid} acceptance rejects with STALE_PROPOSAL and no task-file effects`, async ({ page, make, wire }) => {
    // Only expiry needs >60s: wait for real wire expiresAt, no clock/TTL change.
    if (invalid === 'expired') test.setTimeout(85000);
    const f = await make({ snapshot: true }); await open(page, f, wire);
    await append(page, '# preserved local bytes\n'); await saved(f, wire, seed + '# preserved local bytes\n');
    const p = await requestRestore(page, wire, 'G3 original');
    if (invalid === 'stale') { await append(page, '# invalidates proposal\n'); await saved(f, wire, seed + '# preserved local bytes\n# invalidates proposal\n'); }
    if (invalid === 'expired') await page.waitForTimeout(Math.max(0, Date.parse(p.expiresAt) - Date.now() + 50));
    const before = await session(page, f), tree = filesBelow(f.rootPath), list = await snapshots(page, f);
    let restoreWrites: (() => void) | undefined;
    try {
      if (invalid === 'backup-write-denied') {
        restoreWrites = denySnapshotWrites(f);
        expect(snapshotText(f, f.snapshot!.snapshotId, 'main.py')).toBe(seed); // source is genuinely still readable
      }
      // Negative protocol control must send original basedOn, even if UI has expired/dismissed its card.
      const rejected = wire.command('PROPOSAL_RESPONSE', { proposalId: p.proposalId, accepted: true, basedOnWorkspaceVersion: p.basedOnWorkspaceVersion });
      const ack = await wire.ack(rejected); expect(ack.status).toBe('REJECTED'); expect(ack.error.code).toBe('STALE_PROPOSAL');
      expect(filesBelow(f.rootPath)).toEqual(tree);
      expect((await session(page, f)).workspaceVersion).toBe(before.workspaceVersion);
    } finally { restoreWrites?.(); }
    expect(await snapshots(page, f)).toEqual(list);
  });
}

test('TEST-016: real hidden window pauses server timer, retains veto and manual pause after return', async ({ page, make, wire }) => {
  const f = await make(); await open(page, f, wire); await veto(page, f);
  const original = f.read(), controls = wire.received.filter(m => m.type === 'COACH_STEP_EDIT').length;
  let restore = await hide(page, f, wire);
  try {
    const start = await session(page, f); await page.waitForTimeout(1100); const end = await session(page, f);
    expect(start.timer.pauseOnHidden).toBe(true); expect(start.timer.status).toBe('PAUSED');
    expect(end.timer.elapsedMs).toBe(start.timer.elapsedMs); expect(end.writeOwner).toBe('STUDENT');
    expect(end.coachMode).toBe('MUTED_WINDOW_HIDDEN'); expect(f.read()).toBe(original);
    expect(wire.received.filter(m => m.type === 'COACH_STEP_EDIT')).toHaveLength(controls);
  } finally { await restore(); }
  await expect.poll(async () => (await session(page, f)).presence).toBe('FOCUSED');
  expect((await session(page, f)).cooldownAfterVeto).toBe(true);
  const visible = (await session(page, f)).timer.elapsedMs; await page.waitForTimeout(200);
  expect((await session(page, f)).timer.elapsedMs).toBeGreaterThan(visible);
  await pause(page, f); restore = await hide(page, f, wire); const paused = (await session(page, f)).timer.elapsedMs;
  try { await page.waitForTimeout(200); } finally { await restore(); }
  const end = await session(page, f); expect(end.timer.manualPaused).toBe(true); expect(end.timer.elapsedMs).toBe(paused); expect(end.cooldownAfterVeto).toBe(true);
});

test('TEST-017: pauseOnHidden=false counts real hidden time but rejects delayed AI edit; fresh visible edit works', async ({ page, make, wire }) => {
  const f = await make(); await open(page, f, wire);
  await page.getByLabel('Pauzuj przy ukryciu', { exact: true }).uncheck();
  await expect.poll(async () => (await session(page, f)).timer.pauseOnHidden).toBe(false);
  let resolve!: (v: unknown) => void, captured: Readonly<CoachContext> | undefined;
  f.provider.decideData = c => {
    if (c.messages.at(-1)?.text === 'G3 delayed while hidden' && !captured) { captured = c; return new Promise(r => { resolve = r; }); }
    if (c.messages.at(-1)?.text === 'G3 fresh visible') { f.provider.decideData = () => silent; return editDecision(c, 'main.py', '# fresh visible\n'); }
    return silent;
  };
  await chat(page, 'G3 delayed while hidden'); await expect.poll(() => !!captured).toBe(true);
  const restore = await hide(page, f, wire);
  try {
    const start = await session(page, f), count = wire.received.filter(m => m.type === 'COACH_STEP_EDIT').length;
    resolve(editDecision(captured!, 'main.py', '# forbidden hidden\n'));
    await page.waitForTimeout(1100); const end = await session(page, f);
    expect(end.timer.elapsedMs - start.timer.elapsedMs).toBeGreaterThanOrEqual(1000);
    expect(end.writeOwner).toBe('STUDENT'); expect(end.coachMode).toBe('MUTED_WINDOW_HIDDEN');
    expect(f.read()).toBe(seed); expect(wire.received.filter(m => m.type === 'COACH_STEP_EDIT')).toHaveLength(count);
    expect(f.provider.calls.find(c => c.context.messages.at(-1)?.text === 'G3 delayed while hidden')!.signal.aborted).toBe(true);
  } finally { await restore(); }
  await expect.poll(async () => (await session(page, f)).presence).toBe('FOCUSED');
  await chat(page, 'G3 fresh visible'); await expect.poll(() => f.read()).toBe('# fresh visible\n' + seed);
});

test('TEST-018: actual 1s server limit emits one overtime notice; editor and lifecycle stay active', async ({ page, make, wire }) => {
  const f = await make(); await open(page, f, wire, false);
  // Public start contract selects the 1s boundary; normal GUI start already covered in other cases.
  const r = await page.request.post(f.baseURL + '/api/session/start', { headers: { Authorization: `Bearer ${f.token}` },
    data: { requestId: crypto.randomUUID(), ...wire.identity(), limitMs: 1000, pauseOnHidden: true } });
  expect(r.status()).toBe(200);
  await expect.poll(async () => (await session(page, f)).timer.status).toBe('OVERTIME');
  await expect(page.getByText(/^Overtime \(/)).toBeVisible();
  await append(page, '# after limit\n'); await saved(f, wire, seed + '# after limit\n'); await page.waitForTimeout(250);
  expect(wire.received.filter(m => m.type === 'CHAT_REPLY' && /Limit czasu minął/.test(m.payload.text))).toHaveLength(1);
  expect((await session(page, f)).lifecycle).toBe('RUNNING');
});

test('TEST-019: GUI distinguishes missing profile, real zero-test child NO_TESTS and exit0 UNKNOWN without inventing tests', async ({ page, make, wire }) => {
  const f = await make(); await open(page, f, wire);
  const missing = page.getByRole('button', { name: 'Run Tests', exact: true });
  await expect(missing).toBeDisabled(); await expect(missing).toHaveAttribute('title', /profil|konfigur/i);
  const before = filesBelow(f.rootPath), s = await session(page, f);
  const rejected = await page.request.post(f.baseURL + '/api/run', { headers: { Authorization: `Bearer ${f.token}` },
    data: { requestId: crypto.randomUUID(), ...wire.identity(), mode: 'RUN_TESTS', expectedWorkspaceVersion: s.workspaceVersion } });
  expect(rejected.status()).toBe(409); expect((await rejected.json()).code).toBe('RUN_PROFILE_MISSING');
  expect(filesBelow(f.rootPath)).toEqual(before); expect(wire.received.filter(m => m.type === 'RUN_STATE')).toHaveLength(0);
  await configureProfiles(page, f, [profile('RUN_TESTS', 'zero')]);
  const zero = await terminal(page, f, (await run(page, 'RUN_TESTS')).runId);
  expect(zero.exitCode).toBe(0); expect(zero.testOutcome).toBe('NO_TESTS'); expect(zero.testCount).toBe(0);
  await page.getByRole('button', { name: /^Konsola/ }).click(); await expect(page.getByText(/NO_TESTS/).first()).toBeVisible();
  await configureProfiles(page, f, [profile('RUN_TESTS', 'unknown')]);
  const unknown = await terminal(page, f, (await run(page, 'RUN_TESTS')).runId);
  expect(unknown.exitCode).toBe(0); expect(unknown.testOutcome).toBe('UNKNOWN'); expect(unknown.testCount).toBeNull();
  expect(wire.received.filter(m => m.type === 'RUN_STATE').some(m => m.payload.testOutcome === 'PASSED')).toBe(false);
  const added = Object.keys(filesBelow(f.rootPath)).filter(p => !(p in before));
  expect(added).toEqual([`qa-${zero.runId}.xml`]); // only actual known child report, no generated suite
  expect((await session(page, f)).lifecycle).toBe('RUNNING');
});

for (const stopBy of ['Stop', 'timeout'] as const) {
  test(`TEST-020: GUI-configured real child tree ${stopBy}, responsive typing and unrelated sentinel survives`, async ({ page, make, wire }) => {
    const f = await make(); await open(page, f, wire);
    // 2s allows PID evidence and GUI typing even on Windows; this is fixture profile input, not product timeout weakening.
    await configureProfiles(page, f, [profile('RUN_MAIN', 'tree', stopBy === 'timeout' ? 2000 : 10000)]);
    const other = sentinel(f);
    try {
      await expect.poll(() => fs.existsSync(other.file)).toBe(true);
      const started = await run(page, 'RUN_MAIN');
      await expect.poll(() => ['parent.pid', 'child.pid'].every(p => fs.existsSync(path.join(f.rootPath, p)))).toBe(true);
      const pids = treePids(f); expect(pids.every(alive)).toBe(true); expect(alive(other.child.pid!)).toBe(true);
      await append(page, '# while real process runs\n'); await saved(f, wire, seed + '# while real process runs\n');
      if (stopBy === 'Stop') {
        const [r] = await Promise.all([page.waitForResponse(r => r.url().endsWith('/api/run/' + started.runId + '/stop') && r.request().method() === 'POST'),
          page.getByRole('button', { name: 'Stop', exact: true }).click()]);
        expect(r.status()).toBe(202);
      }
      const end = await terminal(page, f, started.runId);
      expect(end.status).toBe(stopBy === 'Stop' ? 'CANCELLED' : 'TIMED_OUT'); expect(end.workspaceChangedDuringRun).toBe(true);
      await expect.poll(() => pids.every(pid => !alive(pid))).toBe(true);
      const beat = fs.readFileSync(other.file, 'utf8'); await page.waitForTimeout(4600);
      expect(fs.existsSync(path.join(f.rootPath, 'orphan-marker'))).toBe(false);
      expect(alive(other.child.pid!)).toBe(true); expect(fs.readFileSync(other.file, 'utf8')).not.toBe(beat);
      expect(wire.received.some(m => m.type === 'RUN_OUTPUT' && m.payload.runId === started.runId && m.payload.chunk.includes('TREE_STARTED'))).toBe(true);
      await expect(editor(page)).toBeEnabled();
    } finally { await other.close(); }
  });
}

test('TEST-021: CODE_REVIEW preserves reviewed source; human findings and AI notes only in review.md', async ({ page, make, wire }) => {
  const f = await make({ taskMode: 'CODE_REVIEW' }); await open(page, f, wire);
  let attempted = false;
  f.provider.decideData = c => {
    if (c.messages.at(-1)?.text === 'G3 try forbidden source edit' && !attempted) { attempted = true; return editDecision(c, 'bug.js', '// forbidden fix\n'); }
    if (c.messages.at(-1)?.text === 'G3 record finding') { f.provider.decideData = () => silent; return editDecision(c, 'review.md', '# Coach: subtraction is not addition; review may be incomplete.\n'); }
    return silent;
  };
  await chat(page, 'G3 try forbidden source edit'); await expect.poll(() => attempted).toBe(true); await page.waitForTimeout(300);
  expect(f.read('bug.js')).toBe(brokenSource); expect(wire.received.filter(m => m.type === 'COACH_STEP_EDIT')).toHaveLength(0);
  await page.getByText('review.md', { exact: true }).first().click();
  const human = reviewSeed + 'Human finding: a-b does not implement addition.\n';
  await append(page, 'Human finding: a-b does not implement addition.\n', 'review.md'); await saved(f, wire, human, 'review.md');
  await chat(page, 'G3 record finding');
  await expect.poll(() => f.read('review.md')).toBe('# Coach: subtraction is not addition; review may be incomplete.\n' + human);
  expect(f.read('bug.js')).toBe(brokenSource);
  expect(wire.received.filter(m => m.type === 'COACH_STEP_EDIT').map(m => m.payload.path)).toEqual(['review.md']);
  expect(await get<any>(page, f, '/project').then(p => p.settings.runProfiles)).toEqual([]);
  expect(f.provider.calls.at(-1)!.context.taskMode).toBe('CODE_REVIEW');
  expect(wire.received.filter(m => m.type === 'CHAT_REPLY').some(m => /znaleziono wszystkie|wszystkich błędów/i.test(m.payload.text))).toBe(false);
});

test('TEST-022: positive real fresh JUnit PASSED is only a Run result, not automatic finish', async ({ page, make, wire }) => {
  const f = await make(); await open(page, f, wire); await configureProfiles(page, f, [profile('RUN_TESTS', 'pass')]);
  const end = await terminal(page, f, (await run(page, 'RUN_TESTS')).runId);
  expect(end.status).toBe('SUCCEEDED'); expect(end.exitCode).toBe(0); expect(end.testOutcome).toBe('PASSED'); expect(end.testCount).toBe(1);
  expect(wire.received.some(m => m.type === 'RUN_OUTPUT' && m.payload.runId === end.runId)).toBe(true);
  expect((await session(page, f)).lifecycle).toBe('RUNNING'); expect(wire.received.filter(m => m.type === 'SESSION_REPORT')).toHaveLength(0);
  await append(page, '# after green\n'); await saved(f, wire, seed + '# after green\n');
  expect((await session(page, f)).lifecycle).toBe('RUNNING');
});

for (const reason of ['COMPLETED', 'ABANDONED'] as const) {
  test(`TEST-023: GUI ${reason} returns PENDING, freezes real snapshot/facts before later edits and AI READY`, async ({ page, make, wire }) => {
    let release!: (s: string) => void, captured: any;
    const generation = new Promise<string>(r => { release = r; });
    const f = await make({ generate: async facts => { captured = facts; return generation; } });
    await open(page, f, wire);
    f.provider.decideData = c => { if (c.messages.at(-1)?.text === 'G3 assist before finish') { f.provider.decideData = () => silent; return editDecision(c, 'main.py', '# coach attribution\n'); } return silent; };
    await chat(page, 'G3 assist before finish'); await expect.poll(() => f.read()).toBe('# coach attribution\n' + seed);
    await expect.poll(async () => (await session(page, f)).writeOwner).toBe('STUDENT'); await veto(page, f);
    await configureProfiles(page, f, [profile('RUN_TESTS', 'pass'), profile('RUN_MAIN', 'tree')]);
    const green = await terminal(page, f, (await run(page, 'RUN_TESTS')).runId); expect(green.testOutcome).toBe('PASSED');
    const active = await run(page, 'RUN_MAIN');
    await expect.poll(() => ['parent.pid', 'child.pid'].every(p => fs.existsSync(path.join(f.rootPath, p)))).toBe(true);
    const pids = treePids(f), pending = await finish(page, reason);
    expect((await session(page, f)).lifecycle).toBe('FINISHED'); await expect.poll(() => pids.every(pid => !alive(pid))).toBe(true);
    expect((await get<Run>(page, f, '/run/' + active.runId)).status).toBe('CANCELLED');
    await expect.poll(() => !!captured).toBe(true); const frozen = JSON.stringify(captured), diskFacts = factsFiles(f);
    expect(Object.keys(diskFacts)).toHaveLength(1); expect(captured.session.lifecycle).toBe('FINISHED');
    expect(captured.snapshot.snapshotId).toBe(pending.snapshotId); expect(captured.snapshot.workspaceVersion).toBe(pending.sourceWorkspaceVersion);
    expect(captured.runs.find((r: Run) => r.runId === green.runId).testOutcome).toBe('PASSED');
    expect(captured.runs.find((r: Run) => r.runId === active.runId).status).toBe('CANCELLED');
    expect(captured.events.some((e: any) => e.type === 'COACH_STEP_EDIT' && e.payload.path === 'main.py')).toBe(true);
    expect(captured.events.some((e: any) => /VETO/.test(e.type))).toBe(true);
    expect(snapshotText(f, pending.snapshotId, 'main.py')).toBe('# coach attribution\n' + seed);
    expect((await report(page, f, wire)).status).toBe('PENDING'); // HTTP did not wait for the unresolved AI promise
    fs.writeFileSync(path.join(f.rootPath, 'main.py'), 'LATER_FILE_BYTES_MUST_NOT_ENTER_ASSESSMENT\n');
    await expect.poll(async () => (await get<any>(page, f, '/file?path=main.py')).content).toBe('LATER_FILE_BYTES_MUST_NOT_ENTER_ASSESSMENT\n');
    expect(JSON.stringify(captured)).toBe(frozen); expect(factsFiles(f)).toEqual(diskFacts);
    expect(snapshotText(f, pending.snapshotId, 'main.py')).toBe('# coach attribution\n' + seed);
    release(`# Fakty\nSnapshot ${captured.snapshot.snapshotId}. Run ${green.runId}: PASSED, 1 test.\n## Ocena\nProvider QA, nie Gemini; uwzględniono pomoc AI.\n`);
    await expect.poll(async () => (await report(page, f, wire)).status).toBe('READY');
    const ready = await report(page, f, wire); expect(ready.reportId).toBe(pending.reportId); expect(ready.snapshotId).toBe(pending.snapshotId);
    expect(ready.markdown).toContain(green.runId); expect(ready.markdown).toContain(pending.snapshotId);
    expect(ready.markdown).not.toContain('LATER_FILE_BYTES'); expect(ready.markdown!.trim().split(/\s+/u).length).toBeLessThanOrEqual(800);
    expect(factsFiles(f)).toEqual(diskFacts); await page.getByRole('button', { name: /^Raport/ }).click();
    await expect(page.getByText(new RegExp(green.runId)).first()).toBeVisible();
  });
}

test('TEST-024: real ReportService AI-boundary error gives FAILED cause, durable facts and explicit GUI retry using same material', async ({ page, make, wire }) => {
  const inputs: string[] = [];
  const f = await make({ generate: async facts => {
    inputs.push(JSON.stringify(facts)); if (inputs.length === 1) throw new Error('QA_PROVIDER_FAILURE_NO_SECRET');
    return `# Fakty\nSnapshot ${facts.snapshot.snapshotId}.\n## Ocena i granice\nKontrolowany provider QA, nie Gemini.\n`;
  } });
  await open(page, f, wire); await append(page, '# before failure\n'); await saved(f, wire, seed + '# before failure\n');
  const pending = await finish(page, 'ABANDONED');
  await expect.poll(async () => (await report(page, f, wire)).status).toBe('FAILED');
  const failed = await report(page, f, wire); expect(failed.error?.code).toBe('REPORT_GENERATION_FAILED');
  expect(failed.error?.message).toMatch(/gener|raport/i); expect(failed.error?.retryable).toBe(true);
  expect(f.read()).toBe(seed + '# before failure\n'); expect(snapshotText(f, pending.snapshotId, 'main.py')).toBe(seed + '# before failure\n');
  const diskFacts = factsFiles(f); expect(Object.keys(diskFacts)).toHaveLength(1); expect(inputs).toHaveLength(1);
  await page.getByRole('button', { name: /^Raport/ }).click();
  await expect(page.getByText(failed.error!.message, { exact: true })).toBeVisible();
  fs.writeFileSync(path.join(f.rootPath, 'main.py'), 'LATER_EDIT_BEFORE_RETRY\n');
  const [retry] = await Promise.all([page.waitForResponse(r => r.url().endsWith('/api/session/report/retry') && r.request().method() === 'POST'),
    page.getByRole('button', { name: 'Ponów generowanie raportu', exact: true }).click()]);
  expect(retry.status()).toBe(202); expect((await retry.json()).status).toBe('PENDING');
  await expect.poll(async () => (await report(page, f, wire)).status).toBe('READY');
  expect(inputs).toHaveLength(2); expect(inputs[1]).toBe(inputs[0]); expect(inputs[1]).not.toContain('LATER_EDIT_BEFORE_RETRY');
  const ready = await report(page, f, wire); expect(ready.reportId).toBe(pending.reportId); expect(ready.snapshotId).toBe(pending.snapshotId);
  expect(factsFiles(f)).toEqual(diskFacts); expect(snapshotText(f, pending.snapshotId, 'main.py')).toBe(seed + '# before failure\n');
});
