/** Genuine self-SIGKILL at exact production protocol seams; controlled Docker only. */
import path from 'node:path';
import type { TestContext } from 'node:test';
import { executionFixture } from './execution-composition-fixture';
import { DurableMutationJournal } from '../../src/server/runtime-coordinator/MutationJournal';
import { RuntimeRunMutation } from '../../src/server/runtime-coordinator/RuntimeRunMutation';
const boundary=process.argv[2];
const f=await executionFixture({after(){}} as unknown as TestContext);
const request=f.request(),directory=path.join(f.core.workspace.dataDir,'run-mutations');
const journal=new DurableMutationJournal(directory);
const identity={projectId:f.core.workspace.projectId,sessionId:request.sessionId,clientId:request.clientId,requestId:request.requestId,kind:'RUN',payload:request};
const crash=()=>{
  // Console transport is not the persistence proof: parent reopens actual fsynced records.
  process.stdout.write(JSON.stringify({root:f.root,workspace:f.workspace,directory,request,identity,projectId:f.core.workspace.projectId,
    journalDirectory:f.layout.journalDirectory,installationId:f.layout.installationId})+'\n',()=>process.kill(process.pid,'SIGKILL'));
  return new Promise<never>(()=>{});
};
const stage=journal.stageRun.bind(journal);
if(boundary==='ACCEPTED')journal.stageRun=(identity,original)=>{
  stage(identity,original);
  // Synchronous fsync complete, kill before execution.start; stdout flush is synchronous here.
  process.stdout.write(JSON.stringify({root:f.root,workspace:f.workspace,directory,request,identity,projectId:f.core.workspace.projectId,
    journalDirectory:f.layout.journalDirectory,installationId:f.layout.installationId})+'\n');
  process.kill(process.pid,'SIGKILL');throw Error('SIGKILL did not terminate');
};
const mutations=new RuntimeRunMutation(f.core,journal,{start:async(request,admit)=>{
  if(boundary==='RESERVED')return crash();
  const current=await f.execution.start(request,admit);
  if(boundary==='STARTED')return crash();
  return current;
}});
await mutations.execute(request);
throw Error('Requested crash boundary was not reached');
