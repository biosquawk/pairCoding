// UNIT phase orchestration only. Exact operator source, injected preparation/language producers,
// intercepted Docker calls and isolated real filesystem. Never real assets or runtime evidence.
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import childProcess from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
import assert from 'node:assert/strict';
const repo=path.resolve('.'),tmp=fs.mkdtempSync(path.join(process.env.TMPDIR,'prepare-orchestration-')),fixture=path.join(tmp,'installed'),root=path.join(tmp,'operator');
fs.mkdirSync(fixture);fs.writeFileSync(path.join(fixture,'package.json'),'{"type":"module"}');
for(const dir of ['scripts','docker','runtimes','examples'])fs.cpSync(path.join(repo,dir),path.join(fixture,dir),{recursive:true});
const sha=b=>createHash('sha256').update(b).digest('hex'),lock=JSON.parse(fs.readFileSync(path.join(fixture,'runtimes/production-inputs.lock.json')));
lock.artifacts=[{kind:'npm',name:'fixture',files:[{path:'index.js',sha256:sha('unit')}]}];fs.writeFileSync(path.join(fixture,'runtimes/production-inputs.lock.json'),JSON.stringify(lock));
const image='sha256:'+'a'.repeat(64),calls=[],prepared=[];
globalThis.unitPrepare=(r,execute,deadline,engine)=>{
 assert.equal(execute,true);assert.deepEqual(engine,lock.operatorLane);prepared.push(r);
 fs.mkdirSync(r.outputRoot);const result={engine,request:r,toolchainHash:'b'.repeat(64),imageId:image,status:'PREPARED_REQUIRES_OFFLINE_AND_TOOL_VALIDATION'};
 fs.writeFileSync(path.join(r.outputRoot,'receipt.json'),JSON.stringify(result));return result;
};
fs.writeFileSync(path.join(fixture,'scripts/runtime-prepare.mjs'),"export const validatePrepareRequest=r=>r,validateProductionRequest=r=>r,resolvePreparedToolchainIdentity=r=>({toolchainHash:'b'.repeat(64),dispatcherFiles:[]}),prepare=(...args)=>globalThis.unitPrepare(...args);\n");
fs.writeFileSync(path.join(fixture,'scripts/runtime-language-prepare.mjs'),"export function prepareLanguageImages(root,lock,{receipt,save}) {receipt.language=[{key:'jdt-runtime-27'},{key:'pylsp-runtime-3.13'}];save();}\n");
childProcess.spawnSync=(exe,args)=>{assert.equal(exe,'docker');calls.push(args);let stdout;
 if(args[0]==='info')stdout=JSON.stringify(lock.operatorLane);
 else {assert.deepEqual(args,['image','inspect',image]);stdout=JSON.stringify([{Id:image,RepoDigests:[],Descriptor:null}]);}
 return {status:0,stdout,stderr:'',signal:null};
};syncBuiltinESMExports();
fs.mkdirSync(root);fs.mkdirSync(path.join(root,'stage/tools/node_modules/fixture'),{recursive:true});fs.writeFileSync(path.join(root,'stage/tools/node_modules/fixture/index.js'),'unit');
fs.mkdirSync(path.join(root,'download-journal'));fs.writeFileSync(path.join(root,'download-journal/receipt.json'),'{"status":"STAGED_NOT_PREPARED"}');
const mod=await import(pathToFileURL(path.join(fixture,'scripts/runtime-operator.mjs')).href),plan=mod.buildOperatorPlan(root),result=mod.executeOperatorPlan(plan);
assert.equal(result.phase,'PREPARE_ONLY');assert.equal(result.status,'PREPARE_ONLY_COMPLETE_OFFLINE_DEFERRED_NOT_PRODUCT_ACCEPTANCE');assert.equal(prepared.length,9);assert.equal(new Set(prepared.map(r=>r.key)).size,7);assert.equal(result.language.length,2);
assert.equal(result.jobs.every(j=>j.offline.length===0 && j.status==='PREPARED_TOOLS_CHECKED_OFFLINE_DEFERRED'),true);
assert.equal(fs.existsSync(path.join(root,'offline')),false);assert.equal(fs.existsSync(path.join(root,'final-qa-session')),false);assert.equal(calls.some(a=>['create','start','rm'].includes(a[0])),false);
assert.equal(JSON.parse(fs.readFileSync(path.join(root,'session/receipt.json'))).status,result.status);
console.log(JSON.stringify({scope:'UNIT_INJECTED_PRODUCERS_NOT_DOCKER_PROOF',profiles:7,caches:9,languageImages:2,offlineContainers:0}));
