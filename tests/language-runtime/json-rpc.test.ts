import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { JsonRpcTransport, RpcRemoteError } from '../../src/server/language/JsonRpcTransport';
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
function frame(message: unknown): Buffer { const body=Buffer.from(JSON.stringify(message));return Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`),body]); }
function peer(options: Partial<ConstructorParameters<typeof JsonRpcTransport>[2]> = {}) {
  const input=new PassThrough(),output=new PassThrough(),sent: any[]=[],errors:Error[]=[];let buffer=Buffer.alloc(0);
  output.on('data',chunk=>{buffer=Buffer.concat([buffer,chunk]);for(;;){const i=buffer.indexOf('\r\n\r\n');if(i<0)return;const n=Number(/Content-Length: (\d+)/.exec(buffer.subarray(0,i).toString())![1]);if(buffer.length<i+4+n)return;sent.push(JSON.parse(buffer.subarray(i+4,i+4+n).toString()));buffer=buffer.subarray(i+4+n);}});
  const rpc=new JsonRpcTransport(input,output,{connectionId:'test_connection',onClosed:e=>errors.push(e),...options});
  return {input,output,rpc,sent,errors,send:(m:unknown)=>input.write(frame(m))};
}
test('unit framing: UTF8 Content-Length, split headers/body and multiple frames',async()=>{
  const p=peer(),notes:any[]=[];p.rpc.subscribe(n=>notes.push(n));const a=frame({jsonrpc:'2.0',method:'language/status',params:'żółć 😀'});
  for(const b of a)p.input.write(Buffer.from([b]));p.input.write(Buffer.concat([a,a]));assert.equal(notes.length,3);assert.equal(notes[0].params,'żółć 😀');p.rpc.close();
});
test('request exact sent ID only; unknown/duplicate/late responses dropped',async()=>{
  const p=peer(),q=p.rpc.request('textDocument/completion',{textDocument:{uri:'file:///workspace/A.java'}});await tick();assert.equal(p.sent.length,1);
  p.send({jsonrpc:'2.0',id:'unknown:1',result:['unsafe']});assert.equal(p.rpc.pendingCount,1);
  p.send({jsonrpc:'2.0',id:p.sent[0].id,result:{items:[{label:'actual'}]}});assert.deepEqual(await q,{items:[{label:'actual'}]});
  p.send({jsonrpc:'2.0',id:p.sent[0].id,result:{items:[{label:'old'}]}});assert.equal(p.rpc.pendingCount,0);p.rpc.close();
});
test('abort before send and after sent request; cancellation is advisory, late result drops',async()=>{
  const p=peer(),a=new AbortController();a.abort();await assert.rejects(p.rpc.request('initialize',{}, {signal:a.signal}),{name:'AbortError'});assert.equal(p.sent.length,0);
  const b=new AbortController(),q=p.rpc.request('textDocument/completion',{}, {signal:b.signal});const rejected=assert.rejects(q,{name:'AbortError'});await tick();const id=p.sent[0].id;b.abort();await rejected;await tick();
  assert.equal(p.sent.at(-1).method,'$/cancelRequest');assert.equal(p.rpc.pendingCount,0);p.send({jsonrpc:'2.0',id,result:{items:[]}});assert.equal(p.rpc.closed,false);p.rpc.close();
});
test('cancelled queued request is not sent',async()=>{
  const p=peer(),a=new AbortController(),q=p.rpc.request('initialize',{}, {signal:a.signal}),rejected=assert.rejects(q,{name:'AbortError'});a.abort();await rejected;await tick();assert.equal(p.sent.length,0);p.rpc.close();
});
test('request deadline does not grant late replies',async()=>{
  const p=peer(),q=p.rpc.request('shutdown',{}, {timeoutMs:5});await assert.rejects(q,/deadline/);await tick();assert.equal(p.rpc.pendingCount,0);assert.equal(p.sent.at(-1).method,'$/cancelRequest');p.rpc.close();
});
test('server applyEdit unconditionally denied, never delegated to injected callback',async()=>{
  let calls=0;const p=peer({configuration:()=>{calls++;return {applied:true};}});
  p.send({jsonrpc:'2.0',id:33,method:'workspace/applyEdit',params:{edit:{changes:{'file:///workspace/A.java':[]}}}});await tick();assert.equal(calls,0);assert.equal(p.sent[0].result.applied,false);p.rpc.close();
});
test('unsupported server executeCommand denied, only fixed configuration delegated',async()=>{
  const p=peer({configuration:method=>method==='workspace/configuration'?[{safe:true}]:[]});
  p.send({jsonrpc:'2.0',id:1,method:'workspace/executeCommand',params:{command:'arbitrary'}});
  p.send({jsonrpc:'2.0',id:2,method:'workspace/configuration',params:{items:[]}});await tick();assert.equal(p.sent[0].error.code,-32601);assert.deepEqual(p.sent[1].result,[{safe:true}]);p.rpc.close();
});
test('no execute/resolve/workspace writes in client request allowlist',async()=>{
  const p=peer();for(const method of ['workspace/executeCommand','completionItem/resolve','workspace/applyEdit'])await assert.rejects(p.rpc.request(method as any,{}),/Forbidden/);await assert.rejects(p.rpc.notify('workspace/applyEdit' as any,{}),/Forbidden/);assert.equal(p.sent.length,0);p.rpc.close();
});
test('reject duplicate, oversized, negative and missing Content-Length',()=>{
  for(const text of ['Content-Length: 2\r\nContent-Length: 2\r\n\r\n{}','Content-Length: 262145\r\n\r\n','Content-Length: -1\r\n\r\n','Content-Type: application/json\r\n\r\n','x'.repeat(8193)]){const p=peer();p.input.write(text);assert.equal(p.rpc.closed,true);assert.equal(p.errors.length,1);}
});
test('invalid UTF8, arrays, wrong protocol and mixed envelopes fail closed',()=>{
  const invalidUtf8=Buffer.concat([Buffer.from('Content-Length: 2\r\n\r\n'),Buffer.from([0xc3,0x28])]);
  for(const bad of [invalidUtf8,frame([]),frame({jsonrpc:'1.0',method:'test'}),frame({jsonrpc:'2.0',id:1,method:'test',result:1}),frame({jsonrpc:'2.0',id:1,result:1,error:{}})]){const p=peer();p.input.write(bad);assert.equal(p.rpc.closed,true);}
});
test('remote error retains code but cannot resolve a request as success',async()=>{
  const p=peer(),q=p.rpc.request('initialize',{}),rejected=assert.rejects(q,(e:RpcRemoteError)=>e.code===-32000&&e.message==='native failure');await tick();p.send({jsonrpc:'2.0',id:p.sent[0].id,error:{code:-32000,message:'native failure'}});await rejected;p.rpc.close();
});
test('transport closure rejects pending, cannot be mistaken for confirmed process exit',async()=>{
  const p=peer(),q=p.rpc.request('initialize',{}),rejected=assert.rejects(q,/Stop is not confirmed/);p.input.end();await rejected;assert.equal(p.errors.length,1);assert.equal(p.rpc.pendingCount,0);await assert.rejects(p.rpc.notify('exit',null));
});
test('closed connection does not deliver stale notifications/configuration replies',async()=>{
  let resolveConfig:(x:unknown)=>void=()=>{},calls=0;const p=peer({configuration:()=>new Promise(r=>{resolveConfig=r;})});p.rpc.subscribe(()=>calls++);
  p.send({jsonrpc:'2.0',id:2,method:'workspace/configuration',params:{}});p.rpc.close();resolveConfig([]);p.send({jsonrpc:'2.0',method:'textDocument/publishDiagnostics',params:{diagnostics:[]}});await tick();assert.equal(calls,0);assert.equal(p.sent.length,0);
});
test('outgoing body bound rejects without leaking pending request',async()=>{
  const p=peer();await assert.rejects(p.rpc.request('initialize',{large:'x'.repeat(8*1024*1024)}),/limit/);assert.equal(p.rpc.pendingCount,0);p.rpc.close();
});
test('configuration concurrency flood fails transport instead of unbounded pending callbacks',async()=>{
  const p=peer({configuration:()=>new Promise(()=>{})});for(let i=0;i<33;i++)p.send({jsonrpc:'2.0',id:i,method:'workspace/configuration',params:{}});await tick();assert.equal(p.rpc.closed,true);assert.match(p.errors[0].message,/concurrency/);
});
test('invalid connection/deadline rejected before writes',async()=>{
  assert.throws(()=>peer({connectionId:'bad:client-controlled'}));const p=peer();for(const timeoutMs of [0,30001,NaN,1.5])await assert.rejects(p.rpc.request('initialize',{}, {timeoutMs}),/deadline/);assert.equal(p.sent.length,0);p.rpc.close();
});
