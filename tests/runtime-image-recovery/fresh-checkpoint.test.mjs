import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { digest } from '../../scripts/runtime-operator-image-recovery.mjs';
import { controller,root,put,json } from './fixture.mjs';
const childFile=fileURLToPath(new URL('./checkpoint-child.mjs',import.meta.url));
const base='f6a0a8562b3e1458bb914618ce81bf099da4e292';
async function scenario(t,change=()=>{},options={}){
 const dir=root(t),evidenceFile=path.join(dir,'external-UNIT-measurement.json');put(evidenceFile,{unitOnly:true,freeBytes:20*1024**3});
 const plan={base,options:{outputRoot:path.join(dir,'output')},controller:{sha256:digest(fs.readFileSync(controller))},sourceInventory:[{path:'UNIT-scoped-barrier-not-host-admission',sha256:digest('UNIT')}],engine:{ID:'UNIT_ENGINE',ServerVersion:'UNIT',OSType:'linux',Architecture:'x86_64'},guardPolicy:{maxAgeMs:60000,minFreeBytes:15*1024**3,storagePaths:{vm:'/',physical:'D:\\',host:dir}}};
 const planHash=digest(JSON.stringify(plan)),config={dir,plan,planHash,evidenceFile,...options};put(path.join(dir,'config.json'),config);
 const child=spawn(process.execPath,[childFile,path.join(dir,'config.json')],{stdio:['pipe','pipe','pipe']});
 child.stdin.on('error',()=>{});let stdout='',stderr='',readyCount=0,interval,handlerError;
 const timer=setTimeout(()=>child.kill('SIGKILL'),30000);t.after(()=>{clearTimeout(timer);clearInterval(interval);if(child.exitCode===null && child.signalCode===null)child.kill('SIGKILL');});
 child.stderr.on('data',b=>stderr+=b);let pending='';
 child.stdout.on('data',b=>{
  stdout+=b;pending+=b;
  while(pending.includes('\n')){
   const i=pending.indexOf('\n'),line=pending.slice(0,i);pending=pending.slice(i+1);
   try{
    const frame=JSON.parse(line);assert.equal(frame.type,'ROOT_FRESH_GUARD_READY');readyCount++;
    const checkpoint=frame.checkpoint;
    // UNIT evidence only. Simulated child time, not real host free-space/admission.
    const g={schemaVersion:1,operator:'ROOT',observedAtMs:checkpoint.readyAtMs,planSha256:checkpoint.planSha256,controllerSha256:checkpoint.controllerSha256,closureSha256:checkpoint.closureSha256,base,engine:checkpoint.engine,measurements:Object.fromEntries(['vm','physical','host'].map(k=>[k,{freeBytes:20*1024**3,storagePath:k==='host'?path.dirname(checkpoint.outputRoot):plan.guardPolicy.storagePaths[k],evidenceFile,evidenceSha256:digest(fs.readFileSync(evidenceFile))}])),singleHeavyLane:true};
    const reply={type:'ROOT_FRESH_GUARD_REPLY',checkpoint:structuredClone(checkpoint),guardUtf8:JSON.stringify(g),guardSha256:digest(JSON.stringify(g))};
    const send=()=>{reply.guardUtf8=JSON.stringify(g);reply.guardSha256=digest(reply.guardUtf8);};
    const control={child,g,reply,send,evidenceFile,config,checkpoint,setInterval:fn=>{interval=setInterval(fn,20);}};
    const action=change(control);
    if(action!=='handled')child.stdin.end(JSON.stringify(reply)+'\n');
   }catch(e){handlerError=e;child.stdin.end();}
  }
 });
 const end=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',(code,signal)=>resolve({code,signal}));});clearTimeout(timer);clearInterval(interval);
 if(handlerError)throw handlerError;
 assert.equal(end.signal,null,stderr);assert.equal(readyCount,1,stdout+stderr+' '+(fs.existsSync(path.join(dir,'result.json'))?fs.readFileSync(path.join(dir,'result.json'),'utf8'):''));
 const result=json(path.join(dir,'result.json'));
 if(process.env.CHECKPOINT_TEST_ARTIFACTS){
  const out=path.join(process.env.CHECKPOINT_TEST_ARTIFACTS,digest(t.name).slice(0,12)+'.json');
  put(out,{test:t.name,code:end.code,signal:end.signal,stdout,stderr,result,unitEvidence:fs.readFileSync(evidenceFile,'utf8')});
 }
 return {dir,result,...end,stdout,stderr,plan,planHash};
}
function refused(r,pattern){assert.equal(r.code,1,r.stderr);assert.match(r.result.error,pattern);assert.equal(r.result.effects,0);assert.equal(fs.existsSync(path.join(r.dir,'effects.json')),false);}

test('NEW real pipe barrier: >60s simulated RO -> fresh external reply -> exactly first modeled effect',async t=>{
 const r=await scenario(t);assert.equal(r.code,0,r.stderr+' '+r.result.error);assert.equal(r.result.effects,1);assert.ok(r.result.initialGuardAgeMs>60000);
 assert.equal(r.result.audit.status,'ACCEPTED_EXTERNAL_ROOT');assert.ok(r.result.audit.firstMutationFenceAtMs>=r.result.audit.ready.readyAtMs);
 assert.match(r.result.audit.ready.nonce,/^[a-f0-9]{64}$/);assert.equal(digest(r.result.audit.guardUtf8),r.result.audit.guardSha256);
});
for(const [name,change,pattern] of [
 ['stale',({g,send})=>{g.observedAtMs-=60001;send();},/fresh ROOT single-heavy/],
 ['predates READY even within TTL',({g,send})=>{g.observedAtMs--;send();},/must follow READY/],
 ['future',({g,send})=>{g.observedAtMs+=10000;send();},/fresh ROOT single-heavy/],
 ['wrong nonce',({reply})=>{reply.checkpoint.nonce='0'.repeat(64);},/nonce\/scope/],
 ['wrong output scope',({reply})=>{reply.checkpoint.outputRoot+='/foreign';},/nonce\/scope/],
 ['wrong plan',({g,send})=>{g.planSha256='0'.repeat(64);send();},/source\/plan\/engine/],
 ['wrong controller',({g,send})=>{g.controllerSha256='0'.repeat(64);send();},/source\/plan\/engine/],
 ['wrong engine',({g,send})=>{g.engine={...g.engine,ID:'FOREIGN'};send();},/source\/plan\/engine/],
 ['wrong hash',({reply})=>{reply.guardSha256='0'.repeat(64);},/exact fresh ROOT guard receipt hash/],
 ['missing evidence',({g,send})=>{g.measurements.vm.evidenceFile+='.absent';send();},/ENOENT/],
 ['changed evidence',({evidenceFile})=>{fs.appendFileSync(evidenceFile,'changed');},/raw measurement binding/],
 ['insufficient resources',({g,send})=>{g.measurements.vm.freeBytes=15*1024**3-1;send();},/>=15GiB/],
 ['extra reply key',({reply})=>{reply.override=true;},/nonce\/scope/],
 ['EOF',({child})=>{child.stdin.end();return 'handled';},/incomplete|EOF/],
 ['partial EOF',({child})=>{child.stdin.end('{"type":');return 'handled';},/incomplete/],
 ['malformed',({child})=>{child.stdin.end('{invalid}\n');return 'handled';},/JSON|property/i],
 ['multiple replies',({child,reply})=>{child.stdin.end(JSON.stringify(reply)+'\n'+JSON.stringify(reply)+'\n');return 'handled';},/incomplete\/multiple/],
 ['oversized',({child})=>{child.stdin.end('x'.repeat(65537));return 'handled';},/exceeds 64KiB/],
])test('NEW real pipe refuses '+name+' before any effect',async t=>refused(await scenario(t,change),pattern));

test('NEW absolute remaining-deadline timeout with no reply',async t=>refused(await scenario(t,()=> 'handled',{waitMs:150}),/absolute timeout/));
test('NEW partial/trickle cannot reset absolute timeout',async t=>refused(await scenario(t,({child,setInterval})=>{child.stdin.write('{');setInterval(()=>child.stdin.write(' '));return 'handled';},{waitMs:150}),/absolute timeout/));
test('NEW complete frame without EOF remains bounded and cannot authorize effects',async t=>refused(await scenario(t,({child,reply})=>{child.stdin.write(JSON.stringify(reply)+'\n');return 'handled';},{waitMs:150}),/absolute timeout/));
test('NEW accepted reply expires at actual first-effect fence',async t=>refused(await scenario(t,()=>{}, {afterAcceptMs:60001}),/fresh ROOT single-heavy/));
test('NEW clock rollback after reply fails nonfuture first-effect fence',async t=>refused(await scenario(t,()=>{}, {afterAcceptMs:-61001}),/fresh ROOT single-heavy/));
test('NEW post-accept changed evidence refuses actual first-effect fence',async t=>refused(await scenario(t,()=>{}, {alterEvidence:true}),/raw measurement binding/));
test('NEW expiry after intent publication refuses immediate dispatch',async t=>refused(await scenario(t,()=>{}, {beforeDispatchMs:60001}),/expired\/future before mutation dispatch/));
test('NEW checkpoint cannot be entered twice',async t=>refused(await scenario(t,()=>{}, {reenter:true}),/one fresh guard checkpoint only/));

test('NEW composition: real execute preflight ALL9 -> external pipe -> one modeled tag only; no prepare replay',async t=>{
 const r=await scenario(t,()=>{}, {integration:true});assert.equal(r.code,0,r.stderr+' '+r.result.error);assert.equal(r.result.effects,1);assert.equal(r.result.error,'UNIT_STOP_AT_FIRST_MODELED_MUTATION');
 assert.ok(r.result.initialGuardAgeMs>60000);assert.equal(r.result.receipt.jobs.length,0);assert.equal(r.result.receipt.status,'FAILED_RETAIN_AND_RECONCILE');
 assert.equal(r.result.readonlyCommands,81);assert.equal(r.result.mutatingCommands.length,1);assert.equal(r.result.mutatingCommands[0][0],'tag');
 assert.equal(r.result.receipt.freshGuardCheckpoint.status,'ACCEPTED_EXTERNAL_ROOT');assert.ok(r.result.receipt.firstMutationAtMs>=r.result.receipt.freshGuardCheckpoint.ready.readyAtMs);
 // Existing fixture adapts only two historical hashes; retain exact production barrier logic.
 const adapted=r.result.adaptedController,source=fs.readFileSync(controller,'utf8');
 const section=s=>s.slice(s.indexOf('export function freshGuardBarrier'),s.indexOf('/** Programmatic injection'));
 assert.equal(section(adapted),section(source));
});
