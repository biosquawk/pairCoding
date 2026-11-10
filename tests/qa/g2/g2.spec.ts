import { test as base, expect, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { append, chat, editorInput, editorText, focusEditor, Relay } from '../e2e/browser-helpers';
import { fixture, Provider, deferred, edit, hint, silent, seed, canaries } from './fixture';

type F = Awaited<ReturnType<typeof fixture>>;
const test = base.extend<{ make: (provider: Provider, consent?: boolean) => Promise<F> }>({
  make: async ({}, use, info) => {
    if (!fs.existsSync('dist/index.html')) throw new Error('Run npm run build before G2 browser tests');
    const all: { f: F; provider: Provider }[] = [];
    await use(async (provider, consent = true) => {
      const f = await fixture(provider, consent, path.resolve('dist')); all.push({ f, provider }); return f;
    });
    for (const { f, provider } of all) {
      await f.close();
      await info.attach('g2-real-system-evidence', { contentType: 'application/json', body: Buffer.from(JSON.stringify({
        revision: process.env.PAIRCOACH_QA_REVISION || 'UNSPECIFIED: record git rev-parse HEAD separately',
        base: f.base, disk: f.disk(), maxProviderInFlight: provider.maxInFlight,
        calls: provider.calls.map(c => ({ context: c.context, aborted: c.signal.aborted, settled: c.settled })),
      }, null, 2)) });
    }
  },
});
async function open(page: Page, f: F, relay: Relay) {
  await relay.install(page); await page.goto(f.baseURL);
  await page.getByText('main.py', { exact: true }).first().click();
  await expect(editorInput(page)).toBeVisible();
  await expect.poll(() => editorText(page)).toContain('value = 0');
  const [response] = await Promise.all([
    page.waitForResponse(r => new URL(r.url()).pathname === '/api/session/start' && r.request().method() === 'POST'),
    page.getByRole('button', { name: 'Start sesji', exact: true }).click(),
  ]);
  expect(response.status()).toBe(200); expect((await response.json()).lifecycle).toBe('RUNNING');
  await expect(page.getByRole('button', { name: 'Pauza czasu', exact: true })).toBeVisible();
}
const controls = (relay: Relay) => relay.received.filter(m => m.type === 'CONTROL_PREPARE' || m.type === 'COACH_STEP_EDIT');
async function saved(f: F, relay: Relay, expected: string) {
  await expect.poll(() => relay.sent.some(m => m.type === 'CODE_CHANGED' && m.payload.content === expected &&
    relay.received.some(a => a.type === 'ACK' && a.payload.replyTo === m.messageId && a.payload.status === 'OK' && a.payload.error === null))).toBe(true);
  expect(f.disk()).toBe(expected);
}
async function session(page: Page, f: F) {
  const response = await page.request.get(f.baseURL + '/api/session', { headers: { Authorization: `Bearer ${f.token}` } });
  expect(response.status()).toBe(200); return response.json();
}
async function veto(page: Page, f: F) {
  await focusEditor(page); await page.keyboard.press('Escape'); await page.keyboard.press('Escape');
  await expect.poll(async () => (await session(page, f)).cooldownAfterVeto).toBe(true);
}

test('TEST-007: autonomous delayed provider leaves real typing/ACK available; stale EDIT denied, fresh EDIT works', async ({ page, make }) => {
  const old = deferred(); let oldContext: any;
  const provider = new Provider(c => {
    const content = c.documents.find(d => d.path === 'main.py')!.content;
    if (content.includes('g2_slow') && !oldContext) { oldContext = c; return old.promise; }
    if (content.includes('g2_fresh')) return edit(c);
    return silent;
  });
  const f = await make(provider), relay = new Relay(); await open(page, f, relay);
  await append(page, '# g2_slow\n'); await saved(f, relay, seed + '# g2_slow\n');
  await expect.poll(() => !!oldContext).toBe(true);
  const oldCall = provider.calls.at(-1)!;
  // Actual several-second analysis, no chat request and no fake ACK.
  await append(page, '# typing_while_AI_waits\n');
  const newest = seed + '# g2_slow\n# typing_while_AI_waits\n'; await saved(f, relay, newest);
  await page.waitForTimeout(2100);
  expect(provider.inFlight).toBe(1); expect(provider.maxInFlight).toBe(1);
  expect(oldCall.signal.aborted).toBe(true);
  expect((await session(page, f)).writeOwner).toBe('STUDENT'); expect(controls(relay)).toHaveLength(0);
  old.resolve(edit(oldContext, '# STALE_MUST_NEVER_APPEAR\n'));
  await expect.poll(() => provider.inFlight).toBe(0);
  expect(f.disk()).toBe(newest); expect(controls(relay)).toHaveLength(0);
  await append(page, '# g2_fresh\n');
  await expect.poll(() => f.disk()).toBe('# g2_coach_second\n# g2_coach_first\n' + newest + '# g2_fresh\n');
  await expect.poll(async () => (await session(page, f)).writeOwner).toBe('STUDENT');
  expect(relay.received.filter(m => m.type === 'COACH_STEP_EDIT')).toHaveLength(2);
  expect(provider.maxInFlight).toBe(1);
});

test('TEST-008: real show preserves independent selection, Ctrl+C, scroll and read-only; steps use explicit ranges', async ({ page, context, make }) => {
  let show = false;
  const provider = new Provider(c => { if (c.messages.length && !show) { show = true; return edit(c); } return silent; });
  const f = await make(provider), relay = new Relay();
  // Delay ONLY the first genuine STEP_RENDERED, below the unchanged product 2s timeout.
  relay.holdOut = frame => frame.type === 'STEP_RENDERED' && relay.heldOutgoing.length === 0;
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: f.baseURL });
  await open(page, f, relay); await chat(page, 'G2 demonstrate');
  await expect.poll(() => relay.heldOutgoing.length).toBe(1);
  expect((await session(page, f)).writeOwner).toBe('COACH');
  // First step inserts a new line 1; original selection line is now line 3.
  await focusEditor(page); await page.keyboard.press('ControlOrMeta+Home');
  await page.keyboard.press('ArrowDown'); await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Home'); await page.keyboard.press('Shift+End');
  await page.keyboard.press('ControlOrMeta+c');
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('# read_only_selection');
  const firstVisible = await page.locator('.monaco-editor .view-line').first().textContent();
  await page.locator('.monaco-editor').hover(); await page.mouse.wheel(0, 600);
  await expect.poll(() => page.locator('.monaco-editor .view-line').first().textContent()).not.toBe(firstVisible);
  await page.keyboard.press('x'); // mutation must be blocked while actual owner is COACH
  expect(f.disk()).toBe('# g2_coach_first\n' + seed);
  expect((await session(page, f)).writeOwner).toBe('COACH');
  expect(relay.sent.filter(m => m.type === 'CODE_CHANGED')).toHaveLength(0);
  relay.holdOut = () => false; relay.releaseOutgoing();
  await expect.poll(() => f.disk()).toBe('# g2_coach_second\n# g2_coach_first\n' + seed);
  await expect.poll(async () => (await session(page, f)).writeOwner).toBe('STUDENT');
  expect(relay.received.filter(m => m.type === 'COACH_STEP_EDIT').every(m => m.payload.range.startLine === 1)).toBe(true);
});

test('TEST-009: real anchored HINT steals neither focus nor ownership; typing expires pointer and bubble', async ({ page, make }) => {
  const gate = deferred(); let requested = false;
  const provider = new Provider(c => {
    if (c.documents.find(d => d.path === 'main.py')!.content.includes('g2_hint') && !requested) { requested = true; return gate.promise; }
    return silent;
  });
  const f = await make(provider), relay = new Relay(); await open(page, f, relay);
  await append(page, '# g2_hint\n'); await saved(f, relay, seed + '# g2_hint\n');
  await expect.poll(() => requested).toBe(true); await focusEditor(page);
  await page.keyboard.press('ControlOrMeta+Home'); // expose the genuine line-1 decoration
  gate.resolve(hint(provider.calls.at(-1)!.context));
  await expect(page.getByTitle('Zamknij dymek')).toBeVisible();
  await expect(editorInput(page)).toBeFocused(); expect((await session(page, f)).writeOwner).toBe('STUDENT');
  expect(controls(relay)).toHaveLength(0);
  await expect(page.locator('.monaco-editor [class~="border-blue-500"]').first()).toBeVisible();
  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.press('x'); await saved(f, relay, seed + '# g2_hint\nx');
  await expect(page.getByTitle('Zamknij dymek')).toHaveCount(0);
  await expect(page.locator('.monaco-editor [class~="border-blue-500"]')).toHaveCount(0);
  expect(relay.received.some(m => m.type === 'COACH_POINTER' && m.payload.clear)).toBe(true);
  expect((await session(page, f)).writeOwner).toBe('STUDENT');
});

test('TEST-012: cooldown ignores scrolling/wait/whitespace; ACKed new code + 2s or direct chat resumes without button', async ({ page, make }) => {
  let showed = false;
  const provider = new Provider(c => { if (c.messages.length && !showed) { showed = true; return edit(c); } return silent; });
  const f = await make(provider), relay = new Relay();
  relay.holdOut = frame => frame.type === 'STEP_RENDERED';
  await open(page, f, relay); await chat(page, 'G2 show before veto');
  await expect.poll(() => relay.heldOutgoing.length).toBe(1); await veto(page, f);
  relay.holdOut = () => false; relay.releaseOutgoing();
  const afterVeto = f.disk(), calls = provider.calls.length;
  await page.locator('.monaco-editor').hover(); await page.mouse.wheel(0, 500); await page.waitForTimeout(2200);
  expect(provider.calls).toHaveLength(calls); expect((await session(page, f)).cooldownAfterVeto).toBe(true);
  // Newline is whitespace; native Enter after spaces auto-indents (independent Windows baseline).
  await append(page, '\n'); await saved(f, relay, afterVeto + '\n'); await page.waitForTimeout(2200);
  expect(provider.calls).toHaveLength(calls); expect((await session(page, f)).cooldownAfterVeto).toBe(true);
  await append(page, '# new_substantive_fact\n');
  await saved(f, relay, afterVeto + '\n# new_substantive_fact\n');
  await page.waitForTimeout(1500);
  expect(provider.calls).toHaveLength(calls); expect((await session(page, f)).cooldownAfterVeto).toBe(true);
  await expect.poll(() => provider.calls.length).toBe(calls + 1);
  expect((await session(page, f)).cooldownAfterVeto).toBe(false);
  expect(provider.calls.at(-1)!.context.documents.find(d => d.path === 'main.py')!.content).toContain('new_substantive_fact');
  await veto(page, f); const beforeChat = provider.calls.length;
  await chat(page, 'G2 direct new chat fact');
  await expect.poll(() => provider.calls.length).toBe(beforeChat + 1);
  expect((await session(page, f)).cooldownAfterVeto).toBe(false);
  expect((await session(page, f)).writeOwner).toBe('STUDENT');
});

test('TEST-025/026: real browser consent OFF zero provider calls, consent ON denies secret files and redacts exact token', async ({ page, make }) => {
  const provider = new Provider(() => silent), f = await make(provider, false), relay = new Relay();
  await open(page, f, relay); await append(page, '# manual_without_consent\n');
  await saved(f, relay, seed + '# manual_without_consent\n'); await chat(page, 'No consent means no AI');
  await page.waitForTimeout(450); expect(provider.calls).toHaveLength(0);
  const hello = relay.sent.find(m => m.type === 'HELLO')!;
  const state = await session(page, f);
  const project = await page.request.get(f.baseURL + '/api/project', { headers: { Authorization: `Bearer ${f.token}` } });
  expect(project.status()).toBe(200);
  const enabled = await page.request.put(f.baseURL + '/api/project/settings', { headers: { Authorization: `Bearer ${f.token}` },
    data: { requestId: crypto.randomUUID(), clientId: hello.clientId, sessionId: state.sessionId,
      expectedWorkspaceVersion: state.workspaceVersion, settings: { ...(await project.json()).settings, aiConsent: true } } });
  expect(enabled.status()).toBe(200);
  await chat(page, `G2 pasted synthetic session token ${f.token}`);
  await expect.poll(() => provider.calls.length).toBe(1);
  const payload = JSON.stringify(provider.calls[0].context);
  expect(payload).toContain('main.py'); expect(payload).toContain('manual_without_consent'); // positive control
  expect(payload).not.toContain(f.token); expect(payload).toContain('[REDACTED]');
  for (const [name, canary] of Object.entries(canaries)) {
    expect(fs.existsSync(path.join(f.rootPath, name))).toBe(true); // exclusions must be real files
    expect(payload).not.toContain(canary);
    expect(provider.calls[0].context.documents.map(d => d.path)).not.toContain(name);
  }
  for (const badToken of [undefined, 'invalid-qa-token']) {
    const r = await page.request.get(f.baseURL + '/api/file?path=main.py', { headers: badToken ? { Authorization: `Bearer ${badToken}` } : {} });
    expect(r.status()).toBe(401);
  }
  expect(f.disk()).toBe(seed + '# manual_without_consent\n'); expect(controls(relay)).toHaveLength(0);
});
