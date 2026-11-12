import {
  test
} from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {
  fixture,profile
} from './fixtures';
import {
  DockerCliTransport
} from '../../src/server/execution/DockerTransport';
import type {
  ExecutionPlan
} from '../../src/server/execution/ports';
const invalid:Record<string,(p:any)=>void>={
  'host shell':p=>{
    p.command.executable='/bin/sh';
    p.command.args=['-c','echo unsafe'];
  }, 'secret env':p=>{
    p.command.environment.GEMINI_API_KEY='do-not-forward';
  }, 'arbitrary tool argv':p=>{
    p.command.args=['--eval','bad'];
  }, 'mount injection':p=>{
    p.input.buildDirectory='/tmp,readonly';
  }, 'foreign installation':p=>{
    p.ownership.installationId='foreign';
  }, 'LSP name':p=>{
    p.ownership.containerName='paircoach-lsp';
  }, 'image substitution':p=>{
    p.ownership.imageId='sha256:'+'0'.repeat(64);
  }, 'privileged user':p=>{
    p.isolation.nonRootUser='0:0';
  }, 'root writable':p=>{
    p.isolation.readOnlyRoot=false;
  }, 'egress network':p=>{
    p.isolation.network='host';
  }, 'working path escape':p=>{
    p.command.workingDirectory='/workspace/../../home';
  }, 'unbounded CPU':p=>{
    p.resources.cpus=128;
  }, 'unbounded timeout':p=>{
    p.timeoutMs=3600001;
  }, 'foreign cache':p=>{
    p.caches=[{
      directory:'/home',family:'node',toolchainHash:'a'.repeat(64),dependencyHash:'b'.repeat(64),readOnly:false
    }];
  }, 'host service binding':p=>{
    p.service={
      containerPort:8080,bindHost:'0.0.0.0',healthPath:'/health',readinessTimeoutMs:100
    };
    p.mode='RUN_MAIN';
    p.isolation.network='loopback';
  }, 'metadata tamper':p=>{
    p.input.identity.manifestSha256='0'.repeat(64);
  },
};
for(const [name,mutate] of Object.entries(invalid))test(`UNIT policy: deny ${name} before Docker create`,async()=>{
  const f=await fixture();
  try{
    const p=structuredClone(f.plan);
    mutate(p);
    await assert.rejects(f.executor.start(p));
    assert.ok(!f.fake.calls.some(c=>c[0]==='create'));
  }finally{
    await f.cleanup();
  }
});
test('UNIT policy: altered sealed source, stale build/report, unknown profile and daemon/image absent fail closed',async()=>{
  const f=await fixture();
  try{
    f.fake.daemon=false;
    assert.equal((await f.executor.readiness(profile,'config1')).modes.RUN_MAIN.problem!.code,'DAEMON_UNAVAILABLE');
    f.fake.daemon=true;
    f.fake.imagePresent=false;
    assert.equal((await f.executor.readiness(profile,'config1')).modes.RUN_TESTS.problem!.code,'IMAGE_MISSING');
    assert.equal((await f.executor.readiness({
      ...profile,id:'unknown'
    },'config1')).modes.RUN_TESTS.problem!.code,'RUNTIME_CONFIG_INVALID');
    f.fake.imagePresent=true;
    await fs.writeFile(path.join(f.input.artifactsDirectory,'stale.xml'),'stale');
    await assert.rejects(f.executor.start(f.plan),/fresh/);
    await fs.unlink(path.join(f.input.artifactsDirectory,'stale.xml'));
    const source=path.join(f.input.immutableDirectory,'main.js');
    await fs.chmod(source,0o600);
    await fs.writeFile(source,'tampered');
    await assert.rejects(f.executor.start(f.plan),/Immutable input changed/);
    assert.ok(!f.fake.calls.some(c=>c[0]==='create'));
  }finally{
    await f.cleanup();
  }
});
test('UNIT journal: stale updates fail optimistic revision, run admission is exclusive',async()=>{
  const f=await fixture();
  try{
    const h=await f.executor.start(f.plan);
    const a=await f.journal.read(h.runId),b=await f.journal.read(h.runId);
    a.phase='STOP_UNCONFIRMED';
    await f.journal.update(a);
    b.phase='EXITED';
    await assert.rejects(f.journal.update(b),/Concurrent journal revision/);
    assert.equal((await f.journal.read(h.runId)).phase,'STOP_UNCONFIRMED');
  }finally{
    await f.cleanup();
  }
});
test('UNIT CLI transport uses explicit env (no inherited secret), shell:false argv; bounded output/timeout errors UNKNOWN',async()=>{
  assert.throws(()=>new DockerCliTransport('/bin/false',{
    SESSION_TOKEN:'secret'
  }),/environment/);
  const f=await fixture();
  try{
    const config=path.join(f.root,'docker-config');
    await fs.mkdir(config);
    const cli=new DockerCliTransport(process.execPath,{
      DOCKER_CONFIG:config
    });
    const r=await cli.run(['--eval','process.stdout.write(JSON.stringify({secret:process.env.SESSION_TOKEN??null,arg:process.argv[1]}))','x;echo injected']);
    assert.equal(r.exitCode,0);
    assert.deepEqual(JSON.parse(r.stdout),{
      secret:null,arg:'x;echo injected'
    });
    await assert.rejects(cli.run(['--eval','process.stdout.write("x".repeat(10000))'],{
      maxBytes:100
    }),/UNKNOWN/);
    await assert.rejects(cli.run(['--eval','setTimeout(()=>{},10000)'],{
      timeoutMs:30
    }),/UNKNOWN/);
    await fs.writeFile(path.join(config,'config.json'),'{"auths":{"private":{}}}');
    await assert.rejects(cli.run(['--version']),/credential-free/);
  }finally{
    await f.cleanup();
  }
});
test('UNIT readiness: missing approved cache requires explicit prepare, no image pull or create',async()=>{
  const f=await fixture();
  try{
    await fs.rm(f.plan.caches[0].directory,{
      recursive:true
    });
    const ready=await f.executor.readiness(profile,'config1');
    assert.equal(ready.modes.RUN_MAIN.canRun,false);
    assert.equal(ready.modes.RUN_MAIN.problem!.code,'PREPARE_REQUIRED');
    assert.ok(!f.fake.calls.some(a=>['create','pull','run'].includes(a[0])));
  }finally{
    await f.cleanup();
  }
});
