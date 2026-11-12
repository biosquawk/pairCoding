import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import { createdFixture,deferred,zero } from './fixture';
import { fixture,success } from '../runtime-executor/fixtures';
import { DurableRunJournal } from '../../src/server/execution/DurableRunJournal';
import { sha256 } from '../../src/server/execution/files';

test('UNIT real native journal + executor: lost create/no start -> bounded real evidence/fsync -> exact nonforce rm -> ID AND name absence -> distinct durable cancellation',async()=>{
  const f=await createdFixture();try {
    const artifact=Buffer.from([0,255,128,1]);await fs.writeFile(path.join(f.input.artifactsDirectory,'available.bin'),artifact);
    const original=f.fake.run.bind(f.fake);let intentSeen=false;
    f.fake.run=async args=>{
      if(args[0]==='rm'){
        assert.deepEqual(args,['rm','c'.repeat(64)]);
        const r=await f.journal.read(f.handle.runId);assert.equal(r.startDispatch,'REVOKED');assert.equal(r.phase,'INTENT');
        assert.equal(r.unstartedCancellation?.confirmedAt,null);assert.equal(r.exit,null);assert.equal(r.collection,null);assert.equal(r.outcome,null);
        const c=r.unstartedCancellation!,evidence=await fs.readFile(c.evidencePath);assert.equal(sha256(evidence),c.evidenceSha256);
        const e=JSON.parse(evidence.toString());assert.equal(e.container.State.StartedAt,zero);assert.equal(e.files.length,1);
        assert.equal(e.files[0].sha256,sha256(artifact));assert.deepEqual(Buffer.from(await fs.readFile(path.join(path.dirname(c.evidencePath),'files','available.bin'),'utf8'),'base64'),artifact);
        assert.ok(!('exit' in e));assert.ok(!('testOutcome' in e));intentSeen=true;
      }return original(args);
    };
    const result=await f.reopen().recoverUnstarted(f.handle);assert.equal(result.confirmed,true);if(!result.confirmed)throw Error('narrow');
    assert.equal(intentSeen,true);assert.ok(!('exit' in result.receipt));assert.ok(!('collectionSha256' in result.receipt));
    assert.equal((await f.journal.read(f.handle.runId)).phase,'REMOVED');
    const rm=f.fake.calls.findIndex(a=>a[0]==='rm');assert.ok(rm>f.fake.calls.findIndex(a=>a[0]==='logs'));
    assert.deepEqual(f.fake.calls.slice(rm+1).filter(a=>a[0]==='container').map(a=>a[2]),['c'.repeat(64),f.plan.ownership.containerName]);
    assert.deepEqual(await f.reopen().readUnstartedCancellation(f.handle),result.receipt);
    assert.deepEqual(await f.reopen().recoverUnstarted(f.handle),result);assert.equal(f.fake.calls.filter(a=>a[0]==='rm').length,1);
    await assert.rejects(f.reopen().start(f.plan),/revoked/);assert.equal(f.fake.calls.filter(a=>a[0]==='create').length,1);
  }finally{await f.cleanup();}
});

test('UNIT native CAS across journal/executor instances: revoke excludes competing claim while real logs await; revoked start can never dispatch',async()=>{
  const f=await createdFixture(), entered=deferred(),release=deferred();try {
    const original=f.fake.run.bind(f.fake);f.fake.run=async args=>{if(args[0]==='logs'){entered.resolve();await release.promise;}return original(args);};
    const old=await f.journal.read(f.handle.runId),other=new DurableRunJournal(f.journal.directory,'install');
    const recovery=f.reopen().recoverUnstarted(f.handle);await entered.promise;
    await assert.rejects(other.claimStart(old),{code:'EEXIST'});
    release.resolve();assert.equal((await recovery).confirmed,true);
    await assert.rejects(other.claimStart(await other.read(f.handle.runId)),/unavailable/);
    assert.equal(f.fake.calls.some(a=>a[0]==='start'),false);
  }finally{release.resolve();await f.cleanup();}
});

test('UNIT claim wins native CAS: MAY+currently-created remains uncertain even without any reported started timestamp',async()=>{
  const f=await createdFixture();try {
    const other=new DurableRunJournal(f.journal.directory,'install');await other.claimStart(await other.read(f.handle.runId));
    assert.equal((await f.reopen().recoverUnstarted(f.handle)).confirmed,false);
    assert.equal(f.fake.calls.some(a=>a[0]==='logs'||a[0]==='rm'),false);
  }finally{await f.cleanup();}
});

test('UNIT actual start timeout + delayed dispatch: MAY survives reopen, created is not cancellation proof; genuine running/exited normal path still required',async()=>{
  const f=await fixture();try {
    f.fake.startThrowsBeforeCommit=true;
    await assert.rejects(f.executor.start(f.plan));const r=await f.journal.read('run1');f.fake.v.State.StartedAt=zero;
    assert.equal(r.startDispatch,'MAY_HAVE_BEEN_DISPATCHED');assert.equal((await f.executor.recoverUnstarted(r.handle)).confirmed,false);
    assert.equal((await f.executor.stop(r.handle,'RECOVERY')).confirmed,false);assert.equal(f.fake.calls.some(a=>a[0]==='rm'),false);
    // Simulated delayed original daemon start, not a second invocation by recovery.
    f.fake.v.State.Running=true;f.fake.v.State.Status='running';f.fake.v.State.StartedAt='2026-11-12T02:00:00Z';
    const stopped=await f.executor.stop(r.handle,'RECOVERY');assert.equal(stopped.confirmed,true);if(!stopped.confirmed)throw Error('narrow');
    assert.equal(stopped.exit.exitCode,137);await fs.writeFile(path.join(f.input.artifactsDirectory,'real.xml'),'<testsuite><testcase/></testsuite>');
    await f.executor.collect(r.handle,stopped.exit);await f.executor.cleanup(await f.executor.persistTerminal(r.handle,{...success,status:'FAILED',testOutcome:'UNKNOWN',testCount:null,skipped:null,failures:null,errors:null}));
    assert.equal(f.fake.calls.filter(a=>a[0]==='start').length,1);assert.equal(f.fake.calls.filter(a=>a[0]==='rm').length,1);
    assert.equal((await f.journal.read('run1')).unstartedCancellation,undefined);
  }finally{await f.cleanup();}
});

for(const defect of ['legacy','contradictory-phase','foreign-image','foreign-label','foreign-engine','foreign-name','foreign-id','started','missing-started','running','absent','inspect-timeout','artifact-link','logs-fail','state-drift'] as const)test('UNIT no-process recovery fail closed: '+defect,async()=>{
  const f=await createdFixture();try {
    if(defect==='legacy'){const r=await f.journal.read('run1');delete r.startDispatch;await fs.writeFile(path.join(f.journal.directory,'run1.json'),JSON.stringify(r));}
    if(defect==='contradictory-phase'){const r=await f.journal.read('run1');r.phase='RUNNING';await fs.writeFile(path.join(f.journal.directory,'run1.json'),JSON.stringify(r));}
    if(defect==='foreign-image')f.fake.v.Image='sha256:'+'f'.repeat(64);
    if(defect==='foreign-label')f.fake.v.Config.Labels['paircoach.role']='lsp';
    if(defect==='foreign-engine')f.fake.engineId='other';
    if(defect==='foreign-name')f.fake.v.Name='/control';
    if(defect==='foreign-id'){const r=await f.journal.read('run1');r.containerId='d'.repeat(64);await f.journal.update(r);}
    if(defect==='started')f.fake.v.State.StartedAt='2026-11-12T02:00:00Z';
    if(defect==='missing-started')delete f.fake.v.State.StartedAt;
    if(defect==='running')f.fake.v.State.Running=true;
    // HUMAN610e explicitly adds null-ID INTENT recovery; keep this negative about a KNOWN created ID without prior evidence.
    if(defect==='absent'){const r=await f.journal.read('run1');r.containerId=f.fake.v.Id;await f.journal.update(r);f.fake.v=null;}
    if(defect==='inspect-timeout')f.fake.daemon=false;
    if(defect==='artifact-link')await fs.symlink(path.join(f.workspace,'main.js'),path.join(f.input.artifactsDirectory,'link.xml'));
    if(defect==='logs-fail')f.fake.logsFail=true;
    if(defect==='state-drift'){const original=f.fake.run.bind(f.fake);f.fake.run=async args=>{const result=await original(args);if(args[0]==='logs')f.fake.v.State.Running=true;return result;};}
    const r=await f.reopen().recoverUnstarted(f.handle);assert.equal(r.confirmed,false);assert.ok(!f.fake.calls.some(a=>['rm','stop','kill','prune','ps'].includes(a[0])));
    assert.notEqual((await f.journal.read('run1')).phase,'REMOVED');
  }finally{await f.cleanup();}
});

for(const fault of ['evidence-fsync','intent-fsync','final-fsync'] as const)test('UNIT actual FileHandle.sync failure '+fault+' retains durable debt; read-first reopen reconciles without duplicate rm',async()=>{
  const f=await createdFixture(),open=fs.open;let fired=false;
  try {
    fs.open=async function(...args:Parameters<typeof fs.open>){const fd=await open(...args),name=String(args[0]),sync=fd.sync.bind(fd);
      fd.sync=async()=>{
        let inject=fault==='evidence-fsync'&&name.includes('/unstarted-')&&name.includes('stdout.log');
        if(name.startsWith(path.join(f.journal.directory,'run1.json.'))){const value=JSON.parse(await fs.readFile(name,'utf8'));inject ||= fault==='intent-fsync'&&value.unstartedCancellation?.confirmedAt===null || fault==='final-fsync'&&value.phase==='REMOVED';}
        if(!fired&&inject){fired=true;throw Object.assign(Error('Injected FileHandle.sync EIO'),{code:'EIO'});}return sync();};return fd;
    };syncBuiltinESMExports();
    assert.equal((await f.reopen().recoverUnstarted(f.handle)).confirmed,false);assert.equal(fired,true);
    assert.equal(f.fake.calls.filter(a=>a[0]==='rm').length,fault==='final-fsync'?1:0);assert.notEqual((await f.journal.read('run1')).phase,'REMOVED');
  }finally{fs.open=open;syncBuiltinESMExports();}
  try {assert.equal((await f.reopen().recoverUnstarted(f.handle)).confirmed,true);assert.equal(f.fake.calls.filter(a=>a[0]==='rm').length,1);}finally{await f.cleanup();}
});

test('UNIT rm response loss reconciles exact ID+name absence; ambiguous ID inspect retains intent then reopen performs no second rm',async()=>{
  const f=await createdFixture();try {
    f.fake.rmThrowsAfterCommit=true;const original=f.fake.run.bind(f.fake);let ambiguous=true;
    f.fake.run=async args=>{if(ambiguous&&args[0]==='container'&&args[2]==='c'.repeat(64)&&!f.fake.v)throw Error('inspect timeout, NOT absence');return original(args);};
    assert.equal((await f.reopen().recoverUnstarted(f.handle)).confirmed,false);
    const r=await f.journal.read('run1');assert.ok(r.unstartedCancellation);assert.equal(r.unstartedCancellation.confirmedAt,null);assert.notEqual(r.phase,'REMOVED');
    ambiguous=false;assert.equal((await f.reopen().recoverUnstarted(f.handle)).confirmed,true);assert.equal(f.fake.calls.filter(a=>a[0]==='rm').length,1);
  }finally{await f.cleanup();}
});

test('UNIT start fence fsync failure prevents actual transport.start; durable NOT_DISPATCHED remains recoverable, never inferred from phase',async()=>{
  const f=await fixture(),open=fs.open;let fired=false;try {
    const original=f.fake.run.bind(f.fake);f.fake.run=async args=>{
      if(args[0]==='start')assert.equal((await f.journal.read('run1')).startDispatch,'MAY_HAVE_BEEN_DISPATCHED','durable claim must precede EVERY actual dispatch');
      const result=await original(args);if(args[0]==='create')f.fake.v.State.StartedAt=zero;return result;
    };
    fs.open=async function(...args:Parameters<typeof fs.open>){const fd=await open(...args),name=String(args[0]),sync=fd.sync.bind(fd);
      fd.sync=async()=>{if(!fired&&name.startsWith(path.join(f.journal.directory,'run1.json.'))){const r=JSON.parse(await fs.readFile(name,'utf8'));if(r.startDispatch==='MAY_HAVE_BEEN_DISPATCHED'){fired=true;throw Error('Injected start claim fsync EIO');}}return sync();};return fd;};syncBuiltinESMExports();
    await assert.rejects(f.executor.start(f.plan));assert.equal(fired,true);assert.equal(f.fake.calls.some(a=>a[0]==='start'),false);
    assert.equal((await f.journal.read('run1')).startDispatch,'NOT_DISPATCHED');
  }finally{fs.open=open;syncBuiltinESMExports();}
  try{assert.equal((await f.executor.recoverUnstarted((await f.journal.read('run1')).handle)).confirmed,true);}finally{await f.cleanup();}
});

test('UNIT actual native claim readback is visible before transport.start; uncertain start can never be revoked or collected as no-process',async()=>{
  const f=await fixture();try {
    const original=f.fake.run.bind(f.fake);let observed=false;
    f.fake.run=async args=>{if(args[0]==='start'){
      const record=await new DurableRunJournal(f.journal.directory,'install').read('run1');assert.equal(record.startDispatch,'MAY_HAVE_BEEN_DISPATCHED');assert.equal(record.containerId,'c'.repeat(64));observed=true;
    }return original(args);};
    const h=await f.executor.start(f.plan);assert.equal(observed,true);assert.equal((await f.executor.recoverUnstarted(h)).confirmed,false);
    assert.ok(!f.fake.calls.some(a=>a[0]==='logs'||a[0]==='rm'));
  }finally{await f.cleanup();}
});

test('UNIT actual journal directory sync failure after final rename: visible REMOVED is not yet a receipt; reflush/readback admits without another rm',async()=>{
  const f=await createdFixture(),open=fs.open;let failures=0;try {
    fs.open=async function(...args:Parameters<typeof fs.open>){const fd=await open(...args),name=String(args[0]),sync=fd.sync.bind(fd);
      fd.sync=async()=>{if(name===f.journal.directory){const r=JSON.parse(await fs.readFile(path.join(name,'run1.json'),'utf8'));if(r.phase==='REMOVED'){failures++;throw Object.assign(Error('Injected final directory fsync EIO'),{code:'EIO'});}}return sync();};return fd;};syncBuiltinESMExports();
    assert.equal((await f.reopen().recoverUnstarted(f.handle)).confirmed,false);assert.equal((await f.journal.read('run1')).phase,'REMOVED');
    assert.equal((await f.reopen().recoverUnstarted(f.handle)).confirmed,false,'read-only bytes do not bypass a still-failing durability acknowledgement');
    assert.ok(failures>=2);assert.equal(f.fake.calls.filter(a=>a[0]==='rm').length,1);
  }finally{fs.open=open;syncBuiltinESMExports();}
  try{assert.equal((await f.reopen().recoverUnstarted(f.handle)).confirmed,true);assert.equal(f.fake.calls.filter(a=>a[0]==='rm').length,1);}finally{await f.cleanup();}
});
