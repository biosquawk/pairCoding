// UNIT only: real isolated filesystem + synthetic lock/cache + intercepted child calls, never Docker.
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import childProcess from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
import assert from 'node:assert/strict';
const source=path.resolve(process.argv[2]),repo=path.dirname(path.dirname(source)),root=fs.mkdtempSync(path.join(process.env.TMPDIR,'prepare-engine-'));
const fixture=path.join(root,'installed');fs.mkdirSync(fixture);fs.writeFileSync(path.join(fixture,'package.json'),'{"type":"module"}');
for(const dir of ['scripts','docker','runtimes']) {fs.mkdirSync(path.join(fixture,dir));for(const file of fs.readdirSync(path.join(repo,dir))) {const src=path.join(repo,dir,file);if(fs.statSync(src).isFile())fs.copyFileSync(src,path.join(fixture,dir,file));}}
const hash=b=>createHash('sha256').update(b).digest('hex'),pin='node@sha256:'+'a'.repeat(64),image='sha256:'+'b'.repeat(64),id='c'.repeat(64),tools=[{name:'node',version:'22.22.0',raw:'v22.22.0'}];
const engine={ID:'unit-engine',ServerVersion:'29.7.2',OSType:'linux',Architecture:'x86_64'};
const toolFiles=[{path:'node_modules/unit-tool/index.js',sha256:hash('unit')}],projectFiles=[{path:'main.js',sha256:hash('console.log(1)')}];
fs.writeFileSync(path.join(fixture,'runtimes/catalog.json'),JSON.stringify({profiles:[{id:'javascript-node',adapterFamily:'node',expectedTools:[{name:'node',version:'22.22.0'}]}]}));
fs.writeFileSync(path.join(fixture,'runtimes/production-inputs.lock.json'),JSON.stringify({images:{node:{reference:pin},maven:{reference:'maven@sha256:be898b0cf3929205778d61b2841aa36733513a79b0404f9cac67837863c8641f'}},artifacts:[{kind:'npm',name:'unit-tool',files:[{path:'index.js',sha256:hash('unit')}]}]}));
for(const [dir,files] of [['tools',toolFiles],['project',projectFiles]])for(const f of files){const p=path.join(root,dir,f.path);fs.mkdirSync(path.dirname(p),{recursive:true});fs.writeFileSync(p,dir==='tools'?'unit':'console.log(1)');}
let scenario,calls,infoCount,request;
childProcess.spawnSync=(exe,args)=>{
 assert.equal(exe,'docker');calls.push(args);let stdout='';
 if(args[0]==='info'){infoCount++;stdout=JSON.stringify(scenario==='absent'?{...engine,ID:''}:scenario==='switch'&&infoCount>1?{...engine,ID:'other'}:engine);}
 else if(args[0]==='image')stdout=JSON.stringify([{Id:image,RepoDigests:[],Descriptor:scenario==='no-manifest'?undefined:{digest:'sha256:'+'d'.repeat(64),mediaType:'application/vnd.oci.image.manifest.v1+json'},Config:{User:'10001:10001',Entrypoint:[]}}]);
 else if(args[0]==='create') {
  const mount=args.find(a=>a.includes('target=/cache/0')),cache=mount.match(/source=([^,]+)/)[1];
  fs.writeFileSync(path.join(cache,'tools.json'),JSON.stringify(tools));
  fs.writeFileSync(path.join(cache,'dependencies-prepared.json'),JSON.stringify({family:'node',workingDirectory:'.',dependencySha256:scenario==='bad-cache'?'0'.repeat(64):request.dependencySha256,tools,preparedAt:new Date().toISOString()}));
 }
 else if(args[0]==='inspect')stdout=JSON.stringify([{Id:id,State:{Running:false,ExitCode:0},Config:{Image:image,Labels:{'paircoach.installation':'unit','paircoach.role':'prepare'}}}]);
 return {status:0,stdout,stderr:'',signal:null};
};syncBuiltinESMExports();
const mod=await import(pathToFileURL(path.join(fixture,'scripts/runtime-prepare.mjs')).href);
let success=0,negatives=0;
for(scenario of ['success','absent','switch','expected-mismatch','bad-cache','no-manifest']) {
 calls=[];infoCount=0;request={schemaVersion:1,workingDirectory:'.',installationId:'unit',family:'node',key:'javascript-node',imageTag:'paircoach/runtime-node:unit',baseImage:pin,nodeImage:pin,tools:{root:path.join(root,'tools'),files:toolFiles},project:{root:path.join(root,'project'),files:projectFiles},expectedTools:[{name:'node',version:'22.22.0'}],dependencySha256:hash('[]'),outputRoot:path.join(root,scenario)};
 const expected=scenario==='expected-mismatch'?{...engine,ID:'wrong'}:engine;
 if(['success','no-manifest'].includes(scenario)) {
  const result=mod.prepare(request,true,Infinity,expected);assert.deepEqual(result.engine,engine);assert.deepEqual(result.toolchainHash,mod.resolvePreparedToolchainIdentity(request).toolchainHash);assert.deepEqual(result.dispatcherFiles,mod.resolvePreparedToolchainIdentity(request).dispatcherFiles);
  assert.deepEqual(result.cacheEvidence.tools.actual,tools);assert.equal(result.cacheEvidence.dependencies.actual.dependencySha256,request.dependencySha256);assert.deepEqual(calls.find(c=>c[0]==='rm'),['rm',id]);
  const rmReceipt=JSON.parse(fs.readFileSync(path.join(request.outputRoot,'receipt.json')));assert.equal(rmReceipt.status,'PREPARED_REQUIRES_OFFLINE_AND_TOOL_VALIDATION');
  if(scenario==='no-manifest') {assert.equal(result.observedImage.Descriptor,null);assert.deepEqual(result.observedImage.RepoDigests,[]);assert.equal(Object.hasOwn(result.observedImage,'digest'),false);negatives++;}else success++;
 } else {
  assert.throws(()=>mod.prepare(request,true,Infinity,expected),/engine|cache\/tool/);
  const receipt=JSON.parse(fs.readFileSync(path.join(request.outputRoot,'receipt.json')));assert.equal(receipt.status,'FAILED_RETAIN_AND_RECONCILE');assert.equal(calls.some(c=>c[0]==='rm'),false);
  if(scenario!=='bad-cache')assert.equal(calls.some(c=>c[0]!=='info'),false);
  negatives++;
 }
}
// Actual installed-source change, same request: producer helper must change without copied consumer formula.
const commandsBeforeIdentity=calls.length,before=mod.resolvePreparedToolchainIdentity(request);fs.appendFileSync(path.join(fixture,'scripts/runtime-task.mjs'),'\n// UNIT source identity counter\n');
const after=mod.resolvePreparedToolchainIdentity(request);assert.notEqual(before.toolchainHash,after.toolchainHash);assert.notDeepEqual(before.dispatcherFiles,after.dispatcherFiles);assert.equal(calls.length,commandsBeforeIdentity);
console.log(JSON.stringify({success,negatives,scope:'UNIT_FAKE_DOCKER_NOT_RUNTIME_PROOF'}));
