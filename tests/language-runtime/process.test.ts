import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync, linkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { DockerLanguageProcess, LanguageProcessAdmission, type DockerLanguageProcessOptions, type PreparedLanguageLaunch } from '../../src/server/language/DockerLanguageProcess';
import { DockerLanguageDriver, type LanguageAttachment, type LanguageCommandResult, type LanguageContainerInspection, type LanguageDockerDriver } from '../../src/server/language/DockerLanguageDriver';
import { DiskLanguageProcessJournal, intentHash, receiptHash, sha256, type LanguageProcessIntent } from '../../src/server/language/LanguageProcessJournal';

const imageId = `sha256:${'a'.repeat(64)}`, cid = 'b'.repeat(64);
const result = (exitCode = 0, stdout = '', stderr = ''): LanguageCommandResult => ({ exitCode, stdout, stderr, truncated: false });
class FakeDocker implements LanguageDockerDriver {
  events: string[] = []; commands: string[][] = []; container: LanguageContainerInspection | null = null;
  engine = 'engine_one'; disconnected = 0; failInspect = false; failEngine = false;
  commandHook?: (args: readonly string[]) => void | LanguageCommandResult | Promise<LanguageCommandResult | void>;
  inspectHook?: () => void;
  attached?: { input: PassThrough; output: PassThrough; finish: (r: LanguageCommandResult) => void };
  beforeCreate?: () => void; beforeAttach?: () => void;
  async engineId(): Promise<string> { this.events.push('engine'); if (this.failEngine) throw new Error('daemon unavailable'); return this.engine; }
  async inspect(): Promise<LanguageContainerInspection | null> {
    this.events.push('inspect'); if (this.failInspect) throw new Error('inspection unavailable'); this.inspectHook?.();
    return this.container ? structuredClone(this.container) : null;
  }
  async command(args: readonly string[]): Promise<LanguageCommandResult> {
    this.events.push(args[0]); this.commands.push([...args]);
    if (args[0] === 'create') {
      this.beforeCreate?.(); const labels: Record<string,string> = {};
      args.forEach((arg, i) => { if (arg === '--label') { const value = args[i+1], p = value.indexOf('='); labels[value.slice(0,p)] = value.slice(p+1); } });
      this.container = { id: cid, name: args[args.indexOf('--name')+1], imageId, labels, running: false, status: 'created', startedAt: '0001-01-01T00:00:00Z', exitCode: 0 };
    }
    const hook = await this.commandHook?.(args); if (hook) return hook;
    if (args[0] === 'stop' && this.container) { this.container.running = false; this.container.status = 'exited'; this.container.exitCode = 137; }
    if (args[0] === 'logs') return result(0, 'container log\n', 'container error\n');
    if (args[0] === 'rm') this.container = null;
    return result();
  }
  attach(): LanguageAttachment {
    this.events.push('attach'); this.beforeAttach?.();
    this.container!.running = true; this.container!.status = 'running'; this.container!.startedAt = '2026-11-11T21:00:00Z';
    const input = new PassThrough(), output = new PassThrough(); let finish!: (r: LanguageCommandResult) => void;
    const done = new Promise<LanguageCommandResult>(r => { finish = r; }); this.attached = { input, output, finish };
    return { input, output, done, disconnect: () => { this.disconnected++; finish(result(137)); input.end(); output.end(); } };
  }
}
function fixture(t: TestContext, admission = new LanguageProcessAdmission()) {
  const root = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'lsp-unit-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const ownedRoot = join(root, 'owned'), receipts = join(root, 'receipts'); mkdirSync(ownedRoot); mkdirSync(receipts);
  const journal = new DiskLanguageProcessJournal(receipts), driver = new FakeDocker();
  const options: DockerLanguageProcessOptions = { ownedRoot, journal, driver, admission };
  function prepare(overrides: Partial<PreparedLanguageLaunch> = {}) {
    const spec: PreparedLanguageLaunch = { launchId: randomUUID(), installationId: 'test_install', engineId: 'engine_one',
      projectId: 'project_żółć', sessionId: 'session', profileId: 'java21', providerGeneration: 'provider',
      configurationGeneration: 'config', shadowGeneration: 'shadow', connectionGeneration: 'connection', phase: 'completion',
      provider: 'jdt', imageId, argv: ['/opt/jdk27/bin/java', '-version'], ...overrides };
    const dir = join(ownedRoot, spec.launchId); mkdirSync(dir);
    for (const name of ['workspace','boot','state']) mkdirSync(join(dir, name));
    const process = DockerLanguageProcess.prepare(spec, options);
    return { process, spec, dir };
  }
  return { root, ownedRoot, receipts, journal, driver, options, prepare };
}

test('real journal + fake Docker: intent/readback before create/start, stop->logs->receipt/readback->nonforce rm', async t => {
  const f = fixture(t), { process: p, spec, dir } = f.prepare();
  writeFileSync(join(dir,'boot','osgi.log'),'early boot error\n'); mkdirSync(join(dir,'state','.metadata'));
  writeFileSync(join(dir,'state','.metadata','.log'),'workspace log\n');
  // An index symlink is not crawled; only .metadata/.log is collected from state.
  symlinkSync('/nonexistent-outside-index',join(dir,'state','.metadata','binary-index'));
  f.driver.beforeCreate = () => { assert.equal(f.journal.readIntent(spec.launchId).launchId,spec.launchId); assert.equal(f.journal.hasStart(spec.launchId,intentHash(p.intent as LanguageProcessIntent)),false); };
  f.driver.beforeAttach = () => assert.equal(f.journal.hasStart(spec.launchId,intentHash(p.intent as LanguageProcessIntent)),true);
  f.driver.commandHook = args => { if(args[0]==='rm') { const receipt=f.journal.readReceipt(spec.launchId)!; assert.equal(receipt.containerId,cid); assert.equal(receipt.exitCode,137); assert.equal(receipt.collection.files.length,4); assert.equal(f.driver.container!.running,false); } };
  const rpc = await p.start(); assert.equal(rpc.closed,false);
  const flags=f.driver.commands[0];
  for(const flag of ['--pull=never','--network=none','--restart=no','--read-only','--cap-drop=ALL','--security-opt=no-new-privileges','--user=10001:10001','--memory=2048m','--cpus=2','--pids-limit=192','--log-opt=max-size=10m','--log-opt=max-file=1']) assert.ok(flags.includes(flag),flag);
  assert.ok(flags.includes(`type=bind,src=${dir}/workspace,dst=/workspace,readonly`));
  assert.equal(flags.filter(x=>x==='--mount').length,3); assert.equal(flags.includes('--privileged'),false);
  assert.deepEqual(await p.retire(),{confirmed:true,removed:true,problem:null}); assert.equal(rpc.closed,true);
  assert.ok(f.driver.events.indexOf('stop')<f.driver.events.indexOf('logs')); assert.ok(f.driver.events.indexOf('logs')<f.driver.events.indexOf('rm'));
  assert.deepEqual(f.driver.commands.at(-1),['rm',cid]); assert.equal(f.driver.container,null);
  assert.equal(f.journal.listIntents().length,1); const receipt=f.journal.readReceipt(spec.launchId)!;
  assert.equal(JSON.parse(readFileSync(join(f.receipts,spec.launchId,'removed.json'),'utf8')).receiptSha256,receiptHash(receipt));
  assert.deepEqual(await p.retire(),{confirmed:true,removed:true,problem:null}); assert.equal(f.driver.commands.filter(x=>x[0]==='rm').length,1);
});
test('independent completion and diagnostics admission; uncertain old process blocks next project/profile on same phase',async t=>{
  const f=fixture(t),old=f.prepare(),diag=f.prepare({phase:'diagnostics'}); await old.process.start();
  // Separate drivers model different containers; share one backend-wide gate.
  const diagDriver=new FakeDocker(), diagProcess=DockerLanguageProcess.prepare(diag.spec,{...f.options,driver:diagDriver}); await diagProcess.start();
  f.driver.failEngine=true; const uncertain=await old.process.retire(); assert.equal(uncertain.confirmed,false); assert.equal(uncertain.removed,false);
  const next=f.prepare({projectId:'different_project',profileId:'python',provider:'pylsp'}); await assert.rejects(next.process.start(),/ownership retained/);
  assert.equal(f.driver.commands.filter(x=>x[0]==='create').length,1);
  assert.equal((await diagProcess.retire()).removed,true); f.driver.failEngine=false; assert.equal((await old.process.retire()).removed,true);
  const later=f.prepare({projectId:'different_project'}); await later.process.start(); assert.equal((await later.process.retire()).removed,true);
});
test('unknown create that actually created reconciles exact ownership, never sends duplicate create',async t=>{
  const f=fixture(t),{process:p}=f.prepare(); f.driver.commandHook=args=>{if(args[0]==='create')throw new Error('CLI lost create response');};
  const [a,b]=await Promise.all([p.start(),p.start()]); assert.equal(a,b); assert.equal(f.driver.commands.filter(x=>x[0]==='create').length,1); assert.equal((await p.retire()).removed,true);
});
test('unknown create and absent readback retains without fake Stop/receipt/new create',async t=>{
  const f=fixture(t),{process:p,spec}=f.prepare(); f.driver.commandHook=args=>{if(args[0]==='create'){f.driver.container=null;throw new Error('unknown create');}};
  await assert.rejects(p.start(),/unknown create/); const retired=await p.retire(); assert.equal(retired.confirmed,false); assert.match(retired.problem!,/absent without/); assert.equal(f.journal.readReceipt(spec.launchId),null);
  await assert.rejects(p.start()); assert.equal(f.driver.commands.filter(x=>x[0]==='create').length,1); assert.equal(f.driver.commands.some(x=>x[0]==='rm'),false);
});
test('stop CLI failure after actual terminal exit is accepted ONLY after inspect',async t=>{
  const f=fixture(t),{process:p}=f.prepare(); await p.start(); f.driver.commandHook=args=>{if(args[0]==='stop'){f.driver.container!.running=false;f.driver.container!.status='exited';f.driver.container!.exitCode=137;throw new Error('lost stop response');}};
  assert.equal((await p.retire()).removed,true);
});
test('successful stop CLI but still running is not Stop, does not collect or remove; same launch retry works',async t=>{
  const f=fixture(t),{process:p}=f.prepare(); await p.start(); f.driver.commandHook=args=>args[0]==='stop'?result():undefined;
  const r=await p.retire();assert.equal(r.confirmed,false);assert.match(r.problem!,/PROCESS_STOP_UNCONFIRMED/);assert.equal(f.driver.commands.some(x=>['logs','rm'].includes(x[0])),false);
  f.driver.commandHook=undefined;assert.equal((await p.retire()).removed,true);
});
test('CLI/transport close rejects RPC but is not Stop proof; actual running container is still stopped',async t=>{
  const f=fixture(t),{process:p}=f.prepare();const rpc=await p.start();f.driver.attached!.finish(result(1));await new Promise(r=>setImmediate(r));assert.equal(rpc.closed,true);assert.equal(f.driver.container!.running,true);
  assert.equal((await p.retire()).removed,true);assert.equal(f.driver.commands.filter(x=>x[0]==='stop').length,1);
});
test('foreign ownership/image/name never receives stop/log/rm',async t=>{
  for(const field of ['label','image','name'] as const){const f=fixture(t),{process:p}=f.prepare();await p.start();
    if(field==='label')f.driver.container!.labels['paircoach.kind']='run';if(field==='image')f.driver.container!.imageId=`sha256:${'c'.repeat(64)}`;if(field==='name')f.driver.container!.name='foreign';
    const r=await p.retire();assert.equal(r.confirmed,false);assert.match(r.problem!,/ownership/);assert.equal(f.driver.commands.some(x=>['stop','logs','rm'].includes(x[0])),false);
    // fixture performs only fake-container cleanup; no real resource was created.
  }
});
test('engine identity conflict prevents all mutations and retains launch',async t=>{
  const f=fixture(t),{process:p}=f.prepare();await p.start();f.driver.engine='other_engine';const r=await p.retire();assert.equal(r.confirmed,false);assert.match(r.problem!,/engine changed/);assert.equal(f.driver.commands.some(x=>x[0]==='stop'),false);
});
test('log collection failure retains stopped container and no receipt/rm; retry collects once successful',async t=>{
  const f=fixture(t),{process:p,spec}=f.prepare();await p.start();f.driver.commandHook=args=>args[0]==='logs'?result(1):undefined;
  const r=await p.retire();assert.equal(r.confirmed,true);assert.equal(r.removed,false);assert.equal(f.journal.readReceipt(spec.launchId),null);assert.equal(f.driver.commands.some(x=>x[0]==='rm'),false);
  f.driver.commandHook=undefined;assert.equal((await p.retire()).removed,true);
});
test('terminal receipt write/readback failure never authorizes rm',async t=>{
  const f=fixture(t),{process:p}=f.prepare();await p.start();const original=f.journal.putReceipt.bind(f.journal);f.journal.putReceipt=()=>{throw new Error('disk full');};
  const r=await p.retire();assert.equal(r.confirmed,true);assert.match(r.problem!,/disk full/);assert.equal(f.driver.commands.some(x=>x[0]==='rm'),false);
  f.journal.putReceipt=original;assert.equal((await p.retire()).removed,true);
});
test('unknown rm reconciles missing by read; failed rm retry uses same durable receipt without recollection',async t=>{
  const f=fixture(t),{process:p}=f.prepare();await p.start();f.driver.commandHook=args=>args[0]==='rm'?result(1):undefined;
  const a=await p.retire();assert.equal(a.confirmed,true);assert.equal(a.removed,false);assert.match(a.problem!,/removal not confirmed/);
  f.driver.commandHook=args=>{if(args[0]==='rm'){f.driver.container=null;throw new Error('lost rm response');}};
  assert.equal((await p.retire()).removed,true);assert.equal(f.driver.commands.filter(x=>x[0]==='logs').length,1);
});
test('startup recovery only retires journal-owned handle, never replays create/start/mutable index',async t=>{
  const f=fixture(t),{process:p,spec}=f.prepare();await p.start();
  // Simulate process restart: new admission, same durable journal + actual fake daemon state, no live old owner.
  const recovered=DockerLanguageProcess.recover(spec.launchId,{...f.options,admission:new LanguageProcessAdmission()});await assert.rejects(recovered.start(),/cannot be restarted/);
  assert.equal((await recovered.retire()).removed,true);assert.equal(f.driver.commands.filter(x=>x[0]==='create').length,1);assert.equal(f.driver.events.filter(x=>x==='attach').length,1);f.driver.attached!.finish(result());
});
test('recovery rejects tampered paths/labels even when intent is readable',async t=>{
  const f=fixture(t),{process:p,spec}=f.prepare();await p.start();const file=join(f.receipts,spec.launchId,'intent.json'),value=JSON.parse(readFileSync(file,'utf8'));value.labels['paircoach.kind']='run';writeFileSync(file,JSON.stringify(value));
  assert.throws(()=>DockerLanguageProcess.recover(spec.launchId,{...f.options,admission:new LanguageProcessAdmission()}),/Invalid restored/);f.driver.attached!.finish(result());
});
test('intent labels/argv are deeply immutable and source-spec mutation cannot change Docker identity',async t=>{
  const f=fixture(t),{process:p,spec}=f.prepare();(spec.argv as string[]).push('--malicious');assert.equal(p.intent.argv.includes('--malicious'),false);assert.throws(()=>{p.intent.labels['paircoach.kind']='run';});await p.start();assert.equal((await p.retire()).removed,true);
});
test('boot artifact symlinks/hardlinks/size overflow fail closed and retain stopped container',async t=>{
  for(const kind of ['symlink','hardlink','oversize'] as const){const f=fixture(t),{process:p,dir}=f.prepare();
    const log=join(dir,'boot','bad.log');if(kind==='symlink')symlinkSync('/etc/passwd',log);if(kind==='hardlink'){const original=join(f.root,'private.log');writeFileSync(original,'private');linkSync(original,log);}if(kind==='oversize')writeFileSync(log,'x'.repeat(1024*1024+1));
    await p.start();const r=await p.retire();assert.equal(r.confirmed,true);assert.equal(r.removed,false);assert.match(r.problem!,/Unsafe|oversize/);assert.equal(f.driver.commands.some(x=>x[0]==='rm'),false);
  }
});
test('bootstrap failure still collects early boot and missing workspace log honestly before remove',async t=>{
  const f=fixture(t),{process:p,dir,spec}=f.prepare();writeFileSync(join(dir,'boot','osgi.log'),'boot failed before initialize');
  const original=f.driver.attach.bind(f.driver);f.driver.attach=()=>{const a=original();f.driver.container!.running=false;f.driver.container!.status='exited';f.driver.container!.exitCode=13;return a;};
  await assert.rejects(p.start(),/bootstrap \(13\)/);assert.equal((await p.retire()).removed,true);const receipt=f.journal.readReceipt(spec.launchId)!;assert.equal(receipt.exitCode,13);assert.deepEqual(receipt.collection.missing,['state/.metadata/.log']);assert.ok(receipt.collection.files.some(x=>x.path==='boot/osgi.log'));
});
test('durable intent failure means no create and no host process',async t=>{
  const f=fixture(t),{process:p}=f.prepare();f.journal.putIntent=()=>{throw new Error('no durable disk');};await assert.rejects(p.start(),/no durable/);assert.equal(f.driver.commands.length,0);
});
test('unsafe host root links and non-owned/bad launcher rejected before Docker',t=>{
  const f=fixture(t),{spec}=f.prepare();symlinkSync(f.ownedRoot,join(f.root,'alias'));assert.throws(()=>DockerLanguageProcess.prepare(spec,{...f.options,ownedRoot:join(f.root,'alias')}),/Unsafe directory/);
  for(const change of [{imageId:'latest'},{argv:['/usr/bin/host-java']},{argv:['sh','bad\0arg']},{launchId:'client_name'},{provider:'builtin' as any}])assert.throws(()=>DockerLanguageProcess.prepare({...spec,...change},f.options));assert.equal(f.driver.commands.length,0);
});
test('corrupt collected artifact blocks receipt reuse and rm after failed prior cleanup',async t=>{
  const f=fixture(t),{process:p,spec}=f.prepare();await p.start();f.driver.commandHook=args=>args[0]==='rm'?result(1):undefined;assert.equal((await p.retire()).removed,false);
  writeFileSync(join(f.receipts,spec.launchId,'stdout.log'),'tampered');f.driver.commandHook=undefined;const count=f.driver.commands.length;const r=await p.retire();assert.equal(r.removed,false);assert.equal(f.driver.commands.length,count);assert.match(r.problem!,/readback|Unsafe/);
});

function fakeChild() {
  const child=Object.assign(new EventEmitter(),{stdin:new PassThrough(),stdout:new PassThrough(),stderr:new PassThrough(),kills:0,kill(){this.kills++;return true;}});
  return child;
}
test('real driver contract: shell false, explicit private Docker config/context, no inherited secrets; bounded output',async t=>{
  const f=fixture(t),calls:any[]=[],children:ReturnType<typeof fakeChild>[]=[];
  const driver=new DockerLanguageDriver({executable:'/trusted/docker',dockerConfigDirectory:f.root,context:'trusted_context',spawn:(exe,args,opts)=>{calls.push({exe,args,opts});const c=fakeChild();children.push(c);return c as any;}});
  const command=driver.command(['info']);children[0].stdout.write('x'.repeat(600*1024));children[0].emit('close',0);const r=await command;assert.equal(r.truncated,true);assert.equal(Buffer.byteLength(r.stdout),512*1024);
  assert.equal(calls[0].opts.shell,false);assert.deepEqual(calls[0].args,['--context','trusted_context','info']);assert.equal(calls[0].opts.env.DOCKER_CONFIG,f.root);
  for(const name of ['HOME','PATH','GEMINI_API_KEY','OPENAI_API_KEY','DOCKER_HOST','DOCKER_CONTEXT'])assert.equal(calls[0].opts.env[name],undefined);
});
test('real driver distinguishes exact absence from daemon/auth/unknown inspection errors',async t=>{
  const f=fixture(t),{process:p}=f.prepare();let reply=result();
  const driver=new DockerLanguageDriver({executable:'/trusted/docker',dockerConfigDirectory:f.root,spawn:()=>{const c=fakeChild();queueMicrotask(()=>{c.stdout.end(reply.stdout);c.stderr.end(reply.stderr);c.emit('close',reply.exitCode);});return c as any;}});
  reply=result(1,'',`Error response from daemon: No such container: ${p.intent.name}\n`);assert.equal(await driver.inspect(p.intent.name),null);
  for(const error of ['Cannot connect to the Docker daemon','permission denied',`No such container: ${p.intent.name} but also unknown`]){reply=result(1,'',error);await assert.rejects(driver.inspect(p.intent.name),/not proof of absence/);}
});
test('real driver timeout rejects boundedly even without child close; CLI kill never reports Stop',async t=>{
  const f=fixture(t),child=fakeChild(),driver=new DockerLanguageDriver({executable:'/trusted/docker',dockerConfigDirectory:f.root,spawn:()=>child as any});
  await assert.rejects(driver.command(['stop','unknown'],5),/outcome unknown/);assert.equal(child.kills,1);child.emit('close',0);
});
test('real driver attach preserves stdout exclusively for RPC, capped stderr and no accidental shell',async t=>{
  const f=fixture(t),{process:p}=f.prepare(),child=fakeChild();let args:string[]=[];
  const driver=new DockerLanguageDriver({executable:'/trusted/docker',dockerConfigDirectory:f.root,spawn:(_e,a,o)=>{args=a;assert.equal(o.shell,false);return child as any;}});
  const attached=driver.attach(p.intent.name);assert.deepEqual(args,['start','--attach','--interactive',p.intent.name]);assert.equal(child.stdout.listenerCount('data'),0);
  child.stderr.write('z'.repeat(600*1024));child.emit('close',1);const done=await attached.done;assert.equal(done.exitCode,1);assert.equal(done.truncated,true);assert.equal(done.stderr.length,512*1024);attached.disconnect();assert.equal(child.kills,1);
});

test('replacement container with same labels/name/image but different ID is never stopped',async t=>{
  const f=fixture(t),{process:p}=f.prepare();await p.start();f.driver.container!.id='c'.repeat(64);
  const r=await p.retire();assert.equal(r.confirmed,false);assert.match(r.problem!,/ownership/);assert.equal(f.driver.commands.some(x=>['stop','logs','rm'].includes(x[0])),false);
});
test('recover can Stop owned container even if shadow disappeared; missing logs retain stopped container',async t=>{
  const f=fixture(t),{process:p,spec,dir}=f.prepare();await p.start();rmSync(join(dir,'boot'),{recursive:true});
  const recovered=DockerLanguageProcess.recover(spec.launchId,{...f.options,admission:new LanguageProcessAdmission()});const r=await recovered.retire();
  assert.equal(r.confirmed,true);assert.equal(r.removed,false);assert.equal(f.driver.container!.running,false);assert.equal(f.driver.commands.some(x=>x[0]==='rm'),false);f.driver.attached!.finish(result());
});
test('receipt root overlapping container bind rejected before daemon mutation',t=>{
  const f=fixture(t),{spec,dir}=f.prepare();const journal=new DiskLanguageProcessJournal(join(dir,'boot'));
  assert.throws(()=>DockerLanguageProcess.prepare(spec,{...f.options,journal}),/isolated/);assert.equal(f.driver.commands.length,0);
});
test('mounted directory replaced by symlink during async admission is rejected before create',async t=>{
  const f=fixture(t),{process:p,dir}=f.prepare();f.driver.inspectHook=()=>{f.driver.inspectHook=undefined;rmSync(join(dir,'boot'),{recursive:true});symlinkSync(f.root,join(dir,'boot'));};
  await assert.rejects(p.start(),/Unsafe directory/);assert.equal(f.driver.commands.length,0);
});
test('retire requested during startup never yields a live request authority or races rm before start settles',async t=>{
  const f=fixture(t),{process:p}=f.prepare();const start=p.start(),rejected=assert.rejects(start,/retired while starting/);const retire=p.retire();
  await rejected;assert.equal((await retire).removed,true);assert.equal(p.transport!.closed,true);await assert.rejects(p.start(),/cannot be restarted/);
});

test('unobserved start intent on still-created container cannot be mistaken for terminal Stop',async t=>{
  const f=fixture(t),{process:p,spec}=f.prepare();const intent=p.intent as LanguageProcessIntent;f.journal.putIntent(intent);f.journal.markStart(spec.launchId,intentHash(intent),cid);
  f.driver.container={id:cid,name:intent.name,imageId,labels:{...intent.labels},running:false,status:'created',startedAt:'0001-01-01T00:00:00Z',exitCode:0};
  const recovered=DockerLanguageProcess.recover(spec.launchId,f.options),r=await recovered.retire();assert.equal(r.confirmed,false);assert.match(r.problem!,/PROCESS_STOP_UNCONFIRMED/);assert.equal(f.driver.commands.length,0);
});
test('retirement enforces absolute10s even if daemon read never returns; no subsequent mutation',async t=>{
  const f=fixture(t),{process:p}=f.prepare();await p.start();f.driver.engineId=()=>new Promise(()=>{});
  t.mock.timers.enable({apis:['setTimeout','Date']});const pending=p.retire();await new Promise(r=>setImmediate(r));
  t.mock.timers.tick(10000);const r=await pending;assert.equal(r.confirmed,false);assert.equal(r.removed,false);assert.match(r.problem!,/deadline/);assert.equal(f.driver.commands.some(x=>x[0]==='stop'),false);t.mock.timers.reset();f.driver.attached!.finish(result());
});
test('throwing transport observer cannot crash editing or discard actual-container ownership',async t=>{
  const f=fixture(t),{spec}=f.prepare();const p=DockerLanguageProcess.prepare(spec,{...f.options,onTransportClosed:()=>{throw new Error('observer failed');}});
  await p.start();assert.doesNotThrow(()=>p.transport!.close(new Error('transport failed')));assert.equal(f.driver.container!.running,true);assert.equal((await p.retire()).removed,true);
});

// Production constructor joining found a pre-start cancellation could otherwise claim a lane and
// demand a journal for a container it had NEVER admitted or touched.
test('never-admitted retirement has no daemon/journal/phase side effects and permanently revokes start',async t=>{
  const f=fixture(t),unused=f.prepare();
  assert.deepEqual(await unused.process.retire(),{confirmed:true,removed:true,problem:null});
  assert.deepEqual(f.driver.events,[]);assert.deepEqual(f.journal.listIntents(),[]);
  await assert.rejects(unused.process.start(),/cannot be restarted/);
  const next=f.prepare();await next.process.start();assert.equal((await next.process.retire()).removed,true);
});
test('failed phase claim retirement cannot acquire/release/touch the retained incumbent',async t=>{
  const f=fixture(t),old=f.prepare();await old.process.start();
  const next=f.prepare();await assert.rejects(next.process.start(),/ownership retained/);
  const commands=f.driver.commands.length;
  assert.deepEqual(await next.process.retire(),{confirmed:true,removed:true,problem:null});
  assert.equal(f.driver.commands.length,commands);assert.equal(f.driver.container!.running,true);
  assert.equal((await old.process.retire()).removed,true);
  assert.deepEqual(await next.process.retire(),{confirmed:true,removed:true,problem:null});
  const later=f.prepare();await later.process.start();assert.equal((await later.process.retire()).removed,true);
});
