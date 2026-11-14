import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {codexCoachArgs} from '../../src/server/coach/CodexProvider';
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
