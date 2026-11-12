import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import http from 'node:http';
import { WebSocket } from 'ws';
import { createPairCoachServer } from '../../src/server/http';
const TOKEN='test-token-0123456789abcdef-0123456789abcdef';
async function fixture(t:any) {
  const parent=fs.mkdtempSync(path.join(os.tmpdir(),'paircoach-http-')),root=path.join(parent,'workspace');fs.mkdirSync(root);
  fs.writeFileSync(path.join(root,'challenge.md'),'# Zadanie\n');fs.writeFileSync(path.join(root,'solution.js'),'// start\r\n');
  const app=createPairCoachServer({rootPath:root,dataDir:path.join(parent,'data'),port:0,token:TOKEN});
  const port=await app.listen(),base=`http://127.0.0.1:${port}`;
  t.after(async()=>{await app.close();fs.rmSync(parent,{recursive:true,force:true});});
  const request=async(p:string,body?:unknown,method=body?'POST':'GET',headers:Record<string,string>={})=>{
    // Node fetch silently rewrites Host. Raw node:http is required to actually test a hostile Host.
    if(headers.Host) return new Promise<{status:number;body:any}>((resolve,reject)=>{
      const req=http.request(base+p,{method,headers:{Authorization:`Bearer ${TOKEN}`,...headers}},res=>{
        let data='';res.on('data',chunk=>data+=chunk);res.on('end',()=>resolve({status:res.statusCode!,body:JSON.parse(data)}));
      });req.on('error',reject);req.end();
    });
    const res=await fetch(base+p,{method,headers:{Authorization:`Bearer ${TOKEN}`,...(body?{'Content-Type':'application/json'}:{}),...headers},body:body?JSON.stringify(body):undefined});
    return {status:res.status,body:await res.json()};
  };
  const project=(await request('/api/project')).body;
  return {app,root,base,port,request,project};
}
async function peer(port:number,sessionId:string,clientId='client-one') {
  const ws=new WebSocket(`ws://127.0.0.1:${port}/ws/session`,{origin:`http://127.0.0.1:${port}`});
  const messages:any[]=[];ws.on('message',raw=>messages.push(JSON.parse(raw.toString())));
  await once(ws,'open');
  const wait=async(predicate:(m:any)=>boolean)=>{
    const deadline=Date.now()+3000;
    while(Date.now()<deadline) {const m=messages.find(predicate);if(m)return m;await new Promise(r=>setTimeout(r,5));}
    throw new Error('Missing real WS message: '+messages.map(m=>m.type).join(','));
  };
  const send=(type:string,payload:any,id=crypto.randomUUID())=>{ws.send(JSON.stringify({protocolVersion:'3.0',messageId:id,clientId,sessionId,type,payload}));return id;};
  send('HELLO',{token:TOKEN,lastServerSeq:0});await wait(m=>m.type==='SESSION_SNAPSHOT');
  return {ws,messages,wait,send};
}

test('real REST authentication/bootstrap/Host/Origin and default workspace (TEST001/026)',async t=>{
  const f=await fixture(t);
  const unauth=await fetch(f.base+'/api/project');assert.equal(unauth.status,401);
  assert.equal((await f.request('/api/project',undefined,'GET',{Origin:'https://attacker.invalid'})).status,403);
  assert.equal((await f.request('/api/project',undefined,'GET',{Host:'attacker.invalid'})).status,403);
  assert.equal((await f.request('/dev/bootstrap')).body.token,TOKEN);
  assert.equal((await f.request('/api/project')).status,200);
  assert.equal((await f.request('/api/file?path=challenge.md')).body.content,'# Zadanie\n');
  assert.equal((await f.request('/api/file?path=..%2Foutside')).status,403);
  assert.equal((await f.request('/api/file?path=CON.txt')).status,403);
});

test('real CODE_CHANGED ACK, version, CRLF, duplicate and changed-id conflict (TEST004/010)',async t=>{
  const f=await fixture(t),client=await peer(f.port,f.project.sessionId);t.after(()=>client.ws.terminate());
  const initial=(await f.request('/api/file?path=solution.js')).body;
  const session=(await f.request('/api/session')).body;
  const payload={path:'solution.js',baseVersion:initial.version,controlEpoch:session.controlEpoch,content:'const student = 1;\n',editKind:'TYPING'};
  const id=client.send('CODE_CHANGED',payload);const ack=await client.wait(m=>m.type==='ACK'&&m.payload.replyTo===id);
  assert.equal(ack.payload.status,'OK');assert.equal(ack.payload.documentVersion,initial.version+1);
  assert.equal(fs.readFileSync(path.join(f.root,'solution.js'),'utf8'),'const student = 1;\r\n');
  client.send('CODE_CHANGED',payload,id);await client.wait(m=>m.type==='ACK'&&m.payload.replyTo===id&&m.payload.status==='DUPLICATE');
  client.send('CODE_CHANGED',{...payload,content:'WRONG\n'},id);const conflict=await client.wait(m=>m.type==='ACK'&&m.payload.replyTo===id&&m.payload.status==='REJECTED');
  assert.equal(conflict.payload.error.code,'IDEMPOTENCY_CONFLICT');
  assert.equal((await f.request('/api/file?path=solution.js')).body.version,initial.version+1);
  const beforeVeto=(await f.request('/api/session')).body;
  const vetoId=client.send('VETO_ESCAPE',{controlEpoch:beforeVeto.controlEpoch,activeInterventionId:null,lastAppliedSeq:0});
  const vetoAck=await client.wait(m=>m.type==='ACK'&&m.payload.replyTo===vetoId);
  assert.equal(vetoAck.payload.status,'OK');assert.ok(vetoAck.payload.controlEpoch>beforeVeto.controlEpoch);
  const staleId=client.send('CODE_CHANGED',{...payload,baseVersion:initial.version+1,content:'stale write\n'});
  const stale=await client.wait(m=>m.type==='ACK'&&m.payload.replyTo===staleId);assert.equal(stale.payload.status,'REJECTED');
  assert.equal((await f.request('/api/file?path=solution.js')).body.content,'const student = 1;\n');
  const seq=client.messages.map(m=>m.seq);for(let i=1;i<seq.length;i++)assert.equal(seq[i],seq[i-1]+1);
});

test('second client cannot steal lease and external disk change prevents stale overwrite (TEST005/026)',async t=>{
  const f=await fixture(t),client=await peer(f.port,f.project.sessionId);t.after(()=>client.ws.terminate());
  const second=new WebSocket(`ws://127.0.0.1:${f.port}/ws/session`);t.after(()=>second.terminate());
  await once(second,'open');const closed=once(second,'close');second.send(JSON.stringify({protocolVersion:'3.0',messageId:'hello-other',sessionId:f.project.sessionId,clientId:'client-other',type:'HELLO',payload:{token:TOKEN,lastServerSeq:0}}));
  const [code]=await closed;assert.equal(code,1008);assert.equal(f.app.session.leaseClientId,'client-one');
  const original=(await f.request('/api/file?path=solution.js')).body,session=(await f.request('/api/session')).body;
  fs.writeFileSync(path.join(f.root,'solution.js'),'// external IDE\r\n');
  const id=client.send('CODE_CHANGED',{path:'solution.js',baseVersion:original.version,controlEpoch:session.controlEpoch,content:'// overwrite\n',editKind:'TYPING'});
  const ack=await client.wait(m=>m.type==='ACK'&&m.payload.replyTo===id);assert.equal(ack.payload.status,'REJECTED');
  assert.equal(fs.readFileSync(path.join(f.root,'solution.js'),'utf8'),'// external IDE\r\n');
});
