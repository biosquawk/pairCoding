/** Reviewed bounded sequential preparation. PLAN never downloads/runs Docker.
 * execute requires frozen plan SHA; no retries/resume/implicit cleanup after uncertainty. */
import * as fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {createRequire} from 'node:module';
import {prepare,validatePrepareRequest,validateProductionRequest,resolvePreparedToolchainIdentity,createDockerClientState,beginDockerCommand,finishDockerCommand} from './runtime-prepare.mjs';
import {createImageRetention,imagePin,imageCommandOutput} from './runtime-image-retention.mjs';
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
export function buildOperatorPlan(operatorRoot,phase='PREPARE_ONLY') {
 if(!['PREPARE_ONLY','FINAL_QA_OFFLINE'].includes(phase))throw new Error('Explicit reviewed preparation/final offline phase required');
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
 return {schemaVersion:1,phase,offlineFixtureContainers:phase==='PREPARE_ONLY'?0:18,operatorEngine:lock.operatorLane,language:lock.language,scope:phase==='PREPARE_ONLY'?'PREPARE_ONLY_NOT_OFFLINE_OR_PRODUCT_ACCEPTANCE':'FINAL_QA_OFFLINE_FIXTURE_CHECKS_NOT_GUI_OR_ACK_ACCEPTANCE',operatorRoot:root,maxHeavyConcurrency:1,maxElapsedMs:2700000,maxCommandMs:480000,sourceInventory:sourcePaths().map(p=>({path:p,sha256:hash(readPrivate(path.join(repo,p),4*1024*1024).bytes)})),jobs};
}
function validateFrozen(plan,buildPlan=buildOperatorPlan) {
 if(JSON.stringify(plan)!==JSON.stringify(buildPlan(plan.operatorRoot,plan.phase))) throw new Error('Frozen plan/source/pins/assets differ; do not execute');
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
// Caller persists exit/log/artifact collection BEFORE entering this exact-ID cleanup.
export function cleanupOfflineFixture(state,imageId,run) {
 const owned=s=>s && /^[a-f0-9]{64}$/.test(s.Id) && s.State?.Running===false && Number.isInteger(s.State.ExitCode) && s.Config?.Image===imageId && s.Config.Labels?.['paircoach.installation']==='stage09-runtime-assets' && s.Config.Labels?.['paircoach.role']==='offline-smoke';
 if(!owned(state))throw new Error('Cleanup initial terminal identity uncertain');
 const inspected=JSON.parse(run(['inspect',state.Id]).stdout);
 if(inspected.length!==1 || !owned(inspected[0]) || inspected[0].Id!==state.Id || inspected[0].State.ExitCode!==state.State.ExitCode)throw new Error('Cleanup identity changed');
 const final=inspected[0];run(['rm',final.Id]);
}
export function executeOperatorPlan(plan,dependencies={}) {
 validateFrozen(plan,dependencies.buildPlan);const root=canonicalDirectory(plan.operatorRoot),start=Date.now();
 const actualTools=walk(path.join(root,'stage/tools')).map(({path,sha256})=>({path,sha256})).sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0);
 if(JSON.stringify(actualTools)!==JSON.stringify(plan.jobs[0].request.tools.files))throw new Error('Staged tool inventory differs');
 // Published staging receipt is necessary but never sufficient for readiness.
 if(json(path.join(root,'download-journal/receipt.json')).status!=='STAGED_NOT_PREPARED')throw new Error('Assets not staged');
 const session=path.join(root,plan.phase==='PREPARE_ONLY'?'session':'final-qa-session');
 const publish=receiptWriter(session),receipt={phase:plan.phase,scope:plan.scope,status:'STARTED',startedAt:new Date().toISOString(),planSha256:hash(JSON.stringify(plan,null,2)+'\n'),jobs:[],commands:[]};
 let publicationFailed=false;let clientState;
 const endpoint=process.platform==='win32'?'npipe:////./pipe/docker_engine':'unix:///var/run/docker.sock',configDirectory=path.join(session,'docker-config');
 const save=()=>{try{return publish(receipt);}catch(e){publicationFailed=true;throw e;}};save();
 const checkBudget=()=>{if(Date.now()-start>plan.maxElapsedMs) throw new Error('Global preparation budget reached; retain/reconcile, no retry');validateFrozen(plan,dependencies.buildPlan);};
 const invoke=(args,allowNonzero=false,allowMissing=false)=>{
  checkBudget();const began=new Date().toISOString(),issued=beginDockerCommand(clientState),actualArgs=['--host',endpoint,'--config',issued.configDirectory,...args],r=(dependencies.spawnSync??spawnSync)('docker',actualArgs,{shell:false,env:issued.env,encoding:'utf8',timeout:Math.min(plan.maxCommandMs,plan.maxElapsedMs-(Date.now()-start)),maxBuffer:4*1024*1024});
  receipt.commands.push({argv:['docker',...actualArgs],startedAt:began,finishedAt:new Date().toISOString(),exit:r.status,signal:r.signal,error:r.error?.message??null,stdout:r.stdout,stderr:r.stderr});save();
  finishDockerCommand(clientState,issued);
  if(allowMissing)imageCommandOutput(args,r,true);
  else if(r.error || r.signal || !allowNonzero && r.status!==0)throw new Error('Unknown/failed Docker operation; retain exact receipts/resources; inspect before any retry');
  return r;
 };
 const engineArgs=['info','--format','{"ID":{{json .ID}},"ServerVersion":{{json .ServerVersion}},"OSType":{{json .OSType}},"Architecture":{{json .Architecture}}}'];
 const run=(args,allowNonzero=false,allowMissing=false)=>{
  if(args[0]!=='info') {const actual=JSON.parse(invoke(engineArgs).stdout);if(JSON.stringify(actual)!==JSON.stringify(plan.operatorEngine))throw new Error('Reviewed operator engine changed; retain/reconcile');}
  return invoke(args,allowNonzero,allowMissing);
 };
 const make=(d,mode=0o700)=>{canonicalDirectory(path.dirname(d));fs.mkdirSync(d,{mode});canonicalDirectory(d);};
 const put=(p,bytes,mode=0o600)=>{canonicalDirectory(path.dirname(p));const fd=fs.openSync(p,'wx',mode);try{fs.writeFileSync(fd,bytes);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}};
 const materialize=(dir,assets,mode=0o600)=>{
  make(dir,0o755);for(const f of assets) {const p=path.join(dir,f.path);let current=dir;for(const part of path.dirname(f.path).split('/').filter(x=>x&&x!=='.')) {current=path.join(current,part);if(!fs.existsSync(current))make(current,0o755);canonicalDirectory(current);}
   const bytes=Buffer.from(f.bytes,'base64');if(hash(bytes)!==f.sha256)throw new Error('Planned asset mismatch');put(p,bytes,mode);
  }
 };
 try {
  clientState=createDockerClientState(session);receipt.clientState=clientState;save();
  const engine=JSON.parse(run(['info','--format','{"ID":{{json .ID}},"ServerVersion":{{json .ServerVersion}},"OSType":{{json .OSType}},"Architecture":{{json .Architecture}}}']).stdout);
  if(JSON.stringify(engine)!==JSON.stringify(plan.operatorEngine))throw new Error('Reviewed operator engine changed; no mutations allowed');
  receipt.engine=engine;save();
  const retention=createImageRetention({engine,run:(args,missing)=>run(args,false,missing),receipt,save});retention.retainRequired();
  if(plan.phase==='PREPARE_ONLY')for(const d of ['projects','jobs','requests'])make(path.join(root,d));
  else {
   const previous=json(path.join(root,'session/receipt.json'));
   if(previous.phase!=='PREPARE_ONLY' || previous.status!=='PREPARE_ONLY_COMPLETE_OFFLINE_DEFERRED_NOT_PRODUCT_ACCEPTANCE' || JSON.stringify(previous.engine)!==JSON.stringify(engine))throw new Error('Final offline phase requires completed same-engine preparation');
   make(path.join(root,'offline'));
  }
  const xml=plan.phase==='FINAL_QA_OFFLINE'?createRequire(path.join(root,'stage/tools/probe.cjs'))('fast-xml-parser'):null;
  for(const job of plan.jobs) {
   checkBudget();if(plan.phase==='PREPARE_ONLY') {materialize(job.request.project.root,job.assets,0o644);put(path.join(root,'requests',job.id+'.json'),Buffer.from(JSON.stringify(job.request,null,2)+'\n'));}
   const item={id:job.id,status:'PREPARE_INTENT',offline:[]};receipt.jobs.push(item);save();
   const prepared=plan.phase==='PREPARE_ONLY'?(dependencies.prepare??prepare)(job.request,true,start+plan.maxElapsedMs,engine,{endpoint,configDirectory,clientState,...(dependencies.spawnSync?{spawnSync:dependencies.spawnSync}:{})},retention.pins()):json(path.join(job.request.outputRoot,'receipt.json'));
   if(JSON.stringify(prepared.engine)!==JSON.stringify(engine) || JSON.stringify(prepared.request)!==JSON.stringify(job.request) || prepared.toolchainHash!==resolvePreparedToolchainIdentity(job.request).toolchainHash || prepared.status!=='PREPARED_REQUIRES_OFFLINE_AND_TOOL_VALIDATION')throw new Error('Prepared receipt/request/engine/installed-source correlation differs');
   retention.add(imagePin(engine,prepared.imageInspect,path.join(job.request.outputRoot,'receipt.json')));
   if(plan.phase==='PREPARE_ONLY') {if(!Array.isArray(prepared.imageRetention?.pins))throw new Error('Producer retained prior-pin set missing');for(const entry of prepared.imageRetention.pins)retention.add(entry.pin);}
   checkBudget();item.imageId=prepared.imageId;item.prepareReceipt=path.join(job.request.outputRoot,'receipt.json');
   const image=JSON.parse(run(['image','inspect',prepared.imageId]).stdout)[0];item.observedImage={Id:image.Id,RepoDigests:image.RepoDigests??[],Descriptor:image.Descriptor??null};
   if(image.Id!==prepared.imageId)throw new Error('Prepared image changed');
   item.readiness='NOTREADY_UNTIL_REVIEWED_ACTUAL_DIGEST_TOOLS_OFFLINE_RECEIPTS';save();
   if(plan.phase==='PREPARE_ONLY') {item.status='PREPARED_TOOLS_CHECKED_OFFLINE_DEFERRED';save();continue;}
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
    entry.junit=junitSmoke(files.filter(f=>f.path.endsWith('.xml')).map(f=>({xml:Buffer.from(f.bytes,'base64').toString(),parser:xml.XMLParser,validator:xml.XMLValidator})),!corrected);
    if(corrected?state.State.ExitCode!==0:state.State.ExitCode===0)throw new Error('Offline fixture exit differs');
    entry.status='COLLECTED_DURABLE';save(); // Durable exit/artifact digests BEFORE exact nonforce cleanup.
    // Recheck terminal ownership immediately before rm; uncertainty never authorizes force/global cleanup.
    cleanupOfflineFixture(state,prepared.imageId,run);entry.status='OFFLINE_FIXTURE_SMOKE_PASS_REMOVED';save();
   }
   item.status='PREPARED_OFFLINE_SMOKE_REQUIRES_K_REVIEW';save();
  }
  if(plan.phase==='PREPARE_ONLY')(dependencies.prepareLanguageImages??prepareLanguageImages)(root,json(path.join(repo,'runtimes/production-inputs.lock.json')),{run:(args,...rest)=>{
   if(args[0]!=='build')return run(args,...rest);
   const tag=args[args.indexOf('--tag')+1];retention.beforeBuild(tag);const result=run(args);retention.afterBuild(tag);return result;
  },save,receipt});
  retention.verifyAll();
  receipt.status=plan.phase==='PREPARE_ONLY'?'PREPARE_ONLY_COMPLETE_OFFLINE_DEFERRED_NOT_PRODUCT_ACCEPTANCE':'FINAL_OFFLINE_FIXTURES_COMPLETE_NOT_GUI_OR_PRODUCT_ACCEPTANCE';save();return receipt;
 }catch(e){receipt.status='FAILED_RETAIN_AND_RECONCILE';receipt.error=e.message;if(!publicationFailed)save();throw e;}
}
if(process.argv[1] && fileURLToPath(import.meta.url)===path.resolve(process.argv[1])) {
 try {const [mode,input,output]=process.argv.slice(2);if(process.argv.length!==5)throw new Error('Exact three arguments required');if(['plan','plan-final-offline'].includes(mode)&&input&&output) {const bytes=Buffer.from(JSON.stringify(buildOperatorPlan(input,mode==='plan'?'PREPARE_ONLY':'FINAL_QA_OFFLINE'),null,2)+'\n');canonicalDirectory(path.dirname(path.resolve(output)));fs.writeFileSync(output,bytes,{flag:'wx',mode:0o600});console.log(hash(bytes));}
 else if(mode==='execute'&&input&&/^[a-f0-9]{64}$/.test(output??'')) {const bytes=readPrivate(path.resolve(input),4*1024*1024).bytes;if(hash(bytes)!==output)throw new Error('Frozen plan SHA mismatch');executeOperatorPlan(JSON.parse(bytes));}
 else throw new Error('Usage: node scripts/runtime-operator.mjs plan|plan-final-offline ABS_OPERATOR_ROOT NEW_PLAN.json | execute PLAN.json EXACT_PLAN_SHA256');
 }catch(e){console.error(e.message);process.exitCode=1;}
}
