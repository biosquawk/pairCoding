/** Existing HTTP client deadline vs late durable finish. No client changes or performance claim. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {fork} from 'node:child_process';
import {once} from 'node:events';
import {fileURLToPath} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import {LiveBackend} from '../../src/services/LiveBackend';
import {workspaceFiles,id} from '../qa/helpers';
async function until<T>(read:()=>T,valid:(v:T)=>boolean) {
  const end=Date.now()+10000;do{const v=read();if(valid(v))return v;await delay(10);}while(Date.now()<end);assert.fail('observation timeout');
}
test('G3 separate-process finish capture exceeds real client deadline: UNKNOWN then durable SESSION_REPORT, never early FINISHED', {timeout:20000},async t=>{
  const dirs=await workspaceFiles(t,{'main.py':'FROZEN'}),token='finish-'+id(),clientId=id(),messages:any[]=[];
  const child=fork(fileURLToPath(new URL('./g3-finish-timeout-server.ts',import.meta.url)),[dirs.rootPath,dirs.dataDir,token],{execArgv:['--import','tsx'],stdio:['ignore','pipe','pipe','ipc']});
  child.on('message',m=>messages.push(m));let stderr='';child.stderr!.on('data',v=>stderr+=v);
  let client:LiveBackend|undefined;
  t.after(async()=>{client?.close();if(child.exitCode===null&&child.signalCode===null){const exit=once(child,'exit');child.kill('SIGKILL');await exit;}await dirs.cleanup();});
  const ready=await until<any>(()=>messages.find(m=>m.port),Boolean);assert(ready,stderr);
  const baseUrl=`http://127.0.0.1:${ready.port}`,errors:string[]=[],frames:any[]=[],requests:{url:string;body:any}[]=[];
  client=new LiveBackend({baseUrl,token,clientId,fetch:async(url,opts)=>{
    if(opts?.method==='POST')requests.push({url:String(url),body:JSON.parse(String(opts.body))});
    return fetch(url,opts);
  },socket:url=>{
    const ws=new WebSocket(url),proxy={get readyState(){return ws.readyState;},send:(raw:string)=>ws.send(raw),close:()=>ws.close(),onopen:null as any,onmessage:null as any,onerror:null as any,onclose:null as any};
    ws.addEventListener('open',e=>proxy.onopen?.(e));ws.addEventListener('message',e=>{frames.push(JSON.parse(String(e.data)));proxy.onmessage?.(e);});
    ws.addEventListener('error',e=>proxy.onerror?.(e));ws.addEventListener('close',e=>proxy.onclose?.(e));return proxy;
  }});
  client.subscribe('state',s=>{if(s.connectionError)errors.push(s.connectionError);});
  await client.connect();await until(()=>client!.getState().isOffline,v=>!v);
  const started=performance.now();await client.finishSession('COMPLETED');const elapsed=performance.now()-started;
  assert(errors.some(e=>e.includes('Wynik operacji jest nieznany')),'existing client must say UNKNOWN, not false FAIL/success');
  assert.equal(client.getState().report,null);assert.equal(frames.some(m=>m.type==='SESSION_REPORT'),false);
  const checkpoint=messages.find(m=>m.phase==='CAPTURE_PENDING');assert(checkpoint);assert.equal(checkpoint.lifecycle,'READY');assert.equal(checkpoint.snapshots,0);
  await until(()=>client!.getState().report,r=>r?.status==='READY');
  const headers={Authorization:`Bearer ${token}`};
  const report=await fetch(baseUrl+`/api/session/report?sessionId=${ready.sessionId}`,{headers}).then(r=>r.json());
  const session=await fetch(baseUrl+'/api/session',{headers}).then(r=>r.json());
  assert.equal(report.status,'READY');assert.equal(session.lifecycle,'FINISHED');assert.equal(requests.filter(r=>r.url.endsWith('/api/session/finish')).length,1,'no automatic repeat');
  const snapshots=await fetch(baseUrl+'/api/snapshots',{headers}).then(r=>r.json());assert.equal(snapshots.length,1);assert.equal(snapshots[0].snapshotId,report.snapshotId);
  const firstReport=frames.find(m=>m.type==='SESSION_REPORT');assert.equal(firstReport.payload.status,'PENDING');
  t.diagnostic(JSON.stringify({latencyInjectionMs:6500,realClientDeadlineMs:Math.round(elapsed),initialLifecycle:checkpoint.lifecycle,unknownObserved:true,lateReport:report.status,lateLifecycle:session.lifecycle,finishRequests:1,finalSnapshots:1,clientErrorAfterLateReport:client.getState().connectionError}));
});
