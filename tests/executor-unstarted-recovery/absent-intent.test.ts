/** UNIT: real executor/journal/kernel lease/sealed FS + Runner. Docker replies only are injected.
 * Captured Docker29 stdout bytes are unchanged; only the exact target is rebound to unit ownership.
 * No Docker, HTTP, host process or runtime is executed here.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import { fixture } from '../runtime-executor/fixtures';
import { createdFixture,deferred } from './fixture';
import { DockerExecutor,ExecutionUncertainError } from '../../src/server/execution/DockerExecutor';
import { DurableRunJournal } from '../../src/server/execution/DurableRunJournal';
import { RuntimeRunner } from '../../src/server/runtime-coordinator/RuntimeRunner';
import type { JournalRecord } from '../../src/server/execution/DurableRunJournal';
import { canonicalJson,sha256 } from '../../src/server/execution/files';
import captured from './docker29-named-absence.json';
const missing=(target:string)=>({...captured.reply,stderr:captured.reply.stderr.replace(captured.target,target)});
async function intentFixture() {
  const f=await fixture();await f.journal.initialize();
  const handle={runId:'run1',opaqueId:'original-handle'};
  const record:JournalRecord={version:1,createdAt:Date.now(),revision:0,handle,ownership:structuredClone(f.plan.ownership),plan:structuredClone(f.plan),
    phase:'INTENT',containerId:null,exit:null,collection:null,outcome:null};
  await f.journal.reserve(record);
  const original=f.fake.run.bind(f.fake);
  f.fake.run=async args=>{const reply=await original(args);return args[0]==='container'&&!f.fake.v?missing(args[2]):reply;};
  const reopen=()=>new DockerExecutor({policy:f.policy,transport:f.fake,journal:new DurableRunJournal(f.journal.directory,'install')});
  return {...f,handle,record,reopen};
}

test('REGRESSION recorded Docker29 [] named absence permits ordinary executor create/start, not UNKNOWN',async()=>{
  const f=await fixture();try {
    assert.equal(captured.reply.stdout,'[]\n');assert.equal(captured.reply.exitCode,1);
    const original=f.fake.run.bind(f.fake);f.fake.run=async args=>{const result=await original(args);return args[0]==='container'&&!f.fake.v?missing(args[2]):result;};
    const h=await f.executor.start(f.plan);assert.equal(h.runId,'run1');
    assert.equal(f.fake.calls.filter(a=>a[0]==='create').length,1);assert.equal(f.fake.calls.filter(a=>a[0]==='start').length,1);
    assert.equal((await f.journal.read('run1')).startDispatch,'MAY_HAVE_BEEN_DISPATCHED');
  }finally{await f.cleanup();}
});

for(const defect of ['foreign-name','suffix','nonempty','malformed','trailing','object','null','wrong-exit','opaque','wrong-engine'] as const)
test('REGRESSION typed absence fails closed before create: '+defect,async()=>{
  const f=await fixture();try {
    const original=f.fake.run.bind(f.fake);f.fake.run=async args=>{
      const value=await original(args);if(args[0]!=='container'||f.fake.v)return value;
      const r=missing(args[2]);
      if(defect==='foreign-name')r.stderr=missing('other-name').stderr;
      if(defect==='suffix')r.stderr+='permission denied';
      if(defect==='nonempty')r.stdout='[{}]\n';if(defect==='malformed')r.stdout='[';
      if(defect==='trailing')r.stdout='[] garbage';if(defect==='object')r.stdout='{}';if(defect==='null')r.stdout='null';
      if(defect==='wrong-exit')r.exitCode=2;if(defect==='opaque')r.stderr='daemon unavailable';return r;
    };
    if(defect==='wrong-engine')f.fake.engineId='foreign';
    await assert.rejects(f.executor.start(f.plan));assert.equal(f.fake.calls.some(a=>a[0]==='create'||a[0]==='start'),false);
  }finally{await f.cleanup();}
});

test('REGRESSION existing CREATED cancellation checks Docker29 [] for BOTH ID and owned name, keeps true collection/rm',async()=>{
  const f=await createdFixture();try {
    const original=f.fake.run.bind(f.fake);f.fake.run=async args=>{const result=await original(args);return args[0]==='container'&&!f.fake.v?missing(args[2]):result;};
    const result=await f.reopen().recoverUnstarted(f.handle);assert.equal(result.confirmed,true);
    assert.equal(f.fake.calls.filter(a=>a[0]==='rm').length,1);assert.equal(f.fake.calls.filter(a=>a[0]==='logs').length,1);
    const rm=f.fake.calls.findIndex(a=>a[0]==='rm');assert.deepEqual(f.fake.calls.slice(rm+1).filter(a=>a[0]==='container').map(a=>a[2]),['c'.repeat(64),f.plan.ownership.containerName]);
  }finally{await f.cleanup();}
});

test('REGRESSION old original null-ID INTENT -> native revoke -> fsynced named evidence -> read-first cancellation; no fake exit or Docker mutation',async()=>{
  const f=await intentFixture();try {
    const initial=structuredClone(f.record),result=await f.reopen().recoverUnstarted(f.handle);assert.equal(result.confirmed,true);
    if(!result.confirmed)throw Error('narrow');
    assert.equal(result.receipt.kind,'ABSENT_INTENT');assert.equal(result.receipt.containerId,null);
    assert.equal(result.receipt.inputManifestSha256,initial.plan.input.identity.manifestSha256);assert.equal(result.receipt.planSha256,sha256(canonicalJson(initial.plan)));
    assert.equal('exit' in result.receipt,false);assert.equal('collectionSha256' in result.receipt,false);
    const r=await f.journal.read('run1');assert.equal(r.phase,'REMOVED');assert.equal(r.startDispatch,'REVOKED');assert.equal(r.containerId,null);
    assert.deepEqual(r.plan,initial.plan);assert.deepEqual(r.handle,initial.handle);assert.equal(r.exit,null);assert.equal(r.collection,null);assert.equal(r.outcome,null);
    const c=r.unstartedCancellation!,bytes=await fs.readFile(c.evidencePath),e=JSON.parse(bytes.toString());
    assert.equal(sha256(bytes),c.evidenceSha256);assert.equal(e.kind,'NO_PROCESS_ABSENT_INTENT');assert.equal(e.containerId,null);assert.deepEqual(e.reply,missing(r.ownership.containerName));
    assert.equal('container' in e,false);assert.equal('stdoutSha256' in e,false);
    assert.deepEqual(await f.reopen().recoverUnstarted(f.handle),result);assert.deepEqual(await f.reopen().readUnstartedCancellation(f.handle),result.receipt);
    await assert.rejects(f.journal.withCreateAuthority(initial,async()=>{throw Error('must not dispatch');}),/revoked\/changed/);
    await assert.rejects(f.journal.claimStart(initial),/revision/);
    assert.equal(f.fake.calls.some(a=>['create','start','stop','rm','logs','prune','ps'].includes(a[0])),false);
  }finally{await f.cleanup();}
});

for(const defect of ['MAY','legacy','wrong-engine','wrong-owner','changed-input','created-phase','known-ID','response-loss','foreign-name','appearance'] as const)
test('REGRESSION absent INTENT remains unconfirmed: '+defect,async()=>{
  const f=await intentFixture();try {
    if(defect==='MAY')await f.journal.claimStart(await f.journal.read('run1'));
    if(defect==='legacy'){const r=await f.journal.read('run1');delete r.startDispatch;await fs.writeFile(path.join(f.journal.directory,'run1.json'),canonicalJson(r));}
    if(defect==='wrong-engine')f.fake.engineId='foreign';
    if(defect==='wrong-owner'){const r=await f.journal.read('run1');r.ownership.engineId='foreign';r.plan.ownership={...r.plan.ownership,engineId:'foreign'};await fs.writeFile(path.join(f.journal.directory,'run1.json'),canonicalJson(r));}
    if(defect==='changed-input'){await fs.chmod(f.input.immutableDirectory,0o700);await fs.chmod(path.join(f.input.immutableDirectory,'main.js'),0o600);await fs.writeFile(path.join(f.input.immutableDirectory,'main.js'),'changed');await fs.chmod(f.input.immutableDirectory,0o500);}
    if(defect==='created-phase'||defect==='known-ID'){const r=await f.journal.read('run1');if(defect==='created-phase')r.phase='CREATED';else r.containerId='c'.repeat(64);await f.journal.update(r);}
    const original=f.fake.run.bind(f.fake);let inspections=0;
    f.fake.run=async args=>{
      const reply=await original(args);if(args[0]!=='container')return reply;inspections++;
      if(defect==='response-loss')throw Error('Lost inspect response');if(defect==='foreign-name')return missing('foreign');
      if(defect==='appearance'&&inspections>=3)return {exitCode:0,stdout:'[{}]',stderr:''};return reply;
    };
    assert.equal((await f.reopen().recoverUnstarted(f.handle)).confirmed,false);assert.notEqual((await f.journal.read('run1')).phase,'REMOVED');
    assert.equal(f.fake.calls.some(a=>['create','start','stop','rm','logs'].includes(a[0])),false);
  }finally{await f.cleanup();}
});

test('UNIT native exclusion fences competing delayed create AND start throughout absent observation/revoke/evidence',async()=>{
  const f=await intentFixture(),entered=deferred(),release=deferred();try {
    const original=f.fake.run.bind(f.fake);let once=false;
    f.fake.run=async args=>{if(args[0]==='container'&&!once){once=true;entered.resolve();await release.promise;}return original(args);};
    const other=new DurableRunJournal(f.journal.directory,'install'),stale=await other.read('run1'),recovery=f.reopen().recoverUnstarted(f.handle);await entered.promise;
    let effects=0;await assert.rejects(other.withCreateAuthority(stale,async()=>{effects++;}),{code:'EEXIST'});
    await assert.rejects(other.claimStart(structuredClone(stale)),{code:'EEXIST'});
    release.resolve();assert.equal((await recovery).confirmed,true);
    await assert.rejects(other.withCreateAuthority(stale,async()=>{effects++;}),/revoked\/changed/);
    await assert.rejects(other.claimStart(await other.read('run1')),/unavailable/);assert.equal(effects,0);
  }finally{release.resolve();await f.cleanup();}
});

for(const fault of ['revocation','evidence','intent','final','directory'] as const)
test('UNIT absent intent actual fsync failure '+fault+' preserves debt; reopened same-run recovery is idempotent',async()=>{
  const f=await intentFixture(),open=fs.open;let fired=false;try {
    fs.open=async function(...args:Parameters<typeof fs.open>){const fd=await open(...args),name=String(args[0]),sync=fd.sync.bind(fd);
      fd.sync=async()=>{
        let inject=fault==='evidence'&&name.includes('/unstarted-')&&name.includes('evidence.json.');
        if(name.startsWith(path.join(f.journal.directory,'run1.json.'))){const r=JSON.parse(await fs.readFile(name,'utf8'));
          inject ||= fault==='revocation'&&r.startDispatch==='REVOKED'&&!r.unstartedCancellation || fault==='intent'&&r.unstartedCancellation?.confirmedAt===null || fault==='final'&&r.phase==='REMOVED';}
        if(fault==='directory'&&name===f.journal.directory){const r=JSON.parse(await fs.readFile(path.join(name,'run1.json'),'utf8'));inject=r.phase==='REMOVED';}
        if(inject&&!fired){fired=true;throw Error('Injected actual fsync EIO');}return sync();};return fd;};syncBuiltinESMExports();
    assert.equal((await f.reopen().recoverUnstarted(f.handle)).confirmed,false);assert.equal(fired,true);
  }finally{fs.open=open;syncBuiltinESMExports();}
  try {assert.equal((await f.reopen().recoverUnstarted(f.handle)).confirmed,true);assert.equal(f.fake.calls.some(a=>['create','start','stop','rm','logs'].includes(a[0])),false);}finally{await f.cleanup();}
});

test('UNIT genuine absent receipt joins Runner original QUEUED -> explicit same-run cancellation -> read-only restart; original result unchanged',async()=>{
  const f=await intentFixture();try {
    const original={runId:'run1',mode:'RUN_TESTS' as const,status:'QUEUED' as const,exitCode:null,workspaceVersionAtStart:3,workspaceChangedDuringRun:false,
      testOutcome:'UNKNOWN' as const,testCount:null,outputTail:'',outputTruncated:false,startedAt:null,finishedAt:null,profileId:f.plan.profile.id,
      configurationGeneration:'config1',processProblem:null,serviceReadiness:null};
    const accepted=structuredClone(original);let retained:any=null;
    const adapter={family:'node' as const,validate:async()=>({valid:true,problem:null}),buildPlan:async()=>f.plan,interpret:async()=>{throw Error('No interpretation without process');}};
    const make=()=>new RuntimeRunner({execution:f.reopen(),getWorkspaceVersion:()=>3,emit:()=>{},persistTerminal:async()=>{throw Error('No terminal fiction');},retainState:(_plan,run,requested)=>{retained={run,requested};}});
    const base={sessionId:f.plan.input.sessionId,original,plan:f.plan,adapter,handle:f.handle,exit:null,collection:null,outcome:null,noProcess:false};
    const runner=make();runner.restore({...base,removed:false,retained:null});
    const cancelled=await runner.stop('run1');assert.equal(cancelled.status,'CANCELLED');assert.equal(cancelled.startedAt,null);assert.equal(cancelled.exitCode,null);
    assert.equal(cancelled.testOutcome,'UNKNOWN');assert.equal(cancelled.testCount,null);assert.equal(cancelled.processProblem?.code,'RUN_CANCELLED_UNSTARTED');assert.match(cancelled.processProblem!.message,/name absence/);
    assert.deepEqual(original,accepted,'original accepted result is never replaced by current state');
    const reopened=make(),calls=f.fake.calls.length;
    reopened.restore({...base,removed:true,cancellation:await f.reopen().readUnstartedCancellation(f.handle),retained});
    assert.deepEqual(reopened.get('run1'),cancelled);assert.equal(f.fake.calls.length,calls,'startup join performs zero Docker commands');
    const r=await f.journal.read('run1'),c=r.unstartedCancellation!,e=JSON.parse(await fs.readFile(c.evidencePath,'utf8'));e.target='foreign';await fs.writeFile(c.evidencePath,canonicalJson(e));
    await assert.rejects(f.reopen().readUnstartedCancellation(f.handle),/mismatch/);
  }finally{await f.cleanup();}
});

// A real refused Stop only projects uncertainty; it cannot erase the positive native dispatch fence.
test('UNIT original absent intent after refused Stop still requires native revocation, never a fabricated exit',async()=>{
  const f=await intentFixture();try {
    const stopped=await f.executor.stop(f.handle,'RECOVERY');assert.equal(stopped.confirmed,false);
    const r=await f.journal.read('run1');assert.equal(r.phase,'STOP_UNCONFIRMED');assert.equal(r.startDispatch,'NOT_DISPATCHED');assert.equal(r.containerId,null);
    assert.equal((await f.reopen().recoverUnstarted(f.handle)).confirmed,true);
    assert.equal((await f.journal.read('run1')).exit,null);assert.equal(f.fake.calls.some(a=>['create','start','stop','rm','logs'].includes(a[0])),false);
  }finally{await f.cleanup();}
});
