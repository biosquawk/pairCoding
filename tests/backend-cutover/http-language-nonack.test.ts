/** NEW actual caller counter required HUMAN506625/616. Real HTTP+FIFO+filesystem+source+registry,
 * synthetic Docker process/OCI/preparation ONLY. This is not final Docker/LSP/native proof. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {httpLanguage,until} from './http-language-owner-fixture';

test('HTTP LANG closed inactive external B refreshes full generation after SAME occupied FIFO; unchanged active A needs no new overlay',async t=>{
  const f=await httpLanguage(t),p=f.peer,d=f.document(p);p.send('LANGUAGE_OPEN',d);
  await until(()=>f.driver.frames.filter(m=>m.method==='textDocument/didOpen').length>=2,'Both real HTTP lanes sent A');
  f.driver.diagnostics(f.path);const original=await p.wait(m=>m.type==='DIAGNOSTICS'&&m.payload.items.length===1);
  await until(()=>![...f.driver.containers.values()].some(c=>c.labels['paircoach.phase']==='diagnostics'),'Original analysis completed and actually retired');
  const creates=f.driver.commands.filter(a=>a[0]==='create').length;
  let release!:()=>void,entered!:()=>void;
  const barrier=new Promise<void>(r=>{release=r;}),inside=new Promise<void>(r=>{entered=r;});
  const held=f.app.workspace._withQueuedMutation(async()=>{
    fs.writeFileSync(path.join(f.workspace,'inactive.txt'),'B changed without a Monaco model\n');
    // Genuine disk observer under an existing actual FIFO, not an injected changed/file callback.
    assert.throws(()=>f.app.workspace._fresh('inactive.txt',1),{code:'DISK_CONFLICT'});
    entered();await barrier;
  });
  try {
    await inside;
    await p.wait(m=>m.type==='DIAGNOSTICS'&&m.seq>original.seq&&m.payload.items.length===0);
    assert.equal(f.driver.commands.filter(a=>a[0]==='create').length,creates,'Synchronous revoke never recaptures/starts from inside the occupied queue');
    release();await held;
  } finally {release();await held;}
  await until(()=>[...f.driver.containers.values()].some(c=>c.labels['paircoach.phase']==='diagnostics'),'Deferred real registry generation starts WITHOUT another language model event');
  const current=[...f.driver.containers.values()].find(c=>c.labels['paircoach.phase']==='diagnostics')!;
  const create=f.driver.commands.find(a=>a[0]==='create'&&a.includes(current.name))!;
  const mount=create.find(a=>a.startsWith('type=bind,src=')&&a.includes(',dst=/workspace,'))!;
  const shadow=mount.slice('type=bind,src='.length,mount.indexOf(',dst='));
  assert.equal(fs.readFileSync(path.join(shadow,'inactive.txt'),'utf8'),'B changed without a Monaco model\n');
  assert.equal(fs.readFileSync(path.join(shadow,f.path),'utf8'),d.content,'ALL overlays retained; A is not re-invented from disk');
  f.driver.diagnostics(f.path);
  const fresh=await p.wait(m=>m.type==='DIAGNOSTICS'&&m.payload.items.length===1&&m.payload.provenance.launchId!==original.payload.provenance.launchId);
  assert.deepEqual(fresh.payload.sourceStamp,original.payload.sourceStamp);assert.equal(fresh.payload.association,null);
  assert.notEqual(fresh.payload.provenance.inputManifestSha256,original.payload.provenance.inputManifestSha256);
});

test('HTTP LANG authorized closed file create/rename/delete each feeds genuine fresh inventory without new active model',async t=>{
  const f=await httpLanguage(t),p=f.peer,d=f.document(p);p.send('LANGUAGE_OPEN',d);
  await until(()=>f.driver.frames.filter(m=>m.method==='textDocument/didOpen').length>=2,'Both HTTP lanes sent A');
  f.driver.diagnostics(f.path);let prior=await p.wait(m=>m.type==='DIAGNOSTICS'&&m.payload.items.length===1);
  const steps=[{operation:'CREATE',path:'closed.java',newPath:null,content:'class Closed {}\n'},
    {operation:'RENAME',path:'closed.java',newPath:'renamed.java',content:null},
    {operation:'DELETE',path:'renamed.java',newPath:null,content:null}] as const;
  let project=p.snapshot.payload.project;
  for(const step of steps) {
    await until(()=>![...f.driver.containers.values()].some(c=>c.labels['paircoach.phase']==='diagnostics'),'Previous actual diagnostic owner retired');
    const result=await f.http('/api/file','POST',{requestId:crypto.randomUUID(),clientId:f.clientId,sessionId:f.sessionId,
      controlEpoch:f.app.session.state.controlEpoch,...step,baseVersion:step.operation==='CREATE'?null:project.files.find((x:{path:string})=>x.path===step.path).version});
    assert.equal(result.status,200,JSON.stringify(result.value));project=result.value;
    await until(()=>[...f.driver.containers.values()].some(c=>c.labels['paircoach.phase']==='diagnostics'),'A new real diagnostic generation follows '+step.operation);
    const current=[...f.driver.containers.values()].find(c=>c.labels['paircoach.phase']==='diagnostics')!;
    const create=f.driver.commands.find(a=>a[0]==='create'&&a.includes(current.name))!;
    const mount=create.find(a=>a.startsWith('type=bind,src=')&&a.includes(',dst=/workspace,'))!;
    const shadow=mount.slice('type=bind,src='.length,mount.indexOf(',dst='));
    assert.equal(fs.readFileSync(path.join(shadow,f.path),'utf8'),d.content);
    assert.equal(fs.existsSync(path.join(shadow,'closed.java')),step.operation==='CREATE');
    assert.equal(fs.existsSync(path.join(shadow,'renamed.java')),step.operation==='RENAME');
    f.driver.diagnostics(f.path);
    const previous=prior;prior=await p.wait(m=>m.type==='DIAGNOSTICS'&&m.payload.items.length===1&&m.payload.provenance.launchId!==previous.payload.provenance.launchId&&m.seq>previous.seq);
    assert.deepEqual(prior.payload.sourceStamp,d.stamp);assert.equal(prior.payload.association,null);
    assert.notEqual(prior.payload.provenance.inputManifestSha256,previous.payload.provenance.inputManifestSha256);
  }
});
