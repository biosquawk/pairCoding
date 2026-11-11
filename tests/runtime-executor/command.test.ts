import {
  test
} from 'node:test';
import assert from 'node:assert/strict';
import {
  fixture
} from './fixtures';
import {
  canonicalJson
} from '../../src/server/execution/files';
import {
  validateRuntimeCommand
} from '../../src/server/execution/RuntimeCommand';
const cases:Record<string,(p:any,s:any)=>void>={
  'wrong family':(p,s)=>{
    s.family='python';
  }, 'wrong release':(p,s)=>{
    s.release=21;
  }, 'wrong preview':(p,s)=>{
    s.preview=true;
  }, 'wrong run':(p,s)=>{
    s.runId='other';
  }, 'wrong manifest':(p,s)=>{
    s.manifestSha256='0'.repeat(64);
  }, 'wrong mode':(p,s)=>{
    s.mode='RUN_MAIN';
  }, 'hierarchical cache':(p,s)=>{
    s.cache='/cache/node/hash/deps';
  }, 'untrusted field':(p,s)=>{
    s.args=['--eval','evil'];
  }, 'nested task command':(p,s)=>{
    s.task.executable='node';
  }, 'selector flag':(p,s)=>{
    s.task.tests.names=['--inspect'];
  }, 'selector shell':(p,s)=>{
    s.task.tests.names=['name;echo injected'];
  }, 'traversal selector':(p,s)=>{
    s.task.tests.paths=['../private'];
  }, 'cwd traversal':(p,s)=>{
    s.task.workingDirectory='../private';
  }, 'unsupported service':(p,s)=>{
    p.service={
      containerPort:8080,bindHost:'127.0.0.1',healthPath:'/health',readinessTimeoutMs:100
    };
  }, 'RW cache':(p,s)=>{
    p.caches[0].readOnly=false;
  }, 'missing cache':(p,s)=>{
    p.caches=[];
  }, 'extra cache':(p,s)=>{
    p.caches.push({
      ...p.caches[0]
    });
  }, 'altered env':(p,s)=>{
    p.command.environment.LANG='en_US.UTF-8';
  }, 'missing env':(p,s)=>{
    delete p.command.environment.CI;
  }, 'extra env':(p,s)=>{
    p.command.environment.NODE_OPTIONS='--inspect';
  }, 'legacy cwd':(p,s)=>{
    p.command.workingDirectory='/build';
  }, 'task cwd in plan':(p,s)=>{
    p.command.workingDirectory='/workspace/subdir';
  }, 'unknown schema':(p,s)=>{
    s.schemaVersion=2;
  },
};
for(const [name,mutate]of Object.entries(cases))test(`UNIT independent dispatcher grammar rejects ${name}`,async()=>{
  const f=await fixture();
  try{
    const p=structuredClone(f.plan),s=structuredClone(f.spec);
    mutate(p,s);
    p.command.args=[p.command.args[0],Buffer.from(canonicalJson(s)).toString('base64url')];
    assert.throws(()=>validateRuntimeCommand(p),/TASK_CONFIG_INVALID/);
  }finally{
    await f.cleanup();
  }
});
test('UNIT independent dispatcher grammar: canonical positive, malformed/duplicate/noncanonical UTF8 and exact argv bounds',async()=>{
  const f=await fixture();
  try{
    assert.deepEqual(validateRuntimeCommand(f.plan),f.spec);
    const encoded=f.plan.command.args[1];
    const bad=[encoded+'=',encoded+'+',Buffer.from(JSON.stringify(f.spec,null,2)).toString('base64url'),Buffer.from('{"mode":"RUN_TESTS",'+canonicalJson(f.spec).slice(1)).toString('base64url'),Buffer.from([0xff,0xfe]).toString('base64url'),'a'.repeat(4097)];
    for(const value of bad){
      const p=structuredClone(f.plan);
      p.command.args=[p.command.args[0],value];
      assert.throws(()=>validateRuntimeCommand(p),/TASK_CONFIG_INVALID/);
    }
    for(const argv of [[f.plan.command.args[0],encoded,'--eval'],['--eval',encoded],['/workspace/fake-runtime-task.mjs',encoded]]){
      const p=structuredClone(f.plan);
      p.command.args=argv;
      assert.throws(()=>validateRuntimeCommand(p),/TASK_CONFIG_INVALID/);
    }
    const p=structuredClone(f.plan);
    p.command.executable='/usr/bin/node';
    assert.throws(()=>validateRuntimeCommand(p),/TASK_CONFIG_INVALID/);
  }finally{
    await f.cleanup();
  }
});
