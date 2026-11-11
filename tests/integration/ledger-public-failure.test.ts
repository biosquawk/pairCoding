/** Real server, filesystem, REST/WS and LiveBackend. No substitute ledger/gate/execution service. */
import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {createPairCoachServer} from '../../src/server/http';
import {LiveBackend} from '../../src/services/LiveBackend';
import {workspaceFiles,Peer,id} from '../qa/helpers';
import {assertAmbiguousMessage} from '../qa/ledger-failure-oracle';

async function until(read:()=>boolean,label:string){const end=Date.now()+5000;while(!read()){assert(Date.now()<end,label);await delay(10);}}
async function fixture(t:TestContext,badStorage=false,extra:Record<string,string>={}) {
  const dirs=await workspaceFiles(t,{'solution.js':'original\n',...extra});
  const tempRoot=path.join(dirs.base,'only-qa-receipts');
  // Actual ENOTDIR in mkdtemp, not a mocked fs operation or a substituted ledger.
  if(badStorage)await fs.writeFile(tempRoot,'not a directory');else await fs.mkdir(tempRoot);
  const token='ephemeral-'+id(),clientId=id();
  const app=createPairCoachServer({...dirs,token,port:0,enableCoach:false,enableExecution:true,
    ledgerOptions:{tempRoot,maxOutcomeBytes:1024,maxBytes:262144,maxEntries:256,maxPending:4},
  } as any);
  const peers=new Set<{close():void}>(),clients:LiveBackend[]=[],releases:(()=>void)[]=[];
  t.after(async()=>{releases.forEach(r=>r());clients.forEach(c=>c.close());peers.forEach(p=>p.close());try{await app.close();}finally{await dirs.cleanup();}});
  const port=await app.listen(),baseURL=`http://127.0.0.1:${port}`;
  assert(![8081,8765,8766,8767,8768].includes(port));
  async function http(method:string,target:string,body?:unknown){
    const response=await fetch(baseURL+target,{method,headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(5000)});
    return {status:response.status,body:await response.json()};
  }
  const state=(await http('GET','/api/session')).body,sessionId=state.sessionId;
  const requests:{method:string;path:string;body:any;status?:number;value?:any}[]=[],outgoing:any[]=[],incoming:any[]=[];
  function client(holdReports=false){
    let release!:()=>void;const gate=new Promise<void>(r=>release=r);releases.push(release);
    const stored=new Map<string,string>();
    const c=new LiveBackend({baseUrl:baseURL,token,clientId,storage:{getItem:k=>stored.get(k)??null,setItem:(k,v)=>{stored.set(k,v);},removeItem:k=>{stored.delete(k);}},
      fetch:async(url,options)=>{
        assert.equal(new Headers(options?.headers).get('Authorization'),`Bearer ${token}`);
        const target=new URL(String(url)),record:{method:string;path:string;body:any;status?:number;value?:any}={method:options?.method??'GET',path:target.pathname,body:options?.body?JSON.parse(String(options.body)):null};requests.push(record);
        const response=await fetch(url,options);record.status=response.status;record.value=await response.clone().json();
        // Hold a REAL response, only to observe UNKNOWN before successful read-only reconciliation.
        if(holdReports&&target.pathname==='/api/session/report')await gate;
        return response;
      },
      socket:url=>{
        const ws=new WebSocket(url),proxy:any={get readyState(){return ws.readyState;},send:(raw:string)=>{outgoing.push(JSON.parse(raw));ws.send(raw);},close:()=>ws.close()};
        ws.addEventListener('open',e=>proxy.onopen?.(e));ws.addEventListener('message',e=>{incoming.push(JSON.parse(String(e.data)));proxy.onmessage?.(e);});
        ws.addEventListener('error',e=>proxy.onerror?.(e));ws.addEventListener('close',e=>proxy.onclose?.(e));return proxy;
      },
    });clients.push(c);return {c,release,stored};
  }
  return {...dirs,app,token,clientId,peers,port,baseURL,http,state,sessionId,tempRoot,requests,outgoing,incoming,client};
}
function publicFailure(value:any,code:string,requestId:string){
  assert.equal(value.code,code);assert.equal(value.requestId,requestId);assert.equal(value.retryable,false);assertAmbiguousMessage(value.message);
  const text=JSON.stringify(value);assert(!text.includes('only-qa-receipts'));assert(!text.includes('ENOTDIR'));assert(!text.includes('stack'));assert(!text.includes('cause'));
}

test('REAL REST storage503 → LiveBackend finish UNKNOWN; repeated/opposite clicks never create a newPOST/ID',async t=>{
  const f=await fixture(t,true),{c}=f.client();await c.connect();await until(()=>!c.getState().isOffline,'HELLO');
  await c.finishSession('COMPLETED');await delay(30);
  const first=f.requests.find(r=>r.path==='/api/session/finish')!;
  assert(first);assert.equal(first.status,503);publicFailure(first.value,'COMMAND_STORAGE_UNAVAILABLE',first.body.requestId);
  assertAmbiguousMessage(c.getState().connectionError!);assert(c.getState().connectionError!.includes(first.body.requestId));
  await c.finishSession('ABANDONED');await c.finishSession('COMPLETED');await delay(30);
  assert.equal(f.requests.filter(r=>r.method==='POST').length,1);
  assert(f.requests.some(r=>r.method==='GET'&&r.path==='/api/session/report'));
  assert.equal((await f.http('GET','/api/session')).body.lifecycle,'READY');assert.deepEqual((await f.http('GET','/api/snapshots')).body,[]);
  assert.equal(await fs.readFile(path.join(f.rootPath,'solution.js'),'utf8'),'original\n');
});

test('REAL WS storage503 → LiveBackend autosave warning, retained draft, no unauthorized effect or new-ID retry',async t=>{
  const f=await fixture(t,true),{c,stored}=f.client();await c.connect();await until(()=>!c.getState().isOffline,'HELLO');
  await c.selectFile('solution.js');c.saveFileContent('solution.js','local draft must survive\n');
  await until(()=>f.incoming.some(m=>m.type==='ACK'&&m.payload.error?.code==='COMMAND_STORAGE_UNAVAILABLE'&&f.outgoing.some(o=>o.type==='CODE_CHANGED'&&o.messageId===m.payload.replyTo)),'real rejected autosaveACK');
  const command=f.outgoing.find(m=>m.type==='CODE_CHANGED'),ack=f.incoming.find(m=>m.type==='ACK'&&m.payload.replyTo===command.messageId);
  assert.equal(ack.payload.status,'REJECTED');publicFailure(ack.payload.error,'COMMAND_STORAGE_UNAVAILABLE',command.messageId);
  assertAmbiguousMessage(c.getState().connectionError!);assert(c.getState().pendingPaths.includes('solution.js'));
  assert.equal(c.getState().files.find(v=>v.path==='solution.js')?.content,'local draft must survive\n');
  assert([...stored.values()].some(v=>v.includes('local draft must survive')));await delay(600);
  assert.equal(f.outgoing.filter(m=>m.type==='CODE_CHANGED').length,1,'no automatic fresh-ID mutation');
  assert.equal((await f.http('GET','/api/file?path=solution.js')).body.content,'original\n');
});

test('REAL WS known receipt missing after effect:503 replay never becomes a cache miss or repeats CODE_CHANGED',async t=>{
  const f=await fixture(t),p=new Peer(f as any);await p.connect();
  const original=(await f.http('GET','/api/file?path=solution.js')).body;
  const payload={path:'solution.js',baseVersion:original.version,controlEpoch:f.state.controlEpoch,content:'exactly once\n',editKind:'TYPING'},key=p.send('CODE_CHANGED',payload);
  assert.equal((await p.ack(key)).payload.status,'OK');
  const files:string[]=[];
  async function scan(dir:string){for(const e of await fs.readdir(dir,{withFileTypes:true})){const full=path.join(dir,e.name);if(e.isDirectory())await scan(full);else if(e.isFile())files.push(full);}}
  await scan(f.tempRoot);assert(files.length>0,'real receipts exist before external fault injection');
  for(const file of files)await fs.unlink(file); // Only this fixture's configured receipt storage.
  for(let n=0;n<2;n++){
    p.send('CODE_CHANGED',payload,key);const reply=await p.ack(key);assert.equal(reply.payload.status,'REJECTED');publicFailure(reply.payload.error,'COMMAND_STORAGE_UNAVAILABLE',key);
    const actual=(await f.http('GET','/api/file?path=solution.js')).body;assert.equal(actual.version,original.version+1);assert.equal(actual.content,'exactly once\n');
  }
  p.assertProtocol();
});

test('REAL REST oversize settings outcome → safe503 survives public projection and reaches LiveBackend',async t=>{
  const extra=Object.fromEntries(Array.from({length:50},(_,i)=>[`independent-file-${i}-${'a'.repeat(40)}.js`,'const n=1;\n']));
  const f=await fixture(t,false,extra),{c}=f.client();await c.connect();await until(()=>!c.getState().isOffline,'HELLO');
  assert(JSON.stringify((await f.http('GET','/api/project')).body).length>2048,'independently large real project result');
  const before=f.app.workspace.workspaceVersion,patterns=['**/*.js','**/*.md'];
  assert.equal(await c.updateProjectSettings({...c.getState().projectSettings,contextPatterns:patterns}),false);
  const first=f.requests.find(r=>r.path==='/api/project/settings')!;assert.equal(first.status,503);publicFailure(first.value,'COMMAND_RESULT_UNAVAILABLE',first.body.requestId);
  assertAmbiguousMessage(c.getState().connectionError!);assert.deepEqual(f.app.workspace.settings.contextPatterns,patterns);
  assert.equal(f.app.workspace.workspaceVersion,before+1,'effect happened once despite unavailable outcome');
  const replay=await f.http('PUT','/api/project/settings',first.body);assert.equal(replay.status,503);assert.deepEqual(replay.body,first.value);
  assert.equal(f.app.workspace.workspaceVersion,before+1,'known duplicate never applies settings twice');
});

test('REAL REST finish oversize after effect → LiveBackend UNKNOWN then matching GET-only reconciliation, one snapshot/POST',async t=>{
  const f=await fixture(t),p=new Peer(f as any);await p.connect();
  // Real student chat produces >1KiB of report evidence IDs without faking the report generator or runner.
  for(let n=0;n<40;n++)assert.equal((await p.ack(p.send('CHAT_MESSAGE',{text:`Independent evidence ${n}`,path:null,documentVersion:null,selection:null}))).payload.status,'OK');
  const {c,release}=f.client(true);await c.connect();await until(()=>!c.getState().isOffline,'HELLO');
  await c.finishSession('COMPLETED');
  const first=f.requests.find(r=>r.path==='/api/session/finish')!;assert.equal(first.status,503);publicFailure(first.value,'COMMAND_RESULT_UNAVAILABLE',first.body.requestId);
  assertAmbiguousMessage(c.getState().connectionError!);assert(c.getState().connectionError!.includes(first.body.requestId));
  await c.finishSession('ABANDONED');await c.finishSession('COMPLETED');assert.equal(f.requests.filter(r=>r.method==='POST').length,1);
  assert.equal((await f.http('GET','/api/session')).body.lifecycle,'FINISHED');assert.equal((await f.http('GET','/api/snapshots')).body.length,1);
  assert.equal(await fs.readFile(path.join(f.rootPath,'solution.js'),'utf8'),'original\n');
  const replay=await f.http('POST','/api/session/finish',first.body);assert.equal(replay.status,503);assert.deepEqual(replay.body,first.value);
  assert.equal((await f.http('GET','/api/snapshots')).body.length,1);
  release();await until(()=>c.getState().connectionError===null&&c.getState().report!==null,'matching durable report/session proof');
  await c.finishSession('COMPLETED');assert.equal(f.requests.filter(r=>r.method==='POST').length,1);
  assert(f.requests.some(r=>r.method==='GET'&&r.path==='/api/session/report'));p.assertProtocol();
});
