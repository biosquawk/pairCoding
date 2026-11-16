import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {createPairCoachServer} from '../../src/server/http';
import {LiveBackend} from '../../src/services/LiveBackend';
async function until(predicate:()=>boolean){const end=Date.now()+10000;while(!predicate()){if(Date.now()>end)throw Error('Policy reply not observed');await delay(10);}}
for(const policy of ['PAUSED','MUTED','NO_CONSENT','BLURRED'] as const)test(`explicit chat explains ${policy}, preserves policy, and does not queue a hidden analysis`,{timeout:30000},async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'coach-policy-'));
  fs.mkdirSync(path.join(root,'.paircoach'),{mode:0o700});fs.writeFileSync(path.join(root,'task.md'),'# Current task');
  fs.writeFileSync(path.join(root,'.paircoach/settings.json'),JSON.stringify({schemaVersion:2,taskMode:'IMPLEMENTATION',taskFilePath:'task.md',reviewNotesPath:'review.md',contextPatterns:['*.md'],runProfiles:[],aiConsent:policy!=='NO_CONSENT'}),{mode:0o600});
  let calls=0;
  const app=createPairCoachServer({rootPath:root,port:0,enableCoach:true,runtimeEnvironment:{},runtimeArguments:['--runtime-config',path.join(root,'absent.json')],
    coachProvider:{name:'controlled-not-live-AI',mode:'INJECTED',decide:async()=>{calls++;return {kind:'REPLY',text:'Controlled model response'};}}});
  const port=await app.listen(),client=new LiveBackend({baseUrl:`http://127.0.0.1:${port}`});
  app.session.restoreProgress({lifecycle:'RUNNING',timer:{...app.session.getSession().timer,elapsedMs:243,manualPaused:policy==='PAUSED'},activeFilePath:'task.md'});
  t.after(async()=>{client.close();await app.close();fs.rmSync(root,{recursive:true,force:true});});
  await client.connect();await until(()=>!client.getState().isOffline);client.sendWindowState('FOCUSED');
  await until(()=>app.session.state.presence==='FOCUSED');
  if(policy==='PAUSED'){client.pauseTimer();await until(()=>app.session.getSession().timer.manualPaused);}
  if(policy==='MUTED'){app.session.mute(null);await until(()=>client.getState().coachMode==='MUTED_MANUAL');}
  if(policy==='BLURRED'){client.sendWindowState('BLURRED');await until(()=>app.session.state.presence==='BLURRED');}
  assert.equal(await client.sendChatMessage('Explain the current task'),true);
  await until(()=>client.getState().chatEntries.some(e=>e.sender==='COACH'));
  const reply=client.getState().chatEntries.find(e=>e.sender==='COACH')!.message;
  assert.match(reply,{PAUSED:/Wznów trening/,MUTED:/wyciszony/,NO_CONSENT:/zgody/,BLURRED:/aktywnego okna/}[policy]);
  assert.equal(calls,0,'policy explanation is not a fabricated model response');
  if(policy==='PAUSED'){
    assert.equal(app.session.getSession().timer.manualPaused,true);
    client.resumeTimer();await until(()=>app.session.getSession().timer.status==='RUNNING');
    await delay(100);assert.equal(calls,0,'refused question is not deferred until resume');
    assert.equal(await client.sendChatMessage('Now answer explicitly'),true);
    await until(()=>client.getState().chatEntries.some(e=>e.message==='Controlled model response'));assert.equal(calls,1);
  }
  if(policy==='MUTED'){
    client.pauseTimer();await until(()=>app.session.getSession().timer.manualPaused);
    client.resumeTimer();await until(()=>!app.session.getSession().timer.manualPaused);
    assert.equal(app.session.getSession().coachMode,'MUTED_MANUAL','resume cannot unmute');assert.equal(calls,0);
  }
  if(policy==='NO_CONSENT')assert.equal(app.workspace.settings.aiConsent,false);
});
