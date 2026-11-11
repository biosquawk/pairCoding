/** UNIT ONLY: actual filesystem, fake Docker command transport. No daemon/image/runtime proof. */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import type {
  ExecutionPlan, ExecutionHandle, AdapterOutcome
} from '../../src/server/execution/ports';
import {
  copyAcknowledgedInput, type SettledAcknowledgement
} from '../../src/server/execution/ImmutableInput';
import {
  canonicalJson, sha256
} from '../../src/server/execution/files';
import {
  DurableRunJournal
} from '../../src/server/execution/DurableRunJournal';
import {
  DockerExecutor
} from '../../src/server/execution/DockerExecutor';
import type {
  DockerReply, DockerTransport
} from '../../src/server/execution/DockerTransport';
import {
  EXECUTION_COMMAND_ENV, RUNTIME_EXECUTABLE, RUNTIME_DISPATCHER
} from '../../src/server/execution/RuntimeCommand';
import type {
  ExecutorPolicy
} from '../../src/server/execution/PlanPolicy';
export const imageId='sha256:'+'a'.repeat(64),digest='sha256:'+'b'.repeat(64);
export const profile={
  id:'javascript-node',label:'Node',adapterFamily:'node' as const,imageLockKey:'node22',expectedTools:[{
    name:'node',version:'22.22.0'
  }],compilerRelease:null,analysis:{
    languageLevel:'ES2022',preview:false
  },language:{
    provider:'builtin' as const,imageLockKey:null,serverJvm:null
  },taskFields:[]
};
export const image={
  key:'node22',image:'paircoach/runtime-node:22-v1',imageId,digest,tools:profile.expectedTools
};
export const success:AdapterOutcome={
  status:'SUCCEEDED',testOutcome:'PASSED',testCount:1,skipped:0,failures:0,errors:0,problem:null
};
export class FakeDocker implements DockerTransport {
  calls:string[][]=[];
  engineId='engine-unit';
  startThrowsBeforeCommit=false;
  logsFail=false;
  v:any=null;
  daemon=true;
  imagePresent=true;
  createThrowsAfterCommit=false;
  startThrowsAfterCommit=false;
  stopThrowsAfterCommit=false;
  rmThrowsAfterCommit=false;
  stopRemainsRunning=false;
  port=43210;
  exitCode=0;
  logs={
    stdout:'actual task log\n',stderr:''
  };
  journal?:DurableRunJournal;
  beforeCreate?:()=>Promise<void>;
  onStart?:()=>Promise<void>;
  onStop?:()=>Promise<void>;
  async run(args:readonly string[]):Promise<DockerReply>{
    this.calls.push([...args]);
    const ok=(value:any='')=>({
      exitCode:0,stdout:typeof value==='string'?value:JSON.stringify(value),stderr:''
    });
    if(!this.daemon)throw new Error('Fake daemon offline');
    if(args[0]==='info')return ok(JSON.stringify(this.engineId));
    if(args[0]==='image')return this.imagePresent?ok([{
      Id:imageId,RepoDigests:['repo@'+digest]
    }]):{
      exitCode:1,stdout:'',stderr:'No such image'
    };
    if(args[0]==='network')return ok([{
      Name:'paircoach-unit-internal',Internal:true,Driver:'bridge'
    }]);
    if(args[0]==='container'&&args[1]==='inspect')return this.v?ok([structuredClone(this.v)]):{
      exitCode:1,stdout:'',stderr:`Error: No such container: ${args[2]}`
    };
    if(args[0]==='create'){
      await this.beforeCreate?.();
      const labels:Record<string,string>={
      };
      for(let n=0;
      n<args.length;
      n++)if(args[n]==='--label'){
        const [key,...v]=args[n+1].split('=');
        labels[key]=v.join('=');
      }
      this.v={
        Id:'c'.repeat(64),Name:'/'+args[args.indexOf('--name')+1],Image:imageId,Config:{
          Labels:labels
        },State:{
          Running:false,Status:'created',ExitCode:0,FinishedAt:'0001-01-01T00:00:00Z'
        },NetworkSettings:{
          Ports:{
            '8080/tcp':[{
              HostIp:'127.0.0.1',HostPort:String(this.port)
            }]
          }
        }
      };
      if(this.createThrowsAfterCommit)throw new Error('Response lost after create');
      return ok(this.v.Id);
    }
    if(args[0]==='start'){
      if(this.startThrowsBeforeCommit)throw new Error('Failed before start');
      this.v.State.Running=true;
      this.v.State.Status='running';
      await this.onStart?.();
      if(this.startThrowsAfterCommit)throw new Error('Response lost after start');
      return ok(this.v.Id);
    }
    if(args[0]==='stop'){
      if(!this.stopRemainsRunning){
        this.finish(137);
        await this.onStop?.();
      }
      if(this.stopThrowsAfterCommit)throw new Error('Response lost after stop');
      return ok(this.v.Id);
    }
    if(args[0]==='logs'){
      if(this.logsFail)throw new Error('Log transport failed');
      return {
        exitCode:0,...this.logs
      };
    }
    if(args[0]==='rm'){
      this.v=null;
      if(this.rmThrowsAfterCommit)throw new Error('Response lost after rm');
      return ok();
    }
    throw new Error('Unexpected fake argv '+JSON.stringify(args));
  }
  finish(code=this.exitCode){
    this.v.State={
      Running:false,Status:'exited',ExitCode:code,FinishedAt:'2026-11-11T22:00:00.000000000Z'
    };
  }
}
export async function fixture(){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'executor-unit-'));
  const workspace=path.join(root,'workspace'),runs=path.join(root,'runs');
  await fs.mkdir(workspace);
  await fs.mkdir(runs);
  await fs.writeFile(path.join(workspace,'main.js'),'console.log("ACK")\n');
  await fs.writeFile(path.join(workspace,'zażółć 😀.txt'),'A\r\nB');
  const ack:SettledAcknowledgement={
    projectId:'project',sessionId:'session',workspaceVersion:3,files:await Promise.all(['main.js','zażółć 😀.txt'].map(async p=>{
      const b=await fs.readFile(path.join(workspace,p));
      return {
        path:p,documentVersion:2,sha256:sha256(b),bytes:b.length
      };
    })),assertCurrent:async()=>{
    }
  };
  const copy=async(runId='run1',hook?:(p:string)=>Promise<void>)=>copyAcknowledgedInput({
    workspaceDirectory:workspace,runDirectory:path.join(runs,runId),runId,profileId:profile.id,configurationGeneration:'config1',acknowledgement:ack,afterFileCopied:hook
  });
  const input=await copy();
  const cacheRoot=path.join(root,'managed-cache'),cacheDirectory=path.join(cacheRoot,'node','toolchain','dependencies');
  await fs.mkdir(cacheRoot,{
    mode:0o700
  });
  await fs.mkdir(cacheDirectory,{
    recursive:true
  });
  const caches=[{
    directory:cacheDirectory,family:'node' as const,toolchainHash:'d'.repeat(64),dependencyHash:'e'.repeat(64),readOnly:true
  }];
  const spec={
    schemaVersion:1,family:'node',release:null,preview:false,runId:'run1',manifestSha256:input.identity.manifestSha256,mode:'RUN_TESTS',task:{
      workingDirectory:'.',entry:{
        kind:'TESTS'
      },tests:{
        paths:['main.js'],names:[]
      }
    },cache:'/cache/0'
  };
  const plan:ExecutionPlan={
    ownership:{
      installationId:'install',runId:'run1',profileId:profile.id,engineId:'engine-unit',containerName:`paircoach-install-${profile.id}-run1`,imageId
    },input,profile,lockedImage:image,mode:'RUN_TESTS',timeoutMs:1000,command:{
      executable:RUNTIME_EXECUTABLE,args:[RUNTIME_DISPATCHER,Buffer.from(canonicalJson(spec)).toString('base64url')],workingDirectory:'/workspace',environment:{
        ...EXECUTION_COMMAND_ENV
      }
    },caches,resources:{
      memoryBytes:128*1024*1024,cpus:1,pids:64,logBytes:10485760,logFiles:1
    },isolation:{
      nonRootUser:'10001:10001',capDropAll:true,noNewPrivileges:true,readOnlyRoot:true,network:'none'
    },service:null,artifacts:['JUNIT_XML']
  };
  const policy:ExecutorPolicy={
    installationId:'install',engineId:'engine-unit',runRoot:runs,runtimes:[{
      profile,image,caches,commandAllowed:(c,mode)=>c.executable===RUNTIME_EXECUTABLE&&c.args[0]===RUNTIME_DISPATCHER&&['RUN_MAIN','RUN_TESTS'].includes(mode)
    }],nonRootUser:'10001:10001',managedCacheRoot:cacheRoot,serviceNetwork:'paircoach-unit-internal'
  };
  const journal=new DurableRunJournal(path.join(root,'journal'),'install'),fake=new FakeDocker();
  let clock=Date.now();
  const executor=new DockerExecutor({
    policy,journal,transport:fake,now:()=>clock,sleep:async ms=>{
      clock+=ms;
    }
  });
  fake.journal=journal;
  const cleanup=async()=>{
    async function writable(dir:string){
      for(const e of await fs.readdir(dir,{
        withFileTypes:true
      })){
        const p=path.join(dir,e.name);
        if(e.isDirectory())await writable(p);
      }
      await fs.chmod(dir,0o700);
    }
    await writable(root);
    await fs.rm(root,{
      recursive:true,force:true
    });
  };
  const end=async(handle:ExecutionHandle)=>{
    fake.finish();
    const exit=await executor.wait(handle);
    await fs.writeFile(path.join(input.artifactsDirectory,'junit.xml'),'<testsuite><testcase name="fresh"/></testsuite>');
    return {
      exit,collection:await executor.collect(handle,exit)
    };
  };
  const setSpec=(value:object)=>{
    plan.command.args=[RUNTIME_DISPATCHER,Buffer.from(canonicalJson(value)).toString('base64url')];
  };
  return {
    spec,setSpec,cacheRoot,root,workspace,runs,ack,copy,input,plan,policy,journal,fake,executor,cleanup,end,advance:(ms:number)=>{
      clock+=ms;
    }
  };
}
