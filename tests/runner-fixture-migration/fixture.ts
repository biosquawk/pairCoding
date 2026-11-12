/** UNIT: real public Runner/adapter/input/executor/journal/FS, injected Docker transport ONLY. */
import assert from 'node:assert/strict';
import type { TestContext } from 'node:test';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { Runner, type RuntimeRunAdmission } from '../../src/server/Runner';
import { NodeAdapter, dependencyHash } from '../../src/server/runtime-adapters';
import { copyAcknowledgedInput } from '../../src/server/execution/ImmutableInput';
import { DockerExecutor } from '../../src/server/execution/DockerExecutor';
import { DurableRunJournal } from '../../src/server/execution/DurableRunJournal';
import { validateRuntimeCommand } from '../../src/server/execution/RuntimeCommand';
import { sha256 } from '../../src/server/execution/files';
import type { DockerTransport, DockerReply } from '../../src/server/execution/DockerTransport';
import type { ExecutorPolicy } from '../../src/server/execution/PlanPolicy';
import type { ExecutionPlan, PlanContext } from '../../src/server/execution/ports';
import type { RunProfileV2, RunV2, RuntimeProfile, ImageLockEntry } from '../../src/shared/runtime-v2';

export async function until(predicate: () => boolean | Promise<boolean>, limit = 10000): Promise<void> {
  const deadline = Date.now() + limit;
  while (!await predicate()) { if (Date.now() > deadline) throw new Error('Condition timeout'); await new Promise(r => setTimeout(r, 15)); }
}
export function profile(overrides: Partial<RunProfileV2> = {}): RunProfileV2 {
  return { kind: 'RUN_MAIN', task: {workingDirectory:'.',entry:{kind:'SCRIPT',path:'main.cjs'},tests:{paths:[],names:[]}}, timeoutMs:5000, ...overrides };
}
export function testsProfile(): RunProfileV2 {
  return profile({kind:'RUN_TESTS',task:{workingDirectory:'.',entry:{kind:'TESTS'},tests:{paths:['main.cjs'],names:[]}}});
}
export interface ContainerInspection {
  Id:string; Name:string; Image:string; Config:{Labels:Record<string,string>};
  State:{Running:boolean;Status:string;ExitCode:number;StartedAt:string;FinishedAt:string};
}
/** Does not execute code or interpret tests/security. Only models bounded Docker command replies. */
export class UnitDocker implements DockerTransport {
  readonly calls: string[][]=[];
  container:ContainerInspection|null=null;
  logs={stdout:'',stderr:''};
  imagePresent=true;
  constructor(readonly engineId:string, readonly image:ImageLockEntry) {}
  async run(args:readonly string[]):Promise<DockerReply> {
    this.calls.push([...args]);
    const ok=(value:unknown=''):DockerReply=>({exitCode:0,stdout:typeof value==='string'?value:JSON.stringify(value),stderr:''});
    if(args[0]==='info')return ok(JSON.stringify(this.engineId));
    if(args[0]==='image')return this.imagePresent ? ok([{Id:this.image.imageId,Descriptor:{digest:this.image.digest}}]) : {exitCode:1,stdout:'',stderr:'No such image'};
    if(args[0]==='container' && args[1]==='inspect')return this.container ? ok([this.container]) : {exitCode:1,stdout:'',stderr:`Error: No such container: ${args[2]}`};
    if(args[0]==='create') {
      assert.equal(this.container,null,'single modeled container');
      const labels:Record<string,string>={};
      args.forEach((v,i)=>{if(v==='--label'){const [key,...parts]=args[i+1].split('=');labels[key]=parts.join('=');}});
      this.container={Id:'c'.repeat(64),Name:'/'+args[args.indexOf('--name')+1],Image:this.image.imageId,Config:{Labels:labels},
        State:{Running:false,Status:'created',ExitCode:0,StartedAt:'0001-01-01T00:00:00Z',FinishedAt:'0001-01-01T00:00:00Z'}};
      return ok(this.container.Id);
    }
    if(args[0]==='start') {assert.ok(this.container);this.container.State.Running=true;this.container.State.Status='running';this.container.State.StartedAt=new Date().toISOString();return ok(this.container.Id);}
    if(args[0]==='logs')return {exitCode:0,...this.logs};
    if(args[0]==='stop'){this.finish(137);return ok(args.at(-1));}
    if(args[0]==='rm'){assert.ok(this.container && !this.container.State.Running);assert.deepEqual(args,['rm',this.container.Id]);this.container=null;return ok();}
    throw new Error('Unexpected UNIT Docker argv '+JSON.stringify(args));
  }
  finish(exitCode=0):void {assert.ok(this.container);Object.assign(this.container.State,{Running:false,Status:'exited',ExitCode:exitCode,FinishedAt:new Date().toISOString()});}
}
export const unitProfile:RuntimeProfile={id:'javascript-node',label:'UNIT Node',adapterFamily:'node',imageLockKey:'node22',expectedTools:[{name:'node',version:'22.22.0'}],compilerRelease:null,
  analysis:{languageLevel:'ES2022',preview:false},language:{provider:'builtin',imageLockKey:null,serverJvm:null},taskFields:[]};
export const unitImage:ImageLockEntry={key:'node22',image:'paircoach/unit-node:22',imageId:'sha256:'+'a'.repeat(64),digest:'sha256:'+'b'.repeat(64),tools:unitProfile.expectedTools};
export interface FixtureOptions {
  transport?:DockerTransport; engineId?:string; runtime?:RuntimeProfile; image?:ImageLockEntry;
  cacheDirectory?:string; managedCacheRoot?:string; directory?:string; source?:string;
  toolchainHash?:string; dependencyHash?:string; preserve?:boolean;
}
export async function fixture(t:TestContext, options:FixtureOptions={}) {
  const root=await fs.mkdtemp(path.join(options.directory??os.tmpdir(),'runner-migration-'));
  const workspace=path.join(root,'workspace'),runs=path.join(root,'runs');
  await fs.mkdir(workspace);await fs.mkdir(runs);
  await fs.writeFile(path.join(workspace,'main.cjs'),options.source??'// UNIT immutable input, never executed by injected transport\n');
  const runtime=structuredClone(options.runtime??unitProfile),image=structuredClone(options.image??unitImage),engineId=options.engineId??'engine-unit';
  const installationId='fixture-'+randomUUID(),generation='cfg1';
  const managedCacheRoot=options.managedCacheRoot??path.join(root,'cache');
  const cacheDirectory=options.cacheDirectory??path.join(managedCacheRoot,'node','prepared');
  if(!options.cacheDirectory){await fs.mkdir(managedCacheRoot,{mode:0o700});await fs.mkdir(cacheDirectory,{recursive:true});}
  const source=await fs.readFile(path.join(workspace,'main.cjs'));
  const files=[{path:'main.cjs',documentVersion:1,sha256:sha256(source),bytes:source.length}];
  const caches=[{directory:cacheDirectory,family:runtime.adapterFamily,toolchainHash:options.toolchainHash??'d'.repeat(64),dependencyHash:options.dependencyHash??dependencyHash(files),readOnly:true}];
  const unit=new UnitDocker(engineId,image),transport=options.transport??unit;
  const policy:ExecutorPolicy={installationId,engineId,runRoot:runs,nonRootUser:'10001:10001',managedCacheRoot,serviceNetwork:null,
    runtimes:[{profile:runtime,image,caches,commandAllowed:(command,mode)=>{ // additional approval NEVER substitutes for actual independent validator
      return command.executable==='/opt/paircoach/node/bin/node' && command.args[0]==='/opt/paircoach/runtime-task.mjs' && ['RUN_MAIN','RUN_TESTS'].includes(mode);
    }}]};
  const journal=new DurableRunJournal(path.join(root,'journal'),installationId);
  const executor=new DockerExecutor({policy,journal,transport,sleep:ms=>new Promise(resolve=>setTimeout(resolve,options.transport?ms:2))});
  const adapter=new NodeAdapter();
  let version=1,current=true;
  const events:{type:'RUN_STATE'|'RUN_OUTPUT';payload:unknown}[]=[];
  const runner=new Runner({execution:executor,getWorkspaceVersion:()=>version,emit:(type,payload)=>events.push({type,payload}),persistTerminal:(handle,outcome)=>executor.persistTerminal(handle,outcome)});
  const contexts=new Map<string,PlanContext>();
  const admission=(runProfile=profile()):RuntimeRunAdmission=>({projectId:'project1',request:{requestId:randomUUID(),clientId:'client1',sessionId:'session1',mode:runProfile.kind,configurationGeneration:generation,expectedWorkspaceVersion:version},
    profile:runtime,runProfile,adapter,assertCurrent:()=>{assert.ok(current,'current approved configuration');},capture:async runId=>{
      const input=await copyAcknowledgedInput({workspaceDirectory:workspace,runDirectory:path.join(runs,runId),runId,profileId:runtime.id,configurationGeneration:generation,
        acknowledgement:{projectId:'project1',sessionId:'session1',workspaceVersion:version,files,assertCurrent:async()=>{assert.ok(current);}}});
      const context:PlanContext={ownership:{installationId,engineId,runId,profileId:runtime.id,containerName:`paircoach-${installationId}-${runtime.id}-${runId}`,imageId:image.imageId},input,profile:runtime,lockedImage:image,caches};
      contexts.set(runId,context);return context;
    }});
  const start=async(p=profile())=>{unit.logs={stdout:'',stderr:''};return runner.start(admission(p));};
  const context=(runId:string)=>{const c=contexts.get(runId);assert.ok(c);return c;};
  const plan=async(runId:string,p=profile()):Promise<ExecutionPlan>=>{const result=await adapter.buildPlan(context(runId),p);validateRuntimeCommand(result);return result;};
  const finished=async(run:RunV2)=>{await until(()=>!['QUEUED','RUNNING','STOPPING'].includes(runner.get(run.runId).status));return runner.get(run.runId);};
  const finish=async(run:RunV2,xml?:string,exitCode=0)=>{
    if(xml!==undefined)await fs.writeFile(path.join(context(run.runId).input.artifactsDirectory,`report-${run.runId}.xml`),xml);
    unit.finish(exitCode);return finished(run);
  };
  t.after(async()=>{
    await runner.stopAll();
    if(options.preserve)return;
    // Remove ONLY this fixture's private tree, never external cache/input/symlink targets.
    const writable=async(dir:string):Promise<void>=>{for(const e of await fs.readdir(dir,{withFileTypes:true}))if(e.isDirectory())await writable(path.join(dir,e.name));await fs.chmod(dir,0o700);};
    await writable(root);await fs.rm(root,{recursive:true,force:true});
  });
  return {root,workspace,runs,runtime,image,policy,journal,executor,adapter,runner,unit,events,admission,start,context,plan,finish,finished,
    change:()=>{version++;},revoke:()=>{current=false;}};
}
export interface OutputPayload {runId:string;outputSeq:number;stream:'STDOUT'|'STDERR';chunk:string}
export function outputPayload(value:unknown):value is OutputPayload {
  return !!value && typeof value==='object' && 'runId' in value && typeof value.runId==='string' && 'outputSeq' in value && typeof value.outputSeq==='number' &&
    'stream' in value && (value.stream==='STDOUT'||value.stream==='STDERR') && 'chunk' in value && typeof value.chunk==='string';
}
