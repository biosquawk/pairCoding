// AC001..003: final public GUI, not Monaco/store/model API or fabricated ACKs.
import { expect, type Page, type TestType } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { fixture, filesBelow, type Fixture } from './fixture';
import { Wire, editor, editorHost, acknowledged, settings, session } from './helpers';

export const nonEmptyAlert = /\S/u; // HUMAN debece2b: empty Monaco live regions are not error messages
export const taskMarkdown = '# QA markdown-only task\n\nImplement your own solution in a new file.\n';
export const languageCases = [
  { file: 'QaJava.java', language: 'java', first: 'public class QaJava {', keyword: 'public', name: 'QaJava', comment: '// QA java comment', marker: 'qa_java' },
  { file: 'qa_python.py', language: 'python', first: 'def qa_python():', keyword: 'def', name: 'qa_python', comment: '# QA python comment', marker: 'qa_python' },
  { file: 'qa_javascript.js', language: 'javascript', first: 'function qaJavaScript() {', keyword: 'function', name: 'qaJavaScript', comment: '// QA js comment', marker: 'qa_js' },
  { file: 'qa_typescript.ts', language: 'typescript', first: 'interface QaTypeScript {', keyword: 'interface', name: 'QaTypeScript', comment: '// QA ts comment', marker: 'qa_ts' },
].map(c => ({ ...c, text: c.first + '\n' + c.comment + '\n' +
  Array.from({ length: 118 }, (_, i) => `${c.comment.startsWith('#') ? '#' : '//'} visible line ${i + 3}\n`).join('') }));
export const limitBytes = 1024 * 1024;
export const invalidInputs = {
  'binary.dat': Buffer.from([0x51, 0x41, 0, 0xff, 0xfe, 0x80, 0x0a]),
  'oversized.txt': Buffer.from('A'.repeat(limitBytes) + 'Z'),
  'boundary.txt': Buffer.from('A'.repeat(limitBytes - 1) + 'Z'),
};

async function connect(page: Page, f: Fixture, w: Wire) {
  await w.install(page); await page.goto(f.baseURL);
  await expect.poll(() => w.sent.some(m => m.type === 'HELLO')).toBe(true);
  await expect(page.getByText('LIVE — lokalny backend', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Otwórz folder', exact: true })).toBeEnabled();
}
async function start(page: Page) {
  const [r] = await Promise.all([page.waitForResponse(r => r.url().endsWith('/api/session/start') && r.request().method() === 'POST'),
    page.getByRole('button', { name: 'Start sesji', exact: true }).click()]);
  expect(r.status()).toBe(200);
}
async function select(page: Page, file: string) {
  const tab = page.getByRole('tab', { name: file, exact: true });
  if (await tab.count()) await tab.click();
  else await page.getByRole('button', { name: `Otwórz plik ${file}`, exact: true }).click();
  await expect(editor(page, file)).toBeVisible();
}
async function savedSince(f: Fixture, w: Wire, since: number, text: string, file: string) {
  // Undo revisits older content: an earlier matching ACK is NOT fresh confirmation.
  await expect.poll(() => acknowledged({ sent: w.sent.slice(since), received: w.received } as Wire, text, file)).toBe(true);
  expect(f.read(file)).toBe(text);
}
async function colors(page: Page, first: string, name: string) {
  return page.locator('.monaco-editor .view-lines').evaluate((root, data) => {
    const lines = [...root.querySelectorAll('.view-line')];
    const normalize = (s: string) => s.replaceAll('\u00a0', ' ');
    const line = lines.find(l => normalize(l.textContent ?? '') === data.first);
    const comment = lines.find(l => /^(\/\/|#) QA .*comment$/.test(normalize(l.textContent ?? '')));
    if (!line || !comment) throw new Error('Actual first/comment lines are not rendered');
    function at(el: Element, index: number) {
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      let n: Node | null;
      while ((n = walker.nextNode())) {
        if (index < (n.textContent?.length ?? 0)) return getComputedStyle(n.parentElement!).color;
        index -= n.textContent?.length ?? 0;
      }
      throw new Error('No rendered token at fixture offset');
    }
    return { keyword: at(line, 0), identifier: at(line, data.first.indexOf(data.name)), comment: at(comment, 0) };
  }, { first, name });
}
async function view(page: Page) {
  return page.locator('.monaco-editor').evaluate(root => {
    const viewport = root.getBoundingClientRect();
    const cursor = root.querySelector<HTMLElement>('.cursors-layer .cursor');
    const numbers = [...root.querySelectorAll('.line-numbers')].filter(e => {
      const r = e.getBoundingClientRect(); return r.bottom > viewport.top && r.top < viewport.bottom;
    }).map(e => ({ line: Number(e.textContent), top: Math.round(e.getBoundingClientRect().top - viewport.top) }));
    return { cursorLeft: cursor?.style.left, cursorTop: cursor?.style.top, numbers,
      scrollThumb: root.querySelector<HTMLElement>('.scrollbar.vertical .slider')?.style.top };
  });
}

type Args = { page: Page; wire: Wire; make: (options?: Parameters<typeof fixture>[0]) => Promise<Fixture> };
export function registerBasics(test: TestType<Args, {}>) {
  test('TEST-001: open markdown-only folder in GUI, read task, create and save without build tools', async ({ page, make, wire }) => {
    const f = await make({ files: { 'challenge.md': taskMarkdown } });
    expect(Object.keys(filesBelow(f.rootPath))).toEqual(['challenge.md']);
    await connect(page, f, wire);
    // Exercise the delivered folder chooser, not only a preconfigured server root.
    await page.getByRole('button', { name: 'Otwórz folder', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Ustawienia Projektu i Trenera AI', exact: true });
    await dialog.getByLabel('Lokalny folder zadania', { exact: true }).fill(f.rootPath);
    const [opened] = await Promise.all([page.waitForResponse(r => r.url().endsWith('/api/project/open') && r.request().method() === 'POST'),
      dialog.getByRole('button', { name: 'Otwórz wskazany folder', exact: true }).click()]);
    expect(opened.status()).toBe(201);
    const project = await opened.json();
    expect(project.capabilities.docs).toBe('NOT_INSTALLED');
    expect(project.capabilities.autocomplete).toBe('NOT_INSTALLED'); // public state, not proof of registry-module architecture
    await expect(dialog).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'QA markdown-only task', exact: true })).toBeVisible();
    await expect(page.locator('p').filter({ hasText: /^Implement your own solution in a new file\.$/ })).toBeVisible();
    expect((await session(page, f)).lifecycle).toBe('READY');
    await expect(page.getByRole('button', { name: 'Run Tests', exact: true })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Run Main', exact: true })).toBeDisabled();
    await start(page);
    await page.getByTitle('Utwórz nowy plik (np. src/helper.ts)', { exact: true }).click();
    await page.getByPlaceholder('ścieżka/nazwa_pliku.ext', { exact: true }).fill('solution.py');
    const [created] = await Promise.all([page.waitForResponse(r => r.url().endsWith('/api/file') && r.request().method() === 'POST'),
      page.getByTitle('Utwórz', { exact: true }).click()]);
    expect(created.status()).toBe(200); await expect(editor(page, 'solution.py')).toBeVisible();
    const since = wire.sent.length; await editor(page, 'solution.py').focus(); await page.keyboard.insertText('answer = 42');
    await savedSince(f, wire, since, 'answer = 42', 'solution.py');
    expect(f.read('challenge.md')).toBe(taskMarkdown);
    expect(Object.keys(filesBelow(f.rootPath))).toEqual(['challenge.md', 'solution.py']);
    await expect(page.getByRole('alert').filter({ hasText: nonEmptyAlert })).toHaveCount(0);
  });

  test('TEST-002: four real language tabs retain coloring, cursor, scroll and independent local Undo', async ({ page, make, wire }, info) => {
    const f = await make({ files: { 'challenge.md': taskMarkdown, 'plain.txt': languageCases[0].text,
      ...Object.fromEntries(languageCases.map(c => [c.file, c.text])) } });
    await connect(page, f, wire); await start(page);
    const expected = Object.fromEntries(languageCases.map(c => [c.file, c.text]));
    const views: Record<string, Awaited<ReturnType<typeof view>>> = {}, evidence: any[] = [];
    for (const c of languageCases) {
      await select(page, c.file); await editor(page, c.file).focus(); await page.keyboard.press('ControlOrMeta+Home');
      await expect(editorHost(page, c.file)).toHaveAttribute('data-mode-id', c.language); // actual GUI host, not core DTO/model API
      await expect.poll(async () => {
        const s = await colors(page, c.first, c.name); return s.keyword !== s.identifier && s.keyword !== s.comment && s.identifier !== s.comment;
      }, { message: `${c.file}: visible keyword, identifier and comment must have distinct syntax colors` }).toBe(true);
      evidence.push({ file: c.file, renderedLanguage: c.language, colors: await colors(page, c.first, c.name) });
      let since = wire.sent.length;
      await page.keyboard.press('ControlOrMeta+End'); await page.keyboard.insertText(c.marker);
      expected[c.file] = c.text + c.marker; await savedSince(f, wire, since, expected[c.file], c.file);
      // Move via the real Monaco Go to Line UI, never editor.setPosition/setScrollTop.
      await page.keyboard.press('ControlOrMeta+g');
      await page.getByRole('textbox', { name: /Type a line number|Wpisz numer wiersza/i }).fill(':70:7');
      await page.keyboard.press('Enter'); await page.keyboard.press('Escape');
      const target = page.locator('.monaco-editor .view-lines'); await target.hover(); await page.mouse.wheel(0, 80);
      await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
      await expect.poll(async () => (await view(page)).numbers.some(n => n.line > 1)).toBe(true);
      let previous = '', stable = 0;
      await expect.poll(async () => {
        const current = JSON.stringify(await view(page)); stable = current === previous ? stable + 1 : 0; previous = current; return stable;
      }, { message: 'Capture only a settled real cursor/scroll state after normal Go to Line/wheel' }).toBeGreaterThanOrEqual(2);
      views[c.file] = await view(page); expect(views[c.file].cursorLeft).toBeTruthy(); expect(views[c.file].cursorTop).toBeTruthy();
    }
    // Negative/control: identical bytes opened as plaintext must NOT masquerade as colored code.
    await select(page, 'plain.txt'); await editor(page, 'plain.txt').focus(); await page.keyboard.press('ControlOrMeta+Home');
    await expect(editorHost(page, 'plain.txt')).toHaveAttribute('data-mode-id', 'plaintext');
    const plain = await colors(page, languageCases[0].first, languageCases[0].name);
    expect(plain.keyword).toBe(plain.identifier); expect(plain.comment).toBe(plain.identifier); evidence.push({ file: 'plain.txt', colors: plain });
    for (const c of languageCases) {
      await select(page, c.file); await editor(page, c.file).focus();
      await expect(editorHost(page, c.file)).toHaveAttribute('data-mode-id', c.language);
      await expect.poll(() => view(page), { message: `${c.file}: real cursor and viewport restored after tab return` }).toEqual(views[c.file]);
      const lines = expected[c.file].split('\n'), marker = `QA_CURSOR_${c.name}`;
      lines[69] = lines[69].slice(0, 6) + marker + lines[69].slice(6);
      let since = wire.sent.length; await page.keyboard.insertText(marker);
      await savedSince(f, wire, since, lines.join('\n'), c.file); // logical cursor, not pixels alone
      since = wire.sent.length; await page.keyboard.press('ControlOrMeta+z');
      await savedSince(f, wire, since, expected[c.file], c.file);
      since = wire.sent.length; await page.keyboard.press('ControlOrMeta+z');
      await savedSince(f, wire, since, c.text, c.file); expected[c.file] = c.text;
      for (const [file, bytes] of Object.entries(expected)) expect(f.read(file), `Undo ${c.file} must not undo ${file}`).toBe(bytes);
      evidence.push({ file: c.file, retainedView: views[c.file], freshUndoVerified: true });
    }
    await info.attach('actual-dom-color-view-and-local-undo', { contentType: 'application/json', body: Buffer.from(JSON.stringify(evidence, null, 2)) });
  });

  test('TEST-003: GUI missing/binary/over-1MiB errors retain original bytes; exact-1MiB text remains readable', async ({ page, make, wire }, info) => {
    const f = await make({ files: { 'challenge.md': taskMarkdown, ...invalidInputs } });
    const before = filesBelow(f.rootPath), evidence: any[] = [];
    await connect(page, f, wire);
    for (const [file, status, reason] of [
      ['binary.dat', 400, /UTF.?8|binar|kodowan|encoding/i],
      ['oversized.txt', 413, /1\s*MiB|1048576/i],
    ] as const) await test.step(file, async () => {
      const [r] = await Promise.all([page.waitForResponse(r => new URL(r.url()).pathname === '/api/file' && new URL(r.url()).searchParams.get('path') === file),
        page.getByRole('button', { name: `Otwórz plik ${file}`, exact: true }).click()]);
      expect(r.status()).toBe(status);
      await expect(page.getByRole('alert').filter({ hasText: reason }).first()).toBeVisible();
      await expect(editor(page, file)).toHaveCount(0); // never a writable truncated/sanitized substitute
      expect(filesBelow(f.rootPath)).toEqual(before);
      evidence.push({ file, status: r.status(), response: await r.json(), guiAlerts: await page.getByRole('alert').allTextContents() });
    });
    await test.step('missing task selected through normal settings', async () => {
      const dialog = await settings(page);
      await dialog.getByLabel('Ścieżka pliku zadania:', { exact: true }).fill('qa-missing.txt');
      const [missing] = await Promise.all([page.waitForResponse(r => new URL(r.url()).pathname === '/api/file' && new URL(r.url()).searchParams.get('path') === 'qa-missing.txt'),
        dialog.getByRole('button', { name: 'Zapisz Ustawienia', exact: true }).click()]);
      expect(missing.status()).toBe(404);
      await expect(page.getByRole('alert').filter({ hasText: /not exist|not found|nie istnieje|nie znalezion|brak pliku/i }).first()).toBeVisible();
      expect(fs.existsSync(path.join(f.rootPath, 'qa-missing.txt'))).toBe(false);
      expect(filesBelow(f.rootPath)).toEqual(before);
      evidence.push({ file: 'qa-missing.txt', status: missing.status(), response: await missing.json(), guiAlerts: await page.getByRole('alert').allTextContents() });
    });
    await test.step('positive inclusive 1MiB boundary', async () => {
      const [r] = await Promise.all([page.waitForResponse(r => new URL(r.url()).pathname === '/api/file' && new URL(r.url()).searchParams.get('path') === 'boundary.txt'),
        page.getByRole('button', { name: 'Otwórz plik boundary.txt', exact: true }).click()]);
      expect(r.status()).toBe(200); const doc = await r.json();
      expect(doc.content).toBe(invalidInputs['boundary.txt'].toString('utf8'));
      await expect(editor(page, 'boundary.txt')).toBeVisible();
      expect(filesBelow(f.rootPath)).toEqual(before);
      expect(wire.sent.filter(m => m.type === 'CODE_CHANGED')).toHaveLength(0);
      for (const [file, original] of Object.entries(invalidInputs)) expect(fs.readFileSync(path.join(f.rootPath, file)).equals(original)).toBe(true);
      evidence.push({ file: 'boundary.txt', status: r.status(), contentBytes: Buffer.byteLength(doc.content), originalByteIdentical: true });
    });
    await info.attach('gui-open-errors-and-raw-byte-integrity', { contentType: 'application/json', body: Buffer.from(JSON.stringify(evidence, null, 2)) });
  });
}
