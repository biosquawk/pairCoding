import test from 'node:test';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {publicServerOptions} from '../../src/server/index';
import {readLearningPack} from '../../src/server/sprint/LearningPack';

test('public startup defaults to REST and explicitly selects the authored Java pack',()=>{
  assert.deepEqual(publicServerOptions({}),{port:8080,learningPackPath:undefined});
  assert.equal(readLearningPack().id,'rest-spring');
  const learningPackPath=fileURLToPath(new URL('../../learning-packs/java-concurrency/',import.meta.url));
  assert.deepEqual(publicServerOptions({PAIRCOACH_HTTP_PORT:'18131',PAIRCOACH_LEARNING_PACK_PATH:learningPackPath}),{port:18131,learningPackPath});
  assert.equal(readLearningPack(learningPackPath).id,'java-concurrency');
});
test('explicit invalid pack never silently starts a REST lesson',()=>{
  assert.throws(()=>publicServerOptions({PAIRCOACH_LEARNING_PACK_PATH:''}));
  assert.throws(()=>publicServerOptions({PAIRCOACH_LEARNING_PACK_PATH:'/missing-concurrency-pack'}));
});

test('actual public npm start forwards explicit pack to HTTP, not only an unused config helper',{timeout:60_000},async t=>{
  const {spawn}=await import('node:child_process');
  const {once}=await import('node:events');
  const net=await import('node:net');
  const fs=await import('node:fs');
  const path=await import('node:path');
  const os=await import('node:os');
  const repo=fileURLToPath(new URL('../../',import.meta.url));
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'public-java-pack-'));
  t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
  const socket=net.createServer();socket.listen(0,'127.0.0.1');await once(socket,'listening');
  const port=(socket.address() as import('node:net').AddressInfo).port;
  await new Promise<void>((resolve,reject)=>socket.close(e=>e?reject(e):resolve()));
  const npm=path.resolve(path.dirname(process.execPath),'../lib/node_modules/npm/bin/npm-cli.js');
  const child=spawn(process.execPath,[npm,'start','--','--runtime-config',path.join(directory,'absent.json')],{
    cwd:repo,env:{...process.env,PAIRCOACH_HTTP_PORT:String(port),PAIRCOACH_LEARNING_PACK_PATH:fileURLToPath(new URL('../../learning-packs/java-concurrency/',import.meta.url)),NODE_ENV:'development'},
    detached:process.platform!=='win32',stdio:['ignore','pipe','pipe']});
  const terminal=once(child,'exit');let output='';
  child.stdout.on('data',b=>output+=String(b));child.stderr.on('data',b=>output+=String(b));
  t.after(async()=>{
    if(child.exitCode===null&&child.signalCode===null){
      if(process.platform==='win32')child.kill('SIGTERM');else process.kill(-child.pid!,'SIGTERM');
    }
    let timer:ReturnType<typeof setTimeout>;
    try{await Promise.race([terminal,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Owned public start did not terminate')),10000);})]);}
    finally{clearTimeout(timer!);}
  });
  const url='http://127.0.0.1:'+port,deadline=Date.now()+10000;
  while(!output.includes('PairCoach: '+url+' ')){
    assert.equal(child.exitCode,null,output);assert(Date.now()<deadline,'Public startup did not listen');
    await new Promise(resolve=>setTimeout(resolve,25)); // poll cadence, not a liveness gate
  }
  const bootstrap=await fetch(url+'/dev/bootstrap',{signal:AbortSignal.timeout(10000)});
  assert.equal(bootstrap.status,200);const {token}=await bootstrap.json() as {token:string};
  const response=await fetch(url+'/api/durable-project/sprint',{headers:{Authorization:'Bearer '+token,Origin:url},signal:AbortSignal.timeout(10000)});
  assert.equal(response.status,200);const body=await response.json() as any;
  assert.equal(body.pack.id,'java-concurrency');assert.equal(body.pack.topics[0].id,'concurrency');
  assert.equal(body.sprint,null);assert.equal(output.includes(token),false);
});
