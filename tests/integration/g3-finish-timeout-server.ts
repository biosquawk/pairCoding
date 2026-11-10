// Explicit 6500ms capture-delay injection; real public finish/persistence, not scaled timing.
import {createPairCoachServer} from '../../src/server/http';
const [rootPath,dataDir,token]=process.argv.slice(2);
const app=createPairCoachServer({rootPath,dataDir,token,port:0,enableCoach:false,enableExecution:true});
let delayed=false;
app.workspace.on('snapshotCheckpoint',e=>{
  if(e.phase!=='SNAPSHOT_FILE_CAPTURED'||delayed)return;delayed=true;
  let captureReadCode='NO_GUARD';
  try { app.workspace.listSnapshots(); } catch(error) { captureReadCode=(error as {code:string}).code; }
  process.send?.({phase:'CAPTURE_PENDING',lifecycle:app.session.state.lifecycle,captureReadCode});
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,6500);
});
const port=await app.listen();process.send?.({port,sessionId:app.session.state.sessionId});
