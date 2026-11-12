/** Controlled authenticated transport, real FE controller. NOT backend/Docker proof. */
import assert from 'node:assert/strict';
import {setImmediate} from 'node:timers/promises';
import {LiveBackend, type LiveOptions} from '../../src/services/LiveBackend';
import {bundle,doc} from '../frontend-cutover/fixtures';
export class MemoryStorage {
  data=new Map<string,string>();failGet=false;failSet=false;failReadback=false;afterSet=false;
  getItem(key:string){if(this.failGet||this.afterSet&&this.failReadback)throw Error('read refused');return this.data.get(key)??null;}
  setItem(key:string,value:string){if(this.failSet)throw Error('quota refused');this.data.set(key,value);this.afterSet=true;}
  removeItem(key:string){this.data.delete(key);}
}
export const prepared=(projectId='p1')=>({schemaVersion:1,status:'PREPARED',installationId:'install1',projectId,engineId:'engine1',name:'paircoach-install1-service-http-v1',networkId:'a'.repeat(64)});
export const storageKey='paircoach:service-prepare:v1:http://127.0.0.1:8080';
export const deferred=()=>{let resolve!:(v:unknown)=>void;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
export async function fixture(t:{after(fn:()=>void):void},options:{storage?:MemoryStorage;clientId?:string;autoId?:boolean}={}) {
  const b=bundle(),calls:{path:string;method:string;body:any;headers:any;raw:string}[]=[],sent:any[]=[],storage=options.storage??new MemoryStorage();
  let post:(body:any)=>Promise<unknown>=async()=>prepared(),get:()=>Promise<unknown>=async()=>structuredClone(b.project),seq=0;
  const socket:any={readyState:1,onopen:null,onmessage:null,onclose:null,onerror:null,send(raw:string){sent.push(JSON.parse(raw));},close(){this.readyState=3;}};
  const live=new LiveBackend({token:'same-authenticated',...(!options.autoId?{clientId:options.clientId??'c1'}:{}),storage,socket:()=>socket,fetch:async(input,init)=>{
    const url=new URL(String(input)),body=init?.body?JSON.parse(String(init.body)):null;
    calls.push({path:url.pathname,method:init?.method??'GET',body,headers:init?.headers,raw:String(init?.body??'')});
    if(url.pathname==='/api/runtime/service-network/prepare') {
      // Independent positive proof: FULL original already persisted when HTTP is dispatched.
      const record=JSON.parse(storage.data.get(storageKey)!);assert.deepEqual(record.entries.find((e:any)=>e.projectId===b.project.projectId).request,body);
      const value=await post(body);return value instanceof Response?value:Response.json(value);
    }
    if(url.pathname==='/api/project')return Response.json(await get());
    if(url.pathname==='/api/session')return Response.json(b.session);
    if(url.pathname==='/api/snapshots')return Response.json([]);
    return Response.json(doc(url.searchParams.get('path')??'main.txt'));
  }} as LiveOptions);t.after(()=>live.close());
  const receive=(type:string,payload:any)=>live.receive({protocolVersion:'3.0',messageId:`e${seq+1}`,sessionId:b.session.sessionId,seq:++seq,type,payload} as any);
  const snapshot=async()=>{if((live as any).session?.sessionId!==b.session.sessionId){socket.readyState=1;await live.connect();socket.onopen?.();}receive('SESSION_SNAPSHOT',structuredClone(b));await setImmediate();assert.equal(live.getState().isOffline,false);};
  await live.connect();await snapshot();
  return {live,b,calls,sent,storage,socket,receive,snapshot,set post(v:typeof post){post=v;},set get(v:typeof get){get=v;},maintenance:()=>live.getState().runtime!.maintenance!,posts:()=>calls.filter(c=>c.path==='/api/runtime/service-network/prepare')};
}
