/** Real private FS + real native JournalLease, injected Docker ONLY. No factory/HTTP/Docker/nativeWindows proof. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { prepareRuntimeServiceNetwork as prepare, inspectRuntimeServiceNetwork as inspect, runtimeServiceNetworkName as nameOf, type RuntimeServiceNetworkContext } from '../../src/server/runtime-coordinator/RuntimeServiceNetwork';
import type { DockerReply, DockerTransport } from '../../src/server/execution/DockerTransport';
import { canonical, createRecord } from '../../src/server/runtime-coordinator/storage';
const ID='a'.repeat(64), OTHER='b'.repeat(64), INSTALL='123e4567-e89b-42d3-a456-426614174000';
const ok=(v:unknown):DockerReply=>({exitCode:0,stdout:JSON.stringify(v),stderr:''});
function fixture(t:test.TestContext,purpose?:'http-nat-v1') {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'service-network-')); fs.chmodSync(root,0o700);
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const stateDirectory=path.join(root,'state'),workspaceRoot=path.join(root,'workspace');
  fs.mkdirSync(stateDirectory,{mode:0o700}); fs.mkdirSync(workspaceRoot,{mode:0o700});
  const layout={stateDirectory,workspaceRoot,projectId:'project:one.1',installationId:INSTALL};
  const identity=path.join(stateDirectory,'installation.json');
  // Exact pre-existing factory FORMAT, not actual factory composition.
  createRecord(identity,Buffer.from(canonical({version:1,workspaceRoot,projectId:layout.projectId,installationId:INSTALL})));
  const networkDir=path.join(stateDirectory,purpose?'service-network-http-v1':'service-network'), calls:string[][]=[];
  let net:Record<string,any>|null=null, current=true;
  let hook:((args:readonly string[])=>DockerReply|undefined|Promise<DockerReply|undefined>)|undefined;
  const transport:DockerTransport={async run(args,options) {
    assert.deepEqual(options,{timeoutMs:10000,maxBytes:65536}); calls.push([...args]);
    const injected=await hook?.(args); if (injected) return injected;
    if (args[0]==='info') return ok('approved-engine');
    if (args[1]==='ls') return {exitCode:0,stdout:net?JSON.stringify({ID:net.Id,Name:net.Name})+'\n':'',stderr:''};
    if (args[1]==='inspect') return net?ok([net]):{exitCode:1,stdout:'',stderr:'not found (not proof)'};
    if (args[1]==='create') {
      assert.ok(fs.existsSync(path.join(networkDir,'intent-001.json')),'intent durable BEFORE create');
      assert.equal(fs.lstatSync(path.join(networkDir,'intent-001.json')).mode&0o777,0o600);
      assert.deepEqual(args,['network','create','--driver','bridge',...(purpose?[]:['--internal']),
        '--label',`paircoach.installation=${INSTALL}`,'--label',`paircoach.project=${layout.projectId}`,
        '--label','paircoach.engine=approved-engine','--label','paircoach.role=service-network',...(purpose?['--label','paircoach.purpose=http-nat-v1']:[]),nameOf(INSTALL,purpose)]);
      net=own(); return {exitCode:0,stdout:ID+'\n',stderr:''};
    }
    throw Error('unexpected Docker command');
  }};
  const context:RuntimeServiceNetworkContext={layout,purpose,engineId:'approved-engine',transport,assertCurrent(){if(!current)throw Error('authority revoked');}};
  function own() { return {Id:ID,Name:nameOf(INSTALL,purpose),Driver:'bridge',Internal:!purpose,Scope:'local',Labels:{
    'paircoach.installation':INSTALL,'paircoach.project':layout.projectId,'paircoach.engine':'approved-engine','paircoach.role':'service-network',...(purpose?{'paircoach.purpose':purpose}:{})}}; }
  const snapshot=()=>fs.existsSync(networkDir)?Object.fromEntries(fs.readdirSync(networkDir).map(f=>[f,fs.readFileSync(path.join(networkDir,f)).toString('hex')])):{};
  return {root,layout,identity,networkDir,calls,context,own,snapshot,
    request:(requestId='maintenance:1')=>({...context,requestId}),
    set net(value:Record<string,any>|null){net=value;},get net(){return net;},
    set hook(value:typeof hook){hook=value;},revoke(){current=false;},
    creates:()=>calls.filter(a=>a[1]==='create').length};
}
test('readiness proves absence by exact successful list, creates NO directory/identity/lease',async t=>{
  const f=fixture(t),before=fs.readFileSync(f.identity);
  assert.equal(await inspect(f.context),null); assert.equal(fs.existsSync(f.networkDir),false);
  assert.deepEqual(fs.readFileSync(f.identity),before); assert.equal(f.creates(),0);
  assert.deepEqual(f.calls.map(c=>c[0]==='info'?'info':c[1]),['info','ls','info']);
  assert.equal(f.calls[1][4],`name=^${nameOf(INSTALL)}$`);
});
test('explicit prepare persists receipt, stable kernel lock, strict reuse and read-only inspect',async t=>{
  const f=fixture(t),identity=fs.readFileSync(f.identity),r=await prepare(f.request());
  assert.deepEqual(r,{schemaVersion:1,status:'PREPARED',installationId:INSTALL,projectId:f.layout.projectId,engineId:'approved-engine',name:nameOf(INSTALL),networkId:ID});
  assert.equal(Object.isFrozen(r),true);
  const lock=fs.statSync(path.join(f.networkDir,'lease'),{bigint:true}).ino, bytes=f.snapshot();
  assert.deepEqual(await prepare(f.request()),r); assert.deepEqual(await prepare(f.request('different')),r);
  assert.deepEqual(await inspect(f.context),r); assert.equal(f.creates(),1); assert.deepEqual(f.snapshot(),bytes);
  assert.equal(fs.statSync(path.join(f.networkDir,'lease'),{bigint:true}).ino,lock); assert.deepEqual(fs.readFileSync(f.identity),identity);
  assert.ok(f.calls.every(c=>c[0]==='info'||['ls','inspect','create'].includes(c[1])));
});
for (const [title,mutate] of Object.entries({
  'external bridge':(n:any)=>{n.Internal=false;},'wrong driver':(n:any)=>{n.Driver='overlay';},
  'foreign installation':(n:any)=>{n.Labels['paircoach.installation']='someone';},
  'foreign project':(n:any)=>{n.Labels['paircoach.project']='other';},
  'foreign engine':(n:any)=>{n.Labels['paircoach.engine']='other';},
  'wrong role':(n:any)=>{n.Labels['paircoach.role']='execution';},
  'extra label':(n:any)=>{n.Labels.extra='unproven';},'missing labels':(n:any)=>{n.Labels=null;},
  'malformed ID':(n:any)=>{n.Id='short';},'nonlocal scope':(n:any)=>{n.Scope='swarm';},
  'wrong exact name':(n:any)=>{n.Name='foreign';},
})) test(`reject ${title}, never create/adopt/remove`,async t=>{
  const f=fixture(t),net=f.own();mutate(net);f.net=net;
  await assert.rejects(prepare(f.request()));assert.equal(f.creates(),0);assert.equal(fs.existsSync(path.join(f.networkDir,'receipt.json')),false);
});
test('strict owned-looking bridge WITHOUT local intent is not adoptable',async t=>{
  const f=fixture(t);f.net=f.own();await assert.rejects(inspect(f.context),/unreceipted/);assert.equal(fs.existsSync(f.networkDir),false);
  await assert.rejects(prepare(f.request()),/not adoptable/);assert.equal(f.creates(),0);
});
for(const phase of ['wrong-engine','daemon-error','list-error','list-malformed','list-duplicates','inspect-error','inspect-malformed','inspect-multiple','oversized','throw'])
 test(`${phase} is never absence and never triggers create`,async t=>{
  const f=fixture(t);f.net=f.own();
  f.hook=args=>{
    if(phase==='wrong-engine'&&args[0]==='info')return ok('foreign');
    if(phase==='daemon-error'&&args[0]==='info')return {exitCode:1,stdout:'',stderr:'SECRET MUST NOT LEAK'};
    if(phase==='list-error'&&args[1]==='ls')return {exitCode:1,stdout:'',stderr:'SECRET MUST NOT LEAK'};
    if(phase==='list-malformed'&&args[1]==='ls')return {...ok(null),stdout:'invalid'};
    if(phase==='list-duplicates'&&args[1]==='ls')return {...ok(null),stdout:[1,2].map(()=>JSON.stringify({ID,Name:nameOf(INSTALL)})).join('\n')};
    if(phase==='inspect-error'&&args[1]==='inspect')return {exitCode:1,stdout:'',stderr:'SECRET MUST NOT LEAK'};
    if(phase==='inspect-malformed'&&args[1]==='inspect')return {...ok(null),stdout:'invalid'};
    if(phase==='inspect-multiple'&&args[1]==='inspect')return ok([f.net,f.net]);
    if(phase==='oversized')return {...ok(null),stdout:'x'.repeat(65537)};
    if(phase==='throw')throw Error('SECRET MUST NOT LEAK');
  };
  await assert.rejects(prepare(f.request()),error=>{assert.ok(!String(error).includes('SECRET'));return true;});assert.equal(f.creates(),0);
});
for (const mode of ['timeout-after-effect','nonzero-after-effect']) test(`${mode}: lost create response reconciles once by same intent`,async t=>{
  const f=fixture(t);f.hook=args=>{if(args[1]==='create'){f.net=f.own();if(mode==='timeout-after-effect')throw Error('timeout');return {exitCode:1,stdout:'',stderr:'unknown'};}};
  assert.equal((await prepare(f.request())).networkId,ID);f.hook=undefined;await prepare(f.request());assert.equal(f.creates(),1);
});
test('restart with lost reply AND failed readback retains intent; next explicit prepare reconciles without duplicate',async t=>{
  const f=fixture(t);f.hook=args=>{
    if(args[1]==='create'){f.net=f.own();throw Error('timeout');}
    if(f.creates()&&args[1]==='ls')throw Error('daemon temporarily offline');
  };
  await assert.rejects(prepare(f.request()),/UNKNOWN/);assert.equal(fs.existsSync(path.join(f.networkDir,'intent-001.json')),true);
  assert.equal(fs.existsSync(path.join(f.networkDir,'receipt.json')),false);
  f.hook=undefined;assert.equal((await prepare({...f.context,requestId:'maintenance:1'})).networkId,ID);assert.equal(f.creates(),1);
});
test('unknown/no effect: SAME request never creates twice, durable absence precedes separately explicit new attempt',async t=>{
  const f=fixture(t);f.hook=args=>{if(args[1]==='create')throw Error('unknown');};
  await assert.rejects(prepare(f.request()),/UNKNOWN/);const original=f.snapshot();
  await assert.rejects(prepare(f.request('new:request')),/fresh absence recorded/);assert.equal(f.creates(),1);
  const proof=f.snapshot();assert.equal(proof['intent-001.json'],original['intent-001.json']);assert.ok(proof['absence-001.json']);
  await assert.rejects(prepare(f.request()),/no duplicate/);assert.equal(f.creates(),1);
  f.hook=args=>{if(args[1]==='create'){assert.ok(fs.existsSync(path.join(f.networkDir,'intent-002.json')));f.net=f.own();return {exitCode:0,stdout:ID,stderr:''};}};
  await prepare(f.request('new:request'));assert.equal(f.creates(),2);
  assert.equal(f.snapshot()['intent-001.json'],original['intent-001.json']);assert.equal(f.snapshot()['absence-001.json'],proof['absence-001.json']);
});
for(const response of ['different-id','invalid-success'])test(`${response} remains durably blocked across reconciliation`,async t=>{
  const f=fixture(t);f.hook=args=>{if(args[1]==='create'){f.net=f.own();return {exitCode:0,stdout:response==='different-id'?OTHER:'nonsense',stderr:''};}};
  await assert.rejects(prepare(f.request()));f.hook=undefined;
  await assert.rejects(prepare(f.request()));assert.equal(f.creates(),1);assert.equal(fs.existsSync(path.join(f.networkDir,'receipt.json')),false);
});
for(const mode of ['changed-id','missing','foreign'])test(`durable receipt refuses ${mode} resource without reset/recreate`,async t=>{
  const f=fixture(t);await prepare(f.request());const bytes=f.snapshot();
  if(mode==='changed-id')f.net!.Id=OTHER;else if(mode==='missing')f.net=null;else f.net!.Labels['paircoach.project']='foreign';
  await assert.rejects(inspect(f.context));await assert.rejects(prepare(f.request('another')));assert.equal(f.creates(),1);assert.deepEqual(f.snapshot(),bytes);
});
for(const mode of ['identity-field','extra-field','wrong-version','invalid-utf8','oversized-identity','identity-link','identity-hardlink','public-state','state-link','workspace-overlap'])
 test(`reject unsafe ${mode} BEFORE any Docker call or second identity`,async t=>{
  const f=fixture(t),bytes=fs.readFileSync(f.identity);
  if(mode==='identity-field')fs.writeFileSync(f.identity,JSON.stringify({...JSON.parse(bytes.toString()),installationId:'different'}));
  if(mode==='extra-field')fs.writeFileSync(f.identity,JSON.stringify({...JSON.parse(bytes.toString()),extra:true}));
  if(mode==='wrong-version')fs.writeFileSync(f.identity,JSON.stringify({...JSON.parse(bytes.toString()),version:2}));
  if(mode==='invalid-utf8')fs.writeFileSync(f.identity,Buffer.from([0xff]));
  if(mode==='oversized-identity')fs.writeFileSync(f.identity,' '.repeat(4097));
  if(mode==='identity-link'){fs.renameSync(f.identity,f.identity+'.old');fs.symlinkSync(f.identity+'.old',f.identity);}
  if(mode==='identity-hardlink')fs.linkSync(f.identity,f.identity+'.alias');
  if(mode==='public-state')fs.chmodSync(f.layout.stateDirectory,0o755);
  if(mode==='state-link'){fs.renameSync(f.layout.stateDirectory,f.layout.stateDirectory+'.old');fs.symlinkSync(f.layout.stateDirectory+'.old',f.layout.stateDirectory);}
  if(mode==='workspace-overlap')f.layout.workspaceRoot=f.layout.stateDirectory;
  await assert.rejects(prepare(f.request()));assert.equal(f.calls.length,0);assert.equal(fs.existsSync(f.networkDir),false);
});
for(const mode of ['authority','identity','state-inode','workspace-inode','engine-after-list','lease-inode'])
 test(`revalidates ${mode} after awaited Docker operation before create`,async t=>{
  const f=fixture(t);let triggered=false,infoCount=0;
  f.hook=args=>{
    if(args[0]==='info')infoCount++;
    if(mode==='engine-after-list'&&infoCount>1&&args[0]==='info')return ok('changed-engine');
    if(!triggered&&args[1]==='ls'){
      triggered=true;
      if(mode==='authority')f.revoke();
      if(mode==='identity')fs.appendFileSync(f.identity,' ');
      if(mode==='state-inode'){fs.renameSync(f.layout.stateDirectory,f.layout.stateDirectory+'.old');fs.mkdirSync(f.layout.stateDirectory,{mode:0o700});fs.writeFileSync(f.identity,fs.readFileSync(path.join(f.layout.stateDirectory+'.old','installation.json')),{mode:0o600});}
      if(mode==='workspace-inode'){fs.renameSync(f.layout.workspaceRoot,f.layout.workspaceRoot+'.old');fs.mkdirSync(f.layout.workspaceRoot,{mode:0o700});}
      if(mode==='lease-inode'){const lock=path.join(f.networkDir,'lease');fs.renameSync(lock,lock+'.old');fs.writeFileSync(lock,'',{mode:0o600});}
    }
  };
  await assert.rejects(prepare(f.request()));assert.equal(f.creates(),0);
});
test('native kernel exclusion rejects concurrent owner, releases afterward without unlinking lease',async t=>{
  const f=fixture(t);let enter!:()=>void,release!:()=>void;
  const entered=new Promise<void>(r=>enter=r),barrier=new Promise<void>(r=>release=r);
  f.hook=async args=>{if(args[1]==='ls'&&!f.creates()){enter();await barrier;}};
  const one=prepare(f.request());await entered;
  const lock=fs.statSync(path.join(f.networkDir,'lease'),{bigint:true}).ino;
  await assert.rejects(prepare(f.request('two')),/live kernel owner/);release();await one;
  f.hook=undefined;await prepare(f.request('two'));assert.equal(f.creates(),1);assert.equal(fs.statSync(path.join(f.networkDir,'lease'),{bigint:true}).ino,lock);
});
test('service-directory symlink is refused even by read-only inspection',async t=>{
  const f=fixture(t),other=path.join(f.root,'other');fs.mkdirSync(other,{mode:0o700});fs.symlinkSync(other,f.networkDir);
  await assert.rejects(inspect(f.context));await assert.rejects(prepare(f.request()));assert.equal(f.calls.length,0);
});
test('receipt tamper/link and unexpected durable file never reset or recreate',async t=>{
  const f=fixture(t);await prepare(f.request());const receipt=path.join(f.networkDir,'receipt.json');fs.appendFileSync(receipt,'invalid');
  await assert.rejects(prepare(f.request()));assert.equal(f.creates(),1);
});
test('whole derived name policy has no truncation/aliasing and supports existing UUID',()=>{
  assert.equal(nameOf(INSTALL),`paircoach-${INSTALL}-service`);
  for(const id of ['a.b','a:b','a'.repeat(63),'../escape','a;cmd',''])assert.throws(()=>nameOf(id));
  assert.equal(nameOf('a'.repeat(62)).length,80);
});
test('invalid maintenance request is rejected before writes or transport',async t=>{
  const f=fixture(t);await assert.rejects(prepare(f.request('../bad')));assert.equal(f.calls.length,0);assert.equal(fs.existsSync(f.networkDir),false);
});
for(const mode of ['receipt-link','public-receipt','unexpected-file','truncated-intent','intent-extra-key','foreign-receipt','foreign-response'])
 test(`strict durable ${mode} is retained, not adopted/reset`,async t=>{
  const f=fixture(t);await prepare(f.request());
  const receipt=path.join(f.networkDir,'receipt.json');
  if(mode==='receipt-link'){fs.renameSync(receipt,receipt+'.saved');fs.symlinkSync(receipt+'.saved',receipt);}
  if(mode==='public-receipt')fs.chmodSync(receipt,0o644);
  if(mode==='unexpected-file')fs.writeFileSync(path.join(f.networkDir,'unknown.json'),'{}',{mode:0o600});
  if(mode==='truncated-intent')fs.writeFileSync(path.join(f.networkDir,'intent-001.json'),'{');
  if(mode==='intent-extra-key'){const p=path.join(f.networkDir,'intent-001.json');fs.writeFileSync(p,JSON.stringify({...JSON.parse(fs.readFileSync(p,'utf8')),extra:true}));}
  if(mode==='foreign-receipt')fs.writeFileSync(receipt,JSON.stringify({...JSON.parse(fs.readFileSync(receipt,'utf8')),engineId:'foreign'}));
  if(mode==='foreign-response'){const p=path.join(f.networkDir,'response-001.json');fs.writeFileSync(p,JSON.stringify({...JSON.parse(fs.readFileSync(p,'utf8')),networkId:OTHER}));}
  await assert.rejects(inspect(f.context));await assert.rejects(prepare(f.request('next')));assert.equal(f.creates(),1);
});
test('same bytes at a replaced installation inode are not current authority',async t=>{
  const f=fixture(t);let changed=false;
  f.hook=args=>{if(!changed&&args[1]==='ls'){changed=true;const bytes=fs.readFileSync(f.identity);fs.renameSync(f.identity,f.identity+'.saved');fs.writeFileSync(f.identity,bytes,{mode:0o600});}};
  await assert.rejects(prepare(f.request()),/installation identity changed/);assert.equal(f.creates(),0);
});
test('post-create engine drift retains durable intent/response, never writes false receipt',async t=>{
  const f=fixture(t);f.hook=args=>{if(f.creates()&&args[0]==='info')return ok('foreign-engine');};
  await assert.rejects(prepare(f.request()),/engine identity mismatch/);assert.equal(f.creates(),1);
  assert.equal(fs.existsSync(path.join(f.networkDir,'receipt.json')),false);assert.equal(fs.existsSync(path.join(f.networkDir,'intent-001.json')),true);
});
test('read-only inspect does NOT adopt a pending created network or mutate its ledger',async t=>{
  const f=fixture(t);f.hook=args=>{if(args[1]==='create'){f.net=f.own();throw Error('lost reply');}if(f.creates()&&args[1]==='ls')throw Error('no readback');};
  await assert.rejects(prepare(f.request()));f.hook=undefined;const bytes=f.snapshot();
  await assert.rejects(inspect(f.context),/explicit reconciliation/);assert.deepEqual(f.snapshot(),bytes);assert.equal(f.creates(),1);
  await prepare(f.request());assert.equal(f.creates(),1);
});

// HUMAN352072e3: NEW explicitly prepared HTTP Main generation only; legacy tests above unchanged.
test('current NAT exact purpose/name/private ledger, create once and stable readback',async t=>{
  const f=fixture(t,'http-nat-v1'),before=fs.readFileSync(f.identity);
  assert.equal(await inspect(f.context),null);assert.equal(f.creates(),0);
  const r=await prepare(f.request());
  assert.equal(r.name,`paircoach-${INSTALL}-service-http-v1`);
  assert.equal(f.net!.Internal,false);assert.equal(f.net!.Labels['paircoach.purpose'],'http-nat-v1');
  assert.equal(fs.existsSync(path.join(f.layout.stateDirectory,'service-network')),false);
  const bytes=f.snapshot();assert.deepEqual(await prepare(f.request()),r);assert.deepEqual(await inspect(f.context),r);
  assert.equal(f.creates(),1);assert.deepEqual(f.snapshot(),bytes);assert.deepEqual(fs.readFileSync(f.identity),before);
});
for(const [title,mutate]of Object.entries({
  internal:(n:any)=>{n.Internal=true;},purpose:(n:any)=>{n.Labels['paircoach.purpose']='legacy';},
  missingPurpose:(n:any)=>{delete n.Labels['paircoach.purpose'];},extra:(n:any)=>{n.Labels.extra='x';},
  engine:(n:any)=>{n.Labels['paircoach.engine']='other';},project:(n:any)=>{n.Labels['paircoach.project']='other';},
  installation:(n:any)=>{n.Labels['paircoach.installation']='other';},role:(n:any)=>{n.Labels['paircoach.role']='other';},
  driver:(n:any)=>{n.Driver='overlay';},scope:(n:any)=>{n.Scope='swarm';},name:(n:any)=>{n.Name=nameOf(INSTALL);},
  id:(n:any)=>{n.Id=OTHER;},
}))test(`current NAT refuses altered ${title} after receipt, never recreates`,async t=>{
  const f=fixture(t,'http-nat-v1');await prepare(f.request());const bytes=f.snapshot();mutate(f.net!);
  await assert.rejects(inspect(f.context));await assert.rejects(prepare(f.request('new')));
  assert.deepEqual(f.snapshot(),bytes);assert.equal(f.creates(),1);
});
test('current pending restart read-first preserves original intent and never repeats create',async t=>{
  const f=fixture(t,'http-nat-v1');f.hook=args=>{
    if(args[1]==='create'){f.net=f.own();throw Error('lost reply');}
    if(f.creates()&&args[1]==='ls')throw Error('readback unavailable');
  };
  await assert.rejects(prepare(f.request()));const before=f.snapshot();f.hook=undefined;
  const r=await prepare({...f.context,requestId:'maintenance:1'});
  assert.equal(r.name,nameOf(INSTALL,'http-nat-v1'));assert.equal(f.creates(),1);
  assert.equal(f.snapshot()['intent-001.json'],before['intent-001.json']);
  assert.equal(f.snapshot()['response-001.json'],before['response-001.json']);
});
test('current purpose unknown or changed across await is refused before create',async t=>{
  const f=fixture(t,'http-nat-v1');
  await assert.rejects(inspect({...f.context,purpose:'unknown'} as any));assert.equal(f.calls.length,0);
  const request=f.request();f.hook=args=>{if(args[1]==='ls')(request as any).purpose=undefined;};
  await assert.rejects(prepare(request),/context changed/);assert.equal(f.creates(),0);
});
test('current name remains exact and bounded without truncation',()=>{
  assert.equal(nameOf('a'.repeat(54),'http-nat-v1').length,80);
  assert.throws(()=>nameOf('a'.repeat(55),'http-nat-v1'));
});

import { RuntimeNetworkMaintenance } from '../../src/server/runtime-coordinator/RuntimeNetworkMaintenance';
import { createRuntimeExecution } from '../../src/server/runtime-coordinator/RuntimeExecution';
import type { RuntimeExecutionLayout } from '../../src/server/runtime-coordinator/RuntimeExecutionLayout';

/** Real private ledgers/lease + actual maintenance/runtime/helper; injected workspace/resolver/Docker.
 * NOT authenticated HTTP, real source gate or actual Docker proof. */
function generations(t:test.TestContext) {
  const f=fixture(t),layout:RuntimeExecutionLayout={...f.layout,runRoot:path.join(f.layout.stateDirectory,'runs'),journalDirectory:path.join(f.layout.stateDirectory,'journal')};
  const directory=path.join(f.root,'maintenance'),nets=new Map<string,any>(),calls:string[][]=[];
  fs.mkdirSync(layout.runRoot,{mode:0o700});
  let failed=false,lose=false;
  const transport:DockerTransport={async run(args){
    calls.push([...args]);if(args[0]==='info')return ok('approved-engine');
    if(args[1]==='create') {
      const labels:Record<string,string>={};for(let n=0;n<args.length;n++)if(args[n]==='--label'){const [k,...v]=args[n+1].split('=');labels[k]=v.join('=');}
      const name=args.at(-1)!,id=labels['paircoach.purpose']?OTHER:ID;
      nets.set(name,{Id:id,Name:name,Driver:'bridge',Scope:'local',Internal:args.includes('--internal'),Labels:labels});
      if(lose){failed=true;throw Error('lost create reply');}return {exitCode:0,stdout:id,stderr:''};
    }
    if(failed)throw Error('readback unavailable');
    if(args[1]==='ls') {
      const name=args[4].slice(6,-1),n=nets.get(name);return {exitCode:0,stdout:n?JSON.stringify({ID:n.Id,Name:n.Name}):'',stderr:''};
    }
    if(args[1]==='inspect')return ok([...nets.values()].filter(n=>n.Id===args[2]));
    throw Error('unexpected command');
  }};
  const profile=JSON.parse(fs.readFileSync(new URL('../../runtimes/catalog.json',import.meta.url),'utf8')).profiles.find((p:any)=>p.adapterFamily==='java-maven'&&p.compilerRelease===21);
  const settings:any={runProfiles:[{kind:'RUN_MAIN',timeoutMs:120000,task:{workingDirectory:'.',entry:{kind:'SPRING_BOOT',containerPort:8080,healthPath:'/health'},tests:{paths:[],names:[]}}}]};
  const core:any={workspace:{rootPath:layout.workspaceRoot,projectId:layout.projectId,workspaceVersion:0,_withQueuedMutation:async(fn:()=>Promise<any>)=>fn()},
    readSettings:()=>({sourceSha256:'source1',settings}),session:{state:{lifecycle:'ACTIVE',writeOwner:'STUDENT',controlEpoch:0}}};
  const configuration:any={configurationGeneration:'cfg1',resolved:{profile,configurationGeneration:'cfg1'}};
  const runtime=createRuntimeExecution({core,configuration,layout,transport,prepared:{resolve:async()=>({engineId:'approved-engine'})} as any,
    serviceNetwork:nameOf(INSTALL,'http-nat-v1'),assertCurrent(){},emit(){}});
  const request=(requestId:string)=>({requestId,clientId:'client',sessionId:'session',expectedWorkspaceVersion:0,configurationGeneration:'cfg1',controlEpoch:0});
  const authorize=()=>{};
  const owner=()=>new RuntimeNetworkMaintenance(directory,layout.projectId);
  const execute=(m:RuntimeNetworkMaintenance,id:string)=>m.execute(request(id),authorize,(recovery,context,stage)=>runtime.prepareServiceNetwork(request(id),recovery,context,stage,authorize));
  const legacy=(m:RuntimeNetworkMaintenance,id:string)=>m.execute(request(id),authorize,async(_recovery,_context,stage)=>{
    stage({layout,engineId:'approved-engine'});
    return prepare({...f.context,layout,transport,requestId:id});
  });
  const bytes=(dir:string)=>fs.existsSync(dir)?Object.fromEntries(fs.readdirSync(dir).map(n=>[n,fs.readFileSync(path.join(dir,n)).toString('hex')])):{};
  return {f,layout,directory,transport,settings,request,owner,execute,legacy,bytes,calls,
    creates:()=>calls.filter(a=>a[1]==='create').length,lose(){lose=true;},restore(){lose=false;failed=false;}};
}
test('legacy PREPARED restart returns SAME original, never current receipt/ledger; separate new click prepares NAT without rewriting history',async t=>{
  const f=generations(t);let m=f.owner();const original=await f.legacy(m,'legacy1');await m.close();
  const legacyDir=path.join(f.layout.stateDirectory,'service-network'),before=f.bytes(legacyDir),history=f.bytes(f.directory);
  m=f.owner();try {
    assert.deepEqual(await f.execute(m,'legacy1'),original);assert.equal(original.name,nameOf(INSTALL));
    assert.equal(await inspect({layout:f.layout,transport:f.transport,engineId:'approved-engine',purpose:'http-nat-v1',assertCurrent(){}}),null);
    assert.equal(f.creates(),1);assert.deepEqual(f.bytes(legacyDir),before);assert.deepEqual(f.bytes(f.directory),history);
    const current=await f.execute(m,'new-click');assert.equal(current.name,nameOf(INSTALL,'http-nat-v1'));assert.equal(current.networkId,OTHER);
    assert.equal(f.creates(),2);assert.deepEqual(await f.execute(m,'new-click'),current);assert.equal(f.creates(),2);
    assert.deepEqual(await f.execute(m,'legacy1'),original);assert.deepEqual(f.bytes(legacyDir),before);
    for(const [name,bytes]of Object.entries(history))assert.equal(f.bytes(f.directory)[name],bytes);
  }finally{await m.close();}
});
test('legacy PENDING restart globally fences new click; SAME original read-first settles without second create then new generation is separately explicit',async t=>{
  const f=generations(t);let m=f.owner();f.lose();await assert.rejects(f.legacy(m,'legacy1'),{code:'SERVICE_NETWORK_OUTCOME_UNKNOWN'});await m.close();
  const legacyDir=path.join(f.layout.stateDirectory,'service-network'),before=f.bytes(legacyDir);
  m=f.owner();try {
    await assert.rejects(f.execute(m,'new-click'),{code:'SERVICE_NETWORK_OUTCOME_UNKNOWN'});assert.equal(f.creates(),1);
    assert.equal(fs.existsSync(path.join(f.layout.stateDirectory,'service-network-http-v1')),false);f.restore();
    const original=await f.execute(m,'legacy1');assert.equal(original.name,nameOf(INSTALL));assert.equal(f.creates(),1);
    for(const name of ['intent-001.json','response-001.json'])assert.equal(f.bytes(legacyDir)[name],before[name]);
    const history=f.bytes(f.directory);await f.execute(m,'new-click');assert.equal(f.creates(),2);
    assert.deepEqual(await f.execute(m,'legacy1'),original);
    for(const [name,bytes]of Object.entries(history))assert.equal(f.bytes(f.directory)[name],bytes);
  }finally{await m.close();}
});
test('queued interleaving cannot bypass unresolved legacy operation or auto-create current',async t=>{
  const f=generations(t),m=f.owner();f.lose();try {
    const first=f.legacy(m,'legacy1'),second=f.execute(m,'new-click');
    await assert.rejects(first,{code:'SERVICE_NETWORK_OUTCOME_UNKNOWN'});
    await assert.rejects(second,{code:'SERVICE_NETWORK_OUTCOME_UNKNOWN'});assert.equal(f.creates(),1);
    assert.equal(fs.existsSync(path.join(f.layout.stateDirectory,'service-network-http-v1')),false);
  }finally{await m.close();}
});
for(const mode of ['SCRIPT','TESTS','missingMain'])test(`explicit new prepare refuses ${mode} before resolver/network; original recorded without dispatch`,async t=>{
  const f=generations(t),m=f.owner();
  if(mode==='missingMain')f.settings.runProfiles=[];
  else {f.settings.runProfiles[0].task.entry=mode==='SCRIPT'?{kind:'SCRIPT',path:'main.js'}:{kind:'TESTS'};}
  try {
    await assert.rejects(f.execute(m,'new-click'),{code:'SERVICE_NETWORK_NOT_DISPATCHED'});
    assert.equal(f.calls.length,0);assert.equal(f.creates(),0);
    assert.equal(fs.existsSync(path.join(f.layout.stateDirectory,'service-network-http-v1')),false);
    await assert.rejects(f.execute(m,'new-click'),{code:'SERVICE_NETWORK_NOT_DISPATCHED'});assert.equal(f.calls.length,0);
  }finally{await m.close();}
});

test('private maintenance context refuses unknown purpose/extra fields before dispatch and on restart',async t=>{
  for(const delta of [{purpose:'unknown'},{extra:true}]) {
    const f=generations(t),m=f.owner();
    try {
      await assert.rejects(m.execute(f.request('bad-context'),()=>{},async(_r,_c,stage)=>{
        stage({layout:f.layout,engineId:'approved-engine',...delta} as any);throw Error('must not dispatch');
      }),{code:'SERVICE_NETWORK_NOT_DISPATCHED'});assert.equal(f.calls.length,0);
    }finally{await m.close();}
    // Corruption of an existing record is refused, never normalized or downgraded.
    const file=fs.readdirSync(f.directory).find(n=>n.endsWith('.json'))!,p=path.join(f.directory,file);
    const envelope=JSON.parse(fs.readFileSync(p,'utf8'));envelope.body.context={layout:f.layout,engineId:'approved-engine',...delta};
    const {sha256}=await import('../../src/server/runtime-coordinator/storage');
    envelope.sha256=sha256(canonical(envelope.body));fs.writeFileSync(p,canonical(envelope));
    const bytes=fs.readFileSync(p);assert.throws(()=>f.owner(),/Invalid maintenance record/);assert.deepEqual(fs.readFileSync(p),bytes);
    assert.equal(f.calls.length,0);
  }
});
test('current generation concurrent helper prepare has one durable create and retains stable lease',async t=>{
  const f=fixture(t,'http-nat-v1');let enter!:()=>void,release!:()=>void;
  const entered=new Promise<void>(r=>enter=r),barrier=new Promise<void>(r=>release=r);
  f.hook=async args=>{if(args[1]==='ls'&&!f.creates()){enter();await barrier;}};
  const first=prepare(f.request());await entered;
  await assert.rejects(prepare(f.request('second')),/live kernel owner/);release();const r=await first;
  f.hook=undefined;assert.deepEqual(await prepare(f.request('second')),r);assert.equal(f.creates(),1);
});
