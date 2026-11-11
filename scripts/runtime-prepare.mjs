/** Explicit operator utility. Default only validates/plans; --execute requires reviewed concrete pins.
 * Never called automatically by Run/Test. No host language toolchains, private home, env forwarding or docker.sock mounts.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, mkdirSync, lstatSync, readdirSync, copyFileSync, chmodSync } from 'node:fs';
import path from 'node:path';
import { dependencyHash } from './runtime-dependencies.mjs';
import { literalPath } from './runtime-spec.mjs';
import { fileURLToPath } from 'node:url';
import { receiptWriter, canonicalDirectory, readPrivate } from './runtime-files.mjs';
const repo=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const mavenImage='maven@sha256:be898b0cf3929205778d61b2841aa36733513a79b0404f9cac67837863c8641f';
const hash = b=>createHash('sha256').update(b).digest('hex');
const exact=(o,ks)=>o && Object.keys(o).sort().join(',')===[...ks].sort().join(',');
const pin=s=>typeof s==='string' && /^[a-z0-9][a-z0-9._/:+-]*@sha256:[a-f0-9]{64}$/.test(s);
export function validatePrepareRequest(r) {
  if (!exact(r,['schemaVersion','workingDirectory','installationId','family','key','imageTag','baseImage','nodeImage','tools','project','expectedTools','dependencySha256','outputRoot']) || r.schemaVersion!==1 || r.workingDirectory!=='.' && !literalPath(r.workingDirectory) || !/^[a-z0-9-]{1,64}$/.test(r.installationId) || !['node','typescript','python','java-maven'].includes(r.family) || !/^[a-z0-9][a-z0-9.-]{0,63}$/.test(r.key) || !/^paircoach\/runtime-[a-z0-9.-]+:[a-z0-9.-]+$/.test(r.imageTag) || !pin(r.baseImage) || !pin(r.nodeImage) || !path.isAbsolute(r.outputRoot) || /[,\x00-\x1f]/.test(r.outputRoot) || !/^[a-f0-9]{64}$/.test(r.dependencySha256)) throw new Error('NOTREADY: complete explicit pinned preparation request required');
  if(!Array.isArray(r.expectedTools) || !r.expectedTools.length || new Set(r.expectedTools.map(t=>t.name)).size!==r.expectedTools.length || r.expectedTools.some(t=>!exact(t,['name','version']) || !['node','typescript','python','pytest','java','javac','maven'].includes(t.name) || !/^[A-Za-z0-9._+() -]{1,128}$/.test(t.version))) throw new Error('NOTREADY: exact expected tool versions required');
  const required=['node',...(r.family==='typescript'?['typescript']:r.family==='python'?['python','pytest']:r.family==='java-maven'?['java','javac','maven']:[])];
  if(required.some(n=>!r.expectedTools.some(t=>t.name===n))) throw new Error('NOTREADY: family tool version missing');
  for (const set of [r.tools,r.project]) {
    if (!exact(set,['root','files']) || !path.isAbsolute(set.root) || /[,\x00-\x1f]/.test(set.root) || ['/',process.env.HOME].includes(path.resolve(set.root)) || !Array.isArray(set.files) || !set.files.length || set.files.length > 20000 || new Set(set.files.map(f=>f.path)).size!==set.files.length) throw new Error('NOTREADY: explicit bounded inventory required');
    for (const f of set.files) {
      if (!exact(f,['path','sha256']) || typeof f.path!=='string' || !/^[a-f0-9]{64}$/.test(f.sha256) || f.path.startsWith('/') || /[\\\x00-\x1f,]/.test(f.path) || f.path.split('/').some(p=>!p || p==='.' || p==='..' || p.startsWith('.env') || ['.git','.m2','.aws','.ssh','.paircoach'].includes(p) || set===r.project && ['node_modules','target','__pycache__'].includes(p))) throw new Error('NOTREADY: unsafe inventory path');
    }
  }
  if(dependencyHash(r.project.files)!==r.dependencySha256) throw new Error('Dependency inventory hash differs');
  return r;
}

export function validateProductionRequest(r) {
  const lock=JSON.parse(readPrivate(path.join(repo,'runtimes/production-inputs.lock.json'),1024*1024).bytes);
  const catalog=JSON.parse(readPrivate(path.join(repo,'runtimes/catalog.json'),1024*1024).bytes);
  const profile=catalog.profiles.find(p=>p.id===r.key);
  if(!profile || profile.adapterFamily!==r.family || JSON.stringify(profile.expectedTools)!==JSON.stringify(r.expectedTools)) throw new Error('NOTREADY: reviewed production profile required');
  const key=profile.compilerRelease?'java'+profile.compilerRelease:r.family==='python'?'python':'node';
  if(r.baseImage!==lock.images[key].reference || r.nodeImage!==lock.images.node.reference || lock.images.maven.reference!==mavenImage) throw new Error('NOTREADY: production image pin differs');
  const approved=lock.artifacts.filter(a=>a.kind==='npm').flatMap(a=>a.files.map(f=>({path:'node_modules/'+a.name+'/'+f.path,sha256:f.sha256}))).sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0);
  if(JSON.stringify([...r.tools.files].sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0))!==JSON.stringify(approved)) throw new Error('NOTREADY: production tool inventory differs');
  return r;
}

function ownedParents(root,relative) {
  let current=canonicalDirectory(root);
  for(const part of relative.split(path.sep).filter(p=>p&&p!=='.')) {
    if(part==='..') throw new Error('Unsafe owned directory');
    const child=path.join(current,part);
    try {mkdirSync(child,{mode:0o700});}catch(e){if(e.code!=='EEXIST')throw e;}
    current=canonicalDirectory(child);
  }
  return current;
}
function inventory(set) {
  const root=canonicalDirectory(set.root), actual=[]; let bytes=0;
  if(root!==path.resolve(set.root)) throw new Error('Input root symlink');
  const walk=(dir,rel='',depth=0)=>{
    if(depth>64) throw new Error('Inventory depth');
    for(const name of readdirSync(dir).sort()) {
      if(name.startsWith('.env') || ['.git','.m2','.aws','.ssh','.paircoach'].includes(name)) throw new Error('Secret/private inventory forbidden');
      const full=path.join(dir,name),p=rel?`${rel}/${name}`:name,st=lstatSync(full,{bigint:true});
      if(st.isSymbolicLink() || !st.isDirectory() && !st.isFile()) throw new Error('Nonregular prepare input');
      if(st.isDirectory()) { canonicalDirectory(full); walk(full,p,depth+1); } else {
        if(actual.length>=20000 || st.size>16n*1024n*1024n || (bytes+=Number(st.size))>256*1024*1024) throw new Error('Prepare inventory limit');
        actual.push({path:p,sha256:hash(readPrivate(full,16*1024*1024).bytes)});
      }
    }
  }; walk(root);
  if(JSON.stringify(actual.sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0))!==JSON.stringify([...set.files].sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0))) throw new Error('Prepare inventory differs');
  return actual;
}
// Single producer-owned identity formula. Reads installed source/validated metadata only;
// deliberately does not require former staging/project/output roots to exist, and never writes/spawns.
function preparedIdentity(r) {
  const dispatcherFiles=['scripts/runtime-task.mjs','scripts/runtime-pom.mjs','scripts/runtime-spec.mjs','scripts/runtime-cache.mjs','scripts/runtime-tools.mjs','scripts/runtime-dependencies.mjs','scripts/runtime-artifacts.mjs','docker/runtime.Dockerfile'].map(p=>({path:p,sha256:hash(readPrivate(path.join(repo,p),4*1024*1024).bytes)}));
  const toolchainHash=hash(Buffer.from(JSON.stringify({base:r.baseImage,node:r.nodeImage,maven:mavenImage,tools:[...r.tools.files].sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0),versions:r.expectedTools,dispatcher:dispatcherFiles})));
  return {toolchainHash,dispatcherFiles};
}
export function resolvePreparedToolchainIdentity(request) {
  return preparedIdentity(validateProductionRequest(validatePrepareRequest(request)));
}
export function prepare(request,execute=false,deadline=Infinity,expectedEngine=null) {
  const r=validatePrepareRequest(request); inventory(r.tools); inventory(r.project);
  if(execute) validateProductionRequest(r);
  const {toolchainHash,dispatcherFiles}=execute?resolvePreparedToolchainIdentity(r):preparedIdentity(r),out=path.resolve(r.outputRoot);
  // All writes restricted to new explicit owned directory; no retry overwrites of uncertain operations.
  const publish=receiptWriter(out);
  const receipt={schemaVersion:1,status:execute?'STARTED':'PLAN_ONLY_NOT_PREPARED',startedAt:new Date().toISOString(),request:r,toolchainHash,dispatcherFiles,durability:{regularFile:'WRITABLE_HANDLE_FSYNC_REQUIRED',directory:process.platform==='win32'?'WIN32_DIRECTORY_FSYNC_MAY_BE_UNAVAILABLE':'POSIX_FSYNC_REQUIRED',privacy:process.platform==='win32'?'TRUSTED_PRIVATE_PARENT_INHERITED_ACL':'MODE_0700'},commands:[]};
  let publicationFailed=false;
  const save=()=>{try{return publish(receipt);}catch(e){publicationFailed=true;throw e;}}; save();
  const invoke=(args)=>{
    if(Date.now()>=deadline) throw new Error('Preparation global budget reached; retain/reconcile');
    const startedAt=new Date().toISOString(),res=spawnSync('docker',args,{env:{PATH:process.env.PATH,HOME:path.join(out,'docker-home')},shell:false,encoding:'utf8',timeout:Math.max(1,Math.min(480000,deadline-Date.now())),maxBuffer:4*1024*1024});
    receipt.commands.push({argv:['docker',...args],startedAt,finishedAt:new Date().toISOString(),exit:res.status,signal:res.signal,error:res.error?.message??null,stdout:res.stdout,stderr:res.stderr}); save();
    if(res.error || res.status!==0) throw new Error('Preparation operation failed; retain receipt/resources, reconcile by exact inspection before retry.'); return res.stdout;
  };
  const engineArgs=['info','--format','{"ID":{{json .ID}},"ServerVersion":{{json .ServerVersion}},"OSType":{{json .OSType}},"Architecture":{{json .Architecture}}}'];
  const observeEngine=()=>{
    const engine=JSON.parse(invoke(engineArgs));
    if(!exact(engine,['ID','ServerVersion','OSType','Architecture']) || Object.values(engine).some(v=>typeof v!=='string' || !v || v.length>256) || engine.OSType!=='linux' || !['x86_64','amd64'].includes(engine.Architecture)) throw new Error('Actual engine identity missing/unsupported');
    return engine;
  };
  const checkEngine=()=>{const actual=observeEngine();if(JSON.stringify(actual)!==JSON.stringify(receipt.engine))throw new Error('Preparation engine changed; retain/reconcile');};
  const run=args=>{checkEngine();return invoke(args);};
  try {
    if(!execute) return receipt;
    mkdirSync(path.join(out,'docker-home')); receipt.engine=observeEngine();save();
    if(expectedEngine && JSON.stringify(receipt.engine)!==JSON.stringify(expectedEngine))throw new Error('Reviewed preparation engine differs');
    const context=path.join(out,'context'); mkdirSync(context); mkdirSync(path.join(context,'tools')); mkdirSync(path.join(context,'scripts'));
    for(const f of r.tools.files) { const dest=path.join(context,'tools',f.path); ownedParents(path.join(context,'tools'),path.dirname(f.path)); copyFileSync(path.join(r.tools.root,f.path),dest); }
    for(const f of ['runtime-task.mjs','runtime-pom.mjs','runtime-spec.mjs','runtime-cache.mjs','runtime-tools.mjs','runtime-dependencies.mjs','runtime-artifacts.mjs']) copyFileSync(path.join(repo,'scripts',f),path.join(context,'scripts',f));
    copyFileSync(path.join(repo,'docker/runtime.Dockerfile'),path.join(context,'Dockerfile'));
    inventory(r.tools); inventory(r.project); inventory({root:path.join(context,'tools'),files:r.tools.files});
    // Explicit pulls only here, NEVER in Run. Build uses local images/pull=false.
    run(['pull','--platform=linux/amd64',r.baseImage]); if(r.baseImage!==r.nodeImage) run(['pull','--platform=linux/amd64',r.nodeImage]);
    run(['pull','--platform=linux/amd64',mavenImage]);
    run(['build','--pull=false','--network=none','--build-arg',`BASE_IMAGE=${r.baseImage}`,'--build-arg',`NODE_IMAGE=${r.nodeImage}`,'--tag',r.imageTag,context]);
    const image=JSON.parse(run(['image','inspect',r.imageTag]));
    if(image.length!==1 || !/^sha256:[a-f0-9]{64}$/.test(image[0].Id) || image[0].Config.User!=='10001:10001' || image[0].Config.Entrypoint?.length) throw new Error('Image inspect identity missing');
    receipt.imageId=image[0].Id; receipt.imageInspect=image[0];
    receipt.observedImage={Id:image[0].Id,RepoDigests:image[0].RepoDigests??[],Descriptor:image[0].Descriptor??null}; // never substitute config/image ID for manifest identity
    const cache=path.join(out,'cache',r.family,toolchainHash,r.dependencySha256); ownedParents(out,path.relative(out,cache)); chmodSync(cache,0o777);
    const name=`paircoach-${r.installationId}-prepare-${r.key}`; receipt.containerName=name; receipt.status='CONTAINER_INTENT'; save();
    const common=['--pull=never','--name',name,'--label',`paircoach.installation=${r.installationId}`,'--label','paircoach.role=prepare','--user','10001:10001','--cap-drop=ALL','--security-opt=no-new-privileges','--read-only','--network=bridge','--memory=2g','--cpus=2','--pids-limit=256','--log-driver=json-file','--log-opt','max-size=10m','--log-opt','max-file=1','--tmpfs','/tmp:rw,nosuid,size=256m,mode=1777','--tmpfs','/workspace:rw,nosuid,size=1g,uid=10001,gid=10001','--mount',`type=bind,source=${r.project.root},target=/input,readonly`,'--mount',`type=bind,source=${cache},target=/cache/0`];
    // No auto-rm: artifacts/exit/ownership durable before exact nonforce cleanup.
    run(['create',...common,image[0].Id,'/opt/paircoach/node/bin/node','/opt/paircoach/runtime-cache.mjs',r.family,Buffer.from(JSON.stringify(r.expectedTools)).toString('base64url'),r.workingDirectory,r.dependencySha256]);
    run(['start','--attach',name]);
    const state=JSON.parse(run(['inspect',name]));
    if(state.length!==1 || state[0].State.Running || state[0].State.ExitCode!==0 || state[0].Config.Image!==image[0].Id || state[0].Config.Labels?.['paircoach.installation']!==r.installationId || state[0].Config.Labels?.['paircoach.role']!=='prepare') throw new Error('Prepare terminal ownership uncertain');
    receipt.container=state[0]; receipt.status='CACHE_PREPARED_IMAGE_PIN_NOT_PUBLISHED'; save();
    run(['logs',name]); inventory(r.project);
    const tools=readPrivate(path.join(cache,'tools.json'),65536),dependencies=readPrivate(path.join(cache,'dependencies-prepared.json'),65536);
    const actualTools=JSON.parse(tools.bytes),evidence=JSON.parse(dependencies.bytes);
    if(!Array.isArray(actualTools) || r.expectedTools.some(t=>!actualTools.some(a=>a.name===t.name && a.version===t.version)) || evidence.family!==r.family || evidence.workingDirectory!==r.workingDirectory || evidence.dependencySha256!==r.dependencySha256 || JSON.stringify(evidence.tools)!==JSON.stringify(actualTools))throw new Error('Prepared cache/tool evidence differs');
    receipt.cacheEvidence={root:cache,tools:{path:'tools.json',sha256:hash(tools.bytes),actual:actualTools},dependencies:{path:'dependencies-prepared.json',sha256:hash(dependencies.bytes),actual:evidence}};
    receipt.status='COLLECTED_DURABLE'; save();
    // Operators publish production images.lock only after separate exact tools/offline check. Local imageId is NOT invented registry digest.
    if(!/^sha256:[a-f0-9]{64}$/.test('sha256:'+state[0].Id)) throw new Error('Terminal container ID malformed');
    run(['rm',state[0].Id]); checkEngine(); receipt.status='PREPARED_REQUIRES_OFFLINE_AND_TOOL_VALIDATION'; save(); return receipt;
  } catch(err) { receipt.status='FAILED_RETAIN_AND_RECONCILE'; receipt.error=err.message; if(!publicationFailed)save(); throw err; }
}
if (process.argv[1] && fileURLToPath(import.meta.url)===path.resolve(process.argv[1])) {
  try { const args=process.argv.slice(2); if(args.length<1 || args.length>2 || args[1] && args[1]!=='--execute') throw new Error('Usage: node scripts/runtime-prepare.mjs REQUEST.json [--execute]'); prepare(JSON.parse(readFileSync(args[0],'utf8')),args[1]==='--execute'); }
  catch(err) { console.error(err.message); process.exitCode=1; }
}
