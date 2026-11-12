/** Transport/process regression + injected daemon state. NOT live Docker/Windows acceptance. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { parseArguments, buildPublicPreparePlan } from '../../scripts/runtime-prepare-cli.mjs';
import { spawnPrepareCommand } from '../../scripts/runtime-prepare-control.mjs';
import { stopOwnedPreparation } from '../../scripts/runtime-prepare.mjs';
import { stageInputs } from '../../scripts/runtime-stage-inputs.mjs';
const repo = process.cwd();
const root = t => { const p = fs.mkdtempSync(path.join(process.env.TMPDIR, 'cancel-')); t.after(() => fs.rmSync(p, { recursive: true, force: true })); return p; };
const args = p => ['--project', path.join(p,'project'), '--profile','javascript-node','--output',path.join(p,'output')];
function project(p) {
  const dest=path.join(p,'project'); fs.cpSync(path.join(repo,'examples/javascript-counter'),dest,{recursive:true});
  fs.mkdirSync(path.join(dest,'.paircoach'),{mode:0o700});
  const task=JSON.parse(fs.readFileSync(path.join(dest,'task.v2.json')));
  fs.writeFileSync(path.join(dest,'.paircoach/settings.json'),JSON.stringify({schemaVersion:2,taskFilePath:null,taskMode:'IMPLEMENTATION',reviewNotesPath:'notes.md',aiConsent:false,contextPatterns:[],runProfiles:task.runProfiles}),{mode:0o600});
}
const delay = ms => new Promise(r => setTimeout(r,ms));
async function waitFile(p, child) { for(let n=0;n<200;n++){ if(fs.existsSync(p))return; if(child.exitCode!==null)throw Error('child exited before marker');await delay(25); } throw Error('marker not reached'); }

test('prepare timeout is explicit, strict and independent of task timeout; plan remains read-only',async t=>{
  const p=root(t);project(p);const a=args(p);
  assert.equal(parseArguments([...a,'--prepare-timeout-ms','60000']).prepareTimeoutMs,60000);
  for(const v of ['0','999','86400001','1e4','1.5','-1',' 1000','01000'])assert.throws(()=>parseArguments([...a,'--prepare-timeout-ms',v]));
  assert.throws(()=>parseArguments([...a,'--prepare-timeout-ms','1000','--prepare-timeout-ms','2000']));
  const before=fs.readFileSync(path.join(p,'project/.paircoach/settings.json'));
  const plan=await buildPublicPreparePlan([...a,'--prepare-timeout-ms','60000']);
  assert.equal(plan.limits.maxElapsedMs,60000);assert.equal(plan.limits.maxCommandMs,480000);
  assert.deepEqual(plan.settings.runProfiles.map(p=>p.timeoutMs),JSON.parse(before).runProfiles.map(p=>p.timeoutMs));
  assert.equal(fs.existsSync(path.join(p,'output')),false);
});

test('responsive transport captures real output and cancels an actual stubborn CLI process, not unrelated sentinel',async t=>{
  const p=root(t), marker=path.join(p,'started'), c=new AbortController(), events=[];
  const sentinel=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});t.after(()=>sentinel.kill());
  const run=spawnPrepareCommand(process.execPath,['-e',`process.on('SIGTERM',()=>{});process.stdout.write('download/build in progress\\n',()=>require('node:fs').writeFileSync(${JSON.stringify(marker)},String(process.pid)));setInterval(()=>{},1000)`],{env:{PATH:process.env.PATH},timeout:10000,maxBuffer:4*1024*1024},{signal:c.signal,onProgress:e=>events.push(e)});
  await waitFile(marker,sentinel);const pid=Number(fs.readFileSync(marker));c.abort('UNIT user cancellation');
  const raw=await run;assert.match(raw.error.message,/cancellation/);assert.match(raw.stdout,/in progress/);assert.ok(events.some(e=>e.phase==='docker-stdout'));
  assert.throws(()=>process.kill(pid,0),/ESRCH/);assert.equal(sentinel.exitCode,null);
});

test('prepare command timeout is an unknown interrupted operation, never exit0 success',async()=>{
  const raw=await spawnPrepareCommand(process.execPath,['-e','setInterval(()=>{},1000)'],{env:{PATH:process.env.PATH},timeout:100,maxBuffer:4096});
  assert.equal(raw.timedOut,true);assert.match(raw.error.message,/timeout/);assert.notEqual(raw.status,0);
});

test('download cancellation reaches fetch signal and leaves failed durable staging, not prepared output',async t=>{
  const p=root(t),c=new AbortController();let reached;
  const started=new Promise(r=>reached=r);
  const pending=stageInputs(path.join(p,'assets'),{signal:c.signal,fetcher:async(url,options)=>{
    reached();return new Promise((resolve,reject)=>{options.signal.addEventListener('abort',()=>reject(new Error('UNIT download cancelled')),{once:true});});
  }});
  await started;c.abort();await assert.rejects(pending,/cancelled/);
  const receipt=JSON.parse(fs.readFileSync(path.join(p,'assets/download-journal/receipt.json')));assert.equal(receipt.status,'FAILED_NOT_PREPARED_RETAIN');
});

function cancellationFixture(){
  const id='c'.repeat(64),image='sha256:'+'d'.repeat(64), request={installationId:'public-unit',key:'javascript-node',family:'node',outputRoot:'/private/output',project:{root:'/private/input'},dependencySha256:'dep'};
  const receipt={createdContainerId:id,containerName:'paircoach-public-unit-prepare-javascript-node',imageId:image,toolchainHash:'tools'};
  const container={Id:id,Name:'/'+receipt.containerName,Config:{Image:image,Labels:{'paircoach.installation':request.installationId,'paircoach.role':'prepare'}},State:{Running:true},Mounts:[{Type:'bind',Source:request.project.root,Destination:'/input',RW:false},{Type:'bind',Source:path.join(request.outputRoot,'cache/node/tools/dep'),Destination:'/cache/0',RW:true}]};
  return {request,receipt,container};
}
test('cancel kills only exact returned owned container ID, readbacks stopped and retains resources',()=>{
  const f=cancellationFixture(),calls=[];let saves=0;
  stopOwnedPreparation(f.request,f.receipt,args=>{calls.push(args);if(args[0]==='kill')f.container.State.Running=false;return {stdout:JSON.stringify([f.container])};},()=>saves++);
  assert.deepEqual(calls.map(c=>c[0]),['inspect','kill','inspect']);assert.equal(calls[1][2],f.container.Id);assert.equal(f.receipt.cancellation.status,'STOPPED_RETAINED');assert.equal(saves,3);
});
test('foreign/unknown cancellation identities and changed mount never authorize stop',()=>{
  for(const mutate of [f=>delete f.receipt.createdContainerId,f=>f.container.Id='f'.repeat(64),f=>f.container.Name='/foreign',f=>f.container.Config.Image='foreign',f=>f.container.Config.Labels['paircoach.installation']='foreign',f=>f.container.Mounts[0].RW=true,f=>f.container.Mounts[1].Source='/foreign']){
    const f=cancellationFixture();mutate(f);const writes=[];
    assert.throws(()=>stopOwnedPreparation(f.request,f.receipt,args=>{if(args[0]!=='inspect')writes.push(args);return{stdout:JSON.stringify([f.container])};},()=>{}));assert.deepEqual(writes,[]);
  }
});

for (const stop of ['Ctrl+C','timeout']) test('public CLI '+stop+' interrupts blocked actual transport and durably records cancellation without publishing config',async t=>{
  if(process.platform==='win32'){t.skip('POSIX fake executable; native Windows remains NOT_RUN');return;}
  const p=root(t);project(p);const bin=path.join(p,'bin');fs.mkdirSync(bin,{mode:0o700});const marker=path.join(p,'docker-pid');
  fs.writeFileSync(path.join(bin,'docker'),`#!${process.execPath}\nprocess.stderr.write('UNIT fake daemon stalled\\n',()=>require('node:fs').writeFileSync(${JSON.stringify(marker)},String(process.pid)));setInterval(()=>{},1000);`,{mode:0o700});
  const child=spawn(process.execPath,['scripts/runtime-prepare-cli.mjs',...args(p),'--execute','--prepare-timeout-ms',stop==='timeout'?'3000':'60000'],{cwd:repo,env:{...process.env,PATH:bin+path.delimiter+process.env.PATH},stdio:['ignore','pipe','pipe']});
  t.after(()=>{if(child.exitCode===null)child.kill('SIGKILL');});let stderr='',stdout='';child.stderr.on('data',b=>stderr+=b);child.stdout.on('data',b=>stdout+=b);
  const ended=new Promise(resolve=>child.on('close',code=>resolve(code)));
  await waitFile(marker,child);if(stop==='Ctrl+C')child.kill('SIGINT');assert.equal(await ended,1);assert.equal(stdout,'');assert.match(stderr,/cancelling/);assert.match(stderr,/UNIT fake daemon stalled/);const terminal=JSON.parse(stderr.trim().split('\n').at(-1));assert.equal(terminal.status,'CANCELLED_RETAIN_AND_RECONCILE');assert.match(terminal.problem,stop==='timeout'?/PREPARE_TIMEOUT/:/PREPARE_CANCELLED/);
  const receipt=JSON.parse(fs.readFileSync(path.join(p,'output/receipt.json')));assert.equal(receipt.status,'CANCELLED_RETAIN_AND_RECONCILE');assert.equal(receipt.commands.length,1);assert.ok(receipt.commands[0].error);assert.equal(fs.existsSync(path.join(p,'output/runtime-config.json')),false);
  assert.throws(()=>process.kill(Number(fs.readFileSync(marker)),0),/ESRCH/);
});

// Actual public -> actual producer and ownership guards, only Docker daemon is injected.
import { fixture as installation, dockerModel, engine } from '../runtime-image-retention/fixture.mjs';
for (const scenario of ['owned','foreign','engine-drift']) test('public producer cancellation readback: '+scenario,async t=>{
  const f=await installation(t),m=dockerModel();m.nameDerived=true;
  const project=f.project('project'),output=path.join(f.root,'output');
  const plan=await f.cli.buildPublicPreparePlan(['--project',project,'--profile','javascript-node','--output',output]);
  let cancelled=false,container,cleanup=[];
  const spawnSync=(exe,argv,options)=>{
    const a=argv.slice(4);
    if(options.prepareCleanup){
      cleanup.push(a);
      if(a[0]==='info'&&scenario==='engine-drift')return{status:0,signal:null,stdout:JSON.stringify({...engine,ID:'foreign-engine'}),stderr:''};
      if(a[0]==='inspect')return{status:0,signal:null,stdout:JSON.stringify([container]),stderr:''};
      if(a[0]==='kill'){container.State.Running=false;return{status:0,signal:null,stdout:container.Id,stderr:''};}
    }
    if(a[0]==='start'){
      cancelled=true;container.State.Running=true;
      if(scenario==='foreign')container.Config.Labels['paircoach.installation']='foreign';
      return{status:null,signal:'SIGTERM',error:{message:'UNIT cancel during attached preparation'},stdout:'',stderr:''};
    }
    const raw=m.spawn(exe,argv,options);
    if(a[0]==='create'){
      container=[...m.containers.values()].at(-1);container.Name='/'+a[a.indexOf('--name')+1];
      container.Mounts=a.filter(v=>v.startsWith('type=bind,source=')).map(v=>({Type:'bind',Source:v.split('source=')[1].split(',')[0],Destination:v.split('target=')[1].split(',')[0],RW:!v.endsWith(',readonly')}));
    }
    return raw;
  };
  await assert.rejects(f.cli.executePublicPreparePlan(plan,{stageInputs:f.stage,spawnSync,control:{cancelled:()=>cancelled,progress:()=>{}}}),/Preparation operation failed/);
  const leaf=JSON.parse(fs.readFileSync(path.join(plan.preparedRuntime,'receipt.json'))),outer=JSON.parse(fs.readFileSync(path.join(output,'receipt.json')));
  assert.equal(leaf.status,'CANCELLED_RETAIN_AND_RECONCILE');assert.equal(outer.status,'CANCELLED_RETAIN_AND_RECONCILE');assert.equal(fs.existsSync(plan.runtimeConfig),false);assert.equal(m.calls.some(c=>c[0]==='rm'),false);
  if(scenario==='owned'){assert.equal(leaf.cancellation.status,'STOPPED_RETAINED');assert.equal(container.State.Running,false);assert.equal(cleanup.filter(a=>a[0]==='kill').length,1);}
  else{assert.equal(leaf.cancellation.status,'UNKNOWN_RETAIN_AND_RECONCILE');assert.equal(cleanup.some(a=>a[0]==='kill'),false);}
});

test('cancel immediately before publication never publishes runtime config after otherwise valid producer evidence',async t=>{
  const f=await installation(t),m=dockerModel();m.nameDerived=true;const project=f.project('project'),output=path.join(f.root,'output');
  const plan=await f.cli.buildPublicPreparePlan(['--project',project,'--profile','javascript-node','--output',output]);let cancelled=false;
  await assert.rejects(f.cli.executePublicPreparePlan(plan,{stageInputs:f.stage,spawnSync:m.spawn,control:{cancelled:()=>cancelled,progress:()=>{},commit:()=>{cancelled=true;throw new Error('UNIT cancellation at publication fence');}}}),/publication fence/);
  assert.equal(fs.existsSync(plan.runtimeConfig),false);assert.equal(JSON.parse(fs.readFileSync(path.join(output,'receipt.json'))).status,'CANCELLED_RETAIN_AND_RECONCILE');
});
