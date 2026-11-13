/** Real subprocesses implementing only the Codex JSONL protocol. NOT real AI evidence. */
import test, {type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {CodexCoachProvider,CODEX_COACH_SCHEMA} from '../../src/server/coach/CodexProvider';
import {defaultCoachProvider} from '../../src/server/coach/provider';
import {parseCoachDecision,COACH_DECISION_SCHEMA} from '../../src/server/coach/schema';
import type {CoachContext} from '../../src/server/coach/context';
import {workspaceFiles} from '../qa/helpers';

const context:CoachContext={workspaceVersion:4,controlEpoch:2,taskMode:'IMPLEMENTATION',taskFilePath:'task.md',reviewNotesPath:'review.md',activeFilePath:'main.py',timer:{status:'RUNNING',elapsedMs:100,limitMs:null},documents:[{path:'main.py',version:2,content:'def preview_sum(a,b):\n    return a-b\n'}],omittedPaths:[],messages:[{messageId:'student-1',author:'STUDENT',text:'Dlaczego suma jest błędna?',createdAt:'2026-11-10T00:00:00.000Z'}],lastRun:null,previousInterventions:[]};
async function fake(t:TestContext,body:string,timeoutMs=5000) {
  const dirs=await workspaceFiles(t),exe=path.join(dirs.base,'fake codex.cjs'),record=path.join(dirs.base,'record.json');
  // Linux test fixture only. Production Windows uses native codex.exe, never shell.
  const source=`#!${process.execPath}\nconst fs=require('node:fs');const cp=require('node:child_process');const record=${JSON.stringify(record)};let input='';process.stdin.setEncoding('utf8');process.stdin.on('data',s=>input+=s);process.stdin.on('end',()=>{const argv=process.argv.slice(2);fs.writeFileSync(${JSON.stringify(record)},JSON.stringify({pid:process.pid,cwd:process.cwd(),entries:fs.readdirSync(process.cwd()),argv,input,env:process.env,schema:JSON.parse(fs.readFileSync(argv[argv.indexOf('--output-schema')+1],'utf8'))}));const emit=v=>process.stdout.write(JSON.stringify(v)+'\\n');${body}\n});\n`;
  await fs.writeFile(exe,source,{mode:0o700});
  let closeOwner: (()=>Promise<void>) | undefined;
  t.after(async()=>{try {await closeOwner?.();} finally {await dirs.cleanup();}});
  return {...dirs,closeBeforeCleanup(close:()=>Promise<void>){closeOwner=close;},record,provider:new CodexCoachProvider(exe,timeoutMs),read:async()=>JSON.parse(await fs.readFile(record,'utf8'))};
}
const success=`emit({type:'thread.started',thread_id:'synthetic'});emit({type:'turn.started'});emit({type:'item.completed',item:{type:'agent_message',text:JSON.stringify({decision:{kind:'REPLY',text:'preview_sum odejmuje zamiast dodawać.'}})}});emit({type:'turn.completed',usage:{input_tokens:1,output_tokens:1}});`;
async function until<T>(read:()=>Promise<T>) {
  for(let i=0;i<100;i++){try{return await read();}catch{await delay(10);}}throw Error('fixture not ready');
}

test('Codex fakeCLI success: fixed argv, copied isolated character cwd, filtered env and context only stdin; scratch removed',async t=>{
  const f=await fake(t,success);
  const previous=process.env.PAIRCOACH_TOKEN,key=process.env.GEMINI_API_KEY;
  process.env.PAIRCOACH_TOKEN='PRIVATE_HTTP_TOKEN';process.env.GEMINI_API_KEY='PRIVATE_GEMINI_KEY';
  t.after(()=>{if(previous===undefined)delete process.env.PAIRCOACH_TOKEN;else process.env.PAIRCOACH_TOKEN=previous;if(key===undefined)delete process.env.GEMINI_API_KEY;else process.env.GEMINI_API_KEY=key;});
  const dirty={...context,rootPath:'PRIVATE_ROOT',future:'PRIVATE_FUTURE',lastRun:{runId:'run-1',mode:'RUN_MAIN',status:'SUCCEEDED',exitCode:0,workspaceVersionAtStart:4,workspaceChangedDuringRun:false,testOutcome:'NOT_APPLICABLE',testCount:null,startedAt:'s',finishedAt:'e',outputTail:'PRIVATE_STDOUT'}} as any;
  assert.deepEqual(await f.provider.decide(dirty,new AbortController().signal),{kind:'REPLY',text:'preview_sum odejmuje zamiast dodawać.'});
  const r=await f.read();assert.deepEqual(r.entries.sort(),['.agents','AGENTS.md']);assert.notEqual(r.cwd,process.cwd());assert.equal(r.cwd.startsWith(f.rootPath+path.sep),false);
  assert.equal(r.argv[0],'exec');for(const a of ['--ephemeral','--ignore-user-config','--ignore-rules','--skip-git-repo-check','--json'])assert(r.argv.includes(a));
  assert.equal(r.argv[r.argv.indexOf('--sandbox')+1],'read-only');assert.equal(r.argv.at(-1),'-');
  for(const c of ['mcp_servers={}','web_search="disabled"','project_doc_max_bytes=32768','skills.include_instructions=true','features.shell_tool=false','features.apps=false','features.plugins=false','features.hooks=false'])assert(r.argv.includes(c));
  const sent=JSON.parse(r.input);assert.equal(sent.documents[0].content,context.documents[0].content);assert.equal(sent.messages[0].text,context.messages[0].text);assert.equal(sent.lastRun.runId,'run-1');
  for(const privateValue of ['PRIVATE_HTTP_TOKEN','PRIVATE_GEMINI_KEY','PRIVATE_ROOT','PRIVATE_FUTURE','PRIVATE_STDOUT'])assert.equal(JSON.stringify(r.argv).includes(privateValue)||r.input.includes(privateValue)||JSON.stringify(r.env).includes(privateValue),false);
  assert.deepEqual(r.schema,CODEX_COACH_SCHEMA);await assert.rejects(fs.stat(path.dirname(r.cwd)),{code:'ENOENT'});
});

for(const [label,body,code] of [
  ['tool event',`emit({type:'item.started',item:{type:'command_execution',command:'forbidden'}});setInterval(()=>{},1000);`,'COACH_CODEX_TOOL_EVENT'],
  ['malformed JSON',`process.stdout.write('NOT_JSON\\n');setInterval(()=>{},1000);`,'COACH_CODEX_INVALID_RESPONSE'],
  ['extra wrapper field',`emit({type:'item.completed',item:{type:'agent_message',text:'{"decision":{"kind":"REPLY","text":"ok"},"extra":true}'}});`,'COACH_CODEX_INVALID_RESPONSE'],
  ['invalid decision',`emit({type:'item.completed',item:{type:'agent_message',text:'{"decision":{"kind":"EDIT","path":"../../foreign"}}'}});`,'COACH_CODEX_INVALID_RESPONSE'],
  ['stdout bound',`process.stdout.write('x'.repeat(524289));setInterval(()=>{},1000);`,'COACH_CODEX_OUTPUT_LIMIT'],
  ['stderr bound',`process.stderr.write('x'.repeat(65537));setInterval(()=>{},1000);`,'COACH_CODEX_OUTPUT_LIMIT'],
  ['missing completion',`emit({type:'thread.started'});`,'COACH_CODEX_INCOMPLETE'],
  ['nonzero exit',success+'process.exitCode=2;','COACH_CODEX_INCOMPLETE'],
  ['unexpected event',`emit({type:'future.tool'});setInterval(()=>{},1000);`,'COACH_CODEX_UNEXPECTED_EVENT'],
] as const)test('Codex fakeCLI rejects '+label+' and removes scratch',async t=>{
  const f=await fake(t,body);await assert.rejects(f.provider.decide(context,new AbortController().signal),{message:code});
  const r=await f.read();await assert.rejects(fs.stat(path.dirname(r.cwd)),{code:'ENOENT'});
});

test('Codex fakeCLI AbortSignal kills own process tree before scratch cleanup; no delayed child sentinel',async t=>{
  const f=await fake(t,`const child=cp.spawn(process.execPath,['-e',"setTimeout(()=>require('fs').writeFileSync(process.argv[1],'BAD'),1200)",record+'.sentinel'],{stdio:'ignore'});fs.writeFileSync(${JSON.stringify('child.pid')},String(child.pid));setInterval(()=>{},1000);`);
  const controller=new AbortController(),pending=f.provider.decide(context,controller.signal);
  // Attach immediately: a rejection is the expected completion, never an unhandled error.
  const rejected=assert.rejects(pending,{message:'COACH_CODEX_ABORTED'});
  const r=await until(f.read);await until(()=>fs.readFile(path.join(r.cwd,'child.pid')));controller.abort();await rejected;
  await delay(1400);await assert.rejects(fs.stat(f.record+'.sentinel'),{code:'ENOENT'});await assert.rejects(fs.stat(path.dirname(r.cwd)),{code:'ENOENT'});
});

test('Codex fakeCLI timeout and already-aborted input fail closed',async t=>{
  const f=await fake(t,'setInterval(()=>{},1000);',150);
  await assert.rejects(f.provider.decide(context,new AbortController().signal),{message:'COACH_CODEX_TIMEOUT'});
  const r=await f.read();await assert.rejects(fs.stat(path.dirname(r.cwd)),{code:'ENOENT'});
  const c=new AbortController();c.abort();await assert.rejects(f.provider.decide(context,c.signal),{name:'AbortError'});
});

test('Codex schema preserves original Ajv oracle and provider selection preserves Gemini/fallback',async t=>{
  assert('oneOf'in COACH_DECISION_SCHEMA);assert.equal(JSON.stringify(CODEX_COACH_SCHEMA).includes('oneOf'),false);assert.equal(JSON.stringify(CODEX_COACH_SCHEMA).includes('(?!'),false);
  assert.throws(()=>parseCoachDecision({kind:'HINT',severity:'WARNING',text:'x',path:'../foreign',documentVersion:1,range:null,showPointer:false,evidenceIds:[]}));
  const selected=process.env.PAIRCOACH_COACH_PROVIDER,key=process.env.GEMINI_API_KEY;
  t.after(()=>{if(selected===undefined)delete process.env.PAIRCOACH_COACH_PROVIDER;else process.env.PAIRCOACH_COACH_PROVIDER=selected;if(key===undefined)delete process.env.GEMINI_API_KEY;else process.env.GEMINI_API_KEY=key;});
  process.env.PAIRCOACH_COACH_PROVIDER='codex';assert.equal(defaultCoachProvider().mode,'CODEX');
  process.env.PAIRCOACH_COACH_PROVIDER='gemini';process.env.GEMINI_API_KEY='synthetic';assert.equal(defaultCoachProvider().mode,'GEMINI');
  delete process.env.PAIRCOACH_COACH_PROVIDER;delete process.env.GEMINI_API_KEY;assert.equal(defaultCoachProvider().mode,'LOCAL_FALLBACK');
  await assert.rejects(new CodexCoachProvider('relative.cmd').decide(context,new AbortController().signal),{message:'COACH_CODEX_ABSOLUTE_EXE_REQUIRED'});
});

test('Codex selection reaches real backend/WS consented chat via fakeCLI, not a provider injection',async t=>{
  const {createPairCoachServer}=await import('../../src/server/http');
  const {Peer,id,settings}=await import('../qa/helpers');
  const f=await fake(t,success);
  await fs.writeFile(path.join(f.rootPath,'main.py'),context.documents[0].content);
  const selected=process.env.PAIRCOACH_COACH_PROVIDER,exe=process.env.PAIRCOACH_CODEX_EXE;
  process.env.PAIRCOACH_COACH_PROVIDER='codex';process.env.PAIRCOACH_CODEX_EXE=path.join(f.base,'fake codex.cjs');
  t.after(()=>{if(selected===undefined)delete process.env.PAIRCOACH_COACH_PROVIDER;else process.env.PAIRCOACH_COACH_PROVIDER=selected;if(exe===undefined)delete process.env.PAIRCOACH_CODEX_EXE;else process.env.PAIRCOACH_CODEX_EXE=exe;});
  const token='backend-'+id(),app=createPairCoachServer({rootPath:f.rootPath,dataDir:path.join(f.rootPath,'.paircoach'),token,port:0,enableCoach:true});
  const port=await app.listen(),baseURL=`http://127.0.0.1:${port}`,clientId=id(),sessionId=app.session.state.sessionId,peers=new Set<{close():void}>();
  f.closeBeforeCleanup(async()=>{for(const peer of peers)peer.close();await app.close();});
  const peer=new Peer({port,baseURL,clientId,sessionId,token,peers} as any);await peer.connect();
  async function http(method:string,url:string,body:unknown){const r=await fetch(baseURL+url,{method,headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify(body)});return {status:r.status,body:await r.json()};}
  const command=()=>({requestId:id(),clientId,sessionId});
  assert.equal((await http('POST','/api/session/start',{...command(),limitMs:null,pauseOnHidden:true})).status,200);
  await peer.ack(peer.send('CHAT_MESSAGE',{text:'Consent OFF must not run CLI',path:null,documentVersion:null,selection:null}));
  await delay(30);await assert.rejects(fs.stat(f.record),{code:'ENOENT'});
  assert.equal((await http('PUT','/api/project/settings',{...command(),expectedWorkspaceVersion:app.workspace.workspaceVersion,settings:{...settings,schemaVersion:2,aiConsent:true}})).status,200);
  await peer.ack(peer.send('VIEW_CHANGED',{path:'main.py',documentVersion:1,cursor:{line:1,column:1},selection:null}));
  await peer.ack(peer.send('CHAT_MESSAGE',{text:'Dlaczego preview_sum odejmuje zamiast dodawać?',path:null,documentVersion:null,selection:null}));
  const reply=await peer.take(m=>m.type==='CHAT_REPLY'&&m.payload.text.includes('preview_sum'));
  assert(reply.payload.text.includes('odejmuje'));const record=await f.read();const sent=JSON.parse(record.input);
  assert(sent.documents.some((d:any)=>d.path==='main.py'&&d.content.includes('return a-b')));
  assert(sent.messages.some((m:any)=>m.text.includes('Dlaczego preview_sum')));assert.equal(record.env.PAIRCOACH_TOKEN,undefined);
  peer.assertProtocol();
});

test('Codex report uses report schema/instruction and preserves bounded isolated transport',async t=>{
  const f=await fake(t,`emit({type:'turn.started'});emit({type:'item.completed',item:{type:'agent_message',text:JSON.stringify({markdown:'# Podsumowanie\\nTesty: 3 zaliczone.'})}});emit({type:'turn.completed'});`);
  const result=await f.provider.generateReport({aiConsent:true,runs:[{testCount:3,testOutcome:'PASSED'}]},'REPORT_INSTRUCTION',new AbortController().signal);
  assert.equal(result,'# Podsumowanie\nTesty: 3 zaliczone.');
  const r=await f.read();
  assert.deepEqual(r.schema.required,['markdown']);
  assert(r.argv.some((a:string)=>a.includes('developer_instructions=')&&a.includes('REPORT_INSTRUCTION')));
  assert.equal(JSON.parse(r.input).runs[0].testCount,3);
  assert.equal(r.env.GEMINI_API_KEY,undefined);
  assert.deepEqual(r.entries.sort(),['.agents','AGENTS.md']);
  await assert.rejects(fs.stat(r.cwd));
});

test('public Finish selects Codex report without Gemini key and filters private context',async t=>{
  const {createPairCoachServer}=await import('../../src/server/http');
  const {Peer,settings}=await import('../qa/helpers');
  const f=await fake(t,`emit({type:'turn.started'});emit({type:'item.completed',item:{type:'agent_message',text:JSON.stringify({markdown:'# Raport AI Codex\\nZachowano kod próby.'})}});emit({type:'turn.completed'});`);
  await fs.writeFile(path.join(f.rootPath,'main.js'),'module.exports = 0;');
  await fs.writeFile(path.join(f.rootPath,'.env'),'NEVER_SEND_PRIVATE_FILE');
  const old={provider:process.env.PAIRCOACH_COACH_PROVIDER,exe:process.env.PAIRCOACH_CODEX_EXE,key:process.env.GEMINI_API_KEY};
  process.env.PAIRCOACH_COACH_PROVIDER='codex';process.env.PAIRCOACH_CODEX_EXE=path.join(f.base,'fake codex.cjs');delete process.env.GEMINI_API_KEY;
  t.after(()=>{for(const [key,value] of Object.entries({PAIRCOACH_COACH_PROVIDER:old.provider,PAIRCOACH_CODEX_EXE:old.exe,GEMINI_API_KEY:old.key})){if(value===undefined)delete process.env[key];else process.env[key]=value;}});
  const token='PRIVATE_TEST_HTTP_TOKEN';
  const app=createPairCoachServer({...f,dataDir:path.join(f.rootPath,'.paircoach'),port:0,token,enableCoach:false,enableExecution:true});
  const peers=new Set<{close():void}>();
  f.closeBeforeCleanup(async()=>{for(const peer of peers)peer.close();await app.close();});
  const port=await app.listen();
  const state=app.session.getSession(),clientId='report-client';assert(app.session.claimLease(clientId));
  const peer=new Peer({port,baseURL:`http://127.0.0.1:${port}`,clientId,sessionId:state.sessionId,token,peers} as any);await peer.connect();
  // Consent/context is an explicit V2 SAVE by the authenticated, bound student.
  const saved=await fetch(`http://127.0.0.1:${port}/api/project/settings`,{method:'PUT',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify({requestId:'report-settings',clientId,sessionId:state.sessionId,expectedWorkspaceVersion:app.workspace.workspaceVersion,settings:{...settings,schemaVersion:2,aiConsent:true,contextPatterns:['**/*']}})});
  assert.equal(saved.status,200);
  const response=await fetch(`http://127.0.0.1:${port}/api/session/finish`,{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify({requestId:'report-request',clientId,sessionId:state.sessionId,expectedWorkspaceVersion:app.workspace.workspaceVersion,reason:'COMPLETED'})});
  assert.equal(response.status,202);
  const deadline=Date.now()+5000;let report:any;
  do {await delay(10);report=await fetch(`http://127.0.0.1:${port}/api/session/report?sessionId=${state.sessionId}`,{headers:{Authorization:`Bearer ${token}`}}).then(r=>r.json());}while(report.status==='PENDING'&&Date.now()<deadline);
  assert.equal(report.status,'READY');assert.match(report.markdown,/Raport AI Codex/);
  const record=await f.read();assert.doesNotMatch(record.input,/NEVER_SEND_PRIVATE_FILE|PRIVATE_TEST_HTTP_TOKEN|rawBase64|outputTail/);
  assert.equal(record.schema.required[0],'markdown');
});

test('coach and report subprocesses receive identical pinned config; API credentials stay outside child',async t=>{
  const f=await fake(t,`const report=JSON.parse(fs.readFileSync(argv[argv.indexOf('--output-schema')+1],'utf8')).required[0]==='markdown';emit({type:'turn.started'});emit({type:'item.completed',item:{type:'agent_message',text:JSON.stringify(report?{markdown:'Raport Codex.'}:{decision:{kind:'REPLY',text:'Odpowiedź Codex.'}})}});emit({type:'turn.completed'});`);
  const oldKey=process.env.OPENAI_API_KEY,oldUrl=process.env.OPENAI_BASE_URL;
  process.env.OPENAI_API_KEY='SYNTHETIC_DO_NOT_FORWARD';process.env.OPENAI_BASE_URL='https://synthetic.invalid';
  t.after(()=>{if(oldKey===undefined)delete process.env.OPENAI_API_KEY;else process.env.OPENAI_API_KEY=oldKey;if(oldUrl===undefined)delete process.env.OPENAI_BASE_URL;else process.env.OPENAI_BASE_URL=oldUrl;});
  await f.provider.decide(context,new AbortController().signal);const coach=await f.read();
  assert.equal(await f.provider.generateReport({aiConsent:true},'Report',new AbortController().signal),'Raport Codex.');const report=await f.read();
  for(const record of [coach,report]){
    assert.equal(record.argv[record.argv.indexOf('--model')+1],'gpt-6.1-sol');
    assert(record.argv.includes('model_reasoning_effort="medium"'));
    assert.equal(record.env.OPENAI_API_KEY,undefined);assert.equal(record.env.OPENAI_BASE_URL,undefined);
  }
});
