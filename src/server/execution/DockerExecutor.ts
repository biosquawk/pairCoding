import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {
  randomUUID
} from 'node:crypto';
import * as http from 'node:http';
import type {
  AdapterOutcome, CollectedArtifacts, DurableTerminalReceipt, DurableUnstartedCancellationReceipt, UnstartedRecoveryConfirmation, ExecutionExit, ExecutionHandle, ExecutionOutput, ExecutionOwnership, ExecutionPlan, ExecutionPort, ExecutionReadiness, ExecutionServiceReadiness, OwnedOrphan, StopConfirmation
} from './ports';
import type {
  RuntimeProblem, RuntimeProfile
} from '../../shared/runtime-v2';
import {
  DurableRunJournal, type JournalRecord
} from './DurableRunJournal';
import type {
  DockerReply, DockerTransport
} from './DockerTransport';
import {
  approvedRuntime, dockerCreateArgs, type ExecutorPolicy, validatePlan, validateApprovedCaches
} from './PlanPolicy';
import {
  canonicalDirectory, durableWrite, fsyncDirectory, readRegular, requireThat, safeId, safeRelative, sha256, canonicalJson
} from './files';
import {
  verifyAcknowledgedInput
} from './ImmutableInput';
const problem=(code:string,message:string,retryable=true):RuntimeProblem=>({
  code,message,recovery:code==='PREPARE_REQUIRED'?'Run explicit approved runtime prepare for this profile, then refresh readiness; editing stays available.':code==='DAEMON_UNAVAILABLE'?'Reconnect the configured Docker engine; retry the SAME retained run when applicable.':code==='IMAGE_MISSING'?'Prepare the exact pinned image; Run never pulls or falls back to a host executable.':code==='RUNTIME_CONFIG_INVALID'?'Correct the runtime configuration; editing and recovery stay available.':'Retry/reconcile the SAME retained run; do not delete resources or admit another run before collecting evidence.',retryable
});
/** Docker 29 emits [] on named absence. No partial JSON, opaque errors or generic exit1. */
function namedAbsence(reply:DockerReply,target:string):boolean {
  if(reply.exitCode!==1 || ![`Error: No such container: ${target}`,`Error response from daemon: No such container: ${target}`].includes(reply.stderr.trim()))return false;
  if(reply.stdout.trim()==='')return true;
  try {const value:unknown=JSON.parse(reply.stdout);return Array.isArray(value)&&value.length===0;}
  catch {return false;}
}
export const EXECUTOR_LIMITS=Object.freeze({
  inspectBytes:1024*1024,logBytes:10*1024*1024,artifactFiles:128,artifactFileBytes:4*1024*1024,artifactTotalBytes:16*1024*1024,pollMs:200,stopSeconds:2,stopDeadlineMs:10000,httpProbeMs:500
});
export class ExecutionUncertainError extends Error {
  constructor(message:string,readonly handle:ExecutionHandle,options?:ErrorOptions){
    super(message,options);
  }
}
interface Inspection {
  Id:string;
  Name:string;
  Image:string;
  Config:{
    Labels:Record<string,string>
  };
  State:{
    Running:boolean;
    Status:string;
    ExitCode:number;
    StartedAt?:string;
    FinishedAt:string
  };
  NetworkSettings?:{
    Ports?:Record<string,{
      HostIp:string;
      HostPort:string
    }[]|null>
  }
}
export interface DockerExecutorOptions {
  policy:ExecutorPolicy;
  transport:DockerTransport;
  journal:DurableRunJournal;
  /** Injectable clock/wait for bounded unit tests. Production defaults are real clock/timers. */
  now?:()=>number;
  sleep?:(ms:number)=>Promise<void>;
}
/** Concrete production port. Only this module composes Docker operations; never accepts wire/task Docker flags. */
export class DockerExecutor implements ExecutionPort {
  private readonly policy:ExecutorPolicy;
  private readonly transport:DockerTransport;
  private readonly journal:DurableRunJournal;
  private readonly now:()=>number;
  private readonly sleep:(ms:number)=>Promise<void>;
  private queue:Promise<unknown>=Promise.resolve();
  private listeners=new Map<string,Set<(output:ExecutionOutput)=>void>>();
  private outputUnavailable=new Set<string>();
  private outputs=new Map<string,{
    stdout:string;
    stderr:string;
    final?:boolean;
    polling?:boolean
  }>();
  constructor(options:DockerExecutorOptions){
    this.policy=structuredClone({
      ...options.policy,runtimes:[]
    });
    this.policy.runtimes=options.policy.runtimes.map(r=>({
      ...r,profile:structuredClone(r.profile),image:structuredClone(r.image),caches:structuredClone(r.caches)
    }));
    this.transport=options.transport;
    this.journal=options.journal;
    this.now=options.now??Date.now;
    this.sleep=options.sleep??(ms=>new Promise(r=>setTimeout(r,ms)));
    requireThat(this.journal.installationId===this.policy.installationId,'Journal installation mismatch');
  }
  private async exclusive<T>(fn:()=>Promise<T>):Promise<T>{
    const task=this.queue.then(fn,fn);
    this.queue=task.catch(()=>{
    });
    return task;
  }
  private async command(args:readonly string[],options?:{
    timeoutMs?:number;
    maxBytes?:number
  }){
    const reply=await this.transport.run(args,options);
    requireThat(Buffer.byteLength(reply.stdout)+Buffer.byteLength(reply.stderr)<=(options?.maxBytes??EXECUTOR_LIMITS.inspectBytes),'Docker reply exceeds bound');
    return reply;
  }
  private async checked(args:readonly string[],options?:{
    timeoutMs?:number;
    maxBytes?:number
  }){
    const r=await this.command(args,options);
    requireThat(r.exitCode===0,`Docker ${args[0]} failed: ${r.stderr.slice(0,1024)}`);
    return r;
  }
  private async engine(){
    const r=await this.checked(['info','--format','{{json .ID}}']);
    requireThat(JSON.parse(r.stdout)===this.policy.engineId,'Wrong Docker engine');
  }
  private async image(profile:RuntimeProfile){
    const r=approvedRuntime(this.policy,profile);
    const reply=await this.checked(['image','inspect',r.image.imageId]);
    const data=JSON.parse(reply.stdout);
    const sha256Digest=(value:unknown):value is string=>typeof value==='string'&&value.length===71&&/^sha256:[a-f0-9]{64}$/.test(value);
    requireThat(sha256Digest(r.image.imageId)&&sha256Digest(r.image.digest),'Invalid locked image identity');
    requireThat(Array.isArray(data)&&data.length===1&&data[0]&&data[0].Id===r.image.imageId,'Image identity mismatch');
    // Config Id is NOT a manifest digest. Local builds may have only Descriptor;
    // registered images may instead expose RepoDigests. Both bind to this inspected config.
    const actual=data[0];
    const descriptorMatches=actual.Descriptor?.digest===r.image.digest;
    const repoMatches=Array.isArray(actual.RepoDigests)&&actual.RepoDigests.some((value:unknown)=>
      typeof value==='string'&&/^[^@\s]+@sha256:[a-f0-9]{64}$/.test(value)&&value.endsWith('@'+r.image.digest));
    requireThat(descriptorMatches||repoMatches,'Image manifest digest mismatch');
  }
  async readiness(profile:RuntimeProfile,configurationGeneration:string):Promise<ExecutionReadiness>{
    let p:RuntimeProblem|null=null;
    try{
      requireThat(safeId(configurationGeneration),'Invalid generation');
      approvedRuntime(this.policy,profile);
    }catch(e){
      p=problem('RUNTIME_CONFIG_INVALID',String(e),false);
    }
    if(!p)try{
      await validateApprovedCaches(this.policy,approvedRuntime(this.policy,profile));
    }catch(error){
      p=problem('PREPARE_REQUIRED',String(error));
    }
    if(!p)try{
      await this.engine();
    }catch(e){
      p=problem('DAEMON_UNAVAILABLE',String(e));
    }
    if(!p)try{
      await this.image(profile);
    }catch(e){
      p=problem('IMAGE_MISSING',String(e));
    }
    if(!p)try{
      await fs.stat(this.journal.directory);
      const active=(await this.journal.list()).find(r=>r.phase!=='REMOVED');
      if(active)p=problem('PROCESS_STOP_UNCONFIRMED',`Run ${active.handle.runId} still owns resources; finish/reconcile THAT run before new admission.`);
    }catch(error){
      if((error as NodeJS.ErrnoException).code!=='ENOENT')p=problem('RUNTIME_CONFIG_INVALID',String(error),false);
    }
    const mode={
      canRun:p===null,problem:p
    };
    return {
      configurationGeneration,modes:{
        RUN_MAIN:{
          ...mode
        },RUN_TESTS:{
          ...mode
        }
      }
    };
  }
  private async record(h:ExecutionHandle){
    const r=await this.journal.read(h.runId);
    requireThat(r.handle.opaqueId===h.opaqueId,'Unknown execution handle');
    return r;
  }
  private async inspect(r:JournalRecord):Promise<Inspection|null>{
    await this.engine();
    const reply=await this.command(['container','inspect',r.ownership.containerName]);
    if(reply.exitCode!==0){
      // Absence is accepted ONLY when the daemon explicitly names this exact missing object.
      requireThat(namedAbsence(reply,r.ownership.containerName),'Container state UNKNOWN');
      return null;
    }
    const data=JSON.parse(reply.stdout);
    requireThat(Array.isArray(data)&&data.length===1,'Invalid inspect');
    const v=data[0] as Inspection,o=r.ownership;
    requireThat(/^([a-f0-9]{64})$/.test(v.Id)&&v.Name==='/'+o.containerName&&v.Image===o.imageId&&(!r.containerId||r.containerId===v.Id),'Container identity mismatch');
    const labels=v.Config?.Labels??{
    };
    for(const [k,value]of Object.entries({
      installation:o.installationId,run:o.runId,profile:o.profileId,engine:o.engineId,image:o.imageId,role:'execution'
    }))requireThat(labels['paircoach.'+k]===value,'Container ownership mismatch');
    requireThat(v.State&&typeof v.State.Running==='boolean'&&typeof v.State.Status==='string','Invalid container state');
    return v;
  }
  private exit(r:JournalRecord,v:Inspection):ExecutionExit{
    requireThat(!v.State.Running&&['exited','dead'].includes(v.State.Status)&&Number.isInteger(v.State.ExitCode)&&v.State.ExitCode>=0&&v.State.ExitCode<=255&&Number.isFinite(Date.parse(v.State.FinishedAt))&&Date.parse(v.State.FinishedAt)>0,'Exit not confirmed');
    return {
      handle:r.handle,exitCode:v.State.ExitCode,exitedAt:v.State.FinishedAt
    };
  }
  private async stage(p:ExecutionPlan){
    await verifyAcknowledgedInput(p.input);
    // Independent mutable build copy, never RW bind original or immutable ACK input. Fixed nonroot UID needs write access INSIDE private run root only.
    for(const f of p.input.files){
      const dest=path.join(p.input.buildDirectory,f.path);
      await fs.mkdir(path.dirname(dest),{
        recursive:true,mode:0o777
      });
      const b=await readRegular(path.join(p.input.immutableDirectory,f.path),4*1024*1024);
      requireThat(sha256(b)===f.sha256,'Sealed input changed');
      await fs.writeFile(dest,b,{
        flag:'wx',mode:0o666
      });
      await fs.chmod(dest,0o666);
    }
    const chmodDirs=async(dir:string)=>{
      for(const e of await fs.readdir(dir,{
        withFileTypes:true
      }))if(e.isDirectory())await chmodDirs(path.join(dir,e.name));
      await fs.chmod(dir,0o777);
    };
    await chmodDirs(p.input.buildDirectory);
    await fs.chmod(p.input.artifactsDirectory,0o777);
  }
  async start(incoming:ExecutionPlan):Promise<ExecutionHandle>{
    return this.exclusive(async()=>{
      await this.journal.initialize();
      const p=structuredClone(incoming);
      const existing=(await this.journal.list()).find(r=>r.handle.runId===p.ownership.runId);
      if(existing){
        requireThat(canonicalJson(existing.plan)===canonicalJson(p),'Run id reused with different plan');
        const v=await this.inspect(existing);
        requireThat(existing.startDispatch!=='REVOKED','Existing start authority permanently revoked');
        if(v)return {
          ...existing.handle
        };
        throw new ExecutionUncertainError('Existing intent has no confirmed container; reconcile this handle with Stop/recovery, never create a duplicate.',existing.handle);
      }
      await validatePlan(this.policy,p);
      const ready=await this.readiness(p.profile,p.input.identity.configurationGeneration);
      requireThat(ready.modes[p.mode].canRun,ready.modes[p.mode].problem?.message??'Not ready');
      if(p.service){
        const net=JSON.parse((await this.checked(['network','inspect',this.policy.serviceNetwork!])).stdout);
        requireThat(Array.isArray(net)&&net.length===1&&net[0].Name===this.policy.serviceNetwork&&net[0].Internal===true&&net[0].Driver==='bridge','Service requires approved internal bridge');
      }
      await this.stage(p);
      const handle:ExecutionHandle={
        runId:p.ownership.runId,opaqueId:randomUUID()
      };
      let r:JournalRecord={
        version:1,createdAt:this.now(),revision:0,handle,ownership:p.ownership,plan:p,phase:'INTENT',containerId:null,exit:null,collection:null,outcome:null
      };
      await this.journal.reserve(r);
      // MUST precede any create, including uncertain outcomes.
      try{
        requireThat(await this.inspect(r)===null,'Preexisting container name collision');
        try{
          await this.journal.withCreateAuthority(r,()=>this.checked(dockerCreateArgs(this.policy,p)));
        }catch(error){
          const reconciled=await this.inspect(r);
          if(!reconciled)throw error;
        }
        let v=await this.inspect(r);
        requireThat(v,'Created container missing');
        r.containerId=v.Id;
        r.phase='CREATED';
        await this.journal.update(r);
        // Container may already have started after an uncertain CLI response; no duplicate start on read-confirmed running/exit.
        await this.journal.claimStart(r);
        if(v.State.Status==='created')try{
          await this.checked(['start',v.Id]);
        }catch(error){
          v=await this.inspect(r);
          if(!v||(!v.State.Running&&!['exited','dead'].includes(v.State.Status)))throw error;
        }
        v=await this.inspect(r);
        requireThat(v,'Started container missing');
        if(v.State.Running){
          r.phase='RUNNING';
        }else{
          r.exit=this.exit(r,v);
          r.phase='EXITED';
        }
        await this.journal.update(r);
        return {
          ...handle
        };
      }catch(error){
        throw new ExecutionUncertainError('Run create/start uncertain; retained durable ownership and new-run fence.',handle,{
          cause:error
        });
      }
    });
  }
  subscribe(handle:ExecutionHandle,listener:(output:ExecutionOutput)=>void):()=>void{
    requireThat(safeId(handle.runId)&&safeId(handle.opaqueId)&&this.listeners.size<16,'Invalid/excess output subscriptions');
    const key=handle.runId+':'+handle.opaqueId;
    const set=this.listeners.get(key)??new Set();
    requireThat(set.size<16,'Output listener limit');
    set.add(listener);
    this.listeners.set(key,set);
    return ()=>{
      set.delete(listener);
      if(!set.size)this.listeners.delete(key);
    };
  }
  private outputFailure(r:JournalRecord,error:unknown){
    const key=r.handle.runId+':'+r.handle.opaqueId;
    if(this.outputUnavailable.has(key))return;
    this.outputUnavailable.add(key);
    for(const listener of this.listeners.get(key)??[])try{
      listener({stream:'STDERR',text:'[Docker output unavailable; terminal collection still mandatory: '+String(error).slice(0,512)+']\n'});
    }catch{ /* One observer cannot break execution ownership. */ }
  }
  /** Only bounded Docker replies, never collected-file reads or synthetic task output.
   * Final closes the existing per-handle cursor; delayed polls cannot replay it or revive disposed state.
   */
  private publishLogs(r:JournalRecord,reply:Pick<DockerReply,'stdout'|'stderr'>,final=false){
    const key=r.handle.runId+':'+r.handle.opaqueId,set=this.listeners.get(key);
    const previous=this.outputs.get(key)??{stdout:'',stderr:'',final:false,polling:false};
    if(previous.final)return;
    if(final)previous.final=true;
    this.outputs.set(key,previous);
    if(!set?.size||(!final&&this.outputUnavailable.has(key)))return;
    try{
      // Validate BOTH streams before publishing any bytes from this snapshot.
      for(const name of ['stdout','stderr'] as const)requireThat(reply[name].startsWith(previous[name]),'Docker log prefix changed; no synthetic output replay');
      for(const [name,stream]of [['stdout','STDOUT'],['stderr','STDERR']] as const){
        const delta=Buffer.from(reply[name].slice(previous[name].length),'utf8');
        for(let start=0;start<delta.length;){
          let end=Math.min(start+16384,delta.length);
          while(end<delta.length&&(delta[end]&0xc0)===0x80)end--;
          const text=delta.subarray(start,end).toString('utf8');start=end;
          for(const listener of set)try{listener({stream,text});}catch{ /* Observer isolation. */ }
        }
      }
      previous.stdout=reply.stdout;previous.stderr=reply.stderr;
    }catch(error){this.outputFailure(r,error);}
  }
  private async emitLogs(r:JournalRecord){
    const key=r.handle.runId+':'+r.handle.opaqueId;
    if(!this.listeners.get(key)?.size||this.outputUnavailable.has(key))return;
    const state=this.outputs.get(key)??{stdout:'',stderr:'',final:false,polling:false};
    if(state.final||state.polling)return;
    this.outputs.set(key,state);state.polling=true;
    try{
      // Do not hold the lifecycle queue across a log request: Stop must not wait for it.
      const reply=await this.checked(['logs',r.containerId!],{maxBytes:EXECUTOR_LIMITS.logBytes});
      if(this.outputs.get(key)===state&&!state.final)this.publishLogs(r,reply);
    }catch(error){
      if(this.outputs.get(key)===state&&!state.final)this.outputFailure(r,error);
    }finally{state.polling=false;}
  }
  async wait(handle:ExecutionHandle,signal?:AbortSignal):Promise<ExecutionExit>{
    while(true){
      if(signal?.aborted)throw new Error('Wait cancelled; container ownership retained, call Stop');
      let r=await this.record(handle);
      if(r.exit)return structuredClone(r.exit);
      const v=await this.inspect(r);
      requireThat(v,'Container missing without verified exit');
      await this.emitLogs(r);
      if(!v.State.Running&&['exited','dead'].includes(v.State.Status))return this.exclusive(async()=>{
        r=await this.record(handle);
        if(!r.exit){
          r.exit=this.exit(r,v);
          r.phase='EXITED';
          await this.journal.update(r);
        }
        return structuredClone(r.exit);
      });
      if(this.now()-r.createdAt>=r.plan.timeoutMs){
        const stopped=await this.stop(handle,'TIMEOUT');
        if(stopped.confirmed)return stopped.exit;
        throw new ExecutionUncertainError('PROCESS_STOP_UNCONFIRMED',handle);
      }
      await this.sleep(EXECUTOR_LIMITS.pollMs);
    }
  }
  private async serviceUrl(r:JournalRecord,v:Inspection){
    const s=r.plan.service;
    if(!s)return null;
    const bindings=v.NetworkSettings?.Ports?.[s.containerPort+'/tcp'];
    requireThat(bindings?.length===1&&bindings[0].HostIp==='127.0.0.1'&&/^[0-9]{1,5}$/.test(bindings[0].HostPort)&&Number(bindings[0].HostPort)>0&&Number(bindings[0].HostPort)<=65535,'Unsafe service binding');
    return `http://127.0.0.1:${bindings[0].HostPort}${s.healthPath}`;
  }
  private async httpReady(url:string,healthOnly=true):Promise<boolean>{
    return new Promise(resolve=>{
      let done=false;
      let request:http.ClientRequest;
      let timer:ReturnType<typeof setTimeout>;
      const finish=(v:boolean)=>{
        if(!done){
          done=true;
          clearTimeout(timer);
          request?.destroy();
          resolve(v);
        }
      };
      request=http.get(url,{
        agent:false,timeout:EXECUTOR_LIMITS.httpProbeMs,headers:{
          Connection:'close'
        }
      },res=>{
        finish(!healthOnly||((res.statusCode??0)>=200&&(res.statusCode??0)<300));
        res.destroy();
      });
      timer=setTimeout(()=>finish(false),EXECUTOR_LIMITS.httpProbeMs);
      request.on('timeout',()=>finish(false));
      request.on('error',()=>finish(false));
    });
  }
  async serviceReadiness(handle:ExecutionHandle):Promise<ExecutionServiceReadiness|null>{
    const r=await this.record(handle);
    if(!r.plan.service)return null;
    const deadline=Math.min(this.now()+r.plan.service.readinessTimeoutMs,r.createdAt+r.plan.timeoutMs);
    try{
      do{
        const v=await this.inspect(r);
        requireThat(v,'Missing service container');
        const url=await this.serviceUrl(r,v);
        if(!v.State.Running)return {
          handle,ready:false,url,problem:problem('SERVICE_EXITED','Service exited before readiness',false)
        };
        if(await this.httpReady(url!)){
          const current=await this.inspect(r);
          requireThat(current?.State.Running&&!(await this.record(handle)).exit,'Service stopped during readiness');
          return {
            handle,ready:true,url,problem:null
          };
        }
        await this.sleep(EXECUTOR_LIMITS.pollMs);
      }
      while(this.now()<deadline);
      return {
        handle,ready:false,url:null,problem:problem('SERVICE_NOT_READY','No successful actual loopback HTTP response before readiness deadline')
      };
    }catch(error){
      return {
        handle,ready:false,url:null,problem:problem('SERVICE_NOT_READY',String(error))
      };
    }
  }
  async stop(handle:ExecutionHandle,_reason:'USER'|'TIMEOUT'|'RECOVERY'):Promise<StopConfirmation>{
    return this.exclusive(async()=>{
      const r=await this.record(handle);
      try{
        let v=await this.inspect(r);
        requireThat(v,'No exit proof for missing container');
        if(v.State.Running || v.State.Status==='created'){
          if(v.State.Status==='created'){
            // Never started: no genuine exit proof. Do NOT start the task or delete it to manufacture recovery success.
            throw new Error('Created but unstarted container requires scoped operator reconciliation; no fabricated exit');
          }
          try{
            await this.checked(['stop','--time',String(EXECUTOR_LIMITS.stopSeconds),v.Id],{
              timeoutMs:EXECUTOR_LIMITS.stopDeadlineMs
            });
          }catch{
            /* Read reconciliation is mandatory, even when CLI failed/timed out. */
          }
          v=await this.inspect(r);
          requireThat(v,'Container missing after Stop');
        }
        const exit=this.exit(r,v);
        if(r.plan.service){
          const url=await this.serviceUrl(r,v);
          requireThat(!await this.httpReady(url!,false),'Endpoint still responds after container Stop');
        }
        if(r.exit)requireThat(canonicalJson(r.exit)===canonicalJson(exit),'Exit proof changed');
        r.exit=exit;
        if(!['COLLECTED','TERMINAL','REMOVED'].includes(r.phase)){
          r.phase='EXITED';
          await this.journal.update(r);
        }
        return {
          confirmed:true,exit:structuredClone(exit)
        };
      }catch(error){
        if(!['TERMINAL','REMOVED'].includes(r.phase)){
          r.phase='STOP_UNCONFIRMED';
          await this.journal.update(r);
        }
        return {
          confirmed:false,handle:{
            ...handle
          },problem:problem('PROCESS_STOP_UNCONFIRMED',String(error))
        };
      }
    });
  }
  private requireUnstarted(r:JournalRecord,v:Inspection|null):asserts v is Inspection {
    requireThat(['INTENT','CREATED','STOP_UNCONFIRMED','REMOVED'].includes(r.phase) && v && !v.State.Running && v.State.Status==='created' &&
      typeof v.State.StartedAt==='string' && /^0001-01-01T00:00:00(?:\.0+)?Z$/.test(v.State.StartedAt) &&
      !r.exit && !r.collection && !r.outcome,'No positive never-started observation');
  }
  private async unchanged(r:JournalRecord) {
    requireThat(canonicalJson(await this.record(r.handle))===canonicalJson(r),'Recovery ownership/revision changed');
  }
  /** Explicit exact-ID AND ownership-name absence; daemon errors/timeouts are never absence. */
  private async unstartedAbsent(r:JournalRecord) {
    await this.engine();
    const reply=await this.command(['container','inspect',r.containerId!]);
    requireThat(namedAbsence(reply,r.containerId!),'Exact container ID absence unconfirmed');
    requireThat(await this.inspect(r)===null,'Ownership name absence unconfirmed');
    await this.unchanged(r);
  }
  private async collectUnstarted(r:JournalRecord,v:Inspection) {
    this.requireUnstarted(r,v);
    const logs=await this.checked(['logs',v.Id],{maxBytes:EXECUTOR_LIMITS.logBytes});
    await this.unchanged(r);
    const directory=path.join(this.policy.runRoot,r.handle.runId,'unstarted-'+randomUUID());
    await fs.mkdir(directory,{mode:0o700});await canonicalDirectory(directory);
    await durableWrite(path.join(directory,'stdout.log'),logs.stdout);
    await durableWrite(path.join(directory,'stderr.log'),logs.stderr);
    const files:{relative:string;sha256:string;bytes:number}[]=[];let total=0,seen=0;
    const walk=async(relative:string,depth:number):Promise<void>=>{
      requireThat(depth<=16,'No-process artifact depth limit');
      const source=path.join(r.plan.input.artifactsDirectory,relative);await canonicalDirectory(source);
      for(const entry of await fs.readdir(source,{withFileTypes:true})) {
        requireThat(++seen<=EXECUTOR_LIMITS.artifactFiles,'No-process artifact count limit');
        const rel=relative?relative+'/'+entry.name:entry.name;requireThat(safeRelative(rel),'Unsafe no-process artifact path');
        const file=path.join(r.plan.input.artifactsDirectory,rel),st=await fs.lstat(file);
        requireThat(!st.isSymbolicLink(),'No-process artifact link');
        if(st.isDirectory()){await walk(rel,depth+1);continue;}
        requireThat(st.isFile(),'No-process artifact type');
        const bytes=await readRegular(file,EXECUTOR_LIMITS.artifactFileBytes);total+=bytes.length;
        requireThat(total<=EXECUTOR_LIMITS.artifactTotalBytes,'No-process artifact total limit');
        const target=path.join(directory,'files',rel);await fs.mkdir(path.dirname(target),{recursive:true,mode:0o700});
        // Preserve bytes exactly, including non-UTF8, without inventing adapter output.
        await durableWrite(target,bytes.toString('base64'));
        files.push({relative:rel,sha256:sha256(bytes),bytes:bytes.length});
      }
    };
    await walk('',0);files.sort((a,b)=>a.relative.localeCompare(b.relative));
    // Flush every newly published ancestry link, not just the leaf file/directory.
    const directories=new Set([directory]);
    for(const f of files)for(let d=path.dirname(path.join(directory,'files',f.relative));d!==path.dirname(directory);d=path.dirname(d))directories.add(d);
    for(const d of [...directories].sort((a,b)=>b.length-a.length))await fsyncDirectory(d);
    await fsyncDirectory(path.dirname(directory));
    await this.unchanged(r);
    const evidence={version:1,kind:'NO_PROCESS_CANCELLATION',handle:r.handle,ownership:r.ownership,
      planSha256:sha256(canonicalJson(r.plan)),inputManifestSha256:r.plan.input.identity.manifestSha256,
      startDispatch:'REVOKED',artifactEncoding:'base64',container:v,stdoutSha256:sha256(logs.stdout),stderrSha256:sha256(logs.stderr),files,
      inventoryReason:files.length?null:'Actual bounded artifacts directory inventory contained no regular files; no process dispatch occurred.'};
    const evidencePath=path.join(directory,'evidence.json'),bytes=canonicalJson(evidence);
    await durableWrite(evidencePath,bytes);
    return {evidencePath,evidenceSha256:sha256(bytes),confirmedAt:null};
  }
  /** Only a null-ID original INTENT, positively revoked under the native create/start lease.
   * No rm, logs, fabricated container, exit or test artifacts on this variant.
   */
  private requireAbsentIntent(r:JournalRecord) {
    requireThat(['INTENT','STOP_UNCONFIRMED','REMOVED'].includes(r.phase) && r.containerId===null && r.startDispatch==='REVOKED' &&
      !r.exit && !r.collection && !r.outcome,'Not an original absent revoked intent');
    requireThat(r.ownership.engineId===this.policy.engineId && r.ownership.installationId===this.policy.installationId,
      'Recovery engine/installation differs from original owner');
  }
  private async collectAbsentIntent(r:JournalRecord) {
    this.requireAbsentIntent(r);
    await verifyAcknowledgedInput(r.plan.input);
    await this.engine();
    const target=r.ownership.containerName,reply=await this.command(['container','inspect',target]);
    requireThat(namedAbsence(reply,target),'Named intent absence unconfirmed');await this.unchanged(r);
    const directory=path.join(this.policy.runRoot,r.handle.runId,'unstarted-'+randomUUID());
    await fs.mkdir(directory,{mode:0o700});await canonicalDirectory(directory);
    const evidence={version:1,kind:'NO_PROCESS_ABSENT_INTENT',handle:r.handle,ownership:r.ownership,
      planSha256:sha256(canonicalJson(r.plan)),inputManifestSha256:r.plan.input.identity.manifestSha256,
      startDispatch:'REVOKED',containerId:null,engineId:this.policy.engineId,target,reply};
    const evidencePath=path.join(directory,'evidence.json'),bytes=canonicalJson(evidence);
    await durableWrite(evidencePath,bytes);await fsyncDirectory(directory);await fsyncDirectory(path.dirname(directory));
    return {kind:'ABSENT_INTENT' as const,evidencePath,evidenceSha256:sha256(bytes),confirmedAt:null};
  }
  private async verifyUnstartedEvidence(r:JournalRecord) {
    const c=r.unstartedCancellation,runRoot=path.join(this.policy.runRoot,r.handle.runId);
    requireThat(r.ownership.engineId===this.policy.engineId && r.ownership.installationId===this.policy.installationId,'Recovery engine/installation differs from original owner');
    requireThat(c && r.startDispatch==='REVOKED' && (c.kind==='ABSENT_INTENT' ? r.containerId===null : !!r.containerId) && !r.exit && !r.collection && !r.outcome,'Missing no-process evidence');
    const dir=path.dirname(c.evidencePath);
    requireThat(path.dirname(dir)===runRoot && /^unstarted-[a-f0-9-]{36}$/.test(path.basename(dir)) && path.basename(c.evidencePath)==='evidence.json','No-process evidence containment');
    const bytes=await readRegular(c.evidencePath,EXECUTOR_LIMITS.inspectBytes),e=JSON.parse(bytes.toString());
    if(c.kind==='ABSENT_INTENT') {
      this.requireAbsentIntent(r);
      requireThat(sha256(bytes)===c.evidenceSha256 && e.version===1 && e.kind==='NO_PROCESS_ABSENT_INTENT' && e.startDispatch==='REVOKED' &&
        e.containerId===null && e.engineId===r.ownership.engineId && e.target===r.ownership.containerName &&
        canonicalJson(e.handle)===canonicalJson(r.handle) && canonicalJson(e.ownership)===canonicalJson(r.ownership) &&
        e.planSha256===sha256(canonicalJson(r.plan)) && e.inputManifestSha256===r.plan.input.identity.manifestSha256 &&
        e.reply && namedAbsence(e.reply,e.target),'Absent intent evidence mismatch');
      await this.unchanged(r);return;
    }
    requireThat(sha256(bytes)===c.evidenceSha256 && e.version===1 && e.kind==='NO_PROCESS_CANCELLATION' && e.startDispatch==='REVOKED' && e.artifactEncoding==='base64' &&
      canonicalJson(e.handle)===canonicalJson(r.handle) && canonicalJson(e.ownership)===canonicalJson(r.ownership) && e.planSha256===sha256(canonicalJson(r.plan)) &&
      e.inputManifestSha256===r.plan.input.identity.manifestSha256 && e.container?.Id===r.containerId && e.container.Name==='/'+r.ownership.containerName &&
      e.container.Image===r.ownership.imageId && Array.isArray(e.files) && e.files.length<=EXECUTOR_LIMITS.artifactFiles,'No-process evidence mismatch');
    this.requireUnstarted(r,e.container);
    for(const [key,value] of Object.entries({installation:r.ownership.installationId,run:r.ownership.runId,profile:r.ownership.profileId,engine:r.ownership.engineId,image:r.ownership.imageId,role:'execution'}))
      requireThat(e.container.Config?.Labels?.['paircoach.'+key]===value,'No-process evidence labels changed');
    requireThat(sha256(await readRegular(path.join(dir,'stdout.log'),EXECUTOR_LIMITS.logBytes))===e.stdoutSha256 &&
      sha256(await readRegular(path.join(dir,'stderr.log'),EXECUTOR_LIMITS.logBytes))===e.stderrSha256,'No-process logs changed');
    let total=0;const seen=new Set<string>();
    for(const f of e.files){
      requireThat(safeRelative(f.relative) && !seen.has(f.relative) && Number.isSafeInteger(f.bytes) && f.bytes>=0 && f.bytes<=EXECUTOR_LIMITS.artifactFileBytes,'Invalid no-process inventory');seen.add(f.relative);
      const encoded=await readRegular(path.join(dir,'files',f.relative),Math.ceil(EXECUTOR_LIMITS.artifactFileBytes/3)*4),b=Buffer.from(encoded.toString(),'base64');
      requireThat(b.toString('base64')===encoded.toString() && b.length===f.bytes && sha256(b)===f.sha256,'No-process artifact changed');total+=b.length;
      requireThat(total<=EXECUTOR_LIMITS.artifactTotalBytes,'No-process inventory total limit');
    }
    await this.unchanged(r);
  }
  /** Read-only startup join. No Docker operations and no receipt reconstruction by consumers. */
  async readUnstartedCancellation(handle:ExecutionHandle):Promise<DurableUnstartedCancellationReceipt> {
    const r=await this.record(handle);await this.verifyUnstartedEvidence(r);return this.journal.cancellationReceipt(r);
  }
  async recoverUnstarted(handle:ExecutionHandle):Promise<UnstartedRecoveryConfirmation> {
    return this.exclusive(async()=>{
      try {
        const r=await this.record(handle);
        requireThat(r.ownership.engineId===this.policy.engineId && r.ownership.installationId===this.policy.installationId,
          'Recovery engine/installation differs from original owner');
        if(r.phase==='REMOVED')return {confirmed:true,receipt:await this.readUnstartedCancellation(handle)};
        return await this.journal.withUnstartedRecovery(r,async save=>{
          // MAY/legacy was rejected under native exclusion BEFORE any evidence/mutation.
          let v=await this.inspect(r);await this.unchanged(r);
          if(!v && r.containerId===null && (!r.unstartedCancellation || r.unstartedCancellation.kind==='ABSENT_INTENT')) {
            requireThat(['INTENT','STOP_UNCONFIRMED'].includes(r.phase) && !r.exit && !r.collection && !r.outcome,'Absent recovery requires original unstarted intent');
            if(r.startDispatch==='NOT_DISPATCHED'){r.startDispatch='REVOKED';await save();}
            this.requireAbsentIntent(r);
            if(!r.unstartedCancellation){r.unstartedCancellation=await this.collectAbsentIntent(r);await save();}
            await this.verifyUnstartedEvidence(r);
            requireThat(await this.inspect(r)===null,'Named container appeared after revocation');await this.unchanged(r);
            r.unstartedCancellation!.confirmedAt=new Date(this.now()).toISOString();r.phase='REMOVED';await save();
            await this.verifyUnstartedEvidence(r);
            return {confirmed:true as const,receipt:await this.journal.cancellationReceipt(r)};
          }
          requireThat(r.unstartedCancellation?.kind!=='ABSENT_INTENT','Container appeared after absent intent revocation');
          if(!r.unstartedCancellation || v) {
            this.requireUnstarted(r,v);
            if(r.containerId)requireThat(r.containerId===v.Id,'Unstarted container ID changed');
            r.containerId=v.Id;
            if(r.startDispatch==='NOT_DISPATCHED'){r.startDispatch='REVOKED';await save();}
            if(!r.unstartedCancellation){r.unstartedCancellation=await this.collectUnstarted(r,v);await save();}
          }
          // A missing object is reconcilable ONLY from the previously durable cancellation intent.
          await this.verifyUnstartedEvidence(r);
          if(v) {
            v=await this.inspect(r);this.requireUnstarted(r,v);await this.unchanged(r);
            requireThat(r.startDispatch==='REVOKED' && r.containerId===v.Id,'Revocation/identity changed before removal');
            try {await this.checked(['rm',v.Id]);} catch { /* Reconcile actual same-engine ID+name absence, never blind retry here. */ }
          }
          await this.unstartedAbsent(r);
          r.unstartedCancellation!.confirmedAt=new Date(this.now()).toISOString();r.phase='REMOVED';await save();
          await this.verifyUnstartedEvidence(r);
          return {confirmed:true as const,receipt:await this.journal.cancellationReceipt(r)};
        });
      } catch(error) {
        return {confirmed:false,handle:{...handle},problem:problem('PROCESS_STOP_UNCONFIRMED','Unstarted cancellation/removal unconfirmed: '+String(error).slice(0,512))};
      }
    });
  }
  async collect(handle:ExecutionHandle,exit:ExecutionExit):Promise<CollectedArtifacts>{
    return this.exclusive(async()=>{
      const r=await this.record(handle);
      requireThat(r.exit&&canonicalJson(r.exit)===canonicalJson(exit),'Collect requires exact confirmed exit');
      if(r.collection){
        await this.verifyCollection(r);
        return structuredClone(r.collection);
      }
      const v=await this.inspect(r);
      requireThat(v&&canonicalJson(this.exit(r,v))===canonicalJson(exit),'Collection exit not confirmed');
      let logs:DockerReply;
      try{
        logs=await this.checked(['logs',v.Id],{maxBytes:EXECUTOR_LIMITS.logBytes});
      }catch(error){this.outputFailure(r,error);throw error;}
      // start()/Stop may confirm exit before any poll/subscription. Reuse this bounded
      // final reply before Runner release, even if subsequent durable collection fails.
      this.publishLogs(r,logs,true);
      const destination=path.join(this.policy.runRoot,handle.runId,'collected');
      await fs.mkdir(destination,{
        mode:0o700,recursive:true
      });
      await canonicalDirectory(destination);
      const stdoutPath=path.join(destination,'stdout.log'),stderrPath=path.join(destination,'stderr.log');
      await durableWrite(stdoutPath,logs.stdout);
      await durableWrite(stderrPath,logs.stderr);
      const files:CollectedArtifacts['files'][number][]=[];
      let total=0,seen=0;
      const walk=async(relative:string,depth:number)=>{
        requireThat(depth<=16,'Artifact depth limit');
        const directory=path.join(r.plan.input.artifactsDirectory,relative);
        await canonicalDirectory(directory);
        for(const entry of await fs.readdir(directory,{
          withFileTypes:true
        })){
          requireThat(++seen<=EXECUTOR_LIMITS.artifactFiles,'Artifact count limit');
          const rel=relative?relative+'/'+entry.name:entry.name;
          requireThat(safeRelative(rel),'Unsafe artifact path');
          const source=path.join(r.plan.input.artifactsDirectory,rel);
          const st=await fs.lstat(source);
          requireThat(!st.isSymbolicLink(),'Artifact link');
          if(st.isDirectory()){
            await walk(rel,depth+1);
            continue;
          }
          requireThat(st.isFile(),'Artifact type');
          const kind=rel.endsWith('.xml')?'JUNIT_XML':/\.(json|txt)$/.test(rel)?'COMPILER_DIAGNOSTICS':null;
          requireThat(kind&&r.plan.artifacts.includes(kind),'Unapproved artifact');
          const bytes=await readRegular(source,EXECUTOR_LIMITS.artifactFileBytes);
          total+=bytes.length;
          requireThat(total<=EXECUTOR_LIMITS.artifactTotalBytes,'Artifact total limit');
          const target=path.join(destination,'files',rel);
          await fs.mkdir(path.dirname(target),{
            recursive:true,mode:0o700
          });
          await durableWrite(target,bytes.toString('utf8'));
          requireThat((await readRegular(target,EXECUTOR_LIMITS.artifactFileBytes)).equals(bytes),'Artifact encoding changed');
          files.push({
            kind,path:target,sha256:sha256(bytes),bytes:bytes.length,freshForRun:true
          });
        }
      };
      await walk('',0);
      files.sort((a,b)=>a.path.localeCompare(b.path));
      const unsigned={
        handle:r.handle,inputManifestSha256:r.plan.input.identity.manifestSha256,stdoutPath,stderrPath,stdoutSha256:sha256(logs.stdout),stderrSha256:sha256(logs.stderr),files,tools:r.plan.lockedImage.tools
      };
      const collectionSha256=sha256(canonicalJson(unsigned));
      await durableWrite(path.join(destination,'collection.json'),canonicalJson({
        ...unsigned,collectionSha256
      }));
      r.collection={
        handle:r.handle,inputManifestSha256:unsigned.inputManifestSha256,collectionSha256,stdoutPath,stderrPath,files,tools:unsigned.tools
      };
      r.phase='COLLECTED';
      await this.journal.update(r);
      await this.verifyCollection(r);
      return structuredClone(r.collection);
    });
  }
  private async verifyCollection(r:JournalRecord){
    requireThat(r.collection&&r.exit,'Missing collection');
    const c=r.collection,dir=path.join(this.policy.runRoot,r.handle.runId,'collected');
    const manifest=JSON.parse((await readRegular(path.join(dir,'collection.json'),1024*1024)).toString());
    const {
      collectionSha256,...unsigned
    }
    =manifest;
    requireThat(sha256(canonicalJson(unsigned))===collectionSha256&&collectionSha256===c.collectionSha256&&manifest.inputManifestSha256===r.plan.input.identity.manifestSha256&&canonicalJson(manifest.handle)===canonicalJson(r.handle)&&canonicalJson(manifest.files)===canonicalJson(c.files)&&canonicalJson(manifest.tools)===canonicalJson(c.tools)&&c.stdoutPath===path.join(dir,'stdout.log')&&c.stderrPath===path.join(dir,'stderr.log'),'Collection manifest mismatch');
    requireThat(sha256(await readRegular(c.stdoutPath,EXECUTOR_LIMITS.logBytes))===manifest.stdoutSha256&&sha256(await readRegular(c.stderrPath,EXECUTOR_LIMITS.logBytes))===manifest.stderrSha256,'Log digest mismatch');
    for(const file of c.files){
      requireThat(file.path.startsWith(path.join(dir,'files')+path.sep),'Artifact containment');
      await canonicalDirectory(path.dirname(file.path));
      const b=await readRegular(file.path,EXECUTOR_LIMITS.artifactFileBytes);
      requireThat(b.length===file.bytes&&sha256(b)===file.sha256&&file.freshForRun===true,'Artifact digest mismatch');
    }
  }
  /** Runner calls AFTER adapter interpretation. This durable helper is intentionally not a second execution port. */
  async persistTerminal(handle:ExecutionHandle,outcome:AdapterOutcome):Promise<DurableTerminalReceipt>{
    return this.exclusive(async()=>{
      const r=await this.record(handle);
      requireThat(r.phase==='COLLECTED'||r.phase==='TERMINAL','Terminal requires collection first');
      await this.verifyCollection(r);
      requireThat(['SUCCEEDED','FAILED'].includes(outcome.status)&&['NOT_APPLICABLE','UNKNOWN','NO_TESTS','PASSED','FAILED'].includes(outcome.testOutcome)&&canonicalJson(outcome).length<=8192,'Invalid terminal outcome');
      requireThat([outcome.testCount,outcome.skipped,outcome.failures,outcome.errors].every(n=>n===null||(Number.isSafeInteger(n)&&n>=0)),'Invalid outcome counts');
      requireThat(!(outcome.status==='SUCCEEDED'&&r.exit!.exitCode!==0),'False terminal success');
      if(outcome.testOutcome==='PASSED')requireThat(r.plan.mode==='RUN_TESTS'&&r.exit!.exitCode===0&&outcome.testCount!==null&&outcome.skipped!==null&&outcome.testCount>0&&outcome.skipped<=outcome.testCount&&outcome.testCount-outcome.skipped>0&&outcome.failures===0&&outcome.errors===0&&r.collection!.files.some(f=>f.kind==='JUNIT_XML'&&f.freshForRun),'False test success');
      if(r.phase==='TERMINAL')requireThat(canonicalJson(r.outcome)===canonicalJson(outcome),'Terminal outcome immutable');
      else{
        r.outcome=structuredClone(outcome);
        r.phase='TERMINAL';
        await this.journal.update(r);
      }
      return this.journal.receipt(r);
    });
  }
  async cleanup(receipt:DurableTerminalReceipt):Promise<void>{
    return this.exclusive(async()=>{
      const r=await this.record(receipt.handle);
      if(r.phase==='REMOVED'){
        requireThat(canonicalJson(r.ownership)===canonicalJson(receipt.ownership),'Receipt ownership mismatch');
        return;
      }
      await this.verifyCollection(r);
      const actual=await this.journal.receipt(r);
      requireThat(canonicalJson(actual)===canonicalJson(receipt),'Unverified durable receipt');
      const v=await this.inspect(r);
      if(v){
        requireThat(canonicalJson(this.exit(r,v))===canonicalJson(r.exit),'Cleanup requires confirmed exact exit');
        try{
          await this.checked(['rm',v.Id]);
        }catch(error){
          requireThat(await this.inspect(r)===null,'Removal uncertain');
        }
        requireThat(await this.inspect(r)===null,'Container still exists after rm');
      }
      r.phase='REMOVED';
      await this.journal.update(r);
      this.outputs.delete(r.handle.runId+':'+r.handle.opaqueId);
      this.outputUnavailable.delete(r.handle.runId+':'+r.handle.opaqueId);
      this.listeners.delete(r.handle.runId+':'+r.handle.opaqueId);
    });
  }
  async inspectOwnedOrphans(installationId:string):Promise<readonly OwnedOrphan[]>{
    requireThat(installationId===this.policy.installationId,'Foreign installation');
    await this.journal.initialize();
    const list:OwnedOrphan[]=[];
    for(const r of await this.journal.list())if(r.phase!=='REMOVED'){
      let state:OwnedOrphan['state']='UNKNOWN',receipt:DurableTerminalReceipt|null=null;
      try{
        const v=await this.inspect(r);
        if(v)state=v.State.Running?'RUNNING':['exited','dead'].includes(v.State.Status)?'EXITED':'UNKNOWN';
        if(r.phase==='TERMINAL'){
          await this.verifyCollection(r);
          receipt=await this.journal.receipt(r);
        }
      }catch{
        /* Retain unknown ownership; never broad ps/prune/delete. */
      }
      list.push({
        ownership:structuredClone(r.ownership),handle:structuredClone(r.handle),state,durableReceipt:receipt
      });
    }
    return list;
  }
}
