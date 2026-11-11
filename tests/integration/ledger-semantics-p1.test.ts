import test from 'node:test';
import assert from 'node:assert/strict';
import { CommandLedger, TransportError } from '../../src/server/transport';

const deferred=<T>()=>{let resolve!:(value:T)=>void;let reject!:(reason:unknown)=>void;
  const promise=new Promise<T>((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
const cleanup=async(ledger:CommandLedger)=>{if('close' in ledger) await (ledger as any).close();};

test('P1 ledger: pending precedes effect; concurrent identical operation shares completion, tail change conflicts',async()=>{
  const ledger=new CommandLedger(), wait=deferred<number>();let effects=0;
  try {
    const input={z:[null,1,{a:'tail',b:true}],content:'prefix'.repeat(10000)+'original'};
    const first=ledger.run('id',input,()=>{effects++;return wait.promise;});
    assert.equal(effects,0,'operation cannot precede pending registration');
    const other=ledger.run('id',{content:input.content,z:input.z},()=>{effects++;return 9;});
    assert.equal(first.duplicate,false);assert.equal(other.duplicate,true);assert.equal(other.result,first.result);
    assert.throws(()=>ledger.run('id',{...input,content:input.content.slice(0,-1)+'X'},()=>99),{status:409,code:'IDEMPOTENCY_CONFLICT'});
    await Promise.resolve();assert.equal(effects,1);
    wait.resolve(42);assert.deepEqual(await Promise.all([first.result,other.result]),[42,42]);
    assert.equal(await ledger.run('id',input,()=>99).result,42);assert.equal(effects,1);
  } finally {await cleanup(ledger);}
});

test('P1 ledger: async rejection remains rejected for pending and terminal retries without reexecution',async()=>{
  const ledger=new CommandLedger(), wait=deferred<number>();let effects=0;
  try {
    const operation=()=>{effects++;return wait.promise;};
    const a=ledger.run('failure',{data:'same'},operation), b=ledger.run('failure',{data:'same'},operation);
    // Attach handlers before rejecting the deliberate deferred failure.
    const all=Promise.allSettled([a.result,b.result]);
    wait.reject(new TransportError(409,'DISK_CONFLICT','Nie zapisano.'));
    const result=await all;assert(result.every(v=>v.status==='rejected'));
    for(const r of result) if(r.status==='rejected') assert.equal(r.reason.code,'DISK_CONFLICT');
    await assert.rejects(ledger.run('failure',{data:'same'},operation).result,{status:409,code:'DISK_CONFLICT',message:'Nie zapisano.'});
    assert.throws(()=>ledger.run('failure',{data:'changed'},operation),{status:409,code:'IDEMPOTENCY_CONFLICT'});
    assert.equal(effects,1);
  } finally {await cleanup(ledger);}
});

test('P1 ledger: more than 1000 ordinary autosaves keep working and earliest ID cannot reexecute',async()=>{
  const ledger=new CommandLedger();let effects=0;
  try {
    for(let i=0;i<2048;i++) assert.equal(await ledger.run(`save-${i}`,{version:i,content:`v${i}`},()=>{effects++;return i+1;}).result,i+1);
    const old=ledger.run('save-0',{version:0,content:'v0'},()=>{effects++;return -1;});
    assert.equal(old.duplicate,true);assert.equal(await old.result,1);assert.equal(effects,2048);
  } finally {await cleanup(ledger);}
});
