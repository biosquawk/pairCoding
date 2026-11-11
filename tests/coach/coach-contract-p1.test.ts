/** Stage7: real adapter/workspace/gate and actual synthetic Codex child stdin, NOT realAI. */
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import {readFile, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {coreFixture} from '../qa/helpers';
import {CoachAdapter, type CoachProvider} from '../../src/server/CoachAdapter';
import {hasDirectMuteRequest} from '../../src/server/coach/authorization';
import {buildContext, contextFingerprint} from '../../src/server/coach/context';
import type {CoachContext} from '../../src/server/coach/context';
import {CodexCoachProvider, CODEX_COACH_SCHEMA, codexCoachArgs} from '../../src/server/coach/CodexProvider';
import {parseCoachDecision, COACH_DECISION_SCHEMA} from '../../src/server/coach/schema';
import {COACH_SYSTEM_PROMPT, COACH_CONVERSATION_RULES} from '../../src/server/coach/prompt';
import type {ChatEntry, Run} from '../../src/shared/protocol';

const ALLOWED_PROPOSAL_KINDS = ['RETRY_FROM_SNAPSHOT','RESTORE_SNAPSHOT','FINISH_EXERCISE'];
const chat = (messageId: string, text: string, author: ChatEntry['author'] = 'STUDENT'): ChatEntry =>
  ({messageId, text, author, createdAt: new Date().toISOString()});
const hint = (evidenceIds: string[]) => ({kind:'HINT',severity:'NEUTRAL',text:'Sprawdź warunek.',path:null,
  documentVersion:null,range:null,showPointer:false,evidenceIds});
const mute = (id: string) => ({kind:'MUTE',durationSeconds:60,sourceUserMessageId:id});
const proposal = {kind:'PROPOSE',proposalKind:'GENERATE_TESTS',questionText:'Wygenerować?',snapshotId:null,paths:['main.py'],resetTimer:false};
async function until(predicate: () => boolean) {
  const deadline = Date.now() + 1800;
  while (!predicate()) { assert(Date.now() < deadline, 'bounded adapter completion'); await delay(5); }
}
async function fixture(t: TestContext, provider: CoachProvider) {
  const f = await coreFixture(t, {'main.py':'value = 1\n'});
  f.workspace.updateSettings({...f.workspace.settings,aiConsent:true,contextPatterns:['*.py']});
  f.session.start(null,false);
  const events: {type:string;payload:any}[] = [], proposals: unknown[] = [];
  const adapter = new CoachAdapter({workspace:f.workspace,session:f.session,gate:f.gate,provider,
    sensitiveValues:['PRIVATE_TOKEN_FIXTURE'],emit:(type,payload)=>events.push({type,payload}),onProposal:p=>proposals.push(p)});
  t.after(()=>adapter.close());
  return {...f,adapter,events,proposals};
}
function noEffects(f: Awaited<ReturnType<typeof fixture>>) {
  assert.equal(f.session.getSession().writeOwner,'STUDENT');
  assert.equal(f.proposals.length,0);
  assert.equal(f.events.some(e=>['COACH_HINT_BUBBLE','COACH_POINTER','CONTROL_PREPARE','COACH_STEP_EDIT','ACTION_PROPOSAL'].includes(e.type)),false);
}

test('authoritative contract is derived from final redacted/deduplicated messages + run, not file IDs',async t=>{
  const f=await fixture(t,{name:'injected',decide:async()=>({kind:'SILENT',reason:'test'})});
  const messages=[chat('old-omitted','old'),...Array.from({length:21},(_,i)=>chat(i%2 ? 'duplicate-id':'message-'+i,'PRIVATE_TOKEN_FIXTURE'))];
  const run={runId:'run-actual',status:'SUCCEEDED',mode:'RUN_MAIN',finishedAt:new Date().toISOString()} as Run;
  const context=buildContext(f.workspace,f.session.getSession(),messages,run,[],['PRIVATE_TOKEN_FIXTURE']);
  assert.deepEqual(context.capabilities,{canGenerateTests:false});
  assert.deepEqual(context.allowedProposalKinds,[...ALLOWED_PROPOSAL_KINDS]);
  assert.deepEqual(context.allowedEvidenceIds,[...new Set([...context.messages.map(m=>m.messageId),'run-actual'])]);
  assert.equal(context.allowedEvidenceIds!.includes('old-omitted'),false);
  assert.equal(context.allowedEvidenceIds!.includes('main.py'),false);
  assert.equal(JSON.stringify(context).includes('PRIVATE_TOKEN_FIXTURE'),false);
  assert.deepEqual(buildContext(f.workspace,f.session.getSession(),[],null,[]).allowedEvidenceIds,[]);
  const student=chat('student','help');
  const before=buildContext(f.workspace,f.session.getSession(),[student],null,[]);
  const after=buildContext(f.workspace,f.session.getSession(),[student,chat('own-reply','reply','COACH')],null,[]);
  assert.equal(contextFingerprint(before),contextFingerprint(after),'derived COACH evidence is not a new domain fact');
  const ids=buildContext(f.workspace,f.session.getSession(),[chat('PRIVATE_TOKEN_FIXTURE','text')],null,[],['PRIVATE_TOKEN_FIXTURE']);
  assert.deepEqual(ids.allowedEvidenceIds,ids.messages.map(m=>m.messageId),'post-redaction identity');
});

test('GENERATE_TESTS absent in actual prompt/schema, rejected before adapter proposal callback',async t=>{
  assert.equal(JSON.stringify(COACH_DECISION_SCHEMA).includes('GENERATE_TESTS'),false);
  assert.equal(JSON.stringify(CODEX_COACH_SCHEMA).includes('GENERATE_TESTS'),false);
  assert.doesNotMatch(COACH_SYSTEM_PROMPT,/generowanie brakujących testów/);
  assert.match(COACH_CONVERSATION_RULES,/canGenerateTests=false/);
  assert.match(COACH_CONVERSATION_RULES,/allowedEvidenceIds/);
  assert.throws(()=>parseCoachDecision(proposal));
  const f=await fixture(t,{name:'stale-provider',decide:async()=>proposal});
  const before=f.workspace.workspaceVersion;
  f.adapter.trigger('CHAT',chat('generate','pomóż'));
  await until(()=>f.events.some(e=>e.type==='ERROR'));
  assert.match(f.events.find(e=>e.type==='ERROR')!.payload.message,/niedostępna/);
  noEffects(f);assert.equal(f.workspace.workspaceVersion,before);
  assert.equal(await readFile(path.join(f.rootPath,'main.py'),'utf8'),'value = 1\n');
  // Defense independent of schema: a stale/internal caller cannot bypass admission.
  const ctx=buildContext(f.workspace,f.session.getSession(),[],null,[]);
  await assert.rejects((f.adapter as any).applyDecision(proposal,ctx,{reason:'START'},new AbortController().signal));
  noEffects(f);
});

test('adapter passes real contract; empty/valid evidence succeeds; fake/mixed evidence rejects whole hint safely',async t=>{
  for (const kind of ['empty-context','empty','valid','fake','mixed'] as const) {
    let seen:Readonly<CoachContext>|undefined;
    const f=await fixture(t,{name:'injected',decide:async ctx=>{
      seen=ctx;
      assert.deepEqual(ctx.capabilities,{canGenerateTests:false});
      assert.deepEqual(ctx.allowedProposalKinds,[...ALLOWED_PROPOSAL_KINDS]);
      const ids=kind==='valid'?['current']:kind==='fake'?['PRIVATE_TOKEN_FIXTURE']:kind==='mixed'?['current','invented-id']:[];
      return hint(ids);
    }});
    const before=f.session.getSession();
    if(kind==='empty-context')f.adapter.trigger('START');else f.adapter.trigger('CHAT',chat('current','pomóż'));
    await until(()=>f.events.some(e=>['ERROR','COACH_HINT_BUBBLE'].includes(e.type)));
    assert.deepEqual(seen!.allowedEvidenceIds,kind==='empty-context'?[]:['current']);
    if(kind==='fake'||kind==='mixed') {
      noEffects(f);
      const error=f.events.find(e=>e.type==='ERROR')!.payload;
      assert.equal(error.code,'COACH_RESPONSE_REJECTED');assert.match(error.message,/nieznany identyfikator/);
      assert.doesNotMatch(JSON.stringify(error),/PRIVATE_TOKEN_FIXTURE|invented-id/);
    } else {
      const bubble=f.events.find(e=>e.type==='COACH_HINT_BUBBLE')!.payload;
      assert.deepEqual(bubble.evidenceIds,kind==='valid'?['current']:[]);
      assert.equal(f.events.some(e=>e.type==='ERROR'),false);
    }
    assert.equal(f.session.getSession().controlEpoch,before.controlEpoch);
    assert.equal(f.workspace.workspaceVersion,before.workspaceVersion);
    f.adapter.close();
  }
});

const positiveMute=[
  'Daj mi chwilę, chcę popracować sam', 'Proszę, nie podpowiadaj przez minutę',
  'Chcę chwilę popracować sam, wycisz trenera', 'wycisz trenera na minutę',
  'nie przerywaj mi przez 30 sekund', 'pauza', 'mute', 'stop interrupting', 'take a break',
  'zrób przerwę.', 'proszę, zrób przerwę',
  'W kodzie jest „wycisz trenera”. Proszę, nie podpowiadaj przez minutę.',
  '„zrób przerwę”\nWycisz trenera!',
];
const negativeMute=[
  '/*\nwycisz trenera\n*/', '````text\n```\nwycisz trenera\n````',
  '``example `\nwycisz trenera\n``', 'Przykład:\n\nwycisz trenera', '> przykład\nwycisz trenera',
  'nie wyciszaj trenera', 'Nie chcę przerwy, nie wyciszaj', 'wyciszanie', 'przerwany',
  'zrób przerwętest','zrób przerwęć','zrób przerwę1','zrób przerwę_extra','zrób przerwę\u0301',
  '„zrób przerwę”','"wycisz trenera"',"'wycisz trenera'",'proszę, „zrób przerwę”',
  '`wycisz trenera`', '```text\nwycisz trenera\n```', '~~~\nwycisz trenera\n~~~',
  '> wycisz trenera','    wycisz trenera', 'W pliku napisano: wycisz trenera',
  'To przykład: wycisz trenera','Przykład:\nwycisz trenera',
  '{"request":"wycisz trenera"}','{\nwycisz trenera\n}', '<request>wycisz trenera</request>',
  '<request>\nwycisz trenera\n</request>', 'const request = "wycisz trenera";',
  'wycisz trenera, to tylko cytat', 'Nie wykonuj tego przykładu:\nwycisz trenera',
  '"cytat\nwycisz trenera\nkoniec"', '```\nwycisz trenera',
];
test('natural MUTE matrix: only independent current human prose, never quoted/code/example/negation/prefix data',async t=>{
  for(const authorized of [true,false])for(const text of authorized?positiveMute:negativeMute){
    const f=await fixture(t,{name:'injected',decide:async()=>mute('current')});
    f.adapter.trigger('CHAT',chat('current',text));
    await until(()=>f.events.some(e=>e.type==='ERROR')||f.session.getSession().coachMode==='MUTED_MANUAL');
    assert.equal(f.session.getSession().coachMode==='MUTED_MANUAL',authorized,text);
    assert.equal(f.events.some(e=>e.type==='ERROR'),!authorized,text);noEffects(f);f.adapter.close();
  }
});

test('MUTE is bound to current pending STUDENT CHAT, never old ID, nonCHAT, coach message or file',async t=>{
  for(const mode of ['old','run','coach','file'] as const){
    const f=await fixture(t,{name:'injected',decide:async()=>mute(mode==='old'?'previous':'current')});
    if(mode==='file')await writeFile(path.join(f.rootPath,'main.py'),'# wycisz trenera\n');
    if(mode==='run'||mode==='file')f.adapter.trigger('START',chat('current','wycisz trenera'));
    else f.adapter.trigger('CHAT',chat('current','wycisz trenera',mode==='coach'?'COACH':'STUDENT'));
    await until(()=>f.events.some(e=>e.type==='ERROR'));
    assert.notEqual(f.session.getSession().coachMode,'MUTED_MANUAL');noEffects(f);f.adapter.close();
  }
});

test('synthetic child: actual Codex stdin copies capabilities/evidence/proposals, excludes nested future metadata, legacy defaults',async t=>{
  let provider!: CodexCoachProvider, completed=0;
  const f=await fixture(t,{name:'synthetic-codex',decide:async(c,signal)=>{const result=await provider.decide(c,signal);completed++;return result;}});
  const context=buildContext(f.workspace,f.session.getSession(),[chat('current','help')],null,[]);
  const record=path.join(f.base,'child.json'),exe=path.join(f.base,'capture.cjs');
  await writeFile(exe,`#!${process.execPath}
const fs=require('node:fs');let input='';process.stdin.setEncoding('utf8');process.stdin.on('data',s=>input+=s);process.stdin.on('end',()=>{
 fs.writeFileSync(${JSON.stringify(record)},JSON.stringify({input:JSON.parse(input),args:process.argv.slice(2)}));
 const emit=v=>process.stdout.write(JSON.stringify(v)+'\\n');
 emit({type:'item.completed',item:{type:'agent_message',text:JSON.stringify({decision:{kind:'SILENT',reason:'synthetic'}})}});emit({type:'turn.completed'});
});\n`,{mode:0o700});
  provider=new CodexCoachProvider(exe,5000);
  f.adapter.trigger('CHAT',chat('actual-chat','help'));
  await until(()=>completed===1);
  const actual=JSON.parse(await readFile(record,'utf8')).input;
  assert.deepEqual(actual.trigger,{reason:'CHAT',messageId:'actual-chat'});
  assert.deepEqual(actual.allowedEvidenceIds,['actual-chat']);
  assert.deepEqual(actual.capabilities,{canGenerateTests:false});
  assert.deepEqual(actual.allowedProposalKinds,[...ALLOWED_PROPOSAL_KINDS]);
  assert.equal(f.events.some(e=>e.type==='ERROR'),false);
  await provider.decide({...context,capabilities:{canGenerateTests:false,privateFuture:'PRIVATE_FUTURE'} as any,
    privateFuture:'PRIVATE_ROOT'} as any,new AbortController().signal);
  const sent=JSON.parse(await readFile(record,'utf8'));
  assert.deepEqual(sent.input.capabilities,{canGenerateTests:false});
  assert.deepEqual(sent.input.allowedProposalKinds,[...ALLOWED_PROPOSAL_KINDS]);
  assert.deepEqual(sent.input.allowedEvidenceIds,['current']);
  assert.doesNotMatch(JSON.stringify(sent),/PRIVATE_FUTURE|PRIVATE_ROOT/);
  assert.match(sent.args.join(' '),/allowedEvidenceIds/);
  assert.deepEqual(sent.args,codexCoachArgs(sent.args[sent.args.indexOf('--output-schema')+1]));
  const {capabilities:_,allowedEvidenceIds:__,allowedProposalKinds:___,...legacy}=context;
  await provider.decide(legacy,new AbortController().signal);
  const defaults=JSON.parse(await readFile(record,'utf8')).input;
  assert.deepEqual(defaults.capabilities,{canGenerateTests:false});
  assert.deepEqual(defaults.allowedEvidenceIds,[]);assert.deepEqual(defaults.allowedProposalKinds,[]);
});

test('actual adapter RUN evidence is available and valid without fabricating a file/snapshot ID',async t=>{
  let seen:Readonly<CoachContext>|undefined;
  const f=await fixture(t,{name:'injected',decide:async c=>{seen=c;return hint(['actual-run']);}});
  f.adapter.updateRun({runId:'actual-run',status:'SUCCEEDED',mode:'RUN_MAIN',finishedAt:new Date().toISOString()} as Run);
  await until(()=>f.events.some(e=>e.type==='COACH_HINT_BUBBLE'||e.type==='ERROR'));
  assert.deepEqual(seen!.allowedEvidenceIds,['actual-run']);
  assert.deepEqual(f.events.find(e=>e.type==='COACH_HINT_BUBBLE')!.payload.evidenceIds,['actual-run']);
  assert.equal(f.events.some(e=>e.type==='ERROR'||e.type==='CONTROL_PREPARE'),false);
});


// Frozen K cases, exercised via the actual adapter as well as the pure grammar.
const reworkDataCases = [
  ['YAML literal', 'request: |\n  wycisz trenera'],
  ['YAML scalar', 'request:\n  wycisz trenera'],
  ['parenthesized data', '(\nwycisz trenera\n)'],
  ['curly quoted data', '’\nwycisz trenera\n’'],
] as const;
for (const [label, text] of reworkDataCases) test('rework current CHAT data cannot authorize MUTE: '+label, async t=>{
  const f=await fixture(t,{name:'injected',decide:async()=>mute('current')});
  const before=f.session.getSession(), version=f.workspace.workspaceVersion;
  f.adapter.trigger('CHAT',chat('current',text));
  await until(()=>f.events.some(e=>e.type==='ERROR')||f.session.getSession().coachMode==='MUTED_MANUAL');
  assert.notEqual(f.session.getSession().coachMode,'MUTED_MANUAL',text);
  assert.equal(f.events.filter(e=>e.type==='ERROR').length,1);
  assert.equal(f.events.find(e=>e.type==='ERROR')!.payload.code,'COACH_RESPONSE_REJECTED');
  assert.equal(f.session.getSession().controlEpoch,before.controlEpoch);
  assert.equal(f.workspace.workspaceVersion,version);
  assert.equal(await readFile(path.join(f.rootPath,'main.py'),'utf8'),'value = 1\n');
  noEffects(f);
  assert.equal(hasDirectMuteRequest(text),false);
});

const adjacentDataCases = [
  'request: >-\n  wycisz trenera', 'request: |2+ # data\n  wycisz trenera',
  'request:\nwycisz trenera', '- request:\n  wycisz trenera',
  'żądanie:\n  wycisz trenera', '"request": |\n  wycisz trenera',
  "'request':\n  wycisz trenera", 'request: metadata\n  wycisz trenera',
  '(outer (inner)\nwycisz trenera\n)', '("quoted )"\nwycisz trenera\n)',
  '(\nwycisz trenera', '”\nwycisz trenera\n”', '»\nwycisz trenera\n»',
];
test('rework grammar denies data variants and preserves every original positive/negative',()=>{
  const invalid=[...negativeMute,...reworkDataCases.map(([,text])=>text),...adjacentDataCases];
  assert.deepEqual(invalid.filter(hasDirectMuteRequest),[]);
  assert.deepEqual(positiveMute.filter(text=>!hasDirectMuteRequest(text)),[]);
});
test('rework adapter rejects adjacent data but permits independent prose after closed quoted/parenthesized data',async t=>{
  const positive=['(Notatka: wycisz trenera)\nProszę, nie podpowiadaj przez minutę.',
    '’\nwycisz trenera\n’\nDaj mi chwilę, chcę popracować sam',
    '(outer (inner))\nChcę chwilę popracować sam, wycisz trenera'];
  for(const [authorized,inputs] of [[false,adjacentDataCases],[true,positive]] as const)for(const text of inputs){
    const f=await fixture(t,{name:'injected',decide:async()=>mute('current')});
    f.adapter.trigger('CHAT',chat('current',text));
    await until(()=>f.events.some(e=>e.type==='ERROR')||f.session.getSession().coachMode==='MUTED_MANUAL');
    assert.equal(f.session.getSession().coachMode==='MUTED_MANUAL',authorized,text);
    assert.equal(f.events.some(e=>e.type==='ERROR'),!authorized,text);noEffects(f);f.adapter.close();
  }
});
