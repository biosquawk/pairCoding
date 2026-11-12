/** Genuine SIGKILL seams. Docker modeled, production admission/dispatch/journal unmodified. */
import fs from 'node:fs';
import {createPairCoachServer} from '../../src/server/http';
import {FakeDocker} from '../runtime-executor/fixtures';
import {DurableMutationJournal} from '../../src/server/runtime-coordinator/MutationJournal';
const {project,config,prepared,token,marker,daemonFile,boundary}=JSON.parse(process.env.DISPATCH_CHILD!);
const pause=()=>{fs.writeFileSync(marker,boundary);process.kill(process.pid,'SIGSTOP');};
if(boundary==='ADMITTED') {
  const original=DurableMutationJournal.prototype.stageRun;
  DurableMutationJournal.prototype.stageRun=function(...args){original.apply(this,args);pause();};
}
if(boundary==='CLAIMED') {
  const original=DurableMutationJournal.prototype.claimRunDispatch;
  DurableMutationJournal.prototype.claimRunDispatch=function(...args){original.apply(this,args);pause();};
}
const fake=new FakeDocker(),receipt=JSON.parse(fs.readFileSync(prepared+'/receipt.json','utf8'));
const transport={run:async(args:readonly string[])=>{
  if(args[0]==='image')return {exitCode:0,stdout:JSON.stringify([receipt.imageInspect]),stderr:''};
  if(args[0]==='info'&&args[2]==='{{json .}}')return {exitCode:0,stdout:JSON.stringify(receipt.engine),stderr:''};
  const result=await fake.run(args);
  fs.writeFileSync(daemonFile,JSON.stringify({v:fake.v,calls:fake.calls}));
  if(args[0]==='create')pause();
  return result;
}};
const app=createPairCoachServer({port:0,rootPath:project,token,enableExecution:true,runtimeEnvironment:{},runtimeArguments:['--runtime-config',config,'--prepared-runtime',prepared],runtimeTransport:transport});
process.send!({port:await app.listen()});
