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
import { createImageRetention, imageCommandOutput, assertImagePin } from './runtime-image-retention.mjs';
import { isDeepStrictEqual } from 'node:util';
import { receiptWriter, canonicalDirectory, readPrivate, stamp } from './runtime-files.mjs';
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
  for(const part of relative.split(/[\\/]/).filter(p=>p&&p!=='.')) {
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
// In-process ownership capability: never adopt an existing HOME/metadata directory or deserialize
// authority from JSON/env. Paths are fixed disjoint children of an already-new private receipt root.
const dockerClients = new WeakMap();
export function createDockerClientState(root) {
  if (typeof root !== 'string' || !path.isAbsolute(root) || path.resolve(root) !== root) throw new Error('Canonical owned Docker client root required');
  canonicalDirectory(root);
  const owner = lstatSync(root, { bigint: true });
  const privateDirectory = st => st.isDirectory() && !st.isSymbolicLink() && (process.platform === 'win32' || (st.mode & 0o077n) === 0n && st.uid === BigInt(process.getuid()));
  if (!privateDirectory(owner)) throw new Error('Docker client root must be private and owned');
  const client = Object.freeze({ root, configDirectory: path.join(root, 'docker-config'), homeDirectory: path.join(root, 'docker-home'), buildxDirectory: path.join(root, 'docker-buildx') });
  // Preflight ALL paths before creation, no partial adoption and no deleting old/unknown state.
  for (const dir of [client.configDirectory, client.homeDirectory, client.buildxDirectory]) {
    try { lstatSync(dir); throw new Error('Docker client state already exists; retain/reconcile'); }
    catch (e) { if (e.code !== 'ENOENT') throw e; }
  }
  for (const dir of [client.configDirectory, client.homeDirectory, client.buildxDirectory]) mkdirSync(dir, { mode: 0o700 });
  const identities = [root, client.configDirectory, client.homeDirectory, client.buildxDirectory].map(dir => ({ dir, st: lstatSync(dir, { bigint: true }) }));
  dockerClients.set(client, { identities, privateDirectory, commands: [], active: null });
  dockerClientEnvironment(client); return client;
}
/** Validate names/stat only: never read metadata/token/log contents. No same-user malicious-host
 * race guarantee; receipt root identity + canonical ancestry rechecked around every bounded child. */
function assertDockerClient(client, finishing = null) {
  const owned = dockerClients.get(client);
  if (!owned) throw new Error('Unowned Docker client state; no aliases/outside-root authority');
  for (const { dir, st } of owned.identities) {
    canonicalDirectory(dir); const now = lstatSync(dir, { bigint: true });
    if (!owned.privateDirectory(now) || now.dev !== st.dev || now.ino !== st.ino) throw new Error('Owned Docker client directory identity changed');
  }
  const dirs = readdirSync(client.configDirectory).sort();
  if (JSON.stringify(dirs) !== JSON.stringify(owned.commands.map(c => path.basename(c.configDirectory)).sort())) throw new Error('Unexpected Docker credential pool entry; retain/reconcile');
  for (const command of owned.commands) {
    canonicalDirectory(command.configDirectory);
    const now = lstatSync(command.configDirectory, { bigint: true });
    if (!owned.privateDirectory(now) || now.dev !== command.identity.dev || now.ino !== command.identity.ino) throw new Error('Docker command config identity changed');
    if (command === finishing) continue;
    if (command === owned.active) {
      if (readdirSync(command.configDirectory).length) throw new Error('Dedicated command Docker config must be empty before child');
    } else if (JSON.stringify(command.evidence) !== JSON.stringify(configMetadata(command.configDirectory))) throw new Error('Retired Docker credential config changed; never reuse');
  }
  let count = 0;
  const visit = (dir, depth = 0) => {
    if (depth > 32) throw new Error('Docker client metadata depth limit');
    for (const name of readdirSync(dir)) {
      if (++count > 4096) throw new Error('Docker client metadata count limit');
      const file = path.join(dir, name), st = lstatSync(file, { bigint: true });
      if (st.isSymbolicLink() || !st.isDirectory() && !st.isFile() || st.isFile() && st.nlink !== 1n || process.platform !== 'win32' && st.uid !== BigInt(process.getuid())) throw new Error('Unsafe Docker client metadata link/type/owner');
      if (st.isDirectory()) { canonicalDirectory(file); visit(file, depth + 1); }
    }
  };
  visit(client.homeDirectory); visit(client.buildxDirectory);
  return owned;
}
// Newly-created per-command configs are NEVER reused or deleted. BuildKit may create its own
// seed metadata outside BUILDX_CONFIG. Only these two regular owned names can retire unread;
// auth/config.json/unknown writes fail closed. This is NOT acceptance of any nonempty input config.
function configMetadata(directory) {
  return readdirSync(directory).sort().map(name => {
    if (!['.token_seed', '.token_seed.lock'].includes(name)) throw new Error('Unexpected Docker credential config write; retain/reconcile');
    const st = lstatSync(path.join(directory, name), { bigint: true });
    if (!st.isFile() || st.isSymbolicLink() || st.nlink !== 1n || process.platform !== 'win32' && st.uid !== BigInt(process.getuid())) throw new Error('Unsafe Docker command metadata link/type/owner');
    return { name, identity: stamp(st) }; // stat only, no token/lock/log read
  });
}
export function dockerClientEnvironment(client) {
  assertDockerClient(client);
  return { PATH: process.env.PATH, HOME: client.homeDirectory, BUILDX_CONFIG: client.buildxDirectory };
}
export function beginDockerCommand(client) {
  const owned = assertDockerClient(client);
  if (owned.active || owned.commands.length >= 4096) throw new Error('Docker client command overlap/count limit');
  const configDirectory = path.join(client.configDirectory, 'command-' + String(owned.commands.length + 1).padStart(6, '0'));
  mkdirSync(configDirectory, { mode: 0o700 }); canonicalDirectory(configDirectory);
  const command = { configDirectory, identity: lstatSync(configDirectory, { bigint: true }), evidence: null };
  owned.commands.push(command); owned.active = command;
  return Object.freeze({ configDirectory, env: Object.freeze(dockerClientEnvironment(client)) });
}
export function finishDockerCommand(client, issued) {
  const owned = dockerClients.get(client), command = owned?.active;
  if (!command || issued.configDirectory !== command.configDirectory) throw new Error('Unowned Docker command completion');
  assertDockerClient(client, command);
  command.evidence = configMetadata(command.configDirectory); owned.active = null;
  assertDockerClient(client);
}

/** Cancellation never adopts by name alone. Only a returned create ID from this execution,
 * exact engine (caller's run), image, labels and private input/cache mounts authorize kill.
 * Leave the stopped container, cache, images and receipts intact; no rm/retry/recovery protocol. */
export function stopOwnedPreparation(request, receipt, run, save) {
  const id = receipt.createdContainerId, name = receipt.containerName;
  if (!/^[a-f0-9]{64}$/.test(id ?? '') || name !== `paircoach-${request.installationId}-prepare-${request.key}` || !/^sha256:[a-f0-9]{64}$/.test(receipt.imageId ?? '')) throw new Error('Cancellation ownership unknown; retain/reconcile, no stop by name');
  const cache = path.join(request.outputRoot, 'cache', request.family, receipt.toolchainHash, request.dependencySha256);
  const observe = () => {
    const values = JSON.parse(run(['inspect', id]).stdout), c = values?.[0];
    if (!Array.isArray(values) || values.length !== 1 || c.Id !== id || c.Name !== '/' + name || c.Config?.Image !== receipt.imageId || c.Config.Labels?.['paircoach.installation'] !== request.installationId || c.Config.Labels?.['paircoach.role'] !== 'prepare' || typeof c.State?.Running !== 'boolean' || !Array.isArray(c.Mounts)) throw new Error('Cancellation exact container identity unknown; retain/reconcile');
    const mounts = c.Mounts.filter(m => m.Type === 'bind');
    if (mounts.length !== 2 || !mounts.some(m => m.Source === request.project.root && m.Destination === '/input' && m.RW === false) || !mounts.some(m => m.Source === cache && m.Destination === '/cache/0' && m.RW === true)) throw new Error('Cancellation container mounts differ; no foreign stop');
    return c;
  };
  receipt.cancellation = { status: 'INSPECTING_OWNED_CONTAINER', containerId: id }; save();
  const before = observe();
  if (before.State.Running) {
    receipt.cancellation.status = 'KILL_INTENT'; save();
    run(['kill', '--signal=KILL', id]);
  }
  const after = observe();
  if (after.State.Running) throw new Error('Cancellation termination unconfirmed; retain/reconcile');
  receipt.cancellation.status = 'STOPPED_RETAINED'; receipt.cancellation.observed = after; save();
}

// Optional explicit transport retains endpoint/config fields; an in-process owned client capability
// is required for shared outer/nested state. No arbitrary existing home/state path is accepted.
export function prepare(request,execute=false,deadline=Infinity,expectedEngine=null,transport=null,requiredPins=[]) {
  if(transport!==null) {
    if(!transport || !['unix:///var/run/docker.sock','npipe:////./pipe/docker_engine'].includes(transport.endpoint) || !path.isAbsolute(transport.configDirectory) || Object.keys(transport).some(k=>!['endpoint','configDirectory','clientState','spawnSync','control'].includes(k)) || transport.spawnSync!==undefined && typeof transport.spawnSync!=='function') throw new Error('Explicit local Docker transport required');
    if(transport.control!==undefined && (!transport.control || typeof transport.control.cancelled!=='function' || typeof transport.control.progress!=='function')) throw new Error('Explicit in-process prepare control required');
    dockerClientEnvironment(transport.clientState);
    if(transport.configDirectory!==transport.clientState.configDirectory)throw new Error('Docker credential config alias/outside owned root refused');
  }
  const r=validatePrepareRequest(request); inventory(r.tools); inventory(r.project);
  if(execute) validateProductionRequest(r);
  const {toolchainHash,dispatcherFiles}=execute?resolvePreparedToolchainIdentity(r):preparedIdentity(r),out=path.resolve(r.outputRoot);
  // All writes restricted to new explicit owned directory; no retry overwrites of uncertain operations.
  const publish=receiptWriter(out);
  const receipt={schemaVersion:1,status:execute?'STARTED':'PLAN_ONLY_NOT_PREPARED',startedAt:new Date().toISOString(),request:r,toolchainHash,dispatcherFiles,durability:{regularFile:'WRITABLE_HANDLE_FSYNC_REQUIRED',directory:process.platform==='win32'?'WIN32_DIRECTORY_FSYNC_MAY_BE_UNAVAILABLE':'POSIX_FSYNC_REQUIRED',privacy:process.platform==='win32'?'TRUSTED_PRIVATE_PARENT_INHERITED_ACL':'MODE_0700'},commands:[]};
  let client=transport?.clientState;
  let publicationFailed=false;
  const save=()=>{try{return publish(receipt);}catch(e){publicationFailed=true;throw e;}}; save();
  const invoke=(args,allowMissing=false,cleanup=false)=>{
    if(!cleanup && transport?.control?.cancelled()) throw new Error('Preparation cancelled; retain/reconcile');
    if(!cleanup && Date.now()>=deadline) throw new Error('Preparation global budget reached; retain/reconcile');
    const endpoint=transport?.endpoint??(process.platform==='win32'?'npipe:////./pipe/docker_engine':'unix:///var/run/docker.sock');
    const issued=beginDockerCommand(client),actualArgs=['--host',endpoint,'--config',issued.configDirectory,...args],env=issued.env;
    const startedAt=new Date().toISOString(),res=(transport?.spawnSync??spawnSync)('docker',actualArgs,{env,shell:false,encoding:'utf8',timeout:cleanup?10000:Math.max(1,Math.min(480000,deadline-Date.now())),maxBuffer:4*1024*1024,...(cleanup?{prepareCleanup:true}:{})});
    receipt.commands.push({argv:['docker',...actualArgs],...(transport?{endpoint:transport.endpoint,configDirectory:transport.configDirectory}:{}),startedAt,finishedAt:new Date().toISOString(),exit:res.status,signal:res.signal,error:res.error?.message??null,stdout:res.stdout,stderr:res.stderr}); save();
    finishDockerCommand(client,issued); // including final/unknown operations, retain never reused config
    if(allowMissing) imageCommandOutput(args,res,true);
    else if(res.error || res.signal || res.status!==0) throw new Error('Preparation operation failed; retain receipt/resources, reconcile by exact inspection before retry.'); return res;
  };
  const engineArgs=['info','--format','{"ID":{{json .ID}},"ServerVersion":{{json .ServerVersion}},"OSType":{{json .OSType}},"Architecture":{{json .Architecture}}}'];
  const observeEngine=()=>{
    const engine=JSON.parse(invoke(engineArgs).stdout);
    if(!exact(engine,['ID','ServerVersion','OSType','Architecture']) || Object.values(engine).some(v=>typeof v!=='string' || !v || v.length>256) || engine.OSType!=='linux' || !['x86_64','amd64'].includes(engine.Architecture)) throw new Error('Actual engine identity missing/unsupported');
    return engine;
  };
  const checkEngine=()=>{const actual=observeEngine();if(!isDeepStrictEqual(actual,receipt.engine))throw new Error('Preparation engine changed; retain/reconcile');};
  const runRaw=(args,allowMissing=false)=>{checkEngine();return invoke(args,allowMissing);};
  const run=args=>runRaw(args).stdout;
  try {
    if(!execute) return receipt;
    client??=createDockerClientState(out);
    receipt.clientState=client; receipt.engine=observeEngine();save();
    if(expectedEngine && !isDeepStrictEqual(receipt.engine,expectedEngine))throw new Error('Reviewed preparation engine differs');
    const retention=createImageRetention({engine:receipt.engine,requiredPins,run:runRaw,receipt,save});
    retention.retainRequired();
    const context=path.join(out,'context'); mkdirSync(context); mkdirSync(path.join(context,'tools')); mkdirSync(path.join(context,'scripts'));
    for(const f of r.tools.files) { const dest=path.join(context,'tools',f.path); ownedParents(path.join(context,'tools'),path.dirname(f.path)); copyFileSync(path.join(r.tools.root,f.path),dest); }
    for(const f of ['runtime-task.mjs','runtime-pom.mjs','runtime-spec.mjs','runtime-cache.mjs','runtime-tools.mjs','runtime-dependencies.mjs','runtime-artifacts.mjs']) copyFileSync(path.join(repo,'scripts',f),path.join(context,'scripts',f));
    copyFileSync(path.join(repo,'docker/runtime.Dockerfile'),path.join(context,'Dockerfile'));
    inventory(r.tools); inventory(r.project); inventory({root:path.join(context,'tools'),files:r.tools.files});
    // Explicit pulls only here, NEVER in Run. Build uses local images/pull=false.
    run(['pull','--platform=linux/amd64',r.baseImage]); if(r.baseImage!==r.nodeImage) run(['pull','--platform=linux/amd64',r.nodeImage]);
    run(['pull','--platform=linux/amd64',mavenImage]);
    retention.beforeBuild(r.imageTag);
    receipt.status='BUILD_INTENT';save();
    run(['build','--pull=false','--network=none','--build-arg',`BASE_IMAGE=${r.baseImage}`,'--build-arg',`NODE_IMAGE=${r.nodeImage}`,'--tag',r.imageTag,context]);
    const retained=retention.afterBuild(r.imageTag);
    const image=JSON.parse(run(['image','inspect',retained.observedImage.Id]));
    assertImagePin(retained,image[0]);
    if(image.length!==1 || !/^sha256:[a-f0-9]{64}$/.test(image[0].Id) || image[0].Config.User!=='10001:10001' || image[0].Config.Entrypoint?.length) throw new Error('Image inspect identity missing');
    receipt.imageId=image[0].Id; receipt.imageInspect=image[0];
    receipt.observedImage={Id:image[0].Id,RepoDigests:image[0].RepoDigests??[],Descriptor:image[0].Descriptor??null}; // never substitute config/image ID for manifest identity
    const cache=path.join(out,'cache',r.family,toolchainHash,r.dependencySha256); ownedParents(out,path.relative(out,cache)); chmodSync(cache,0o777);
    const name=`paircoach-${r.installationId}-prepare-${r.key}`; receipt.containerName=name; receipt.status='CONTAINER_INTENT'; save();
    const common=['--pull=never','--name',name,'--label',`paircoach.installation=${r.installationId}`,'--label','paircoach.role=prepare','--user','10001:10001','--cap-drop=ALL','--security-opt=no-new-privileges','--read-only','--network=bridge','--memory=2g','--cpus=2','--pids-limit=256','--log-driver=json-file','--log-opt','max-size=10m','--log-opt','max-file=1','--tmpfs','/tmp:rw,nosuid,size=256m,mode=1777','--tmpfs','/workspace:rw,nosuid,size=1g,uid=10001,gid=10001','--mount',`type=bind,source=${r.project.root},target=/input,readonly`,'--mount',`type=bind,source=${cache},target=/cache/0`];
    // No auto-rm: artifacts/exit/ownership durable before exact nonforce cleanup.
    const created = run(['create',...common,image[0].Id,'/opt/paircoach/node/bin/node','/opt/paircoach/runtime-cache.mjs',r.family,Buffer.from(JSON.stringify(r.expectedTools)).toString('base64url'),r.workingDirectory,r.dependencySha256]);
    if (/^[a-f0-9]{64}$/.test(created.trim())) { receipt.createdContainerId=created.trim(); save(); }
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
    run(['rm',state[0].Id]); checkEngine(); retention.verifyAll(); receipt.status='PREPARED_REQUIRES_OFFLINE_AND_TOOL_VALIDATION'; save(); return receipt;
  } catch(err) {
    const cancelled=transport?.control?.cancelled();
    receipt.status=cancelled?'CANCELLED_RETAIN_AND_RECONCILE':'FAILED_RETAIN_AND_RECONCILE'; receipt.error=err.message;
    if(!publicationFailed) {
      save();
      if(cancelled && receipt.containerName) {
        try {
          const cleanupRun=args=>{
            const current=JSON.parse(invoke(engineArgs,false,true).stdout);
            if(!isDeepStrictEqual(current,receipt.engine))throw new Error('Cancellation engine changed; no stop');
            return invoke(args,false,true);
          };
          stopOwnedPreparation(r,receipt,cleanupRun,save);
        } catch(e) { receipt.cancellation={...receipt.cancellation,status:'UNKNOWN_RETAIN_AND_RECONCILE',problem:e.message}; if(!publicationFailed)save(); }
      }
    }
    throw err;
  }
}
if (process.argv[1] && fileURLToPath(import.meta.url)===path.resolve(process.argv[1])) {
  try { const args=process.argv.slice(2); if(args.length<1 || args.length>2 || args[1] && args[1]!=='--execute') throw new Error('Usage: node scripts/runtime-prepare.mjs REQUEST.json [--execute]'); prepare(JSON.parse(readFileSync(args[0],'utf8')),args[1]==='--execute'); }
  catch(err) { console.error(err.message); process.exitCode=1; }
}
