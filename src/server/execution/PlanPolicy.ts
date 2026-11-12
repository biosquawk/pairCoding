import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {
  homedir
} from 'node:os';
import type {
  ExecutionPlan
} from './ports';
import type {
  ImageLockEntry, RuntimeProfile
} from '../../shared/runtime-v2';
import {
  validateRuntimeProfile
} from '../../shared/validation-v2';
import {
  canonicalDirectory, inside, requireThat, safeId, canonicalJson
} from './files';
import {
  validateRuntimeCommand
} from './RuntimeCommand';
import {
  verifyAcknowledgedInput
} from './ImmutableInput';
export interface ApprovedRuntime {
  profile:RuntimeProfile;
  image:ImageLockEntry;
  /** Independent trusted policy, NOT an adapter/client supplied callback. Must enforce tool-specific argv grammar. */
  commandAllowed(command:ExecutionPlan['command'], mode:ExecutionPlan['mode']):boolean;
  /** Exact managed cache identity/path/access. Exactly one prepared read-only cache mounted /cache/0 */
  caches:ExecutionPlan['caches'];
}
export interface ExecutorPolicy {
  installationId:string;
  engineId:string;
  runRoot:string;
  runtimes:readonly ApprovedRuntime[];
  nonRootUser:string;
  managedCacheRoot:string|null;
  /** Exact preprepared bridge. New HTTP Main uses an outbound-capable owned NAT generation. */
  serviceNetwork:string|null;
  /** Trusted current helper receipt, never caller/task input. Absent on retained legacy Run policies. */
  serviceNetworkIdentity?:Readonly<{schemaVersion:1;status:'PREPARED';installationId:string;projectId:string;engineId:string;name:string;networkId:string}>;
}
export function approvedRuntime(policy:ExecutorPolicy,profile:RuntimeProfile) {
  const runtime=policy.runtimes.find(p=>p.profile.id===profile.id);
  requireThat(runtime && validateRuntimeProfile(profile) && canonicalJson(profile)===canonicalJson(runtime.profile),'Unapproved runtime profile');
  requireThat(profile.imageLockKey===runtime.image.key,'Profile/image key mismatch');
  requireThat(runtime.image.tools.some(t=>t.name==='node'&&/^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][A-Za-z0-9.-]+)?$/.test(t.version)),'Pinned dispatcher Node tool inventory missing');
  requireThat(profile.expectedTools.every(t=>runtime.image.tools.some(actual=>actual.name===t.name&&actual.version===t.version)),'Pinned tool mismatch');
  return runtime;
}
/** Prepared identities come from the independent current-input config/cache authority, never task data. */
export async function validateApprovedCaches(policy:ExecutorPolicy,runtime:ApprovedRuntime) {
  requireThat(runtime.caches.length===1&&runtime.caches[0].readOnly===true,'Exactly one prepared read-only cache required');
  requireThat(policy.managedCacheRoot&&policy.managedCacheRoot!==homedir()&&policy.managedCacheRoot!==path.parse(policy.managedCacheRoot).root,'Private managed cache root required');
  await canonicalDirectory(policy.managedCacheRoot);
  // Win32 controlled private-parent ACL inheritance is a deployment prerequisite, not chmod proof.
  if (process.platform !== 'win32') requireThat(((await fs.lstat(policy.managedCacheRoot, { bigint:true })).mode & 0o077n) === 0n, 'Cache root must be private');
  for(const cache of runtime.caches) {
    await canonicalDirectory(cache.directory);
    requireThat(inside(policy.managedCacheRoot,cache.directory)&&!cache.directory.split(path.sep).some(p=>['.m2','.ssh','.aws','.docker'].includes(p)),'Private/home cache forbidden');
    requireThat(!inside(policy.runRoot,cache.directory)&&cache.directory!==policy.runRoot&&!inside(cache.directory,policy.runRoot)&&cache.family===runtime.profile.adapterFamily&&/^[a-f0-9]{64}$/.test(cache.toolchainHash)&&/^[a-f0-9]{64}$/.test(cache.dependencyHash),'Unsafe cache');
  }
}
export async function validatePlan(policy:ExecutorPolicy,plan:ExecutionPlan) {
  requireThat(Buffer.byteLength(canonicalJson(plan))<=2*1024*1024,'Plan byte limit');
  const trusted=approvedRuntime(policy,plan.profile),o=plan.ownership,i=plan.input;
  requireThat([policy.installationId,o.runId,o.profileId].every(safeId) && o.installationId===policy.installationId && o.profileId===plan.profile.id && o.engineId===policy.engineId,'Unapproved ownership');
  requireThat(o.containerName===`paircoach-${o.installationId}-${o.profileId}-${o.runId}` && o.containerName.length<=240,'Invalid container name');
  requireThat(o.imageId===trusted.image.imageId && /^sha256:[a-f0-9]{64}$/.test(o.imageId) && /^sha256:[a-f0-9]{64}$/.test(trusted.image.digest) && canonicalJson(plan.lockedImage)===canonicalJson(trusted.image),'Unapproved image');
  requireThat(i.identity.runId===o.runId && i.identity.profileId===o.profileId && safeId(i.identity.configurationGeneration),'Input/run mismatch');
  await canonicalDirectory(policy.runRoot);
  const run=path.join(policy.runRoot,o.runId);
  await canonicalDirectory(run);
  requireThat(i.immutableDirectory===path.join(run,'input') && i.buildDirectory===path.join(run,'build') && i.artifactsDirectory===path.join(run,'artifacts'),'Unapproved mounts');
  await canonicalDirectory(i.buildDirectory);
  await canonicalDirectory(i.artifactsDirectory);
  requireThat((await fs.readdir(i.buildDirectory)).length===0 && (await fs.readdir(i.artifactsDirectory)).length===0,'Build/artifacts must be fresh');
  requireThat((await verifyAcknowledgedInput(i)).length<=4096,'Input limit');
  const r=plan.resources;
  requireThat(Number.isSafeInteger(r.memoryBytes)&&r.memoryBytes>=64*1024*1024&&r.memoryBytes<=2*1024*1024*1024 && Number.isFinite(r.cpus)&&r.cpus>=0.1&&r.cpus<=2 && Number.isInteger(r.pids)&&r.pids>=16&&r.pids<=256 && r.logBytes===10485760&&r.logFiles===1,'Resource bounds');
  requireThat(Number.isInteger(plan.timeoutMs)&&plan.timeoutMs>=1000&&plan.timeoutMs<=3600000 && ['RUN_MAIN','RUN_TESTS'].includes(plan.mode),'Execution bounds');
  requireThat(/^[1-9][0-9]{0,5}:[1-9][0-9]{0,5}$/.test(policy.nonRootUser) && plan.isolation.nonRootUser===policy.nonRootUser && plan.isolation.capDropAll===true&&plan.isolation.noNewPrivileges===true&&plan.isolation.readOnlyRoot===true,'Isolation policy');
  requireThat(plan.isolation.network===(plan.service?'loopback':'none'),'Network policy');
  const c=plan.command;
  requireThat(typeof c.executable==='string' && /^(?:\/[a-zA-Z0-9_.-]+)*\/?[a-zA-Z0-9_.-]+$/.test(c.executable) && !/(^|\/)(sh|bash|dash|zsh|cmd|powershell|docker|env|sudo|su)$/.test(c.executable),'Unsafe executable');
  requireThat(c.args.length<=256 && c.args.every(a=>typeof a==='string'&&a.length<=4096&&!/[\x00-\x1f\x7f]/.test(a))&&canonicalJson(c.args).length<=32768,'Argv bounds');
  requireThat(c.workingDirectory==='/workspace','Unsafe working directory');
  requireThat(Object.entries(c.environment).every(([k,v])=>['LANG','LC_ALL','TZ','CI','PYTHONDONTWRITEBYTECODE'].includes(k)&&/^[a-zA-Z0-9_.@/-]{1,128}$/.test(v)),'Secret/unapproved environment');
  validateRuntimeCommand(plan);
  requireThat(trusted.commandAllowed(c,plan.mode),'Command denied by independent trusted policy');
  requireThat(canonicalJson(plan.caches)===canonicalJson(trusted.caches) && plan.caches.length===1,'Unapproved caches');
  await validateApprovedCaches(policy,trusted);
  for(const dir of [i.immutableDirectory,i.buildDirectory,i.artifactsDirectory,...plan.caches.map(c=>c.directory)])requireThat(!/[,\x00-\x1f]/.test(dir),'Invalid mount path');
  requireThat(plan.artifacts.length<=2&&new Set(plan.artifacts).size===plan.artifacts.length&&plan.artifacts.every(k=>['JUNIT_XML','COMPILER_DIAGNOSTICS'].includes(k)),'Unapproved artifact type');
  if(plan.service){
    const s=plan.service;
    requireThat(plan.mode==='RUN_MAIN'&&s.bindHost==='127.0.0.1'&&Number.isInteger(s.containerPort)&&s.containerPort>=1024&&s.containerPort<=65535&&/^\/[a-zA-Z0-9/_-]*$/.test(s.healthPath)&&s.healthPath.length<=256&&Number.isInteger(s.readinessTimeoutMs)&&s.readinessTimeoutMs>=100&&s.readinessTimeoutMs<=3600000&&s.readinessTimeoutMs<=plan.timeoutMs&&policy.serviceNetwork&&/^[a-zA-Z0-9_-]{1,80}$/.test(policy.serviceNetwork),'Service policy');
  }
}
export function dockerCreateArgs(policy:ExecutorPolicy,p:ExecutionPlan):string[] {
  const o=p.ownership,args=['create','--pull=never','--name',o.containerName];
  for(const [k,v]of Object.entries({
    installation:o.installationId,run:o.runId,profile:o.profileId,engine:o.engineId,image:o.imageId,role:'execution'
  }))args.push('--label',`paircoach.${k}=${v}`);
  args.push('--user',p.isolation.nonRootUser,'--cap-drop=ALL','--security-opt=no-new-privileges','--read-only','--memory',String(p.resources.memoryBytes),'--memory-swap',String(p.resources.memoryBytes),'--cpus',String(p.resources.cpus),'--pids-limit',String(p.resources.pids),'--log-driver=json-file','--log-opt=max-size=10m','--log-opt=max-file=1','--network',p.service?(policy.serviceNetworkIdentity?.networkId??policy.serviceNetwork!):'none','--tmpfs','/tmp:rw,nosuid,nodev,noexec,size=67108864,mode=1777');
  for(const [source,target,ro]of [[p.input.immutableDirectory,'/input',true],[p.input.buildDirectory,'/workspace',false],[p.input.artifactsDirectory,'/artifacts',false],...p.caches.map((c,i)=>[c.directory,`/cache/${i}`,c.readOnly])] as [string,string,boolean][])args.push('--mount',`type=bind,source=${source},target=${target}${ro?',readonly':''}`);
  if(p.service)args.push('--publish',`127.0.0.1::${p.service.containerPort}`);
  args.push('--workdir',p.command.workingDirectory);
  for(const [k,v]of Object.entries(p.command.environment))args.push('--env',`${k}=${v}`);
  // Image ENTRYPOINT never gets to inject a shell or different executable.
  args.push('--entrypoint',p.command.executable,o.imageId,...p.command.args);
  return args;
}
