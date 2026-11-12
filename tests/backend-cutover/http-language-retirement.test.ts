import test from 'node:test';
import assert from 'node:assert/strict';
import {httpLanguage,until} from './http-language-owner-fixture';

test('HTTP LANG uncertain reconnect retirement retains SAME owner and blocks replacement; next explicit HELLO reconciles it',async t=>{
  const f=await httpLanguage(t),p=f.peer,d=f.document(p);p.send('LANGUAGE_OPEN',d);
  await until(()=>f.driver.frames.filter(m=>m.method==='textDocument/didOpen').length>=2,'Both original HTTP lanes sent A');
  const creates=f.driver.commands.filter(a=>a[0]==='create').length;
  f.driver.unreachable=true;
  const next=await f.connect();
  assert.equal(next.snapshot.payload.languageBootstrap,null);assert.equal(next.snapshot.payload.project.capabilities.language.state,'FAILED');
  assert.equal(next.snapshot.payload.project.capabilities.language.problem.code,'PROCESS_STOP_UNCONFIRMED');
  assert.equal(f.driver.commands.filter(a=>a[0]==='create').length,creates,'No owner replacement or automatic retry on uncertainty');
  const id=next.send('CODE_CHANGED',{path:f.path,baseVersion:1,content:'manual during language outage\n',editKind:'TYPING',controlEpoch:f.app.session.state.controlEpoch});
  const ack=await next.wait(m=>m.type==='ACK'&&m.payload.replyTo===id);assert.equal(ack.payload.status,'OK');
  f.driver.unreachable=false;
  const reconciled=await f.connect();
  assert.ok(reconciled.snapshot.payload.languageBootstrap);
  assert.notEqual(reconciled.snapshot.payload.languageBootstrap.shadowGeneration,p.snapshot.payload.languageBootstrap.shadowGeneration);
  assert.notEqual(reconciled.snapshot.payload.project.capabilities.language.providerGeneration,p.snapshot.payload.project.capabilities.language.providerGeneration);
  await until(()=>f.driver.commands.filter(a=>a[0]==='create').length>creates,'Explicit reconnect creates new scope ONLY after exact previous owners retire');
});
