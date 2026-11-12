/** Frozen ONE host-only actual-source/Gate measurement. NO production patch or warmup.
 * Only process.start/stdio is controlled. Native OCI reads, budgets and currentness are real. */
import fs from 'node:fs';
import threads from 'node:worker_threads';
import {syncBuiltinESMExports} from 'node:module';
import {performance} from 'node:perf_hooks';
import {createHash,randomUUID} from 'node:crypto';
import {isDeepStrictEqual as same} from 'node:util';
import {join,dirname,resolve,relative} from 'node:path';
import {pathToFileURL} from 'node:url';
import {PassThrough,Writable} from 'node:stream';
import assert from 'node:assert/strict';
const [planPath,output,dockerExecutable] = process.argv.slice(2);
assert.equal(process.argv.length,5);
const moduleEntry=performance.now(),moduleEntryUTC=new Date().toISOString();
const spec=JSON.parse(fs.readFileSync(planPath,'utf8'));
assert.equal(resolve(output),output);assert.equal(dirname(output),spec.outputParent);
assert.equal(output,spec.defaultOutput);
assert.equal(dockerExecutable,spec.dockerExecutable);
assert.equal(process.env.PAIRCOACH_MEASUREMENT_OPERATOR,'ONE_A8_HOST_REVIEWED');
assert.equal(process.version,'v22.22.0');
assert.equal(fs.existsSync(join(output,'runner-start.json')),true);
assert.equal(fs.existsSync(join(output,'measurement-start.json')),false);
const n={};for(const k of ['writeFileSync','readFileSync','lstatSync','fstatSync','openSync','closeSync','readSync','readdirSync','readlinkSync','mkdirSync','chmodSync','fsyncSync','existsSync'])n[k]=fs[k].bind(fs);
const sha=b=>createHash('sha256').update(b).digest('hex');
const stamp=s=>Object.fromEntries(['dev','ino','mode','size','nlink','mtimeNs','ctimeNs'].map(k=>[k,String(s[k])]));
const report={workId:spec.workId,executionId:spec.executionId,revision:spec.revision,tree:spec.tree,
 scope:'HOST WSL actual RuntimeWorkspace/WriteGate/RuntimeLanguageSource/Registry/Selected/resolver/Factory/Store; actual OCI readonly; controlled process.start JSON-RPC ONLY, NOT LSP READY, Dockerprocess, semantic, Windows or backend9 acceptance',
 startedUTC:null,moduleEntryUTC,phases:[],lanes:[],scenarioOverflow:[],counters:{},workers:[],frames:[],events:[],oci:[],observer:{ms:0,writes:0,bytes:0},seamStarts:0,forbiddenDriverCalls:[],gate:{held:0,entered:0,released:0},status:'RUNNING'};
let timerStart,mechanismStart,core,source,registry,scope,alive=true,workersActive=0,workerMax=0,workerCreated=0,pendingAsync=0,providerMs=0;
const asyncFD=new Set(),syncFD=new Map(),methodActive=new Map(),openTransports=[],launches=[],currentPhase=()=>report.phases.at(-1)?.name??'setup';
const observed=(label,fn)=>{const at=performance.now();try{return fn();}finally{report.observer.ms+=performance.now()-at;}};
const save=(file,value)=>observed('reportwrite',()=>{const b=JSON.stringify(value,null,2)+'\n';n.writeFileSync(join(output,file),b,{flag:'w',mode:0o600});report.observer.writes++;report.observer.bytes+=Buffer.byteLength(b);});
const event=(kind,extra={})=>report.events.push({kind,ms:timerStart===undefined?null:performance.now()-timerStart,...extra});
const increment=(key,ms)=>{const c=report.counters[key]??={calls:0,ms:0};c.calls++;c.ms+=ms;};
function wrap(obj,key,label=key){const original=obj[key];assert.equal(typeof original,'function',label);obj[key]=function(...args){const at=performance.now();methodActive.set(label,(methodActive.get(label)??0)+1);let result;
 const done=()=>{increment(label,performance.now()-at);methodActive.set(label,methodActive.get(label)-1);};
 try{result=original.apply(this,args);}catch(e){done();throw e;}
 if(result&&typeof result.then==='function')return result.finally(done);done();return result;};}
for(const key of ['lstatSync','fstatSync','readSync','writeFileSync','fsyncSync','renameSync','mkdirSync','fchmodSync','readdirSync','readFileSync'])wrap(fs,key,'native.'+key);
const originalOpen=fs.openSync,originalClose=fs.closeSync;
fs.openSync=function(...args){const fd=originalOpen.apply(this,args);syncFD.set(fd,String(args[0]));return fd;};
fs.closeSync=function(fd){try{return originalClose.call(this,fd);}finally{syncFD.delete(fd);}};
wrap(fs,'openSync','native.openSync');wrap(fs,'closeSync','native.closeSync');wrap(fs.realpathSync,'native','native.realpathSync.native');
for(const key of ['open','writeFile','fchmod','fsync','close']){const original=fs[key];fs[key]=function(...args){const at=performance.now(),cb=args.pop();assert.equal(typeof cb,'function');pendingAsync++;
 args.push(function(error,...rest){pendingAsync--;increment('native.async.'+key,performance.now()-at);if(!error&&key==='open')asyncFD.add(rest[0]);if(!error&&key==='close')asyncFD.delete(args[0]);return cb.call(this,error,...rest);});
 try{return original.apply(this,args);}catch(e){pendingAsync--;throw e;}};}
const NativeWorker=threads.Worker;
threads.Worker=class extends NativeWorker {
 constructor(...args){super(...args);this.isRead=String(args[0]).endsWith('/LanguageBoundedRead.worker.mjs');if(!this.isRead)return;
 this.readJobs=new Map();this.serial=++workerCreated;workersActive++;workerMax=Math.max(workerMax,workersActive);
 report.workers.push({kind:'spawn',worker:this.serial,phase:currentPhase(),gate:report.gate.held});
 this.on('message',m=>{const path=this.readJobs.get(m.id);report.workers.push({kind:'result',worker:this.serial,path,phase:currentPhase(),gate:report.gate.held,error:m.error??null,bytes:m.bytes,sha256:m.data instanceof ArrayBuffer?sha(Buffer.from(m.data,0,m.bytes)):null});});
 this.on('exit',code=>{workersActive--;report.workers.push({kind:'exit',worker:this.serial,phase:currentPhase(),gate:report.gate.held,code,active:workersActive});});
 }
 postMessage(v,...rest){if(this.isRead&&v.type==='READ'){this.readJobs.set(v.id,v.path);report.workers.push({kind:'dispatch',worker:this.serial,phase:currentPhase(),path:v.path,limit:v.limit,gate:report.gate.held});}return super.postMessage(v,...rest);}
};
syncBuiltinESMExports();
const mod=p=>import(pathToFileURL(join(spec.repo,p)).href);
const {LanguageShadowStore}=await mod('src/server/language/LanguageShadowStore.ts');
const {createRuntimeWorkspace}=await mod('src/server/runtime-coordinator/RuntimeWorkspace.ts');
const {RuntimeLanguageSource}=await mod('src/server/runtime-coordinator/RuntimeLanguageSource.ts');
const {createSelectedCacheLanguageFactory,SelectedCacheLanguageAuthority}=await mod('src/server/language/SelectedCacheLanguageAuthority.ts');
const {ProductionLanguageRegistryFactory}=await mod('src/server/language/ProductionLanguageRegistryFactory.ts');
const {PreparedRuntimeResolver}=await mod('src/server/runtime-coordinator/PreparedRuntimeResolver.ts');
const {PreparedLanguageImageVerifier}=await mod('src/server/language/PreparedLanguageImage.ts');
const {LanguageFeatureRegistry}=await mod('src/server/language/LanguageFeatureRegistry.ts');
const {LanguageAckLedger}=await mod('src/server/language/LanguageAckLedger.ts');
const {JsonRpcTransport}=await mod('src/server/language/JsonRpcTransport.ts');
const {DiskLanguageProcessJournal}=await mod('src/server/language/LanguageProcessJournal.ts');
const {LanguageProcessAdmission}=await mod('src/server/language/DockerLanguageProcess.ts');
const {DockerCliTransport}=await mod('src/server/execution/DockerTransport.ts');
const {loadRuntimeConfiguration}=await mod('src/server/runtime-config/index.ts');
const {LANGUAGE_LIMITS}=await mod('src/shared/language-v2.ts');
const codec=await mod('src/language/uriCodec.ts');
for(const [klass,methods,prefix] of [[LanguageShadowStore,['captureSource','captureScope','captureStage','discoverRead','finishRead','capture','scan','inventory','stage','stageRead','consumeStage','consumeReadStage','discardStage','discardReadStage','refreshCompletion','assertIntegrity','revalidate'],'store'],[RuntimeLanguageSource,['capture','isCurrent','withSourceLease','admit','guard','context','selectedLease'],'source'],[SelectedCacheLanguageAuthority,['prepare','capture','isCurrent','assertCopyLease'],'selected'],[ProductionLanguageRegistryFactory,['withCaptureLease','stageCapture','capture','current','create','refreshCompletion'],'factory'],[PreparedRuntimeResolver,['resolve','resolveCache'],'resolver'],[PreparedLanguageImageVerifier,['verify'],'image']])for(const key of methods)wrap(klass.prototype,key,prefix+'.'+key);
const owned=join(output,'private-canonical-runtime','owned-language'),workspace=join(output,'private-canonical-runtime','workspace'),journalRoot=join(output,'private-canonical-runtime','journal');
const privateRoot=dirname(owned),configDirectory=spec.dockerConfig;
const outstanding=()=>({workersActive,pendingAsync,asyncFD:[...asyncFD],syncFD:[...syncFD],ownedFD:n.readdirSync('/proc/self/fd').flatMap(fd=>{try{const target=n.readlinkSync('/proc/self/fd/'+fd);return [owned,spec.sourceRoot,spec.cacheRoot].some(r=>target===r||target.startsWith(r+'/'))?[{fd,target}]:[];}catch{return [];}})});
const drain=(where)=>{const v=outstanding();event('drain',{where,...v});assert.equal(v.workersActive,0);assert.equal(v.pendingAsync,0);assert.deepEqual(v.asyncFD,[]);assert.deepEqual(v.ownedFD,[]);};
// These are independent native witnesses, not an alternate source scanner/currentness authority.
function witness(root,skipControl=false){return observed('nativewitness',()=>{const entries=[];let bytes=0;const walk=(dir,depth)=>{assert.ok(depth<=64);for(const name of n.readdirSync(dir).sort()){if(skipControl&&dir===root&&name==='.paircoach')continue;
 const p=join(dir,name),s=n.lstatSync(p,{bigint:true});assert.ok(!s.isSymbolicLink());assert.ok(entries.length<16000);
 if(s.isDirectory()){entries.push({path:relative(root,p),kind:'directory',stamp:stamp(s)});walk(p,depth+1);}else{assert.ok(s.isFile());bytes+=Number(s.size);assert.ok(bytes<=268435456);const fd=n.openSync(p,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
 try{assert.deepEqual(stamp(n.fstatSync(fd,{bigint:true})),stamp(s));const b=n.readFileSync(fd);assert.equal(b.length,Number(s.size));assert.deepEqual(stamp(n.fstatSync(fd,{bigint:true})),stamp(s));assert.deepEqual(stamp(n.lstatSync(p,{bigint:true})),stamp(s));entries.push({path:relative(root,p),kind:'file',bytes:b.length,sha256:sha(b),stamp:stamp(s)});}finally{n.closeSync(fd);}}
 }};walk(root,0);return {root,rootStamp:stamp(n.lstatSync(root,{bigint:true})),bytes,entries};});}
const vector=w=>w.entries.filter(e=>e.kind==='file').map(({path,bytes,sha256})=>({path,bytes,sha256})).sort((a,b)=>a.path.localeCompare(b.path,'en'));
const sorted=v=>[...v].sort((a,b)=>a.path.localeCompare(b.path,'en'));
const countSnapshot=()=>structuredClone(report.counters);
async function phase(name,fn){const t=performance.now(),start=countSnapshot(),record={name,startedUTC:new Date().toISOString()};report.phases.push(record);try{const result=await fn();record.status='PASS';return result;}catch(e){record.status='FAIL';record.error=String(e);throw e;}finally{record.elapsedMs=performance.now()-t;record.endedUTC=new Date().toISOString();record.counters=Object.fromEntries(Object.entries(report.counters).map(([k,v])=>[k,{calls:v.calls-(start[k]?.calls??0),ms:v.ms-(start[k]?.ms??0)}]));save('partial.json',report);}}
async function settle(){for(;;){const pending=[registry.completion.pumping,registry.diagnostics.pumping].filter(Boolean);if(!pending.length)break;await Promise.all(pending);}drain('after Registry pumps');}
let beforeOriginal,beforeCache,beforePrivate,diagnosticBefore,completionDepsBefore,completionRootBefore,diagnosticGeneration;
const runtimes=[];
try {
 // Timer starts BEFORE any cache/source workload bytes/native inventory/witness/copy. No warmup.
 timerStart=performance.now();report.startedUTC=new Date().toISOString();report.modulePreflightMs=timerStart-moduleEntry;report.modulePreflightCounters=countSnapshot();save('measurement-start.json',{utc:report.startedUTC,revision:spec.revision,noWarmup:true,timer:'whole from before native original/cache witnesses + private source setup through dispose/drain/final witnesses'});
 await phase('timed native original source/cache before witnesses',async()=>{for(const f of spec.producerWitnesses)assert.equal(sha(fs.readFileSync(f.path)),f.sha256);beforeOriginal=witness(spec.sourceRoot);beforeCache=witness(spec.cacheRoot);
 assert.deepEqual(vector(beforeOriginal),sorted(spec.sourceFiles));assert.deepEqual(beforeOriginal.entries.filter(e=>e.kind==='directory').map(e=>e.path).sort(),[...spec.expectedSourceDirectories].sort());assert.deepEqual(vector(beforeCache),sorted(spec.expectedDependencies));assert.equal(beforeCache.bytes,56727070);assert.equal(vector(beforeCache).length,1847);
 assert.deepEqual(beforeCache.entries.filter(e=>e.kind==='directory').map(e=>e.path).sort(),[...spec.expectedDependencyDirectories].sort());
 save('before-native.json',{source:beforeOriginal,cache:beforeCache});});
 await phase('timed full private canonical source copy/settings/core/control setup',async()=>{
 n.mkdirSync(privateRoot,{mode:0o700});for(const dir of [owned,workspace,journalRoot])n.mkdirSync(dir,{mode:0o700});
 // Reproduce complete real source tree/empty dirs from the observed full native source inventory.
 for(const e of beforeOriginal.entries.filter(e=>e.kind==='directory').sort((a,b)=>a.path.length-b.path.length))n.mkdirSync(join(workspace,e.path),{mode:0o700});
 for(const e of beforeOriginal.entries.filter(e=>e.kind==='file')){const b=n.readFileSync(join(spec.sourceRoot,e.path));assert.equal(sha(b),e.sha256);n.writeFileSync(join(workspace,e.path),b,{flag:'wx',mode:Number(BigInt(e.stamp.mode)&0o777n)});}
 const originalConfig=JSON.parse(n.readFileSync(spec.configPath,'utf8')),base=dirname(spec.configPath);
 const privateConfig={...originalConfig,workspaceRoot:workspace,runtimeCatalog:resolve(base,originalConfig.runtimeCatalog),imageLock:resolve(base,originalConfig.imageLock)};
 const configPath=join(privateRoot,'paircoach.runtime.json');n.writeFileSync(configPath,JSON.stringify(privateConfig,null,2)+'\n',{flag:'wx',mode:0o600});
 const loaded=loadRuntimeConfiguration({configPath,environment:{PAIRCOACH_RUNTIME_PROFILE:spec.profileId}});assert.ok(loaded.resolved,JSON.stringify(loaded.problem));const runtime=loaded.resolved;runtimes.push(runtime);
 assert.equal(runtime.workspaceRoot,workspace);assert.equal(runtime.config.languageFeatures.completion,true);assert.equal(runtime.config.languageFeatures.diagnostics,true);
 const producerPlan=JSON.parse(n.readFileSync(spec.producerWitnesses.find(x=>x.path.endsWith('/admitted-plan.json')).path,'utf8'));
 const run=producerPlan.cases.find(x=>x.id==='java21').run;n.mkdirSync(join(workspace,'.paircoach'),{mode:0o700});n.writeFileSync(join(workspace,'.paircoach','settings.json'),JSON.stringify({schemaVersion:2,taskFilePath:null,taskMode:'IMPLEMENTATION',reviewNotesPath:'review.md',runProfiles:[run],aiConsent:false,contextPatterns:[]}),{flag:'wx',mode:0o600});
 core=await createRuntimeWorkspace({rootPath:workspace});core.session.claimLease('a8-measurement-tab');
 scope={projectId:core.workspace.projectId,sessionId:core.session.state.sessionId,profile:runtime.profile,configurationGeneration:runtime.configurationGeneration,connectionGeneration:randomUUID(),providerGeneration:randomUUID(),shadowGeneration:randomUUID(),shadowDirectory:owned};
 const fixedScope=structuredClone(scope),settingsHash=core.readSettings().sourceSha256;
 const guard=()=>{assert.ok(alive);assert.deepEqual(scope,fixedScope);assert.equal(core.session.state.sessionId,scope.sessionId);assert.equal(core.workspace.rootPath,runtime.workspaceRoot);assert.equal(core.session.leaseClientId,'a8-measurement-tab');core.session.assertClient('a8-measurement-tab',scope.sessionId);core.workspace._settingsVersionStore().assertCurrent();assert.equal(core.readSettings().sourceSha256,settingsHash);
  // Actual config/catalog/image-lock bytes remain immutable; no cached readiness boolean.
  for(const f of configWitnesses)assert.equal(sha(fs.readFileSync(f.path)),f.sha256);
 };
 const configWitnesses=[configPath,privateConfig.runtimeCatalog,privateConfig.imageLock].map(path=>({path,sha256:sha(n.readFileSync(path))}));
 source=new RuntimeLanguageSource({core,runtime,scope,installationId:'a8-fullpath-private-runtime',assertCurrent:guard,assertPeer(peer,message){assert.equal(peer,'a8-private-authenticated-peer');assert.equal(message.clientId,'a8-measurement-tab');core.session.assertClient(message.clientId,message.sessionId);guard();}});
 const nativeGate=core.gate._withLanguageSourceLease.bind(core.gate);
 core.gate._withLanguageSourceLease=(input,check,action)=>nativeGate(input,check,async token=>{report.gate.held++;report.gate.entered++;event('actual Gate acquired');try{return await action(token);}finally{try{drain('before actual Gate release');}finally{report.gate.held--;report.gate.released++;event('actual Gate releasing');}}});
 wrap(core.workspace,'_withQueuedMutation','workspace.FIFO');wrap(core.gate,'_withLanguageSourceLease','gate.withLanguageSourceLease');
 const cli=new DockerCliTransport(dockerExecutable,{PATH:'/usr/bin:/bin',DOCKER_CONFIG:configDirectory});
 const transport={async run(args,options){assert.ok(args.length===3&&args[0]==='info'&&args[1]==='--format'&&args[2]==='{{json .}}'||args.length===3&&args[0]==='image'&&args[1]==='inspect'&&/^sha256:[a-f0-9]{64}$/.test(args[2]),'ONLY production readonly OCI requests allowed');const at=performance.now(),record={args:[...args],options,phase:currentPhase(),startedUTC:new Date().toISOString()};report.oci.push(record);try{const result=await cli.run(args,options);Object.assign(record,result);return result;}catch(e){record.error=String(e);throw e;}finally{record.elapsedMs=performance.now()-at;}}};
 const driver={engineId:async()=>{const v=await transport.run(['info','--format','{{json .}}'],{timeoutMs:3000,maxBytes:1048576});assert.equal(v.exitCode,0);return JSON.parse(v.stdout).ID;},inspect:async()=>{report.forbiddenDriverCalls.push('inspect');throw Error('No Dockerprocess inspection in this finite start seam');},command:async args=>{report.forbiddenDriverCalls.push(args);throw Error('No Dockerprocess commands allowed');},attach:()=>{report.forbiddenDriverCalls.push('attach');throw Error('No Dockerprocess attachment allowed');}};
 const selected=createSelectedCacheLanguageFactory({ownedRoot:owned,preparedOutputRoots:spec.preparedOutputRoots,languageReceiptPath:spec.languageReceiptPath,transport,driver,journal:new DiskLanguageProcessJournal(journalRoot),admission:new LanguageProcessAdmission(),withSourceLease:source.withSourceLease.bind(source)});
 // Finite operator scope ceiling, not a timer/readiness/currentness replacement. Any
 // native coalescing request beyond the authorized 2CREATE+1REFRESH is a preserved FAIL,
 // never a fourth heavy capture silently included/excluded or a reported success.
 const allowedOperations=['CREATE:completion','CREATE:diagnostics','REFRESH:completion'];
 const nativeCapture=selected.factory.withCaptureLease.bind(selected.factory);
 selected.factory.withCaptureLease=async(s,v,action,op)=>{const key=op?.kind+':'+op?.phase,index=report.lanes.length;
  if(key!==allowedOperations[index]){report.scenarioOverflow.push({key,index,utc:new Date().toISOString()});throw Error('SCENARIO_OVERFLOW before unapproved capture: '+key);}
  const at=performance.now(),before=countSnapshot(),record={operation:key,startedUTC:new Date().toISOString()};report.lanes.push(record);
  try{return await nativeCapture(s,v,()=>{const actionStart=performance.now();try{drain('before SAME synchronous registry action '+key);return action();}finally{record.syncActionMs=performance.now()-actionStart;}},op);}
  catch(e){record.error=String(e);throw e;}finally{record.elapsedMs=performance.now()-at;record.endedUTC=new Date().toISOString();record.counts=Object.fromEntries(Object.entries(report.counters).map(([k,c])=>[k,{calls:c.calls-(before[k]?.calls??0),ms:c.ms-(before[k]?.ms??0)}]));record.drain=outstanding();}
 };
 const originalCreate=selected.factory.create.bind(selected.factory);
 selected.factory.create=(...args)=>{drain('before factory CREATE');assert.equal(report.gate.held,1);const launch=originalCreate(...args);launches.push(launch);event('factory returned owner handle',{phase:args[1],launchId:launch.session.launchId});
  const processBoundary=launch.session.options.process;
  processBoundary.start=async()=>{const at=performance.now();try{report.seamStarts++;assert.equal(report.gate.held,0);drain('controlled process.start AFTER release');assert.ok([registry.completion,registry.diagnostics].some(l=>l.active?.launch.session===launch.session),'Registry MUST own exact session before start');
   const input=new PassThrough();let buffered=Buffer.alloc(0);const outputStream=new Writable({write(chunk,_enc,callback){try{buffered=Buffer.concat([buffered,Buffer.from(chunk)]);while(buffered.length){const end=buffered.indexOf('\r\n\r\n');if(end<0)break;const length=Number(/Content-Length:\s*(\d+)/i.exec(buffered.subarray(0,end).toString())[1]);if(buffered.length<end+4+length)break;const frame=JSON.parse(buffered.subarray(end+4,end+4+length));buffered=buffered.subarray(end+4+length);report.frames.push({launchId:launch.session.launchId,phase:args[1],frame});
    if(frame.id!==undefined){assert.equal(frame.method,'initialize','No fake completion/import/diagnostics accepted');const response=Buffer.from(JSON.stringify({jsonrpc:'2.0',id:frame.id,result:{capabilities:{completionProvider:{},textDocumentSync:{openClose:true,change:1},positionEncoding:'utf-16'}}}));queueMicrotask(()=>input.write(Buffer.concat([Buffer.from('Content-Length: '+response.length+'\r\n\r\n'),response])));}}
    callback();}catch(e){callback(e);}}});const rpc=new JsonRpcTransport(input,outputStream,{connectionId:'controlled_'+launches.length});openTransports.push({rpc,input,output:outputStream});return rpc;
  }finally{providerMs+=performance.now()-at;}};return launch;};
 const originalRefresh=selected.factory.refreshCompletion.bind(selected.factory);selected.factory.refreshCompletion=(...args)=>{drain('before factory REFRESH');assert.equal(report.gate.held,1);const result=originalRefresh(...args);assert.equal(result,true);return result;};
 const ledger=new LanguageAckLedger({readCurrent:source.readCurrent.bind(source),readAnalysisSource:()=>null,readCommittedSave:source.readCommittedSave.bind(source)},codec);
 registry=new LanguageFeatureRegistry({factory:selected.factory,authority:source,ackLedger:ledger,languageFeatures:runtime.config.languageFeatures});
 const messages=spec.overlays.map((overlay,i)=>{const old=overlay.originalStamp,content=overlay.content;return {protocolVersion:'3.0',messageId:'a8-original-'+i,sessionId:scope.sessionId,clientId:'a8-measurement-tab',type:'LANGUAGE_OPEN',payload:{stamp:{...old,projectId:scope.projectId,sessionId:scope.sessionId,profileId:scope.profile.id,configurationGeneration:scope.configurationGeneration,connectionGeneration:scope.connectionGeneration,providerGeneration:scope.providerGeneration,shadowGeneration:scope.shadowGeneration,modelLifetime:'a8-original-model-'+i,controlEpoch:core.session.state.controlEpoch,baseDocumentVersion:core.workspace.getDocument(old.path).version,documentVersion:null},content,reason:'OPEN'}};});
 report.normalization={reason:'Private canonical runtime owns fresh actual project/session/control/scope IDs. All overlay paths/content/model versions/ALL-vector retained; current scanner sees raw source bytes. No rewriting original receipts/cache identities.',scope,originalOverlays:spec.overlays.map(x=>x.originalStamp),privateMessages:messages,configWitnesses};
 report.messages=messages;
 beforePrivate=witness(workspace,true);assert.deepEqual(vector(beforePrivate),sorted(spec.sourceFiles));
 });
 mechanismStart=performance.now();
 await phase('actual OPEN ingress + completionCREATE + diagnosticCREATE through actual source/Gate/Registry',async()=>{
  for(const message of report.messages)await source.admit('a8-private-authenticated-peer',message);
  const t=performance.now();await registry.startProject(scope);await settle();
  // Preserve native registry coalescing/analysis deadlines. No manually fired or suppressed clock.
  if(registry.diagnostics.timer!==null)await new Promise(r=>setTimeout(r,LANGUAGE_LIMITS.diagnosticCoalesceMs));
  await settle();assert.equal(launches.length,2,'Exactly both actual CREATE owners');assert.equal(report.seamStarts,2);assert.equal(registry.completion.active?.opened,true);assert.equal(registry.diagnostics.active?.opened,true);
  report.createToBothOwnedOpenedMs=performance.now()-t;
  const completion=launches.find(x=>x.generation===null),diagnostic=launches.find(x=>x.generation!==null);diagnosticGeneration=structuredClone(diagnostic.generation);
  assert.equal(diagnosticGeneration.sources.length,spec.overlays.length);diagnosticBefore=witness(diagnosticGeneration.immutableShadowDirectory);
  const completionShadow=completion.session.shadow;completionRootBefore=stamp(n.lstatSync(completionShadow.workspaceDirectory,{bigint:true}));completionDepsBefore=witness(join(completionShadow.workspaceDirectory,'.paircoach-dependencies'));
  assert.deepEqual(vector(diagnosticBefore),sorted(diagnostic.session.shadow.manifest.files.map(({path,bytes,sha256})=>({path,bytes,sha256}))));
  report.initialManifests=launches.map(x=>({launchId:x.session.launchId,manifest:x.session.shadow.manifest,generation:x.generation}));
  for(const launch of launches){const files=launch.session.shadow.manifest.files.filter(x=>x.origin==='dependency').map(({path,bytes,sha256})=>({path:path.slice('.paircoach-dependencies/'.length),bytes,sha256}));assert.deepEqual(sorted(files),sorted(spec.expectedDependencies));}
 });
 await phase('ONE ordinary strict CHANGE ingress + actual completion REFRESH + didChange/drain',async()=>{
  const first=report.messages.find(x=>x.payload.stamp.path===spec.refresh.path);assert.ok(first);const change={...first,messageId:'a8-one-ordinary-change',type:'LANGUAGE_CHANGE',payload:{stamp:{...first.payload.stamp,localModelVersion:first.payload.stamp.localModelVersion+1,requestGeneration:first.payload.stamp.requestGeneration+1,contentSha256:codec.contentSha256(spec.refresh.content)},content:spec.refresh.content,reason:'TYPING'}};
  await source.admit('a8-private-authenticated-peer',change);await registry.change(change.payload);await settle();
  assert.equal(launches.length,2,'No replacement CREATE before next diagnostic coalesce');assert.equal(report.seamStarts,2);
  assert.equal(report.frames.filter(x=>x.phase==='completion'&&x.frame.method==='textDocument/didChange').length,1);assert.equal(report.frames.filter(x=>x.frame.method==='textDocument/didOpen').length,spec.overlays.length*2);
  const completion=launches.find(x=>x.generation===null),afterDeps=witness(join(completion.session.shadow.workspaceDirectory,'.paircoach-dependencies'));
  assert.deepEqual(afterDeps,completionDepsBefore,'All unchanged dependency inode/mode/mtime/content witnesses retained');
  const afterRoot=stamp(n.lstatSync(completion.session.shadow.workspaceDirectory,{bigint:true}));assert.equal(afterRoot.dev,completionRootBefore.dev);assert.equal(afterRoot.ino,completionRootBefore.ino);
  assert.deepEqual(witness(diagnosticGeneration.immutableShadowDirectory),diagnosticBefore,'Diagnostic immutable original full source/dependencies never refreshed');
  assert.deepEqual(witness(workspace,true),beforePrivate,'Draft-only edit, zero original workspace writes');
  assert.equal(fs.readFileSync(join(completion.session.shadow.workspaceDirectory,spec.refresh.path),'utf8'),spec.refresh.content);
  const privateFinal=witness(completion.session.shadow.workspaceDirectory);assert.deepEqual(vector(privateFinal),sorted(completion.session.shadow.manifest.files.map(({path,bytes,sha256})=>({path,bytes,sha256}))));assert.deepEqual(privateFinal.entries.filter(e=>e.kind==='directory').map(e=>e.path).sort(),[...completion.session.shadow.manifest.directories].sort());report.privateOutputWitness=privateFinal;report.refreshManifest=completion.session.shadow.manifest;report.diagnosticGeneration=diagnosticGeneration;report.completionRoot={before:completionRootBefore,after:afterRoot};report.dependencyInodesStable=true;report.immutableDiagnosticsStable=true;report.workspaceVersion=core.workspace.workspaceVersion;assert.equal(core.workspace.workspaceVersion,0);
  report.mechanismElapsedMs=performance.now()-mechanismStart;
 });
 report.status='PASS_SCENARIO_OBSERVATION_NOT_LSP_READY';
} catch(e){report.status='FAIL_PRESERVED_NO_RETRY';report.error={message:String(e),stack:e?.stack};}
finally {
 if(timerStart===undefined)timerStart=performance.now();
 try{await phase('native dispose SAME owners + drain; retained on unknown',async()=>{if(registry){await settle();const retirement=await registry.disposeProject(scope);report.retirement=retirement;assert.equal(retirement.confirmed,true);}drain('after dispose');});}catch(e){report.cleanupError=String(e);report.status='FAIL_PRESERVED_NO_RETRY';}
 // No terminate, timeout kill, rm, FIFO release while IO is pending, or retry after failure.
 if(workersActive===0&&pendingAsync===0&&asyncFD.size===0){source?.retire();alive=false;core?.close();for(const t of openTransports){t.rpc.close(new Error('finite controlled seam disposal'));t.input.destroy();t.output.destroy();}}
 try{await phase('timed final original/cache/private native witnesses',async()=>{if(beforeOriginal){const after=witness(spec.sourceRoot);assert.deepEqual(after,beforeOriginal);report.originalSourceUnchanged=true;}if(beforeCache){const after=witness(spec.cacheRoot);assert.deepEqual(after,beforeCache);report.originalCacheUnchanged=true;}for(const f of spec.producerWitnesses)assert.equal(sha(fs.readFileSync(f.path)),f.sha256);report.finalNative={source:beforeOriginal&&witness(spec.sourceRoot),cache:beforeCache&&witness(spec.cacheRoot),privateSource:beforePrivate&&witness(workspace,true)};save('after-native.json',report.finalNative);drain('FINAL');});}catch(e){report.finalProofError=String(e);report.status='FAIL_PRESERVED_NO_RETRY';}
 report.wholeElapsedMs=performance.now()-timerStart;report.endedUTC=new Date().toISOString();report.providerControlledStartMs=providerMs;report.workerSummary={created:workerCreated,maxActive:workerMax,active:workersActive,pendingAsync,asyncFD:[...asyncFD],syncFD:[...syncFD]};
 if(workerMax>4||workersActive!==0||pendingAsync!==0||asyncFD.size!==0||syncFD.size!==0||report.gate.held!==0||report.forbiddenDriverCalls.length||report.scenarioOverflow.length){report.status='FAIL_PRESERVED_NO_RETRY';report.drainOrScopeFailure=true;}
 if(report.workers.some(x=>['dispatch','result','exit'].includes(x.kind)&&x.gate!==1)){report.status='FAIL_PRESERVED_NO_RETRY';report.workerOutsideGate=true;}
 report.processIncludingModulePreflightMs=performance.now()-moduleEntry;report.finalEmissionOutsideTimer='Final profile/terminal serialization + writes only; no production work excluded. Separate emission receipt follows.';report.totalWithin30s=report.wholeElapsedMs<=30000;report.existingCriterionMs=30000;report.performanceClaim='Report elapsed literally; no threshold, METRIC, clock, path, scan, freshness or currentness guard changed. Inclusive nested durations MUST NOT be summed. Extra native witness/report time disclosed; whole includes it.';
 const emissionStart=performance.now();save('profile.json',report);save('measurement-terminal.json',{status:report.status,endedUTC:report.endedUTC,wholeElapsedMs:report.wholeElapsedMs,mechanismElapsedMs:report.mechanismElapsedMs,workerSummary:report.workerSummary,gate:report.gate,forbiddenDriverCalls:report.forbiddenDriverCalls,cleanupError:report.cleanupError??null});
 n.writeFileSync(join(output,'final-emission.json'),JSON.stringify({ms:performance.now()-emissionStart,observerTotals:report.observer,processElapsedBeforeConsoleMs:performance.now()-moduleEntry})+'\n');
 console.log(JSON.stringify({status:report.status,wholeElapsedMs:report.wholeElapsedMs,mechanismElapsedMs:report.mechanismElapsedMs,totalWithin30s:report.totalWithin30s,output}));
 process.exitCode=report.status.startsWith('PASS_')?0:1;
}
