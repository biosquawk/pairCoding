/** NEW compatibility-only modeled transport. Stops at first tag; never runs prepare. */
import * as fs from 'node:fs';
import path from 'node:path';
import {fixture,guard,hash,dockerModel,json,put} from './fixture.mjs';
const config=json(process.argv[2]),callbacks=[],realNow=Date.now;let offset=0,model,plan,effects=0;
Date.now=()=>realNow()+offset;
try {
 const f=await fixture({after:fn=>callbacks.push(fn)});
 plan=await f.m.buildRecoveryPlan({...f.o,outputRoot:path.join(f.dir,'compat-output'),...(config.required?{checkpointMode:'REQUIRED_V1'}:{})});
 const bytes=f.m.planBytes(plan),ph=hash(bytes),gb=Buffer.from(JSON.stringify(guard(plan,ph,f.dir)));model=dockerModel(plan);
 let firstCommandAt;
 model.hook=args=>{
  firstCommandAt??=realNow();
  if(args[0]==='ps')offset+=config.offsetMs??0;
  if(config.timeout && model.calls.length===76)offset=plan.limits.maxElapsedMs-(realNow()-firstCommandAt)-5000;
  if(args[0]==='tag'){effects++;throw new Error('UNIT_STOP_AT_FIRST_MODELED_MUTATION');}
 };
 // Literal unchanged legacy call shape; REQUIRED explicitly uses real inherited pipe, no callback.
 if(config.required)await f.m.executeRecoveryPlan(bytes,ph,gb,hash(gb),{spawnSync:model.spawn,checkpointMode:'REQUIRED_V1'});
 else await f.m.executeRecoveryPlan(bytes,ph,gb,hash(gb),{spawnSync:model.spawn});
 throw new Error('unexpected full preparation');
} catch(e) {
 const receipt=plan && fs.existsSync(path.join(plan.options.outputRoot,'receipt.json'))?json(path.join(plan.options.outputRoot,'receipt.json')):null;
 put(path.join(config.dir,'result.json'),{error:e.message,effects,calls:model?.calls??[],receipt});
 process.exitCode=effects===1 && e.message==='UNIT_STOP_AT_FIRST_MODELED_MUTATION'?0:1;
} finally {Date.now=realNow;for(const fn of callbacks.reverse())fn();}
