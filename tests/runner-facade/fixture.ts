/** UNIT controlled execution boundary, never a Docker/real receipt proof. */
import { Runner, type RuntimeRunAdmission, type RuntimeRunnerOptions } from '../../src/server/Runner';
import type { ExecutionExit, ExecutionOutput, ExecutionPort, PlanContext, TaskRuntimeAdapter } from '../../src/server/execution/ports';

export function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}
export function fixture() {
  const profile: RuntimeRunAdmission['profile'] = {
    id:'profile1',label:'Unit profile',adapterFamily:'node',imageLockKey:'image1',expectedTools:[],compilerRelease:null,
    analysis:{languageLevel:'level',preview:false},language:{provider:'off',imageLockKey:null,serverJvm:null},taskFields:[]
  };
  const handle = {runId:'run1',opaqueId:'opaque1'};
  const context: PlanContext = {
    ownership:{installationId:'install1',runId:handle.runId,profileId:profile.id,engineId:'engine1',containerName:'owned-unit',imageId:'sha256:'+'a'.repeat(64)},
    profile,lockedImage:{key:'image1',image:'unit/runtime:v1',imageId:'sha256:'+'a'.repeat(64),digest:'sha256:'+'b'.repeat(64),tools:[]},caches:[],
    input:{projectId:'project1',sessionId:'session1',identity:{runId:handle.runId,profileId:profile.id,configurationGeneration:'cfg1',workspaceVersion:1,manifestSha256:'c'.repeat(64)},
      files:[],immutableDirectory:'/unit/input',buildDirectory:'/unit/build',artifactsDirectory:'/unit/artifacts'}
  };
  const calls: string[] = [];
  const events: {type:string;payload:unknown}[] = [];
  let version=1,output: ((value:ExecutionOutput)=>void)|undefined;
  const waiting=deferred<ExecutionExit>();
  const exit:ExecutionExit={handle,exitCode:0,exitedAt:'2026-11-12T00:00:00.000Z'};
  const execution:ExecutionPort={
    readiness:async(_p,g)=>{calls.push('readiness');return {configurationGeneration:g,modes:{RUN_MAIN:{canRun:true,problem:null},RUN_TESTS:{canRun:true,problem:null}}};},
    start:async()=>{calls.push('start');return handle;},
    subscribe:(_h,listener)=>{output=listener;return ()=>{output=undefined;};},
    serviceReadiness:async()=>null,wait:()=>waiting.promise,
    stop:async()=>{calls.push('stop');return {confirmed:false,handle,problem:{code:'PROCESS_STOP_UNCONFIRMED',message:'unit lost reply',recovery:'same-run Stop',retryable:true}};},
    collect:async()=>{calls.push('collect');return {handle,inputManifestSha256:context.input.identity.manifestSha256,collectionSha256:'d'.repeat(64),stdoutPath:'/unit/stdout',stderrPath:'/unit/stderr',files:[],tools:[]};},
    cleanup:async()=>{calls.push('cleanup');throw Error('No fabricated branded terminal receipt');},inspectOwnedOrphans:async()=>[]
  };
  const adapter:TaskRuntimeAdapter={
    family:'node',validate:async()=>({valid:true,problem:null}),
    buildPlan:async(c,p)=>{calls.push('plan');return {...c,mode:p.kind,timeoutMs:p.timeoutMs,
      command:{executable:'/unit/dispatcher',args:[';literal'],workingDirectory:'/workspace',environment:{}},
      resources:{memoryBytes:134217728,cpus:1,pids:64,logBytes:10485760,logFiles:1},
      isolation:{nonRootUser:'10001:10001',capDropAll:true,noNewPrivileges:true,readOnlyRoot:true,network:'none'},service:null,artifacts:[]};},
    interpret:async()=>{calls.push('interpret');return {status:'SUCCEEDED',testOutcome:'NOT_APPLICABLE',testCount:null,failures:null,errors:null,skipped:null,problem:null};}
  };
  const admission:RuntimeRunAdmission={projectId:'project1',profile,
    request:{requestId:'request1',clientId:'client1',sessionId:'session1',expectedWorkspaceVersion:1,mode:'RUN_MAIN',configurationGeneration:'cfg1'},
    runProfile:{kind:'RUN_MAIN',task:{workingDirectory:'.',entry:{kind:'SCRIPT',path:'main.js'},tests:{paths:[],names:[]}},timeoutMs:300000},
    adapter,assertCurrent:()=>{},capture:async()=>{calls.push('capture');return structuredClone(context);}
  };
  const options:RuntimeRunnerOptions={execution,getWorkspaceVersion:()=>version,newRunId:()=>handle.runId,
    emit:(type,payload)=>events.push({type,payload}),persistTerminal:async()=>{calls.push('persist');throw Error('Genuine receipt boundary unavailable in UNIT');}};
  return {runner:new Runner(options),admission,execution,adapter,context,handle,exit,calls,events,waiting,
    change:()=>{version++;},output:(text:string)=>output?.({stream:'STDOUT',text})};
}
