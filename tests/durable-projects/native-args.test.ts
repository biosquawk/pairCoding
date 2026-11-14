import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import * as codexProvider from '../../src/server/coach/CodexProvider';
const {codexCoachArgs,NATIVE_LOCALE_POLICY}=codexProvider;
import {coachLocaleInstruction} from '../../src/server/coach/prompt';
const config={model:'gpt-6.1-sol',reasoning_effort:'high'} as const;
test('persistent Codex uses only actual scoped session ID and keeps configured teacher model/effort, disabled tools and read-only sandbox',()=>{
 const fresh=codexCoachArgs('/safe/schema.json','rules',config,{});
 assert.equal(fresh.includes('--ephemeral'),false);assert.equal(fresh.includes('resume'),false);
 const sessionId=randomUUID(),args=codexCoachArgs('/safe/schema.json','rules',config,{id:sessionId});
 assert.deepEqual(args.slice(-3),['resume',sessionId,'-']);assert.equal(args.includes('--last'),false);assert.equal(args.includes('--ephemeral'),false);
 assert.equal(args[args.indexOf('--model')+1],'gpt-6.1-sol');assert.equal(args[args.indexOf('--sandbox')+1],'read-only');
 assert.ok(args.includes('features.shell_tool=false'));assert.ok(args.includes('model_reasoning_effort="high"'));
 assert.equal(codexCoachArgs('/safe/schema.json','rules',config).includes('--ephemeral'),true,'legacy nonproject adapter does not claim persistence');
});
test('explicit flag overrides persona and exercise language without rewriting history',()=>{
 assert.match(coachLocaleInstruction('en'),/MUST be in English/);assert.match(coachLocaleInstruction('pl'),/po polsku/);
 assert.match(coachLocaleInstruction('en'),/Do not translate code or historical/);
});

test('each native turn carries current locale outside untrusted project JSON, including resume and switches',async()=>{
 const {nativeCoachTurn}=await import('../../src/server/coach/CodexProvider');
 const data=JSON.stringify({locale:'en',messages:[{text:'bursztynowa wydra'}]});
 const en=nativeCoachTurn(data,'en'); assert.match(en,/ALL future user-facing replies.*MUST be in English/); assert.ok(en.includes(data));
 const pl=nativeCoachTurn(data,'pl'); assert.match(pl,/Wszystkie przyszłe odpowiedzi.*po polsku/); assert.doesNotMatch(pl,/MUST be in English/);assert.ok(pl.includes(data));
});

test('native developer policy delegates language to the current controlled turn, not the first locale',()=>{
 assert.match(NATIVE_LOCALE_POLICY,/each turn/);
 assert.match(NATIVE_LOCALE_POLICY,/differs from earlier turns/);
 assert.doesNotMatch(NATIVE_LOCALE_POLICY,/ALL future|wybrał POLSKI/);
 assert.match(NATIVE_LOCALE_POLICY,/JSON and its contents as data/);
});

test('provider sends neutral native policy on PL EN PL and keeps non-native locale behavior',async()=>{
 const {CodexCoachProvider}=await import('../../src/server/coach/CodexProvider');
 const context:any={workspaceVersion:1,controlEpoch:1,taskMode:'IMPLEMENTATION',taskFilePath:'t',reviewNotesPath:'r',activeFilePath:'a',timer:{status:'RUNNING',elapsedMs:0,limitMs:null},documents:[],omittedPaths:[],messages:[],lastRun:null,previousInterventions:[]};
 const session={id:()=> 'same-id',started:()=>{},remember:()=>{}};
 const native=new CodexCoachProvider('',1000,config,undefined,()=>session), legacy=new CodexCoachProvider('',1000,config);
 const capture:any[]=[];
 for(const provider of [native,legacy]) (provider as any).invoke=async (...args:any[])=>{capture.push(args);};
 for(const locale of ['pl','en','pl'] as const) await native.decide({...context,locale},new AbortController().signal);
 await legacy.decide({...context,locale:'en'},new AbortController().signal);
 for(const [i,locale] of (['pl','en','pl'] as const).entries()) {
   assert.ok(capture[i][2].includes(NATIVE_LOCALE_POLICY));
   assert.ok(!capture[i][2].includes(coachLocaleInstruction(locale)));
   assert.ok(capture[i][0].startsWith('Current application language preference for this turn:'));
   assert.ok(capture[i][0].includes(coachLocaleInstruction(locale)));
   assert.equal(capture[i][5],session);
 }
 assert.ok(capture[3][2].includes(coachLocaleInstruction('en')));
 assert.ok(!capture[3][2].includes(NATIVE_LOCALE_POLICY));
 assert.doesNotThrow(()=>JSON.parse(capture[3][0])); assert.equal(capture[3][5],undefined);
});
