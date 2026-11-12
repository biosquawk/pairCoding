/** Isolated NEW SIGKILL boundary, never an actual Docker subprocess. */
import fs from 'node:fs';
import { createPairCoachServer } from '../../src/server/http';
import { FakeDocker } from '../runtime-executor/fixtures';
const {project,config,prepared,token}=JSON.parse(process.env.NETWORK_CHILD!);
const receipt=JSON.parse(fs.readFileSync(prepared+'/receipt.json','utf8')),fake=new FakeDocker();
const transport={run:async(args:readonly string[])=>{
  if(args[0]==='image')return {exitCode:0,stdout:JSON.stringify([receipt.imageInspect]),stderr:''};
  if(args[0]==='info'&&args[2]==='{{json .}}')return {exitCode:0,stdout:JSON.stringify(receipt.engine),stderr:''};
  return fake.run(args);
}};
const app=createPairCoachServer({port:0,rootPath:project,token,enableExecution:true,runtimeEnvironment:{},
  runtimeArguments:['--runtime-config',config,'--prepared-runtime',prepared],runtimeTransport:transport});
process.send!({port:await app.listen()});
