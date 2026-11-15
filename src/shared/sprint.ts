/** Persisted facts, not a model assessment. Old projects omit sprint. */
export interface LearningTask {
  id:string; topicId:string; title:string; difficulty:number; estimatedMinutes:number;
  exercisePath:string; sourceIds:string[]; kind:'IMPLEMENTATION'|'BUGFIX'; ready:boolean;
}
export interface KnowledgeFragment {
  id:string; sourceKind:'AUTHOR_TRAINING'|'USER_MATERIAL'|'REFERENCE';
  sourceTitle:string; section:string; text:string; quote?:string;
}
export interface LearningPack {
  id:string; version:string; title:string; topics:{id:string;title:string}[];
  tasks:LearningTask[]; sources:KnowledgeFragment[];
}
export type SprintAction = 'start'|'new'|'next'|'easier'|'harder'|'deeper'|'bugfix'|'example'|'selfAssess'|'resume'|'topic'|'extend';
export interface SprintRun {
  runId:string; inputVersion:number; outcome:'PASSED'|'FAILED'|'UNKNOWN'; testCount:number|null;
}
export type AttemptOutcome = 'IN_PROGRESS'|'TESTED'|'ASSISTED'|'DECLARED_SKIP'|'INTERRUPTED'|'REVIEW';
export interface SprintAttempt {
  attemptId:string; taskId:string; sessionId:string; startedAt:string;
  outcome:AttemptOutcome; runs:SprintRun[]; help:boolean; selfAssessment:number|null;
}
export interface SprintState {
  previous?:SprintState[];
  sprintId:string; packId:string; packVersion:string; topics:string[];
  startLevel:number; budgetMinutes:number; elapsedMs:number; status:'ACTIVE'|'SUSPENDED'|'FINISHED';
  activeAttemptId:string; attempts:SprintAttempt[];
  recommendation:{taskId:string|null;reason:string};
  requests:{requestId:string;payloadHash:string}[];
}
export interface SprintView {pack:LearningPack;sprint:SprintState|null;currentVersion:number|null}
export interface SprintCommand {
  requestId:string;clientId:string;projectId:string;sessionId:string|null;
  expectedSprintId:string|null;expectedAttemptId:string|null;action:SprintAction;
  topics?:string[];level?:number;budgetMinutes?:number;selfAssessment?:number;topicId?:string;
}

/** A deterministic, bounded selection over available tasks only. No AI or IO. */
export function selectTask(pack:LearningPack,s:SprintState,action:SprintAction,version:number|null):SprintState['recommendation'] {
  const attempt=s.attempts.find(a=>a.attemptId===s.activeAttemptId);
  const current=pack.tasks.find(t=>t.id===attempt?.taskId);
  const visited=new Set(s.attempts.filter(a=>a.outcome!=='IN_PROGRESS').map(a=>a.taskId));
  let candidates=pack.tasks.filter(t=>t.ready && s.topics.includes(t.topicId) && t.id!==current?.id);
  const same=candidates.filter(t=>t.topicId===current?.topicId);
  const passed=attempt?.runs.some(r=>r.outcome==='PASSED'&&r.inputVersion===version);
  const failures=attempt?.runs.filter(r=>r.outcome==='FAILED'&&r.inputVersion===version).length??0;
  const harder=action==='harder'||(action==='next'&&passed&&(attempt?.selfAssessment??3)>=4);
  const easier=action==='easier'||(action==='next'&&!passed&&failures>=2);
  if(easier) {
    candidates=same.filter(t=>t.difficulty<(current?.difficulty??s.startLevel));
    if(!candidates.length)return {taskId:null,reason:'NO_EASIER_HINT_AVAILABLE'};
  } else if(harder) {
    const higher=same.filter(t=>t.difficulty>(current?.difficulty??s.startLevel));
    candidates=higher.length?higher:candidates.filter(t=>t.topicId!==current?.topicId&&!visited.has(t.id));
  } else if(action==='deeper') candidates=same.filter(t=>!visited.has(t.id));
  else if(action==='bugfix') candidates=candidates.filter(t=>t.kind==='BUGFIX'&&!visited.has(t.id));
  else {
    candidates=candidates.filter(t=>!visited.has(t.id));
    if(same.some(t=>!visited.has(t.id)))candidates=candidates.filter(t=>t.topicId===current?.topicId);
  }
  const remaining=s.budgetMinutes-s.elapsedMs/60000;
  const fitting=candidates.filter(t=>t.estimatedMinutes<=remaining);
  if(!fitting.length)return {taskId:null,reason:candidates.length?'BUDGET_SUMMARY_OR_CONTINUE':'NO_AVAILABLE_TASK'};
  const target=current?.difficulty??s.startLevel;
  fitting.sort((a,b)=> {
    if(easier)return b.difficulty-a.difficulty||a.id.localeCompare(b.id);
    if(harder)return a.difficulty-b.difficulty||a.id.localeCompare(b.id);
    return Math.abs(a.difficulty-target)-Math.abs(b.difficulty-target)||a.id.localeCompare(b.id);
  });
  return {taskId:fitting[0].id,reason:easier?'EASIER':harder?'HARDER':passed?'PASSED_NEXT':'AVAILABLE_IN_SELECTED_TOPICS'};
}
export function currentAttempt(s:SprintState):SprintAttempt {
  const a=s.attempts.find(a=>a.attemptId===s.activeAttemptId);
  if(!a)throw Error('SPRINT_ATTEMPT_MISSING');
  return a;
}
export function closeAttempt(a:SprintAttempt,version:number,action:SprintAction):void {
  const tested=a.runs.some(r=>r.outcome==='PASSED'&&r.inputVersion===version);
  a.outcome=tested?(a.help?'ASSISTED':'TESTED'):action==='harder'?'DECLARED_SKIP':a.runs.some(r=>r.outcome==='FAILED')?'REVIEW':'INTERRUPTED';
}
/** Reject corrupt state on durable reopen. IO identities are checked by the server. */
export function validSprint(value:unknown,depth=0):value is SprintState {
  if(!value||typeof value!=='object'||Array.isArray(value))return false;
  const s=value as SprintState;
  if(s.previous!==undefined&&(!Array.isArray(s.previous)||s.previous.length>20||depth>0||!s.previous.every(v=>validSprint(v,depth+1))))return false;
  const id=(v:unknown)=>typeof v==='string'&&/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(v);
  const integer=(v:unknown,min:number,max:number)=>Number.isSafeInteger(v)&&Number(v)>=min&&Number(v)<=max;
  if(!id(s.sprintId)||!id(s.packId)||!id(s.packVersion)||!id(s.activeAttemptId)||
    !['ACTIVE','SUSPENDED','FINISHED'].includes(s.status)||!integer(s.startLevel,1,5)||!integer(s.budgetMinutes,1,1440)||
    !integer(s.elapsedMs,0,Number.MAX_SAFE_INTEGER)||!Array.isArray(s.topics)||!s.topics.length||s.topics.length>20||
    !s.topics.every(id)||new Set(s.topics).size!==s.topics.length||!Array.isArray(s.attempts)||!s.attempts.length||s.attempts.length>1000||
    !Array.isArray(s.requests)||s.requests.length>1000||s.requests.some(r=>!r||!id(r.requestId)||!(/^[a-f0-9]{64}$/).test(r.payloadHash)))return false;
  if(!s.recommendation||!(s.recommendation.taskId===null||id(s.recommendation.taskId))||typeof s.recommendation.reason!=='string'||s.recommendation.reason.length>200)return false;
  if(new Set(s.attempts.map(a=>a.attemptId)).size!==s.attempts.length)return false;
  return s.attempts.some(a=>a.attemptId===s.activeAttemptId)&&s.attempts.every(a=>a&&id(a.attemptId)&&id(a.taskId)&&id(a.sessionId)&&
    typeof a.startedAt==='string'&&Number.isFinite(Date.parse(a.startedAt))&&typeof a.help==='boolean'&&
    ['IN_PROGRESS','TESTED','ASSISTED','DECLARED_SKIP','INTERRUPTED','REVIEW'].includes(a.outcome)&&
    (a.selfAssessment===null||integer(a.selfAssessment,1,5))&&Array.isArray(a.runs)&&a.runs.length<=1000&&
    new Set(a.runs.map(r=>r.runId)).size===a.runs.length&&a.runs.every(r=>r&&id(r.runId)&&integer(r.inputVersion,0,Number.MAX_SAFE_INTEGER)&&
      ['PASSED','FAILED','UNKNOWN'].includes(r.outcome)&&(r.testCount===null||integer(r.testCount,0,Number.MAX_SAFE_INTEGER))));
}
