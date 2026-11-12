/** Durable explicit local maintenance requests. Separate from expiring HTTP receipts and
 * source RUN/SAVE outcomes. An uncertain dispatch is recovered read-first, never replayed.
 */
import fs from 'node:fs';
import path from 'node:path';
import { AppError } from '../errors';
import { validateRuntimeNetworkPrepareRequest } from './RuntimeHttpValidation';
import { JournalLease } from './JournalLease';
import type { RuntimeExecutionLayout } from './RuntimeExecutionLayout';
import { runtimeServiceNetworkName, type PreparedServiceNetwork } from './RuntimeServiceNetwork';
import { canonical, privateDirectory, createRecord, readRecord, replaceRecord, SerialQueue, sha256 } from './storage';
export interface RuntimeNetworkPrepareRequest {
  requestId:string; clientId:string; sessionId:string; expectedWorkspaceVersion:number;
  configurationGeneration:string; controlEpoch:number;
}
export interface NetworkMaintenanceContext {layout:RuntimeExecutionLayout;engineId:string;purpose?:'http-nat-v1'}
export class NetworkMaintenanceAbsence extends Error {
  constructor(readonly state:'NOT_DISPATCHED'|'ABSENCE_CONFIRMED') {super('Original maintenance reconciled without an available bridge; use a separately explicit new request.');}
}
interface Entry { state:'PENDING'|'PREPARED'|'NOT_DISPATCHED'|'ABSENCE_CONFIRMED'; context:NetworkMaintenanceContext|null; version:1; projectId:string; request:RuntimeNetworkPrepareRequest; result:PreparedServiceNetwork|null }
export class RuntimeNetworkMaintenance {
  private readonly queue=new SerialQueue();
  private readonly lease:JournalLease;
  private closed=false;
  constructor(private readonly directory:string,private readonly projectId:string) {
    privateDirectory(directory);this.lease=new JournalLease(path.join(directory,'lease'));
    try {this.entries();} catch(error) {this.lease.close();throw error;}
  }
  private check() {if(this.closed)throw Error('Maintenance owner closed');this.lease.assertCurrent();}
  private key(request:RuntimeNetworkPrepareRequest) {return sha256(canonical([this.projectId,request.clientId,request.requestId]));}
  private encode(body:Entry) {return Buffer.from(canonical({body,sha256:sha256(canonical(body))}));}
  private entries():Entry[] {
    this.check();const names=fs.readdirSync(this.directory);if(names.length>1001)throw Error('Maintenance budget exceeded');
    return names.filter(name=>name!=='lease').map(name=>{
      if(!/^[a-f0-9]{64}\.json$/.test(name))throw Error('Unreconciled maintenance record');
      const r=JSON.parse(new TextDecoder('utf8',{fatal:true}).decode(readRecord(path.join(this.directory,name),16384)!));
      const e=r.body as Entry;
      if(!e || e.version!==1 || e.projectId!==this.projectId || !validateRuntimeNetworkPrepareRequest(e.request) || r.sha256!==sha256(canonical(e)) || name!==this.key(e.request)+'.json' ||
          Object.keys(e).sort().join(',')!=='context,projectId,request,result,state,version' || !['PENDING','PREPARED','NOT_DISPATCHED','ABSENCE_CONFIRMED'].includes(e.state) || (e.state==='PREPARED')!==(e.result!==null) ||
          e.context!==null && (!e.context || !['engineId,layout','engineId,layout,purpose'].includes(Object.keys(e.context).sort().join(',')) || ('purpose' in e.context && e.context.purpose!=='http-nat-v1') || typeof e.context.engineId!=='string' || !e.context.layout || e.context.layout.projectId!==this.projectId) ||
          e.result!==null && (!e.context || Object.keys(e.result).sort().join(',')!=='engineId,installationId,name,networkId,projectId,schemaVersion,status' || e.result.schemaVersion!==1 || e.result.status!=='PREPARED'||e.result.projectId!==this.projectId ||
            e.result.engineId!==e.context.engineId || e.result.installationId!==e.context.layout.installationId || e.result.name!==runtimeServiceNetworkName(e.context.layout.installationId,e.context.purpose) || !/^[a-f0-9]{64}$/.test(e.result.networkId)))throw Error('Invalid maintenance record');
      return e;
    });
  }
  execute(original:RuntimeNetworkPrepareRequest, authorize:(retained:boolean)=>void,
      perform:(recovery:boolean,context:NetworkMaintenanceContext|null,stage:(context:NetworkMaintenanceContext)=>void)=>Promise<PreparedServiceNetwork>):Promise<PreparedServiceNetwork> {
    const request=structuredClone(original);
    return this.queue.run(async()=>{
      this.check();const entries=this.entries(), prior=entries.find(e=>this.key(e.request)===this.key(request));
      if(prior && canonical(prior.request)!==canonical(request))throw new AppError(409,'IDEMPOTENCY_CONFLICT','Maintenance ID belongs to another immutable request.');
      authorize(!!prior);
      if(prior && ['NOT_DISPATCHED','ABSENCE_CONFIRMED'].includes(prior.state))throw new AppError(409,'SERVICE_NETWORK_'+prior.state,'Original maintenance is reconciled without a bridge. Use a separately explicit NEW request; never replay this original.');
      if(!prior && entries.some(e=>e.state==='PENDING'))throw new AppError(409,'SERVICE_NETWORK_OUTCOME_UNKNOWN','Reconcile the exact original maintenance request before a new one.');
      if(!prior && entries.length>=1000)throw new AppError(409,'MAINTENANCE_LIMIT','Maintenance budget exhausted; retain the original records.');
      let entry:Entry=prior??{state:'PENDING',context:null,version:1,projectId:this.projectId,request,result:null};
      const file=path.join(this.directory,this.key(request)+'.json');
      // Complete immutable body fsynced BEFORE any Docker operation or async dispatch.
      if(!prior)createRecord(file,this.encode(entry));
      let result:PreparedServiceNetwork;
      try {result=await perform(!!prior,structuredClone(entry.context),context=>{
        this.check();authorize(false);
        if(!context || !['engineId,layout','engineId,layout,purpose'].includes(Object.keys(context).sort().join(',')) ||
            ('purpose' in context && context.purpose!=='http-nat-v1'))throw Error('Unknown maintenance context/purpose');
        if(prior || entry.context)throw Error('Original maintenance context may only be staged once before dispatch');
        entry={...entry,context:structuredClone(context)};replaceRecord(file,this.encode(entry));
      });}
      catch(error) {
        this.check();
        if(!entry.context || error instanceof NetworkMaintenanceAbsence) {
          const state=error instanceof NetworkMaintenanceAbsence?error.state:'NOT_DISPATCHED';
          replaceRecord(file,this.encode({...entry,state}));
          throw new AppError(409,'SERVICE_NETWORK_'+state,'Original maintenance reconciled without an available bridge. Use a separately explicit NEW request; the original is never replayed.');
        }
        throw new AppError(503,'SERVICE_NETWORK_OUTCOME_UNKNOWN','Service network preparation/readback is unconfirmed. Retain this exact request and reconcile; no automatic create retry.');}
      this.check();authorize(true);
      // Even a known receipt requires fresh authoritative Docker/engine readback on every call.
      if(prior?.result && canonical(prior.result)!==canonical(result))throw new AppError(409,'SERVICE_NETWORK_CHANGED','Prepared bridge changed; preserve original maintenance receipt.');
      if(!entry.result)replaceRecord(file,this.encode({...entry,state:'PREPARED',result:structuredClone(result)}));
      return structuredClone(prior?.result??result);
    });
  }
  close():Promise<void> {return this.queue.run(()=>{if(!this.closed){this.lease.close();this.closed=true;}});}
}
