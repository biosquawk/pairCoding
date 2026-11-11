/** Operator-only bounded proof. Importing this module never spawns or touches Docker.
 * Uses installed production registry/factory/resolver/session/driver, NOT the historical A–B spike.
 * Harness owns immutable fixture snapshots + FIFO only; this is NOT actual backend/WriteGate proof.
 */
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Transform } from 'node:stream';
import { isDeepStrictEqual as same } from 'node:util';
import * as codec from '../../src/language/uriCodec';
import { DockerLanguageDriver, type LanguageDockerDriver } from '../../src/server/language/DockerLanguageDriver';
import { DockerCliTransport } from '../../src/server/execution/DockerTransport';
import { LanguageFeatureRegistry, type RegistryLaunch, type RegistrySnapshot } from '../../src/server/language/LanguageFeatureRegistry';
import { createSelectedCacheLanguageFactory, type SelectedLanguageLease } from '../../src/server/language/SelectedCacheLanguageAuthority';
import { LanguageShadowStore, type ShadowFile, type ShadowManifest } from '../../src/server/language/LanguageShadowStore';
import { LanguageProcessAdmission } from '../../src/server/language/DockerLanguageProcess';
import { DiskLanguageProcessJournal, assertRealDirectory, readRegular, sha256 } from '../../src/server/language/LanguageProcessJournal';
import { LanguageAckLedger } from '../../src/server/language/LanguageAckLedger';
import { loadRuntimeConfiguration } from '../../src/server/runtime-config';
import { validateTaskForProfile } from '../../src/shared/validation-v2';
import type { LanguageProjectScope, LanguageEvent } from '../../src/server/language/ports';
import type { CompleteResult, DiagnosticsResult, OpenOrChange } from '../../src/shared/language-v2';
import type { RunProfileV2 } from '../../src/shared/runtime-v2';

export const PROOF_BUDGET = Object.freeze({ activeMs: 180000, stageMs: 30000, retirementMs: 10000,
  cases: 3, maxContainers: 9, simultaneous: 2, transcriptBytes: 8 * 1024 * 1024 });
export const MISSING = 'PAIRCOACH_MISSING_IMPORT_PROBE';
export interface ImportCase {
  id: 'java21' | 'java27' | 'python313'; profileId: 'java-maven-21' | 'java-maven-27' | 'python-3.13';
  configPath: string; sourceRoot: string; sourceFiles: ShadowFile[]; run: RunProfileV2;
  document: { path: string; bad: string; good: string; completion: { line: number; column: number; identifier: string } };
  /** Reviewed actual prepared artifact, outside JDK/server environment, used by BOTH overlay variants. */
  dependency: { path: string; sha256: string; importLine: string };
}
export interface ImportPlan {
  schemaVersion: 1; policy: 'PRODUCTION_IMPORT_ONLY_NO_PREPARE'; sourceRevision: string;
  expectedEngineId: string; dockerExecutable: string; evidenceRoot: string;
  preparedOutputRoots: string[]; languageReceiptPath: string;
  /** Exact cfg/catalog/lock/receipt files; complete referenced set checked before ANY Docker access. */
  frozenInputs: { path: string; sha256: string }[];
  cases: ImportCase[];
}
const absolute = (p: unknown): p is string => typeof p === 'string' && isAbsolute(p) && resolve(p) === p && !/[\x00-\x1f\x7f,]/.test(p);
const hex = (s: unknown): s is string => typeof s === 'string' && /^[a-f0-9]{64}$/.test(s);
const contained = (a: string,b: string): boolean => { const p = relative(a,b); return !p || !isAbsolute(p) && p !== '..' && !p.startsWith('..' + sep); };
const disjoint = (a:string,b:string): void => assert.ok(!contained(a,b) && !contained(b,a), 'Input/evidence roots must be disjoint');
export function validateImportPlan(value: unknown): asserts value is ImportPlan {
  const p = value as ImportPlan;
  assert.equal(p?.schemaVersion, 1); assert.equal(p.policy, 'PRODUCTION_IMPORT_ONLY_NO_PREPARE');
  assert.match(p.sourceRevision, /^[a-f0-9]{40}$/); assert.match(p.expectedEngineId, /^[A-Za-z0-9:_.-]{1,200}$/);
  assert.ok(absolute(p.evidenceRoot) && absolute(p.dockerExecutable) && absolute(p.languageReceiptPath));
  assert.ok(Array.isArray(p.preparedOutputRoots) && p.preparedOutputRoots.length > 0 && p.preparedOutputRoots.length <= 12);
  assert.equal(new Set(p.preparedOutputRoots).size, p.preparedOutputRoots.length);
  for (const root of p.preparedOutputRoots) { assert.ok(absolute(root)); disjoint(root,p.evidenceRoot); }
  assert.ok(Array.isArray(p.frozenInputs) && p.frozenInputs.length > 0 && p.frozenInputs.length <= 64);
  assert.equal(new Set(p.frozenInputs.map(f => f.path)).size,p.frozenInputs.length);
  for (const f of p.frozenInputs) { assert.ok(absolute(f.path) && hex(f.sha256)); disjoint(dirname(f.path),p.evidenceRoot); }
  assert.ok(Array.isArray(p.cases)); assert.equal(p.cases.length,3);
  assert.deepEqual(p.cases.map(c => [c.id,c.profileId]), [['java21','java-maven-21'],['java27','java-maven-27'],['python313','python-3.13']]);
  for (const c of p.cases) {
    assert.ok(absolute(c.configPath) && absolute(c.sourceRoot)); disjoint(c.sourceRoot,p.evidenceRoot);
    for (const root of p.preparedOutputRoots) disjoint(c.sourceRoot,root);
    assert.ok(Array.isArray(c.sourceFiles) && c.sourceFiles.length > 0 && c.sourceFiles.length <= 16000);
    assert.equal(new Set(c.sourceFiles.map(f => f.path)).size,c.sourceFiles.length);
    for (const f of c.sourceFiles) { codec.assertRelativePath(f.path); assert.ok(hex(f.sha256) && Number.isSafeInteger(f.bytes) && f.bytes >= 0); }
    codec.assertRelativePath(c.document.path); assert.ok(c.sourceFiles.some(f => f.path === c.document.path));
    const d = c.document;
    for (const content of [d.bad,d.good]) { assert.equal(typeof content,'string'); assert.ok(content.length > 0 && content.length <= 1024*1024); assert.equal(codec.normalizeContent(content),content); }
    assert.equal(d.bad.split(MISSING).length,2); assert.equal(d.good.includes(MISSING),false); assert.notEqual(d.bad,d.good);
    assert.match(d.completion.identifier,/^[A-Za-z_][A-Za-z_0-9]{2,79}$/);
    for (const content of [d.bad,d.good]) {
      const line = content.split('\n')[d.completion.line-1];
      assert.ok(line && Number.isSafeInteger(d.completion.column) && d.completion.column >= 1 && d.completion.column <= line.length+1);
      assert.ok(content.split('\n').includes(c.dependency.importLine), 'Exact reviewed nonstandard dependency import required');
    }
    codec.assertRelativePath(c.dependency.path); assert.ok(hex(c.dependency.sha256));
    assert.ok(c.id === 'python313' ? c.dependency.path.startsWith('site-packages/') : c.dependency.path.startsWith('m2/') && c.dependency.path.endsWith('.jar'));
    assert.ok(c.dependency.importLine.length > 0 && !/[\r\n]/.test(c.dependency.importLine));
  }
}
/** No stale invalidation-empty, warning-only marker, unrelated path or truncated evidence is success. */
export function diagnosticMatches(result: DiagnosticsResult, document: OpenOrChange,
  expected: 'error' | 'clear', priorLaunch: string | null = null): boolean {
  if (!same(result.sourceStamp,document.stamp) || !same(result.presentationStamp,document.stamp) || result.association !== null || result.truncated ||
    result.provenance.kind !== 'IMMUTABLE_GENERATION' || result.provenance.launchId === priorLaunch) return false;
  if (result.items.some(d => !d.message.includes(MISSING) && /non-project|class.?path|syntax errors? only|cannot (?:be )?resolve|import.+(?:could not|not found)/i.test(d.message))) return false;
  if (expected === 'clear') return result.items.length === 0;
  const line = document.content.split('\n').findIndex(l => l.includes(MISSING)) + 1;
  return result.items.some(d => d.severity === 'ERROR' && d.message.includes(MISSING) && d.range.startLine === line);
}
export function completionMatches(result: CompleteResult, doc: OpenOrChange, identifier: string): boolean {
  return same(result.stamp,doc.stamp) && result.items.some(i => {
    // Match inserted identifier, not an unrelated label/doc string or an empty lexical list.
    const first = i.primary.text.match(/^[A-Za-z_][A-Za-z_0-9]*/)?.[0];
    return i.primary.path === doc.stamp.path && first === identifier;
  });
}
/** Passive bounded transcript parser, never sends/answers RPC and never grants session authority.
 * Avoids polling the provider's completion endpoint while JDT is still importing.
 */
export class PassiveImportTrace {
  private buffers = {client:Buffer.alloc(0),server:Buffer.alloc(0)};
  private requests = new Map<string,string>();
  private contents = new Map<string,string>();
  private initialized = false;
  private imported = false;
  invalid = false;
  constructor(private readonly projectUri:string) {}
  observe(direction:'client'|'server',chunk:Buffer):void {
    if(this.invalid) return;
    try {
      let b=Buffer.concat([this.buffers[direction],chunk]);
      const max=direction==='client'?8*1024*1024:256*1024;
      assert.ok(b.length<=max+8192);
      while(b.length) {
        const end=b.indexOf('\r\n\r\n'); if(end<0) {assert.ok(b.length<=8192);break;}
        const headers=b.subarray(0,end).toString('ascii').split('\r\n');
        const length=headers.filter(h=>/^Content-Length:/i.test(h));assert.equal(length.length,1);
        assert.match(length[0],/^Content-Length: [0-9]+$/i);const n=Number(length[0].split(':')[1]);
        assert.ok(Number.isSafeInteger(n)&&n>0&&n<=max);if(b.length<end+4+n) break;
        const frame=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(b.subarray(end+4,end+4+n)));
        b=b.subarray(end+4+n);
        if(direction==='client') {
          if(frame.method==='initialize') this.requests.set(String(frame.id),'initialize');
          if(frame.method==='workspace/executeCommand'&&frame.params?.command==='java.project.getAll') this.requests.set(String(frame.id),'import');
          if(frame.method==='textDocument/didOpen') this.contents.set(frame.params.textDocument.uri,codec.contentSha256(frame.params.textDocument.text));
          if(frame.method==='textDocument/didChange') {
            assert.equal(frame.params.contentChanges.length,1);assert.equal(frame.params.contentChanges[0].range,undefined);
            this.contents.set(frame.params.textDocument.uri,codec.contentSha256(frame.params.contentChanges[0].text));
          }
        } else {
          const request=this.requests.get(String(frame.id));
          if(request) {this.requests.delete(String(frame.id));assert.equal(frame.error,undefined);
            if(request==='initialize') {assert.ok(frame.result?.capabilities);this.initialized=true;}
            else {assert.ok(Array.isArray(frame.result)&&frame.result.some((uri:unknown)=>uri===this.projectUri||uri===this.projectUri+'/'));this.imported=true;}
          }
        }
      }
      this.buffers[direction]=Buffer.from(b);
    } catch {this.invalid=true;}
  }
  ready(doc:OpenOrChange,java:boolean):boolean {
    return !this.invalid&&this.initialized&&(!java||this.imported)&&this.contents.get(codec.toWorkspaceUri(doc.stamp.path))===doc.stamp.contentSha256;
  }
}
/** Proof-only raw before/after inventory. No exclusions, symlink following, truncation or authority. */
export function rawDependencyInventory(root:string):ShadowFile[] {
  assertRealDirectory(root);const files:ShadowFile[]=[];let total=0,entries=0;
  const walk=(dir:string,prefix:string,depth:number):void=>{
    assert.ok(depth<=32);assertRealDirectory(dir);const handle=fs.opendirSync(dir),names:string[]=[];
    try{let e;while((e=handle.readSync())){assert.ok(++entries<=16000);names.push(e.name);}}finally{handle.closeSync();}
    for(const name of names.sort()){
      const file=join(dir,name),path=prefix?prefix+'/'+name:name;codec.assertRelativePath(path);
      const stat=fs.lstatSync(file);assert.equal(stat.isSymbolicLink(),false);
      if(stat.isDirectory())walk(file,path,depth+1);
      else{assert.ok(stat.isFile());const b=readRegular(file,64*1024*1024);total+=b.length;assert.ok(total<=256*1024*1024);files.push({path,bytes:b.length,sha256:sha256(b)});}
    }
  };walk(root,'',0);return files.sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0);
}
function durable(file: string,value: unknown): void {
  const bytes = Buffer.from(JSON.stringify(value,null,2) + '\n'), fd = fs.openSync(file,'wx',0o600);
  try { fs.writeFileSync(fd,bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  assert.deepEqual(readRegular(file,bytes.length),bytes);
  const dir = fs.openSync(dirname(file),'r'); try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
}
function append(file: string,value: unknown): void {
  const fd = fs.openSync(file,'a',0o600); try { fs.writeFileSync(fd,JSON.stringify(value)+'\n'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
function frozenInputs(p: ImportPlan): () => void {
  const expected = new Set<string>([p.languageReceiptPath,...p.preparedOutputRoots.map(r => join(r,'receipt.json'))]);
  for (const c of p.cases) {
    const b = dirname(c.configPath), cfg = JSON.parse(readRegular(c.configPath,4*1024*1024).toString('utf8'));
    expected.add(c.configPath); expected.add(resolve(b,cfg.runtimeCatalog)); expected.add(resolve(b,cfg.imageLock));
  }
  assert.deepEqual([...expected].sort(),p.frozenInputs.map(f=>f.path).sort(), 'Freeze exactly ALL referenced config/catalog/lock/receipt bytes');
  const assertCurrent = () => { for (const f of p.frozenInputs) assert.equal(sha256(readRegular(f.path,16*1024*1024)),f.sha256,'Frozen input changed'); };
  assertCurrent(); return assertCurrent;
}
export function preflightImportPlan(p: ImportPlan, repository: string): void {
  validateImportPlan(p); assert.equal(process.platform,'linux','WSL/Linux-only harness; no native Windows claim');
  assertRealDirectory(repository); disjoint(repository,p.evidenceRoot);
  const git = (args: string[]) => execFileSync('git',args,{cwd:repository,encoding:'utf8',env:{ PATH:process.env.PATH },maxBuffer:1024*1024}).trim();
  assert.equal(git(['rev-parse','HEAD']),p.sourceRevision); assert.equal(git(['status','--porcelain','--untracked-files=all']), '','Frozen evaluated source must be clean');
  assert.equal(fs.existsSync(p.evidenceRoot),false,'No overwrite/retry/new-root after UNKNOWN'); assertRealDirectory(dirname(p.evidenceRoot));
  frozenInputs(p);
  // Scanner is production; no privileged client-provided inventory admission.
  for (const c of p.cases) {
    const capture = new LanguageShadowStore(repository,codec).captureSource(c.sourceRoot);
    assert.deepEqual(capture.files,c.sourceFiles); capture.assertCurrent();
    const cfg = loadRuntimeConfiguration({configPath:c.configPath, environment:{PAIRCOACH_RUNTIME_PROFILE:c.profileId}, explicitWorkspaceRoot:c.sourceRoot});
    assert.ok(cfg.resolved,JSON.stringify(cfg.problem)); assert.ok(validateTaskForProfile(cfg.resolved.profile,c.run));
    assert.ok(cfg.resolved.languageImage && cfg.resolved.config.languageFeatures.completion && cfg.resolved.config.languageFeatures.diagnostics);
  }
}

/** Sole live entry: preflight completed before creating config/evidence or constructing real CLI drivers.
 * No build/pull/prepare/host Java/Python, no ad-hoc rm, no cleanup of original resources.
 */
export async function runProductionImportProof(p: ImportPlan, repository: string): Promise<void> {
  preflightImportPlan(p,repository);
  fs.mkdirSync(p.evidenceRoot,{mode:0o700});
  const config = join(p.evidenceRoot,'empty-docker-config'); fs.mkdirSync(config,{mode:0o700});
  const journalRoot = join(p.evidenceRoot,'journal'); fs.mkdirSync(journalRoot,{mode:0o700});
  durable(join(p.evidenceRoot,'admitted-plan.json'),p);
  const inputCurrent = frozenInputs(p), admission = new LanguageProcessAdmission();
  const journal = new DiskLanguageProcessJournal(journalRoot), raw = new DockerLanguageDriver({executable:p.dockerExecutable,dockerConfigDirectory:config,host:'unix:///var/run/docker.sock'});
  const cli = new DockerCliTransport(p.dockerExecutable,{DOCKER_CONFIG:config,DOCKER_HOST:'unix:///var/run/docker.sock'});
  let transcriptBytes = 0, overflow = false, creates = 0;
  const commands = join(p.evidenceRoot,'docker-commands.jsonl');
  const traces=new Map<string,PassiveImportTrace>(), ids=new Map<string,string>(), projectUris=new Map<string,string>();
  const credentialFree = () => { assertRealDirectory(config); assert.deepEqual(fs.readdirSync(config),[],'No arbitrary metadata/credential config admission'); };
  const driver: LanguageDockerDriver = {
    engineId: async () => {credentialFree();const id=await raw.engineId();append(commands,{kind:'engine',id});assert.equal(id,p.expectedEngineId);return id;},
    inspect: async name => {credentialFree();const inspected=await raw.inspect(name);append(commands,{kind:'inspect',name,inspected});
      if(inspected) ids.set(inspected.id,inspected.labels['paircoach.launch']);return inspected;},
    command: async (args,ms) => {
      credentialFree(); if (args[0] === 'create') assert.ok(++creates <= PROOF_BUDGET.maxContainers);
      append(commands,{at:new Date().toISOString(),kind:'command',args});
      try { const result = await raw.command(args,ms); append(commands,{at:new Date().toISOString(),kind:'result',args,result}); return result; }
      catch (e) { append(commands,{kind:'UNKNOWN',args,error:String(e)}); throw e; }
    },
    attach: name => {
      credentialFree(); const launchId=ids.get(name);assert.ok(launchId&&projectUris.has(launchId));
      const trace=new PassiveImportTrace(projectUris.get(launchId)!);traces.set(launchId,trace);
      append(commands,{kind:'attach',name,launchId});const attached = raw.attach(name);
      const tap = (direction:'client'|'server') => new Transform({transform(chunk,enc,cb) {
        const bytes = Buffer.from(chunk); trace.observe(direction,bytes);transcriptBytes += bytes.length;
        if (transcriptBytes > PROOF_BUDGET.transcriptBytes) overflow = true;
        else append(join(p.evidenceRoot,'rpc-wire.jsonl'),{name,direction,at:new Date().toISOString(),bytes:bytes.toString('base64')});
        cb(null,bytes); // Passive lossless tee; NEVER filters or rewrites real frames.
      }});
      const incoming = tap('server'), outgoing = tap('client');
      attached.input.on('error',e=>incoming.destroy(e));attached.output.on('error',e=>outgoing.destroy(e)); outgoing.on('error',()=>{}); incoming.on('error',()=>{});
      attached.input.pipe(incoming); outgoing.pipe(attached.output);
      return {...attached,input:incoming,output:outgoing};
    },
  };
  const transport = { run: async (...args: Parameters<DockerCliTransport['run']>) => {
    append(commands,{kind:'observer',args});
    const result = await cli.run(...args); append(commands,{kind:'observer-result',args,result}); return result;
  }};
  const sourceGuards=p.cases.map(c=>new LanguageShadowStore(repository,codec).captureSource(c.sourceRoot));
  const dependencyGuards=new Map<string,readonly ShadowFile[]>();
  const report: any = { schemaVersion:1,sourceRevision:p.sourceRevision,platform:process.platform,startedUTC:new Date().toISOString(),
    status:'RUNNING',cases:[],limits:PROOF_BUDGET,notProven:['backend/WriteGate/HTTP','rename','selected-javac preview oracle','GUI/Monaco/AI','native Windows','fullF/whole9'],full5a:'FAIL_UNCHANGED',jdt21:'OPEN_UNCHANGED' };
  let activeRegistry: LanguageFeatureRegistry | null = null, activeScope: LanguageProjectScope | null = null;
  let revoked = false; const deadline = Date.now()+PROOF_BUDGET.activeMs;
  const check = () => { assert.ok(!revoked && Date.now() < deadline,'Aggregate active deadline/revocation'); assert.equal(overflow,false,'Bounded transcript exceeded');assert.ok([...traces.values()].every(t=>!t.invalid),'Malformed passive transcript');inputCurrent(); };
  const until = async <T>(read:()=>T|null,label:string):Promise<T> => {
    const end = Math.min(deadline,Date.now()+PROOF_BUDGET.stageMs);
    while(Date.now()<end) { check(); const value=read(); if(value!==null) return value; await new Promise(r=>setTimeout(r,25)); }
    throw Error('Bounded stage failed: '+label);
  };
  try {
    assert.equal(await raw.engineId(),p.expectedEngineId);
    for (const c of p.cases) {
      check(); const owned = join(p.evidenceRoot,c.id); fs.mkdirSync(owned,{mode:0o700});
      const loaded = loadRuntimeConfiguration({configPath:c.configPath,environment:{PAIRCOACH_RUNTIME_PROFILE:c.profileId},explicitWorkspaceRoot:c.sourceRoot});
      assert.ok(loaded.resolved); const runtime = loaded.resolved, generation = randomUUID();
      const scope: LanguageProjectScope = {projectId:c.id,sessionId:generation,profile:runtime.profile,configurationGeneration:runtime.configurationGeneration,
        providerGeneration:randomUUID(),shadowGeneration:randomUUID(),connectionGeneration:randomUUID(),shadowDirectory:owned};
      const document = (content:string,version:number):OpenOrChange => ({reason:version===1?'OPEN':'TYPING',content,stamp:{projectId:scope.projectId,
        sessionId:scope.sessionId,profileId:c.profileId,configurationGeneration:scope.configurationGeneration,providerGeneration:scope.providerGeneration,
        shadowGeneration:scope.shadowGeneration,connectionGeneration:scope.connectionGeneration,path:c.document.path,modelLifetime:generation,
        localModelVersion:version,requestGeneration:version,controlEpoch:0,baseDocumentVersion:1,documentVersion:null,contentSha256:codec.contentSha256(content)}});
      const bad=document(c.document.bad,1), good=document(c.document.good,2);
      let snapshot:RegistrySnapshot={revision:randomUUID(),documents:[bad]}, held=false, heldToken:symbol|null=null, tail=Promise.resolve();
      const events:LanguageEvent[]=[], launches:RegistryLaunch[]=[];
      const source = new LanguageShadowStore(owned,codec).captureSource(c.sourceRoot); assert.deepEqual(source.files,c.sourceFiles);
      const current = (s:RegistrySnapshot) => { check(); source.assertCurrent(); assert.deepEqual(snapshot,s); };
      const joined = createSelectedCacheLanguageFactory({ownedRoot:owned,driver,journal,admission,transport,
        preparedOutputRoots:p.preparedOutputRoots,languageReceiptPath:p.languageReceiptPath,
        withSourceLease: async (asked,s,action) => {
          const prior=tail; let release!:()=>void; tail=new Promise(r=>{release=r;}); await prior;
          try {
            assert.equal(held,false); held=true;const token=Symbol('actual harness FIFO grant');heldToken=token;assert.deepEqual(asked,scope);current(s);
            const lease:SelectedLanguageLease={installationId:'bounded-import-'+generation,runtime,run:c.run,
              source:{leaseId:s.revision,projectRoot:c.sourceRoot,files:source.files,overlays:s.documents.map(d=>({stamp:d.stamp,content:d.content}))},
              assertCurrent(){assert.equal(held,true);assert.equal(heldToken,token);current(s);},assertRetainedCurrent(){current(s);}};
            await action(lease); current(s);
            const dependency=joined.authority.capture(asked,s).source.dependencies!;
            const priorFiles=dependencyGuards.get(dependency.root);
            if(priorFiles)assert.deepEqual(dependency.files,priorFiles);
            else dependencyGuards.set(dependency.root,structuredClone(dependency.files));
            assert.deepEqual(rawDependencyInventory(dependency.root),dependency.files);
          } finally {held=false;heldToken=null;release();}
        }});
      // Actual issuer required by registry; no saves/ACKs are fabricated in this import-only experiment.
      const ackLedger = new LanguageAckLedger({readCurrent:()=>null,readAnalysisSource:()=>null,readCommittedSave:()=>null},codec);
      const registry = new LanguageFeatureRegistry({ackLedger,authority:{capture:()=>snapshot,isCurrent:(_scope,s)=>{try{current(s);return true;}catch{return false;}}},factory:{
        bindAckLedger:l=>joined.factory.bindAckLedger(l),acknowledge:(...a)=>joined.factory.acknowledge(...a),
        withCaptureLease:(...a)=>joined.factory.withCaptureLease(...a),refreshCompletion:(...a)=>joined.factory.refreshCompletion(...a),
        create:(...args)=>{assert.ok(launches.length<3,'No implicit provider restart/retry');const launch=joined.factory.create(...args);launches.push(launch);
          projectUris.set(launch.session.launchId,c.run.task.workingDirectory==='.'?'file:///workspace':codec.toWorkspaceUri(c.run.task.workingDirectory));return launch;}}});
      activeRegistry=registry;activeScope=scope;
      await registry.startProject(scope); registry.subscribe(scope,e=>{events.push(e);append(join(owned,'events.jsonl'),e);});
      const diagnostic = (doc:OpenOrChange,kind:'error'|'clear',prior:string|null) => events.flatMap(e=>e.type==='DIAGNOSTICS'?[e.result]:[])
        .find(r=>diagnosticMatches(r,doc,kind,prior))??null;
      const first=await until(()=>diagnostic(bad,'error',null),'real dependency-backed marker');
      const completionOwner=await until(()=>launches.find(l=>l.generation===null)??null,'completion owner');
      const before=await completionWithoutRetry(registry,completionOwner,bad,c.document.completion,traces,c.id!=='python313',until);
      const oldLaunch=first.provenance.kind==='IMMUTABLE_GENERATION'?first.provenance.launchId:null; assert.ok(oldLaunch);
      const oldManifest=readRegular(launches.find(l=>l.session.launchId===oldLaunch)!.generation!.wholeProjectManifestPath,8*1024*1024);
      // Harness-owned FIFO updates its complete immutable overlay vector. No disk save/ACK/coordinator claim.
      await tail; assert.equal(held,false); snapshot={revision:randomUUID(),documents:[good]}; await registry.change(good);
      const second=await until(()=>diagnostic(good,'clear',oldLaunch),'NEW immutable analysed empty diagnostics');
      const after=await completionWithoutRetry(registry,completionOwner,good,c.document.completion,traces,c.id!=='python313',until);
      assert.equal(launches.length,3); assert.equal(launches.filter(l=>l.generation===null).length,1);
      assert.deepEqual(readRegular(launches.find(l=>l.session.launchId===oldLaunch)!.generation!.wholeProjectManifestPath,8*1024*1024),oldManifest);
      for(const launch of launches) {
        const manifest=JSON.parse(readRegular(join(owned,launch.session.launchId,'manifest.json'),8*1024*1024).toString('utf8')) as ShadowManifest;
        assert.ok(manifest.files.some(f=>f.origin==='dependency'&&f.path==='.paircoach-dependencies/'+c.dependency.path&&f.sha256===c.dependency.sha256),'Exact measured dependency must be copied into EVERY launch');
      }
      const disposal=await registry.disposeProject(scope); assert.equal(disposal.confirmed,true,'Uncertain Stop blocks all next cases');
      for(const l of launches) { assert.ok(journal.readReceipt(l.session.launchId)); assert.ok(fs.existsSync(join(journalRoot,l.session.launchId,'removed.json'))); }
      source.assertCurrent();inputCurrent();
      report.cases.push({id:c.id,status:'PASS_IMPORT_SUBSET_ONLY',first,second,before,after,launches:launches.map(l=>l.session.launchId)});
      activeRegistry=null;activeScope=null;
    }
    check();for(const source of sourceGuards)source.assertCurrent();
    for(const [root,files]of dependencyGuards)assert.deepEqual(rawDependencyInventory(root),files);
    report.status='PASS_BOUNDED_PRODUCTION_IMPORT_ONLY';
  } catch(error) { report.status='FAIL';report.problem=String(error);throw error; }
  finally {
    revoked=true; // Revoke late async captures BEFORE final disposal. Never launch the next case on uncertainty.
    if(activeRegistry&&activeScope) {
      try {const disposal=await activeRegistry.disposeProject(activeScope);report.finalDisposal=disposal;
        if(!disposal.confirmed) report.status='FAIL_RETAINED_OWNER';}
      catch(error) {report.status='FAIL_RETAINED_OWNER';report.cleanupProblem=String(error);}
    }
    try{inputCurrent();for(const source of sourceGuards)source.assertCurrent();for(const [root,files]of dependencyGuards)assert.deepEqual(rawDependencyInventory(root),files);report.originalInputsUnchanged=true;}
    catch(error){report.status='FAIL_ORIGINAL_INPUT_CHANGED';report.originalInputProblem=String(error);}
    report.creates=creates;report.transcriptBytes=transcriptBytes;report.finishedUTC=new Date().toISOString();
    durable(join(p.evidenceRoot,'receipt.json'),report);
  }
}
async function completionWithoutRetry(registry:LanguageFeatureRegistry,launch:RegistryLaunch,doc:OpenOrChange,
  expected:ImportCase['document']['completion'],traces:Map<string,PassiveImportTrace>,java:boolean,until:<T>(read:()=>T|null,label:string)=>Promise<T>):Promise<CompleteResult> {
  // Poll passive exact real sent bytes + initialize/getAll response only, no extra RPCs/retries.
  // Production session independently validates currentness/import; trace is NOT readiness authority.
  await until(()=>traces.get(launch.session.launchId)?.ready(doc,java)?true:null,'completion exact sent bytes + real semantic import');
  const result=await registry.complete({requestId:randomUUID(),stamp:doc.stamp,position:{line:expected.line,column:expected.column},trigger:null});
  assert.ok(completionMatches(result,doc,expected.identifier),'Exact dependency completion missing (no retry)');return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [mode,planPath,expectedHash,...extra]=process.argv.slice(2);
  assert.ok(['--check-plan','--execute-reviewed-plan'].includes(mode)&&absolute(planPath)&&hex(expectedHash)&&extra.length===0,
    'Usage: node --import tsx tests/language-runtime/real-import-harness.ts --check-plan|--execute-reviewed-plan ABS_PLAN SHA256');
  const bytes=readRegular(planPath,1024*1024);assert.equal(sha256(bytes),expectedHash);const plan=JSON.parse(bytes.toString('utf8'));validateImportPlan(plan);
  const repo=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
  if(mode==='--check-plan') {preflightImportPlan(plan,repo);process.stdout.write('PASS_PLAN_PREFLIGHT_ONLY_NO_DOCKER\n');}
  else await runProductionImportProof(plan,repo);
}
