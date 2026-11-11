/** K-approved small public budgets; assertions derive from fail-before-effect and no replay, not journal internals. */
import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {CommandLedger} from '../../src/server/transport';
type Options={maxEntries?:number;maxBytes?:number;maxPending?:number;maxOutcomeBytes?:number;tempRoot?:string};
type Lifecycle=CommandLedger&{retire():void|Promise<void>;close():void|Promise<void>};
const PublicLedger=CommandLedger as unknown as new(options:Options)=>Lifecycle;
async function fixture(t:TestContext,options:Options={}) {
  const tempRoot=await fs.mkdtemp(path.join(os.tmpdir(),'ledger-budget-p3-'));
  const ledger=new PublicLedger({tempRoot,maxOutcomeBytes:1024,...options});
  t.after(async()=>{try{await ledger.close?.();}finally{await fs.rm(tempRoot,{recursive:true,force:true});}});
  return {ledger,tempRoot};
}
function limited(fn:()=>unknown) {
  assert.throws(fn,(e:any)=>Number.isInteger(e.status)&&e.status>=400&&e.status<500,'new effect must be explicitly rejected before invocation');
}

test('ledger entry budget: reject new work before effect but preserve old success/failure/conflict',async t=>{
  const {ledger}=await fixture(t,{maxEntries:2,maxBytes:65536});let effects=0;
  assert.equal(await ledger.run('one',{n:1},()=>{effects++;return 17;}).result,17);
  await assert.rejects(ledger.run('two',{n:2},()=>{effects++;throw Object.assign(new Error('expected rejection'),{status:409,code:'QA_FAIL'});}).result,{code:'QA_FAIL'});
  limited(()=>ledger.run('three',{n:3},()=>++effects));
  assert.equal(await ledger.run('one',{n:1},()=>++effects).result,17);
  await assert.rejects(ledger.run('two',{n:2},()=>++effects).result,{status:409,code:'QA_FAIL',message:'expected rejection'});
  assert.throws(()=>ledger.run('one',{n:9},()=>++effects),{status:409,code:'IDEMPOTENCY_CONFLICT'});
  assert.equal(effects,2);
});

test('ledger pending budget: accepted unresolved work shares promise, excess new work has no effect, capacity resumes after settlement',async t=>{
  const {ledger}=await fixture(t,{maxPending:2,maxEntries:20,maxBytes:65536});let effects=0;
  let release!:(n:number)=>void;const barrier=new Promise<number>(r=>release=r);
  const first=ledger.run('one',{n:1},()=>{effects++;return barrier;});
  const second=ledger.run('two',{n:2},()=>{effects++;return barrier;});
  const duplicate=ledger.run('one',{n:1},()=>{effects++;return 0;});
  assert.equal(duplicate.duplicate,true);assert.equal(duplicate.result,first.result);
  limited(()=>ledger.run('three',{n:3},()=>++effects));
  await Promise.resolve();assert.equal(effects,2);release(21);
  assert.deepEqual(await Promise.all([first.result,second.result,duplicate.result]),[21,21,21]);
  assert.equal(await ledger.run('three',{n:3},()=>++effects).result,3);
});

test('ledger byte budget: oversized accepted effect returns stable503, then fail-closed before any further effect',async t=>{
  const {ledger}=await fixture(t,{maxBytes:4096,maxEntries:100,maxPending:2});let effects=0;
  const value={content:'independent-large-result-'.repeat(2048)};
  const first=ledger.run('large',{n:1},()=>{effects++;return value;});
  await assert.rejects(first.result,{status:503,code:'COMMAND_RESULT_UNAVAILABLE'});
  // Post-effect freeze is not ordinary budget exhaustion: approved ledger503 is also fail-closed.
  assert.throws(()=>ledger.run('next',{n:2},()=>++effects),(e:any)=>
    (Number.isInteger(e.status)&&e.status>=400&&e.status<500)||
    (e.status===503&&['COMMAND_RESULT_UNAVAILABLE','COMMAND_STORAGE_UNAVAILABLE'].includes(e.code)));
  const replay=ledger.run('large',{n:1},()=>{effects++;return null;});
  assert.equal(replay.duplicate,true);await assert.rejects(replay.result,{status:503,code:'COMMAND_RESULT_UNAVAILABLE'});
  assert.throws(()=>ledger.run('large',{n:99},()=>++effects),{status:409,code:'IDEMPOTENCY_CONFLICT'});
  assert.equal(effects,1);
});

test('ledger retire pending lifecycle: no new effect, accepted work completes, files removed only after settlement and old key cannot execute',async t=>{
  const {ledger,tempRoot}=await fixture(t,{maxPending:2});let effects=0;
  let release!:(n:number)=>void;const barrier=new Promise<number>(r=>release=r);
  const first=ledger.run('old',{content:'sensitive text must not survive disposal'},()=>{effects++;return barrier;});
  await Promise.resolve();assert.equal(effects,1);
  assert.equal(typeof ledger.retire,'function','approved lifecycle API is required');
  // retire may return a cleanup promise, but must synchronously stop admitting effects.
  const retirement=ledger.retire();limited(()=>ledger.run('new',{},()=>++effects));
  release(73);assert.equal(await first.result,73);await retirement;
  assert.equal(typeof ledger.close,'function');await ledger.close();await ledger.close();
  assert.deepEqual(await fs.readdir(tempRoot),[],'scope storage must be removed after pending settles');
  try {const replay=ledger.run('old',{content:'sensitive text must not survive disposal'},()=>++effects);assert.equal(await replay.result,73);}
  catch(e){assert(Number.isInteger((e as any).status)&&(e as any).status>=400&&(e as any).status<500);}
  assert.equal(effects,1,'retired key can be replayed/rejected, never executed again');
});

test('ledger fingerprint checks the complete large payload, including a changed tail',async t=>{
  const {ledger}=await fixture(t);let effects=0;
  const prefix='unchanged-prefix-'.repeat(16384),input={type:'CODE_CHANGED',payload:{content:prefix+'A',path:'solution.js'}};
  assert.equal(await ledger.run('tail',input,()=>++effects).result,1);
  assert.throws(()=>ledger.run('tail',{...input,payload:{...input.payload,content:prefix+'B'}},()=>++effects),{status:409,code:'IDEMPOTENCY_CONFLICT'});
  assert.equal(await ledger.run('tail',{payload:{path:'solution.js',content:prefix+'A'},type:'CODE_CHANGED'},()=>++effects).result,1);
  assert.equal(effects,1);
});
