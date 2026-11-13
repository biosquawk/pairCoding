// Product regressions: real HTTP/WS plus source-isolated lifecycle unit (not GUI acceptance).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import vm from 'node:vm';
import { LiveBackend } from '../../src/services/LiveBackend';
import { createPairCoachServer } from '../../src/server/http';
import { disableNativeCompletionProviders, SAFE_SUGGEST_OPTIONS } from '../../src/services/monacoLspBridge';
import { createBuiltinLanguageRegistry, languageForPath } from '../../src/services/builtinLanguageRegistry';
const panel = fs.readFileSync(new URL('../../src/components/EditorPanel.tsx', import.meta.url), 'utf8');
// Source-extracted callbacks with explicit fake editor; NOT React/Monaco integration.
const mountStart = panel.indexOf('const handleEditorMount: OnMount = (editor, monaco) => {');
const mountBody = panel.slice(panel.indexOf('{', mountStart) + 1, panel.indexOf('\n  };', mountStart));
test('001 lifetime unit: only current instance disposal invalidates refs; stable editor shell across loading', () => {
  const refs: any = { editorRef: { current: null }, monacoRef: { current: null }, decorationsRef: { current: ['old'] },
    setEditorReady() {}, setEditorGeneration() {}, disableNativeCompletionProviders, SAFE_SUGGEST_OPTIONS,
    createBuiltinLanguageRegistry, client:{setBuiltinLanguageProvider() {}} };
  const fake = () => { const callbacks: (() => void)[] = [], locks: any[] = []; return { callbacks, locks, updateOptions(v: any) { locks.push(v); }, onDidDispose(cb: () => void) { callbacks.push(cb); }, dispose() { callbacks.forEach(cb => cb()); } }; };
  const mode=()=>({modeConfiguration:{completionItems:true,diagnostics:true},setModeConfiguration(value:any){this.modeConfiguration=value;}});
  const monaco = { editor: { defineTheme() {}, setTheme() {} },
    typescript:{typescriptDefaults:mode(),javascriptDefaults:mode()},json:{jsonDefaults:mode()},
    css:{cssDefaults:mode(),lessDefaults:mode(),scssDefaults:mode()},
    html:{htmlDefaults:mode(),handlebarDefaults:mode(),razorDefaults:mode()} }, first = fake(), second = fake();
  const mount = (editor: any) => vm.runInNewContext('(function(){' + mountBody + '})()', { ...refs, editor, monaco });
  mount(first); assert.equal(first.locks.at(-1).readOnly, true); assert.equal(first.callbacks.length, 1, 'a disposed editor must invalidate its refs');
  mount(second); first.dispose(); assert.equal(refs.editorRef.current, second, 'late old disposal cannot clear new instance');
  second.dispose(); assert.equal(refs.editorRef.current, null); assert.equal(refs.monacoRef.current, null);
  assert.equal(refs.decorationsRef.current.length, 0);
  assert.doesNotMatch(panel, /activeFile && activeFile.loaded !== false \? \(/, 'do not conditionally unmount Monaco');
  assert.match(panel, /useLayoutEffect/, 'model swap/ownership lock must run before paint');
  assert.match(panel, /\[projectId, activePath, editorGeneration/, 'same-path new project must switch models');
  assert.match(panel, /hidden=\{!editorRef.current \|\| !activeFile \|\| activeFile.loaded === false\}/);
  assert.match(panel, /viewStatesRef.current.set\(currentModel.uri.toString\(\)/, 'viewstate is scoped to complete project URI');
});
async function until(fn: () => boolean, label: string) {
  const end = Date.now() + 5000;
  while (!fn()) { if (Date.now() > end) throw new Error('Timeout: ' + label); await new Promise(r => setTimeout(r, 10)); }
}
test('003 REAL HTTP/WS error projection: binary, oversized, settings missing task; retain state timeline', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'triage-real-')), root = path.join(dir, 'root'); fs.mkdirSync(root);
  fs.writeFileSync(path.join(root, 'challenge.md'), '# task');
  fs.writeFileSync(path.join(root, 'binary.dat'), Buffer.from([0x51,0,0xff]));
  fs.writeFileSync(path.join(root, 'oversized.txt'), 'A'.repeat(1024*1024+1));
  const app = createPairCoachServer({ rootPath: root, port: 0, devBootstrap: true, enableCoach: false });
  const port = await app.listen();
  const requests: any[] = [], states: any[] = [];
  const client = new LiveBackend({ baseUrl: `http://127.0.0.1:${port}`, fetch: (async (url, options) => {
    const r = await fetch(url, options); requests.push({ method: options?.method ?? 'GET', path: new URL(String(url)).pathname + new URL(String(url)).search, status: r.status }); return r;
  }) as typeof fetch });
  const unsub = client.subscribe('state', s => states.push({ activePath: s.activePath, task: s.scenario.taskFilePath, error: s.connectionError, files: s.files.map((f: any) => ({ path: f.path, loaded: f.loaded, loadError: f.loadError })) }));
  t.after(async () => { unsub(); client.close(); await app.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  await client.connect(); await until(() => !client.getState().isOffline, 'sync');
  await client.selectFile('binary.dat');
  assert.match(client.getState().connectionError!, /UTF|BINARY|ENCODING|binar/i);
  await client.selectFile('oversized.txt');
  assert.match(client.getState().connectionError!, /1048576|MiB/);
  const result = await client.updateProjectSettings({ ...client.getState().projectSettings, taskFilePath: 'qa-missing.txt' });
  await new Promise(r => setTimeout(r, 100));
  console.log(JSON.stringify({ result, requests, states }, null, 2));
  assert.equal(result, true);
  assert.ok(requests.some(r => r.path.includes('qa-missing.txt') && r.status === 404));
  assert.equal(client.getState().scenario.taskFilePath, 'qa-missing.txt');
  // This real environment shows what the client reports, not a guessed browser failure.
  assert.match(client.getState().connectionError!, /FILE_NOT_FOUND/);
  assert.match(client.getState().connectionError!, /binary.dat/);
  assert.equal(client.getState().taskReadError?.path, 'qa-missing.txt');
  assert.match(client.getState().taskReadError?.message ?? '', /FILE_NOT_FOUND/);
  assert.equal(client.getState().files.some(f => f.path === 'qa-missing.txt'), false, 'never create a fake writable missing ProjectFile');
  assert.equal(fs.readFileSync(path.join(root, 'binary.dat')).toString('hex'), '5100ff');
  assert.equal(fs.statSync(path.join(root, 'oversized.txt')).size, 1024*1024+1);
  assert.equal(await client.updateProjectSettings({ ...client.getState().projectSettings, taskFilePath: 'challenge.md' }), true);
  await new Promise(r => setTimeout(r, 100));
  assert.equal(client.getState().taskReadError, null, 'valid task clears only task-specific diagnostic');
  assert.match(client.getState().connectionError!, /binary.dat/, 'independent binary error still matters');
});
test('003 positive control REAL HTTP/WS: no active binary failure, missing task IS exposed', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'triage-control-')), root = path.join(dir, 'root'); fs.mkdirSync(root);
  fs.writeFileSync(path.join(root, 'challenge.md'), '# valid task');
  const app = createPairCoachServer({ rootPath: root, port: 0, devBootstrap: true, enableCoach: false });
  const port = await app.listen(), client = new LiveBackend({ baseUrl: `http://127.0.0.1:${port}` });
  t.after(async () => { client.close(); await app.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  await client.connect(); await until(() => !client.getState().isOffline, 'control sync');
  const transitions: any[] = [];
  const stop = client.subscribe('state', s => transitions.push({ activePath: s.activePath, loaded: s.files.find((f: any) => f.path === s.activePath)?.loaded ?? null, offline: s.isOffline }));
  assert.equal(await client.openProject(root), true, client.getState().connectionError ?? undefined);
  await until(() => !client.getState().isOffline && client.getState().files.some(f => f.path === 'challenge.md' && f.loaded), 'reopen same root');
  stop(); console.log('001 real openProject conditional-editor inputs', JSON.stringify(transitions));
  assert.ok(transitions.some(s => s.activePath === '' || s.loaded === false), 'conditional Editor absent at least once');
  assert.ok(transitions.some(s => s.loaded === true), 'conditional Editor present again');
  assert.equal(await client.updateProjectSettings({ ...client.getState().projectSettings, taskFilePath: 'qa-missing.txt' }), true);
  await new Promise(r => setTimeout(r, 100));
  assert.match(client.getState().connectionError!, /FILE_NOT_FOUND/);
  assert.equal(client.getState().files.some(f => f.path === 'qa-missing.txt'), false);
});

test('003 stale REAL read failure from previous root cannot contaminate new task or selection', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'triage-stale-')), root = path.join(dir, 'old'), next = path.join(dir, 'next');
  fs.mkdirSync(root); fs.mkdirSync(next);
  fs.writeFileSync(path.join(root, 'challenge.md'), '# old'); fs.writeFileSync(path.join(next, 'challenge.md'), '# next');
  const app = createPairCoachServer({ rootPath: root, port: 0, devBootstrap: true, enableCoach: false });
  const port = await app.listen(); let release!: () => void, held = false;
  const client = new LiveBackend({ baseUrl: `http://127.0.0.1:${port}`, fetch: (async (url, options) => {
    const response = await fetch(url, options);
    if (String(url).includes('old-missing.txt')) { held = true; await new Promise<void>(r => { release = r; }); }
    return response;
  }) as typeof fetch });
  t.after(async () => { release?.(); client.close(); await app.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  await client.connect(); await until(() => !client.getState().isOffline, 'old sync');
  const oldRead = client.selectFile('old-missing.txt'); await until(() => held, 'actual old404 held');
  assert.equal(await client.openProject(next), true, client.getState().connectionError ?? undefined);
  await until(() => !client.getState().isOffline && client.getState().scenario.title === next, 'next sync');
  release(); await oldRead;
  assert.equal(client.getState().taskReadError ?? null, null);
  assert.equal(client.getState().activePath, 'challenge.md');
  assert.equal(client.getState().connectionError, null, 'old failure must not cross generations');
});
test('003 task diagnostic is additive and labeled at the task UI entry (static, NOT rendering)', () => {
  const app = fs.readFileSync(new URL('../../src/App.tsx', import.meta.url), 'utf8');
  assert.match(app, /role="alert" aria-label="Błąd pliku zadania"/);
  assert.match(app, /state.taskReadError.path/); assert.match(app, /state.taskReadError.message/);
});
test('001 switch unit: detach during loading retains named model/Undo, restores URI-scoped view; no cross-project view', () => {
  const marker = panel.indexOf('// Switch models cleanly between tabs');
  const hook = panel.includes('useLayoutEffect(() => {', marker) ? 'useLayoutEffect(() => {' : 'useEffect(() => {';
  const start = panel.indexOf(hook, marker);
  const body = panel.slice(start + hook.length, panel.indexOf('}, [', start));
  const oldUri = { toString: () => 'paircoach://old/main.ts' }, newUri = { toString: () => 'paircoach://next/main.ts' };
  const oldModel = { uri: oldUri, undo: ['original', 'human'] }, nextModel = { uri: newUri, undo: ['other'] };
  let current: any = oldModel; const restores: any[] = [], options: any[] = [];
  const editor = { getModel: () => current, setModel: (m: any) => { current = m; }, saveViewState: () => ({ line: 70 }),
    restoreViewState: (v: any) => restores.push(v), updateOptions: (v: any) => options.push(v) };
  const models = new Map([[oldUri.toString(), oldModel], [newUri.toString(), nextModel]]);
  const context: any = { editorRef: { current: editor }, monacoRef: { current: { editor: { getModel: (uri: any) => models.get(uri.toString()), setModelLanguage() {} } } },
    activeFile: undefined, modelUri: () => oldUri, languageForPath, retiredModelsRef:{current:new Set()},
    viewStatesRef: { current: new Map() }, isApplyingCoachStepRef: { current: false } };
  const effect = () => vm.runInNewContext('(function(){' + body + '})()', context);
  effect(); assert.equal(current, null); assert.equal(options.at(-1).readOnly, true);
  context.activeFile = { path: 'main.ts', loaded: true, content: 'human' }; effect();
  assert.equal(current, oldModel); assert.deepEqual(oldModel.undo, ['original', 'human']); assert.equal(restores.at(-1).line, 70);
  context.modelUri = () => newUri; effect(); assert.equal(current, nextModel);
  assert.equal(restores.length, 1, 'old project view is never applied to new project URI');
  context.editorRef.current = null; effect(); assert.equal(current, nextModel, 'disposed ref cannot be reused by switch effect');
});
