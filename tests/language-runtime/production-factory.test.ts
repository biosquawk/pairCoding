import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { isDeepStrictEqual as same } from 'node:util';
import { PassThrough, Writable } from 'node:stream';
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import * as codec from '../../src/language/uriCodec';
import { ProductionLanguageRegistryFactory, type ProductionLanguageBinding } from '../../src/server/language/ProductionLanguageRegistryFactory';
import { LanguageProcessAdmission } from '../../src/server/language/DockerLanguageProcess';
import { DiskLanguageProcessJournal, sha256 } from '../../src/server/language/LanguageProcessJournal';
import type { LanguageAttachment, LanguageCommandResult, LanguageContainerInspection, LanguageDockerDriver } from '../../src/server/language/DockerLanguageDriver';
import type { RegistryLaunch, RegistrySnapshot } from '../../src/server/language/LanguageFeatureRegistry';
import type { AnalysisSource, CompleteRequest, DiagnosticsResult, OpenOrChange } from '../../src/shared/language-v2';
import type { LanguageProjectScope } from '../../src/server/language/ports';
import { profile } from '../runtime-contract/fixtures';
const result: LanguageCommandResult = { exitCode: 0, stdout: '', stderr: '', truncated: false };
// Only Docker/process IO and preparation admission are FAKE. The factory, complete shadow FS copies,
// boot durability, process journal/admission, framing, session and SAME central codec are production.
class Driver implements LanguageDockerDriver {
  commands: string[][] = []; frames: any[] = [];
  containers = new Map<string, LanguageContainerInspection>(); inputs = new Map<string, PassThrough>();
  async engineId() { return 'engine'; }
  async inspect(name: string) { const c = this.containers.get(name) ?? [...this.containers.values()].find(c => c.id === name); return c ? structuredClone(c) : null; }
  async command(args: readonly string[]): Promise<LanguageCommandResult> {
    this.commands.push([...args]);
    if (args[0] === 'create') {
      const name = args[args.indexOf('--name') + 1], labels: Record<string, string> = {};
      args.forEach((v, i) => { if (v === '--label') { const [key, value] = args[i + 1].split('='); labels[key] = value; } });
      this.containers.set(name, { name, labels, id: sha256(name), imageId: args[args.indexOf('--entrypoint') + 2],
        running: false, status: 'created', startedAt: '', exitCode: 0 });
    } else {
      const c = [...this.containers.values()].find(c => c.id === args.at(-1));
      if (!c) throw new Error('unknown exact container');
      if (args[0] === 'stop') { c.running = false; c.status = 'exited'; }
      if (args[0] === 'rm') { assert.equal(c.running, false); assert.equal(args.length, 2); this.containers.delete(c.name); }
    }
    return result;
  }
  private send(id: string, value: unknown) { const b = Buffer.from(JSON.stringify(value)); this.inputs.get(id)!.write(Buffer.concat([Buffer.from(`Content-Length: ${b.length}\r\n\r\n`), b])); }
  notify(launchId: string, method: string, params: unknown) {
    const c = [...this.containers.values()].find(c => c.labels['paircoach.launch'] === launchId)!;
    this.send(c.id, { jsonrpc: '2.0', method, params });
  }
  attach(id: string): LanguageAttachment {
    const c = [...this.containers.values()].find(c => c.id === id)!; c.running = true; c.status = 'running'; c.startedAt = new Date().toISOString();
    const input = new PassThrough(); this.inputs.set(id, input);
    const output = new Writable({ write: (bytes: Buffer, _encoding, cb) => {
      try {
        const frame = JSON.parse(bytes.subarray(bytes.indexOf('\r\n\r\n') + 4).toString('utf8')); this.frames.push(frame);
        if (frame.method === 'initialize') this.send(id, { jsonrpc: '2.0', id: frame.id, result: { capabilities: {
          completionProvider: {}, textDocumentSync: { openClose: true, change: 1 }, positionEncoding: 'utf-16' } } });
        if (frame.method === 'textDocument/completion') this.send(id, { jsonrpc: '2.0', id: frame.id, result: [{ label: 'method',
          textEdit: { range: { start: frame.params.position, end: frame.params.position }, newText: 'method' } }] });
        cb();
      } catch (error) { cb(error as Error); }
    } });
    return { input, output, done: new Promise(() => {}), disconnect: () => { input.end(); output.end(); } };
  }
}
function fixture(t: TestContext, family: 'python' | 'java-maven' = 'python') {
  const root = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'production-language-'));
  const clear = (dir: string): void => { for (const name of readdirSync(dir)) { const p = join(dir, name), s = lstatSync(p);
    if (s.isDirectory() && !s.isSymbolicLink()) clear(p); else if (s.isFile() && !s.isSymbolicLink()) chmodSync(p, 0o644); } };
  const owned = join(root, 'owned'), source = join(root, 'source'), cache = join(root, 'cache'), journalRoot = join(root, 'journal');
  [owned, source, cache, journalRoot].forEach(p => mkdirSync(p));
  const path = family === 'python' ? 'main.py' : 'Main.java', content = 'obj.\n', disk = 'old disk\n'; writeFileSync(join(source, path), disk);
  const project: LanguageProjectScope = { projectId: 'p', sessionId: 's', profile: profile(family), shadowDirectory: owned,
    configurationGeneration: 'config', providerGeneration: 'provider', shadowGeneration: 'shadow', connectionGeneration: 'connection' };
  const doc: OpenOrChange = { stamp: { projectId: 'p', sessionId: 's', profileId: project.profile.id, path,
    configurationGeneration: 'config', providerGeneration: 'provider', shadowGeneration: 'shadow', connectionGeneration: 'connection',
    modelLifetime: 'model', localModelVersion: 1, requestGeneration: 1, controlEpoch: 0, baseDocumentVersion: 1, documentVersion: null,
    contentSha256: codec.contentSha256(content) }, content, reason: 'OPEN' };
  const files = Object.entries({ 'tools.json': '{}', 'dependencies-prepared.json': '{}', ...(family === 'python'
    ? { 'site-packages/example.py': 'name = 1' } : { 'effective-pom.xml': '<project/>', 'm2/example.jar': 'jar bytes' }) }).map(([path, content]) => {
    if (path.includes('/')) mkdirSync(join(cache, path.split('/')[0]), { recursive: true });
    writeFileSync(join(cache, path), content); return { path, bytes: Buffer.byteLength(content), sha256: sha256(content) };
  });
  let snapshot: RegistrySnapshot = { revision: 'r1', documents: [doc] };
  let binding: ProductionLanguageBinding = { installationId: 'install', engineId: 'engine', imageId: `sha256:${'a'.repeat(64)}`,
    source: { leaseId: 'r1', projectRoot: source, files: [{ path, bytes: Buffer.byteLength(disk), sha256: sha256(disk) }],
      overlays: [{ stamp: doc.stamp, content: doc.content }], dependencies: { root: cache, files } },
    prepared: { family, workingDirectory: '.', files, toolchainSha256: 'b'.repeat(64), dependencySha256: 'c'.repeat(64) } };
  let current = true; const driver = new Driver(), launches: RegistryLaunch[] = [], results: DiagnosticsResult[] = [], sources: AnalysisSource[] = [];
  const factory = new ProductionLanguageRegistryFactory({ ownedRoot: owned, driver, journal: new DiskLanguageProcessJournal(journalRoot), admission: new LanguageProcessAdmission(),
    authority: { capture: () => binding, isCurrent: (scope, candidate, prepared) => current && same(scope, project) && same(candidate, snapshot) && same(prepared, binding) } });
  t.after(async () => { for (const launch of launches) await launch.session.retire(); clear(root); rmSync(root, { recursive: true, force: true }); });
  return { root, source, cache, owned, driver, project, doc, factory, results, sources,
    get snapshot() { return snapshot; }, get binding() { return binding; },
    create(phase: 'completion' | 'diagnostics' = 'completion') {
      const launch = factory.create(project, phase, snapshot, { onState: () => {}, onDiagnostics: r => results.push(r), onSourceSent: (_stamp, s) => sources.push(s) });
      launches.push(launch); return launch;
    },
    edit() {
      const next = { ...doc, content: 'value.\n', reason: 'TYPING' as const, stamp: { ...doc.stamp, localModelVersion: 2, requestGeneration: 2, contentSha256: codec.contentSha256('value.\n') } };
      snapshot = { revision: 'r2', documents: [next] }; binding = { ...binding, source: { ...binding.source, leaseId: 'r2', overlays: [{ stamp: next.stamp, content: next.content }] } }; return next;
    },
    incompatible() { binding = { ...binding, prepared: { ...binding.prepared, dependencySha256: 'd'.repeat(64) } }; },
    revoke() { current = false; },
  };
}
const request = (d: OpenOrChange, id = 'request'): CompleteRequest => ({ requestId: id, stamp: d.stamp, position: { line: 1, column: d.content.indexOf('.') + 2 }, trigger: '.' });
test('actual factory transfers owner before any Docker await; private copy/boot/framing completion/retirement join', async t => {
  const f = fixture(t), launch = f.create(); assert.equal(f.driver.commands.length, 0); assert.equal(launch.generation, null);
  await launch.session.start(); await launch.session.open(f.doc);
  const result = await launch.session.complete(request(f.doc)); assert.equal(result.items.length, 1); assert.deepEqual(result.stamp, f.doc.stamp);
  assert.equal(f.sources[0].provenance.kind, 'VERSIONED_PUSH');
  const create = f.driver.commands.find(a => a[0] === 'create')!;
  assert.ok(create.includes('--network=none')); assert.ok(create.includes('--pull=never'));
  assert.ok(create.includes('PYTHONPATH=/opt/pylsp')); assert.equal(create.join(' ').includes(f.source), false); assert.equal(create.join(' ').includes(f.cache), false);
  assert.equal(readFileSync(join(f.source, f.doc.stamp.path), 'utf8'), 'old disk\n');
  assert.deepEqual(await launch.session.retire(), { confirmed: true, removed: true, problem: null }); assert.equal(f.driver.containers.size, 0);
  assert.equal(f.driver.commands.filter(a => a[0] === 'rm').length, 1);
});
test('diagnostic sibling uses actual generated fixed manifest/source, never mutable completion pushes', async t => {
  const f = fixture(t), completion = f.create(), diagnostic = f.create('diagnostics');
  assert.notEqual(completion.session.launchId, diagnostic.session.launchId); const g = diagnostic.generation!;
  assert.equal(g.policy, 'IMMUTABLE_WHOLE_PROJECT'); assert.deepEqual(g.sources[0].sourceStamp, f.doc.stamp);
  assert.equal(g.inputManifestSha256, sha256(readFileSync(g.wholeProjectManifestPath)));
  for (const launch of [completion, diagnostic]) { await launch.session.start(); await launch.session.open(f.doc); }
  const diagnosticParams = { uri: codec.toWorkspaceUri(f.doc.stamp.path), diagnostics: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } }, severity: 1, message: 'undefined' }] };
  f.driver.notify(completion.session.launchId, 'textDocument/publishDiagnostics', diagnosticParams);
  f.driver.notify(diagnostic.session.launchId, 'textDocument/publishDiagnostics', diagnosticParams);
  await new Promise(resolve => setImmediate(resolve)); assert.equal(f.results.length, 1); assert.deepEqual(f.results[0].sourceStamp, f.doc.stamp);
  assert.deepEqual(f.results[0].provenance, g.sources[0].provenance); assert.equal(f.results[0].association, null);
});
test('compatible mutable refresh reuses process/root, replaces complete shadow before actual didChange', async t => {
  const f = fixture(t), launch = f.create(); await launch.session.start(); await launch.session.open(f.doc);
  const create = f.driver.commands[0], mount = create.find(a => a.startsWith('type=bind,src=') && a.endsWith('dst=/workspace,readonly'))!;
  const directory = mount.slice('type=bind,src='.length, mount.indexOf(',dst=')), inode = lstatSync(directory, { bigint: true }).ino;
  const next = f.edit(); assert.equal(f.factory.refreshCompletion(f.project, f.snapshot, launch), true);
  assert.equal(lstatSync(directory, { bigint: true }).ino, inode); assert.equal(readFileSync(join(directory, next.stamp.path), 'utf8'), next.content);
  assert.equal(f.driver.frames.filter(a => a.method === 'textDocument/didChange').length, 0);
  await launch.session.change(next); assert.equal(f.driver.frames.filter(a => a.method === 'textDocument/didChange').length, 1);
  await assert.rejects(launch.session.complete(request(f.doc, 'old'))); assert.equal((await launch.session.complete(request(next, 'new'))).items.length, 1);
  assert.equal(f.driver.commands.filter(a => a[0] === 'create').length, 1);
});
test('incompatible preparation returns false before refreshing any file or process', async t => {
  const f = fixture(t), launch = f.create(); await launch.session.start(); await launch.session.open(f.doc);
  const launchRoot = join(f.owned, launch.session.launchId), before = readFileSync(join(launchRoot, 'manifest.json'));
  f.edit(); f.incompatible(); assert.equal(f.factory.refreshCompletion(f.project, f.snapshot, launch), false);
  assert.deepEqual(readFileSync(join(launchRoot, 'manifest.json')), before); assert.equal(f.driver.commands.filter(a => a[0] === 'create').length, 1);
});
test('false current lease and actual cache inventory tampering fail before Docker commands', t => {
  const f = fixture(t); f.revoke(); assert.throws(() => f.create(), /Stale production/); assert.deepEqual(f.driver.commands, []);
  const g = fixture(t); writeFileSync(join(g.cache, 'tools.json'), 'tampered'); assert.throws(() => g.create(), /inventory\/manifest mismatch/); assert.deepEqual(g.driver.commands, []);
});
test('runtime boot manifest tamper rejects completion before RPC, never fabricates ready source', async t => {
  const f = fixture(t), launch = f.create(); await launch.session.start(); await launch.session.open(f.doc);
  const path = join(f.owned, launch.session.launchId, 'boot/language-launch.json'); chmodSync(path, 0o644); writeFileSync(path, 'tampered');
  await assert.rejects(launch.session.complete(request(f.doc)), /Boot manifest tampered/);
  assert.equal(f.driver.frames.filter(a => a.method === 'textDocument/completion').length, 0);
});
test('lease revoked between constructor ownership transfer and start cancels unadmitted owner without leaked phase', async t => {
  const f = fixture(t), launch = f.create(); f.revoke();
  await assert.rejects(launch.session.start(), /Stale production/);
  assert.deepEqual(await launch.session.retire(), { confirmed: true, removed: true, problem: null });
  assert.equal(f.driver.commands.length, 0); assert.equal(f.driver.containers.size, 0);
});
test('Java actual factory publishes pinned offline settings and keeps server27 separate from target21', async t => {
  const f = fixture(t, 'java-maven'), launch = f.create(); await launch.session.start();
  const create = f.driver.commands.find(a => a[0] === 'create')!;
  assert.match(create.at(-1)!, /exec \/opt\/jdk27\/bin\/java/); assert.match(create.at(-1)!, /generatesMetadataFilesAtProjectRoot=false/);
  const boot = JSON.parse(readFileSync(join(f.owned, launch.session.launchId, 'boot/language-launch.json'), 'utf8'));
  const settings = f.driver.frames.find(a => a.method === 'initialize').params.initializationOptions.settings;
  assert.deepEqual(boot.config.settings, settings); assert.equal(settings.java.import.maven.offline.enabled, true);
  assert.equal(settings.java.configuration.runtimes.find((r: any) => r.default).name, 'JavaSE-21');
  assert.match(readFileSync(join(f.owned, launch.session.launchId, 'boot/maven-settings.xml'), 'utf8'), /<offline>true<\/offline>/);
});
