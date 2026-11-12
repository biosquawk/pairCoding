/** Delivery-only historical two-pin controller. NOT public product API or host admission.
 * PLAN has no child/write/network effects. Execution must be separately reviewed by K+ROOT.
 * All Docker calls, including accepted leaf prepare, cross the same fail-stop budget fence. */
import * as fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { isDeepStrictEqual as equal } from 'node:util';
const self = fileURLToPath(import.meta.url);
const check = (ok, why) => { if (!ok) throw new Error('NOTREADY: ' + why); };
export const digest = bytes => createHash('sha256').update(bytes).digest('hex');
export const planBytes = plan => Buffer.from(JSON.stringify(plan, null, 2) + '\n');
const proposalHash = '76519849a51863fb65bd92a81d844604b1ec3d623a53a122faa64bdb57bbbb73';
const cacheSnapshotHash = '26af27ad2fa0aa1e083412ef0a8f9d93eb13f39debd3b005410f28f0a581aa5c';
const base = 'f6a0a8562b3e1458bb914618ce81bf099da4e292';
const tree = 'a8d1d3fa277c3b4729f6aacee4bfe4ab160bd0d5';
const ids = ['java-maven-21--java-pattern', 'java-maven-27--java-pattern'];
const stamp = s => [s.dev,s.ino,s.size,s.mtimeNs,s.ctimeNs,s.mode,s.nlink].join(':');
const identity = s => [s.dev,s.ino,s.mode,s.uid].join(':');
const exact = (v, keys) => v && !Array.isArray(v) && Object.keys(v).sort().join(',') === [...keys].sort().join(',');
export const LIMITS = Object.freeze({ maxElapsedMs:1800000,maxCommandMs:480000,maxDockerCommands:1024,perCommandOutputBytes:4194304,maxNewRetainedReferences:11,maxHeavyConcurrency:1,runBuilds:2,dependencyPrepareContainers:2,languageBuilds:0,languageProbes:0,offlineContainers:0 });
export function assertCommandBudget(count, deadline, now=Date.now()) {
  check(Number.isSafeInteger(count) && count>=0 && count<LIMITS.maxDockerCommands && now<deadline, 'global/count fail-stop budget');
}
function canonical(directory) {
  check(typeof directory === 'string' && path.isAbsolute(directory) && path.resolve(directory) === directory && !/[,\x00-\x1f\x7f]/.test(directory), 'canonical absolute path required');
  let current = path.parse(directory).root;
  for (const part of directory.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part); const s = fs.lstatSync(current, {bigint:true});
    check(s.isDirectory() && !s.isSymbolicLink() && fs.realpathSync.native(current) === current, 'directory ancestry/link');
  }
  return directory;
}
function read(file, limit = 16*1024*1024) {
  canonical(path.dirname(file)); const s = fs.lstatSync(file, {bigint:true});
  check(s.isFile() && !s.isSymbolicLink() && s.nlink === 1n && s.size <= BigInt(limit), 'bounded regular no-link file');
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    check(stamp(s) === stamp(fs.fstatSync(fd,{bigint:true})), 'file identity on open');
    const bytes = Buffer.alloc(Number(s.size)+1); let count=0;
    while (count<bytes.length) { const n=fs.readSync(fd,bytes,count,bytes.length-count,null); if (!n) break; count+=n; }
    check(count===Number(s.size) && stamp(s)===stamp(fs.fstatSync(fd,{bigint:true})) && stamp(s)===stamp(fs.lstatSync(file,{bigint:true})), 'file changed on read');
    return bytes.subarray(0,count);
  } finally { fs.closeSync(fd); }
}
const json = file => JSON.parse(read(file));
function fileProof(file, expected) {
  const bytes=read(file,128*1024*1024), result={file,bytes:bytes.length,sha256:digest(bytes)};
  if (expected) check(equal(result,expected), 'historical/source file bytes differ: '+file);
  return result;
}
const contained = (parent, child) => child===parent || child.startsWith(parent+path.sep);
function absent(file) { try { fs.lstatSync(file); throw new Error('NOTREADY: output already exists; no resume/adoption'); } catch(e) { if(e.code!=='ENOENT') throw e; } }
function privateParent(output) {
  canonical(path.dirname(output)); const s=fs.lstatSync(path.dirname(output),{bigint:true});
  check(process.platform==='win32' || s.uid===BigInt(process.getuid()) && (s.mode&0o022n)===0n, 'owned non-group/world-writable output parent required');
  return identity(s); // New output and client directories are 0700. Parent may be trusted ROOT 0755.
}
/** Complete bounded inventory. Never truncate; bind bytes AND inode/stat/directory identity.
 * No hostile same-user-host race guarantee; canonical ancestors and O_NOFOLLOW around every read. */
export function inventory(root) {
  canonical(root); const files=[],directories=[]; let total=0;
  const visit=(dir,relative='',depth=0)=>{
    check(depth<=64 && directories.length<20000, 'inventory directory/depth ceiling');
    canonical(dir); const before=fs.lstatSync(dir,{bigint:true}); directories.push({path:relative,identity:stamp(before)});
    for (const name of fs.readdirSync(dir).sort()) {
      const full=path.join(dir,name), rel=relative?relative+'/'+name:name, s=fs.lstatSync(full,{bigint:true});
      check(!s.isSymbolicLink() && (s.isFile() || s.isDirectory()), 'inventory link/type');
      if (s.isDirectory()) visit(full,rel,depth+1);
      else {
        check(files.length<20000 && s.size<=128n*1024n*1024n && (total+=Number(s.size))<=2*1024**3, 'inventory file/byte ceiling');
        const bytes=read(full,128*1024*1024); check(stamp(s)===stamp(fs.lstatSync(full,{bigint:true})), 'inventory identity changed');
        files.push({path:rel,bytes:bytes.length,sha256:digest(bytes),identity:stamp(s)});
      }
    }
    check(stamp(before)===stamp(fs.lstatSync(dir,{bigint:true})), 'inventory directory changed');
  }; visit(root);
  files.sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0);
  return {files,directories,bytes:total};
}
const byteInventory = value => value.files.map(({path,bytes,sha256})=>({path,bytes,sha256}));
const summary = (root,value) => ({root,files:value.files.length,bytes:value.bytes,inventorySha256:digest(JSON.stringify(value))});
function verifySource(options,p) {
  canonical(options.producerRoot);
  check(p.producerSource.sha===base && p.producerSource.tree===tree && p.producerSource.sourceClosure.length===19, 'exact accepted source required');
  return p.producerSource.sourceClosure.map(f=>{
    check(/^(?:scripts\/[a-z-]+\.mjs|docker\/runtime\.Dockerfile|runtimes\/(?:catalog|production-inputs.lock)\.json)$/.test(f.path), 'closed installed source inventory');
    const actual=fileProof(path.join(options.producerRoot,f.path));
    check(actual.bytes===f.bytes && actual.sha256===f.sha256, 'accepted installed source changed: '+f.path);
    return {path:f.path,bytes:actual.bytes,sha256:actual.sha256};
  });
}
async function modules(root) {
  const load=name=>import(pathToFileURL(path.join(root,'scripts',name)).href);
  return {...await load('runtime-prepare.mjs'),...await load('runtime-image-retention.mjs'),...await load('runtime-files.mjs')};
}
function checkInventory(root, expected) {
  const value=inventory(root);
  check(equal(value.files.map(({path,sha256})=>({path,sha256})),expected), 'literal original tools/project inventory differs');
  return summary(root,value);
}
/** Only these four locators are inputs. Historical proposal/cache bytes are anchored, not authority.
 * New output may be relocated before freeze; input project/tool R1/R3 provenance may NOT change. */
export async function buildRecoveryPlan(options) {
  check(exact(options,['proposalFile','cacheSnapshotFile','producerRoot','outputRoot']), 'closed recovery options');
  for (const v of Object.values(options)) check(typeof v==='string' && path.isAbsolute(v) && path.resolve(v)===v, 'canonical options');
  const pb=read(options.proposalFile), cb=read(options.cacheSnapshotFile);
  check(digest(pb)===proposalHash && digest(cb)===cacheSnapshotHash, 'known original proposal/cache snapshot hashes required');
  const p=JSON.parse(pb), caches=JSON.parse(cb), sourceInventory=verifySource(options,p), m=await modules(options.producerRoot);
  const parentIdentity=privateParent(options.outputRoot); absent(options.outputRoot);
  check(p.initialRequiredPins.length===9 && p.preserveRun.length===7 && p.preserveLanguage.length===2 && equal(p.recoverOnly.map(j=>j.job),ids) && caches.roots.length===9, 'finite 7Run+2LANGUAGE+2missing scope');
  for (const pin of p.initialRequiredPins) { m.imagePin(pin.engine,pin.observedImage,pin.source); check(equal(pin.engine,p.engine), 'initial engine provenance'); }
  check(new Set(p.initialRequiredPins.map(pin=>pin.observedImage.Id)).size===9, 'distinct nine pins');
  const evidence=new Map(), addProof=record=>{ fileProof(record.file,record); evidence.set(record.file,record); };
  for (const record of [...p.requiredPriorEvidence,p.staging.frozenManifestSource,...p.preserveRun.map(j=>j.leafReceipt),...p.preserveLanguage.map(j=>j.receipt),...p.recoverOnly.map(j=>j.leafReceipt)]) addProof(record);
  const cacheInventories=caches.roots.map(c=>{
    check(p.preserveRun.some(j=>j.job===c.job) || ids.includes(c.job), 'unexpected historical cache job');
    const record=[...p.preserveRun,...p.recoverOnly].find(j=>j.job===c.job);
    check(c.leafReceipt===record.leafReceipt.file && c.leaf_sha256===record.leafReceipt.sha256, 'cache original receipt provenance');
    const leaf=json(c.leafReceipt); check(leaf.cacheEvidence.root===c.root, 'cache root differs from original leaf');
    const value=inventory(c.root); check(equal(byteInventory(value),[...c.files].sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0)), 'ALL9 historical cache bytes differ: '+c.job);
    return {job:c.job,...summary(c.root,value)};
  });
  check(new Set(cacheInventories.map(c=>c.job)).size===9, 'duplicate historical cache');
  const stages=[...new Set(p.recoverOnly.map(j=>path.dirname(j.proposedRequest.tools.root)))];
  const frozen=json(p.staging.frozenManifestSource.file).staging;
  check(digest(JSON.stringify(frozen.files.map(({bytes,path,sha256})=>({bytes,path,sha256}))))===p.staging.canonicalInventorySha256 && frozen.files.length===p.staging.fileCount && frozen.root===p.staging.root, 'original stage manifest binding');
  const protectedInventories=[];
  for (const root of stages) {
    const value=inventory(root); check(equal(byteInventory(value),frozen.files), 'literal staged asset bytes differ');
    protectedInventories.push(summary(root,value));
  }
  // All nine projects, old requests, LANGUAGE context/probes and staging journal remain read-only.
  const roots=[...new Set(caches.roots.map(c=>path.resolve(path.dirname(c.leafReceipt),'../..')))];
  for (const root of roots) for (const sub of ['projects','requests']) protectedInventories.push(summary(path.join(root,sub),inventory(path.join(root,sub))));
  const r3=path.dirname(p.preserveLanguage[0].receipt.file);
  protectedInventories.push(summary(path.join(r3,'language-contexts'),inventory(path.join(r3,'language-contexts'))));
  const r1=path.dirname(p.staging.root);
  const journal=path.join(r1,'download-journal/receipt.json'); addProof(fileProof(journal));
  const jobs=p.recoverOnly.map(j=>{
    const request={...structuredClone(j.proposedRequest),outputRoot:path.join(options.outputRoot,'jobs',j.job)};
    m.validateProductionRequest(m.validatePrepareRequest(request));
    check(equal({...request,installationId:j.request.installationId,outputRoot:j.request.outputRoot},j.request), 'only new installation/output may change');
    check(equal(json(j.leafReceipt.file).request,j.request), 'original leaf request binding');
    checkInventory(request.tools.root,request.tools.files); checkInventory(request.project.root,request.project.files);
    for (const record of j.sourceFiles) addProof(record);
    const spring=p.preserveRun.find(s=>s.job===request.key+'--spring-counter');
    check(spring && json(spring.leafReceipt.file).request.imageTag===request.imageTag, 'known current Spring mutable tag required');
    return {id:j.job,request,oldUnavailableId:j.oldUnavailableId,currentTagPin:spring.pin,toolchainIdentity:m.resolvePreparedToolchainIdentity(request)};
  });
  const protectedPaths=[options.producerRoot,path.dirname(self),options.proposalFile,options.cacheSnapshotFile,...evidence.keys(),...cacheInventories.map(c=>c.root),...protectedInventories.map(c=>c.root),...jobs.flatMap(j=>[j.request.tools.root,j.request.project.root])];
  for(const old of protectedPaths) check(!contained(old,options.outputRoot) && !contained(options.outputRoot,old), 'output overlaps old/source/evidence tree');
  const previousContainerIds=caches.roots.map(c=>json(c.leafReceipt).container.Id);
  const aggregate=json(p.preserveLanguage[0].receipt.file);
  for (const language of aggregate.language) for (const tool of language.tools) previousContainerIds.push(tool.container.Id);
  return {schemaVersion:1,phase:'TWO_PURE_PREPARE_ONLY_NOT_HOST_ADMISSION',base,tree,options,controller:fileProof(self),parentIdentity,sourceInventory,
    historical:{proposal:fileProof(options.proposalFile),cacheSnapshot:fileProof(options.cacheSnapshotFile),evidence:[...evidence.values()],cacheInventories,protectedInventories},
    engine:p.engine,initialRequiredPins:p.initialRequiredPins,previousContainerIds:[...new Set(previousContainerIds)],jobs,limits:{...LIMITS},
    guardPolicy:{maxAgeMs:60000,minFreeBytes:15*1024**3,requiredMeasurements:['vm','physical','host'],storagePaths:{vm:'/',physical:'D:\\',host:path.dirname(options.outputRoot)},schema:['schemaVersion','operator','observedAtMs','planSha256','controllerSha256','closureSha256','base','engine','measurements','singleHeavyLane'],authority:'EXTERNAL_ROOT_MEASUREMENTS_ONLY_NOT_SELF_ADMISSION'},
    readiness:'PREPARE_ONLY; separate K consumer binding and all offline/LSP/GUI/native checks still required'};
}
function assertProtected(plan) {
  const p=json(plan.options.proposalFile); verifySource(plan.options,p); fileProof(self,plan.controller);
  for (const f of [plan.historical.proposal,plan.historical.cacheSnapshot,...plan.historical.evidence]) fileProof(f.file,f);
  for (const item of [...plan.historical.cacheInventories,...plan.historical.protectedInventories]) check(equal(summary(item.root,inventory(item.root)),Object.fromEntries(Object.entries(item).filter(([k])=>k!=='job'))), 'old cache/staging/project/probe bytes or identity changed');
}
function validateGuards(plan,planHash,bytes,expected,now) {
  check(/^[a-f0-9]{64}$/.test(expected??'') && digest(bytes)===expected, 'exact fresh ROOT guard receipt hash required');
  const g=JSON.parse(bytes);
  check(exact(g,['schemaVersion','operator','observedAtMs','planSha256','controllerSha256','closureSha256','base','engine','measurements','singleHeavyLane']) && g.schemaVersion===1 && g.operator==='ROOT' && g.base===base && g.planSha256===planHash && g.controllerSha256===plan.controller.sha256 && g.closureSha256===digest(JSON.stringify(plan.sourceInventory)) && equal(g.engine,plan.engine), 'fresh source/plan/engine-bound guard measurements');
  check(Number.isSafeInteger(g.observedAtMs) && now-g.observedAtMs>=0 && now-g.observedAtMs<=plan.guardPolicy.maxAgeMs && g.singleHeavyLane===true, 'fresh ROOT single-heavy-lane guard');
  check(exact(g.measurements,['vm','physical','host']) && Object.values(g.measurements).every(v=>exact(v,['freeBytes','storagePath','evidenceFile','evidenceSha256']) && typeof v.storagePath==='string' && v.storagePath.length>0 && v.storagePath.length<=512 && !/[\x00-\x1f]/.test(v.storagePath) && Number.isSafeInteger(v.freeBytes) && v.freeBytes>=plan.guardPolicy.minFreeBytes), 'VM/physical/host >=15GiB measured guards');
  for(const [key,v] of Object.entries(g.measurements)) {check(v.storagePath===plan.guardPolicy.storagePaths[key], 'guard measured storage path differs');check(digest(read(v.evidenceFile))===v.evidenceSha256, 'guard raw measurement binding');}
  return g;
}
/** Programmatic injection is ONLY a Docker transport for modeled tests, never planner/prepare/guard
 * replacement. CLI has no env/argv module overrides. Real prepare and retention always execute. */
export async function executeRecoveryPlan(bytes,expectedHash,guardBytes,guardHash,dependencies={}) {
  check(exact(dependencies,Object.hasOwn(dependencies,'spawnSync')?['spawnSync']:[]) && (!dependencies.spawnSync || typeof dependencies.spawnSync==='function'), 'only injected Docker transport permitted');
  check(Buffer.isBuffer(bytes) && /^[a-f0-9]{64}$/.test(expectedHash??'') && digest(bytes)===expectedHash, 'exact reviewed plan bytes hash required');
  const plan=JSON.parse(bytes);
  check(equal(plan,await buildRecoveryPlan(plan.options)), 'closed frozen recovery plan/source/scope changed');
  const guard=validateGuards(plan,expectedHash,guardBytes,guardHash,Date.now());
  const m=await modules(plan.options.producerRoot), root=plan.options.outputRoot, start=Date.now(), deadline=start+plan.limits.maxElapsedMs;
  // No effects before all schema/hash/source/output/guard validation above.
  const publish=m.receiptWriter(root), receipt={schemaVersion:1,status:'STARTED_NOT_READY',phase:plan.phase,planSha256:expectedHash,guardSha256:guardHash,engine:plan.engine,commands:[],jobs:[]};
  let stopped=false,publicationFailed=false,client,activeJob=null,builds=0,creates=0; const references=new Set(),states=new Map(),removed=new Set();
  const save=()=>{check(!publicationFailed,'publication previously failed; no retry');try{publish(receipt);}catch(e){publicationFailed=true;stopped=true;throw e;}}; save();
  const endpoint=process.platform==='win32'?'npipe:////./pipe/docker_engine':'unix:///var/run/docker.sock';
  const engineArgs=['info','--format','{"ID":{{json .ID}},"ServerVersion":{{json .ServerVersion}},"OSType":{{json .OSType}},"Architecture":{{json .Architecture}}}'];
  const knownPins=new Map(plan.initialRequiredPins.map(pin=>[pin.observedImage.Id,pin]));
  let engineChecked=false,lastEngine=null;
  const wrappedSpawn=(exe,argv,options)=>{
    check(!stopped,'transport stopped; no later dispatch'); assertCommandBudget(receipt.commands.length,deadline);
    check(exe==='docker' && argv[0]==='--host' && argv[1]===endpoint && argv[2]==='--config' && path.dirname(argv[3])===client.configDirectory && /^command-[0-9]{6}$/.test(path.basename(argv[3])) && options.shell===false && options.maxBuffer<=plan.limits.perCommandOutputBytes && options.timeout>0 && options.timeout<=Math.min(plan.limits.maxCommandMs,deadline-Date.now()) && equal(Object.keys(options.env).sort(),['BUILDX_CONFIG','HOME','PATH']) && options.env.HOME===client.homeDirectory && options.env.BUILDX_CONFIG===client.buildxDirectory && options.env.PATH===process.env.PATH && fs.readdirSync(argv[3]).length===0, 'same owned empty-config bounded Docker transport');
    const args=argv.slice(4), command=args[0];
    verifySource(plan.options,json(plan.options.proposalFile)); fileProof(self,plan.controller);
    const mutating=['tag','pull','build','create','start','rm'].includes(command);
    check(command==='info' || engineChecked, 'fresh same-engine before every command');
    engineChecked=false;
    if (mutating) {
      check(lastEngine && equal(lastEngine,plan.engine), 'same-engine mutation fence');
      check(identity(fs.lstatSync(path.dirname(root),{bigint:true}))===plan.parentIdentity, 'output parent identity changed');
      // Guard age is required before first mutation; whole run is bounded by the reviewed deadline.
      if(!receipt.firstMutationAtMs) {check(Date.now()-guard.observedAtMs<=plan.guardPolicy.maxAgeMs,'guard expired before mutation');receipt.firstMutationAtMs=Date.now();}
    }
    if (command==='tag') {
      check(args.length===3 && knownPins.has(args[1]) && args[2]===m.retentionReference(knownPins.get(args[1])), 'exact declared retention reference/ID ceiling');
      if(!references.has(args[2])) check(references.size<11,'retained reference ceiling'); references.add(args[2]);
    } else if (command==='pull') {
      check(activeJob && args.length===3 && args[1]==='--platform=linux/amd64' && [activeJob.request.baseImage,activeJob.request.nodeImage,'maven@sha256:be898b0cf3929205778d61b2841aa36733513a79b0404f9cac67837863c8641f'].includes(args[2]), 'only accepted leaf pinned base pulls');
    } else if (command==='build') {
      check(activeJob && builds<2 && equal(args,['build','--pull=false','--network=none','--build-arg',`BASE_IMAGE=${activeJob.request.baseImage}`,'--build-arg',`NODE_IMAGE=${activeJob.request.nodeImage}`,'--tag',activeJob.request.imageTag,path.join(activeJob.request.outputRoot,'context')]), 'exact two Pure Run builds only'); builds++;
    } else if (command==='create') {
      check(activeJob && creates<2 && args.includes('paircoach.role=prepare') && args.includes('--memory=2g') && args.includes('--cpus=2') && args.includes('--pids-limit=256') && args[args.indexOf('--name')+1]===`paircoach-${activeJob.request.installationId}-prepare-${activeJob.request.key}` && args.includes('/opt/paircoach/runtime-cache.mjs'), 'exact two dependency containers only'); creates++;
    } else if (command==='rm') {
      const state=states.get(args[1]);
      check(activeJob && args.length===2 && state && !removed.has(args[1]) && state.State.Running===false && state.State.ExitCode===0 && state.Config.Labels?.['paircoach.installation']===activeJob.request.installationId && state.Config.Labels?.['paircoach.role']==='prepare' && knownPins.has(state.Config.Image), 'ordinary exact-ID terminal owned cleanup only');
      const leaf=json(path.join(activeJob.request.outputRoot,'receipt.json'));
      check(leaf.status==='COLLECTED_DURABLE' && equal(leaf.container,state), 'durable terminal collection before nonforce removal'); removed.add(args[1]);
    } else if (command==='start' || command==='logs' || command==='inspect') {
      check(activeJob && args.length===(command==='start'?3:2) && (command!=='start'||args[1]==='--attach') && args.at(-1)===`paircoach-${activeJob.request.installationId}-prepare-${activeJob.request.key}`, 'only exact new leaf lifecycle');
    } else check(command==='info' && equal(args,engineArgs) || command==='image' && args.length===3 && args[1]==='inspect' || command==='container' && args.length===3 && args[1]==='inspect' && (plan.previousContainerIds.includes(args[2]) || removed.has(args[2])) || equal(args,['ps','--filter','label=paircoach.installation','--format','{{.ID}}']), 'Docker operation outside finite scope');
    const entry={argv:['docker',...argv],status:'INTENT',startedAtMs:Date.now()}; receipt.commands.push(entry); save(); // durable even if dispatch/reply UNKNOWN
    let raw;
    try {
      raw=(dependencies.spawnSync??spawnSync)(exe,argv,options);
      check(raw && Buffer.byteLength(raw.stdout??'')+Buffer.byteLength(raw.stderr??'')<=plan.limits.perCommandOutputBytes,'per-command output ceiling');
      Object.assign(entry,{status:raw.error||raw.signal||raw.status===null?'UNKNOWN_RETAIN_AND_RECONCILE':'RETURNED',exit:raw.status,signal:raw.signal??null,error:raw.error?.message??null,stdout:raw.stdout??'',stderr:raw.stderr??'',finishedAtMs:Date.now()}); save();
      check(!raw.error && !raw.signal && Date.now()<deadline,'UNKNOWN/elapsed command; retain/reconcile');
      if(command==='info') {lastEngine=JSON.parse(raw.stdout);check(raw.status===0 && equal(lastEngine,plan.engine),'actual engine changed');engineChecked=true;}
      else if(command==='image' && raw.status===0) {
        const values=JSON.parse(raw.stdout); check(Array.isArray(values)&&values.length===1,'exact one image readback');
        if(knownPins.has(args[2])) m.assertImagePin(knownPins.get(args[2]),values[0]);
        if(activeJob && args[2]===activeJob.request.imageTag && builds===receipt.jobs.length) {
          const pin=m.imagePin(plan.engine,values[0],'measured new Pure '+activeJob.id);
          check(!plan.initialRequiredPins.some(p=>p.observedImage.Id===pin.observedImage.Id),'new Pure ID must not substitute an old/Spring pin');
          if(!knownPins.has(pin.observedImage.Id)) {check(knownPins.size<11,'11 immutable ID ceiling');knownPins.set(pin.observedImage.Id,pin);}
        }
      } else if(command==='inspect' && raw.status===0) {
        const values=JSON.parse(raw.stdout); check(Array.isArray(values)&&values.length===1,'single new terminal container'); const s=values[0]; states.set(s.Id,s);
      }
      if(raw.status!==0) {
        const ref=args.at(-1),missingImage=command==='image' && m.imageCommandOutput(args,raw,true)===null;
        const missingContainer=command==='container' && raw.status===1 && ['', '[]'].includes((raw.stdout??'').trim()) && [`Error: No such container: ${ref}`,`Error response from daemon: No such container: ${ref}`,`Error: No such object: ${ref}`].includes((raw.stderr??'').trim());
        check(missingImage || missingContainer,'failed operation; stop and retain');
      }
      return raw;
    } catch(e) {stopped=true;throw e;}
  };
  const invoke=(args)=>{
    const issued=m.beginDockerCommand(client);
    const raw=wrappedSpawn('docker',['--host',endpoint,'--config',issued.configDirectory,...args],{env:issued.env,shell:false,encoding:'utf8',timeout:Math.max(1,Math.min(plan.limits.maxCommandMs,deadline-Date.now())),maxBuffer:plan.limits.perCommandOutputBytes});
    m.finishDockerCommand(client,issued);return raw;
  };
  const run=(args,missing=false)=>{invoke(engineArgs); const raw=invoke(args); m.imageCommandOutput(args,raw,missing);return raw;};
  const oneImage=ref=>{const raw=run(['image','inspect',ref]);return JSON.parse(raw.stdout)[0];};
  try {
    client=m.createDockerClientState(root); receipt.clientState=client; save();
    invoke(engineArgs);
    check(invoke(['ps','--filter','label=paircoach.installation','--format','{{.ID}}']).stdout.trim()==='', 'owned running resource present');
    for(const id of plan.previousContainerIds) {invoke(engineArgs);check(invoke(['container','inspect',id]).status===1,'old terminal resource unexpectedly present');}
    // Check ALL pins and known original mutable refs BEFORE ANY tag, not interleaved retain.
    for(const pin of plan.initialRequiredPins) m.assertImagePin(pin,oneImage(pin.observedImage.Id));
    const p=json(plan.options.proposalFile);
    for (const prior of p.preserveRun) m.assertImagePin(prior.pin,oneImage(json(prior.leafReceipt.file).request.imageTag));
    for (const prior of p.preserveLanguage) m.assertImagePin(prior.pin,oneImage(json(prior.receipt.file).language.find(l=>l.key===prior.key).imageTag));
    for(const job of plan.jobs) {
      check(run(['image','inspect',job.oldUnavailableId],true).status===1, 'historical missing ID unexpectedly present; reconcile');
      m.assertImagePin(job.currentTagPin,oneImage(job.request.imageTag));
    }
    assertProtected(plan); // full ALL9 inventories fresh before FIRST mutation
    const retention=m.createImageRetention({engine:plan.engine,requiredPins:plan.initialRequiredPins,run,receipt,save});retention.retainRequired();
    fs.mkdirSync(path.join(root,'jobs'),{mode:0o700});
    for (const job of plan.jobs) {
      activeJob=job; receipt.jobs.push({id:job.id,status:'PREPARE_INTENT'});save();
      assertProtected(plan); m.assertImagePin(job.currentTagPin,oneImage(job.request.imageTag));
      const prepared=m.prepare(job.request,true,deadline,plan.engine,{endpoint,configDirectory:client.configDirectory,clientState:client,spawnSync:wrappedSpawn},retention.pins());
      check(prepared.status==='PREPARED_REQUIRES_OFFLINE_AND_TOOL_VALIDATION' && equal(prepared.request,job.request) && equal(prepared.engine,plan.engine) && equal(json(path.join(job.request.outputRoot,'receipt.json')),prepared) && prepared.toolchainHash===job.toolchainIdentity.toolchainHash, 'actual durable prepare identity');
      const expectedIds=[...retention.pins().map(p=>p.observedImage.Id),prepared.imageId].sort();
      check(equal(prepared.imageRetention.pins.map(e=>e.pin.observedImage.Id).sort(),expectedIds), 'leaf prior-pin set exact; no extra inferred IDs');
      retention.add(m.imagePin(plan.engine,prepared.imageInspect,path.join(job.request.outputRoot,'receipt.json')));
      invoke(engineArgs);check(invoke(['container','inspect',prepared.container.Id]).status===1,'new exact container absence after nonforce remove');
      receipt.jobs.at(-1).status='PREPARED_OFFLINE_DEFERRED'; receipt.jobs.at(-1).receipt=fileProof(path.join(job.request.outputRoot,'receipt.json'));save();activeJob=null;
    }
    check(builds===2 && creates===2 && removed.size===2 && retention.pins().length===11 && knownPins.size===11,'exact two preparations and final11 proof');
    retention.verifyAll(); assertProtected(plan);
    check(Date.now()<deadline,'overall budget before publication');
    receipt.status='RECOVERY2_PREPARE_ONLY_COMPLETE_NOT_CONSUMER_OR_PRODUCT_ACCEPTANCE';save();return receipt;
  } catch(e) {
    stopped=true;receipt.status='FAILED_RETAIN_AND_RECONCILE';receipt.error=e.message;
    if(!publicationFailed)save();throw e;
  }
}
if (process.argv[1] && path.resolve(process.argv[1])===self) {
  try {
    const args=process.argv.slice(2);
    if(args[0]==='execute') {
      check(args.length===5,'execute PLAN.json SHA256 ROOT-GUARDS.json SHA256; separate K+ROOT admission required');
      await executeRecoveryPlan(read(path.resolve(args[1])),args[2],read(path.resolve(args[3])),args[4]);
    } else {
      check(args.length===1 || args.length===2 && args[0]==='plan','[plan] OPTIONS.json (default read-only)');
      const bytes=planBytes(await buildRecoveryPlan(json(path.resolve(args.at(-1)))));check(bytes.length<=4*1024*1024,'bounded plan stdout');process.stdout.write(bytes);
    }
  } catch(e) {console.error(e.message);process.exitCode=1;}
}
