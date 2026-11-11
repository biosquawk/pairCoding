/** Finite real-heap probe. No private-field introspection; never allocate an OOM workload. */
import assert from 'node:assert/strict';
import { randomBytes, createHash } from 'node:crypto';
import { CommandLedger, TransportError } from '../../src/server/transport';

const MiB=1024*1024, count=192, chars=256*1024;
const mode=process.argv[2];
assert(['input','control','result','error','pending'].includes(mode));
assert(global.gc,'requires --expose-gc');
const ledger=new CommandLedger(),held:string[]=[];
async function collect() {
  for(let i=0;i<5;i++){global.gc!();await new Promise<void>(r=>setImmediate(r));}
  return process.memoryUsage();
}
// Warm real hashing/canonicalization/promise path before comparing heapUsed.
for(let i=0;i<8;i++)await ledger.run('warm-'+i,{content:'warm'},()=>i).result;
const baseline=await collect();
let firstHash='';
const digest=(s:string)=>createHash('sha256').update(s).digest('hex');
async function command(i:number) {
  const content=randomBytes(chars*3/4).toString('base64');
  assert.equal(content.length,chars);
  // Control uses the same canonical-history shape as the known defect, on purpose.
  if(mode==='result') {
    const value=await ledger.run('result-'+i,{index:i},()=>({content:JSON.parse(JSON.stringify(content))})).result;
    assert.equal(value.content.length,chars);if(i===0)firstHash=digest(value.content);
  } else if(mode==='error') {
    const message=JSON.parse(JSON.stringify(content));if(i===0)firstHash=digest(message);
    await assert.rejects(ledger.run('error-'+i,{index:i},()=>{throw new TransportError(409,'QA_LARGE_ERROR',message);}).result,{status:409,code:'QA_LARGE_ERROR',message});
  } else if(mode==='control')held.push(JSON.stringify({type:'CODE_CHANGED',payload:{content}}));
  else assert.equal(await ledger.run('edit-'+i,{type:'CODE_CHANGED',payload:{path:'solution.js',content,baseVersion:i+1}},()=>i+2).result,i+2);
}
let pendingPeak:number|null=null;
if(mode==='pending') {
  let release!:()=>void;
  const barrier=new Promise<void>(r=>release=r),waiters:Promise<number>[]=[];
  function launch(i:number) {
    const content=JSON.parse(JSON.stringify(randomBytes(6*MiB*3/4).toString('base64'))) as string;
    return ledger.run('pending-'+i,{type:'CODE_CHANGED',content},async()=>{await barrier;return content.length;}).result;
  }
  for(let i=0;i<8;i++)waiters.push(launch(i));
  await new Promise<void>(r=>setImmediate(r));pendingPeak=(await collect()).heapUsed-baseline.heapUsed;
  assert(pendingPeak>24*MiB,'positive pending control must actually hold the live inputs');
  release();assert.deepEqual(await Promise.all(waiters),Array(8).fill(6*MiB));
} else for(let i=0;i<count;i++)await command(i);
if(mode==='result') {
  const replay=ledger.run<{content:string}>('result-0',{index:0},()=>{throw new Error('result repeated');});
  assert.equal(replay.duplicate,true);assert.equal(digest((await replay.result).content),firstHash);
}
if(mode==='error')await assert.rejects(ledger.run('error-0',{index:0},()=>{throw new Error('failure repeated');}).result,(e:any)=>e.status===409&&e.code==='QA_LARGE_ERROR'&&digest(e.message)===firstHash);
const final=await collect(),retained=final.heapUsed-baseline.heapUsed;
console.log(JSON.stringify({mode,count:mode==='pending'?8:count,chars:mode==='pending'?6*MiB:chars,totalHistoryBytes:count*chars,baseline,final,retained,pendingPeak,threshold:24*MiB,heapLimitMiB:192}));
// Read survivors after GC: neither the live ledger nor the control may be optimized away.
if(mode==='control')assert.equal(held.length,count);
else assert.equal((await ledger.run('warm-0',{content:'warm'},()=>{throw new Error('replayed effect');}).result),0);
if(mode==='control')assert(retained>24*MiB,`control must expose retained full history, saw ${retained}`);
else assert(retained<24*MiB,`settled ${mode} history retains ${retained} bytes; expected <24MiB for48MiB historical text`);

await (ledger as any).close?.();
