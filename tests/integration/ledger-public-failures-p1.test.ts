/** Public listener integration; executionFactory is a controlled service, not real runner/report persistence. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { once } from 'node:events';
import http from 'node:http';
import { WebSocket } from 'ws';
import { apiError, CommandLedger, TransportError } from '../../src/server/transport';
import { createPairCoachServer } from '../../src/server/http';
import { LiveBackend } from '../../src/services/LiveBackend';

const secret='SECRET_C:/private/token=do-not-publish';
const codes=['COMMAND_RESULT_UNAVAILABLE','COMMAND_STORAGE_UNAVAILABLE'] as const;
function warning(error:any,code:string) {
  assert.equal(error.code,code);assert.equal(error.retryable,false);
  assert.match(error.message,/mogła się wykonać/);assert.match(error.message,/zsynchronizuj/i);
  assert.match(error.message,/nie ponawiaj.*nowym ID/);assert(!JSON.stringify(error).includes(secret));
}
function evidence(t:any,label:string,payload:unknown) {t.diagnostic(JSON.stringify({label,payload}));}

test('P1 projection: only local TransportError503 gets fixed ambiguous warning; spoof/secret never upgraded',async t=>{
  const temp=fs.mkdtempSync(path.join(os.tmpdir(),'p1-public-projection-'));
  t.after(()=>fs.rmSync(temp,{recursive:true,force:true}));
  for(const code of codes) {
    const local=Object.assign(new TransportError(503,code,secret),{cause:new Error(secret),stack:secret});
    warning(apiError(local,'public-request'),code);
    for(const spoof of [Object.assign(new Error(secret),{status:503,code}),{status:503,code,message:secret,cause:secret,stack:secret}]) {
      const first=apiError(spoof);
      assert.equal(first.code,'INTERNAL_ERROR');assert.equal(first.retryable,true);
      assert.doesNotMatch(first.message,/zsynchronizuj|nowym ID/);assert(!JSON.stringify(first).includes(secret));
      const ledger=new CommandLedger({tempRoot:temp});t.after(()=>ledger.close());
      let count=0;
      const effect=()=>{count++;throw spoof;};
      for(let i=0;i<2;i++) {
        try {await ledger.run('spoof',null,effect).result;assert.fail('expected rejection');}
        catch(error) {assert.deepEqual(apiError(error),first,'journal replay must not upgrade a spoof into trusted warning');}
      }
      assert.equal(count,1);
    }
  }
});

async function fixture(t:any,storage:boolean) {
  const temp=fs.mkdtempSync(path.join(os.tmpdir(),'p1-public-http-')),root=path.join(temp,'root'),receipts=path.join(temp,'receipts');
  fs.mkdirSync(root);fs.mkdirSync(receipts);fs.writeFileSync(path.join(root,'solution.js'),'initial\n');
  fs.writeFileSync(path.join(root,'challenge.md'),'# valid task\n');
  let effects=0;
  const app=createPairCoachServer({port:0,rootPath:root,dataDir:path.join(root,'.paircoach'),token:'public-test-token',
    ledgerOptions:{tempRoot:receipts,maxOutcomeBytes:1024},executionFactory:()=>({
      runner:{setApprovedProfiles(){},start(){throw new Error('unused');},get(){throw new Error('unused');},list(){return [];},stopAll(){return Promise.resolve();},
        stop(){effects++;return Promise.resolve({runId:'oversize',outputTail:'x'.repeat(2048)} as any);}},
      reports:{finish(){throw new Error('unused');},get(){throw new Error('unused');},retry(){throw new Error('unused');},close(){}}
    })});
  if(storage){fs.rmdirSync(receipts);fs.writeFileSync(receipts,'obstruction');}
  const port=await app.listen(),baseUrl=`http://127.0.0.1:${port}`,sockets:WebSocket[]=[];
  t.after(async()=>{for(const socket of sockets)socket.terminate();await app.close();fs.rmSync(temp,{recursive:true,force:true});});
  const request=async(body:unknown)=>{
    const response=await fetch(baseUrl+'/api/run/oversize/stop',{method:'POST',headers:{Authorization:'Bearer public-test-token','Content-Type':'application/json'},body:JSON.stringify(body)});
    return {status:response.status,body:await response.json()};
  };
  const ws=new WebSocket(baseUrl.replace('http','ws')+'/ws/session');sockets.push(ws);const frames:any[]=[];
  ws.on('message',raw=>frames.push(JSON.parse(String(raw))));await once(ws,'open');
  ws.send(JSON.stringify({protocolVersion:'3.0',messageId:'hello',sessionId:app.session.state.sessionId,clientId:'public-client',type:'HELLO',payload:{token:'public-test-token',lastServerSeq:0}}));
  await until(()=>frames.find(f=>f.type==='SESSION_SNAPSHOT'));
  return {app,request,ws,frames,baseUrl,sockets,effects:()=>effects};
}
async function until<T>(read:()=>T):Promise<NonNullable<T>> {
  const end=Date.now()+5000;
  do {const value=read();if(value)return value as NonNullable<T>;await new Promise(r=>setTimeout(r,5));}while(Date.now()<end);
  throw new Error('Missing public fixture observation');
}

test('P1 real REST: oversize result warning is non-retryable and same ID preserves one effect',async t=>{
  const f=await fixture(t,false),body={requestId:'result-id',sessionId:f.app.session.state.sessionId,clientId:'public-client'};
  const first=await f.request(body),again=await f.request(body);
  assert.equal(first.status,503);warning(first.body,codes[0]);assert.equal(first.body.requestId,body.requestId);
  assert.deepEqual(first,again);assert.equal(f.effects(),1);evidence(t,'REST RESULT503',first);
});

test('P1 real REST+WS: storage obstruction fails before effect, exposes fixed non-retryable ambiguous warning',async t=>{
  const f=await fixture(t,true),body={requestId:'storage-id',sessionId:f.app.session.state.sessionId,clientId:'public-client'};
  const result=await f.request(body);assert.equal(result.status,503);warning(result.body,codes[1]);assert.equal(f.effects(),0);
  const envelope={protocolVersion:'3.0',messageId:'storage-ws',sessionId:body.sessionId,clientId:body.clientId,type:'CODE_CHANGED',
    payload:{path:'solution.js',baseVersion:f.app.workspace.getDocument('solution.js').version,controlEpoch:f.app.session.state.controlEpoch,content:'new\n',editKind:'TYPING'}};
  for(let i=0;i<2;i++)f.ws.send(JSON.stringify(envelope));
  await until(()=>f.frames.filter(frame=>frame.type==='ACK'&&frame.payload.replyTo===envelope.messageId).length===2);
  const ack=f.frames.find(frame=>frame.type==='ACK'&&frame.payload.replyTo===envelope.messageId).payload;
  assert.equal(ack.status,'REJECTED');warning(ack.error,codes[1]);assert.equal(ack.error.requestId,envelope.messageId);
  assert.equal(f.app.workspace.getDocument('solution.js').content,'initial\n');
  evidence(t,'REST STORAGE503',result);evidence(t,'WS STORAGE ACK',ack);
});

test('P1 real WS→LiveBackend autosave: ambiguous storage warning reaches connectionError and draft is retained',async t=>{
  const f=await fixture(t,true);f.ws.terminate();
  await until(()=>f.ws.readyState===WebSocket.CLOSED);
  // Reuse the lease owner; actual browser-shaped socket backed by ws, no receive/private-method injection.
  const client=new LiveBackend({baseUrl:f.baseUrl,token:'public-test-token',clientId:'public-client',socket:url=>{
    const ws=new WebSocket(url);f.sockets.push(ws);
    const proxy:any={get readyState(){return ws.readyState;},send:(raw:string)=>ws.send(raw),close:()=>ws.close()};
    ws.on('open',()=>proxy.onopen?.({}));ws.on('message',data=>proxy.onmessage?.({data:String(data)}));
    ws.on('close',()=>proxy.onclose?.({}));ws.on('error',()=>proxy.onerror?.({}));return proxy;
  }});t.after(()=>client.close());
  await client.connect();await until(()=>!client.getState().isOffline);
  await client.selectFile('solution.js');client.saveFileContent('solution.js','local draft\n');
  await until(()=>client.getState().connectionError?.includes('COMMAND_STORAGE_UNAVAILABLE'));
  assert.match(client.getState().connectionError!,/mogła się wykonać/);assert.match(client.getState().connectionError!,/nie ponawiaj.*nowym ID/);
  assert(client.getState().pendingPaths.includes('solution.js'));assert.equal(f.app.workspace.getDocument('solution.js').content,'initial\n');
  evidence(t,'LiveBackend connectionError',client.getState().connectionError);
});

test('P1 real REST→LiveBackend finish storage503 retains UNKNOWN; repeat click and reconnect use GET only, no new ID/POST',async t=>{
  const f=await fixture(t,true);f.ws.terminate();await until(()=>f.ws.readyState===WebSocket.CLOSED);
  const requests:{method:string;path:string;body:any}[]=[],payloads:unknown[]=[];
  const client=new LiveBackend({baseUrl:f.baseUrl,token:'public-test-token',clientId:'public-client',
    fetch:async(url,options)=>{
      const entry={method:options?.method??'GET',path:new URL(String(url)).pathname,body:options?.body?JSON.parse(String(options.body)):null};requests.push(entry);
      const response=await fetch(url,options);
      if(entry.path==='/api/session/finish')payloads.push({status:response.status,body:await response.clone().json()});
      return response;
    },socket:url=>{
      const ws=new WebSocket(url);f.sockets.push(ws);
      const proxy:any={get readyState(){return ws.readyState;},send:(raw:string)=>ws.send(raw),close:()=>ws.close()};
      ws.on('open',()=>proxy.onopen?.({}));ws.on('message',data=>proxy.onmessage?.({data:String(data)}));
      ws.on('close',()=>proxy.onclose?.({}));ws.on('error',()=>proxy.onerror?.({}));return proxy;
    }});t.after(()=>client.close());
  await client.connect();await until(()=>!client.getState().isOffline);
  await client.finishSession('COMPLETED');
  const posts=()=>requests.filter(r=>r.method==='POST');const original=posts()[0].body.requestId;
  assert.match(client.getState().connectionError!,/COMMAND_STORAGE_UNAVAILABLE.*Wynik zakończenia jest nieznany/);
  assert(client.getState().connectionError!.includes(original));
  assert.equal(f.app.session.state.lifecycle,'READY','this fixture did not execute finish; rejection nevertheless cannot prove that to client');
  assert.equal(f.app.workspace.listSnapshots().length,0);
  await until(()=>requests.find(r=>r.path==='/api/session/report'));
  await client.finishSession('ABANDONED');await client.finishSession('COMPLETED');
  const gets=requests.filter(r=>r.path==='/api/session/report').length;
  client.reconnect();await until(()=>!client.getState().isOffline);
  await until(()=>requests.filter(r=>r.path==='/api/session/report').length>gets);
  await client.finishSession('COMPLETED');
  assert.equal(posts().length,1);assert.equal(posts()[0].body.requestId,original);
  assert.match(client.getState().connectionError!,/nieznany/);
  evidence(t,'REAL finish503→UNKNOWN→reconnect GET-only',{payloads,connectionError:client.getState().connectionError,requests});
});

test('P1 real503headers then response.destroy: LiveBackend keeps UNKNOWN and original ID; reclick/reconnect GET-only',async t=>{
  const f=await fixture(t,true);f.ws.terminate();await until(()=>f.ws.readyState===WebSocket.CLOSED);
  const requests:{method:string;path:string;status?:number;body?:any}[]=[],upstreamErrors:string[]=[];
  const proxy=http.createServer((req,res)=>{
    const upstream=http.request(new URL(req.url!,f.baseUrl),{method:req.method,headers:{...req.headers,host:new URL(f.baseUrl).host}},response=>{
      if(req.url==='/api/session/finish'&&response.statusCode===503) {
        response.resume();res.writeHead(503,{'Content-Type':'application/json','Content-Length':'2048'});
        res.write('{"code":');res.flushHeaders();setTimeout(()=>res.destroy(),25);
      } else {res.writeHead(response.statusCode!,response.headers);response.pipe(res);}
    });
    upstream.on('error',error=>{upstreamErrors.push(error.message);res.destroy();});req.pipe(upstream);
  });
  await new Promise<void>(resolve=>proxy.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise<void>(resolve=>proxy.close(()=>resolve())));
  const baseUrl=`http://127.0.0.1:${(proxy.address() as any).port}`;
  const client=new LiveBackend({baseUrl,token:'public-test-token',clientId:'public-client',fetch:async(url,options)=>{
    const entry={method:options?.method??'GET',path:new URL(String(url)).pathname,body:options?.body?JSON.parse(String(options.body)):null,status:undefined as number|undefined};requests.push(entry);
    const response=await fetch(url,options);entry.status=response.status;return response;
  },socket:url=>{
    // WS is not faulted: the deliberate proxy cuts only the real REST error body.
    const ws=new WebSocket(url.replace(new URL(baseUrl).host,new URL(f.baseUrl).host));f.sockets.push(ws);
    const socket:any={get readyState(){return ws.readyState;},send:(raw:string)=>ws.send(raw),close:()=>ws.close()};
    ws.on('open',()=>socket.onopen?.({}));ws.on('message',data=>socket.onmessage?.({data:String(data)}));
    ws.on('close',()=>socket.onclose?.({}));ws.on('error',()=>socket.onerror?.({}));return socket;
  }});t.after(()=>client.close());
  await client.connect();await until(()=>!client.getState().isOffline);
  await client.finishSession('COMPLETED');
  const posts=()=>requests.filter(r=>r.method==='POST'),original=posts()[0].body.requestId;
  assert.equal(posts()[0].status,503,'fetch really received503 headers before body loss');
  assert.match(client.getState().connectionError!,/Wynik zakończenia jest nieznany/);
  assert(client.getState().connectionError!.includes(original));
  await until(()=>requests.find(r=>r.path==='/api/session/report'));
  await client.finishSession('ABANDONED');const reads=requests.filter(r=>r.path==='/api/session/report').length;
  client.reconnect();await until(()=>!client.getState().isOffline);
  await until(()=>requests.filter(r=>r.path==='/api/session/report').length>reads);
  await client.finishSession('COMPLETED');assert.equal(posts().length,1);assert.equal(posts()[0].body.requestId,original);
  assert.equal(f.app.session.state.lifecycle,'READY');assert.equal(f.app.workspace.listSnapshots().length,0);
  assert.deepEqual(upstreamErrors,[]);
  evidence(t,'REAL unreadable503headers→UNKNOWN→GET-only',{requests,connectionError:client.getState().connectionError});
});
