/** Exercise real DockerCliTransport argument/environment composition, never a host command. */
import assert from 'node:assert/strict';
import type { TestContext } from 'node:test';
import childProcess, { ChildProcess, type SpawnOptions } from 'node:child_process';
import { PassThrough } from 'node:stream';
import { syncBuiltinESMExports } from 'node:module';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { DockerCliTransport } from '../../src/server/execution/DockerTransport';

export async function literalTransport(t:TestContext):Promise<void> {
  const config=await fs.mkdtemp(path.join(os.tmpdir(),'runner-empty-docker-config-'));
  const before=process.env.PAIRCOACH_TEST_API_KEY;
  process.env.PAIRCOACH_TEST_API_KEY='fixture-not-real-key';
  const calls:{file:string;args:readonly string[];options:SpawnOptions}[]=[];
  const mock=t.mock.method(childProcess,'spawn',(file:string,args:readonly string[],options:SpawnOptions)=>{
    calls.push({file,args,options});
    const child=new ChildProcess();child.stdout=new PassThrough();child.stderr=new PassThrough();
    setImmediate(()=>{child.stdout?.emit('data',Buffer.from('transport bytes'));child.emit('close',0,null);});
    return child;
  });
  syncBuiltinESMExports();
  try {
    const transport=new DockerCliTransport('/approved/docker',{PATH:'/approved/bin',DOCKER_CONFIG:config});
    const literal=['exec','owned-container','/approved/node',';echo NOT_A_SHELL'];
    const result=await transport.run(literal);
    assert.deepEqual(result,{exitCode:0,stdout:'transport bytes',stderr:''});
    assert.equal(calls.length,1);assert.equal(calls[0].file,'/approved/docker');
    assert.deepEqual(calls[0].args,literal);assert.equal(calls[0].options.shell,false);
    assert.deepEqual(calls[0].options.env,{PATH:'/approved/bin',DOCKER_CONFIG:config});
    assert.equal(Object.hasOwn(calls[0].options.env??{},'PAIRCOACH_TEST_API_KEY'),false);
    assert.doesNotMatch(JSON.stringify(calls[0]),/fixture-not-real-key|LEAK/);
  } finally {
    mock.mock.restore();syncBuiltinESMExports();
    if(before===undefined)delete process.env.PAIRCOACH_TEST_API_KEY;else process.env.PAIRCOACH_TEST_API_KEY=before;
    await fs.rm(config,{recursive:true,force:true});
  }
}
