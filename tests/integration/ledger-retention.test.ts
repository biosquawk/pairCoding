import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { CommandLedger, TransportError } from '../../src/server/transport';

for(const mode of ['control','input','result','error','pending'])test(`ledger real heap: ${mode==='control'?'negative control detects retained history':`settled ${mode} does not retain full history`}`,{timeout:30000},async t=>{
  const args=['--expose-gc','--max-old-space-size=192','--import','tsx',fileURLToPath(new URL('./ledger-retention.fixture.ts',import.meta.url)),mode];
  const child=spawn(process.execPath,args,{stdio:['ignore','pipe','pipe'],env:process.env});
  let stdout='',stderr='';child.stdout.on('data',d=>stdout+=d);child.stderr.on('data',d=>stderr+=d);
  const timer=setTimeout(()=>child.kill('SIGKILL'),25000);
  const result=await new Promise<{code:number|null;signal:string|null}>((resolve,reject)=>{child.once('error',reject);child.once('close',(code,signal)=>resolve({code,signal}));}).finally(()=>clearTimeout(timer));
  t.diagnostic(JSON.stringify({command:[process.execPath,...args],...result,stdout,stderr}));
  assert.equal(result.signal,null,'probe must finish, not OOM or hang');
  assert.equal(result.code,0,stderr||stdout);
});

test('ledger registers PENDING before effect, canonical concurrent duplicates share the exact result, conflicts never execute',async t=>{
  const ledger=new CommandLedger();t.after(()=> (ledger as any).close?.());let effects=0,settled=false;
  let release!:(value:{version:number})=>void;
  const gate=new Promise<{version:number}>(resolve=>release=resolve);
  const first=ledger.run('pending',{b:[2,3],a:1},()=>{effects++;return gate;});
  assert.equal(effects,0,'effect cannot run before registration');
  const second=ledger.run('pending',{a:1,b:[2,3]},()=>{effects++;throw new Error('duplicate effect');});
  assert.equal(second.duplicate,true);assert.equal(second.result,first.result);
  assert.throws(()=>ledger.run('pending',{a:1,b:[3,2]},()=>{effects++;}),{status:409,code:'IDEMPOTENCY_CONFLICT'});
  first.result.then(()=>{settled=true;});await Promise.resolve();
  assert.equal(effects,1);assert.equal(settled,false);
  const value={version:17};release(value);
  assert.deepEqual(await first.result,value);assert.deepEqual(await second.result,value);
  const replay=ledger.run('pending',{a:1,b:[2,3]},()=>{effects++;return {version:18};});
  assert.equal(replay.duplicate,true);assert.deepEqual(await replay.result,value);assert.equal(effects,1);
});

for(const asyncFailure of [false,true])test(`ledger ${asyncFailure?'async reject':'sync throw'} remains the same failure across pending/concurrent/settled replay`,async t=>{
  const ledger=new CommandLedger();t.after(()=> (ledger as any).close?.());let effects=0;
  const error=new TransportError(409,'QA_REJECTION','independent failure');
  const operation=()=>{effects++;if(asyncFailure)return Promise.reject(error);throw error;};
  const first=ledger.run('failure',{path:'a'},operation);
  const concurrent=ledger.run('failure',{path:'a'},operation);
  assert.equal(concurrent.duplicate,true);
  const failures=await Promise.allSettled([first.result,concurrent.result]);
  for(const result of failures){assert.equal(result.status,'rejected');if(result.status==='rejected'){assert.equal(result.reason.status,409);assert.equal(result.reason.code,'QA_REJECTION');assert.equal(result.reason.message,'independent failure');}}
  await assert.rejects(ledger.run('failure',{path:'a'},operation).result,{status:409,code:'QA_REJECTION',message:'independent failure'});
  assert.throws(()=>ledger.run('failure',{path:'b'},operation),{status:409,code:'IDEMPOTENCY_CONFLICT'});
  assert.equal(effects,1);
});

test('ledger >1000 small mutations keeps autosave and cannot re-execute an old key',async t=>{
  const ledger=new CommandLedger();t.after(()=> (ledger as any).close?.());let effects=0;
  for(let i=0;i<1500;i++)assert.equal(await ledger.run('edit-'+i,{content:'small-'+i},()=>++effects).result,i+1);
  assert.equal(await ledger.run('edit-0',{content:'small-0'},()=>++effects).result,1);
  assert.throws(()=>ledger.run('edit-0',{content:'different'},()=>++effects),{status:409,code:'IDEMPOTENCY_CONFLICT'});
  assert.equal(effects,1500);
});
