/** Explicit operator utility. Default only validates/plans; --execute requires reviewed concrete pins.
 * Never called automatically by Run/Test. No host language toolchains, private home, env forwarding or docker.sock mounts.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, lstatSync, readdirSync, realpathSync, copyFileSync, chmodSync, renameSync, openSync, fsyncSync, closeSync } from 'node:fs';
import path from 'node:path';
import { dependencyHash } from './runtime-dependencies.mjs';
import { literalPath } from './runtime-spec.mjs';
import { fileURLToPath } from 'node:url';
const repo=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const hash = b=>createHash('sha256').update(b).digest('hex');
const exact=(o,ks)=>o && Object.keys(o).sort().join(',')===[...ks].sort().join(',');
const pin=s=>typeof s==='string' && /^[a-z0-9][a-z0-9._/:+-]*@sha256:[a-f0-9]{64}$/.test(s);
export function validatePrepareRequest(r) {
  if (!exact(r,['schemaVersion','workingDirectory','installationId','family','key','imageTag','baseImage','nodeImage','tools','project','expectedTools','dependencySha256','outputRoot']) || r.schemaVersion!==1 || r.workingDirectory!=='.' && !literalPath(r.workingDirectory) || !/^[a-z0-9-]{1,64}$/.test(r.installationId) || !['node','typescript','python','java-maven'].includes(r.family) || !/^[a-z0-9-]{1,64}$/.test(r.key) || !/^paircoach\/runtime-[a-z0-9.-]+:[a-z0-9.-]+$/.test(r.imageTag) || !pin(r.baseImage) || !pin(r.nodeImage) || !path.isAbsolute(r.outputRoot) || /[,\x00-\x1f]/.test(r.outputRoot) || !/^[a-f0-9]{64}$/.test(r.dependencySha256)) throw new Error('NOTREADY: complete explicit pinned preparation request required');
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
function inventory(set) {
  const root=realpathSync(set.root), actual=[]; let bytes=0;
  if(root!==path.resolve(set.root)) throw new Error('Input root symlink');
  const walk=(dir,rel='',depth=0)=>{
    if(depth>64) throw new Error('Inventory depth');
    for(const name of readdirSync(dir).sort()) {
      if(name.startsWith('.env') || ['.git','.m2','.aws','.ssh','.paircoach'].includes(name)) throw new Error('Secret/private inventory forbidden');
      const full=path.join(dir,name),p=rel?`${rel}/${name}`:name,st=lstatSync(full);
      if(st.isSymbolicLink() || !st.isDirectory() && !st.isFile()) throw new Error('Nonregular prepare input');
      if(st.isDirectory()) walk(full,p,depth+1); else {
        if(actual.length>=20000 || (bytes+=st.size)>256*1024*1024) throw new Error('Prepare inventory limit');
        actual.push({path:p,sha256:hash(readFileSync(full))});
      }
    }
  }; walk(root);
  if(JSON.stringify(actual.sort((a,b)=>a.path.localeCompare(b.path)))!==JSON.stringify([...set.files].sort((a,b)=>a.path.localeCompare(b.path)))) throw new Error('Prepare inventory differs');
  return actual;
}
export function prepare(request,execute=false) {
  const r=validatePrepareRequest(request); inventory(r.tools); inventory(r.project);
  const toolchainHash=hash(Buffer.from(JSON.stringify({base:r.baseImage,node:r.nodeImage,tools:r.tools.files,versions:r.expectedTools}))), out=path.resolve(r.outputRoot);
  // All writes restricted to new explicit owned directory; no retry overwrites of uncertain operations.
  mkdirSync(out,{recursive:false,mode:0o700}); const receipt={schemaVersion:1,status:execute?'STARTED':'PLAN_ONLY_NOT_PREPARED',startedAt:new Date().toISOString(),request:r,toolchainHash,commands:[]};
  const save=()=>{ const f=path.join(out,'receipt.json'),tmp=path.join(out,'receipt.tmp'); writeFileSync(tmp,JSON.stringify(receipt,null,2)); const fd=openSync(tmp,'r'); try { fsyncSync(fd); } finally { closeSync(fd); } renameSync(tmp,f); const dir=openSync(out,'r'); try { fsyncSync(dir); } finally { closeSync(dir); } }; save();
  const run=(args)=>{
    const startedAt=new Date().toISOString(),res=spawnSync('docker',args,{env:{PATH:process.env.PATH,HOME:path.join(out,'docker-home')},shell:false,encoding:'utf8',timeout:180000,maxBuffer:4*1024*1024});
    receipt.commands.push({argv:['docker',...args],startedAt,finishedAt:new Date().toISOString(),exit:res.status,signal:res.signal,error:res.error?.message??null,stdout:res.stdout,stderr:res.stderr}); save();
    if(res.error || res.status!==0) throw new Error('Preparation operation failed; retain receipt/resources, reconcile by exact inspection before retry.'); return res.stdout;
  };
  try {
    if(!execute) return receipt;
    mkdirSync(path.join(out,'docker-home')); const context=path.join(out,'context'); mkdirSync(context); mkdirSync(path.join(context,'tools')); mkdirSync(path.join(context,'scripts'));
    for(const f of r.tools.files) { const dest=path.join(context,'tools',f.path); mkdirSync(path.dirname(dest),{recursive:true}); copyFileSync(path.join(r.tools.root,f.path),dest); }
    for(const f of ['runtime-task.mjs','runtime-pom.mjs','runtime-spec.mjs','runtime-cache.mjs','runtime-tools.mjs','runtime-dependencies.mjs','runtime-artifacts.mjs']) copyFileSync(path.join(repo,'scripts',f),path.join(context,'scripts',f));
    copyFileSync(path.join(repo,'docker/runtime.Dockerfile'),path.join(context,'Dockerfile'));
    inventory(r.tools); inventory(r.project);
    // Explicit pulls only here, NEVER in Run. Build uses local images/pull=false.
    run(['pull','--platform=linux/amd64',r.baseImage]); if(r.baseImage!==r.nodeImage) run(['pull','--platform=linux/amd64',r.nodeImage]);
    run(['build','--pull=false','--network=none','--build-arg',`BASE_IMAGE=${r.baseImage}`,'--build-arg',`NODE_IMAGE=${r.nodeImage}`,'--tag',r.imageTag,context]);
    const image=JSON.parse(run(['image','inspect',r.imageTag]));
    if(image.length!==1 || !/^sha256:[a-f0-9]{64}$/.test(image[0].Id)) throw new Error('Image inspect identity missing');
    receipt.imageId=image[0].Id;
    const cache=path.join(out,'cache',r.family,toolchainHash,r.dependencySha256); mkdirSync(cache,{recursive:true}); chmodSync(cache,0o777);
    const name=`paircoach-${r.installationId}-prepare-${r.key}`; receipt.containerName=name; receipt.status='CONTAINER_INTENT'; save();
    const common=['--pull=never','--name',name,'--label',`paircoach.installation=${r.installationId}`,'--label','paircoach.role=prepare','--user','10001:10001','--cap-drop=ALL','--security-opt=no-new-privileges','--read-only','--memory=2g','--cpus=2','--pids-limit=256','--log-driver=json-file','--log-opt','max-size=10m','--log-opt','max-file=1','--tmpfs','/tmp:rw,nosuid,size=256m,mode=1777','--tmpfs','/workspace:rw,nosuid,size=1g,uid=10001,gid=10001','--mount',`type=bind,source=${r.project.root},target=/input,readonly`,'--mount',`type=bind,source=${cache},target=/cache/0`];
    // No auto-rm: artifacts/exit/ownership durable before exact nonforce cleanup.
    run(['create',...common,image[0].Id,'/opt/paircoach/node/bin/node','/opt/paircoach/runtime-cache.mjs',r.family,Buffer.from(JSON.stringify(r.expectedTools)).toString('base64url'),r.workingDirectory,r.dependencySha256]);
    run(['start','--attach',name]);
    const state=JSON.parse(run(['inspect',name]));
    if(state.length!==1 || state[0].State.Running || state[0].State.ExitCode!==0 || state[0].Config.Image!==image[0].Id || state[0].Config.Labels?.['paircoach.installation']!==r.installationId || state[0].Config.Labels?.['paircoach.role']!=='prepare') throw new Error('Prepare terminal ownership uncertain');
    receipt.container=state[0]; receipt.status='CACHE_PREPARED_IMAGE_PIN_NOT_PUBLISHED'; save();
    run(['logs',name]); inventory(r.project); receipt.status='COLLECTED_DURABLE'; save();
    // Operators publish production images.lock only after separate exact tools/offline check. Local imageId is NOT invented registry digest.
    run(['rm',name]); receipt.status='PREPARED_REQUIRES_OFFLINE_AND_TOOL_VALIDATION'; save(); return receipt;
  } catch(err) { receipt.status='FAILED_RETAIN_AND_RECONCILE'; receipt.error=err.message; save(); throw err; }
}
if (import.meta.url===`file://${process.argv[1]}`) {
  try { const args=process.argv.slice(2); if(args.length<1 || args.length>2 || args[1] && args[1]!=='--execute') throw new Error('Usage: node scripts/runtime-prepare.mjs REQUEST.json [--execute]'); prepare(JSON.parse(readFileSync(args[0],'utf8')),args[1]==='--execute'); }
  catch(err) { console.error(err.message); process.exitCode=1; }
}
