/** Physical Docker fixture for retained process-tree regressions. No host task execution. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import type { TestContext } from 'node:test';
import { createPairCoachServer, type ServerOptions } from '../../src/server/http';
import type { SettingsV2 } from '../../src/shared/runtime-v2';
import { workspaceFiles, Peer, id } from './helpers';

const execute=promisify(execFile);
export async function liveNodeFixture(t:TestContext,files:Record<string,string>,runProfiles:SettingsV2['runProfiles'],options:Partial<ServerOptions>={},initialSettings:Partial<SettingsV2>={}) {
  const prepared=process.env.PAIRCOACH_NODE_TEST_PREPARED;
  assert.ok(prepared&&path.isAbsolute(prepared),'Physical Node regression needs PAIRCOACH_NODE_TEST_PREPARED: public runtime:prepare output for examples/javascript-counter; no host fallback.');
  const preparedConfig=path.join(prepared,'runtime-config.json'),config=JSON.parse(fs.readFileSync(preparedConfig,'utf8'));
  assert.equal(config.activeProfile,'javascript-node');
  const dirs=await workspaceFiles(t,{'package.json':fs.readFileSync(new URL('../../examples/javascript-counter/package.json',import.meta.url),'utf8'),...files},path.join(path.dirname(prepared),'node-fixtures'));
  const settings:SettingsV2={schemaVersion:2,taskFilePath:'challenge.md',taskMode:'IMPLEMENTATION',reviewNotesPath:'review.md',aiConsent:false,contextPatterns:[],runProfiles,...initialSettings};
  fs.writeFileSync(path.join(dirs.dataDir,'settings.json'),JSON.stringify(settings),{mode:0o600});
  const runtimeConfig=path.join(dirs.base,'runtime.json');
  fs.writeFileSync(runtimeConfig,JSON.stringify({...config,workspaceRoot:dirs.rootPath,
    runtimeCatalog:path.resolve(prepared,config.runtimeCatalog),imageLock:path.resolve(prepared,config.imageLock)}),{mode:0o600});
  const token=id(),clientId=id(),app=createPairCoachServer({port:0,rootPath:dirs.rootPath,token,enableExecution:true,enableCoach:false,...options,
    runtimeEnvironment:{},runtimeArguments:['--runtime-config',runtimeConfig,'--prepared-runtime',path.join(prepared,'jobs/javascript-node')]});
  const peers=new Set<{close():void}>();
  t.after(async()=>{for(const p of peers)p.close();try{await app.close();}finally{
    // Immutable Run inputs are deliberately read-only; only unlock this fixture after owner close.
    const unlock=(directory:string)=>{if(fs.statSync(directory).uid===process.getuid?.())fs.chmodSync(directory,0o700);for(const item of fs.readdirSync(directory,{withFileTypes:true}))if(item.isDirectory()&&!item.isSymbolicLink())unlock(path.join(directory,item.name));};
    unlock(dirs.base);
    // The dispatcher creates its private HOME as UID 10001. Reclaim only fixture-owned
    // test data as that same non-root UID, without sudo/capabilities or host-home mounts.
    const foreignRoots:string[]=[];
    const foreign=(directory:string)=>{if(fs.statSync(directory).uid===10001){foreignRoots.push(directory);return;}for(const e of fs.readdirSync(directory,{withFileTypes:true}))if(e.isDirectory()&&!e.isSymbolicLink())foreign(path.join(directory,e.name));};
    foreign(dirs.base);
    if(foreignRoots.length){
      const profile=JSON.parse(fs.readFileSync(path.resolve(prepared,config.runtimeCatalog),'utf8')).profiles.find((p:any)=>p.id===config.activeProfile);
      const image=JSON.parse(fs.readFileSync(path.resolve(prepared,config.imageLock),'utf8')).images.find((i:any)=>i.key===profile.imageLockKey);
      const clean=`const fs=require('fs'),p=require('path');function visit(d){for(const e of fs.readdirSync(d,{withFileTypes:true})){const n=p.join(d,e.name);if(e.isDirectory()&&!e.isSymbolicLink())visit(n)}if(fs.statSync(d).uid===process.getuid())fs.chmodSync(d,0o777)}for(const d of process.argv.slice(1))visit(d)`;
      const mounts=foreignRoots.flatMap((directory,n)=>['--mount',`type=bind,src=${directory},dst=/fixture${n}`]);
      await execute('docker',['run','--rm','--pull=never','--name','paircoach-test-cleanup-'+randomUUID(),'--user','10001:10001','--cap-drop=ALL','--security-opt=no-new-privileges','--network=none','--memory=128m','--cpus=1','--pids-limit=32','--log-opt','max-size=10m','--log-opt','max-file=1',...mounts,image.imageId,'node','-e',clean,...foreignRoots.map((_,n)=>'/fixture'+n)],{encoding:'utf8',timeout:10000,maxBuffer:1048576});
    }
    await dirs.cleanup();}});
  const port=await app.listen(),baseURL=`http://127.0.0.1:${port}`,sessionId=app.session.state.sessionId;
  const peer=new Peer({port,baseURL,clientId,sessionId,token,peers} as any);await peer.connect();
  // Consume the actual measured readiness already requested by HELLO, rather than
  // launching a duplicate expensive GET probe concurrently with that same measurement.
  const measured=(await peer.take(m=>m.type==='SESSION_SNAPSHOT'&&m.payload.project.capabilities.execution.modes.RUN_MAIN.canRun)).payload.project;
  const command=()=>({requestId:id(),clientId,sessionId});
  const http=async(method:string,url:string,body?:unknown)=>{
    const response=await fetch(baseURL+url,{method,headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},
      body:body===undefined?undefined:JSON.stringify(body),signal:url==='/api/run'?t.signal:AbortSignal.timeout(5000)});
    return {status:response.status,body:await response.json()};
  };
  const save=async(next:SettingsV2)=>{
    const response=await http('PUT','/api/project/settings',{...command(),expectedWorkspaceVersion:app.workspace.workspaceVersion,settings:next});
    assert.equal(response.status,200,JSON.stringify(response.body));return response.body;
  };
  const run=async(mode:'RUN_MAIN'|'RUN_TESTS'='RUN_MAIN')=>{
    const project={body:measured};
    const response=await http('POST','/api/run',{...command(),mode,expectedWorkspaceVersion:project.body.workspaceVersion,
      configurationGeneration:project.body.capabilities.execution.runtime.configurationGeneration});
    assert.equal(response.status,202,JSON.stringify(response.body));return response.body;
  };
  const layout=JSON.parse(fs.readFileSync(path.join(dirs.dataDir,'runtime-execution-layout.json'),'utf8')).layout;
  const record=(runId:string)=>JSON.parse(fs.readFileSync(path.join(layout.journalDirectory,runId+'.json'),'utf8'));
  const processes=async(runId:string)=>{
    const owner=record(runId);assert.match(owner.containerId,/^[a-f0-9]{64}$/);
    const {stdout}=await execute('docker',['top',owner.containerId,'-eo','pid,ppid,args'],{encoding:'utf8',timeout:10000,maxBuffer:1048576});
    const rows=stdout.trim().split('\n').slice(1).map(row=>row.trim().split(/\s+/));
    const nodes=rows.filter(row=>row.slice(2).join(' ').includes('node'));
    assert.ok(nodes.length>=3,'Actual container must contain dispatcher, program and child Node processes');
    return {containerId:owner.containerId,pids:nodes.map(row=>row[0])};
  };
  const absent=async(runId:string)=>{
    const owner=record(runId);assert.equal(owner.phase,'REMOVED');
    try{await execute('docker',['container','inspect',owner.containerId],{encoding:'utf8',timeout:10000,maxBuffer:1048576});assert.fail('Owned container remains');}
    catch(error){const e=error as Error&{code?:number;stderr?:string};assert.equal(e.code,1);assert.ok(e.stderr?.includes('No such container: '+owner.containerId)||e.stderr?.includes('No such object: '+owner.containerId));}
  };
  return {...dirs,app,port,baseURL,token,clientId,sessionId,peer,command,http,settings,save,run,record,processes,absent};
}

export function scriptProfile(file:string,timeoutMs:number):SettingsV2['runProfiles'][number] {
  return {kind:'RUN_MAIN',timeoutMs,task:{workingDirectory:'.',entry:{kind:'SCRIPT',path:file},tests:{paths:[],names:[]}}};
}
