import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {readLearningPack,installLearningTask} from '../../src/server/sprint/LearningPack';
import {selectTask,currentAttempt,type SprintState} from '../../src/shared/sprint';
import {allowedSource,requiredFiles} from '../../scripts/verify-source-revision.mjs';
const root=fileURLToPath(new URL('../../learning-packs/java-concurrency/',import.meta.url));
const ids=['01-executor-future','02-countdown-latch','03-completable-combine','04-virtual-thread','05-virtual-executor'];

test('five beginner JAVA_MAIN exercises share exact dependency identity; no reference enters installed/AI source',t=>{
  const pack=readLearningPack(root);
  assert.deepEqual(pack.tasks.map(t=>t.id),ids);
  assert.deepEqual(pack.tasks.map(t=>t.difficulty),[1,2,2,2,3]);
  assert.equal(pack.topics.length,1);assert.equal(pack.topics[0].id,'concurrency');
  const base=fs.mkdtempSync(path.join(os.tmpdir(),'java-material-'));t.after(()=>fs.rmSync(base,{recursive:true,force:true}));
  const pom=fs.readFileSync(path.join(root,'tasks',ids[0],'pom.xml'));
  assert.match(pom.toString(),/<maven.compiler.release>21</);assert.doesNotMatch(pom.toString(),/spring|preview/i);
  const material=fs.readFileSync(path.join(root,'material.md'),'utf8');
  for(const task of pack.tasks){
    assert.equal(task.topicId,'concurrency');assert.equal(task.estimatedMinutes,6);
    assert.deepEqual(fs.readFileSync(path.join(root,task.exercisePath,'pom.xml')),pom);
    const settings=JSON.parse(fs.readFileSync(path.join(root,task.exercisePath,'settings.v2.json'),'utf8'));
    assert.equal(settings.aiConsent,false);
    assert.deepEqual(settings.contextPatterns,['src/main/**/*.java','challenge.md']);
    assert.deepEqual(settings.runProfiles.map((p:any)=>p.task.entry),Array(2).fill({kind:'JAVA_MAIN',className:'demo.ConcurrencyExercise'}));
    const installed=installLearningTask(base,pack,task,root);
    assert.equal(fs.existsSync(path.join(installed,'references')),false);
    const source=path.join(installed,'src/main/java/demo/ConcurrencyExercise.java');
    assert.notDeepEqual(fs.readFileSync(source),fs.readFileSync(path.join(root,'references',task.id,'ConcurrencyExercise.java')));
    fs.writeFileSync(source,'// learner ACK bytes\n');
    assert.equal(installLearningTask(base,pack,task,root,true),installed);
    assert.equal(fs.readFileSync(source,'utf8'),'// learner ACK bytes\n');
    for(const sourceId of task.sourceIds)assert(material.includes(pack.sources.find(s=>s.id===sourceId)!.text));
    for(const relative of ['challenge.md','pom.xml','settings.v2.json','src/main/java/demo/ConcurrencyExercise.java','src/test/java/demo/ConcurrencyExerciseTest.java']){
      const file='learning-packs/java-concurrency/'+task.exercisePath+'/'+relative;
      assert(allowedSource(file));assert(requiredFiles.includes(file));
    }
    const reference='learning-packs/java-concurrency/references/'+task.id+'/ConcurrencyExercise.java';
    assert(allowedSource(reference));assert(requiredFiles.includes(reference));
  }
  for(const name of ['learning-packs/java-concurrency/tasks/private/challenge.md','learning-packs/java-concurrency/tasks/01-executor-future/solution.java','learning-packs/java-concurrency/references/private/ConcurrencyExercise.java','learning-packs/java-concurrency/tasks/01-executor-future/.paircoach/settings.json'])assert.equal(allowedSource(name),false,name);
  assert.equal(readLearningPack().tasks.length,12,'Default mandatory REST unchanged');
});

test('actual curriculum orders five six-minute beginner steps; PASS→Next→Easier returns to first',()=>{
  const pack=readLearningPack(root);assert(pack.tasks.every(t=>t.ready),'Activate only after actual material evidence');
  const s:SprintState={sprintId:'fixture',packId:pack.id,packVersion:pack.version,topics:['concurrency'],startLevel:1,budgetMinutes:30,elapsedMs:0,status:'ACTIVE',activeAttemptId:'none',attempts:[],recommendation:{taskId:null,reason:'START'},requests:[]};
  assert.equal(selectTask(pack,s,'start',1).taskId,ids[0]);
  const add=(id:string)=>{s.activeAttemptId=id;s.attempts.push({attemptId:id,taskId:id,sessionId:id,startedAt:new Date().toISOString(),outcome:'IN_PROGRESS',runs:[{runId:id,inputVersion:1,outcome:'PASSED',testCount:2}],help:false,selfAssessment:null});};
  add(ids[0]);assert.equal(selectTask(pack,s,'next',1).taskId,ids[1]);
  currentAttempt(s).outcome='TESTED';add(ids[1]);
  assert.equal(selectTask(pack,s,'easier',1).taskId,ids[0]);
  for(let i=2;i<ids.length;i++){
    assert.equal(selectTask(pack,s,'next',1).taskId,ids[i]);
    currentAttempt(s).outcome='TESTED';add(ids[i]);
  }
});
