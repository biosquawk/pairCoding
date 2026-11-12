/** NEW actual process-death boundary. Only Docker process observations are UNIT injected. */
import fs from 'node:fs';
import { createPairCoachServer } from '../../src/server/http';
import { FakeDocker } from '../runtime-executor/fixtures';
import { DurableMutationJournal } from '../../src/server/runtime-coordinator/MutationJournal';
import { DurableRunJournal } from '../../src/server/execution/DurableRunJournal';
const {project,config,prepared,token,boundary,marker,daemonFile}=JSON.parse(process.env.RUN_RECOVERY_CHILD!);
const pause=()=>{fs.writeFileSync(marker,boundary);process.kill(process.pid,'SIGSTOP');};
if(boundary==='ADMITTED') {
  const original=DurableMutationJournal.prototype.stageRun;
  DurableMutationJournal.prototype.stageRun=function(...args){original.apply(this,args);pause();};
}
if(['COLLECTED','TERMINAL','REMOVED'].includes(boundary)) {
  const original=DurableRunJournal.prototype.update;
  DurableRunJournal.prototype.update=async function(record){await original.call(this,record);if(record.phase===boundary)pause();};
}
if(boundary==='FINAL') {
  const {RuntimeRunState}=await import('../../src/server/runtime-coordinator/RuntimeRunState');
  const original=RuntimeRunState.prototype.retain;
  RuntimeRunState.prototype.retain=function(...args){original.apply(this,args);if(args[1].finishedAt)pause();};
}
const receipt=JSON.parse(fs.readFileSync(prepared+'/receipt.json','utf8')),fake=new FakeDocker();
const transport={run:async(args:readonly string[])=>{
  if(args[0]==='image')return {exitCode:0,stdout:JSON.stringify([receipt.imageInspect]),stderr:''};
  if(args[0]==='info'&&args[2]==='{{json .}}')return {exitCode:0,stdout:JSON.stringify(receipt.engine),stderr:''};
  const result=await fake.run(args);
  fs.writeFileSync(daemonFile,JSON.stringify({v:fake.v,calls:fake.calls}));
  if(args[0]==='stop'&&boundary==='STOPPED')pause();
  return result;
}};
const app=createPairCoachServer({port:0,rootPath:project,token,enableExecution:true,runtimeEnvironment:{},
  runtimeArguments:['--runtime-config',config,'--prepared-runtime',prepared],runtimeTransport:transport});
process.send!({port:await app.listen()});
