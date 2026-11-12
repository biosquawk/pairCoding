import path from 'node:path';
import { pathToFileURL } from 'node:url';
const [root,tombstone]=process.argv.slice(2);
if(!process.env.PAIRCOACH_IDENTITY_BASELINE)throw Error('Pinned e982 source required');
const {createRuntimeWorkspace}=await import(pathToFileURL(path.join(process.env.PAIRCOACH_IDENTITY_BASELINE,'src/server/runtime-coordinator/RuntimeWorkspace.ts')).href);
const core=await createRuntimeWorkspace({rootPath:root});
if(tombstone==='true'){
  core.session.claimLease('old-empty');
  core.gate.mutate({clientId:'old-empty',sessionId:core.session.state.sessionId,controlEpoch:core.session.state.controlEpoch,actor:'STUDENT',operation:'DELETE',path:'a.ts',baseVersion:1,content:null,newPath:null});
}
const result={projectId:core.workspace.projectId,workspaceVersion:core.workspace.workspaceVersion};core.close();process.stdout.write(JSON.stringify(result)+'\n');
