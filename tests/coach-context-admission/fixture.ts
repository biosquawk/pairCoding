/** Building-block UNIT composition, NOT HTTP/LIVE. Actual startup/core, gate/FIFO,
 * RuntimeLanguageSource, owner.readProjection, registry and CoachAdapter. Only existing
 * preparation/OCI/Docker process observations and model decisions are injected. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import type {TestContext} from 'node:test';
import {fixture as assets} from '../runtime-language-binding/fixture';
import {createRuntimeStartup} from '../../src/server/runtime-coordinator/RuntimeStartup';
import {createRuntimeExecutionLayout} from '../../src/server/runtime-coordinator/RuntimeExecutionLayout';
import {RuntimeLanguageOwner} from '../../src/server/runtime-coordinator/RuntimeLanguageOwner';
import {CoachAdapter, type CoachOptions, type CoachProvider} from '../../src/server/CoachAdapter';
import type {CoachContext} from '../../src/server/coach/context';
export const barrier=()=>{let resolve!:()=>void;const promise=new Promise<void>(r=>resolve=r);return {promise,resolve};};
export const tick=async()=>{for(let i=0;i<12;i++)await new Promise<void>(r=>setImmediate(r));};
export async function until(check:()=>boolean,detail:string){const deadline=Date.now()+5000;while(!check()&&Date.now()<deadline)await new Promise(r=>setTimeout(r,5));assert.ok(check(),detail);}
export const chat=(messageId:string,text='Help with current code')=>({messageId,text,author:'STUDENT' as const,createdAt:'2026-11-12T04:00:00Z'});
export async function composed(t:TestContext, options:{legacy?:boolean;provider?:CoachProvider;
  readContext?:CoachOptions['readContext'];onProposal?:CoachOptions['onProposal']}={}) {
  let cleanup=async()=>{};t.after(()=>cleanup());
  const f=await assets(t,'java-maven'),runtime=f.lease().runtime,run=f.lease().run;
  f.driver.beforeCreate=null;
  fs.mkdirSync(path.join(f.workspace,'.paircoach'),{mode:0o700});
  fs.writeFileSync(path.join(f.workspace,'.paircoach','settings.json'),JSON.stringify({schemaVersion:2,taskFilePath:null,taskMode:'IMPLEMENTATION',reviewNotesPath:'review.md',runProfiles:[run],aiConsent:true,contextPatterns:['**/*']}));
  fs.writeFileSync(path.join(f.root,'catalog.json'),JSON.stringify({...runtime.catalog,profiles:runtime.catalog.profiles.filter(p=>p.adapterFamily==='java-maven')}));
  fs.writeFileSync(path.join(f.root,'lock.json'),JSON.stringify({schemaVersion:1,images:[...runtime.imageLock.images,...runtime.catalog.profiles.filter(p=>p.adapterFamily==='java-maven'&&p.id!==runtime.profile.id).map(p=>({...runtime.image,key:p.imageLockKey,image:'paircoach/runtime-'+p.id+':stage09',tools:p.expectedTools}))]}));
  fs.writeFileSync(runtime.configPath,JSON.stringify(runtime.config));
  const startup=await createRuntimeStartup({argv:['--runtime-config',runtime.configPath,'--prepared-runtime',f.options.selected.preparedOutputRoots[0],'--language-receipt',f.options.selected.languageReceiptPath!],transport:f.options.selected.transport,environment:{},explicitWorkspaceRoot:f.workspace});
  assert.ok(startup.core);assert.ok(startup.configuration.resolved);
  const core=startup.core;core.session.claimLease('tab');
  const layout=createRuntimeExecutionLayout(path.join(f.root,'application-state'),f.workspace,core.workspace.projectId);
  let current=true,reads=0;const signals:AbortSignal[]=[],contexts:Readonly<CoachContext>[]=[],events:{type:string;payload:any}[]=[];
  const owner=new RuntimeLanguageOwner({startup,layout,driver:f.driver,transport:f.options.selected.transport,admission:f.admission,assertCurrent(){assert.ok(current,'Captured binding remains current');}});
  const project=<T>(read:()=>T,signal:AbortSignal)=>{signals.push(signal);return owner.readProjection(async()=>{signal.throwIfAborted();assert.ok(current);reads++;const result=read();signal.throwIfAborted();assert.ok(current);return result;});};
  const adapter=new CoachAdapter({workspace:core.workspace,session:core.session,gate:core.gate,canAnalyze:()=>current,
    ...(options.legacy?{}:{readContext:options.readContext??project}),
    provider:options.provider??{name:'UNIT_DECISION',mode:'INJECTED',async decide(c){contexts.push(c);return {kind:'SILENT',reason:'UNIT no mutation'};}},
    emit:(type,payload)=>events.push({type,payload}),onProposal:options.onProposal??(()=>{})});
  const entered=barrier(),resume=barrier();let held=false;
  f.hook(async args=>{if(args[0]==='info'&&!held){held=true;entered.resolve();await resume.promise;}});
  cleanup=async()=>{resume.resolve();f.hook(null);adapter.close();await tick();await owner.retire();startup.close();};
  await owner.connect({id:'transport',clientId:'tab',connectionGeneration:'same-peer',assertCurrent(){core.session.assertClient('tab',core.session.state.sessionId);},emit(){}});
  owner.published();await entered.promise;
  // This is a REAL selected-source capture holding the actual gate, not an invented delay.
  assert.throws(()=>core.workspace.listFiles(),{code:'WORKSPACE_BUSY'});
  assert.equal(f.driver.commands.filter(a=>a[0]==='create').length,0);
  const start=()=>{core.session.start(null,true);adapter.trigger('START');};
  const release=async()=>{resume.resolve();await core.workspace._withQueuedMutation(async()=>{});await tick();};
  return {f,core,owner,adapter,contexts,events,signals,project,start,release,
    get reads(){return reads;},revokeBinding(){current=false;},setCurrent(){current=true;}};
}
