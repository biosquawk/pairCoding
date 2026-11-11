import {
  test
} from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as http from 'node:http';
import {
  canonicalJson
} from '../../src/server/execution/files';
import {
  fixture,success,profile
} from './fixtures';
import {
  DockerExecutor,ExecutionUncertainError
} from '../../src/server/execution/DockerExecutor';
import type {
  DurableTerminalReceipt
} from '../../src/server/execution/ports';
test('UNIT fake Docker: durable intent precedes create, isolation argv independent build copy, output, exit→collect→terminal→nonforce exact rm',async()=>{
  const f=await fixture();
  try{
    f.fake.beforeCreate=async()=>{
      assert.equal((await f.journal.read('run1')).phase,'INTENT');
    };
    const h=await f.executor.start(f.plan);
    assert.equal((await f.journal.read(h.runId)).phase,'RUNNING');
    const argv=f.fake.calls.find(a=>a[0]==='create')!;
    for(const option of ['--pull=never','--cap-drop=ALL','--security-opt=no-new-privileges','--read-only','--pids-limit','--memory','--cpus','--entrypoint'])assert.ok(argv.includes(option));
    assert.ok(argv.includes('type=bind,source='+f.input.immutableDirectory+',target=/input,readonly'));
    assert.ok(!argv.join(' ').includes(f.workspace));
    assert.deepEqual(await fs.readdir(f.input.buildDirectory),['main.js','zażółć 😀.txt']);
    await fs.writeFile(path.join(f.input.buildDirectory,'main.js'),'changed only build');
    assert.equal(await fs.readFile(path.join(f.workspace,'main.js'),'utf8'),'console.log("ACK")\n');
    const output:string[]=[];
    const off=f.executor.subscribe(h,o=>output.push(o.text));
    f.fake.onStop=async()=>{
    };
    f.fake.finish();
    const exit=await f.executor.wait(h);
    assert.deepEqual(output,['actual task log\n']);
    off();
    await fs.writeFile(path.join(f.input.artifactsDirectory,'new.xml'),'<testsuite><testcase name="new"/></testsuite>');
    const c=await f.executor.collect(h,exit);
    assert.equal(c.files.length,1);
    assert.equal(c.files[0].freshForRun,true);
    assert.ok(!f.fake.calls.some(a=>a[0]==='rm'));
    const receipt=await f.executor.persistTerminal(h,success);
    assert.equal((await f.journal.read(h.runId)).phase,'TERMINAL');
    await f.executor.cleanup(receipt);
    assert.deepEqual(f.fake.calls.find(a=>a[0]==='rm'),['rm','c'.repeat(64)]);
    assert.equal((await f.journal.read(h.runId)).phase,'REMOVED');
    assert.deepEqual(await f.executor.inspectOwnedOrphans('install'),[]);
    await f.executor.cleanup(receipt);
  }finally{
    await f.cleanup();
  }
});
for(const kind of ['create','start','rm'] as const)test(`UNIT fake Docker: ${kind} lost response reconciles by exact read, no duplicate`,async()=>{
  const f=await fixture();
  try{
    if(kind==='create')f.fake.createThrowsAfterCommit=true;
    if(kind==='start')f.fake.startThrowsAfterCommit=true;
    const h=await f.executor.start(f.plan);
    assert.equal(f.fake.calls.filter(a=>a[0]==='create').length,1);
    assert.deepEqual(await f.executor.start(f.plan),h);
    assert.equal(f.fake.calls.filter(a=>a[0]==='create').length,1);
    await f.end(h);
    const receipt=await f.executor.persistTerminal(h,success);
    f.fake.rmThrowsAfterCommit=kind==='rm';
    await f.executor.cleanup(receipt);
    assert.equal(f.fake.calls.filter(a=>a[0]==='rm').length,1);
  }finally{
    await f.cleanup();
  }
});
test('UNIT fake Docker: daemon loss Stop retains same handle, fences new run, retry reads first and never targets control/LSP',async()=>{
  const f=await fixture();
  try{
    const h=await f.executor.start(f.plan);
    f.fake.daemon=false;
    const s=await f.executor.stop(h,'USER');
    assert.equal(s.confirmed,false);
    assert.equal((await f.journal.read(h.runId)).phase,'STOP_UNCONFIRMED');
    f.fake.daemon=true;
    const next=structuredClone(f.plan);
    next.ownership={
      ...next.ownership,runId:'run2',containerName:`paircoach-install-${profile.id}-run2`
    };
    next.input=await f.copy('run2');
    next.command.args=[next.command.args[0],Buffer.from(canonicalJson({
      ...f.spec,runId:'run2',manifestSha256:next.input.identity.manifestSha256
    })).toString('base64url')];
    await assert.rejects(f.executor.start(next),/still owns resources/);
    f.fake.stopThrowsAfterCommit=true;
    const retried=await f.executor.stop(h,'USER');
    assert.equal(retried.confirmed,true);
    assert.deepEqual(f.fake.calls.filter(a=>a[0]==='stop'),[['stop','--time','2','c'.repeat(64)]]);
    assert.ok(!f.fake.calls.some(a=>['kill','prune','ps'].includes(a[0])));
    assert.equal((await f.journal.read('run1')).handle.opaqueId,h.opaqueId);
  }finally{
    await f.cleanup();
  }
});
test('UNIT fake Docker: stopping still-running container is not success; wait timeout uses actual Stop',async()=>{
  const f=await fixture();
  try{
    const h=await f.executor.start(f.plan);
    f.fake.stopRemainsRunning=true;
    assert.equal((await f.executor.stop(h,'USER')).confirmed,false);
    f.fake.stopRemainsRunning=false;
    f.advance(1001);
    const exit=await f.executor.wait(h);
    assert.equal(exit.exitCode,137);
    assert.equal(f.fake.calls.filter(a=>a[0]==='stop').length,2);
  }finally{
    await f.cleanup();
  }
});
test('UNIT fake Docker: ownership/image/engine mismatches never stop/remove a foreign container',async()=>{
  const f=await fixture();
  try{
    const h=await f.executor.start(f.plan);
    f.fake.v.Config.Labels['paircoach.role']='lsp';
    assert.equal((await f.executor.stop(h,'USER')).confirmed,false);
    assert.ok(!f.fake.calls.some(a=>a[0]==='stop'||a[0]==='rm'));
    const orphan=await f.executor.inspectOwnedOrphans('install');
    assert.equal(orphan[0].state,'UNKNOWN');
    await assert.rejects(f.executor.inspectOwnedOrphans('foreign'));
    await assert.rejects(f.executor.wait({
      ...h,opaqueId:'forged'
    }));
  }finally{
    await f.cleanup();
  }
});
test('UNIT fake Docker: missing object without exit proof never fabricates Stop/collect/receipt',async()=>{
  const f=await fixture();
  try{
    const h=await f.executor.start(f.plan);
    f.fake.v=null;
    assert.equal((await f.executor.stop(h,'RECOVERY')).confirmed,false);
    await assert.rejects(f.executor.collect(h,{
      handle:h,exitCode:0,exitedAt:'2026-11-11T22:00:00Z'
    }));
    await assert.rejects(f.executor.persistTerminal(h,success));
  }finally{
    await f.cleanup();
  }
});
test('UNIT fake Docker: crash after create intent keeps recovery handle and prevents blind duplicate',async()=>{
  const f=await fixture();
  try{
    f.fake.beforeCreate=async()=>{
      throw new Error('daemon disconnected before response');
    };
    let h:any;
    await assert.rejects(f.executor.start(f.plan),e=>{
      assert.ok(e instanceof ExecutionUncertainError);
      h=e.handle;
      return true;
    });
    const orphan=await f.executor.inspectOwnedOrphans('install');
    assert.deepEqual(orphan[0].handle,h);
    assert.equal(orphan[0].state,'UNKNOWN');
    await assert.rejects(f.executor.start(f.plan),ExecutionUncertainError);
    assert.equal(f.fake.calls.filter(a=>a[0]==='create').length,1);
  }finally{
    await f.cleanup();
  }
});
test('UNIT fake Docker: cleanup refuses forged receipt, modified artifact/log/outcome; no early rm',async()=>{
  const f=await fixture();
  try{
    const h=await f.executor.start(f.plan);
    await f.end(h);
    await assert.rejects(f.executor.cleanup({
      handle:h
    } as DurableTerminalReceipt));
    const receipt=await f.executor.persistTerminal(h,success);
    await assert.rejects(f.executor.cleanup({
      ...receipt,collectionSha256:'0'.repeat(64)
    }));
    await assert.rejects(f.executor.persistTerminal(h,{
      ...success,status:'FAILED'
    }));
    await fs.writeFile(path.join(f.runs,'run1','collected','stdout.log'),'tampered');
    await assert.rejects(f.executor.cleanup(receipt),/digest/);
    assert.ok(!f.fake.calls.some(a=>a[0]==='rm'));
  }finally{
    await f.cleanup();
  }
});
test('UNIT fake Docker: artifacts symlink and oversize fail; retry partial collection permitted; nonzero exit cannot PASSED',async()=>{
  const f=await fixture();
  try{
    const h=await f.executor.start(f.plan);
    f.fake.finish(1);
    const exit=await f.executor.wait(h);
    await fs.symlink('/etc/passwd',path.join(f.input.artifactsDirectory,'bad.xml'));
    await assert.rejects(f.executor.collect(h,exit),/link/);
    await fs.unlink(path.join(f.input.artifactsDirectory,'bad.xml'));
    await fs.writeFile(path.join(f.input.artifactsDirectory,'big.xml'),Buffer.alloc(4*1024*1024+1));
    await assert.rejects(f.executor.collect(h,exit),/oversized/);
    await fs.unlink(path.join(f.input.artifactsDirectory,'big.xml'));
    await fs.writeFile(path.join(f.input.artifactsDirectory,'fresh.xml'),'<testsuite><testcase/></testsuite>');
    await f.executor.collect(h,exit);
    await assert.rejects(f.executor.persistTerminal(h,success),/False terminal success/);
    assert.ok(!f.fake.calls.some(a=>a[0]==='rm'));
  }finally{
    await f.cleanup();
  }
});
test('UNIT fake Docker: persisted terminal orphan survives a new executor, exact receipt cleanup only',async()=>{
  const f=await fixture();
  try{
    const h=await f.executor.start(f.plan);
    await f.end(h);
    const receipt=await f.executor.persistTerminal(h,success);
    const restarted=new DockerExecutor({
      policy:f.policy,transport:f.fake,journal:f.journal
    });
    const [orphan]=await restarted.inspectOwnedOrphans('install');
    assert.equal(orphan.state,'EXITED');
    assert.deepEqual(orphan.durableReceipt,receipt);
    await restarted.cleanup(orphan.durableReceipt!);
    assert.equal(f.fake.v,null);
  }finally{
    await f.cleanup();
  }
});
test('UNIT real loopback HTTP + fake Docker: stdout is not readiness, health is nonterminal; Stop requires endpoint unavailable',async()=>{
  const f=await fixture();
  let server:http.Server|undefined;
  try{
    server=http.createServer((req,res)=>{
      res.statusCode=req.url==='/health'?200:404;
      res.end('ok');
    });
    await new Promise<void>(r=>server!.listen(0,'127.0.0.1',r));
    f.fake.port=(server.address() as any).port;
    f.plan.mode='RUN_MAIN';
    f.plan.service={
      containerPort:8080,bindHost:'127.0.0.1',healthPath:'/health',readinessTimeoutMs:100
    };
    f.plan.isolation.network='loopback';
    setServiceFixture(f);
    const h=await f.executor.start(f.plan);
    const ready=await f.executor.serviceReadiness(h);
    assert.equal(ready!.ready,true);
    assert.equal((await f.journal.read(h.runId)).phase,'RUNNING');
    assert.equal((await f.executor.stop(h,'USER')).confirmed,false);
    await new Promise<void>(r=>server!.close(()=>r()));
    server=undefined;
    assert.equal((await f.executor.stop(h,'USER')).confirmed,true);
  }finally{
    if(server)await new Promise<void>(r=>server!.close(()=>r()));
    await f.cleanup();
  }
});
test('UNIT real loopback HTTP + fake Docker: unavailable endpoint never becomes ready from logs',async()=>{
  const f=await fixture();
  try{
    f.plan.mode='RUN_MAIN';
    f.plan.service={
      containerPort:8080,bindHost:'127.0.0.1',healthPath:'/health',readinessTimeoutMs:100
    };
    f.plan.isolation.network='loopback';
    f.fake.port=1;
    setServiceFixture(f);
    const h=await f.executor.start(f.plan);
    const ready=await f.executor.serviceReadiness(h);
    assert.equal(ready!.ready,false);
    assert.equal(ready!.problem!.code,'SERVICE_NOT_READY');
    assert.equal((await f.journal.read(h.runId)).phase,'RUNNING');
  }finally{
    await f.cleanup();
  }
});
test('UNIT fake Docker: never-started created container has no invented exit; retains scoped recovery fence',async()=>{
  const f=await fixture();
  try{
    f.fake.startThrowsBeforeCommit=true;
    let h:any;
    await assert.rejects(f.executor.start(f.plan),e=>{
      assert.ok(e instanceof ExecutionUncertainError);
      h=e.handle;
      return true;
    });
    assert.equal(f.fake.v.State.Status,'created');
    const stopped=await f.executor.stop(h,'RECOVERY');
    assert.equal(stopped.confirmed,false);
    assert.equal((await f.journal.read(h.runId)).exit,null);
    assert.equal((await f.executor.stop(h,'RECOVERY')).confirmed,false);
    const restarted=new DockerExecutor({
      policy:f.policy,transport:f.fake,journal:f.journal
    });
    const [orphan]=await restarted.inspectOwnedOrphans('install');
    assert.deepEqual(orphan.handle,h);
    assert.equal(orphan.state,'UNKNOWN');
    assert.equal(orphan.durableReceipt,null);
    assert.equal((await restarted.stop(h,'RECOVERY')).confirmed,false);
    const next=structuredClone(f.plan);
    next.ownership={
      ...next.ownership,runId:'run2',containerName:`paircoach-install-${profile.id}-run2`
    };
    next.input=await f.copy('run2');
    next.command.args=[next.command.args[0],Buffer.from(canonicalJson({
      ...f.spec,runId:'run2',manifestSha256:next.input.identity.manifestSha256
    })).toString('base64url')];
    await assert.rejects(restarted.start(next),/still owns resources/);
    await assert.rejects(restarted.persistTerminal(h,success));
    assert.equal(f.fake.calls.filter(c=>c[0]==='start').length,1);
    assert.ok(!f.fake.calls.some(c=>c[0]==='rm'));
  }finally{
    await f.cleanup();
  }
});
test('UNIT fake Docker: log transport failure cannot disable timeout Stop or synthesize terminal success',async()=>{
  const f=await fixture();
  try{
    const h=await f.executor.start(f.plan);
    const events:string[]=[];
    f.executor.subscribe(h,o=>events.push(o.text));
    f.fake.logsFail=true;
    f.advance(1001);
    const exit=await f.executor.wait(h);
    assert.equal(exit.exitCode,137);
    assert.equal(f.fake.calls.filter(c=>c[0]==='stop').length,1);
    assert.ok(events.some(s=>s.includes('output unavailable')));
    await assert.rejects(f.executor.collect(h,exit));
    assert.ok(!f.fake.calls.some(c=>c[0]==='rm'));
  }finally{
    await f.cleanup();
  }
});
test('UNIT fake Docker: wrong engine blocks Stop before targeting any resource',async()=>{
  const f=await fixture();
  try{
    const h=await f.executor.start(f.plan);
    f.fake.engineId='foreign-engine';
    assert.equal((await f.executor.stop(h,'USER')).confirmed,false);
    assert.ok(!f.fake.calls.some(c=>c[0]==='stop'||c[0]==='rm'));
  }finally{
    await f.cleanup();
  }
});
function setServiceFixture(f:Awaited<ReturnType<typeof fixture>>){
  const p={
    ...f.plan.profile,adapterFamily:'java-maven' as const,compilerRelease:21 as const,analysis:{
      languageLevel:'21',preview:false
    },language:{
      provider:'jdt' as const,imageLockKey:'jdt',serverJvm:'27'
    }
  };
  // Fixture setup only, before construction; fresh executor receives the SAME approved runtime/cache identities.
  f.plan.profile=p;
  f.plan.caches=f.plan.caches.map(c=>({
    ...c,family:'java-maven' as const
  }));
  f.policy.runtimes=[{
    ...f.policy.runtimes[0],profile:p,caches:f.plan.caches
  }];
  f.executor=new DockerExecutor({
    policy:f.policy,transport:f.fake,journal:f.journal,now:()=>Date.now(),sleep:ms=>new Promise(r=>setTimeout(r,ms))
  });
  f.setSpec({
    ...f.spec,family:'java-maven',release:21,mode:'RUN_MAIN',task:{
      workingDirectory:'.',entry:{
        kind:'SPRING_BOOT',containerPort:8080,healthPath:'/health'
      },tests:{
        paths:[],names:[]
      }
    }
  });
}
