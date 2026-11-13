import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {HeaderBar} from '../../src/components/HeaderBar';
import {createPairCoachServer} from '../../src/server/http';
import {LiveBackend} from '../../src/services/LiveBackend';
async function until(fn:()=>boolean){const end=Date.now()+10000;while(!fn()){if(Date.now()>end)throw Error('activation timeout');await delay(20);}}
for(const consent of [true,false])test(`first committed edit starts consented observation without chat; consent=${consent}`,{timeout:30000},async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'paircoach-first-edit-'));fs.mkdirSync(path.join(root,'.paircoach'),{mode:0o700});
 fs.writeFileSync(path.join(root,'main.py'),'value = 1\n');fs.writeFileSync(path.join(root,'challenge.md'),'# Task');
 fs.writeFileSync(path.join(root,'.paircoach/settings.json'),JSON.stringify({schemaVersion:2,taskMode:'IMPLEMENTATION',taskFilePath:'challenge.md',reviewNotesPath:'review.md',contextPatterns:['**/*'],runProfiles:[],aiConsent:consent}),{mode:0o600});
 let calls=0;
 const app=createPairCoachServer({rootPath:root,port:0,enableCoach:true,runtimeEnvironment:{},runtimeArguments:['--runtime-config',path.join(root,'missing.json')],coachProvider:{name:'activation',mode:'INJECTED',decide:async c=>{calls++;assert.equal(c.trigger?.reason,'EDIT');assert.ok(c.documents.find(d=>d.path==='main.py')?.content.includes('2'));return {kind:'SILENT',reason:'no new hint needed'};}}});
 const port=await app.listen(),client=new LiveBackend({baseUrl:`http://127.0.0.1:${port}`});
 t.after(async()=>{client.close();await app.close();fs.rmSync(root,{recursive:true,force:true});});
 await client.connect();await until(()=>!client.getState().isOffline);client.sendWindowState('FOCUSED');await client.selectFile('main.py');
 assert.equal(calls,0);assert.equal(app.session.getSession().lifecycle,'READY');
 const markup=renderToStaticMarkup(createElement(HeaderBar,{...client.getState(),taskMode:'IMPLEMENTATION',executionStatus:'IDLE',isDevSimulatorOpen:false} as any));
 if(consent)assert.match(markup,/Trener:.*Gotowy/);
 else assert.doesNotMatch(markup,/Trener:.*Gotowy/);
 client.saveFileContent('main.py','value = 2\n');await until(()=>client.getState().pendingPaths.length===0);
 assert.equal(fs.readFileSync(path.join(root,'main.py'),'utf8'),'value = 2\n');
 if(!consent){await delay(500);assert.equal(calls,0);assert.equal(app.session.getSession().lifecycle,'READY');return;}
 await until(()=>calls===1);assert.equal(app.session.getSession().lifecycle,'RUNNING');
 client.pauseTimer();await until(()=>app.session.getSession().timer.manualPaused);
 client.saveFileContent('main.py','value = 3\n');await until(()=>client.getState().pendingPaths.length===0);await delay(500);assert.equal(calls,1,'manual pause is preserved');
});
