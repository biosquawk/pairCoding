/** HUMAN b25a9d79: projection contract only; fabricated errors are not storage integration. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {apiError, TransportError} from '../../src/server/transport';

const codes=['COMMAND_RESULT_UNAVAILABLE','COMMAND_STORAGE_UNAVAILABLE'] as const;
const secret='QA_SECRET_MUST_NOT_ESCAPE_7ae213';
import {assertAmbiguousMessage} from '../qa/ledger-failure-oracle';

for(const code of codes) {
  test(`projection ${code}: safe actionable UNKNOWN warning, not automatic retry`,()=>{
    const value=apiError(new TransportError(503,code,'arbitrary untrusted exception text'),'qa-request');
    assert.equal(value.code,code);assert.equal(value.requestId,'qa-request');
    assertAmbiguousMessage(value.message);assert.equal(value.retryable,false);
  });
  test(`projection ${code}: even a reserved code cannot expose arbitrary message/stack/cause/path`,()=>{
    const error=Object.assign(new TransportError(503,code,`${secret} /private/qa/receipt C:\\private\\receipt`),{
      stack:secret+' stack',cause:new Error(secret+' cause'),details:{token:secret},currentVersion:null,
    });
    const value=apiError(error,'qa-redaction'),wire=JSON.stringify(value);
    assert(!wire.includes(secret));assert(!wire.includes('/private/'));assert(!wire.includes('C:\\\\private'));
    assert.deepEqual(Object.keys(value).sort(),['code','currentVersion','message','requestId','retryable'].sort());
    assertAmbiguousMessage(value.message);assert.equal(value.retryable,false);
  });
}
test('projection negative control: generic5xx still redacts exception details; ordinary409 retains its contract',()=>{
  const value=apiError(Object.assign(new Error(secret+' /private/receipt'),{status:503,code:'UNRELATED_503',cause:secret}));
  assert(!JSON.stringify(value).includes(secret));assert(!value.message.includes('/private/receipt'));
  const conflict=apiError(Object.assign(new TransportError(409,'VERSION_CONFLICT','Jawny konflikt wersji.'),{currentVersion:7}),'request409');
  assert.deepEqual(conflict,{code:'VERSION_CONFLICT',message:'Jawny konflikt wersji.',retryable:false,requestId:'request409',currentVersion:7});
});
