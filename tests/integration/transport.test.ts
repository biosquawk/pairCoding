import test from 'node:test';
import assert from 'node:assert/strict';
import { CommandLedger, canonical, validateMessage, validateRequest, apiError, TransportError } from '../../src/server/transport';

test('request schema rejects ownership spoofing, missing ids and invalid versions',()=>{
  const input={protocolVersion:'3.0',messageId:'msg-1',sessionId:'session-1',clientId:'client-1',type:'CODE_CHANGED',payload:{path:'solution.js',baseVersion:1,controlEpoch:0,content:'x',editKind:'TYPING'}};
  assert.equal(validateMessage(input),true);
  assert.equal(validateMessage({...input,payload:{...input.payload,writeOwner:'COACH'}}),false);
  assert.equal(validateMessage({...input,payload:{...input.payload,baseVersion:0}}),false);
  assert.equal(validateMessage({...input,messageId:''}),false);
  assert.equal(validateRequest('SessionCommand',{requestId:'r1',clientId:'c1',sessionId:'s1'}),true);
  assert.equal(validateRequest('SessionCommand',{requestId:'r1',clientId:'c1',sessionId:'s1',extra:true}),false);
});

test('idempotent concurrent retransmission has one effect; changed payload conflicts',async()=>{
  const ledger=new CommandLedger();let effects=0;
  const first=ledger.run('command',{b:1,a:2},async()=>{effects++;await new Promise(r=>setTimeout(r,5));return 123;});
  const repeat=ledger.run('command',{a:2,b:1},()=>{effects++;return 0;});
  assert.equal(first.duplicate,false);assert.equal(repeat.duplicate,true);
  assert.deepEqual(await Promise.all([first.result,repeat.result]),[123,123]);assert.equal(effects,1);
  assert.throws(()=>ledger.run('command',{a:2,b:3},()=>0),{code:'IDEMPOTENCY_CONFLICT',status:409});
});

test('failed effects remain failed and are not repeated',async()=>{
  const ledger=new CommandLedger();let attempts=0;
  const perform=()=>{attempts++;throw new TransportError(409,'STALE_EPOCH','Nieaktualna epoka');};
  await assert.rejects(ledger.run('id',{a:1},perform).result,{code:'STALE_EPOCH'});
  await assert.rejects(ledger.run('id',{a:1},perform).result,{code:'STALE_EPOCH'});
  assert.equal(attempts,1);
});

test('internal error does not leak path/token exception text',()=>{
  assert.equal(apiError(new Error('C:/secret bearer private')).message.includes('private'),false);
  assert.equal(apiError(new TransportError(403,'PATH_FORBIDDEN','Niedozwolona ścieżka')).code,'PATH_FORBIDDEN');
  assert.equal(canonical({b:[2],a:1}),canonical({a:1,b:[2]}));
});
