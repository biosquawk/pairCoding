import test from 'node:test';
import assert from 'node:assert/strict';
import {selectTask,closeAttempt,validSprint,type SprintState} from '../../src/shared/sprint';
import {readLearningPack} from '../../src/server/sprint/LearningPack';
const pack=readLearningPack();pack.tasks.forEach(t=>t.ready=true);
function state():SprintState {return {sprintId:'s',packId:pack.id,packVersion:pack.version,topics:['http'],startLevel:1,budgetMinutes:60,
 elapsedMs:0,status:'ACTIVE',activeAttemptId:'a',attempts:[{attemptId:'a',taskId:'create-item',sessionId:'sess',startedAt:new Date().toISOString(),outcome:'IN_PROGRESS',runs:[],help:false,selfAssessment:null}],
 recommendation:{taskId:null,reason:'START'},requests:[]};}
test('TEST201 deterministic easier/harder, no easier, no available, budget and unverified task exclusion',()=>{
 const s=state();assert.equal(selectTask(pack,s,'easier',1).taskId,'get-item');assert.equal(selectTask(pack,s,'harder',1).taskId,'update-item');
 assert.deepEqual(selectTask(pack,s,'harder',1),selectTask(pack,s,'harder',1));
 s.attempts[0].taskId='get-item';assert.equal(selectTask(pack,s,'easier',1).reason,'NO_EASIER_HINT_AVAILABLE');
 s.budgetMinutes=1;assert.equal(selectTask(pack,s,'next',1).reason,'BUDGET_SUMMARY_OR_CONTINUE');
 const unavailable=structuredClone(pack);unavailable.tasks.forEach(t=>t.ready=false);assert.equal(selectTask(unavailable,s,'next',1).reason,'NO_AVAILABLE_TASK');
});
test('TEST201 skips never become PASSED; stale code PASS is not current; initial red starter not skill judgment',()=>{
 const s=state(),a=s.attempts[0];a.runs=[{runId:'old',inputVersion:1,outcome:'PASSED',testCount:1}];a.selfAssessment=5;
 assert.equal(selectTask(pack,s,'next',2).reason,'AVAILABLE_IN_SELECTED_TOPICS');
 closeAttempt(a,2,'harder');assert.equal(a.outcome,'DECLARED_SKIP');
 a.help=true;closeAttempt(a,1,'next');assert.equal(a.outcome,'ASSISTED');
 a.runs=[{runId:'starter',inputVersion:1,outcome:'FAILED',testCount:1}];assert.notEqual(selectTask(pack,s,'next',1).reason,'EASIER');
 a.runs.push({runId:'fail2',inputVersion:1,outcome:'FAILED',testCount:1});assert.equal(selectTask(pack,s,'next',1).reason,'EASIER');
});
test('TEST201 corrupt persistence identities, duplicate runId, invalid confidence rejected; old store may omit sprint',()=>{
 const s=state();assert.equal(validSprint(s),true);
 for(const change of [{elapsedMs:-1},{activeAttemptId:'missing'},{budgetMinutes:0},{topics:['../x']},{requests:[{requestId:'r',payloadHash:'fake'}]}])assert.equal(validSprint({...s,...change}),false);
 s.attempts[0].runs=[{runId:'r',inputVersion:1,outcome:'PASSED',testCount:1},{runId:'r',inputVersion:2,outcome:'PASSED',testCount:1}];assert.equal(validSprint(s),false);
});
