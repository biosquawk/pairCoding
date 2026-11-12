/** NEW genuine process death; only daemon observations are controlled UNIT transport. */
import fs from 'node:fs';
import { createPairCoachServer } from '../../src/server/http';
import { DurableRunJournal, type JournalRecord } from '../../src/server/execution/DurableRunJournal';
import { FakeDocker } from '../runtime-executor/fixtures';
const {project,config,prepared,token,boundary,marker,daemonFile}=JSON.parse(process.env.UNSTARTED_CHILD!);
const pause=()=>{fs.writeFileSync(marker,boundary);process.kill(process.pid,'SIGSTOP');};
const recover=DurableRunJournal.prototype.withUnstartedRecovery;
DurableRunJournal.prototype.withUnstartedRecovery=function<T>(record:JournalRecord,action:(save:()=>Promise<void>)=>Promise<T>):Promise<T>{return recover.call(this,record,save=>action(async()=>{
  await save();
  if(boundary==='REVOKED'&&record.startDispatch==='REVOKED'&&!record.unstartedCancellation ||
     boundary==='EVIDENCE'&&record.unstartedCancellation?.confirmedAt===null || boundary==='REMOVED'&&record.phase==='REMOVED')pause();
})) as Promise<T>;};
const receipt=JSON.parse(fs.readFileSync(prepared+'/receipt.json','utf8')),fake=new FakeDocker();let lostInspect=0;
const transport={run:async(args:readonly string[])=>{
  if(args[0]==='image')return {exitCode:0,stdout:JSON.stringify([receipt.imageInspect]),stderr:''};
  if(args[0]==='info'&&args[2]==='{{json .}}')return {exitCode:0,stdout:JSON.stringify(receipt.engine),stderr:''};
  if(args[0]==='container'&&lostInspect){lostInspect--;throw Error('Lost create readback');}
  const result=await fake.run(args);
  if(args[0]==='create')fake.v.State.StartedAt='0001-01-01T00:00:00Z';
  fs.writeFileSync(daemonFile,JSON.stringify({v:fake.v,calls:fake.calls}));
  if(args[0]==='create'){
    if(boundary==='CREATED')pause();
    lostInspect=1;throw Error('Lost create response');
  }
  return result;
}};
const app=createPairCoachServer({port:0,rootPath:project,token,enableExecution:true,runtimeEnvironment:{},
  runtimeArguments:['--runtime-config',config,'--prepared-runtime',prepared],runtimeTransport:transport});
process.send!({port:await app.listen()});
