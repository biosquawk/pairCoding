/** Real provider child stdin and actual CoachAdapter, not real Codex inference. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {coreFixture,workspaceFiles} from '../qa/helpers';
import {CodexCoachProvider} from '../../src/server/coach/CodexProvider';
import {CoachAdapter} from '../../src/server/CoachAdapter';
import {readLearningPack} from '../../src/server/sprint/LearningPack';
import {sprintContext} from '../../src/server/sprint/sprintFacts';
import {buildContext} from '../../src/server/coach/context';
import type {SprintState} from '../../src/shared/sprint';
const pack=readLearningPack(),s:SprintState={sprintId:'s',packId:pack.id,packVersion:pack.version,topics:['http'],startLevel:1,budgetMinutes:45,elapsedMs:0,status:'ACTIVE',activeAttemptId:'a',
 attempts:[{attemptId:'a',taskId:'get-item',sessionId:'sess',startedAt:new Date().toISOString(),outcome:'IN_PROGRESS',runs:[],help:false,selfAssessment:null}],requests:[],recommendation:{taskId:null,reason:'START'}};
const sprint=sprintContext(pack,s,1)!;
async function until(predicate:()=>boolean) {const end=Date.now()+4000;while(!predicate()){assert.ok(Date.now()<end);await new Promise(r=>setTimeout(r,5));}}
test('TEST201 exact admitted fragment and candidates actually reach CodexProvider stdin, no references/future fields',async t=>{
 const f=await workspaceFiles(t),record=path.join(f.base,'received.json'),exe=path.join(f.base,'fake-codex.cjs');t.after(f.cleanup);
 fs.writeFileSync(exe,`#!${process.execPath}
const fs=require('node:fs');let input='';process.stdin.on('data',s=>input+=s);process.stdin.on('end',()=>{
fs.writeFileSync(${JSON.stringify(record)},JSON.stringify({input,args:process.argv.slice(2)}));
for(const e of [{type:'thread.started',thread_id:'synthetic'},{type:'turn.started'},{type:'item.completed',item:{type:'agent_message',text:JSON.stringify({decision:{kind:'REPLY',text:'Current material received.'}})}},{type:'turn.completed',usage:{input_tokens:1,output_tokens:1}}])process.stdout.write(JSON.stringify(e)+'\\n');
});`,{mode:0o700});
 const ctx:any={workspaceVersion:1,controlEpoch:1,taskMode:'IMPLEMENTATION',taskFilePath:'challenge.md',reviewNotesPath:'review.md',activeFilePath:null,timer:{status:'RUNNING',elapsedMs:1,limitMs:null},documents:[],omittedPaths:[],messages:[],lastRun:null,previousInterventions:[],sprint:{...sprint,reference:'PRIVATE_REFERENCE',sources:sprint.sources.map(source=>({...source,path:'PRIVATE_PATH'}))}};
 const provider=new CodexCoachProvider(exe);await provider.decide(ctx,new AbortController().signal);
 const captured=JSON.parse(fs.readFileSync(record,'utf8')),received=JSON.parse(captured.input);
 assert.ok(captured.args.some((a:string)=>a.startsWith('developer_instructions=')&&a.includes('attemptId')&&a.includes('verbatim in the supplied fragment')));
 assert.deepEqual(received.sprint.sources,sprint.sources);assert.equal(received.sprint.attemptId,'a');
 assert.doesNotMatch(JSON.stringify(received),/PRIVATE_REFERENCE|PRIVATE_PATH|references|ApiApplication.java/);
});
for(const unknown of [false,true])test('TEST201 admitted source IDs: '+(unknown?'unknown rejected':'real fragment citation selected by application'),async t=>{
 const f=await coreFixture(t,{'main.py':'value = 1\n'});f.workspace.updateSettings({...f.workspace.settings,aiConsent:true,contextPatterns:['*.py']});f.session.start(null,false);
 const events:{type:string;payload:any}[]=[];
 const adapter=new CoachAdapter({...f,emit:(type,payload)=>events.push({type,payload}),onProposal(){},contextExtras:()=>({sprint}),
  provider:{name:'controlled',mode:'INJECTED',decide:async ctx=>{
    assert.equal(ctx.sprint?.sources[0].id,sprint.sources[0].id);
    assert.ok(ctx.allowedEvidenceIds?.includes(sprint.sources[0].id));
    return {kind:'HINT',severity:'NEUTRAL',text:'Check the HTTP contract.',path:null,documentVersion:null,range:null,showPointer:false,evidenceIds:[unknown?'invented-source':sprint.sources[0].id]};
  }}});t.after(()=>adapter.close());
 adapter.trigger('CHAT',{messageId:'student-1',author:'STUDENT',text:'Explain this concept.',createdAt:new Date().toISOString()});
 await until(()=>events.some(e=>['COACH_HINT_BUBBLE','CHAT_REPLY','ERROR'].includes(e.type)));
 if(unknown){assert.equal(events.some(e=>e.type==='COACH_HINT_BUBBLE'),false);assert.equal(events.find(e=>e.type==='ERROR')?.payload.code,'COACH_RESPONSE_REJECTED');}
 else {
  const hint=events.find(e=>e.type==='COACH_HINT_BUBBLE');assert.ok(hint);assert.equal(hint.payload.text.length<=400,true);
  const citation=events.find(e=>e.type==='CHAT_REPLY'&&e.payload.text.includes(sprint.sources[0].quote!));assert.ok(citation);assert.ok(sprint.sources[0].text.includes(sprint.sources[0].quote!));
 }
});
