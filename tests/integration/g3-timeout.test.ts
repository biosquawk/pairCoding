/** Transport experiment, NOT a scaled performance benchmark or a client fix.
 * The real client's 5s deadline runs in another process from the real sync gate.
 * The harness retains the original decision, then reconciles ONLY after an
 * authoritative snapshot proves the proposal absent. Never retry a live proposal.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fork} from 'node:child_process';
import {once} from 'node:events';
import {fileURLToPath} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import {LiveBackend} from '../../src/services/LiveBackend';
import {workspaceFiles,id,Peer} from '../qa/helpers';

async function until<T>(read:()=>T,valid:(value:T)=>boolean,label:string,ms=10000):Promise<T>{
  const end=Date.now()+ms;
  do{const value=read();if(valid(value))return value;await delay(10);}while(Date.now()<end);
  assert.fail('Timed out: '+label);
}
for(const mode of ['success','recovery'])test(`G3 slow sync restore: real client timeout then guarded ledger reconciliation (${mode})`,{timeout:22000},async t=>{
  const dirs=await workspaceFiles(t,{'main.py':'ORIGINAL\n'}),token='probe-'+id(),clientId=id();
  const child=fork(fileURLToPath(new URL('./g3-timeout-server.ts',import.meta.url)),[dirs.rootPath,dirs.dataDir,token,mode],{
    execArgv:['--import','tsx'],stdio:['ignore','pipe','pipe','ipc'],
  });
  let stderr='';child.stderr!.on('data',chunk=>{stderr+=chunk;});
  const peers=new Set<{close():void}>();let client:LiveBackend|undefined;
  t.after(async()=>{
    client?.close();for(const peer of peers)peer.close();
    if(child.exitCode===null&&child.signalCode===null){const exited=once(child,'exit');child.kill('SIGKILL');await exited;}
    await dirs.cleanup();
  });
  const ready=await Promise.race([
    once(child,'message').then(([value])=>value as {port:number;snapshotId:string;sessionId:string}),
    once(child,'exit').then(([code])=>{throw new Error(`Server exited ${code}: ${stderr}`);}),
    delay(10000).then(()=>{throw new Error('Server startup timeout: '+stderr);}),
  ]);
  assert(![8765,8766,8767,8768].includes(ready.port));
  const baseUrl=`http://127.0.0.1:${ready.port}`,sent:any[]=[],frames:any[]=[],errors:string[]=[];
  client=new LiveBackend({baseUrl,token,clientId,socket:url=>{
    const ws=new WebSocket(url);
    const proxy={get readyState(){return ws.readyState;},send:(raw:string)=>{sent.push(JSON.parse(raw));ws.send(raw);},close:()=>ws.close(),
      onopen:null as any,onmessage:null as any,onerror:null as any,onclose:null as any};
    ws.addEventListener('open',e=>proxy.onopen?.(e));
    ws.addEventListener('message',e=>{frames.push(JSON.parse(String(e.data)));proxy.onmessage?.(e);});
    ws.addEventListener('error',e=>proxy.onerror?.(e));ws.addEventListener('close',e=>proxy.onclose?.(e));return proxy;
  }});
  client.subscribe('state',s=>{if(s.connectionError)errors.push(s.connectionError);});
  await client.connect();await until(()=>client!.getState().isOffline,v=>!v,'client sync');
  await client.selectFile('main.py');client.saveFileContent('main.py','USER WORK\n');await client.flushAll();
  client.restoreSnapshotById(ready.snapshotId);
  await until(()=>client!.getState().activeProposal,Boolean,'public proposal');
  const proposalId=client.getState().activeProposal!.id,start=performance.now();
  await client.respondToProposal(proposalId,true);
  const deadlineElapsed=performance.now()-start;
  assert(errors.some(e=>e.includes('Brak ACK decyzji; wynik nieznany.')),'actual unmodified client must observe its real 5s timeout');
  const original=sent.find(m=>m.type==='PROPOSAL_RESPONSE');assert(original);
  const first=await until(()=>frames.find(m=>m.type==='ACK'&&m.payload.replyTo===original.messageId),value=>!!value,'late terminal ACK');
  const expected=mode==='success'?'OK':'REJECTED';assert.equal(first.payload.status,expected);
  if(mode==='recovery')assert.equal(first.payload.error.code,'RECOVERY_REQUIRED');
  assert.equal(fs.readFileSync(path.join(dirs.rootPath,'main.py'),'utf8'),mode==='success'?'ORIGINAL\n':'FOREIGN');
  assert(deadlineElapsed<performance.now()-start,'client timeout preceded final server ACK');
  // A new HELLO / fresh snapshot is an authenticated read before any replay.
  const peer=new Peer({port:ready.port,baseURL:baseUrl,clientId,sessionId:ready.sessionId,token,peers} as any);
  const bundle=(await peer.connect()).payload;
  assert.equal(bundle.session.sessionId,original.sessionId);
  assert.equal(bundle.proposals.some((p:any)=>p.proposalId===proposalId),false,'absence guard is mandatory');
  const before=await fetch(baseUrl+'/api/snapshots',{headers:{Authorization:`Bearer ${token}`}}).then(r=>r.json());
  const replayId=peer.send(original.type,original.payload,original.messageId),reconciled=await peer.ack(replayId);
  assert.equal(reconciled.payload.status,mode==='success'?'DUPLICATE':'REJECTED');
  assert.deepEqual(reconciled.payload.error,first.payload.error);
  const after=await fetch(baseUrl+'/api/snapshots',{headers:{Authorization:`Bearer ${token}`}}).then(r=>r.json());
  assert.deepEqual(after,before);assert.equal(after.length,2,'source and exactly one pre-effect backup');
  assert.equal(fs.readFileSync(path.join(dirs.dataDir,'probe-checkpoints.txt'),'utf8'),'1\n','no second gate effect');
  const wrong=await peer.ack(peer.send(original.type,{...original.payload,accepted:false},original.messageId));
  assert.equal(wrong.payload.error.code,'IDEMPOTENCY_CONFLICT');
  // A changed session is rejected before the old outcome can be served.
  const differentSession=id(),wrongMessage=id();
  peer.socket.send(JSON.stringify({...original,sessionId:differentSession,messageId:wrongMessage}));
  assert.equal((await peer.ack(wrongMessage)).payload.error.code,'SESSION_MISMATCH');
  peer.assertProtocol();
  t.diagnostic(JSON.stringify({mode,latencyInjectionMs:6500,clientDeadlineObservedMs:Math.round(deadlineElapsed),first:first.payload.status,
    reconciliation:reconciled.payload.status,error:reconciled.payload.error?.code??null,backupCount:after.length-1,gatePublicationCheckpoints:1,
    clientDisplayedRecoveryError:errors.some(e=>e.includes('RECOVERY_REQUIRED'))}));
});
