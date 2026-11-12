/** UNIT: genuine installed resolver/producer hashes + actual private filesystem/factory.
 * Docker info/image/tool-probe receipts below are SYNTHETIC, not measured runtime/native proof.
 */
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { createSelectedCacheLanguageFactory, type SelectedLanguageLease } from '../../src/server/language/SelectedCacheLanguageAuthority';
import { LanguageProcessAdmission } from '../../src/server/language/DockerLanguageProcess';
import { DiskLanguageProcessJournal } from '../../src/server/language/LanguageProcessJournal';
import type { LanguageDockerDriver } from '../../src/server/language/DockerLanguageDriver';
import type { LanguageProjectScope } from '../../src/server/language/ports';
import type { RegistrySnapshot } from '../../src/server/language/LanguageFeatureRegistry';
import type { DockerTransport } from '../../src/server/execution/DockerTransport';
import { readRunSourceInventory } from '../../src/server/execution/ImmutableInput';
import { dependencyHash } from '../../scripts/runtime-dependencies.mjs';
import { resolvePreparedToolchainIdentity } from '../../scripts/runtime-prepare.mjs';
import type { ResolvedRuntime } from '../../src/server/runtime-config';
import type { ImageLockEntry, RunProfileV2, RuntimeCatalog, RuntimeProfile } from '../../src/shared/runtime-v2';
import catalogData from '../../runtimes/catalog.json';
import pins from '../../runtimes/production-inputs.lock.json';
import * as codec from '../../src/language/uriCodec';
const hash = (b: string | Buffer) => createHash('sha256').update(b).digest('hex');

import { PassThrough, Writable } from 'node:stream';
import { isDeepStrictEqual as same } from 'node:util';
import { LanguageFeatureRegistry, type RegistryLaunch } from '../../src/server/language/LanguageFeatureRegistry';
import { LanguageAckLedger, type LanguageSaveCommit, type LanguageSaveInput } from '../../src/server/language/LanguageAckLedger';
import type { LanguageAttachment, LanguageCommandResult, LanguageContainerInspection } from '../../src/server/language/DockerLanguageDriver';
import type { CompleteRequest, OpenOrChange } from '../../src/shared/language-v2';
import type { LanguageEvent, VerifiedLanguageAck } from '../../src/server/language/ports';

const result: LanguageCommandResult = { exitCode: 0, stdout: '', stderr: '', truncated: false };
// Only Docker/process IO and preparation admission are FAKE. The factory, complete shadow FS copies,
// boot durability, process journal/admission, framing, session and SAME central codec are production.
class Driver implements LanguageDockerDriver {
  hold = false; pending: {container:string;frame:any}[] = [];
  release() { for (const {container,frame} of this.pending.splice(0)) this.send(container,{jsonrpc:"2.0",id:frame.id,result:[{label:"method",textEdit:{range:{start:frame.params.position,end:frame.params.position},newText:"method"}}]}); }
  commands: string[][] = []; frames: any[] = [];
  containers = new Map<string, LanguageContainerInspection>(); inputs = new Map<string, PassThrough>();
  async engineId() { return 'unit-engine'; }
  async inspect(name: string) { const c = this.containers.get(name) ?? [...this.containers.values()].find(c => c.id === name); return c ? structuredClone(c) : null; }
  async command(args: readonly string[]): Promise<LanguageCommandResult> {
    this.commands.push([...args]);
    if (args[0] === 'create') {
      const name = args[args.indexOf('--name') + 1], labels: Record<string, string> = {};
      args.forEach((v, i) => { if (v === '--label') { const [key, value] = args[i + 1].split('='); labels[key] = value; } });
      this.containers.set(name, { name, labels, id: hash(name), imageId: args[args.indexOf('--entrypoint') + 2],
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
        if (frame.method === 'textDocument/completion' && this.hold) this.pending.push({container:id,frame});
        if (frame.method === 'textDocument/completion' && !this.hold) this.send(id, { jsonrpc: '2.0', id: frame.id, result: [{ label: 'method',
          textEdit: { range: { start: frame.params.position, end: frame.params.position }, newText: 'method' } }] });
        cb();
      } catch (error) { cb(error as Error); }
    } });
    return { input, output, done: new Promise(() => {}), disconnect: () => { input.end(); output.end(); } };
  }
}

const callbacks = { onState: () => {}, onSourceSent: () => {}, onDiagnostics: () => {} };
async function fixture(t: TestContext, family: 'python' | 'java-maven' = 'python', acquisition = true) {
  const root = fs.mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'selected-language-'));
  const clear = (dir: string) => { for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const p = join(dir, e.name); if (e.isDirectory()) clear(p); else if (e.isFile()) fs.chmodSync(p, 0o600); } };
  const cleanup = () => { clear(root); fs.rmSync(root, { recursive: true, force: true }); };
  const workspace = join(root, 'current-project'), prepared = join(root, 'prepared'), owned = join(root, 'owned'), journal = join(root, 'journal');
  for (const p of [workspace, prepared, owned, journal]) fs.mkdirSync(p, { mode: 0o700 });
  const catalog = structuredClone(catalogData) as RuntimeCatalog, profile = catalog.profiles.find(p => p.id === (family === 'python' ? 'python-3.13' : 'java-maven-21'))!;
  const path = family === 'python' ? 'main.py' : 'Main.java';
  fs.writeFileSync(join(workspace, path), 'disk before ACK\r\n'); fs.writeFileSync(join(workspace, 'inactive.txt'), 'inactive'); fs.mkdirSync(join(workspace, 'empty'));
  fs.writeFileSync(join(workspace, family === 'python' ? 'requirements.txt' : 'pom.xml'), family === 'python' ? 'dependency==1\r\n' : '<project/>\r\n');
  const raw = await readRunSourceInventory(workspace), dep = dependencyHash(raw);
  const run: RunProfileV2 = { kind: 'RUN_TESTS', timeoutMs: 1000, task: { workingDirectory: '.', entry: { kind: 'TESTS' }, tests: { paths: family === 'python' ? ['main.py'] : [], names: [] } } };
  const base = family === 'python' ? pins.images.python.reference : pins.images.java21.reference;
  const request = { schemaVersion: 1, key: profile.id, family, workingDirectory: '.', installationId: 'unit-install', outputRoot: prepared,
    imageTag: 'paircoach/runtime-' + profile.id + ':stage09', baseImage: base, nodeImage: pins.images.node.reference,
    project: { root: join(root, 'historical-preparation-root'), files: raw.map(({ path, sha256 }) => ({ path, sha256 })) },
    expectedTools: profile.expectedTools, dependencySha256: dep,
    tools: { root: join(root, 'historical-tools'), files: pins.artifacts.filter(a => a.kind === 'npm').flatMap(a => a.files!.map(f => ({ path: 'node_modules/' + a.name + '/' + f.path, sha256: f.sha256 }))).sort((a,b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0) } };
  const identity = resolvePreparedToolchainIdentity(request), cache = join(prepared, 'cache', family, identity.toolchainHash, dep); fs.mkdirSync(cache, { recursive: true });
  const actualTools = profile.expectedTools.map(t => ({ ...t, raw: t.name + ' ' + t.version + '\n' }));
  const deps = { family, workingDirectory: '.', dependencySha256: dep, tools: actualTools, preparedAt: '2026-11-11T22:00:00Z' };
  const artifacts: Record<string, string | Buffer> = { 'tools.json': JSON.stringify(actualTools), 'dependencies-prepared.json': JSON.stringify(deps),
    ...(family === 'python' ? { 'site-packages/dependency.py': Buffer.from([0,255,10,13,128]) } : { 'effective-pom.xml': '<project/>', 'm2/dependency.jar': Buffer.from([0,255,10,13,128]) }) };
  for (const [p,b] of Object.entries(artifacts)) { fs.mkdirSync(join(cache, p, '..'), { recursive: true }); fs.writeFileSync(join(cache,p), b); }
  const image: ImageLockEntry = { key: profile.imageLockKey, image: request.imageTag, imageId: 'sha256:' + 'a'.repeat(64), digest: 'sha256:' + 'b'.repeat(64), tools: profile.expectedTools };
  const pythonPackages = Object.fromEntries(pins.language.artifacts.filter(a => a.kind === 'language-wheel').map(a => [a.name, a.version]));
  const languageTools = family === 'python' ? [{ name: 'python', version: pins.language.pylsp.pythonVersion }, ...['python-lsp-server','jedi','pyflakes'].map(name => ({ name, version: pythonPackages[name] }))] :
    [{ name: 'java', version: profile.language.serverJvm! }, ...[11,17,21,27].map(r => ({ name: 'target-javac-' + r, version: catalog.profiles.find(p => p.compilerRelease === r)!.expectedTools.find(t => t.name === 'javac')!.version }))];
  const lang: ImageLockEntry = { key: profile.language.imageLockKey!, image: family === 'python' ? 'paircoach/language-pylsp:stage09' : 'paircoach/language-jdt:stage09', imageId: 'sha256:' + 'c'.repeat(64), digest: 'sha256:' + 'd'.repeat(64), tools: languageTools };
  const engine = { ID: 'unit-engine', ServerVersion: '29.7.2', OSType: 'linux', Architecture: 'x86_64' };
  const inspect = (i: ImageLockEntry): any => ({ Id: i.imageId, Os: 'linux', Architecture: 'amd64', Config: { User: '10001:10001', Entrypoint: null }, RepoDigests: [i.image.split(':')[0] + '@' + i.digest] });
  const inspected = inspect(image), inspectedLang = inspect(lang);
  const container = (imageId: string, role: string, suffix: string): any => ({ Id: hash(suffix), State: { Running: false, ExitCode: 0 }, Config: { Image: imageId, Labels: { 'paircoach.installation': role === 'prepare' ? 'unit-install' : 'stage09-runtime-assets', 'paircoach.role': role } } });
  const receipt: any = { schemaVersion: 1, status: 'PREPARED_REQUIRES_OFFLINE_AND_TOOL_VALIDATION', request, engine, imageId: image.imageId, ...identity, imageInspect: inspected,
    observedImage: { Id: image.imageId, RepoDigests: inspected.RepoDigests, Descriptor: null }, container: container(image.imageId, 'prepare', 'prepare'),
    cacheEvidence: { root: cache, tools: { path: 'tools.json', sha256: hash(artifacts['tools.json']), actual: actualTools }, dependencies: { path: 'dependencies-prepared.json', sha256: hash(artifacts['dependencies-prepared.json']), actual: deps } } };
  const probes = family === 'python' ? [{ name: 'python-pylsp-inventory', stdout: JSON.stringify({ python: pins.language.pylsp.pythonVersion, packages: pythonPackages }), stderr: '', inventory: { python: pins.language.pylsp.pythonVersion, packages: pythonPackages } }] : languageTools.map(p => ({ name: p.name === 'java' ? 'jdt-server-java' : p.name, stdout: p.name === 'java' ? '' : 'javac ' + p.version + '\n', stderr: p.name === 'java' ? 'openjdk version "' + p.version + '"\n' : '', version: p.version }));
  const languageReceipt: any = { language: [{ key: lang.key, imageTag: lang.image, engine: structuredClone(engine), observedImage: { Id: lang.imageId, RepoDigests: inspectedLang.RepoDigests, Descriptor: null }, status: 'BUILT_TOOLS_CHECKED_NOT_LSP_FUNCTIONAL_ACCEPTANCE',
    tools: probes.map(p => ({ ...p, name: 'paircoach-stage09-language-' + p.name, container: container(lang.imageId, 'language-tool-probe', p.name), status: 'TOOL_PROBE_PASS_REMOVED' })) }] };
  const languageReceiptPath = join(root, 'language-receipt.json');
  const write = () => { fs.writeFileSync(join(prepared, 'receipt.json'), JSON.stringify(receipt)); fs.writeFileSync(languageReceiptPath, JSON.stringify(languageReceipt)); }; write();
  const runtime: ResolvedRuntime = { configurationGeneration: 'cfg', configPath: join(root, 'config.json'), workspaceRoot: workspace, catalog, profile, image, languageImage: lang, imageLock: { schemaVersion: 1, images: [image, lang] },
    config: { schemaVersion: 1, activeProfile: profile.id, workspaceRoot: workspace, runtimeCatalog: 'catalog.json', imageLock: 'images.lock.json', languageFeatures: { completion: true, diagnostics: true }, execution: { backend: 'docker', pullPolicy: 'never' } } };
  const calls: string[][] = []; let hook: ((args: readonly string[]) => void | Promise<void>) | null = null;
  const transport: DockerTransport = { run: async args => { calls.push([...args]); await hook?.(args); return { exitCode: 0, stderr: '', stdout: JSON.stringify(args[0] === 'info' ? engine : [args[2] === lang.imageId ? inspectedLang : inspected]) }; } };
  const driver = new Driver();
  let acquisitions = 0, acquisitionTail = Promise.resolve();
  const joined = createSelectedCacheLanguageFactory({ ownedRoot: owned, journal: new DiskLanguageProcessJournal(journal), admission: new LanguageProcessAdmission(), driver, transport, preparedOutputRoots: [prepared], languageReceiptPath,
    withSourceLease: !acquisition ? undefined : async (_scope, _snapshot, action) => {

      const prior = acquisitionTail; let release!: () => void;
      acquisitionTail = new Promise<void>(resolve => { release = resolve; }); await prior;
      acquisitions++; assert.equal(held, false, 'Serialized UNIT FIFO grants exclusive access'); held = true;
      const actual = staleAcquisition ? initialLease : makeLease(); leases.push(actual);
      try { await action(actual); } finally { held = false; release(); }

    } });
  const scope: LanguageProjectScope = { projectId: 'p', sessionId: 's', profile, configurationGeneration: 'cfg', providerGeneration: 'provider', shadowGeneration: 'shadow', connectionGeneration: 'connection', shadowDirectory: owned };
  const content = 'obj.\n', document = { stamp: { projectId: 'p', sessionId: 's', profileId: profile.id, path, configurationGeneration: 'cfg', providerGeneration: 'provider', shadowGeneration: 'shadow', connectionGeneration: 'connection', modelLifetime: 'model', localModelVersion: 1, requestGeneration: 1, controlEpoch: 0, baseDocumentVersion: 1, documentVersion: null, contentSha256: codec.contentSha256(content) }, content, reason: 'OPEN' as const };
  let snapshot: RegistrySnapshot = { revision: 'revision1', documents: [document] };
  let held = false, current = true, checks = 0, staleAcquisition = false;
  const leases: SelectedLanguageLease[] = [];
  const makeLease = (): SelectedLanguageLease => {
    const revision = snapshot.revision;
    return { installationId: 'unit-install', runtime, run,
      source: { leaseId: revision, projectRoot: workspace, files: joined.captureSource(workspace).files,
        overlays: snapshot.documents.map(d => ({ stamp: d.stamp, content: d.content })) },
      assertCurrent() { checks++; if (!held || !current || revision !== snapshot.revision) throw Error('Actual serialized lease revoked'); },
      assertRetainedCurrent() { checks++; if (!current || revision !== snapshot.revision) throw Error('Retained full vector revoked'); } };
  };
  const initialLease = makeLease();
  return { ...joined, cleanup, root, owned, workspace, cache, path, document, scope, receipt, driver, calls, leases,
    hook: (value: typeof hook) => { hook = value; },
    get snapshot() { return snapshot; },
    setSnapshot(next: RegistrySnapshot) { assert.equal(held, false); snapshot = next; },
    useStaleAcquisition() { staleAcquisition = true; },
    get checks() { return checks; }, get acquisitions() { return acquisitions; }, get held() { return held; } };
}

const request = (doc: OpenOrChange, requestId: string): CompleteRequest => ({ requestId, stamp: doc.stamp,
  position: { line: 1, column: 5 }, trigger: '.' });
const tick = async () => { for (let i = 0; i < 24; i++) await new Promise<void>(resolve => setImmediate(resolve)); };
async function joined(t: TestContext) {
  const f = await fixture(t), events: LanguageEvent[] = [], launches: RegistryLaunch[] = [], commits = new Map<string, LanguageSaveCommit>();
  const envelopes: { id: string; replyTo: string; type: 'ACK' }[] = [], order: string[] = [];
  let registry!: LanguageFeatureRegistry;
  const ledger = new LanguageAckLedger({
    readCurrent: () => ({ documentMessageId: 'doc', stamp: f.snapshot.documents[0].stamp,
      content: f.snapshot.documents[0].content, projectRevision: f.snapshot.revision,
      dependencyManifestSha256: f.receipt.request.dependencySha256 }),
    readAnalysisSource: (_peer, id) => id === 'doc' ? registry.readSentAnalysisSource(f.document.stamp) : null,
    readCommittedSave: (_request, id) => commits.get(id) ?? null,
  }, codec);
  const tasks: { ms: number; cb: () => void }[] = [];
  registry = new LanguageFeatureRegistry({ ackLedger: ledger,
    authority: { capture: () => f.snapshot, isCurrent: (_scope, snapshot) => same(snapshot, f.snapshot) },
    clock: { set: (ms, cb) => { const task = { ms, cb }; tasks.push(task); return task; },
      clear: h => { const i = tasks.indexOf(h as any); if (i >= 0) tasks.splice(i, 1); } },
    factory: {
      create: (...args) => { const launch = f.factory.create(...args); launches.push(launch); return launch; },
      refreshCompletion: (...args) => f.factory.refreshCompletion(...args),
      bindAckLedger: (...args) => f.factory.bindAckLedger(...args),
      acknowledge: (...args) => f.factory.acknowledge(...args),
      withCaptureLease: (...args) => f.factory.withCaptureLease(...args),
    } });
  t.after(async () => { await registry.disposeProject(f.scope); for (const l of launches) await l.session.retire(); f.cleanup(); });
  const startup = await registry.startProject(f.scope); registry.subscribe(f.scope, event => events.push(event));
  // Explicit scheduling clock only, not a reduced product coalesce/retirement limit.
  await tick(); const task = tasks.find(task => task.ms === 150); assert.ok(task);
  tasks.splice(tasks.indexOf(task), 1); task.cb();
  for (let i = 0; i < 100 && !registry.readSentAnalysisSource(f.document.stamp); i++) await new Promise<void>(resolve => setTimeout(resolve, 25));
  assert.equal(launches.length, 2, JSON.stringify({startup,events,calls:f.calls,acquisitions:f.acquisitions,tasks:tasks.map(t=>t.ms)})); assert.ok(registry.readSentAnalysisSource(f.document.stamp), JSON.stringify(events));
  assert.equal(f.held, false); assert.equal(f.acquisitions, 2);
  ledger.observeDocument('peer', 'doc', f.document);
  const input: LanguageSaveInput = { peerId: 'peer', transactionMessageId: 'save', languageDocumentMessageId: 'doc',
    path: f.path, baseVersion: 1, controlEpoch: 0, content: f.document.content };
  const pending = ledger.beginSave(input); assert.ok(pending);
  const stageCommit = () => {
    const before = f.snapshot.revision;
    fs.writeFileSync(join(f.workspace, f.path), f.document.content);
    const stamp = { ...f.document.stamp, baseDocumentVersion: 2, documentVersion: 2 };
    f.setSnapshot({ revision: 'revision2', documents: [{ ...f.document, stamp }] });
    commits.set('ack', { request: input, saveReceiptId: 'ack', replyTo: 'save', status: 'OK', documentVersion: 2,
      workspaceVersion: 2, committedContent: input.content, beforeProjectRevision: before, afterProjectRevision: f.snapshot.revision });
    order.push('commit');
  };
  const issue = () => { const proof = ledger.commitSave(pending, 'ack'); assert.ok(proof); return proof; };
  const publish = (proof: VerifiedLanguageAck) => {
    const envelope = { id: 'ack', replyTo: 'save', type: 'ACK' as const };
    assert.equal(proof.saveReceiptId, envelope.id); assert.equal(proof.replyTo, envelope.replyTo);
    envelopes.push(envelope); order.push('publish'); registry.acknowledge(proof); order.push('acknowledge');
  };
  return { ...f, registry, ledger, events, launches, envelopes, order, stageCommit, issue, publish,
    get snapshot() { return f.snapshot; }, get acquisitions() { return f.acquisitions; }, get held() { return f.held; },
    async acknowledgeAfterCommit(expectUnrelated = false) {
      let proof!: VerifiedLanguageAck;
      await f.factory.withCaptureLease(f.scope, f.snapshot, () => {
        order.push('prepared-held'); assert.equal(f.held, true);
        proof = issue();
        if (expectUnrelated) assert.throws(() => f.factory.acknowledge(f.scope, f.snapshot, launches[0], proof, ledger), /unrelated production input/);
        publish(proof);
      }); order.push('released'); return proof;
    } };
}

test('selected ACK uses a fresh after-commit held lease before publication: unchanged immutable source and no provider restart/change', async t => {
  const f = await joined(t), original = f.registry.readSentAnalysisSource(f.document.stamp)!;
  const before = await f.registry.complete(request(f.document, 'before'));
  assert.equal(before.items.length, 1); const oldResult = structuredClone(before);
  const commands = f.driver.commands.length, frames = f.driver.frames.length, observers = f.calls.length;
  const unchanged = f.launches.flatMap(l => ['manifest.json', 'boot/language-launch.json'].map(p => {
    const path = join(f.owned, l.session.launchId, p); return { path, bytes: fs.readFileSync(path) };
  }));
  const oldLease = f.leases.at(-1)!;
  f.stageCommit(); const proof = await f.acknowledgeAfterCommit();
  assert.equal(f.acquisitions, 3); assert.ok(f.calls.length >= observers + 6, 'Actual selected Run + separate language image observers reran');
  assert.notEqual(f.leases.at(-1), oldLease); assert.throws(() => oldLease.assertRetainedCurrent(), /revoked/);
  assert.equal(f.leases.at(-1)!.source.leaseId, 'revision2');
  assert.deepEqual(f.order, ['commit', 'prepared-held', 'publish', 'acknowledge', 'released']);
  assert.equal(f.held, false); assert.deepEqual(before, oldResult);
  assert.deepEqual(f.registry.readSentAnalysisSource(f.document.stamp), original);
  for (const file of unchanged) assert.deepEqual(fs.readFileSync(file.path), file.bytes);
  const fresh = await f.registry.complete(request({ ...f.document, stamp: proof.presentation }, 'fresh'));
  assert.equal(fresh.items.length, 1); assert.deepEqual(fresh.stamp, proof.presentation);
  await assert.rejects(f.registry.complete(request(f.document, 'old')));
  assert.equal(f.driver.commands.length, commands);
  assert.equal(f.driver.frames.slice(frames).some(v => /didOpen|didChange|didSave|didClose|initialize/.test(v.method ?? '')), false);
  f.driver.notify(f.launches[1].session.launchId, 'textDocument/publishDiagnostics', { uri: codec.toWorkspaceUri(f.path),
    diagnostics: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } }, severity: 1, message: 'undefined' }] });
  await tick(); const event = f.events.find(e => e.type === 'DIAGNOSTICS'); assert.ok(event && event.type === 'DIAGNOSTICS');
  assert.deepEqual(event.result.sourceStamp, original.sourceStamp); assert.deepEqual(event.result.provenance, original.provenance);
  assert.deepEqual(event.result.presentationStamp, proof.presentation); assert.equal(event.result.association?.saveReceiptId, f.envelopes[0].id);
  assert.equal(fs.readFileSync(join(f.workspace, f.path), 'utf8'), f.document.content);
});

test('selected after-commit reacquisition cannot upgrade an old prewrite lease or publish an alias', async t => {
  const f = await joined(t); f.stageCommit(); f.useStaleAcquisition();
  await assert.rejects(f.acknowledgeAfterCommit(), /lease revoked/);
  assert.equal(f.envelopes.length, 0); assert.deepEqual(f.order, ['commit']);
  await assert.rejects(f.registry.complete(request(f.snapshot.documents[0], 'stale')));
});

test('prepare then release cannot authorize synchronous factory ACK copy; caller must publish+join inside SAME fresh lease', async t => {
  const f = await joined(t); f.stageCommit(); const proof = f.issue();
  await f.factory.withCaptureLease(f.scope, f.snapshot, () => {});
  assert.equal(f.held, false);
  assert.throws(() => f.factory.acknowledge(f.scope, f.snapshot, f.launches[0], proof, f.ledger), /lease revoked/);
  await assert.rejects(f.launches[0].session.complete(request({ ...f.document, stamp: proof.presentation }, 'released')));
  assert.equal(f.envelopes.length, 0);
});

for (const mutation of ['ABA', 'draft', 'unrelated-source', 'inactive-overlay'] as const)
  test(`selected ACK refuses ${mutation} without rewriting original sent source`, async t => {
    const f = await joined(t), original = f.registry.readSentAnalysisSource(f.document.stamp)!;
    f.stageCommit();
    if (mutation === 'unrelated-source') fs.writeFileSync(join(f.workspace, 'inactive.txt'), 'changed unrelated file');
    else if (mutation === 'inactive-overlay') {
      const other = { ...f.document, content: 'inactive draft', stamp: { ...f.document.stamp, path: 'inactive.txt',
        modelLifetime: 'inactive', contentSha256: codec.contentSha256('inactive draft') } };
      f.setSnapshot({ ...f.snapshot, documents: [...f.snapshot.documents, other] });
    } else {
      const current = f.snapshot.documents[0];
      f.setSnapshot({ revision: 'revision3', documents: [{ ...current, stamp: { ...current.stamp,
        localModelVersion: 2, requestGeneration: 2, ...(mutation === 'ABA' ? { modelLifetime: 'new-lifetime' } : {}) } }] });
    }
    if (mutation === 'ABA' || mutation === 'draft') {
      assert.equal(f.ledger.commitSave(f.ledger.beginSave({ peerId: 'peer', transactionMessageId: 'save', languageDocumentMessageId: 'doc',
        path: f.path, baseVersion: 1, controlEpoch: 0, content: f.document.content })!, 'ack'), null);
      assert.equal(f.envelopes.length, 0);
    } else {
      // Issuer authenticates exact saved document, but factory independently refuses other source/overlay changes.
      await f.acknowledgeAfterCommit(true);
      assert.equal(f.envelopes.length, 1, 'Ordinary authentic save ACK is not withheld by LSP failure');
    }
    await assert.rejects(f.registry.complete(request(f.snapshot.documents[0], 'invalid')));
    const retained = f.registry.readSentAnalysisSource(f.document.stamp);
    assert.ok(retained === null || same(retained, original), 'May invalidate archive; must NEVER replace provenance');
  });


test('selected fresh after-commit ACK cancels old pending requests and never rebinds a late completion', async t => {
  const f = await joined(t); f.driver.hold = true;
  const sent = f.registry.complete(request(f.document, 'sent')), rejectedSent = assert.rejects(sent);
  await tick(); assert.equal(f.driver.pending.length, 1);
  const queued = f.registry.complete(request(f.document, 'queued')), rejectedQueued = assert.rejects(queued);
  f.stageCommit(); const proof = await f.acknowledgeAfterCommit(); f.driver.release();
  await Promise.all([rejectedSent, rejectedQueued]);
  assert.ok(f.driver.frames.some(v => v.method === '$/cancelRequest'));
  assert.equal(f.driver.frames.filter(v => v.method === 'textDocument/completion').length, 1);
  f.driver.hold = false;
  assert.equal((await f.registry.complete(request({ ...f.document, stamp: proof.presentation }, 'current'))).items.length, 1);
});
