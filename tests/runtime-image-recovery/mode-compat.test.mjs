import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import path from 'node:path';
import {spawn,spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {fixture,root,guard,hash,json,put,controller} from './fixture.mjs';
const childFile=fileURLToPath(new URL('./mode-compat-child.mjs',import.meta.url));
const mutation=a=>['tag','pull','build','create','start','rm'].includes(a[0]);
async function scenario(t,options={}) {
 const dir=root(t),config=path.join(dir,'config.json');put(config,{dir,...options});
 // Legacy uses an ordinary file stdin: touching a pipe/handshake would reject, not silently pass.
 const input=options.fileInput?fs.openSync(config,'r'):'pipe';
 const child=spawn(process.execPath,[childFile,config],{stdio:[input,'pipe','pipe']});if(typeof input==='number')fs.closeSync(input);
 child.stdin?.on('error',()=>{});let stdout='',stderr='',ready=0,pending='';
 const timer=setTimeout(()=>child.kill('SIGKILL'),20000);t.after(()=>clearTimeout(timer));
 child.stderr.on('data',b=>stderr+=b);
 child.stdout.on('data',b=>{
  stdout+=b;pending+=b;
  while(pending.includes('\n')){
   const i=pending.indexOf('\n'),line=pending.slice(0,i);pending=pending.slice(i+1);
   const frame=JSON.parse(line);ready++;
   if(options.timeout)continue;
   if(options.eof){child.stdin.end();continue;}
   const c=frame.checkpoint,evidenceFile=path.join(dir,'NEW-unit-external.json');put(evidenceFile,{unitOnly:true});
   const g={schemaVersion:1,operator:'ROOT',observedAtMs:c.readyAtMs,planSha256:c.planSha256,controllerSha256:c.controllerSha256,closureSha256:c.closureSha256,base:c.base,engine:c.engine,singleHeavyLane:true,
    measurements:Object.fromEntries(['vm','physical','host'].map(k=>[k,{freeBytes:20*1024**3,storagePath:k==='vm'?'/':k==='physical'?'D:\\':path.dirname(c.outputRoot),evidenceFile,evidenceSha256:hash(fs.readFileSync(evidenceFile))}]))};
   const guardUtf8=JSON.stringify(g);child.stdin.end(JSON.stringify({type:'ROOT_FRESH_GUARD_REPLY',checkpoint:c,guardUtf8,guardSha256:hash(guardUtf8)})+'\n');
  }
 });
 const end=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',(code,signal)=>resolve({code,signal}));});clearTimeout(timer);child.stdin?.destroy();
 assert.equal(end.signal,null,stderr);const result=json(path.join(dir,'result.json'));
 const record={test:t.name,...end,ready,stdout,stderr,result};
 if(process.env.MODE_COMPAT_ARTIFACTS)put(path.join(process.env.MODE_COMPAT_ARTIFACTS,hash(t.name).slice(0,12)+'.json'),record);
 return record;
}
for(const [name,options,pattern] of [
 ['unchanged legacy inline call reaches first tag without reading stdin',{fileInput:true},null],
 ['legacy >60s preflight retains stale refusal, no READY/refresh',{fileInput:true,offsetMs:61001},/guard expired before mutation/],
 ['legacy clock rollback refuses nonfuture guard at first effect',{fileInput:true,offsetMs:-61001},/guard expired before mutation/],
 ['REQUIRED explicit programmatic call uses real pipe after >60s RO',{required:true,offsetMs:61001},null],
 ['REQUIRED absent private pipe cannot fallback to valid initial guard',{required:true,fileInput:true},/private inherited ROOT stdin pipe/],
 ['REQUIRED EOF cannot fallback to valid initial guard',{required:true,eof:true},/incomplete|EOF/],
 ['REQUIRED no reply remains bounded by remaining global deadline',{required:true,timeout:true},/absolute timeout/],
])test('NEW compatibility: '+name,async t=>{
 const r=await scenario(t,options);assert.equal(r.code,pattern?1:0,r.stderr+' '+r.result.error);
 assert.equal(r.ready,options.required&&!options.fileInput?1:0);
 assert.equal(r.result.calls.filter(mutation).length,pattern?0:1);assert.equal(r.result.effects,pattern?0:1);
 assert.equal(r.result.receipt.jobs.length,0);assert.equal(r.result.receipt.status,'FAILED_RETAIN_AND_RECONCILE');
 if(pattern){assert.match(r.result.error,pattern);assert.equal(r.result.receipt.firstMutationAtMs,undefined);}
 else {assert.equal(r.result.error,'UNIT_STOP_AT_FIRST_MODELED_MUTATION');assert.ok(r.result.receipt.firstMutationAtMs);}
 if(options.timeout){assert.ok(r.result.receipt.freshGuardCheckpoint.maxWaitMs>0);assert.ok(r.result.receipt.freshGuardCheckpoint.maxWaitMs<=5000);}
 if(!options.required)assert.equal(Object.hasOwn(r.result.receipt,'freshGuardCheckpoint'),false);
});

test('NEW compatibility: closed hashbound modes, downgrade attempts and CLI discrimination (no prepare)',async t=>{
 const f=await fixture(t),legacy=await f.plan('no-effects'),required=await f.m.buildRecoveryPlan({...legacy.options,checkpointMode:'REQUIRED_V1'});
 assert.equal(Object.hasOwn(legacy,'checkpointPolicy'),false);assert.equal(Object.hasOwn(legacy.options,'checkpointMode'),false);
 assert.equal(required.options.checkpointMode,'REQUIRED_V1');assert.equal(required.checkpointPolicy.protocol,'ROOT_FRESH_GUARD_V1');
 const normalized=structuredClone(required);delete normalized.options.checkpointMode;delete normalized.checkpointPolicy;assert.deepEqual(normalized,legacy);
 const bytes=f.m.planBytes(required),ph=hash(bytes),gb=Buffer.from(JSON.stringify(guard(required,ph,f.dir)));let calls=0;
 const attempt=async(plan,deps,pattern,expected)=>{
  const b=f.m.planBytes(plan),h=expected??hash(b),g=Buffer.from(JSON.stringify(guard(plan,h,f.dir)));
  await assert.rejects(f.m.executeRecoveryPlan(b,h,g,hash(g),{spawnSync:()=>calls++,...deps}),pattern);
  assert.equal(calls,0);assert.equal(fs.existsSync(plan.options.outputRoot),false);
 };
 await t.test('REQUIRED invocation omission is not legacy downgrade',()=>attempt(required,{},/mode mismatch/));
 await t.test('explicit legacy option is not accepted',()=>attempt(required,{checkpointMode:'LEGACY_INLINE'},/explicit REQUIRED_V1/));
 await t.test('unknown injected callback cannot replace real barrier',()=>attempt(required,{checkpointMode:'REQUIRED_V1',checkpoint:()=>true},/only Docker transport/));
 await t.test('legacy plan cannot claim REQUIRED partner',()=>attempt(legacy,{checkpointMode:'REQUIRED_V1'},/mode mismatch/));
 await t.test('deleting mode fields changes reviewed hash and fails',()=>attempt(legacy,{},/plan bytes hash/,ph));
 await t.test('omitting checkpointPolicy but retaining REQUIRED option fails closed rebuild',async()=>{const p=structuredClone(required);delete p.checkpointPolicy;await attempt(p,{checkpointMode:'REQUIRED_V1'},/closed frozen recovery plan/);});
 await t.test('omitting option but retaining policy fails closed rebuild',async()=>{const p=structuredClone(required);delete p.options.checkpointMode;await attempt(p,{},/closed frozen recovery plan/);});
 for(const mode of ['LEGACY_INLINE','REQUIRED_V2',null,false])await t.test('unknown/null mode '+mode,()=>assert.rejects(f.m.buildRecoveryPlan({...legacy.options,checkpointMode:mode}),/closed recovery options/));
 const planFile=path.join(f.dir,'required.json'),legacyFile=path.join(f.dir,'legacy.json'),guardFile=path.join(f.dir,'guard.json'),optionsFile=path.join(f.dir,'legacy-options.json');put(planFile,bytes);put(legacyFile,f.m.planBytes(legacy));put(guardFile,gb);put(optionsFile,legacy.options);
 for(const [name,argv,pattern] of [
  ['execute omitted REQUIRED flag',['execute',planFile,ph,guardFile,hash(gb)],/execute --required-checkpoint-v1/],
  ['plan omitted REQUIRED flag',['plan',optionsFile],/plan --required-checkpoint-v1/],
  ['plan explicit flag cannot promote legacy options',['plan','--required-checkpoint-v1',optionsFile],/hashbound REQUIRED_V1/],
  ['execute explicit flag cannot promote legacy plan',['execute','--required-checkpoint-v1',legacyFile,hash(f.m.planBytes(legacy)),guardFile,hash(gb)],/mode mismatch/],
 ])await t.test(name,()=>{const p=spawnSync(process.execPath,[f.file,...argv],{encoding:'utf8',timeout:3000});assert.equal(p.status,1,p.stderr);assert.match(p.stderr,pattern);assert.equal(p.stdout,'');assert.equal(fs.existsSync(legacy.options.outputRoot),false);});
});
