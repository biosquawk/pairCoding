/** Finite payload history under a small real V8 heap; no inspection of ledger private fields. */
import { randomBytes } from 'node:crypto';
import { CommandLedger } from '../../src/server/transport';
import assert from 'node:assert/strict';

const ledger = new CommandLedger();
const gc = (globalThis as typeof globalThis & {gc?:()=>void}).gc;
assert(gc, 'child must expose actual GC');
gc();
const before = process.memoryUsage();
let effects = 0;
const outcomes=process.argv[2]==='outcomes';
let first: {content:string;index:number}|undefined;
let firstResult:unknown;
for (let index=0;index<384;index++) {
  // New incompressible contents, 256 KiB each: a finite 96 MiB historical workload.
  const input={index,content:randomBytes(128*1024).toString('hex')};
  if(!index) first=input;
  const command=outcomes ? {index} : input;
  const op=ledger.run(`memory-${index}`, command, ()=>{effects++;return outcomes ? input : index;});
  const result=await op.result;
  if(!index) firstResult=result;
  assert.deepEqual(result,outcomes ? input : index);
}
const replay=ledger.run('memory-0',outcomes ? {index:0}:first,()=>{effects++;return -1;});
assert.equal(replay.duplicate,true);assert.deepEqual(await replay.result,firstResult);
assert.equal(effects,384);
assert.throws(()=>ledger.run('memory-0',{...first,content:first!.content+'changed-tail'},()=>-1),{code:'IDEMPOTENCY_CONFLICT'});
gc();
const after=process.memoryUsage();
console.log(JSON.stringify({mode:outcomes?'outcomes':'inputs',before,after,retainedHeap:after.heapUsed-before.heapUsed,effects,commands:384,payloadBytes:384*256*1024}));
assert(after.heapUsed-before.heapUsed<16*1024*1024,'completed payload history must not remain in the process heap');
if ('close' in ledger) await (ledger as any).close();
