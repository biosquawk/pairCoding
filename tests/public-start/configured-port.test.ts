import test, {type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import {once} from 'node:events';
import {spawn, spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {PairCoachClient} from '../../src/services/PairCoachClient';

const repo=fileURLToPath(new URL('../../',import.meta.url));
const npmCli=[process.env.npm_execpath,
  path.resolve(path.dirname(process.execPath),'../lib/node_modules/npm/bin/npm-cli.js'),
  path.resolve(path.dirname(process.execPath),'node_modules/npm/bin/npm-cli.js')]
  .find((p):p is string=>!!p && p.endsWith('npm-cli.js') && fs.existsSync(p));
assert.ok(npmCli,'An existing npm installation is required; do not install one during tests.');
const delay=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
async function bounded<T>(promise:Promise<T>,message:string):Promise<T> {
  let timer:ReturnType<typeof setTimeout>;
  try {return await Promise.race([promise,new Promise<never>((_resolve,reject)=>{timer=setTimeout(()=>reject(Error(message)),10000);})]);}
  finally {clearTimeout(timer!);}
}
async function until(check:()=>boolean|Promise<boolean>,message:string) {
  const end=Date.now()+10000;
  while(!await check()){if(Date.now()>end)throw Error(message);await delay(25);}
}
async function listen(server:http.Server) {
  server.listen(0,'127.0.0.1');await once(server,'listening');
  const address=server.address();assert.ok(address && typeof address==='object');
  assert.notEqual(address.port,8080);return address.port;
}
async function close(server:http.Server) {await new Promise<void>((resolve,reject)=>server.close(e=>e?reject(e):resolve()));}
async function freePort() {
  const server=http.createServer();const port=await listen(server);await close(server);return port;
}
async function portClosed(port:number) {
  try {await fetch(`http://127.0.0.1:${port}/`,{signal:AbortSignal.timeout(300)});return false;}
  catch {return true;}
}
function fixture(t:TestContext) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'paircoach-public-port-'));
  const project=path.join(root,'project');fs.mkdirSync(project);
  fs.writeFileSync(path.join(project,'task.md'),'# Isolated public CLI fixture\n');
  fs.writeFileSync(path.join(project,'source.js'),'// ORIGINAL\n');
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  return {root,project};
}
function start(t:TestContext,f:ReturnType<typeof fixture>,port:string,args:string[]=[]) {
  // Invoke the REAL package script, not an imported factory or alternate launcher.
  // A missing config plus explicit private workspace avoids using packaged examples.
  const env:NodeJS.ProcessEnv={...process.env,PATH:path.dirname(process.execPath)+path.delimiter+(process.env.PATH??''),
    NODE_ENV:'development',PAIRCOACH_HTTP_PORT:port,PAIRCOACH_WORKSPACE_DIR:f.project,
    TSX_DISABLE_CACHE:'1'};
  delete env.PAIRCOACH_DATA_DIR;
  const child=spawn(process.execPath,[npmCli!,'start','--','--runtime-config',path.join(f.root,'absent.json'),...args],
    {cwd:repo,env,detached:process.platform!=='win32',stdio:['pipe','pipe','pipe']});
  let output='';child.stdout.on('data',b=>output+=String(b));child.stderr.on('data',b=>output+=String(b));
  const done=once(child,'exit').then(([code,signal])=>({code,signal}));
  // Closing primary stdin is NOT an instruction to terminate a healthy public server.
  child.stdin.end();
  const stop=async()=>{
    if(child.exitCode===null && child.signalCode===null) {
      if(process.platform==='win32') {
        // Only the test-owned npm PID/tree, never node.exe or an existing server.
        const r=spawnSync('taskkill.exe',['/PID',String(child.pid),'/T'],{encoding:'utf8'});
        assert.equal(r.status,0,'Could not stop owned npm test tree');
      } else process.kill(-child.pid!,'SIGTERM');
    }
    return bounded(done,'Owned public npm process did not stop');
  };
  t.after(stop);
  return {child,done,stop,output:()=>output};
}

test('public port parser preserves default 8080 and rejects invalid/reserved values without binding it',async()=>{
  const {parsePublicHttpPort}=await import('../../src/server/index');
  assert.equal(parsePublicHttpPort(undefined),8080);
  for(const [raw,expected] of [['2',2],['18080',18080],['65535',65535],['03000',3000]] as const) {
    if(expected===3000)assert.throws(()=>parsePublicHttpPort(raw),/zastrzeżone/);
    else assert.equal(parsePublicHttpPort(raw),expected);
  }
  for(const value of ['', ' ', '18080 ', '-1', '0', '65536', '1.5', '1e4', '+18080','0x4650','NaN','Infinity','80','3000','8765','8766','8767','8768','secret\n'])
    assert.throws(()=>parsePublicHttpPort(value),/PAIRCOACH_HTTP_PORT/);
});

// Independent expectations from https://fetch.spec.whatwg.org/#port-blocking.
// No browser-policy override and no network traffic to any of these ports.
test('public port parser rejects browser-blocked ports including numeric aliases',async()=>{
  const {parsePublicHttpPort}=await import('../../src/server/index');
  const browserBlocked=[
    0,1,7,9,11,13,15,17,19,20,21,22,23,25,37,42,43,53,69,77,79,87,95,
    101,102,103,104,109,110,111,113,115,117,119,123,135,137,139,143,161,
    179,389,427,465,512,513,514,515,526,530,531,532,540,548,554,556,563,
    587,601,636,989,990,993,995,1719,1720,1723,2049,3659,4045,4190,
    5060,5061,6000,6566,6665,6666,6667,6668,6669,6679,6697,10080,
  ];
  for(const port of browserBlocked) {
    assert.throws(()=>parsePublicHttpPort(String(port)),/PAIRCOACH_HTTP_PORT/,`Unsafe port ${port}`);
    assert.throws(()=>parsePublicHttpPort(String(port).padStart(5,'0')),/PAIRCOACH_HTTP_PORT/,`Unsafe alias ${port}`);
  }
  for(const raw of ['6000','6667','06000'])
    assert.throws(()=>parsePublicHttpPort(raw),/blokowane przez przeglądarkę/);
  assert.equal(parsePublicHttpPort(undefined),8080);
  for(const port of [2,18080,8080,65535])assert.equal(parsePublicHttpPort(String(port)),port);
  for(const raw of ['80','00080','3000','03000','8765','8766','8767','8768','08768'])
    assert.throws(()=>parsePublicHttpPort(raw),/zastrzeżone/);
});

test('browser-blocked ports fail via actual public npm start before workspace recovery',async t=>{
  for(const value of ['6000','6667','06000'])await t.test(value,async t=>{
    const f=fixture(t),app=start(t,f,value);const terminal=await bounded(app.done,'Unsafe port start did not fail');
    assert.equal(terminal.code,1);assert.match(app.output(),/PAIRCOACH_HTTP_PORT.*blokowane przez przeglądarkę/);
    assert.doesNotMatch(app.output(),/PairCoach: http/);
    assert.equal(fs.existsSync(path.join(f.project,'.paircoach')),false,'Unsafe port validation must precede workspace recovery');
    assert.equal(fs.readFileSync(path.join(f.project,'source.js'),'utf8'),'// ORIGINAL\n');
  });
});

test('public npm start uses chosen port after primary EOF: real UI, auth/API, browser-origin client/WS and owned stop/portClosed',async t=>{
  const f=fixture(t),port=await freePort(),url=`http://127.0.0.1:${port}`;
  const app=start(t,f,String(port));
  await until(()=>app.output().includes(`PairCoach: ${url} `),'Actual configured URL was not announced');
  assert.equal(app.child.exitCode,null);assert.equal(app.child.signalCode,null);
  const page=await fetch(url);assert.equal(page.status,200);assert.match(await page.text(),/<div id="root"><\/div>/);
  assert.equal((await fetch(url+'/api/project')).status,401);
  const bootstrap=await fetch(url+'/dev/bootstrap');assert.equal(bootstrap.status,200);
  const {token}=await bootstrap.json();assert.equal(typeof token,'string');assert.ok(token.length>0);
  const headers={Authorization:`Bearer ${token}`,Origin:url};
  const projectResponse=await fetch(url+'/api/project',{headers});assert.equal(projectResponse.status,200);
  const project=await projectResponse.json();assert.equal(project.rootPath,f.project);
  assert.equal((await fetch(url+'/api/project',{headers:{...headers,Authorization:'Bearer wrong'}})).status,401);
  assert.equal((await fetch(url+'/api/project',{headers:{...headers,Origin:'http://foreign.invalid'}})).status,403);
  const badHost=await new Promise<number>(resolve=>{
    http.get(url+'/api/project',{headers:{...headers,Host:'127.0.0.1:8080'}},r=>{r.resume();resolve(r.statusCode!);});
  });assert.equal(badHost,403,'Host authority still belongs to actual port, not default8080');

  // Exercise actual PairCoachClient.localOrigin, not a copied origin calculation.
  // Browser shell is synthetic; HTTP, bootstrap, API, WS and HELLO are real.
  const previous=Object.getOwnPropertyDescriptor(globalThis,'window');
  const values=new Map<string,string>();const storage={getItem:(k:string)=>values.get(k)??null,setItem:(k:string,v:string)=>{values.set(k,v);},removeItem:(k:string)=>{values.delete(k);}};
  Object.defineProperty(globalThis,'window',{configurable:true,value:{location:new URL(url),localStorage:storage,sessionStorage:storage}});
  const fetched:string[]=[],sockets:string[]=[];
  const client=new PairCoachClient({fetch:((input:any,init:any)=>{fetched.push(String(input));return fetch(input,init);}) as typeof fetch,
    socket:address=>{sockets.push(address);return new WebSocket(address);}});
  try {
    await until(()=>!client.getState().isOffline,'Real browser-origin client did not complete HELLO/snapshot');
    assert.ok(fetched.some(u=>u===url+'/dev/bootstrap'));
    assert.ok(fetched.every(u=>u.startsWith(url+'/')));
    assert.deepEqual(sockets,[url.replace('http:','ws:')+'/ws/session']);
  } finally {
    client.close();if(previous)Object.defineProperty(globalThis,'window',previous);else Reflect.deleteProperty(globalThis,'window');
  }
  assert.equal(fs.readFileSync(path.join(f.project,'source.js'),'utf8'),'// ORIGINAL\n');
  assert.equal(app.output().includes(token),false,'Token must never be printed');
  const terminal=await app.stop();await until(()=>portClosed(port),'Own port did not close');
  t.diagnostic(JSON.stringify({publicCommand:'npm start -- --runtime-config ABSENT_CONFIG',port,pid:app.child.pid,primaryEOF:'SURVIVED',http:200,api:200,ws:'HELLO+SESSION_SNAPSHOT',terminal,portClosed:true,protected8080:'NOT_CONTACTED_OR_BOUND',tokenLogged:false}));
});

test('occupied public port reports EADDRINUSE, leaves existing owner serving and exits nonzero',async t=>{
  const f=fixture(t),owner=http.createServer((_req,res)=>res.end('OWNED SENTINEL'));
  const port=await listen(owner);t.after(()=>close(owner));const app=start(t,f,String(port));
  const terminal=await bounded(app.done,'Occupied start did not fail');
  assert.equal(terminal.code,1);assert.match(app.output(),/EADDRINUSE/);assert.doesNotMatch(app.output(),/PairCoach: http/);
  assert.equal(await (await fetch(`http://127.0.0.1:${port}/`)).text(),'OWNED SENTINEL');
  t.diagnostic(JSON.stringify({port,terminal,occupiedOwnerUntouched:true}));
});

test('invalid, fractional, out-of-range and reserved dev/control ports fail via actual public npm start before startup',async t=>{
  for(const value of ['', 'abc', '1.5', '0', '65536', '80', '3000', '8765'])await t.test(JSON.stringify(value),async t=>{
    const f=fixture(t),app=start(t,f,value);const terminal=await bounded(app.done,'Invalid start did not fail');
    assert.equal(terminal.code,1);assert.match(app.output(),/PAIRCOACH_HTTP_PORT/);assert.doesNotMatch(app.output(),/PairCoach: http/);
    assert.equal(fs.existsSync(path.join(f.project,'.paircoach')),false,'Port validation must precede workspace recovery');
  });
});

test('public npm start still rejects unknown runtime CLI arguments without a listener',async t=>{
  const f=fixture(t),port=await freePort(),app=start(t,f,String(port),['--port','18080']);
  const terminal=await bounded(app.done,'Unknown argument start did not fail');
  assert.equal(terminal.code,1);assert.doesNotMatch(app.output(),/PairCoach: http/);assert.equal(await portClosed(port),true);
});
