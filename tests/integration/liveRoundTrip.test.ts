import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WebSocket } from 'ws';
import { createPairCoachServer } from '../../src/server/http';
import { LiveBackend } from '../../src/services/LiveBackend';
const pause=(ms:number)=>new Promise(r=>setTimeout(r,ms));
async function until(predicate:()=>boolean) { const deadline=Date.now()+3000;while(!predicate()){if(Date.now()>deadline)throw new Error('Live roundtrip deadline');await pause(10);} }
async function fixture(t:any) {
  const parent=fs.mkdtempSync(path.join(os.tmpdir(),'paircoach-live-real-')),root=path.join(parent,'workspace');fs.mkdirSync(root);
  fs.writeFileSync(path.join(root,'challenge.md'),'# Real task\n');fs.writeFileSync(path.join(root,'solution.ts'),'const start = true;\n');
  const app=createPairCoachServer({rootPath:root,dataDir:path.join(root,'.paircoach'),port:0});const port=await app.listen();
  const stored=new Map<string,string>();
  const live=new LiveBackend({baseUrl:`http://127.0.0.1:${port}`,clientId:'real-client',socket:url=>new WebSocket(url) as any,storage:{getItem:k=>stored.get(k)??null,setItem:(k,v)=>{stored.set(k,v);},removeItem:k=>{stored.delete(k);}}});
  t.after(async()=>{live.close();await app.close();fs.rmSync(parent,{recursive:true,force:true});});
  await live.connect();await until(()=>!live.getState().isOffline);await live.selectFile('solution.ts');
  return {root,app,live,stored};
}

test('real LIVE client bootstrap+REST+WS autosave and reload matches disk (TEST001/004)',async t=>{
  const {live,root,app}=await fixture(t);
  for(let n=0;n<12;n++){live.saveFileContent('solution.ts',`const student = ${n};\n`);await pause(25);}
  await live.flushAll();
  assert.equal(fs.readFileSync(path.join(root,'solution.ts'),'utf8'),'const student = 11;\n');
  assert.equal(app.workspace.getDocument('solution.ts').content,'const student = 11;\n');
  assert.deepEqual(live.getState().pendingPaths,[]);
  assert.equal(live.getState().files.find(f=>f.path==='solution.ts')?.content,'const student = 11;\n');
  live.reconnect();await until(()=>!live.getState().isOffline);
  assert.equal(live.getState().files.find(f=>f.path==='solution.ts')?.content,'const student = 11;\n');
});

test('real external IDE vs local draft preserves both and explicit choice saves only selected version (TEST005)',async t=>{
  const {live,root}=await fixture(t);
  live.saveFileContent('solution.ts','const localDraft = 2;\n');
  fs.writeFileSync(path.join(root,'solution.ts'),'const external = 3;\n');
  await until(()=>live.getState().fileConflict!==null);
  assert.equal(live.getState().fileConflict?.localDraftContent,'const localDraft = 2;\n');
  assert.equal(live.getState().fileConflict?.diskContent,'const external = 3;\n');
  await pause(200);assert.equal(fs.readFileSync(path.join(root,'solution.ts'),'utf8'),'const external = 3;\n');
  live.resolveConflict('KEEP_LOCAL');await live.flushAll();
  assert.equal(fs.readFileSync(path.join(root,'solution.ts'),'utf8'),'const localDraft = 2;\n');
});
