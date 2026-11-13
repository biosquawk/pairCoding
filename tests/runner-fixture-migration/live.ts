/** Real Docker final-campaign harness; imports are inert. NO fallback, pull, prepare, fake transport or skip.
 * Requires explicit final operator config via PAIRCOACH_RUNNER_LIVE_CONFIG. NOT_RUN during implementation.
 */
import assert from 'node:assert/strict';
import type { TestContext } from 'node:test';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { sha256 } from '../../src/server/execution/files';
import { DockerCliTransport, type DockerTransport, type DockerReply } from '../../src/server/execution/DockerTransport';
import { validateImageLock, validateRuntimeProfile } from '../../src/shared/validation-v2';
import { fixture, profile, until } from './fixture';
function object(value:unknown):value is Record<string,unknown> {return !!value && typeof value==='object' && !Array.isArray(value);}
function string(value:unknown):value is string {return typeof value==='string' && value.length>0;}

export async function liveFixture(t:TestContext,source:string) {
  const file=process.env.PAIRCOACH_RUNNER_LIVE_CONFIG;
  assert.ok(file,'LIVE NOT_RUN prerequisite: final approved Docker lane and PAIRCOACH_RUNNER_LIVE_CONFIG absolute JSON (see tests/runner-fixture-migration/LIVE.md); no injected substitute');
  assert.ok(path.isAbsolute(file));
  const value:unknown=JSON.parse(await fs.readFile(file,'utf8'));
  assert.ok(object(value));assert.ok(validateRuntimeProfile(value.runtime));assert.equal(value.runtime.adapterFamily,'node');
  assert.ok(validateImageLock(value.imageLock));assert.equal(value.imageLock.images.length,1);
  const image=value.imageLock.images[0];assert.equal(image.key,value.runtime.imageLockKey);
  for(const key of ['engineId','outputDirectory','cacheDirectory','managedCacheRoot','toolchainHash','dependencyHash','dockerExecutable'])assert.ok(string(value[key]),`Missing ${key}`);
  assert.ok(string(value.engineId) && string(value.outputDirectory) && string(value.cacheDirectory) && string(value.managedCacheRoot) && string(value.toolchainHash) && string(value.dependencyHash) && string(value.dockerExecutable));
  assert.match(value.toolchainHash,/^[a-f0-9]{64}$/);assert.match(value.dependencyHash,/^[a-f0-9]{64}$/);
  assert.ok(object(value.dockerEnvironment));
  const environment:Record<string,string>={};for(const [key,v]of Object.entries(value.dockerEnvironment)){assert.ok(string(v));environment[key]=v;}
  // Exact public-prepared package bytes enter the genuine immutable inventory.
  // The unchanged adapter still compares their dependency hash with the trusted cache.
  assert.ok(object(value.preparedPackage) && string(value.preparedPackage.path) && path.isAbsolute(value.preparedPackage.path) &&
    string(value.preparedPackage.sha256),'Missing original preparedPackage:{path,sha256}');
  assert.match(value.preparedPackage.sha256,/^[a-f0-9]{64}$/);
  const packageStat=await fs.lstat(value.preparedPackage.path);
  assert.ok(packageStat.isFile() && !packageStat.isSymbolicLink() && packageStat.size<=1024*1024);
  const packageJson=await fs.readFile(value.preparedPackage.path);
  assert.equal(sha256(packageJson),value.preparedPackage.sha256,'Original prepared package bytes changed');
  const cli=new DockerCliTransport(value.dockerExecutable,environment);
  const evidence=await fs.mkdtemp(path.join(value.outputDirectory,'runner-live-evidence-'));
  const removals:{id:string;inspection:Record<string,unknown>}[]=[];
  const run: DockerTransport['run']=async(args,options)=>{
    const startedAt=new Date().toISOString();
    const reply=await cli.run(args,options);
    await fs.appendFile(path.join(evidence,'docker.jsonl'),JSON.stringify({startedAt,finishedAt:new Date().toISOString(),args,options,reply})+'\n');return reply;
  };
  const transport:DockerTransport={run:async(args,options)=>{
    if(args[0]==='rm') {
      assert.equal(args.length,2);assert.match(args[1],/^[a-f0-9]{64}$/);
      const proof=await run(['container','inspect',args[1]]);assert.equal(proof.exitCode,0);
      const inspections:unknown=JSON.parse(proof.stdout);assert.ok(Array.isArray(inspections) && inspections.length===1);
      const v:unknown=inspections[0];assert.ok(object(v) && object(v.State));
      assert.equal(v.Id,args[1]);assert.equal(v.State.Running,false);assert.ok(['exited','dead'].includes(String(v.State.Status)));
      // Actual daemon refuses namespace entry once this owned container's full tree is stopped.
      const entry=await run(['exec',args[1],'/opt/paircoach/node/bin/node','-e','process.exit(0)']);
      assert.notEqual(entry.exitCode,0);assert.match(entry.stderr,/not running/i);
      removals.push({id:args[1],inspection:v});
    }
    return run(args,options);
  }};
  const f=await fixture(t,{transport,engineId:value.engineId,runtime:value.runtime,image,cacheDirectory:value.cacheDirectory,managedCacheRoot:value.managedCacheRoot,
    toolchainHash:value.toolchainHash,dependencyHash:value.dependencyHash,directory:value.outputDirectory,source,packageJson,preserve:true});
  return {...f,live:{run,removals,evidence}};
}
async function inspect(run:(args:readonly string[])=>Promise<DockerReply>,id:string):Promise<Record<string,unknown>> {
  const reply=await run(['container','inspect',id]);assert.equal(reply.exitCode,0);
  const value:unknown=JSON.parse(reply.stdout);assert.ok(Array.isArray(value) && value.length===1 && object(value[0]));return value[0];
}
export async function liveTree(t:TestContext,action:'STOP'|'TIMEOUT'):Promise<void> {
  const grandchild='setInterval(()=>{},1000)';
  const child=`const g=require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(grandchild)}],{stdio:'ignore'});require('node:fs').writeFileSync('/artifacts/grandchild.json',JSON.stringify({pid:g.pid}));setInterval(()=>{},1000)`;
  const source=`const c=require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(child)}],{stdio:'ignore'});require('node:fs').writeFileSync('/artifacts/child.json',JSON.stringify({parent:process.pid,pid:c.pid}));setInterval(()=>{},1000)`;
  const sentinel=await liveFixture(t,'console.log("CONTROL_ALIVE");setInterval(()=>{},1000)');
  const control=await sentinel.start(profile({timeoutMs:300000}));
  const f=await liveFixture(t,source);
  const run=await f.start(profile({timeoutMs:action==='TIMEOUT'?1000:5000}));
  const record=await f.journal.read(run.runId);assert.ok(record.containerId);
  const c=await sentinel.journal.read(control.runId);assert.ok(c.containerId);
  const artifacts=f.context(run.runId).input.artifactsDirectory;
  await until(async()=>{try{await fs.stat(path.join(artifacts,'grandchild.json'));await fs.stat(path.join(artifacts,'child.json'));return true;}catch{return false;}});
  const childData:unknown=JSON.parse(await fs.readFile(path.join(artifacts,'child.json'),'utf8'));
  const grandData:unknown=JSON.parse(await fs.readFile(path.join(artifacts,'grandchild.json'),'utf8'));
  assert.ok(object(childData)&&object(grandData));
  const pids=[childData.parent,childData.pid,grandData.pid];assert.ok(pids.every(p=>Number.isSafeInteger(p)&&Number(p)>0));
  assert.equal(new Set(pids).size,3);
  const probe=await f.live.run(['exec',record.containerId,'/opt/paircoach/node/bin/node','-e',`for(const pid of ${JSON.stringify(pids)})process.kill(pid,0);console.log('TREE_ALIVE')`]);
  assert.equal(probe.exitCode,0);assert.match(probe.stdout,/TREE_ALIVE/);
  if(action==='STOP')await f.runner.stop(run.runId);
  const result=await f.finished(run);assert.equal(result.status,action==='STOP'?'CANCELLED':'TIMED_OUT');
  assert.ok(f.live.removals.some(p=>p.id===record.containerId));
  // Exact ID + name absence after confirmed exited namespace, never timeout-as-absence.
  for(const id of [record.containerId,record.ownership.containerName]){
    const absence=await f.live.run(['container','inspect',id]);assert.equal(absence.exitCode,1);assert.ok(['','[]'].includes(absence.stdout.trim()));
    assert.ok([`Error: No such container: ${id}`,`Error response from daemon: No such container: ${id}`].includes(absence.stderr.trim()));
  }
  const controlProof=await inspect(sentinel.live.run,c.containerId);assert.ok(object(controlProof.State));assert.equal(controlProof.State.Running,true);
  const controlAlive=await sentinel.live.run(['exec',c.containerId,'/opt/paircoach/node/bin/node','-e',"console.log('CONTROL_ALIVE')"]);assert.equal(controlAlive.exitCode,0);assert.match(controlAlive.stdout,/CONTROL_ALIVE/);
  assert.equal((await f.runner.stop(run.runId)).status,result.status);
  await fs.writeFile(path.join(f.live.evidence,'tree-result.json'),JSON.stringify({action,pids,result,controlProof,removals:f.live.removals},null,2));
}
