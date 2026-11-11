/** Actual coordinator/gate/resolver/executor/adapters with controlled Docker and producer identity.
 * Synthetic prepared receipt/tool/engine/image evidence, NOT real preparation/Docker/native proof.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { TestContext } from 'node:test';
import { createRuntimeWorkspace } from '../../src/server/runtime-coordinator/RuntimeWorkspace';
import { createRuntimeExecutionLayout } from '../../src/server/runtime-coordinator/RuntimeExecutionLayout';
import { createRuntimeExecution } from '../../src/server/runtime-coordinator/RuntimeExecution';
import { PreparedRuntimeResolver } from '../../src/server/runtime-coordinator/PreparedRuntimeResolver';
import { readRunSourceInventory } from '../../src/server/execution/ImmutableInput';
import { dependencyHash } from '../../src/server/runtime-adapters';
import { sha256 } from '../../src/server/runtime-coordinator/storage';
import { FakeDocker, profile, image } from '../runtime-executor/fixtures';
import type { ResolvedRuntime } from '../../src/server/runtime-config';
import type { SettingsV2, RunProfileV2 } from '../../src/shared/runtime-v2';
export async function executionFixture(t: TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'execution-composition-')), workspace = path.join(root,'workspace'), preparedRoot = path.join(root,'prepared');
  fs.mkdirSync(workspace);fs.mkdirSync(preparedRoot,{mode:0o700});fs.mkdirSync(path.join(workspace,'.paircoach'),{mode:0o700});
  fs.writeFileSync(path.join(workspace,'main.js'),'\ufeffconsole.log("ORIGINAL");\r\n');fs.writeFileSync(path.join(workspace,'test.js'),'// TEST\r\n');fs.writeFileSync(path.join(workspace,'package.json'),'{}\r\n');
  const main:RunProfileV2={kind:'RUN_MAIN',task:{workingDirectory:'.',entry:{kind:'SCRIPT',path:'main.js'},tests:{paths:[],names:[]}},timeoutMs:300000};
  const tests:RunProfileV2={kind:'RUN_TESTS',task:{workingDirectory:'.',entry:{kind:'TESTS'},tests:{paths:['test.js'],names:[]}},timeoutMs:300000};
  const settings:SettingsV2={schemaVersion:2,taskFilePath:null,taskMode:'IMPLEMENTATION',reviewNotesPath:'review.md',runProfiles:[main,tests],aiConsent:false,contextPatterns:[]};
  fs.writeFileSync(path.join(workspace,'.paircoach','settings.json'),JSON.stringify(settings));
  const core=await createRuntimeWorkspace({rootPath:workspace});core.session.claimLease('tab');
  const fake=new FakeDocker(), engine={ID:fake.engineId,ServerVersion:'29.7.2',OSType:'linux',Architecture:'amd64'};
  const inspected={Id:image.imageId,Os:'linux',Architecture:'amd64',RepoDigests:['paircoach/runtime-node@'+image.digest],Config:{User:'10001:10001',Entrypoint:null}};
  const identity={toolchainHash:'c'.repeat(64),dispatcherFiles:[{path:'scripts/runtime-task.mjs',sha256:'d'.repeat(64)}]};
  const inventory=await readRunSourceInventory(workspace), dependency=dependencyHash(inventory);
  const cache=path.join(preparedRoot,'cache',profile.adapterFamily,identity.toolchainHash,dependency);fs.mkdirSync(cache,{recursive:true});
  const tools=[{name:'node',version:'22.22.0',raw:'v22.22.0\n'}], marker={family:profile.adapterFamily,workingDirectory:'.',dependencySha256:dependency,tools,preparedAt:'2026-11-11T22:00:00.000Z'};
  const toolBytes=JSON.stringify(tools),markerBytes=JSON.stringify(marker);fs.writeFileSync(path.join(cache,'tools.json'),toolBytes);fs.writeFileSync(path.join(cache,'dependencies-prepared.json'),markerBytes);
  const receipt={schemaVersion:1,status:'PREPARED_REQUIRES_OFFLINE_AND_TOOL_VALIDATION',engine,request:{key:profile.id,family:profile.adapterFamily,project:{root:workspace,files:[]},workingDirectory:'.',outputRoot:preparedRoot,imageTag:image.image,dependencySha256:dependency,expectedTools:profile.expectedTools,installationId:'prepare-unit'},
    toolchainHash:identity.toolchainHash,dispatcherFiles:identity.dispatcherFiles,imageId:image.imageId,imageInspect:inspected,observedImage:{Id:inspected.Id,RepoDigests:inspected.RepoDigests,Descriptor:null},
    container:{Id:'e'.repeat(64),State:{Running:false,ExitCode:0},Config:{Image:image.imageId,Labels:{'paircoach.installation':'prepare-unit','paircoach.role':'prepare'}}},
    cacheEvidence:{root:cache,tools:{path:'tools.json',sha256:sha256(toolBytes),actual:tools},dependencies:{path:'dependencies-prepared.json',sha256:sha256(markerBytes),actual:marker}}};
  fs.writeFileSync(path.join(preparedRoot,'receipt.json'),JSON.stringify(receipt));
  const runtime:ResolvedRuntime={configurationGeneration:'cfg',configPath:path.join(root,'paircoach.runtime.json'),workspaceRoot:workspace,profile,image,languageImage:null,catalog:{schemaVersion:1,profiles:[profile]},imageLock:{schemaVersion:1,images:[image]},
    config:{schemaVersion:1,activeProfile:profile.id,workspaceRoot:workspace,runtimeCatalog:'catalog.json',imageLock:'images.lock.json',languageFeatures:{completion:true,diagnostics:true},execution:{backend:'docker',pullPolicy:'never'}}};
  const prepared=new PreparedRuntimeResolver({outputRoots:[preparedRoot]},{readRunSourceInventory,dependencyHash,resolvePreparedToolchainIdentity:()=>structuredClone(identity),inspectEngine:async()=>structuredClone(engine),inspectImage:async()=>[structuredClone(inspected)]});
  const transport={run:async(args:readonly string[])=>args[0]==='image'?{exitCode:0,stdout:JSON.stringify([inspected]),stderr:''}:fake.run(args)};
  const layout=createRuntimeExecutionLayout(path.join(root,'.paircoach-runtime'),workspace,core.workspace.projectId,[preparedRoot]);
  const events:{type:string;payload:any}[]=[];let current=true;
  const execution=createRuntimeExecution({core,configuration:{configurationGeneration:'cfg',resolved:runtime,problem:null},prepared,layout,transport,serviceNetwork:null,
    assertCurrent:()=>{if(!current)throw Error('binding revoked');},emit:(type,payload)=>events.push({type,payload})});
  t.after(async()=>{
    fake.daemon=true;await execution.runner.stopAll().catch(()=>{});core.close();
    function unlock(p:string){if(fs.lstatSync(p).isDirectory()){fs.chmodSync(p,0o700);for(const n of fs.readdirSync(p))unlock(path.join(p,n));}}
    unlock(root);fs.rmSync(root,{recursive:true,force:true});
  });
  const request=(mode:'RUN_MAIN'|'RUN_TESTS'='RUN_MAIN')=>({requestId:'request-'+mode,clientId:'tab',sessionId:core.session.state.sessionId,expectedWorkspaceVersion:core.workspace.workspaceVersion,configurationGeneration:'cfg',mode});
  return {root,workspace,preparedRoot,cache,core,fake,runtime,prepared,layout,execution,events,request,revoke:()=>{current=false;}};
}
export async function until(predicate:()=>boolean){const deadline=Date.now()+3000;while(!predicate()){if(Date.now()>deadline)throw Error('Expected actual lifecycle transition not observed');await new Promise(r=>setTimeout(r,5));}}
