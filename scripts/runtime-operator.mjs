/** Reviewed bounded sequential preparation. PLAN never downloads/runs Docker.
 * execute requires frozen plan SHA; no retries/resume/implicit cleanup after uncertainty. */
import * as fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {createRequire} from 'node:module';
import {prepare,validatePrepareRequest,validateProductionRequest} from './runtime-prepare.mjs';
import {canonicalDirectory,readPrivate,receiptWriter} from './runtime-files.mjs';
import {dependencyHash} from './runtime-dependencies.mjs';
import {encodeSpec} from './runtime-spec.mjs';
import {prepareLanguageImages} from './runtime-language-prepare.mjs';
const repo=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const hash=b=>createHash('sha256').update(b).digest('hex');
const json=p=>JSON.parse(readPrivate(p,4*1024*1024).bytes);
const sourcePaths=()=>[
 ...fs.readdirSync(path.join(repo,'scripts')).filter(n=>/^runtime-.*\.(?:mjs|py)$/.test(n)).map(n=>'scripts/'+n),
 'docker/runtime.Dockerfile','docker/language-java.Dockerfile','docker/language-python.Dockerfile','runtimes/production-inputs.lock.json','runtimes/pylsp-requirements.lock','runtimes/catalog.json',
 ...walk(path.join(repo,'examples')).map(f=>'examples/'+f.path)
].sort();
function walk(root) {
 canonicalDirectory(root);const result=[]; const visit=(dir,rel='')=>{
  for(const name of fs.readdirSync(dir).sort()) {const f=path.join(dir,name),r=rel?rel+'/'+name:name,s=fs.lstatSync(f,{bigint:true});
   if(s.isSymbolicLink() || !s.isDirectory()&&!s.isFile()) throw new Error('Unsafe planned source');
   if(s.isDirectory()) {canonicalDirectory(f);visit(f,r);} else {const bytes=readPrivate(f,16*1024*1024).bytes;result.push({path:r,sha256:hash(bytes),bytes:bytes.toString('base64')});}
  }
 };visit(root);return result;
}
const repairs={
 'javascript-counter':{path:'main.js',before:'return a - b;',after:'return a + b;'},
 'typescript-counter':{path:'main.ts',before:'return a - b;',after:'return a + b;'},
 'python-calculator':{path:'calculator.py',before:'return left - right',after:'return left + right'},
 'java-pattern':{path:'src/main/java/demo/StrategyDemo.java',before:'(a, b) -> a - b',after:'(a, b) -> a + b'},
 'spring-counter':{path:'src/main/java/demo/CounterApplication.java',before:'return 2 - 3;',after:'return 2 + 3;'}
};
export function correctedExercise(job) {
 const repair=job.correction;
 return job.assets.map(f=>{if(f.path!==repair.path)return f;
  const old=Buffer.from(f.bytes,'base64').toString();if(old.split(repair.before).length!==2)throw new Error('Exact exercise source repair changed');
  const bytes=Buffer.from(old.replace(repair.before,repair.after));return {...f,sha256:hash(bytes),bytes:bytes.toString('base64')};
 });
}
const combinations=[['javascript-node','javascript-counter'],['typescript-node','typescript-counter'],['python-3.13','python-calculator'],...[11,17,21,27].map(r=>['java-maven-'+r,'java-pattern']),...[21,27].map(r=>['java-maven-'+r,'spring-counter'])];
export function buildOperatorPlan(operatorRoot) {
 const root=path.resolve(operatorRoot);if(root!==operatorRoot || /[,\x00-\x1f]/.test(root)) throw new Error('Canonical explicit absolute operator root required');
 const lock=json(path.join(repo,'runtimes/production-inputs.lock.json')),catalog=json(path.join(repo,'runtimes/catalog.json'));
 const tools=lock.artifacts.filter(a=>a.kind==='npm').flatMap(a=>a.files.map(f=>({path:'node_modules/'+a.name+'/'+f.path,sha256:f.sha256}))).sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0);
 const jobs=combinations.map(([key,example])=>{
  const profile=catalog.profiles.find(p=>p.id===key),id=key+'--'+example;
  const assets=walk(path.join(repo,'examples',example)).map(f=>{
   if(f.path==='pom.xml') {let text=Buffer.from(f.bytes,'base64').toString();text=text.replace(/<maven.compiler.release>\d+<\/maven.compiler.release>/g,`<maven.compiler.release>${profile.compilerRelease}</maven.compiler.release>`).replace(/<java.version>\d+<\/java.version>/g,`<java.version>${profile.compilerRelease}</java.version>`);const bytes=Buffer.from(text);return {...f,sha256:hash(bytes),bytes:bytes.toString('base64')};}return f;
  });
  const files=assets.map(({path,sha256})=>({path,sha256})),baseKey=profile.compilerRelease?'java'+profile.compilerRelease:profile.adapterFamily==='python'?'python':'node';
  const request={schemaVersion:1,workingDirectory:'.',installationId:'stage09-runtime-assets',family:profile.adapterFamily,key,imageTag:`paircoach/runtime-${key}:stage09`,baseImage:lock.images[baseKey].reference,nodeImage:lock.images.node.reference,tools:{root:path.join(root,'stage/tools'),files:tools},project:{root:path.join(root,'projects',id),files},expectedTools:profile.expectedTools,dependencySha256:dependencyHash(files),outputRoot:path.join(root,'jobs',id)};
  validatePrepareRequest(request);validateProductionRequest(request);
  return {id,profile,example,correction:repairs[example],assets,request};
 });
 return {schemaVersion:1,operatorEngine:lock.operatorLane,language:lock.language,scope:'PREPARATION_AND_OFFLINE_FIXTURE_SMOKE_ONLY_NOT_ACK_AUTHORITY_OR_FINAL_QA',operatorRoot:root,maxHeavyConcurrency:1,maxElapsedMs:2700000,maxCommandMs:480000,sourceInventory:sourcePaths().map(p=>({path:p,sha256:hash(readPrivate(path.join(repo,p),4*1024*1024).bytes)})),jobs};
}
function validateFrozen(plan) {
 if(JSON.stringify(plan)!==JSON.stringify(buildOperatorPlan(plan.operatorRoot))) throw new Error('Frozen plan/source/pins/assets differ; do not execute');
}
export function junitSmoke(xmls,expectFailure) {
 if(!xmls.length) throw new Error('Missing fresh JUnit XML');
 let tests=0,failures=0,skipped=0;
 for(const {xml,parser,validator} of xmls) {
  if(Buffer.byteLength(xml)>4*1024*1024 || /<!\s*(?:DOCTYPE|ENTITY)/i.test(xml) || validator.validate(xml)!==true) throw new Error('Unsafe JUnit');
  const tree=new parser({ignoreAttributes:false,parseTagValue:false,processEntities:false}).parse(xml);
  if(!tree.testsuite&&!tree.testsuites) throw new Error('JUnit root');
  const visit=o=>{ if(!o || typeof o!=='object')return;for(const [key,value] of Object.entries(o)) {
   if(key==='testcase')for(const tc of Array.isArray(value)?value:[value]) {tests++;if(tc && typeof tc==='object') {if(Object.hasOwn(tc,'failure')||Object.hasOwn(tc,'error'))failures++;if(Object.hasOwn(tc,'skipped'))skipped++;}}
   else if(!key.startsWith('@_'))for(const v of Array.isArray(value)?value:[value])visit(v);
  }};visit(tree);
 }
 if(!tests || skipped || (expectFailure?failures===0:failures!==0)) throw new Error('Offline fixture testcase evidence differs');
 return {tests,failures,skipped,scope:'SMOKE_COUNTS_ONLY_PRODUCT_PARSER_UNCHANGED'};
}
export function executeOperatorPlan(plan) {
 validateFrozen(plan);const root=canonicalDirectory(plan.operatorRoot),start=Date.now();
 const actualTools=walk(path.join(root,'stage/tools')).map(({path,sha256})=>({path,sha256})).sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0);
 if(JSON.stringify(actualTools)!==JSON.stringify(plan.jobs[0].request.tools.files))throw new Error('Staged tool inventory differs');
 // Published staging receipt is necessary but never sufficient for readiness.
 if(json(path.join(root,'download-journal/receipt.json')).status!=='STAGED_NOT_PREPARED')throw new Error('Assets not staged');
 const publish=receiptWriter(path.join(root,'session')),receipt={scope:plan.scope,status:'STARTED',startedAt:new Date().toISOString(),planSha256:hash(JSON.stringify(plan,null,2)+'\n'),jobs:[],commands:[]};
 let publicationFailed=false;
 const save=()=>{try{return publish(receipt);}catch(e){publicationFailed=true;throw e;}};save();
 const checkBudget=()=>{if(Date.now()-start>plan.maxElapsedMs) throw new Error('Global preparation budget reached; retain/reconcile, no retry');validateFrozen(plan);};
 const run=(args,allowNonzero=false)=>{
  checkBudget();const began=new Date().toISOString(),r=spawnSync('docker',args,{shell:false,env:{PATH:process.env.PATH,HOME:path.join(root,'session/docker-home')},encoding:'utf8',timeout:Math.min(plan.maxCommandMs,plan.maxElapsedMs-(Date.now()-start)),maxBuffer:4*1024*1024});
  receipt.commands.push({argv:['docker',...args],startedAt:began,finishedAt:new Date().toISOString(),exit:r.status,signal:r.signal,error:r.error?.message??null,stdout:r.stdout,stderr:r.stderr});save();
  if(r.error || r.signal || !allowNonzero && r.status!==0)throw new Error('Unknown/failed Docker operation; retain exact receipts/resources; inspect before any retry');
  return r;
 };
 const make=(d,mode=0o700)=>{canonicalDirectory(path.dirname(d));fs.mkdirSync(d,{mode});canonicalDirectory(d);};
 const put=(p,bytes,mode=0o600)=>{canonicalDirectory(path.dirname(p));const fd=fs.openSync(p,'wx',mode);try{fs.writeFileSync(fd,bytes);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}};
 const materialize=(dir,assets,mode=0o600)=>{
  make(dir,0o755);for(const f of assets) {const p=path.join(dir,f.path);let current=dir;for(const part of path.dirname(f.path).split('/').filter(x=>x&&x!=='.')) {current=path.join(current,part);if(!fs.existsSync(current))make(current,0o755);canonicalDirectory(current);}
   const bytes=Buffer.from(f.bytes,'base64');if(hash(bytes)!==f.sha256)throw new Error('Planned asset mismatch');put(p,bytes,mode);
  }
 };
 try {
  make(path.join(root,'session/docker-home'));
  const engine=JSON.parse(run(['info','--format','{"ID":{{json .ID}},"ServerVersion":{{json .ServerVersion}},"OSType":{{json .OSType}},"Architecture":{{json .Architecture}}}']).stdout);
  if(JSON.stringify(engine)!==JSON.stringify(plan.operatorEngine))throw new Error('Reviewed operator engine changed; no mutations allowed');
  receipt.engine=engine;save();
  for(const d of ['projects','jobs','requests','offline'])make(path.join(root,d));
  const require=createRequire(path.join(root,'stage/tools/probe.cjs')),{XMLParser,XMLValidator}=require('fast-xml-parser');
  for(const job of plan.jobs) {
   checkBudget();materialize(job.request.project.root,job.assets,0o644);put(path.join(root,'requests',job.id+'.json'),Buffer.from(JSON.stringify(job.request,null,2)+'\n'));
   const item={id:job.id,status:'PREPARE_INTENT',offline:[]};receipt.jobs.push(item);save();
   const prepared=prepare(job.request,true,start+plan.maxElapsedMs);checkBudget();item.imageId=prepared.imageId;item.prepareReceipt=path.join(job.request.outputRoot,'receipt.json');
   const image=JSON.parse(run(['image','inspect',prepared.imageId]).stdout)[0];item.observedImage={Id:image.Id,RepoDigests:image.RepoDigests??[],Descriptor:image.Descriptor??null};
   if(image.Id!==prepared.imageId)throw new Error('Prepared image changed');
   item.readiness='NOTREADY_UNTIL_REVIEWED_ACTUAL_DIGEST_TOOLS_OFFLINE_RECEIPTS';save();
   const cache=path.join(job.request.outputRoot,'cache',job.profile.adapterFamily,prepared.toolchainHash,job.request.dependencySha256);
   const task=JSON.parse(Buffer.from(job.assets.find(f=>f.path==='task.v2.json').bytes,'base64').toString()).runProfiles.find(p=>p.kind==='RUN_TESTS').task;
   for(const corrected of [false,true]) {
    const runId=(job.id+'--'+(corrected?'corrected':'defect')).replace(/[^A-Za-z0-9_-]/g,'_'),base=path.join(root,'offline',runId);make(base);
    const assets=corrected?correctedExercise(job):job.assets;
    if(corrected && assets.every((f,i)=>f.sha256===job.assets[i].sha256))throw new Error('Corrected fixture did not change source');
    const input=path.join(base,'input'),workspace=path.join(base,'workspace'),artifacts=path.join(base,'artifacts');materialize(input,assets,0o644);materialize(workspace,assets,0o666);fs.chmodSync(workspace,0o777);make(artifacts,0o777);fs.chmodSync(artifacts,0o777);
    const manifest=hash(JSON.stringify(assets.map(({path,sha256})=>({path,sha256})))),spec={schemaVersion:1,family:job.profile.adapterFamily,release:job.profile.compilerRelease,preview:false,runId,manifestSha256:manifest,mode:'RUN_TESTS',task,cache:'/cache/0'},name='paircoach-stage09-'+runId;
    const entry={runId,status:'CREATE_INTENT',containerName:name,manifestSha256:manifest,corrected,fixtureOnlyNotRealACK:true};item.offline.push(entry);save();
    run(['create','--pull=never','--name',name,'--label','paircoach.installation=stage09-runtime-assets','--label','paircoach.role=offline-smoke','--user','10001:10001','--cap-drop=ALL','--security-opt=no-new-privileges','--read-only','--network=none','--memory=2g','--cpus=2','--pids-limit=256','--log-driver=json-file','--log-opt','max-size=10m','--log-opt','max-file=1','--tmpfs','/tmp:rw,nosuid,size=256m,mode=1777','--mount',`type=bind,source=${input},target=/input,readonly`,'--mount',`type=bind,source=${workspace},target=/workspace`,'--mount',`type=bind,source=${artifacts},target=/artifacts`,'--mount',`type=bind,source=${cache},target=/cache/0,readonly`,'--workdir','/workspace',...['CI=true','LANG=C.UTF-8','LC_ALL=C.UTF-8','TZ=UTC','PYTHONDONTWRITEBYTECODE=1'].flatMap(e=>['--env',e]),prepared.imageId,'/opt/paircoach/node/bin/node','/opt/paircoach/runtime-task.mjs',encodeSpec(spec)]);
    const result=run(['start','--attach',name],true),state=JSON.parse(run(['inspect',name]).stdout)[0];
    if(!state || state.State.Running || state.Config.Image!==prepared.imageId || state.Config.Labels?.['paircoach.installation']!=='stage09-runtime-assets' || state.Config.Labels?.['paircoach.role']!=='offline-smoke' || state.State.ExitCode!==result.status)throw new Error('Offline terminal ownership/exit uncertain');
    entry.container=state;run(['logs',name]);const files=walk(artifacts);entry.artifacts=files.map(({path,sha256})=>({path,sha256}));
    const actualInput=json(path.join(artifacts,'runtime-input.json'));if(actualInput.runId!==runId || actualInput.manifestSha256!==manifest)throw new Error('Offline dispatcher input correlation missing');
    entry.junit=junitSmoke(files.filter(f=>f.path.endsWith('.xml')).map(f=>({xml:Buffer.from(f.bytes,'base64').toString(),parser:XMLParser,validator:XMLValidator})),!corrected);
    if(corrected?state.State.ExitCode!==0:state.State.ExitCode===0)throw new Error('Offline fixture exit differs');
    entry.status='COLLECTED_DURABLE';save(); // Durable exit/artifact digests BEFORE exact nonforce cleanup.
    // Recheck terminal ownership immediately before rm; uncertainty never authorizes force/global cleanup.
    const final=JSON.parse(run(['inspect',name]).stdout)[0];if(final.Id!==state.Id || final.State.Running || final.Config.Image!==prepared.imageId || final.Config.Labels?.['paircoach.installation']!=='stage09-runtime-assets' || final.Config.Labels?.['paircoach.role']!=='offline-smoke')throw new Error('Cleanup identity changed');
    run(['rm',name]);entry.status='OFFLINE_FIXTURE_SMOKE_PASS_REMOVED';save();
   }
   item.status='PREPARED_OFFLINE_SMOKE_REQUIRES_K_REVIEW';save();
  }
  prepareLanguageImages(root,json(path.join(repo,'runtimes/production-inputs.lock.json')),{run,save,receipt});
  receipt.status='PREPARATION_AND_OFFLINE_SMOKE_COMPLETE_NOT_PRODUCT_ACCEPTANCE';save();return receipt;
 }catch(e){receipt.status='FAILED_RETAIN_AND_RECONCILE';receipt.error=e.message;if(!publicationFailed)save();throw e;}
}
if(process.argv[1] && fileURLToPath(import.meta.url)===path.resolve(process.argv[1])) {
 try {const [mode,input,output]=process.argv.slice(2);if(process.argv.length!==5)throw new Error('Exact three arguments required');if(mode==='plan'&&input&&output) {const bytes=Buffer.from(JSON.stringify(buildOperatorPlan(input),null,2)+'\n');canonicalDirectory(path.dirname(path.resolve(output)));fs.writeFileSync(output,bytes,{flag:'wx',mode:0o600});console.log(hash(bytes));}
 else if(mode==='execute'&&input&&/^[a-f0-9]{64}$/.test(output??'')) {const bytes=readPrivate(path.resolve(input),4*1024*1024).bytes;if(hash(bytes)!==output)throw new Error('Frozen plan SHA mismatch');executeOperatorPlan(JSON.parse(bytes));}
 else throw new Error('Usage: node scripts/runtime-operator.mjs plan ABS_OPERATOR_ROOT NEW_PLAN.json | execute PLAN.json EXACT_PLAN_SHA256');
 }catch(e){console.error(e.message);process.exitCode=1;}
}
