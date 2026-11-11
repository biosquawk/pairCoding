/** Real POSIX process-group regression, not Codex or native Windows evidence. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {performance} from 'node:perf_hooks';
import {setTimeout as delay} from 'node:timers/promises';
import {CodexCoachProvider} from '../../src/server/coach/CodexProvider';
import type {CoachContext} from '../../src/server/coach/context';
import {workspaceFiles} from '../qa/helpers';

const context:CoachContext={workspaceVersion:1,controlEpoch:1,taskMode:'IMPLEMENTATION',taskFilePath:'task.md',reviewNotesPath:'review.md',activeFilePath:'main.py',timer:{status:'RUNNING',elapsedMs:0,limitMs:null},documents:[],omittedPaths:[],messages:[],lastRun:null,previousInterventions:[]};
for(const [label,abort,stdio,reply] of [
  ['timeout with stdout retained',false,"['ignore',1,'ignore']",false],
  ['abort with stderr retained',true,"['ignore','ignore',2]",false],
  ['complete reply cannot bypass retained-pipe deadline',false,"['ignore',1,2]",true],
] as const)test('Codex exited leader: '+label,async t=>{
  const dirs=await workspaceFiles(t);t.after(()=>dirs.cleanup());
  const sentinel=path.join(dirs.base,'delayed.sentinel'),record=path.join(dirs.base,'lifecycle.json'),exe=path.join(dirs.base,'fake.cjs');
  const childCode=`setTimeout(()=>{require('fs').writeFileSync(${JSON.stringify(sentinel)},'SURVIVED');process.exit(0)},1100)`;
  const output=reply?`process.stdout.write(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:JSON.stringify({decision:{kind:'REPLY',text:'ok'}})}})+'\\n');process.stdout.write(JSON.stringify({type:'turn.completed'})+'\\n');`:'';
  await fs.writeFile(exe,`#!${process.execPath}\nconst fs=require('fs'),cp=require('child_process');process.stdin.resume();process.stdin.on('end',()=>{cp.spawn(process.execPath,['-e',${JSON.stringify(childCode)}],{stdio:${stdio}});fs.writeFileSync(${JSON.stringify(record)},JSON.stringify({pid:process.pid,cwd:process.cwd()}));${output}process.exit(0);});\n`,{mode:0o700});
  const controller=new AbortController(),provider=new CodexCoachProvider(exe,abort?2000:250),start=performance.now();
  const pending=assert.rejects(provider.decide(context,controller.signal),{message:abort?'COACH_CODEX_ABORTED':'COACH_CODEX_TIMEOUT'});
  let r:{pid:number,cwd:string}|undefined;
  for(let i=0;i<100;i++){try{r=JSON.parse(await fs.readFile(record,'utf8'));break;}catch{await delay(10);}}
  assert(r,'leader started');
  // Independently confirm the leader has actually exited before issuing abort.
  let exited=false;
  for(let i=0;i<100;i++){try{process.kill(r.pid,0);await delay(5);}catch{exited=true;break;}}
  assert(exited,'leader exited while its descendant retained the pipe');
  if(abort)controller.abort();
  await pending;
  const elapsedMs=performance.now()-start;
  assert(elapsedMs<750,`bounded rejection: ${elapsedMs}ms`);
  await assert.rejects(fs.stat(path.dirname(r.cwd)),{code:'ENOENT'});
  // Unlike the review probe's immediate check, wait past the child's effect time.
  await delay(1200);
  await assert.rejects(fs.stat(sentinel),{code:'ENOENT'});
  console.log(JSON.stringify({label,elapsedMs,leaderExited:true,delayedSentinelAbsent:true,scratchRemoved:true}));
});
