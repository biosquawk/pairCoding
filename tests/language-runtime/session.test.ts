import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough, Writable } from 'node:stream';
import { randomUUID } from 'node:crypto';
import * as codec from '../../src/language/uriCodec';
import { JsonRpcTransport } from '../../src/server/language/JsonRpcTransport';
import { LanguageServerSession } from '../../src/server/language/LanguageServerSession';
import type { LanguageProcessIntent } from '../../src/server/language/LanguageProcessJournal';
import type { LanguageProcessRetirement } from '../../src/server/language/DockerLanguageProcess';
import type { LanguageShadow, ShadowIdentity } from '../../src/server/language/LanguageShadowStore';
import type { AnalysisSource, CompleteRequest, DiagnosticsResult, DocumentStamp, OpenOrChange } from '../../src/shared/language-v2';
import { validateDiagnosticsResult } from '../../src/shared/validation-v2';
const initial = '😀.\r\nnext';
const document = (content = initial): OpenOrChange => ({ stamp: { projectId: 'p', sessionId: 's', path: 'src/Zażółć spację.py', profileId: 'python-3.13',
  connectionGeneration: 'conn', configurationGeneration: 'config', providerGeneration: 'provider', shadowGeneration: 'shadow', modelLifetime: 'model',
  localModelVersion: 1, baseDocumentVersion: 1, documentVersion: null, contentSha256: codec.contentSha256(content), controlEpoch: 0, requestGeneration: 1 }, content, reason: 'OPEN' });
const request = (doc: OpenOrChange, id = randomUUID()): CompleteRequest => ({ requestId: id, stamp: structuredClone(doc.stamp), position: { line: 1, column: 4 }, trigger: '.' });
const completion = [{ label: 'ownMethod', textEdit: { range: { start: { line: 0, character: 3 }, end: { line: 0, character: 3 } }, newText: 'ownMethod()' }, command: { command: 'evil' } }];
const diagnostic = (severity = 2) => ({ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 2 } }, severity, message: 'raw warning', code: 42, data: 'DROP' });
const capabilities = { capabilities: { completionProvider: { triggerCharacters: ['.'], resolveProvider: true }, textDocumentSync: { openClose: true, change: 2 }, positionEncoding: 'utf-16' } };
function makeShadow(doc: OpenOrChange, phase: LanguageShadow['phase'], provider: 'jdt' | 'pylsp' = 'pylsp', launchId: string = randomUUID()): LanguageShadow {
  const s = doc.stamp;
  const identity: ShadowIdentity = { projectId: s.projectId, sessionId: s.sessionId, profileId: s.profileId, configurationGeneration: s.configurationGeneration,
    providerGeneration: s.providerGeneration, shadowGeneration: s.shadowGeneration, connectionGeneration: s.connectionGeneration, provider,
    imageId: `sha256:${'a'.repeat(64)}`, toolchainSha256: 'b'.repeat(64), dependencyManifestSha256: 'c'.repeat(64), analysisSettingsSha256: 'd'.repeat(64) };
  return { launchId, phase, workspaceDirectory: `/fixture/${launchId}/workspace`, bootDirectory: `/fixture/${launchId}/boot`, stateDirectory: `/fixture/${launchId}/state`,
    wholeProjectManifestPath: `/fixture/${launchId}/manifest.json`, inputManifestSha256: 'e'.repeat(64),
    manifest: { schemaVersion: 1, launchId, phase, leaseId: 'lease', identity, sourceInventorySha256: 'f'.repeat(64), dependencyInventorySha256: '0'.repeat(64),
      files: [{ path: s.path, bytes: Buffer.byteLength(codec.normalizeContent(doc.content)), sha256: s.contentSha256, uri: codec.toWorkspaceUri(s.path), origin: 'overlay' }],
      directories: ['src'], overlays: [structuredClone(s)] } };
}
// Explicit UNIT fake process/daemon + synthetic trusted manifest. Actual accepted SINGLE codec and real
// JsonRpcTransport framing are exercised; no Docker, private-FS capture, real pylsp/JDT/import readiness claim.
class FakeProcess {
  intent: Readonly<LanguageProcessIntent>;
  input = new PassThrough(); rpc: JsonRpcTransport; frames: any[] = []; retired = 0; started = 0;
  init: unknown = structuredClone(capabilities); completionValue: unknown = completion; autoComplete = true;
  projectUris: unknown = ['file:///workspace'];
  pending: any[] = []; sentHook?: (frame: any) => void;
  outcome: LanguageProcessRetirement = { confirmed: true, removed: true, problem: null };
  constructor(shadow: LanguageShadow) {
    this.intent = { ...shadow.manifest.identity, installationId: 'install', engineId: 'engine', schemaVersion: 1, launchId: shadow.launchId,
      phase: shadow.phase, provider: shadow.manifest.identity.provider, imageId: shadow.manifest.identity.imageId,
      argv: ['/usr/local/bin/python', '-m', 'pylsp'], name: 'fixture', labels: {}, workspaceDirectory: shadow.workspaceDirectory,
      bootDirectory: shadow.bootDirectory, stateDirectory: shadow.stateDirectory, createdUTC: new Date().toISOString() };
    const output = new Writable({ write: (bytes: Buffer, _encoding, callback) => {
      try {
        const i = bytes.indexOf('\r\n\r\n'), frame = JSON.parse(bytes.subarray(i + 4).toString('utf8')); this.frames.push(frame);
        this.sentHook?.(frame);
        if (frame.method === 'initialize') this.respond(frame.id, this.init);
        if (frame.method === 'workspace/executeCommand') this.respond(frame.id, this.projectUris);
        if (frame.method === 'textDocument/completion') {
          if (this.autoComplete) this.respond(frame.id, this.completionValue); else this.pending.push(frame);
        }
        callback();
      } catch (e) { callback(e as Error); }
    } });
    this.rpc = new JsonRpcTransport(this.input, output, { connectionId: shadow.launchId });
  }
  respond(id: string, result: unknown) { this.send({ jsonrpc: '2.0', id, result }); }
  notify(method: string, params: unknown) { this.send({ jsonrpc: '2.0', method, params }); }
  send(value: unknown) { const b = Buffer.from(JSON.stringify(value)); this.input.write(Buffer.concat([Buffer.from(`Content-Length: ${b.length}\r\n\r\n`), b])); }
  async start() { this.started++; return this.rpc; }
  async retire() { this.retired++; this.rpc.close(); return this.outcome; }
}
function fixture(t: TestContext, phase: LanguageShadow['phase'] = 'completion', provider: 'jdt' | 'pylsp' = 'pylsp') {
  const doc = document(), shadow = makeShadow(doc, phase, provider), process = new FakeProcess(shadow);
  let currentShadow = shadow, current = true;
  const results: DiagnosticsResult[] = [], states: string[] = [], sources: Array<{ stamp: Readonly<DocumentStamp>; source: Readonly<AnalysisSource> }> = [];
  const settings = { pylsp: { plugins: { jedi_completion: { include_params: false } } } };
  const session = new LanguageServerSession({ process, shadow, codec, settings,
    assertCurrent: s => { if (!current || s !== currentShadow) throw new Error('stale full source vector'); },
    onState: (s, problem) => states.push(s + (problem ? ':' + problem : '')), onDiagnostics: d => results.push(d),
    onSourceSent: (stamp, source) => sources.push({ stamp, source }) });
  t.after(async () => { await session.retire(); });
  return { session, process, doc, shadow, settings, results, states, sources,
    revoke: () => { current = false; },
    replace: (next: OpenOrChange) => { currentShadow = makeShadow(next, phase, provider, shadow.launchId); session.replaceCompletionShadow(currentShadow); },
    diagnostic: (diagnostics: unknown, version?: unknown, uri = codec.toWorkspaceUri(doc.stamp.path)) =>
      process.notify('textDocument/publishDiagnostics', { uri, diagnostics, ...(version === undefined ? {} : { version }) }) };
}
const tick = () => new Promise(resolve => setImmediate(resolve));

test('initialize uses UTF16/no writes/snippets and pinned settings; initialize alone never ON', async t => {
  const f = fixture(t); await f.session.start(); assert.equal(f.session.state, 'INDEXING');
  const p = f.process.frames[0].params;
  assert.equal(p.rootUri, 'file:///workspace'); assert.deepEqual(p.capabilities.general.positionEncodings, ['utf-16']);
  assert.equal(p.capabilities.workspace.applyEdit, false); assert.equal(p.capabilities.textDocument.completion.completionItem.snippetSupport, false);
  assert.deepEqual(p.initializationOptions.settings, f.settings);
  assert.deepEqual(f.process.frames[2].params.settings, f.settings); assert.equal(f.process.started, 1);
});
test('invalid capabilities/encoding/initialize failure retires actual owner, never fake ON', async t => {
  for (const init of [null, {}, { capabilities: { completionProvider: {}, textDocumentSync: 0 } },
    { capabilities: { ...capabilities.capabilities, positionEncoding: 'utf-8' } }]) {
    const f = fixture(t); f.process.init = init; await assert.rejects(f.session.start()); await tick();
    assert.equal(f.process.retired, 1); assert.equal(f.session.state, 'FAILED'); assert.equal(f.states.includes('ON'), false);
  }
});
test('real central codec/UTF16/CRLF + framed completion uses exact sent source captured BEFORE response', async t => {
  const f = fixture(t); f.process.sentHook = frame => { if (frame.method === 'textDocument/didOpen') {
    assert.equal(f.sources.length, 1); assert.equal(f.session.readSource(f.doc.stamp), f.sources[0].source);
    assert.equal(frame.params.textDocument.text, '😀.\nnext'); assert.equal(frame.params.textDocument.uri, codec.toWorkspaceUri(f.doc.stamp.path));
  } };
  await f.session.open(f.doc); const req = request(f.doc); const result = await f.session.complete(req);
  assert.equal(result.items.length, 1); assert.equal(f.session.state, 'ON'); assert.deepEqual(result.stamp, f.doc.stamp);
  assert.equal(JSON.stringify(result).includes('evil'), false); assert.equal(Object.isFrozen(f.sources[0].source), true);
  assert.equal(f.sources[0].source.provenance.kind, 'VERSIONED_PUSH');
  const frame = f.process.frames.find(v => v.method === 'textDocument/completion'); assert.deepEqual(frame.params.position, { line: 0, character: 3 });
  await assert.rejects(f.session.complete(req), /Duplicate/);
});
test('JDT Started is required but NOT enough for ON; malformed/empty completion is not semantic proof', async t => {
  const f = fixture(t, 'completion', 'jdt'); await f.session.open(f.doc);
  await assert.rejects(f.session.complete(request(f.doc)), /indexing/);
  f.process.notify('language/status', { type: 'Started' }); await tick(); assert.equal(f.session.state, 'INDEXING');
  f.process.autoComplete = false; const result = f.session.complete(request(f.doc)); await tick(); f.process.respond(f.process.pending[0].id, []);
  assert.equal((await result).items.length, 0); assert.equal(f.session.state, 'INDEXING');
  f.process.autoComplete = true; assert.equal((await f.session.complete(request(f.doc))).items.length, 1); assert.equal(f.session.state, 'ON');
});
test('mutable pushes never markers, versioned OR unversioned, despite matching current bytes', async t => {
  const f = fixture(t); await f.session.open(f.doc); f.diagnostic([diagnostic()]); f.diagnostic([], 1);
  assert.equal(f.results.length, 0); assert.equal(f.session.state, 'INDEXING');
});
test('immutable versionless push maps ONLY fixed launch+sent stamp, raw severity preserved and no command/data', async t => {
  const f = fixture(t, 'diagnostics'); await f.session.open(f.doc); const source = f.sources[0].source;
  f.diagnostic([diagnostic()]); assert.equal(f.results.length, 1);
  const r = f.results[0]; assert.equal(validateDiagnosticsResult(r), true); assert.equal(r.items[0].severity, 'WARNING');
  assert.equal(r.items[0].code, '42'); assert.equal('data' in r.items[0], false); assert.deepEqual(r.sourceStamp, f.doc.stamp);
  assert.deepEqual(r.provenance, source.provenance); assert.deepEqual(r.provenance, { kind: 'IMMUTABLE_GENERATION', launchId: f.shadow.launchId, lspVersion: 1, inputManifestSha256: f.shadow.inputManifestSha256 });
  assert.equal(r.association, null); assert.equal(Object.isFrozen(r), true); assert.equal(f.session.state, 'ON');
  f.doc.stamp.localModelVersion = 99; assert.equal(r.sourceStamp.localModelVersion, 1);
});
test('immutable wrong/unknown URI, noncanonical aliases, wrong/null/valid versions handled without current rebinding', async t => {
  const f = fixture(t, 'diagnostics'); await f.session.open(f.doc);
  for (const uri of ['file:///workspace/other.py', 'file:///etc/passwd', codec.toWorkspaceUri(f.doc.stamp.path).replace('%20', ' '), 'file:///workspace/a%2Fb']) f.diagnostic([diagnostic()], 1, uri);
  for (const version of [0, 2, '1', -1]) f.diagnostic([diagnostic()], version);
  assert.equal(f.results.length, 0); assert.equal(f.process.retired, 0);
  f.diagnostic([], null); assert.equal(f.results.length, 1); assert.equal(f.results[0].items.length, 0);
  f.diagnostic([diagnostic()], 1); assert.equal(f.results.length, 2);
});
test('JDT immutable diagnostics before semantic Started are frozen and held; startup Error never ON', async t => {
  const f = fixture(t, 'diagnostics', 'jdt'); await f.session.open(f.doc); f.diagnostic([diagnostic()]); assert.equal(f.results.length, 0);
  f.process.notify('language/status', { type: 'Started' }); await tick(); assert.equal(f.results.length, 1); assert.equal(f.session.state, 'ON');
  const g = fixture(t, 'diagnostics', 'jdt'); await g.session.open(g.doc); g.diagnostic([diagnostic()]); g.process.notify('language/status', { type: 'Error' }); await tick();
  assert.equal(g.results.length, 0); assert.equal(g.session.state, 'FAILED'); assert.equal(g.process.retired, 1);
});
test('immutable diagnostics never didChange/didClose/replacedShadow; original sources remain fixed', async t => {
  const f = fixture(t, 'diagnostics'); await f.session.open(f.doc);
  await assert.rejects(f.session.change(f.doc), /never didChange/); await assert.rejects(f.session.close(f.doc.stamp), /retirement/);
  assert.throws(() => f.session.replaceCompletionShadow(f.shadow), /immutable/);
  assert.equal(f.process.frames.some(v => v.method === 'textDocument/didChange' || v.method === 'textDocument/didClose'), false);
});
test('invalid or surrogate-split diagnostics never manufacture marker or clear existing markers', async t => {
  const f = fixture(t, 'diagnostics'); await f.session.open(f.doc); f.diagnostic([diagnostic()]);
  for (const raw of [null, {}, [{ ...diagnostic(), severity: 9 }], [{ ...diagnostic(), severity: undefined }],
    [{ ...diagnostic(), message: '' }], [{ ...diagnostic(), range: { start: { line: 0, character: 1 }, end: { line: 0, character: 2 } } }]]) f.diagnostic(raw);
  assert.equal(f.results.length, 1); assert.equal(f.results[0].items[0].severity, 'WARNING');
});
test('completion refresh invalidates pending request synchronously, late old framed reply cannot reopen result', async t => {
  const f = fixture(t); await f.session.open(f.doc); f.process.autoComplete = false;
  const old = f.session.complete(request(f.doc)); const rejected = assert.rejects(old, /Cancel|Late/); await tick();
  const next = document('😀.\nchanged'); next.stamp.localModelVersion = 2; next.stamp.requestGeneration = 2; next.reason = 'UNDO';
  f.replace(next); const changed = f.session.change(next); f.process.respond(f.process.pending[0].id, completion);
  await rejected; await changed; assert.equal(f.sources.length, 2); assert.equal(f.sources[1].source.provenance.kind, 'VERSIONED_PUSH');
  assert.equal(f.session.readSource(f.doc.stamp), null); assert.deepEqual(f.session.readSource(next.stamp)?.sourceStamp, next.stamp);
  const frame = f.process.frames.find(v => v.method === 'textDocument/didChange'); assert.equal(frame.params.textDocument.version, 2);
  assert.deepEqual(frame.params.contentChanges, [{ text: '😀.\nchanged' }]);
  f.process.autoComplete = true; const r = await f.session.complete(request(next)); assert.equal(r.stamp.localModelVersion, 2);
});
test('cancel exact request does not fake process stop; duplicate/late response has no authority', async t => {
  const f = fixture(t); await f.session.open(f.doc); f.process.autoComplete = false;
  const req = request(f.doc), p = f.session.complete(req); const rejected = assert.rejects(p, /Cancel/); await tick();
  f.session.cancel(req.requestId); f.process.respond(f.process.pending[0].id, completion); await rejected;
  assert.equal(f.process.retired, 0); assert.equal(f.session.state, 'INDEXING');
  await assert.rejects(f.session.complete(req), /Duplicate/);
});
test('didClose/reopen retains monotonically increasing LSP version across new model lifetime', async t => {
  const f = fixture(t); await f.session.open(f.doc); await f.session.close(f.doc.stamp); assert.equal(f.session.readSource(f.doc.stamp), null);
  const next = document(); next.stamp.modelLifetime = 'newmodel'; f.replace(next); await f.session.open(next);
  const opens = f.process.frames.filter(v => v.method === 'textDocument/didOpen'); assert.deepEqual(opens.map(v => v.params.textDocument.version), [1, 2]);
});
test('revoked full-project vector and transport close immediately reject authority and retire real owner', async t => {
  const f = fixture(t, 'diagnostics'); await f.session.open(f.doc); f.revoke(); f.diagnostic([diagnostic()]); await tick();
  assert.equal(f.results.length, 0); assert.equal(f.session.readSource(f.doc.stamp), null); assert.equal(f.process.retired, 1); assert.equal(f.session.state, 'FAILED');
  const g = fixture(t); await g.session.open(g.doc); g.process.input.end(); await tick();
  assert.equal(g.session.state, 'FAILED'); assert.equal(g.process.retired, 1);
});
test('unknown Stop is retained and same process retried; semantic project import warning fails closed', async t => {
  const f = fixture(t); await f.session.open(f.doc); f.process.outcome = { confirmed: false, removed: false, problem: 'daemon offline' };
  const result = await f.session.retire(); assert.equal(result.confirmed, false); assert.equal(f.process.retired, 1);
  await assert.rejects(f.session.complete(request(f.doc)), /retired/); assert.equal(f.process.started, 1);
  f.process.outcome = { confirmed: true, removed: true, problem: null }; assert.equal((await f.session.retire()).removed, true); assert.equal(f.process.retired, 2);
  const g = fixture(t, 'completion', 'jdt'); await g.session.open(g.doc);
  g.process.notify('window/logMessage', { type: 2, message: 'Main.java is a non-project file; only syntax errors are reported' }); await tick();
  assert.equal(g.session.state, 'FAILED'); assert.equal(g.process.retired, 1);
});

test('cancel immediately after complete call rejects before queued admission/send', async t => {
  const f = fixture(t); await f.session.open(f.doc); const req = request(f.doc);
  const p = f.session.complete(req); f.session.cancel(req.requestId); await assert.rejects(p, /Cancelled/);
  assert.equal(f.process.frames.some(v => v.method === 'textDocument/completion'), false);
});

test('JDT Started with no exact imported project never gives completion/markers or ON', async t => {
  const f = fixture(t, 'diagnostics', 'jdt'); f.process.projectUris = ['file:///different']; await f.session.open(f.doc);
  f.diagnostic([diagnostic()]); f.process.notify('language/status', { type: 'Started' }); await tick();
  assert.equal(f.results.length, 0); assert.equal(f.session.state, 'FAILED'); assert.equal(f.process.retired, 1);
});

test('only exact read-only pinned JDT introspection command allowed, never command execution tunnel', async t => {
  const f = fixture(t); await f.session.start(); const before = f.process.frames.length;
  for (const params of [{ command: 'java.project.getAll', arguments: ['injection'] }, { command: 'java.edit.organizeImports', arguments: [] },
    { command: 'java.project.getAll', arguments: [], extra: true }, { command: 'java.project.getAll' }, null]) {
    await assert.rejects(f.process.rpc.request('workspace/executeCommand', params), /Forbidden/);
  }
  assert.equal(f.process.frames.length, before);
});
test('JDT project list accepts only literal directory suffix, syntax-only diagnostics invalidate completion too', async t => {
  const f = fixture(t, 'completion', 'jdt'); f.process.projectUris = ['file:///workspace/']; await f.session.open(f.doc);
  f.process.notify('language/status', { type: 'Started' }); await tick();
  assert.equal((await f.session.complete(request(f.doc))).items.length, 1);
  f.diagnostic([{ ...diagnostic(), message: 'Main.java is a non-project file, only syntax errors are reported' }]); await tick();
  assert.equal(f.session.state, 'FAILED'); assert.equal(f.process.retired, 1);
});

test('real framed pylsp insertText response reaches safe complete result with no resolve or secondary write', async t => {
  const f = fixture(t); const d = document('calc.'); f.replace(d);
  f.process.completionValue = [{ label: 'own_method(x)', kind: 3, insertText: 'own_method', data: { doc_uri: 'file:///workspace/x.py' } }];
  await f.session.open(d); const req = request(d); req.position.column = 6; const r = await f.session.complete(req);
  assert.equal(r.items[0].primary.text, 'own_method'); assert.equal(f.session.state, 'ON');
  assert.equal(f.process.frames.filter(v => v.method === 'textDocument/didOpen').length, 1);
  assert.equal(f.process.frames.some(v => /resolve|didSave/.test(v.method ?? '')), false);
});
