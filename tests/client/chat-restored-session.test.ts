import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {createPairCoachServer} from '../../src/server/http';
import {LiveBackend} from '../../src/services/LiveBackend';

async function until(predicate:()=>boolean) {
  const deadline=Date.now()+5000;
  while(!predicate()){if(Date.now()>deadline)throw Error('Chat state did not settle');await delay(20);}
}
for (const paused of [false,true]) test(`restored RUNNING chat preserves manual pause=${paused}`,{timeout:15000},async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'paircoach-chat-restored-'));
  fs.mkdirSync(path.join(root,'.paircoach'),{mode:0o700});
  fs.writeFileSync(path.join(root,'challenge.md'),'# Exercise');
  fs.writeFileSync(path.join(root,'.paircoach/settings.json'),JSON.stringify({schemaVersion:2,taskMode:'IMPLEMENTATION',taskFilePath:'challenge.md',reviewNotesPath:'review.md',contextPatterns:['*.md'],runProfiles:[],aiConsent:true}),{mode:0o600});
  let calls=0;
  const app=createPairCoachServer({rootPath:root,port:0,enableCoach:true,runtimeEnvironment:{},runtimeArguments:['--runtime-config',path.join(root,'missing-runtime.json')],coachProvider:{name:'restored-test',mode:'INJECTED',decide:async context=>{calls++;assert.equal(context.trigger?.reason,'CHAT');return {kind:'REPLY',text:'Restored reply'};}}});
  const port=await app.listen();
  const saved=app.session.getSession();
  app.session.restoreProgress({lifecycle:'RUNNING',timer:{...saved.timer,elapsedMs:1234,manualPaused:paused,serverTime:'2020-01-01T00:00:00Z'},activeFilePath:saved.activeFilePath});
  await delay(30);
  assert.equal(app.session.getSession().timer.elapsedMs,1234,'offline time is not counted');
  assert.equal(app.session.canCoach(),false,'old lease is not restored');
  assert.equal(app.session.getSession().writeOwner,'STUDENT');
  const client=new LiveBackend({baseUrl:`http://127.0.0.1:${port}`});
  t.after(async()=>{client.close();await app.close();fs.rmSync(root,{recursive:true,force:true});});
  await client.connect();await until(()=>!client.getState().isOffline);client.sendWindowState('FOCUSED');
  await until(()=>app.session.leaseClientId!==null);
  assert.equal(app.session.getSession().timer.manualPaused,paused);
  assert.equal(await client.sendChatMessage('Question after reopen'),true);
  if(paused){await delay(150);assert.equal(calls,0);assert.equal(app.session.getSession().timer.manualPaused,true);assert.equal(app.session.getSession().timer.status,'PAUSED');}
  else {await until(()=>client.getState().chatEntries.some(entry=>entry.sender==='COACH'&&entry.message==='Restored reply'));assert.equal(calls,1);assert.equal(app.session.getSession().timer.status,'RUNNING');}
});
