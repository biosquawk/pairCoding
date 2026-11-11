import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CommandLedger, TransportError } from '../../src/server/transport';

function fixture(t:any, options:ConstructorParameters<typeof CommandLedger>[0]={}) {
  const tempRoot=fs.mkdtempSync(path.join(os.tmpdir(),'p1-ledger-budget-'));
  const ledger=new CommandLedger({tempRoot,...options});
  t.after(()=>{ledger.close();fs.rmSync(tempRoot,{recursive:true,force:true});});
  const journal=()=>path.join(tempRoot,fs.readdirSync(tempRoot)[0],'receipts.bin');
  return {ledger,tempRoot,journal};
}
function deferred<T>() {let resolve!:(value:T)=>void;const promise=new Promise<T>(yes=>resolve=yes);return {promise,resolve};}

test('P1 budget: count limit is before effects; known success/error retries and conflicts still work',async t=>{
  const {ledger}=fixture(t,{maxEntries:2});let effects=0;
  assert.equal(await ledger.run('success',{text:'a'},()=>{effects++;return {value:42};}).result instanceof Object,true);
  await assert.rejects(ledger.run('failure',null,()=>{effects++;throw Object.assign(new TransportError(409,'VERSION_CONFLICT','zmiana'),{currentVersion:23});}).result,{currentVersion:23});
  assert.throws(()=>ledger.run('new',{},()=>{effects++;}),{status:429,code:'COMMAND_LIMIT'});
  assert.deepEqual(await ledger.run('success',{text:'a'},()=>{effects++;return null;}).result,{value:42});
  await assert.rejects(ledger.run('failure',null,()=>{effects++;}).result,{status:409,code:'VERSION_CONFLICT',currentVersion:23});
  assert.throws(()=>ledger.run('success',{text:'b'},()=>{}),{status:409,code:'IDEMPOTENCY_CONFLICT'});
  assert.equal(effects,2);
});

test('P1 budget: pending and byte reservation bound admission; duplicate does not consume another slot',async t=>{
  const {ledger,journal}=fixture(t,{maxPending:1,maxBytes:2048,maxOutcomeBytes:1024});const done=deferred<number>();let effects=0;
  const a=ledger.run('a',1,()=>{effects++;return done.promise;}),b=ledger.run('a',1,()=>0);
  assert.equal(a.result,b.result);
  assert.throws(()=>ledger.run('b',1,()=>{effects++;}),{code:'COMMAND_PENDING_LIMIT'});
  done.resolve(1);assert.equal(await a.result,1);
  await ledger.run('b',1,()=>{effects++;return 'x'.repeat(850);}).result;
  assert(fs.statSync(journal()).size+1024>2048,'real receipts plus next reservation exceed byte budget');
  assert.throws(()=>ledger.run('c',1,()=>{effects++;}),{code:'COMMAND_LIMIT'});
  assert.equal(await ledger.run('a',1,()=>0).result,1);assert.equal(effects,2);
});

test('P1 lifecycle: retire rejects all later run calls and cleans only after issued pending settles',async t=>{
  const {ledger,tempRoot}=fixture(t);const done=deferred<number>();let effects=0;
  const a=ledger.run('a',{value:'original'},()=>{effects++;return done.promise;});
  ledger.retire();assert.equal(fs.readdirSync(tempRoot).length,1);
  assert.throws(()=>ledger.run('a',{value:'original'},()=>0),{status:409,code:'COMMAND_SCOPE_RETIRED'});
  assert.throws(()=>ledger.run('b',null,()=>0),{code:'COMMAND_SCOPE_RETIRED'});
  done.resolve(4);assert.equal(await a.result,4);assert.equal(effects,1);
  assert.deepEqual(fs.readdirSync(tempRoot),[]);
  ledger.close();ledger.retire();assert.deepEqual(fs.readdirSync(tempRoot),[]);
});

test('P1 storage: terminal results private; source text is absent; known missing/corrupt journal never reexecutes',async t=>{
  for(const missing of [false,true]) {
    const {ledger,tempRoot,journal}=fixture(t);let effects=0;
    await ledger.run('a',{content:'VERY_PRIVATE_OLD_CODE_CHANGED_9723'},()=>{effects++;return 42;}).result;
    const file=journal(),directory=path.dirname(file),content=fs.readFileSync(file);
    assert.equal(fs.statSync(directory).mode&0o777,0o700);assert.equal(fs.statSync(file).mode&0o777,0o600);
    assert(!content.includes(Buffer.from('VERY_PRIVATE_OLD_CODE_CHANGED_9723')));
    assert.equal(fs.readdirSync(tempRoot).length,1);assert.deepEqual(fs.readdirSync(directory),['receipts.bin']);
    if(missing)fs.unlinkSync(file);else {content[40]^=0xff;fs.writeFileSync(file,content);}
    assert.throws(()=>ledger.run('a',{content:'VERY_PRIVATE_OLD_CODE_CHANGED_9723'},()=>{effects++;}),{code:'COMMAND_STORAGE_UNAVAILABLE'});
    assert.throws(()=>ledger.run('new',null,()=>{effects++;}),{code:'COMMAND_STORAGE_UNAVAILABLE'});
    assert.equal(effects,1);
  }
});

test('P1 storage: post-effect write failure preserves ALL pending outcomes bounded by maxPending; cleanup cannot replace them',async t=>{
  const {ledger,tempRoot,journal}=fixture(t,{maxPending:2});const a=deferred<number>(),b=deferred<number>();let effects=0;
  const x=ledger.run('a',1,()=>{effects++;return a.promise;}),y=ledger.run('b',1,()=>{effects++;return b.promise;});
  // Obstruct the actual path after admission, not a mocked fs/server.
  const file=journal();fs.unlinkSync(file);fs.mkdirSync(file);
  a.resolve(42);b.resolve(24);assert.deepEqual(await Promise.all([x.result,y.result]),[42,24]);
  assert.equal(await ledger.run('a',1,()=>0).result,42);assert.equal(await ledger.run('b',1,()=>0).result,24);
  assert.throws(()=>ledger.run('a',2,()=>0),{code:'IDEMPOTENCY_CONFLICT'});
  assert(fs.statSync(file).isDirectory(),'write failure is a real path obstruction, not byte-budget exhaustion');
  assert.deepEqual(fs.readdirSync(file),[]);
  assert.throws(()=>ledger.run('c',1,()=>{effects++;}),{code:'COMMAND_STORAGE_UNAVAILABLE'});assert.equal(effects,2);
  ledger.close();assert.deepEqual(fs.readdirSync(tempRoot),[]);
});

test('P1 outcomes: oversized/unserializable response stable failed receipt, never reexecution',async t=>{
  for(const result of ['x'.repeat(2048),{callback:()=>undefined}]) {
    const {ledger}=fixture(t,{maxOutcomeBytes:1024});let effects=0;
    const run=()=>ledger.run('a',{data:1},()=>{effects++;return result;});
    await assert.rejects(run().result,{status:503,code:'COMMAND_RESULT_UNAVAILABLE'});
    await assert.rejects(run().result,{status:503,code:'COMMAND_RESULT_UNAVAILABLE'});
    assert.throws(()=>ledger.run('a',{data:2},()=>{}),{code:'IDEMPOTENCY_CONFLICT'});
    assert.throws(()=>ledger.run('b',{},()=>{}),{code:'COMMAND_STORAGE_UNAVAILABLE'});assert.equal(effects,1);
  }
});

test('P1 outcomes: arbitrary errors retain safe fields only, no stack/cause/custom history or internal secrets',async t=>{
  const {ledger,journal}=fixture(t);let effects=0;
  const secret='RAW_ERROR_HISTORY_PRIVATE_7268';
  const err=Object.assign(new Error(secret,{cause:{content:secret.repeat(100000)}}),{payload:secret.repeat(100000),code:'IO_FAILURE',status:500,currentVersion:11});
  await assert.rejects(ledger.run('a',{},()=>{effects++;throw err;}).result,(error:any)=>{
    assert.equal(error.code,'IO_FAILURE');assert.equal(error.status,500);assert.equal(error.currentVersion,11);
    assert(!error.message.includes(secret));assert.equal(error.cause,undefined);assert.equal(error.payload,undefined);return true;
  });
  await assert.rejects(ledger.run('a',{},()=>{effects++;throw err;}).result,{code:'IO_FAILURE',status:500,currentVersion:11});
  assert.equal(effects,1);assert(!fs.readFileSync(journal()).includes(Buffer.from(secret)));
  assert(fs.statSync(journal()).size<2048,'terminal error must not store arbitrary Error properties');
});
