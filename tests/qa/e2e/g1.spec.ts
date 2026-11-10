import { test, expect } from '@playwright/test';
import { writeFileSync } from 'node:fs';
import path from 'node:path';

// Reset only the dedicated fixture, never product sources or expected values.
import { append, chat, disk, editorInput, editorText, manifest, openEditor, Relay } from './browser-helpers';

test.beforeEach(async ({ page }) => {
  writeFileSync(path.join(manifest().rootPath, 'main.py'), 'value = 0\n');
  const bootstrap = await page.request.get('/dev/bootstrap');
  expect(bootstrap.status()).toBe(200); const { token } = await bootstrap.json();
  await expect.poll(async () => {
    const reply = await page.request.get('/api/file?path=main.py', { headers: { Authorization: `Bearer ${token}` } });
    expect(reply.status()).toBe(200); return (await reply.json()).content;
  }).toBe('value = 0\n');
});

test('AC-004 TEST-004: LIVE single-flight, delayed real ACK, newest buffer uses ACK version', async ({ page }) => {
  const relay = new Relay(); let heldId: string | undefined;
  let withholding = false;
  relay.holdIn = frame => {
    if (frame.type === 'ACK' && frame.payload.replyTo === heldId) withholding = true;
    return withholding; // preserve original seq order while delaying the real ACK
  };
  relay.holdOut = frame => { if (frame.type === 'CODE_CHANGED' && !heldId) heldId = frame.messageId; return false; };
  await relay.install(page); await openEditor(page);
  const marker = `student_first_${Date.now()}`;
  await append(page, `# ${marker}\n`);
  await expect.poll(() => relay.heldIncoming.some(f => f.data.type === 'ACK')).toBe(true);
  await append(page, '# newest_buffer\n');
  // More than autosave150ms: pending first ACK must still prevent a second in-flight write.
  await page.waitForTimeout(200);
  expect(relay.sent.filter(f => f.type === 'CODE_CHANGED')).toHaveLength(1);
  expect(disk()).toContain(marker); expect(disk()).not.toContain('newest_buffer');
  const firstAck = relay.heldIncoming.find(f => f.data.type === 'ACK')!.data.payload;
  relay.holdIn = () => false; relay.releaseIncoming();
  await expect.poll(() => disk()).toContain('newest_buffer');
  const writes = relay.sent.filter(f => f.type === 'CODE_CHANGED'); expect(writes).toHaveLength(2);
  expect(writes[1].payload.baseVersion).toBe(firstAck.documentVersion);
  expect(writes[1].payload.content).toContain(marker); expect(writes[1].payload.content).toContain('newest_buffer');
  await page.reload(); await page.getByText('main.py', { exact: true }).first().click();
  await expect.poll(() => editorText(page)).toContain('newest_buffer');
});

test('AC-005 TEST-005: real external write + pending local draft preserves both and exposes CONFLICT', async ({ page }) => {
  const relay = new Relay(); relay.holdOut = frame => frame.type === 'CODE_CHANGED';
  await relay.install(page); await openEditor(page);
  const marker = `unconfirmed_local_${Date.now()}`;
  await append(page, `# ${marker}\n`);
  await expect.poll(() => relay.heldOutgoing.length).toBeGreaterThan(0);
  const external = 'value = 0\n# external IDE independent version\n';
  writeFileSync(path.join(manifest().rootPath, 'main.py'), external);
  await expect(page.getByText('Konflikt synchronizacji:', { exact: false })).toBeVisible();
  expect(await editorText(page)).toContain(marker); expect(disk()).toBe(external);
  await expect(page.getByRole('button', { name: /Zachowaj mój lokalny draft/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /Załaduj wersję z dysku/ })).toBeVisible();
  // Do not silently release/commit the obsolete base. The next test uses a fresh page/connection.
});

test('AC-011 TEST-011: committed pre-cutoff step arriving after local veto cannot erase pre-ACK draft', async ({ page }) => {
  const relay = new Relay(); let count = 0; let vetoId: string | undefined;
  relay.holdOut = frame => { if (frame.type === 'VETO_ESCAPE') vetoId = frame.messageId; return false; };
  let withholding = false;
  relay.holdIn = frame => {
    if (frame.type === 'COACH_STEP_EDIT' && ++count === 2) withholding = true;
    return withholding; // hold subsequent actual frames, preserving wire seq order
  };
  await relay.install(page); await openEditor(page);
  await chat(page, 'QA:DEMO');
  await expect.poll(() => relay.heldIncoming.filter(f => f.data.type === 'COACH_STEP_EDIT').length).toBe(1);
  const late = relay.heldIncoming.find(f => f.data.type === 'COACH_STEP_EDIT')!.data;
  expect(manifest().committedSteps.some((f: any) => f.id === late.payload.stepId)).toBe(true);
  expect(disk()).toContain('coach_fixture_step_2');
  await editorInput(page).click(); await page.keyboard.press('Escape'); await page.keyboard.press('Escape');
  const marker = `human_before_veto_ack_${Date.now()}`;
  await append(page, `# ${marker}\n`);
  await expect.poll(() => relay.heldIncoming.some(f => f.data.type === 'ACK' && f.data.payload.replyTo === vetoId)).toBe(true);
  expect(await editorText(page)).toContain(marker);
  const step = relay.heldIncoming.find(f => f.data.type === 'COACH_STEP_EDIT')!;
  relay.heldIncoming = relay.heldIncoming.filter(f => f !== step); step.route.send(step.raw);
  await expect.poll(() => editorText(page)).toContain(marker);
  relay.holdIn = () => false; relay.releaseIncoming();
  await expect.poll(async () => {
    const visible = await editorText(page);
    const conflict = await page.getByText('Konflikt synchronizacji:', { exact: false }).isVisible();
    return visible.includes(marker) && (conflict || (visible.includes('coach_fixture_step_2') && disk().includes(marker)));
  }).toBe(true);
});

test('AC-006 TEST-006: actual Monaco Undo/Redo groups two committed fixture coach steps', async ({ page }) => {
  await openEditor(page); const before = disk();
  await chat(page, 'QA:DEMO');
  await expect.poll(() => disk()).toBe(before + '# coach_fixture_step_1\n# coach_fixture_step_2\n');
  await expect.poll(() => editorText(page)).toContain('coach_fixture_step_2');
  await expect(page.getByText('Tryb ucznia (Piszesz Ty)', { exact: false })).toBeVisible();
  await editorInput(page).click(); await page.keyboard.press('ControlOrMeta+z');
  await expect.poll(() => disk()).toBe(before);
  await page.keyboard.press(process.platform === 'win32' ? 'Control+y' : 'ControlOrMeta+Shift+z');
  await expect.poll(() => disk()).toBe(before + '# coach_fixture_step_1\n# coach_fixture_step_2\n');
  await append(page, '# separate_student_group\n');
  await expect.poll(() => disk()).toContain('separate_student_group');
  await page.keyboard.press('ControlOrMeta+z');
  await expect.poll(() => disk()).toBe(before + '# coach_fixture_step_1\n# coach_fixture_step_2\n');
});
