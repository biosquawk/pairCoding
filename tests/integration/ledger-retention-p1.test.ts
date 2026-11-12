import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// The parent never allocates the workload; child has a 64 MiB heap and finite input.
for(const mode of ['inputs','outcomes']) test(`P1 retention: completed 96 MiB ${mode} history survives a bounded child heap and replays once`, {timeout:30000}, async () => {
  const child=spawn(process.execPath,['--max-old-space-size=64','--expose-gc','--import','tsx',
    fileURLToPath(new URL('./ledger-memory-p1-child.ts',import.meta.url)),mode],{stdio:['ignore','pipe','pipe']});
  let stdout='',stderr='';
  child.stdout.on('data',chunk=>stdout+=chunk);child.stderr.on('data',chunk=>stderr+=chunk);
  const guard=setTimeout(()=>child.kill('SIGKILL'),25000);
  const result=await new Promise<{code:number|null;signal:NodeJS.Signals|null}>((resolve,reject)=>{
    child.once('error',reject);child.once('close',(code,signal)=>resolve({code,signal}));
  }).finally(()=>clearTimeout(guard));
  assert.equal(result.code,0,JSON.stringify({result,stdout,stderr}));
  const evidence=JSON.parse(stdout.trim().split('\n').at(-1)!);
  assert.equal(evidence.commands,384);assert.equal(evidence.effects,384);
  assert(evidence.retainedHeap<16*1024*1024);
  console.log('P1_RETENTION '+JSON.stringify(evidence));
});
