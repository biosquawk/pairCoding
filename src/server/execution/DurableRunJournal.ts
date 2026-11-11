import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type {
  AdapterOutcome, CollectedArtifacts, DurableTerminalReceipt, ExecutionExit, ExecutionHandle, ExecutionOwnership, ExecutionPlan
} from './ports';
import {
  canonicalDirectory, durableWrite, fsyncDirectory, readRegular, requireThat, safeId, sha256, canonicalJson
} from './files';
export interface JournalRecord {
  version:1;
  createdAt:number;
  revision:number;
  handle:ExecutionHandle;
  ownership:ExecutionOwnership;
  plan:ExecutionPlan;
  phase:'INTENT'|'CREATED'|'RUNNING'|'STOP_UNCONFIRMED'|'EXITED'|'COLLECTED'|'TERMINAL'|'REMOVED';
  containerId:string|null;
  exit:ExecutionExit|null;
  collection:CollectedArtifacts|null;
  outcome:AdapterOutcome|null;
}
export class DurableRunJournal {
  constructor(readonly directory:string, readonly installationId:string) {
    requireThat(safeId(installationId),'Invalid installation');
  }
  private filename(runId:string){
    requireThat(safeId(runId),'Invalid runId');
    return path.join(this.directory,runId+'.json');
  }
  async initialize(){
    await canonicalDirectory(path.dirname(this.directory));
    await fs.mkdir(this.directory,{
      mode:0o700,recursive:true
    });
    await canonicalDirectory(this.directory);
    requireThat(((await fs.stat(this.directory)).mode&0o077)===0,'Journal must be private');
  }
  private async locked<T>(fn:()=>Promise<T>):Promise<T> {
    const file=path.join(this.directory,'.transaction-lock');
    const fd=await fs.open(file,'wx',0o600);
    try{
      return await fn();
    }finally{
      await fd.close();
      await fs.unlink(file);
      await fsyncDirectory(this.directory);
    }
  }
  async list():Promise<JournalRecord[]> {
    const names=await fs.readdir(this.directory);
    requireThat(names.length<=10000,'Journal count limit');
    const records:JournalRecord[]=[];
    for(const name of names.filter(n=>n.endsWith('.json')).sort()){
      const r=await this.read(name.slice(0,-5));
      records.push(r);
    }
    return records;
  }
  async read(runId:string):Promise<JournalRecord>{
    const r=JSON.parse((await readRegular(this.filename(runId),4*1024*1024)).toString()) as JournalRecord;
    requireThat(r.version===1 && Number.isFinite(r.createdAt) && Number.isSafeInteger(r.revision) && r.revision>=0 && r.handle.runId===runId && r.ownership.installationId===this.installationId && r.ownership.runId===runId && canonicalJson(r.plan.ownership)===canonicalJson(r.ownership) && r.plan.input.identity.runId===runId && ['INTENT','CREATED','RUNNING','STOP_UNCONFIRMED','EXITED','COLLECTED','TERMINAL','REMOVED'].includes(r.phase),'Corrupt/foreign journal');
    return r;
  }
  /** Cross-instance admission is atomic. An uncertain/crashed run fences new runs until reconciliation. */
  async reserve(record:JournalRecord) {
    await this.locked(async()=>{
      requireThat((await this.list()).every(r=>r.phase==='REMOVED'),'Unreconciled run blocks admission');
      const file=this.filename(record.handle.runId);
      const fd=await fs.open(file,'wx',0o600);
      try{
        await fd.writeFile(canonicalJson(record));
        await fd.sync();
      }finally{
        await fd.close();
      }
      await fsyncDirectory(this.directory);
      requireThat(canonicalJson(await this.read(record.handle.runId))===canonicalJson(record),'Intent readback mismatch');
    });
  }
  async update(record:JournalRecord){
    await this.locked(async()=>{
      const old=await this.read(record.handle.runId);
      requireThat(old.revision===record.revision,'Concurrent journal revision');
      requireThat(old.handle.opaqueId===record.handle.opaqueId && canonicalJson(old.ownership)===canonicalJson(record.ownership) && canonicalJson(old.plan)===canonicalJson(record.plan),'Journal ownership changed');
      const next={
        ...record,revision:record.revision+1
      };
      await durableWrite(this.filename(record.handle.runId),canonicalJson(next));
      record.revision=next.revision;
    });
  }
  async receipt(record:JournalRecord):Promise<DurableTerminalReceipt> {
    const bytes=await readRegular(this.filename(record.handle.runId),4*1024*1024);
    const r=await this.read(record.handle.runId);
    requireThat(r.phase==='TERMINAL' && r.exit && r.collection && r.outcome && canonicalJson(r)===canonicalJson(record),'No verified terminal outcome');
    return Object.freeze({
      handle:Object.freeze({
        ...r.handle
      }),ownership:Object.freeze({
        ...r.ownership
      }),exit:Object.freeze({
        ...r.exit
      }),collectionSha256:r.collection.collectionSha256,journalSha256:sha256(bytes)
    }) as DurableTerminalReceipt;
  }
}
