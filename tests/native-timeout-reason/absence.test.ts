/** Source-bound UNIT: compile ONLY unchanged inline LIVE absence assertions; no Docker operation. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import type { DockerReply } from '../../src/server/execution/DockerTransport';
const source=fs.readFileSync(new URL('../../tests/runner-fixture-migration/live.ts',import.meta.url),'utf8');
const begin="const absence=await f.live.run(['container','inspect',id]);";
assert.equal(source.split(begin).length,2);
const assertions=source.split(begin)[1].split('\n  }')[0];
const actual=new Function('assert','absence','id',assertions).bind(null,assert) as (reply:DockerReply,id:string)=>void;
const target='c'.repeat(64);
const reply=(stdout:string,stderr=`Error response from daemon: No such container: ${target}`,exitCode=1):DockerReply=>({stdout,stderr,exitCode});
for(const stdout of ['', '\n', '[]', '[]\r\n'])test(`exact Docker named absence allows ${JSON.stringify(stdout)} only with exit1 + exact target error`,()=>{
  actual(reply(stdout),target);
  actual(reply(stdout,`Error: No such container: ${target}\r\n`),target);
});
for(const [label,value]of [
  ['exit0',reply('[]',undefined,0)],['other-exit',reply('[]',undefined,2)],
  ['nonempty-JSON',reply('[{}]')],['noncanonical-empty',reply('[ ]')],['object',reply('{}')],['null',reply('null')],
  ['garbage',reply('[] broken')],['daemonfailure',reply('[]','Cannot connect to the Docker daemon')],
  ['timeout-as-absence',reply('[]','Docker command timed out',124)],['wrong-target',reply('[]','Error: No such container: foreign')],
  ['extra-error',reply('[]',`Error: No such container: ${target}\npermission denied`)],['no-error',reply('[]','')],
] as const)test(`exact absence rejects ${label}`,()=>{assert.throws(()=>actual(value,target));});

test('physical exit/namespace, ID+name and sentinel gates remain present around absence predicate',()=>{
  // Structural invariant only, NOT a physical Docker proof; native execution remains ROOT-owned.
  const proof=source.indexOf("assert.equal(v.State.Running,false);assert.ok(['exited','dead'].includes(String(v.State.Status)))");
  const namespace=source.indexOf('assert.notEqual(entry.exitCode,0);assert.match(entry.stderr,/not running/i)');
  const removal=source.indexOf('removals.push({id:args[1],inspection:v})');
  assert.ok(proof>=0 && namespace>proof && removal>namespace);
  const status=source.indexOf("assert.equal(result.status,action==='STOP'?'CANCELLED':'TIMED_OUT')");
  const removed=source.indexOf('assert.ok(f.live.removals.some(p=>p.id===record.containerId))');
  const both=source.indexOf('for(const id of [record.containerId,record.ownership.containerName])');
  const absence=source.indexOf(begin);const sentinel=source.indexOf('const controlProof=await inspect');
  assert.ok(status>=0 && removed>status && both>removed && absence>both && sentinel>absence);
});
