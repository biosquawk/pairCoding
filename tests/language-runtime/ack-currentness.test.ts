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
import { LanguageFeatureRegistry, type RegistryLaunch, type RegistrySnapshot } from '../../src/server/language/LanguageFeatureRegistry';
import type { AnalysisSource, CompleteRequest, DiagnosticsResult, OpenOrChange } from '../../src/shared/language-v2';
import type { LanguageServerSession } from '../../src/server/language/LanguageServerSession';
import { LanguageAckLedger, type LanguageSaveCommit, type LanguageSaveInput } from '../../src/server/language/LanguageAckLedger';
import type { LanguageEvent } from '../../src/server/language/ports';
import type { LanguageProjectScope } from '../../src/server/language/ports';
import { profile } from '../runtime-contract/fixtures';
const result: LanguageCommandResult = { exitCode: 0, stdout: '', stderr: '', truncated: false };
// Only Docker/process IO and preparation admission are FAKE. The factory, complete shadow FS copies,
// boot durability, process journal/admission, framing, session and SAME central codec are production.
class Driver implements LanguageDockerDriver {
  hold = false; pending: {container:string;frame:any}[] = [];
  release() { for (const {container,frame} of this.pending.splice(0)) this.send(container,{jsonrpc:"2.0",id:frame.id,result:[{label:"method",textEdit:{range:{start:frame.params.position,end:frame.params.position},newText:"method"}}]}); }
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
        if (frame.method === 'textDocument/completion' && this.hold) this.pending.push({container:id,frame});
        if (frame.method === 'textDocument/completion' && !this.hold) this.send(id, { jsonrpc: '2.0', id: frame.id, result: [{ label: 'method',
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
    track(launch:RegistryLaunch) { launches.push(launch); },
    set(next:RegistrySnapshot, nextBinding:ProductionLanguageBinding) { snapshot=next; binding=nextBinding; },
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

const tick = async () => { for(let i=0;i<16;i++) await new Promise<void>(resolve=>setImmediate(resolve)); };
async function joined(t:TestContext) {
  const f=fixture(t), events:LanguageEvent[]=[], commits=new Map<string,LanguageSaveCommit>();
  let registry!:LanguageFeatureRegistry, revision='r1', stamp=f.doc.stamp, dependency=f.binding.prepared.dependencySha256;
  const ledger=new LanguageAckLedger({
    readCurrent:()=>({documentMessageId:'doc',stamp,content:f.snapshot.documents[0].content,projectRevision:revision,dependencyManifestSha256:dependency}),
    readAnalysisSource:(_peer,id)=>id==='doc'?registry.readSentAnalysisSource(f.doc.stamp):null,
    readCommittedSave:(_request,id)=>commits.get(id)??null,
  },codec);
  const launches:RegistryLaunch[]=[], tasks:{ms:number;cb:()=>void}[]=[];
  registry=new LanguageFeatureRegistry({ackLedger:ledger,authority:{capture:()=>f.snapshot,isCurrent:(_scope,s)=>same(s,f.snapshot)},
    clock:{set:(ms,cb)=>{const v={ms,cb};tasks.push(v);return v;},clear:h=>{const i=tasks.indexOf(h as any);if(i>=0)tasks.splice(i,1);}},
    factory:{create:(...args)=>{const l=f.factory.create(...args);f.track(l);launches.push(l);return l;},
      refreshCompletion:(...args)=>f.factory.refreshCompletion(...args),
      ...('bindAckLedger' in f.factory?{bindAckLedger:(ledger:LanguageAckLedger)=>(f.factory as any).bindAckLedger(ledger)}:{}),
      // Keep this test compilable against the BEFORE product too. A missing hook leaves its real stale lease,
      // so the positive fresh request fails instead of passing a fake completion implementation.
      ...('acknowledge' in f.factory?{acknowledge:(...args:any[])=>(f.factory as any).acknowledge(...args)}:{}),
    }});
  t.after(()=>registry.disposeProject(f.project));
  await registry.startProject(f.project); registry.subscribe(f.project,e=>events.push(e)); await tick();
  const task=tasks.find(v=>v.ms===150)!;tasks.splice(tasks.indexOf(task),1);task.cb();await tick();
  assert.equal(launches.length,2);assert.ok(registry.readSentAnalysisSource(f.doc.stamp));
  ledger.observeDocument('peer','doc',f.doc);
  const input:LanguageSaveInput={peerId:'peer',transactionMessageId:'save',languageDocumentMessageId:'doc',path:f.doc.stamp.path,baseVersion:1,controlEpoch:0,content:f.doc.content};
  const pending=ledger.beginSave(input);assert.ok(pending);
  return {...f,registry,ledger,events,launches,
    get snapshot(){return f.snapshot;},get binding(){return f.binding;},
    settle() {
      const before=revision;revision='r2';stamp={...f.doc.stamp,baseDocumentVersion:2,documentVersion:2};
      writeFileSync(join(f.source,stamp.path),f.doc.content);
      const file={path:stamp.path,bytes:Buffer.byteLength(f.doc.content),sha256:sha256(f.doc.content)};
      f.set({revision,documents:[{...f.doc,stamp}]},{...f.binding,source:{...f.binding.source,leaseId:revision,files:[file],overlays:[{stamp,content:f.doc.content}]}});
      commits.set('ack',{request:input,saveReceiptId:'ack',replyTo:'save',status:'OK',documentVersion:2,workspaceVersion:2,committedContent:input.content,beforeProjectRevision:before,afterProjectRevision:revision});
      const proof=ledger.commitSave(pending,'ack');assert.ok(proof);return proof;
    },
    later(kind:'ABA'|'draft'|'dependency'|'revision') {
      revision='r3';if(kind==='draft'||kind==='ABA')stamp={...stamp,localModelVersion:2,requestGeneration:2,...(kind==='ABA'?{modelLifetime:'other'}:{})};
      if(kind==='dependency')dependency='d'.repeat(64);
      f.set({revision,documents:[{...f.doc,stamp}]},{...f.binding,source:{...f.binding.source,leaseId:revision,overlays:[{stamp,content:f.doc.content}]}});
    },
  };
}
const diagnostic=(f:Awaited<ReturnType<typeof joined>>)=>({uri:codec.toWorkspaceUri(f.doc.stamp.path),diagnostics:[{range:{start:{line:0,character:0},end:{line:0,character:3}},severity:1,message:'undefined'}]});
test('genuine ACK joins actual registry/factory/session: immutable diagnostic source, fresh completion presentation, no LSP mutation',async t=>{
  const f=await joined(t), original=f.registry.readSentAnalysisSource(f.doc.stamp)!;
  const sent=await f.registry.complete(request(f.doc,'before'));const immutable=structuredClone(sent);
  const commands=f.driver.commands.length, frames=f.driver.frames.length;
  const fixed=f.launches.map(l=>['manifest.json','boot/language-launch.json'].map(p=>({path:join(f.owned,l.session.launchId,p),bytes:readFileSync(join(f.owned,l.session.launchId,p))}))).flat();
  const proof=f.settle();f.registry.acknowledge(proof);
  assert.deepEqual(sent,immutable);assert.deepEqual(f.registry.readSentAnalysisSource(f.doc.stamp),original);
  for(const file of fixed)assert.deepEqual(readFileSync(file.path),file.bytes);
  const next={...f.doc,stamp:proof.presentation};
  const fresh=await f.registry.complete(request(next,'after'));assert.equal(fresh.items.length,1);assert.deepEqual(fresh.stamp,proof.presentation);
  await assert.rejects(f.registry.complete(request(f.doc,'old-request')));
  assert.equal(f.driver.commands.length,commands);
  assert.equal(f.driver.frames.slice(frames).some(v=>/didOpen|didChange|didSave|didClose|initialize/.test(v.method??'')),false);
  f.driver.notify(f.launches[1].session.launchId,'textDocument/publishDiagnostics',diagnostic(f));await tick();
  const event=f.events.find(e=>e.type==='DIAGNOSTICS');assert.ok(event&&event.type==='DIAGNOSTICS');
  assert.deepEqual(event.result.sourceStamp,original.sourceStamp);assert.deepEqual(event.result.provenance,original.provenance);
  assert.deepEqual(event.result.presentationStamp,proof.presentation);assert.equal(event.result.association?.saveReceiptId,'ack');
});
test('ACK synchronously cancels sent AND pre-registration requests; late response cannot rebind an old request',async t=>{
  const f=await joined(t);f.driver.hold=true;
  const old=f.registry.complete(request(f.doc,'sent'));const rejected=assert.rejects(old);await tick();assert.equal(f.driver.pending.length,1);
  const queued=f.registry.complete(request(f.doc,'queued'));const queuedRejected=assert.rejects(queued);
  const proof=f.settle();f.registry.acknowledge(proof);f.driver.release();await Promise.all([rejected,queuedRejected]);
  assert.equal(f.driver.frames.filter(v=>v.method==='textDocument/completion').length,1);
  assert.ok(f.driver.frames.some(v=>v.method==='$/cancelRequest'));
  f.driver.hold=false;assert.equal((await f.registry.complete(request({...f.doc,stamp:proof.presentation},'fresh'))).items.length,1);
});
for(const kind of ['ABA','draft','dependency','revision'] as const)test(`later ${kind} revokes SAME ACK authority before any fresh completion RPC`,async t=>{
  const f=await joined(t),proof=f.settle();f.registry.acknowledge(proof);f.later(kind);
  assert.equal(f.ledger.isVerified(proof),false);const count=f.driver.frames.filter(v=>v.method==='textDocument/completion').length;
  await assert.rejects(f.registry.complete(request({...f.doc,stamp:proof.presentation},'stale')));
  await assert.rejects(f.launches[0].session.complete(request({...f.doc,stamp:proof.presentation},'direct-stale')));
  assert.equal(f.driver.frames.filter(v=>v.method==='textDocument/completion').length,count);
  assert.equal(f.registry.readAnalysisSource(f.doc.stamp),null);
});
test('copied proof fails closed and cannot mint factory presentation currentness',async t=>{
  const f=await joined(t),proof=f.settle(),copied=structuredClone(proof);
  f.registry.acknowledge(copied);await assert.rejects(f.registry.complete(request({...f.doc,stamp:proof.presentation},'forged')));
  assert.equal(f.events.some(e=>e.type==='DIAGNOSTICS'&&e.result.association!==null),false);
});

test('factory is permanently bound to registry SAME issuer; no foreign ledger rebinding',async t=>{
  const f=await joined(t),proof=f.settle();
  const foreign=new LanguageAckLedger({readCurrent:()=>null,readAnalysisSource:()=>null,readCommittedSave:()=>null},codec);
  assert.throws(()=>f.factory.bindAckLedger(foreign),/already bound/);
  assert.throws(()=>f.factory.acknowledge(f.project,f.snapshot,f.launches[0],proof,foreign),/Unbound/);
  assert.throws(()=>(f.launches[0].session as LanguageServerSession).acknowledgePresentation(proof,foreign),/Unverified/);
  f.registry.acknowledge(proof);assert.equal((await f.registry.complete(request({...f.doc,stamp:proof.presentation},'same-issuer'))).items.length,1);
});
test('duplicate SAME ACK is idempotent and cannot cancel a fresh presentation-bound in-flight request',async t=>{
  const f=await joined(t),proof=f.settle();f.registry.acknowledge(proof);f.driver.hold=true;
  const pending=f.registry.complete(request({...f.doc,stamp:proof.presentation},'fresh-pending'));await tick();
  f.registry.acknowledge(proof);f.driver.release();assert.deepEqual((await pending).stamp,proof.presentation);
  assert.equal(f.driver.frames.some(v=>v.method==='$/cancelRequest'),false);
});
test('genuine proof does not authorize changed selected binding or unrelated raw source inventory',async t=>{
  const f=await joined(t),proof=f.settle();
  writeFileSync(join(f.source,'inactive.py'),'changed');
  f.set(f.snapshot,{...f.binding,source:{...f.binding.source,files:[...f.binding.source.files,{path:'inactive.py',bytes:7,sha256:sha256('changed')}]}});
  assert.throws(()=>f.factory.acknowledge(f.project,f.snapshot,f.launches[0],proof,f.ledger),/unrelated/);
  await assert.rejects(f.launches[0].session.complete(request({...f.doc,stamp:proof.presentation},'wrong-input')));
});
test('actual ACK then model edit retains process, removes presentation alias only at new sent source',async t=>{
  const f=await joined(t),proof=f.settle();f.registry.acknowledge(proof);
  const next={...f.doc,reason:'TYPING' as const,content:'value.\n',stamp:{...proof.presentation,localModelVersion:2,requestGeneration:2,contentSha256:codec.contentSha256('value.\n')}};
  const snapshot={revision:'r3',documents:[next]};f.set(snapshot,{...f.binding,source:{...f.binding.source,leaseId:'r3',overlays:[{stamp:next.stamp,content:next.content}]}});
  await f.registry.change(next);await tick();
  assert.equal((await f.registry.complete(request(next,'edited'))).items.length,1);
  assert.equal(f.driver.commands.filter(a=>a[0]==='create').length,2,'no replacement completion process');
  assert.equal(f.driver.frames.filter(v=>v.method==='textDocument/didChange').length,1);
  assert.equal(f.registry.readSentAnalysisSource(f.doc.stamp),null);
});
test('actual ACK then close uses acknowledged presentation without rewriting original sent source',async t=>{
  const f=await joined(t),proof=f.settle();f.registry.acknowledge(proof);
  const snapshot={revision:'r3',documents:[]};f.set(snapshot,{...f.binding,source:{...f.binding.source,leaseId:'r3',overlays:[]}});
  await f.registry.close(proof.presentation);await tick();
  assert.equal(f.driver.frames.filter(v=>v.method==='textDocument/didClose').length,1);
  assert.equal(f.driver.frames.filter(v=>v.method==='textDocument/didChange').length,0);
});

test('factory rejects wrong after revision and cloned proof, even when all presentation bytes are equal',async t=>{
  const f=await joined(t),proof=f.settle();
  assert.throws(()=>f.factory.acknowledge(f.project,{...f.snapshot,revision:'other'},f.launches[0],proof,f.ledger),/Unbound/);
  assert.throws(()=>f.factory.acknowledge(f.project,f.snapshot,f.launches[0],structuredClone(proof),f.ledger),/Unbound/);
  assert.equal(f.driver.frames.filter(v=>v.method==='textDocument/completion').length,0);
  f.registry.acknowledge(proof);assert.equal((await f.registry.complete(request({...f.doc,stamp:proof.presentation},'verified-exact'))).items.length,1);
});
test('actual retired diagnostic ledger aliases after ACK without resurrecting immutable owner',async t=>{
  const f=await joined(t),original=f.registry.readSentAnalysisSource(f.doc.stamp)!;
  f.driver.notify(f.launches[1].session.launchId,'textDocument/publishDiagnostics',diagnostic(f));await tick();
  const containers=f.driver.containers.size;assert.equal(containers,1);
  const proof=f.settle(),commands=f.driver.commands.length;f.registry.acknowledge(proof);
  assert.equal(f.driver.commands.length,commands);assert.deepEqual(f.registry.readSentAnalysisSource(f.doc.stamp),original);
  const rows=f.events.filter(e=>e.type==='DIAGNOSTICS');assert.equal(rows.length,2);
  const last=rows.at(-1)!;assert.ok(last.type==='DIAGNOSTICS');assert.deepEqual(last.result.sourceStamp,original.sourceStamp);
  assert.deepEqual(last.result.provenance,original.provenance);assert.equal(last.result.association?.saveReceiptId,'ack');
  assert.equal((await f.registry.complete(request({...f.doc,stamp:proof.presentation},'retained'))).items.length,1);
});
