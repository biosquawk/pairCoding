import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { serialize, deserialize } from 'node:v8';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import schema from '../shared/ws.schema.json';
import type { ApiError } from '../shared/protocol';

// The schema builders are from HUMAN file2; payload names match authoritative file1.
const ajv = new Ajv2020({ allErrors: false, strict: false });
addFormats(ajv);
ajv.addSchema(schema, 'paircoach');
const clientValidator = ajv.compile({ $ref: 'paircoach#/$defs/ClientMessage' });
const requestValidators = new Map<string, ReturnType<typeof ajv.compile>>();
export interface ClientMessage {
  protocolVersion: '3.0'; messageId: string; sessionId: string; clientId: string;
  type: string; payload: Record<string, any>;
}
export function validateMessage(value: unknown): value is ClientMessage {
  return Boolean(clientValidator(value));
}
export function validateRequest(name: string, value: unknown): boolean {
  let validate = requestValidators.get(name);
  if (!validate) {
    validate = ajv.compile({ $ref: `paircoach#/$defs/${name}` });
    requestValidators.set(name, validate);
  }
  return Boolean(validate(value));
}
export function apiError(error: unknown, requestId: string | null = null): ApiError {
  const candidate = error as { status?: number; code?: string; message?: string; currentVersion?: number };
  const safe = typeof candidate?.status === 'number' && candidate.status >= 400 && candidate.status < 500;
  const reservedLedgerCode = typeof candidate?.code === 'string' && Object.hasOwn(ledgerMessages,candidate.code);
  const ambiguous = candidate instanceof TransportError && candidate.status === 503 && reservedLedgerCode;
  // Reserved warnings are local capabilities, not arbitrary exception properties.
  // Sanitize a spoofed code too, so journal reconstruction cannot upgrade it on retry.
  return { code: reservedLedgerCode && !ambiguous ? 'INTERNAL_ERROR' : candidate?.code || 'INTERNAL_ERROR',
    message: ambiguous ? ledgerMessages[candidate.code!] : safe ? candidate.message || 'Żądanie odrzucone.' :
      'Błąd operacji lokalnej. Dane nie zostały potwierdzone.',
    retryable: !safe && !ambiguous, requestId, currentVersion: candidate?.currentVersion ?? null };
}
export class TransportError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}
const ledgerMessages:Record<string,string>={
  COMMAND_RESULT_UNAVAILABLE:'Wynik przekroczył budżet rejestru. Operacja mogła się wykonać. Zsynchronizuj stan; nie ponawiaj z nowym ID.',
  COMMAND_STORAGE_UNAVAILABLE:'Rejestr komend jest niedostępny; wynik jest nieznany. Operacja mogła się wykonać. Zsynchronizuj stan; nie ponawiaj z nowym ID.',
};
export function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.entries(value).sort(([a],[b]) => a.localeCompare(b)).map(([k,v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
}

export interface CommandLedgerOptions {
  maxEntries?: number; maxBytes?: number; maxPending?: number; maxOutcomeBytes?: number;
  tempRoot?: string; limitMessage?: string;
}
type SafeFailure = { status:number; code:string; message:string; currentVersion:number|null };
type Outcome = { ok:true; value:unknown } | { ok:false; error:SafeFailure };
type Receipt = { fingerprint:string; outcome:Outcome };
const digest = (value:string|Buffer) => createHash('sha256').update(value).digest('hex');

/**
 * Process-local idempotency, not a durable replay log. Only fixed-size key digests and
 * offsets remain in RAM after settlement. No eviction: retirement rejects the old scope.
 * A private packed journal owns terminal results; a bounded pending set owns live effects.
 */
export class CommandLedger {
  private entries = new Map<string,{offset:number; length:number}>();
  private pending = new Map<string,{fingerprint:string; result:Promise<unknown>}>();
  private fallback = new Map<string,Buffer>();
  private bytes = 0;
  private directory:string|undefined;
  private journal:string|undefined;
  private identity:{dev:number;ino:number}|undefined;
  private failed = false;
  private retired = false;
  private readonly maxEntries:number;
  private readonly maxBytes:number;
  private readonly maxPending:number;
  private readonly maxOutcomeBytes:number;
  constructor(private readonly options:CommandLedgerOptions = {}) {
    this.maxEntries=options.maxEntries ?? 250000;
    this.maxBytes=options.maxBytes ?? 256*1024*1024;
    this.maxPending=options.maxPending ?? 16;
    this.maxOutcomeBytes=options.maxOutcomeBytes ?? Math.min(8*1024*1024,this.maxBytes);
    for(const value of [this.maxEntries,this.maxBytes,this.maxPending,this.maxOutcomeBytes])
      if(!Number.isSafeInteger(value) || value<1) throw new RangeError('Ledger budgets must be positive safe integers.');
    if(this.maxOutcomeBytes<1024 || this.maxOutcomeBytes>this.maxBytes)
      throw new RangeError('Ledger maxOutcomeBytes must be at least 1024 and no greater than maxBytes.');
  }
  private storageFailure() {
    this.failed=true;
    return new TransportError(503,'COMMAND_STORAGE_UNAVAILABLE',ledgerMessages.COMMAND_STORAGE_UNAVAILABLE);
  }
  private ensureStorage() {
    if(this.journal) return;
    try {
      this.directory=fs.mkdtempSync(path.join(this.options.tempRoot ?? os.tmpdir(),'paircoach-ledger-'));
      fs.chmodSync(this.directory,0o700);
      this.journal=path.join(this.directory,'receipts.bin');
      const fd=fs.openSync(this.journal,'wx',0o600);
      try { const stat=fs.fstatSync(fd);this.identity={dev:stat.dev,ino:stat.ino}; }
      finally {fs.closeSync(fd);}
    } catch { throw this.storageFailure(); }
  }
  private openJournal(write=false) {
    // Re-open by path: a removed/replaced journal or changed permissions is not a cache miss.
    const stat=fs.lstatSync(this.journal!);
    if(!stat.isFile() || stat.dev!==this.identity!.dev || stat.ino!==this.identity!.ino || stat.size!==this.bytes)
      throw this.storageFailure();
    const fd=fs.openSync(this.journal!,write?'r+':'r');
    try {
      const opened=fs.fstatSync(fd);
      if(opened.dev!==stat.dev || opened.ino!==stat.ino || opened.size!==this.bytes) throw this.storageFailure();
      return fd;
    } catch(error) {fs.closeSync(fd);throw error;}
  }
  private encode(receipt:Receipt) {
    const body=serialize(receipt);
    return Buffer.concat([createHash('sha256').update(body).digest(),body]);
  }
  private decode(record:Buffer):Receipt {
    if(record.length<33 || !createHash('sha256').update(record.subarray(32)).digest().equals(record.subarray(0,32)))
      throw this.storageFailure();
    const receipt=deserialize(record.subarray(32)) as Receipt;
    if(!receipt || typeof receipt.fingerprint!=='string' || !/^[a-f0-9]{64}$/.test(receipt.fingerprint) ||
        !receipt.outcome || typeof receipt.outcome.ok!=='boolean') throw this.storageFailure();
    if(!receipt.outcome.ok) {
      const e=receipt.outcome.error;
      if(!e || typeof e.status!=='number' || typeof e.code!=='string' || typeof e.message!=='string') throw this.storageFailure();
    }
    return receipt;
  }
  private read(entry:{offset:number;length:number}) {
    let fd:number|undefined;
    try {
      fd=this.openJournal();
      const buffer=Buffer.alloc(entry.length);
      let count=0;
      while(count<buffer.length) {
        const read=fs.readSync(fd,buffer,count,buffer.length-count,entry.offset+count);
        if(!read) throw this.storageFailure();
        count+=read;
      }
      return this.decode(buffer);
    } catch {throw this.storageFailure();}
    finally {if(fd!==undefined)fs.closeSync(fd);}
  }
  private write(key:string,record:Buffer) {
    let fd:number|undefined;
    try {
      fd=this.openJournal(true);
      let count=0;
      while(count<record.length) {
        const written=fs.writeSync(fd,record,count,record.length-count,this.bytes+count);
        if(!written) throw this.storageFailure();
        count+=written;
      }
      this.entries.set(key,{offset:this.bytes,length:record.length});
      this.bytes+=record.length;
    } finally {if(fd!==undefined)fs.closeSync(fd);}
  }
  private safeFailure(error:unknown):SafeFailure {
    const status=(error as {status?:number})?.status;
    const safeStatus=typeof status==='number' && Number.isInteger(status) && status>=400 && status<=599 ? status : 500;
    const publicError=apiError(error);
    const code=typeof publicError.code==='string' ? publicError.code.slice(0,128) : 'INTERNAL_ERROR';
    // No arbitrary Error object, cause, stack or custom payload survives settlement.
    const message=String(publicError.message).slice(0,Math.min(16384,Math.floor(this.maxOutcomeBytes/16)));
    return {status:safeStatus,code,message,currentVersion:Number.isFinite(publicError.currentVersion)?publicError.currentVersion:null};
  }
  private value<T>(receipt:Receipt):T {
    if(receipt.outcome.ok) return receipt.outcome.value as T;
    const failure=receipt.outcome.error;
    throw Object.assign(new TransportError(failure.status,failure.code,failure.message),{currentVersion:failure.currentVersion});
  }
  private duplicate<T>(receipt:Receipt,fingerprint:string) {
    if(receipt.fingerprint!==fingerprint) throw new TransportError(409,'IDEMPOTENCY_CONFLICT','Ten identyfikator ma już inną treść.');
    return {duplicate:true,result:Promise.resolve().then(()=>this.value<T>(receipt))};
  }
  run<T>(key:string,input:unknown,operation:()=>Promise<T>|T):{duplicate:boolean;result:Promise<T>} {
    if(this.retired) throw new TransportError(409,'COMMAND_SCOPE_RETIRED','Zakres komend został zamknięty; zsynchronizuj aktualną sesję.');
    const keyHash=digest(key), fingerprint=digest(canonical(input) ?? 'undefined');
    const pending=this.pending.get(keyHash);
    if(pending) {
      if(pending.fingerprint!==fingerprint) throw new TransportError(409,'IDEMPOTENCY_CONFLICT','Ten identyfikator ma już inną treść.');
      return {duplicate:true,result:pending.result as Promise<T>};
    }
    const fallback=this.fallback.get(keyHash);
    if(fallback) return this.duplicate<T>(this.decode(fallback),fingerprint);
    const existing=this.entries.get(keyHash);
    if(existing) return this.duplicate<T>(this.read(existing),fingerprint);
    if(this.failed) throw this.storageFailure();
    if(this.pending.size>=this.maxPending) throw new TransportError(429,'COMMAND_PENDING_LIMIT','Trwa zbyt wiele komend. Poczekaj na ich rozliczenie.');
    // Reserve terminal-result space before the effect. Known IDs above never consume admission.
    if(this.entries.size+this.pending.size>=this.maxEntries ||
        this.bytes+(this.pending.size+1)*this.maxOutcomeBytes>this.maxBytes)
      throw new TransportError(429,'COMMAND_LIMIT',this.options.limitMessage ?? 'Osiągnięto budżet komend sesji. Zachowaj dane i otwórz projekt ponownie, aby rozpocząć nową sesję.');
    this.ensureStorage();
    // Check storage before NEW effects too, not just when looking up a known ID.
    try {const fd=this.openJournal(true);fs.closeSync(fd);} catch {throw this.storageFailure();}
    const result=Promise.resolve().then(operation).then(
      value=>this.settle<T>(keyHash,fingerprint,{ok:true,value}),
      error=>this.settle<T>(keyHash,fingerprint,{ok:false,error:this.safeFailure(error)})
    );
    this.pending.set(keyHash,{fingerprint,result});
    return {duplicate:false,result};
  }
  private settle<T>(key:string,fingerprint:string,outcome:Outcome):T {
    let record:Buffer;
    try {
      try {
        record=this.encode({fingerprint,outcome});
        if(record.length>this.maxOutcomeBytes) throw new Error('Outcome exceeds reserved budget');
      } catch {
        this.failed=true;
        outcome={ok:false,error:{status:503,code:'COMMAND_RESULT_UNAVAILABLE',currentVersion:null,
          message:ledgerMessages.COMMAND_RESULT_UNAVAILABLE}};
        record=this.encode({fingerprint,outcome});
      }
      try {this.write(key,record);}
      catch {
        // At most maxPending in-flight effects can reach here after a failure. Each
        // retained buffer is bounded by maxOutcomeBytes; never retain resolved promises.
        this.failed=true;this.fallback.set(key,record);
      }
      // Return the same serialized snapshot used by terminal replay, not a mutable
      // service-owned object that a later command could change before HTTP writes it.
      return this.value<T>(this.decode(record));
    } finally {
      this.pending.delete(key);
      if(this.retired && !this.pending.size) this.cleanup();
    }
  }
  /** Already-issued pending results settle normally. No later run may restart this scope. */
  retire():void {this.retired=true;if(!this.pending.size)this.cleanup();}
  close():void {this.retire();}
  private cleanup() {
    this.entries.clear();this.fallback.clear();
    // Cleanup cannot replace a known command result with a second filesystem error.
    try {if(this.directory)fs.rmSync(this.directory,{recursive:true,force:true});} catch { /* documented crash/IO residue */ }
  }
}
