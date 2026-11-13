// Separate process: a synchronous restore must not also block the client's 5s timer.
// ONLY latency/failure is injected. HTTP, WS, WriteGate, backup and disk are real.
import fs from 'node:fs';
import path from 'node:path';
import {createPairCoachServer} from '../../src/server/http';

const [rootPath,dataDir,token,mode]=process.argv.slice(2);
const app=createPairCoachServer({rootPath,dataDir,token,port:0,enableCoach:false});
const port=await app.listen();
const source=app.workspace.createSnapshot('Original',['main.py']);
let checkpoints=0;
app.workspace.on('snapshotCheckpoint',e=>{
  if(e.phase!=='BEFORE_PUBLICATION')return;
  checkpoints++;
  fs.appendFileSync(path.join(dataDir,'probe-checkpoints.txt'),String(checkpoints)+'\n');
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,6500);
  if(mode==='recovery')fs.writeFileSync(path.join(rootPath,'main.py'),'FOREIGN',{flag:'wx'});
});
process.send?.({port,snapshotId:source.snapshotId,sessionId:app.session.state.sessionId});
process.on('message',message=>{if(message==='close')void app.close().then(()=>process.exit(0));});
