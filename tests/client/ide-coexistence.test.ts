import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';import {setTimeout as delay} from 'node:timers/promises';
import {fixture} from '../snapshots/helpers';import {snapshotAllowed} from '../../src/server/SnapshotStorage';import {buildContext,isContextPathAllowed,isCoachWriteAllowed} from '../../src/server/coach/context';import {readRunSourceInventory} from '../../src/server/execution/ImmutableInput';

test('IDE metadata is not traversed, observed, snapshotted, sent to AI or copied into Run; source edits still reconcile',{timeout:15000},async t=>{
 const f=fixture(t,{'a.java':'class A { int value = 1; }\n'});f.workspace.updateSettings({...f.workspace.settings,aiConsent:true,contextPatterns:['**/*']});
 const snapshot=f.workspace.createSnapshot('Before IDE');const version=f.workspace.workspaceVersion;const events:any[]=[];f.workspace.on('external',e=>events.push(e));
 const dirs=['.idea','.git','target'];const metadata:Record<string,string>={'.gitignore':'target/\n','module.iml':'IDE module','module.IPR':'IDE project','module.iws':'IDE workspace'};
 try{
  for(const dir of dirs){fs.mkdirSync(f.file(dir));fs.writeFileSync(f.file(dir+'/unreadable-data'),'x'.repeat(1048577));if(process.platform!=='win32')fs.chmodSync(f.file(dir),0);}
  for(const [name,content] of Object.entries(metadata))fs.writeFileSync(f.file(name),content);
  await delay(800);assert.equal(f.workspace.workspaceVersion,version);assert.equal(events.length,0,'metadata does not wake the coach or invalidate source versions');
  assert.deepEqual(f.workspace.listFiles().filter(x=>x.kind==='FILE').map(x=>x.path),['a.java']);
  assert.deepEqual(f.workspace.createSnapshot('With IDE').paths,['a.java']);
  assert.deepEqual((await readRunSourceInventory(f.root)).map(x=>x.path),['a.java']);
  const ctx=buildContext(f.workspace,f.session.getSession(),[],null,[]);assert.deepEqual(ctx.documents.map(d=>d.path),['a.java']);
  for(const name of [...Object.keys(metadata),...dirs.map(d=>d+'/unreadable-data')]){
   assert.equal(isContextPathAllowed(name),false,name);assert.equal(snapshotAllowed(name),false,name);
   assert.equal(isCoachWriteAllowed(name,f.workspace.settings),false,name);assert.throws(()=>f.workspace.getDocument(name));
  }
  fs.writeFileSync(f.file('a.java'),'class A { int value = 2; }\n');const deadline=Date.now()+5000;
  while(!events.some(e=>e.path==='a.java')){if(Date.now()>deadline)throw Error('external source sync timeout');await delay(20);}
  assert.match(f.workspace.getDocument('a.java').content,/value = 2/);
  await f.restore(snapshot.snapshotId,['a.java']);assert.match(f.workspace.getDocument('a.java').content,/value = 1/);
 }finally{for(const dir of dirs)if(fs.existsSync(f.file(dir))&&process.platform!=='win32')fs.chmodSync(f.file(dir),0o700);}
 for(const [name,content] of Object.entries(metadata))assert.equal(fs.readFileSync(f.file(name),'utf8'),content,'metadata preserved after restore');
 for(const dir of dirs)assert.equal(fs.statSync(f.file(dir+'/unreadable-data')).size,1048577,'IDE/build data preserved');
});
