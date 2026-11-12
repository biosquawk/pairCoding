/** NEW nonACK UNIT fixture adapted from the admitted binding fixture (data/transport only).
 * No old test is imported/executed; every implementation is the actual exported product.
 * UNIT fixture. Only Docker/process I/O, preparation observations and backend source/save callbacks
 * are injected. Real selected resolver, scanners, factory, registry, issuer, codec, shadow and journal.
 * Receipts/images/tool outputs here are SYNTHETIC and never actual Docker/host availability evidence.
 */
import assert from 'node:assert/strict';
import type { TestContext } from 'node:test';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { PassThrough, Writable } from 'node:stream';
import { isDeepStrictEqual as same } from 'node:util';
import { tmpdir } from 'node:os';
import { createRuntimeLanguageBinding, type RuntimeLanguageBindingOptions } from '../../src/server/runtime-coordinator/RuntimeLanguageBinding';
import { WorkspaceService } from '../../src/server/WorkspaceService';
import { LanguageShadowStore } from '../../src/server/language/LanguageShadowStore';
import { LanguageProcessAdmission } from '../../src/server/language/DockerLanguageProcess';
import { DiskLanguageProcessJournal } from '../../src/server/language/LanguageProcessJournal';
import type { LanguageDockerDriver, LanguageContainerInspection, LanguageAttachment, LanguageCommandResult } from '../../src/server/language/DockerLanguageDriver';
import type { SelectedLanguageLease } from '../../src/server/language/SelectedCacheLanguageAuthority';
import type { RegistrySnapshot } from '../../src/server/language/LanguageFeatureRegistry';
import type { LanguageSaveInput, LanguageSaveCommit } from '../../src/server/language/LanguageAckLedger';
import type { LanguageProjectScope, LanguageEvent } from '../../src/server/language/ports';
import type { LanguageClientMessage, OpenOrChange, CompleteRequest } from '../../src/shared/language-v2';
import type { RuntimeCatalog, ImageLockEntry, RunProfileV2 } from '../../src/shared/runtime-v2';
import type { ResolvedRuntime } from '../../src/server/runtime-config';
import type { DockerTransport } from '../../src/server/execution/DockerTransport';
import { readRunSourceInventory } from '../../src/server/execution/ImmutableInput';
import { dependencyHash } from '../../scripts/runtime-dependencies.mjs';
import { resolvePreparedToolchainIdentity } from '../../scripts/runtime-prepare.mjs';
import catalogData from '../../runtimes/catalog.json';
import pins from '../../runtimes/production-inputs.lock.json';
import * as codec from '../../src/language/uriCodec';
export { codec };
export const hash = (v: string | Buffer) => createHash('sha256').update(v).digest('hex');
const ok: LanguageCommandResult = { exitCode: 0, stdout: '', stderr: '', truncated: false };
export class UnitDriver implements LanguageDockerDriver {
  observations: string[] = [];
  commands: string[][] = []; frames: any[] = [];
  containers = new Map<string, LanguageContainerInspection>();
  inputs = new Map<string, PassThrough>();
  pending: { id: string; request: any }[] = []; hold = false; unreachable = false; failureMessage = 'UNIT daemon inaccessible';
  beforeCreate: ((args: readonly string[]) => void) | null = null;
  async engineId() { this.observations.push('engine');if (this.unreachable) throw Error(this.failureMessage); return 'binding-unit-engine'; }
  async inspect(name: string) {
    this.observations.push('inspect:'+name);
    if (this.unreachable) throw Error(this.failureMessage);
    const c = this.containers.get(name) ?? [...this.containers.values()].find(c => c.id === name);
    return c ? structuredClone(c) : null;
  }
  async command(args: readonly string[]): Promise<LanguageCommandResult> {
    this.commands.push([...args]);
    if (args[0] === 'create') {
      this.beforeCreate?.(args);
      const name = args[args.indexOf('--name') + 1], labels: Record<string, string> = {};
      args.forEach((v, i) => { if (v === '--label') { const at = args[i+1].indexOf('='); labels[args[i+1].slice(0,at)] = args[i+1].slice(at+1); } });
      this.containers.set(name, { name, id: hash(name), labels, imageId: args[args.indexOf('--entrypoint') + 2], running: false, status: 'created', startedAt: '', exitCode: 0 });
    } else {
      const c = [...this.containers.values()].find(c => c.id === args.at(-1)); assert.ok(c, 'Exact known container only');
      if (args[0] === 'stop') { c.running = false; c.status = 'exited'; }
      else if (args[0] === 'rm') { assert.equal(c.running, false); assert.equal(args.length, 2); this.containers.delete(c.name); }
      else assert.equal(args[0], 'logs');
    }
    return ok;
  }
  send(id: string, value: unknown) { const bytes = Buffer.from(JSON.stringify(value)); this.inputs.get(id)!.write(Buffer.concat([Buffer.from(`Content-Length: ${bytes.length}\r\n\r\n`), bytes])); }
  answer(id: string, request: any) {
    this.send(id, { jsonrpc: '2.0', id: request.id, result: [{ label: 'ownMethod', command: { command: 'evil' },
      textEdit: { uri: 'file:///foreign', range: { start: request.params.position, end: request.params.position }, newText: 'ownMethod' } },
      { label: 'safeMethod', command: { command: 'SENTINEL-evil' }, data: 'SENTINEL-private', textEdit: { range: { start: request.params.position, end: request.params.position }, newText: 'safeMethod' } }] });
  }
  release() { for (const p of this.pending.splice(0)) this.answer(p.id, p.request); }
  diagnostics(path: string) {
    const c = [...this.containers.values()].find(c => c.labels['paircoach.phase'] === 'diagnostics'); assert.ok(c);
    this.send(c.id, { jsonrpc: '2.0', method: 'textDocument/publishDiagnostics', params: { uri: codec.toWorkspaceUri(path), diagnostics: [{
      range: { start: { line: 0, character: 0 }, end: { line: 0, character: 2 } }, severity: 2, message: 'unit warning', code: 'U1' }] } });
  }
  attach(id: string): LanguageAttachment {
    const c = [...this.containers.values()].find(c => c.id === id); assert.ok(c);
    c.running = true; c.status = 'running'; c.startedAt = new Date().toISOString();
    const input = new PassThrough(); this.inputs.set(id, input);
    const output = new Writable({ write: (bytes: Buffer, _encoding, done) => {
      try {
        const request = JSON.parse(bytes.subarray(bytes.indexOf('\r\n\r\n') + 4).toString('utf8')); this.frames.push(request);
        if (request.method === 'initialize') this.send(id, { jsonrpc: '2.0', id: request.id, result: { capabilities: {
          completionProvider: {}, textDocumentSync: { openClose: true, change: 1 }, positionEncoding: 'utf-16' } } });
        if (request.method === 'initialized' && c.labels['paircoach.provider']==='jdt') this.send(id,{jsonrpc:'2.0',method:'language/status',params:{type:'Started',message:'unit semantic import'}});
        if (request.method === 'workspace/executeCommand') this.send(id,{jsonrpc:'2.0',id:request.id,result:['file:///workspace']});
        if (request.method === 'textDocument/completion') { if (this.hold) this.pending.push({ id, request }); else this.answer(id, request); }
        done();
      } catch (error) { done(error as Error); }
    } });
    return { input, output, done: new Promise(() => {}), disconnect: () => { input.end(); output.end(); } };
  }
}
export const tick = async () => { for (let i = 0; i < 12; i++) await new Promise<void>(resolve => setImmediate(resolve)); };
export async function until(check: () => boolean, detail = 'condition') {
  const end = Date.now() + 5000;
  while (!check() && Date.now() < end) await new Promise(resolve => setTimeout(resolve, 10));
  assert.ok(check(), detail);
}
export const complete = (doc: Readonly<OpenOrChange>, requestId = 'completion'): CompleteRequest => ({ requestId, stamp: doc.stamp, position: { line: 1, column: 5 }, trigger: '.' });
export const wire = (type: LanguageClientMessage['type'], payload: LanguageClientMessage['payload'], messageId = 'document'): LanguageClientMessage =>
  ({ protocolVersion: '3.0', sessionId: 'session', clientId: 'wire-client-NOT-peer', messageId, type, payload }) as LanguageClientMessage;
export async function fixture(t: TestContext, family: 'python' | 'java-maven' = 'python') {
  const root = fs.mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'nonack-refresh-'));
  const workspace = join(root, 'workspace'), prepared = join(root, 'preparation'), owned = join(root, 'language'), journalRoot = join(root, 'journal');
  for (const p of [workspace, prepared, owned, journalRoot]) fs.mkdirSync(p, { mode: 0o700 });
  const catalog = structuredClone(catalogData) as RuntimeCatalog;
  const profile = catalog.profiles.find(p => p.id === (family === 'python' ? 'python-3.13' : 'java-maven-21'))!;
  const path = family === 'python' ? 'Kod źródła.py' : 'Kod źródła.java', content = 'obj.\r\n# 😀\r\n';
  fs.writeFileSync(join(workspace, path), 'prior disk\r\n'); fs.writeFileSync(join(workspace, 'inactive.txt'), 'untouched');
  fs.writeFileSync(join(workspace, family === 'python' ? 'requirements.txt' : 'pom.xml'), family === 'python' ? 'fixture==1\r\n' : '<project/>\r\n');
  const inventory = await readRunSourceInventory(workspace), dep = dependencyHash(inventory);
  const run: RunProfileV2 = { kind: 'RUN_TESTS', timeoutMs: 1234, task: { workingDirectory: '.', entry: { kind: 'TESTS' }, tests: { paths: family === 'python' ? [path] : [], names: [] } } };
  const request = { schemaVersion: 1, key: profile.id, family, workingDirectory: '.', installationId: 'binding-unit-install', outputRoot: prepared,
    imageTag: 'paircoach/runtime-' + profile.id + ':stage09', baseImage: family === 'python' ? pins.images.python.reference : pins.images.java21.reference, nodeImage: pins.images.node.reference,
    project: { root: join(root, 'historic-not-current'), files: inventory.map(({path,sha256}) => ({path,sha256})) }, expectedTools: profile.expectedTools, dependencySha256: dep,
    tools: { root: join(root, 'tools-not-mounted'), files: pins.artifacts.filter(a => a.kind === 'npm').flatMap(a => a.files!.map(f => ({path:'node_modules/'+a.name+'/'+f.path,sha256:f.sha256}))).sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0) } };
  const identity = resolvePreparedToolchainIdentity(request), cache = join(prepared, 'cache', family, identity.toolchainHash, dep); fs.mkdirSync(cache,{recursive:true});
  const tools = profile.expectedTools.map(t => ({...t,raw:t.name+' '+t.version+'\n'})), dependencies = {family,workingDirectory:'.',dependencySha256:dep,tools,preparedAt:'2026-11-12T01:00:00Z'};
  const files = { 'tools.json': JSON.stringify(tools), 'dependencies-prepared.json': JSON.stringify(dependencies),
    ...(family === 'python' ? {'site-packages/fixture.py': 'fixture = 1\n'} : {'effective-pom.xml':'<project/>','m2/fixture.jar':'unit binary'}) };
  for (const [path,bytes] of Object.entries(files)) {fs.mkdirSync(join(cache,path,'..'),{recursive:true});fs.writeFileSync(join(cache,path),bytes);}
  const image: ImageLockEntry = {key:profile.imageLockKey,image:request.imageTag,imageId:'sha256:'+'1'.repeat(64),digest:'sha256:'+'2'.repeat(64),tools:profile.expectedTools};
  const packages = Object.fromEntries(pins.language.artifacts.filter(a=>a.kind==='language-wheel').map(a=>[a.name,a.version]));
  const languageTools = family === 'python' ? [{name:'python',version:pins.language.pylsp.pythonVersion},...['python-lsp-server','jedi','pyflakes'].map(name=>({name,version:packages[name]}))] :
    [{name:'java',version:profile.language.serverJvm!},...[11,17,21,27].map(r=>({name:'target-javac-'+r,version:catalog.profiles.find(p=>p.compilerRelease===r)!.expectedTools.find(t=>t.name==='javac')!.version}))];
  const languageImage: ImageLockEntry = {key:profile.language.imageLockKey!,image:'paircoach/language-'+(family==='python'?'pylsp':'jdt')+':stage09',imageId:'sha256:'+'3'.repeat(64),digest:'sha256:'+'4'.repeat(64),tools:languageTools};
  const engine = {ID:'binding-unit-engine',ServerVersion:'29.7.2',OSType:'linux',Architecture:'x86_64'};
  const inspect = (i:ImageLockEntry) => ({Id:i.imageId,Os:'linux',Architecture:'amd64',Config:{User:'10001:10001',Entrypoint:null},RepoDigests:[i.image.split(':')[0]+'@'+i.digest]});
  const container = (imageId:string, role:string, name:string) => ({Id:hash(name),State:{Running:false,ExitCode:0},Config:{Image:imageId,Labels:{'paircoach.installation':role==='prepare'?'binding-unit-install':'stage09-runtime-assets','paircoach.role':role}}});
  const receipt = {schemaVersion:1,status:'PREPARED_REQUIRES_OFFLINE_AND_TOOL_VALIDATION',request,engine,imageId:image.imageId,...identity,imageInspect:inspect(image),observedImage:{Id:image.imageId,RepoDigests:inspect(image).RepoDigests,Descriptor:null},container:container(image.imageId,'prepare','prepare'),
    cacheEvidence:{root:cache,tools:{path:'tools.json',sha256:hash(files['tools.json']),actual:tools},dependencies:{path:'dependencies-prepared.json',sha256:hash(files['dependencies-prepared.json']),actual:dependencies}}};
  fs.writeFileSync(join(prepared,'receipt.json'),JSON.stringify(receipt));
  const probes = family==='python' ? [{name:'python-pylsp-inventory',stdout:JSON.stringify({python:pins.language.pylsp.pythonVersion,packages}),stderr:'',inventory:{python:pins.language.pylsp.pythonVersion,packages}}] :
    languageTools.map(p=>({name:p.name==='java'?'jdt-server-java':p.name,stdout:p.name==='java'?'':'javac '+p.version+'\n',stderr:p.name==='java'?'openjdk version "'+p.version+'"\n':'',version:p.version}));
  const languageReceiptPath=join(root,'language-receipt.json');
  fs.writeFileSync(languageReceiptPath,JSON.stringify({language:[{key:languageImage.key,imageTag:languageImage.image,engine,observedImage:{Id:languageImage.imageId,RepoDigests:inspect(languageImage).RepoDigests,Descriptor:null},status:'BUILT_TOOLS_CHECKED_NOT_LSP_FUNCTIONAL_ACCEPTANCE',tools:probes.map(p=>({...p,name:'paircoach-stage09-language-'+p.name,container:container(languageImage.imageId,'language-tool-probe',p.name),status:'TOOL_PROBE_PASS_REMOVED'}))}]}));
  const runtime: ResolvedRuntime = {configurationGeneration:'configuration',configPath:join(root,'runtime.json'),workspaceRoot:workspace,catalog,profile,image,languageImage,imageLock:{schemaVersion:1,images:[image,languageImage]},
    config:{schemaVersion:1,activeProfile:profile.id,workspaceRoot:workspace,runtimeCatalog:'catalog.json',imageLock:'lock.json',languageFeatures:{completion:true,diagnostics:true},execution:{backend:'docker',pullPolicy:'never'}}};
  const scope: LanguageProjectScope = {projectId:'project',sessionId:'session',profile,configurationGeneration:'configuration',connectionGeneration:'connection',providerGeneration:'provider',shadowGeneration:'shadow',shadowDirectory:owned};
  const document: OpenOrChange = {stamp:{projectId:'project',sessionId:'session',profileId:profile.id,path,configurationGeneration:'configuration',connectionGeneration:'connection',providerGeneration:'provider',shadowGeneration:'shadow',modelLifetime:'model',localModelVersion:3,baseDocumentVersion:1,documentVersion:null,contentSha256:codec.contentSha256(content),controlEpoch:4,requestGeneration:2},content,reason:'OPEN'};
  let snapshot: RegistrySnapshot={revision:'vector-before',documents:[structuredClone(document)]}, held=false, alive=true, peerAlive=true, acquisitions=0;
  let activeLease:SelectedLanguageLease|null=null;const launchLeases=new Map<string,SelectedLanguageLease>();
  const calls:string[][]=[],events:LanguageEvent[]=[],commits=new Map<string,LanguageSaveCommit>(),leases:SelectedLanguageLease[]=[];
  let hook:((args:readonly string[])=>void|Promise<void>)|null=null, releaseEarly=false, observer:((e:LanguageEvent)=>void)|null=null;
  let peerObserver:((message:Readonly<LanguageClientMessage>)=>void)|null=null;
  const driver=new UnitDriver(), admission=new LanguageProcessAdmission(), scanner=new LanguageShadowStore(owned,codec);
  const transport: DockerTransport={run:async args=>{calls.push([...args]);await hook?.(args);return {exitCode:0,stderr:'',stdout:JSON.stringify(args[0]==='info'?engine:[inspect(args[2]===languageImage.imageId?languageImage:image)])};}};
  const lease=():SelectedLanguageLease=>{
    const revision=snapshot.revision;
    const check=()=>{if(!alive||revision!==snapshot.revision)throw Error('UNIT retained full vector revoked');};
    const result:SelectedLanguageLease={installationId:'binding-unit-install',runtime,run,source:{leaseId:revision,projectRoot:workspace,files:scanner.captureSource(workspace).files,overlays:snapshot.documents.map(d=>({stamp:d.stamp,content:d.content}))},
      assertCurrent(){check();if(!held||activeLease!==result)throw Error('UNIT held source lease released');},assertRetainedCurrent:check};leases.push(result);return result;
  };
  // Actual production workspace FIFO, not a Promise imitation of the queue. External source/save
  // authorities and Docker are UNIT-injected; source disk, queue, selected factory and journal are real.
  const fifo=new WorkspaceService(workspace, undefined, {deferObservation:true});
  const underLease=async(action:(token:SelectedLanguageLease)=>Promise<void>)=>fifo._withQueuedMutation(async()=>{
    assert.equal(held,false);held=true;acquisitions++;const token=lease();activeLease=token;
    try {await action(token);for(const id of fs.readdirSync(owned))if(!launchLeases.has(id))launchLeases.set(id,token);if(releaseEarly)throw Error('UNIT lease final release failed');}finally{held=false;activeLease=null;}
  });
  const options:RuntimeLanguageBindingOptions={scope,selected:{ownedRoot:owned,driver,journal:new DiskLanguageProcessJournal(journalRoot),admission,transport,preparedOutputRoots:[prepared],languageReceiptPath,
    withSourceLease:async(_scope,_snapshot,action)=>underLease(action)},
    sourceAuthority:{capture:()=>snapshot,isCurrent:(_scope,s)=>alive&&same(s,snapshot)},
    saveAuthority:{readCurrent:(peer,path)=>{const d=snapshot.documents.find(d=>d.stamp.path===path);return peer==='authenticated-peer'&&d?{documentMessageId:'document',stamp:d.stamp,content:d.content,projectRevision:snapshot.revision,dependencyManifestSha256:dep}:null;},readCommittedSave:(_request,id)=>commits.get(id)??null},
    assertCurrent(){if(!alive)throw Error('UNIT binding authority revoked');},assertPeer(peer,message){if(peer!=='authenticated-peer'||!peerAlive)throw Error('UNIT authenticated peer refused');peerObserver?.(message);},
    emit(event){events.push(structuredClone(event));observer?.(event);}};
  const binding=createRuntimeLanguageBinding(options), bindings=[binding], cleanups:(()=>Promise<void>)[]=[];
  t.after(async()=>{
    driver.unreachable=false;alive=true;hook=null;
    for(const cleanup of cleanups)await cleanup();
    for(const b of bindings)await b.retire();
    assert.equal(driver.containers.size,0,'No injected process owner leaked');
    const writable=(dir:string)=>{for(const e of fs.readdirSync(dir,{withFileTypes:true})){const p=join(dir,e.name);if(e.isDirectory())writable(p);else fs.chmodSync(p,0o600);}};
    fifo.close();writable(root);fs.rmSync(root,{recursive:true,force:true});
  });
  driver.beforeCreate=args=>{const id=args.find(v=>v.startsWith('paircoach.launch='))!.split('=')[1],token=launchLeases.get(id);assert.ok(token,'Actual launch was transferred under a source token');assert.throws(()=>token.assertCurrent(),/held source lease released/,'SAME copy token is released before provider start, even when sibling owns FIFO');};
  const input:LanguageSaveInput={peerId:'authenticated-peer',transactionMessageId:'save',languageDocumentMessageId:'document',path,baseVersion:1,controlEpoch:4,content};
  const stageCommit=()=>{
    const before=snapshot.revision;
    fs.writeFileSync(join(workspace,path),content);
    snapshot={revision:'vector-after',documents:[{...document,stamp:{...document.stamp,baseDocumentVersion:2,documentVersion:2}}]};
    commits.set('save-receipt',{request:structuredClone(input),saveReceiptId:'save-receipt',replyTo:'save',status:'OK',documentVersion:2,workspaceVersion:7,committedContent:content,beforeProjectRevision:before,afterProjectRevision:snapshot.revision});
  };
  return {root,path,workspace,owned,cache,document,driver,events,calls,options,binding,admission,commits,input,leases,stageCommit,underLease,lease,fifo,retainCleanup(fn:()=>Promise<void>){cleanups.push(fn);},
    replace(){const b=createRuntimeLanguageBinding(options);bindings.push(b);return b;},
    get snapshot(){return snapshot;},setSnapshot(value:RegistrySnapshot){snapshot=value;},
    get held(){return held;},get acquisitions(){return acquisitions;},
    setAlive(value:boolean){alive=value;},setPeer(value:boolean){peerAlive=value;},releaseNow(){held=false;},failFinalRelease(){releaseEarly=true;},
    peerHook(value:typeof peerObserver){peerObserver=value;},hook(value:typeof hook){hook=value;},observer(value:typeof observer){observer=value;},
    async start(){await binding.start();await binding.handle('authenticated-peer',wire('LANGUAGE_OPEN',document));await until(()=>driver.frames.filter(f=>f.method==='textDocument/didOpen').length===2,'Both real registry lanes opened');},
    async prepare(){await underLease(token=>binding.prepareSaveAcknowledgement(token));},
  };
}
