import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {LiveBackend} from '../../src/services/LiveBackend';
import {createPairCoachServer} from '../../src/server/http';

async function until(predicate: () => boolean) {
  const deadline=Date.now()+10000;
  while(!predicate()) {
    if(Date.now()>deadline)throw Error('Client state did not settle');
    await delay(20);
  }
}

test('second tab explains the lease conflict without retrying or taking control; explicit reconnect works after owner closes', {timeout:30000}, async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'paircoach-lease-conflict-'));
  fs.writeFileSync(path.join(root,'challenge.md'),'# Java exercise\n');
  const app=createPairCoachServer({rootPath:root,dataDir:path.join(root,'.paircoach'),port:0,devBootstrap:true});
  const port=await app.listen(),baseUrl=`http://127.0.0.1:${port}`;
  let reads=0;
  const first=new LiveBackend({baseUrl,clientId:'original-tab'});
  const second=new LiveBackend({baseUrl,clientId:'new-tab',fetch:((url,options)=>{
    if(new URL(String(url)).pathname==='/api/project')reads++;
    return fetch(url,options);
  }) as typeof fetch});
  t.after(async()=>{first.close();second.close();await app.close();fs.rmSync(root,{recursive:true,force:true});});
  await first.connect();await until(()=>!first.getState().isOffline);
  await second.connect();
  await until(()=>/LEASE_CONFLICT/.test(second.getState().connectionError??''));
  assert.match(second.getState().connectionError!,/karta|okno/i);
  assert.match(second.getState().connectionError!,/Połącz ponownie/);
  assert.equal(second.getState().isOffline,true);
  assert.equal(second.getState().writeOwner,'SYNCING');
  assert.equal(first.getState().isOffline,false,'the current owner is not evicted');
  await delay(1100);
  assert.equal(reads,1,'an authority conflict cannot be fixed by blind automatic retries');
  first.close();await delay(100);
  second.reconnect();await until(()=>!second.getState().isOffline);
  assert.equal(second.getState().connectionError,null);
  assert.ok(second.getState().files.some(file=>file.path==='challenge.md'));
  assert.equal(fs.readFileSync(path.join(root,'challenge.md'),'utf8'),'# Java exercise\n');
});
