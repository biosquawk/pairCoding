import { project,hash } from '../client-v2/fixtures';
export const doc=(path='main.txt',content='draft',version=1)=>({path,content,version,contentHash:hash(content),languageId:'plaintext',eol:'LF',utf8Bom:false,readOnly:false});
export function bundle() {
  const p=project();p.files=[{path:'main.txt',kind:'FILE',version:1}];
  return {project:p,session:{sessionId:'s1',projectId:'p1',lifecycle:'READY',workspaceVersion:1,controlEpoch:0,writeOwner:'STUDENT',coachMode:'UNAVAILABLE',cooldownAfterVeto:false,presence:'FOCUSED',aiStatus:'OFF',timer:{status:'STOPPED',elapsedMs:0,limitMs:null,pauseOnHidden:true,manualPaused:false,serverTime:'2026-11-11T21:00:00.000Z'},activeFilePath:'main.txt',interventionId:null,lastServerSeq:0},activeDocument:doc(),proposals:[],lastRun:null,chat:[],report:null};
}
