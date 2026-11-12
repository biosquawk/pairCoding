import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { constants } from 'node:fs';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { atomicNoReplace } from '../AtomicNoReplace';
import type {
  AdapterOutcome, CollectedArtifacts, DurableTerminalReceipt, DurableUnstartedCancellationReceipt, ExecutionExit, ExecutionHandle, ExecutionOwnership, ExecutionPlan
} from './ports';
import {
  canonicalDirectory, durableWrite, fsyncDirectory, readRegular, requireThat, safeId, sha256, canonicalJson
} from './files';
const require = createRequire(import.meta.url);
const lockProtocol = 'PairCoach journal native exclusion v2\n';
const lockError = (code:string, message:string, cause?:unknown) => Object.assign(new Error(message, { cause }), { code });

/** Stable marker publication fences old wx-only binaries too: they can no longer
 * create the name. An empty legacy sentinel is ambiguous, so NEVER adopt/delete it.
 * Atomic no-replace prevents a crash from publishing a partial marker and preserves
 * a concurrent publisher's inode. The marker/locked inode is NEVER unlinked.
 */
async function prepareLockFile(directory:string):Promise<string> {
  await canonicalDirectory(directory);
  const file=path.join(directory,'.transaction-lock');
  try {
    await fs.lstat(file);
  } catch(error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    const temporary=path.join(directory,'.lock-protocol-'+randomUUID()+'.tmp');
    try {
      await durableWrite(temporary,lockProtocol);
      try { atomicNoReplace(temporary,file); }
      catch(error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
      await fsyncDirectory(directory);
    } finally { await fs.rm(temporary,{ force:true }); }
  }
  requireThat((await readRegular(file,Buffer.byteLength(lockProtocol))).toString()===lockProtocol,
    'Legacy/unknown journal lock: preserve for scoped operator reconciliation; no guessed recovery');
  return file;
}

/** Native, nonblocking, process-death-released lease. Synchronous FFI only, from
 * existing pinned application dependency koffi (same trust boundary as no-replace).
 * No shell/helper/TTL/PID probes, async native worker, unlink, or in-memory fallback.
 */
async function acquireLock(file:string):Promise<()=>Promise<void>> {
  let koffi:any, flock:any, create:any, close:any, lastError:any;
  try {
    koffi=require('koffi');
    if(process.platform==='linux') flock=koffi.load('libc.so.6').func('int flock(int, int)');
    else if(process.platform==='win32') {
      requireThat(!!process.env.SystemRoot && path.isAbsolute(process.env.SystemRoot),'Missing trusted SystemRoot');
      const kernel=koffi.load(path.join(process.env.SystemRoot!,'System32','kernel32.dll'));
      // intptr_t preserves INVALID_HANDLE_VALUE (-1) and pointer-sized HANDLE values.
      create=kernel.func('__stdcall','CreateFileW','intptr_t',['str16','uint32','uint32','void *','uint32','uint32','intptr_t']);
      close=kernel.func('__stdcall','CloseHandle','int',['intptr_t']);
      lastError=kernel.func('__stdcall','GetLastError','uint32',[]);
    } else throw new Error('Unsupported journal locking platform');
  } catch(error) { throw lockError('JOURNAL_LOCK_UNAVAILABLE','Native journal exclusion unavailable; no fallback',error); }
  if(process.platform==='linux') {
    const fd=await fs.open(file,constants.O_RDWR | (constants.O_NOFOLLOW ?? 0));
    try {
      // LOCK_EX | LOCK_NB: separate open file descriptions conflict even in one
      // process. Closing this descriptor (also on SIGKILL) releases ownership.
      if(flock(fd.fd,2|4)!==0) {
        const number=koffi.errno();
        const code=number===koffi.os.errno.EAGAIN || number===koffi.os.errno.EWOULDBLOCK ? 'EEXIST' : 'JOURNAL_LOCK_FAILED';
        throw lockError(code,'Journal lease refused (errno '+number+')');
      }
      const opened=await fd.stat({ bigint:true }), named=await fs.lstat(file,{ bigint:true });
      requireThat(opened.isFile() && !named.isSymbolicLink() && opened.nlink===1n && named.nlink===1n &&
        opened.dev===named.dev && opened.ino===named.ino,'Journal lock identity changed');
      requireThat((await readRegular(file,Buffer.byteLength(lockProtocol))).toString()===lockProtocol,'Journal lock protocol changed');
      return ()=>fd.close();
    } catch(error) { await fd.close(); throw error; }
  }
  // OPEN_EXISTING, GENERIC_READ|WRITE, FILE_SHARE_READ only. Every independent
  // transaction handle requests WRITE: kernel sharing checks exclude live peers,
  // including this process, while readonly marker inspection remains possible.
  // No FILE_SHARE_DELETE, inheritable handle, truncation, or reparse-point follow.
  const handle=create(path.toNamespacedPath(file),0xC0000000,1,null,3,0x00200000,0);
  if(handle===-1 || handle===-1n || handle===0 || handle===0n) {
    const number=lastError();
    throw lockError(number===32 || number===33 ? 'EEXIST' : 'JOURNAL_LOCK_FAILED','Journal handle refused (Win32 '+number+')');
  }
  const release=async()=>{ if(!close(handle)) throw lockError('JOURNAL_LOCK_RELEASE_FAILED','CloseHandle failed (Win32 '+lastError()+')'); };
  try {
    await canonicalDirectory(path.dirname(file));
    requireThat((await readRegular(file,Buffer.byteLength(lockProtocol))).toString()===lockProtocol,'Journal lock protocol changed');
    return release;
  } catch(error) { await release(); throw error; }
}

export interface JournalRecord {
  version:1;
  createdAt:number;
  revision:number;
  handle:ExecutionHandle;
  ownership:ExecutionOwnership;
  plan:ExecutionPlan;
  phase:'INTENT'|'CREATED'|'RUNNING'|'STOP_UNCONFIRMED'|'EXITED'|'COLLECTED'|'TERMINAL'|'REMOVED';
  /** Missing on legacy records means UNKNOWN, never implicitly NOT_DISPATCHED. */
  startDispatch?: 'NOT_DISPATCHED'|'MAY_HAVE_BEEN_DISPATCHED'|'REVOKED';
  unstartedCancellation?: { kind?:'CREATED'|'ABSENT_INTENT'; evidencePath:string; evidenceSha256:string; confirmedAt:string|null };
  containerId:string|null;
  exit:ExecutionExit|null;
  collection:CollectedArtifacts|null;
  outcome:AdapterOutcome|null;
}
function cancellationIdentity(r:JournalRecord):boolean {
  const kind=r.unstartedCancellation?.kind;
  return kind==='ABSENT_INTENT' ? r.containerId===null && ['INTENT','STOP_UNCONFIRMED','REMOVED'].includes(r.phase) :
    (kind===undefined || kind==='CREATED') && typeof r.containerId==='string' && /^[a-f0-9]{64}$/.test(r.containerId);
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
    try { await fs.mkdir(this.directory, { mode:0o700 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    await canonicalDirectory(this.directory);
    // On Win32 privacy relies on the configured controlled parent's inherited ACL, not mode bits.
    if (process.platform !== 'win32') requireThat(((await fs.lstat(this.directory, { bigint:true })).mode & 0o077n) === 0n, 'Journal must be private');
  }
  private async locked<T>(fn:()=>Promise<T>):Promise<T> {
    const release=await acquireLock(await prepareLockFile(this.directory));
    try { return await fn(); }
    finally { await release(); }
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
    requireThat(r.startDispatch===undefined || ['NOT_DISPATCHED','MAY_HAVE_BEEN_DISPATCHED','REVOKED'].includes(r.startDispatch),'Unknown dispatch fence');
    if(r.unstartedCancellation)requireThat(r.startDispatch==='REVOKED' && cancellationIdentity(r) && !r.exit && !r.collection && !r.outcome &&
      typeof r.unstartedCancellation.evidencePath==='string' && /^[a-f0-9]{64}$/.test(r.unstartedCancellation.evidenceSha256) &&
      (r.phase==='REMOVED' ? typeof r.unstartedCancellation.confirmedAt==='string' && Number.isFinite(Date.parse(r.unstartedCancellation.confirmedAt)) && Date.parse(r.unstartedCancellation.confirmedAt)>0 : r.unstartedCancellation.confirmedAt===null),'Invalid cancellation journal');
    if(r.startDispatch==='REVOKED' && r.phase==='REMOVED')requireThat(r.unstartedCancellation,'Revoked removal lacks cancellation proof');
    return r;
  }
  /** Cross-instance admission is atomic. An uncertain/crashed run fences new runs until reconciliation. */
  async reserve(record:JournalRecord) {
    await this.locked(async()=>{
      requireThat((await this.list()).every(r=>r.phase==='REMOVED'),'Unreconciled run blocks admission');
      requireThat(record.phase==='INTENT' && record.revision===0 && !record.containerId && !record.exit && !record.collection && !record.outcome && !record.unstartedCancellation,'New reserve must be a fresh intent');
      record.startDispatch='NOT_DISPATCHED';
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
  private async writeUpdate(record:JournalRecord, recovery=false, claim=false) {
    const old=await this.read(record.handle.runId);
    requireThat(old.revision===record.revision,'Concurrent journal revision');
    requireThat(old.createdAt===record.createdAt && old.handle.opaqueId===record.handle.opaqueId && canonicalJson(old.ownership)===canonicalJson(record.ownership) && canonicalJson(old.plan)===canonicalJson(record.plan) && (!old.containerId || old.containerId===record.containerId),'Journal ownership changed');
    const fenceUnchanged=old.startDispatch===record.startDispatch;
    requireThat(fenceUnchanged || (old.startDispatch==='NOT_DISPATCHED' &&
      (claim && record.startDispatch==='MAY_HAVE_BEEN_DISPATCHED' || recovery && record.startDispatch==='REVOKED')),'Start dispatch fence cannot regress/change without native CAS');
    requireThat(recovery || canonicalJson(old.unstartedCancellation??null)===canonicalJson(record.unstartedCancellation??null),'Cancellation requires native recovery exclusion');
    if(record.unstartedCancellation)requireThat(record.startDispatch==='REVOKED' && cancellationIdentity(record) && !record.exit && !record.collection && !record.outcome,'Cancellation contradicts process evidence');
    if(old.unstartedCancellation)requireThat(record.unstartedCancellation &&
      old.unstartedCancellation.kind===record.unstartedCancellation.kind && old.unstartedCancellation.evidencePath===record.unstartedCancellation.evidencePath && old.unstartedCancellation.evidenceSha256===record.unstartedCancellation.evidenceSha256 &&
      (!old.unstartedCancellation.confirmedAt || old.unstartedCancellation.confirmedAt===record.unstartedCancellation.confirmedAt),'Cancellation intent immutable');
    if(old.phase==='REMOVED')requireThat(canonicalJson(old)===canonicalJson(record),'Removed journal immutable');
    const next={...record,revision:record.revision+1};
    await durableWrite(this.filename(record.handle.runId),canonicalJson(next));
    record.revision=next.revision;
  }
  async update(record:JournalRecord){ await this.locked(()=>this.writeUpdate(record)); }
  /** Native exclusion spans the create invocation; revocation cannot slip between check and dispatch. */
  async withCreateAuthority<T>(record:JournalRecord, dispatch:()=>Promise<T>):Promise<T> {
    return this.locked(async()=>{
      requireThat(canonicalJson(await this.read(record.handle.runId))===canonicalJson(record) && record.startDispatch==='NOT_DISPATCHED' && record.phase==='INTENT' && !record.containerId,'Create authority revoked/changed');
      return dispatch();
    });
  }
  /** Durable monotonic CAS MUST resolve before transport.start is invoked. */
  async claimStart(record:JournalRecord):Promise<void> {
    await this.locked(async()=>{
      requireThat(record.startDispatch==='NOT_DISPATCHED' && !record.unstartedCancellation,'Start authority unavailable');
      record.startDispatch='MAY_HAVE_BEEN_DISPATCHED';
      await this.writeUpdate(record,false,true);
    });
  }
  /** The native lease spans bounded evidence, intent publication, recheck, rm and absence.
   * All saves CAS the exact revision/plan. No second recovery or delayed create/start can enter.
   */
  async withUnstartedRecovery<T>(record:JournalRecord, action:(save:()=>Promise<void>)=>Promise<T>):Promise<T> {
    return this.locked(async()=>{
      requireThat(canonicalJson(await this.read(record.handle.runId))===canonicalJson(record) &&
        ['NOT_DISPATCHED','REVOKED'].includes(record.startDispatch??''),'No positive no-dispatch authority');
      return action(()=>this.writeUpdate(record,true));
    });
  }
  async cancellationReceipt(record:JournalRecord):Promise<DurableUnstartedCancellationReceipt> {
    // Re-acknowledge a visible final rename whose original directory-flush response
    // may have failed. A read alone must not upgrade that uncertainty to durability.
    await fsyncDirectory(this.directory);
    const bytes=await readRegular(this.filename(record.handle.runId),4*1024*1024),r=await this.read(record.handle.runId),c=r.unstartedCancellation;
    requireThat(canonicalJson(r)===canonicalJson(record) && r.phase==='REMOVED' && r.startDispatch==='REVOKED' && c && cancellationIdentity(r) &&
      !r.exit && !r.collection && !r.outcome && typeof c.confirmedAt==='string' && Number.isFinite(Date.parse(c.confirmedAt)) && Date.parse(c.confirmedAt)>0 && /^[a-f0-9]{64}$/.test(c.evidenceSha256),'No durable unstarted cancellation');
    return Object.freeze({handle:Object.freeze({...r.handle}),ownership:Object.freeze({...r.ownership}),containerId:r.containerId,...(c.kind==='ABSENT_INTENT'?{kind:'ABSENT_INTENT' as const}:{}),
      inputManifestSha256:r.plan.input.identity.manifestSha256,planSha256:sha256(canonicalJson(r.plan)),
      evidenceSha256:c.evidenceSha256,journalSha256:sha256(bytes),confirmedAt:c.confirmedAt}) as DurableUnstartedCancellationReceipt;
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
