import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createPairCoachServer } from '../../src/server/http';
const [rootPath,receipt]=process.argv.slice(2),token='http-save-local-only-token';
const app=createPairCoachServer({rootPath,token,port:0,runtimeEnvironment:{},runtimeArguments:['--runtime-config',path.join(path.dirname(rootPath),'missing.json')]});
const port=await app.listen();
const post=async(method:string,url:string,body:unknown)=>{const r=await fetch(`http://127.0.0.1:${port}${url}`,{method,headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify(body)});if(!r.ok) throw Error('HTTP setup '+r.status+' '+await r.text());return r.json();};
const settings={schemaVersion:2,taskFilePath:null,taskMode:'IMPLEMENTATION',reviewNotesPath:'review.md',runProfiles:[],aiConsent:true,contextPatterns:[]};
const p=await post('POST','/api/project/open',{requestId:randomUUID(),clientId:'tab',rootPath,settings});
const request={requestId:randomUUID(),clientId:'tab',sessionId:p.sessionId,expectedWorkspaceVersion:p.workspaceVersion,settings};
const fd=fs.openSync(receipt,'wx',0o600);try{fs.writeFileSync(fd,JSON.stringify({mutation:{projectId:p.projectId,kind:'SAVE',request}}));fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
app.workspace._publishSettingsReceipt=()=>{process.kill(process.pid,'SIGKILL');};
await post('PUT','/api/project/settings',request);throw Error('Expected actual process death after durable authority commit');
