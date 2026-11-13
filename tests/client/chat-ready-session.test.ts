import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {createPairCoachServer} from '../../src/server/http';
import {LiveBackend} from '../../src/services/LiveBackend';

async function until(predicate:()=>boolean) {
  const deadline=Date.now()+10000;
  while(!predicate()){if(Date.now()>deadline)throw Error('Chat state did not settle');await delay(20);}
}
for(const consent of [true,false])test(`chat in READY session: consent=${consent}, no silent wait for manual Start and no double model call`,{timeout:30000},async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'paircoach-chat-ready-'));
  fs.mkdirSync(path.join(root,'.paircoach'),{mode:0o700});
  fs.writeFileSync(path.join(root,'challenge.md'),'# Exercise');
  fs.writeFileSync(path.join(root,'.paircoach/settings.json'),JSON.stringify({schemaVersion:2,taskMode:'IMPLEMENTATION',taskFilePath:'challenge.md',reviewNotesPath:'review.md',contextPatterns:['*.md'],runProfiles:[],aiConsent:consent}),{mode:0o600});
  let calls=0,answer:(value:unknown)=>void=()=>{};
  const app=createPairCoachServer({rootPath:root,port:0,enableCoach:true,runtimeEnvironment:{},runtimeArguments:['--runtime-config',path.join(root,'missing-runtime.json')],
    coachProvider:{name:'controlled-chat',mode:'INJECTED',decide:async context=>{
      calls++;assert.equal(context.trigger?.reason,'CHAT');
      return new Promise(resolve=>{answer=resolve;});
    }}});
  const port=await app.listen(),client=new LiveBackend({baseUrl:`http://127.0.0.1:${port}`});
  t.after(async()=>{answer({kind:'REPLY',text:'Tak, jestem.'});client.close();await app.close();fs.rmSync(root,{recursive:true,force:true});});
  await client.connect();await until(()=>!client.getState().isOffline);client.sendWindowState('FOCUSED');
  assert.equal(app.session.getSession().lifecycle,'READY');
  assert.equal(await client.sendChatMessage('jestes?'),true);
  if(!consent){await delay(50);assert.equal(calls,0);assert.equal(app.session.getSession().lifecycle,'READY');assert.equal(app.session.getSession().aiStatus,'OFF');return;}
  await until(()=>calls===1&&client.getState().aiStatus==='THINKING');
  assert.equal(app.session.getSession().lifecycle,'RUNNING');
  answer({kind:'REPLY',text:'Tak, jestem.'});
  await until(()=>client.getState().chatEntries.some(entry=>entry.sender==='COACH'&&entry.message==='Tak, jestem.'));
  assert.equal(calls,1,'starting chat does not also invoke a START analysis');
  client.pauseTimer();await until(()=>app.session.getSession().timer.manualPaused);
  assert.equal(await client.sendChatMessage('Drugie pytanie podczas ręcznej pauzy'),true);
  await delay(50);assert.equal(calls,1,'explicit manual pause is preserved');
});
