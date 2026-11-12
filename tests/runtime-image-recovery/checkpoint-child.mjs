/** NEW UNIT-only child support. Real inherited stdin pipe + production barrier. No Docker.
 * Date offset is ONLY here to model a >60s RO preflight without minute-long sleeps.
 * Not loaded by controller CLI; no runtime env/module override exists. */
import * as fs from 'node:fs';
import path from 'node:path';
import * as production from '../../scripts/runtime-operator-image-recovery.mjs';
import { fixture,guard,hash,dockerModel,json,put } from './fixture.mjs';
const config=json(process.argv[2]), realNow=Date.now;let offset=0,effects=0,audit={},callbacks=[];
Date.now=()=>realNow()+offset;
const resultFile=path.join(config.dir,'result.json'), effect=()=>{effects++;put(path.join(config.dir,'effects.json'),{effects});};
try {
 if(config.integration){
  const f=await fixture({after:fn=>callbacks.push(fn)}), plan=await f.plan('checkpoint-only-output'),bytes=f.m.planBytes(plan),ph=hash(bytes),gb=Buffer.from(JSON.stringify(guard(plan,ph,f.dir))),model=dockerModel(plan);
  model.hook=args=>{if(args[0]==='ps')offset+=61001;if(args[0]==='tag'){effect();throw new Error('UNIT_STOP_AT_FIRST_MODELED_MUTATION');}};
  try{await f.m.executeRecoveryPlan(bytes,ph,gb,hash(gb),{spawnSync:model.spawn});throw new Error('unexpected full prepare');}
  catch(e){const receipt=json(path.join(plan.options.outputRoot,'receipt.json'));put(resultFile,{error:e.message,effects,receipt,readonlyCommands:model.calls.filter(a=>!['tag','pull','build','create','start','rm'].includes(a[0])).length,mutatingCommands:model.calls.filter(a=>['tag','pull','build','create','start','rm'].includes(a[0])),initialGuardAgeMs:Date.now()-JSON.parse(gb).observedAtMs,adaptedController:fs.readFileSync(f.file,'utf8')});if(e.message!=='UNIT_STOP_AT_FIRST_MODELED_MUTATION')process.exitCode=1;}
 } else {
  // Minimal UNIT scope, not a plan admission/host source proof. execute() builds full plan.
  const plan=config.plan,ph=config.planHash,initialObservedAtMs=Date.now();offset+=config.preflightMs??61001;
  const deadline=Date.now()+(config.waitMs??2000);
  const barrier=production.freshGuardBarrier(plan,ph,deadline,audit,()=>put(path.join(config.dir,'audit.json'),audit));
  await barrier.checkpoint();
  if(config.alterEvidence)fs.appendFileSync(config.evidenceFile,'changed after accepted');
  if(config.afterAcceptMs)offset+=config.afterAcceptMs;
  if(config.reenter)await barrier.checkpoint();
  barrier.beforeFirstMutation();
  if(config.beforeDispatchMs)offset+=config.beforeDispatchMs;
  barrier.assertDispatchFreshness();effect();
  put(resultFile,{effects,audit,initialGuardAgeMs:Date.now()-initialObservedAtMs});
 }
} catch(e){put(resultFile,{error:e.message,effects,audit});process.exitCode=1;}
finally{Date.now=realNow;for(const fn of callbacks.reverse())fn();}
