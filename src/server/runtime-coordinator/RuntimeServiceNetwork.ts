/** Explicit local maintenance only. Never invoked implicitly by Run/readiness/startup.
 * Private durable intent + kernel exclusion precede the sole mutating command.
 * Injected Docker transports prove UNIT behavior, not an actual prepared bridge.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { DockerTransport, DockerReply } from '../execution/DockerTransport';
import { validId } from '../errors';
import { safeId } from '../execution/files';
import { JournalLease } from './JournalLease';
import { canonical, canonicalDirectory, createRecord, privateDirectory, readRecord, sha256 } from './storage';

export interface RuntimeServiceNetworkContext {
  readonly layout: Readonly<{stateDirectory:string;installationId:string;projectId:string;workspaceRoot:string}>;
  readonly transport: DockerTransport;
  readonly engineId: string;
  assertCurrent():void;
}
export interface PreparedServiceNetwork {
  readonly schemaVersion:1;
  readonly status:'PREPARED';
  readonly installationId:string;
  readonly projectId:string;
  readonly engineId:string;
  readonly name:string;
  readonly networkId:string;
}
const LIMIT = 64 * 1024, MAX_ATTEMPTS = 128;
const fileStamp=(file:string):string=>{const s=fs.lstatSync(file,{bigint:true});return [s.dev,s.ino,s.mode,s.nlink,s.size,s.mtimeNs,s.ctimeNs].join(':');};
const id64 = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const requireState: (value: unknown, message: string) => asserts value = (value, message) => {
  if (!value) throw Error(`SERVICE_NETWORK: ${message}`);
};
function exact(value: unknown, keys: string[]): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).sort().join(',') === [...keys].sort().join(',');
}
export function runtimeServiceNetworkName(installationId:string):string {
  requireState(validId(installationId), 'invalid installation ID');
  const name = `paircoach-${installationId}-service`;
  requireState(safeId(name), 'installation identity cannot form approved service name (80 character limit); never truncate or replace identity');
  return name;
}
function directoryIdentity(directory: string): string {
  canonicalDirectory(directory);
  const s = fs.lstatSync(directory, {bigint:true});
  requireState(process.platform === 'win32' || (s.mode & 0o077n) === 0n, 'state directory must be private');
  return [s.dev,s.ino,s.mode].join(':');
}
function privateRead(file: string, missing = false, maxBytes = LIMIT): Buffer | null {
  const b = readRecord(file, maxBytes, missing);
  if (b !== null) requireState(process.platform === 'win32' || (fs.lstatSync(file).mode & 0o077) === 0, 'record must be private');
  return b;
}
function decode(bytes: Buffer): unknown {
  try { return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes)); }
  catch { throw Error('SERVICE_NETWORK: malformed durable record; retain state and reconcile'); }
}
type Intent = {schemaVersion:1;kind:'CREATE_INTENT';installationId:string;projectId:string;engineId:string;name:string;requestId:string;sequence:number};
type Response = {schemaVersion:1;kind:'CREATE_RESPONSE';intentSha256:string;outcome:'CONFIRMED_ID'|'UNKNOWN'|'INVALID_SUCCESS';networkId:string|null};
type Receipt = PreparedServiceNetwork & {intentSha256:string};
/** Snapshot anchors copied inputs, identity bytes, directory inodes and observed durable records.
 * No async filesystem gaps are introduced between guard and a local write.
 */
function authority(input: RuntimeServiceNetworkContext) {
  input.assertCurrent();
  const layout = {...input.layout}, engineId = input.engineId, transport = input.transport;
  requireState(typeof engineId === 'string' && engineId.length > 0 && engineId.length <= 256 && !/[\s\x00-\x1f\x7f]/.test(engineId), 'invalid approved engine ID');
  const name = runtimeServiceNetworkName(layout.installationId);
  requireState(validId(layout.projectId), 'invalid project ID');
  canonicalDirectory(layout.workspaceRoot);
  const ws=fs.lstatSync(layout.workspaceRoot,{bigint:true}), workspaceIdentity=[ws.dev,ws.ino].join(':');
  const stateIdentity = directoryIdentity(layout.stateDirectory);
  const relative = (a:string,b:string) => { const r=path.relative(a,b); return r==='' || (!r.startsWith('..'+path.sep) && r!=='..' && !path.isAbsolute(r)); };
  requireState(!relative(layout.workspaceRoot,layout.stateDirectory) && !relative(layout.stateDirectory,layout.workspaceRoot), 'state and workspace must be disjoint');
  const identityFile = path.join(layout.stateDirectory,'installation.json');
  const identityBytes = privateRead(identityFile, false, 4096)!;
  const identityStamp=fileStamp(identityFile);
  const identity = decode(identityBytes);
  requireState(exact(identity,['version','workspaceRoot','projectId','installationId']) && identity.version === 1 &&
    identity.workspaceRoot === layout.workspaceRoot && identity.projectId === layout.projectId && identity.installationId === layout.installationId,
    'existing installation identity mismatch; never reset it');
  const directory = path.join(layout.stateDirectory,'service-network');
  let childIdentity: string | null = null, lease: JournalLease | undefined;
  const observed = new Map<string, {bytes:Buffer;stamp:string}>();
  function guard() {
    input.assertCurrent();
    requireState(canonical(input.layout) === canonical(layout) && input.engineId === engineId && input.transport === transport, 'context changed');
    canonicalDirectory(layout.workspaceRoot);
    const wsNow=fs.lstatSync(layout.workspaceRoot,{bigint:true});
    requireState([wsNow.dev,wsNow.ino].join(':')===workspaceIdentity, 'workspace root identity changed');
    requireState(directoryIdentity(layout.stateDirectory) === stateIdentity, 'state directory identity changed');
    requireState(privateRead(identityFile, false, 4096)!.equals(identityBytes) && fileStamp(identityFile)===identityStamp, 'installation identity changed');
    if (childIdentity !== null) requireState(directoryIdentity(directory) === childIdentity, 'service directory identity changed');
    lease?.assertCurrent();
    for (const [file, record] of observed) requireState(privateRead(file)!.equals(record.bytes) && fileStamp(file)===record.stamp, 'durable authority changed');
  }
  function exists() {
    guard();
    try { childIdentity = directoryIdentity(directory); return true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
  }
  function read(name:string): Buffer | null {
    guard(); const file=path.join(directory,name), b=privateRead(file,true);
    if (b !== null) observed.set(file,{bytes:b,stamp:fileStamp(file)});
    return b;
  }
  function write(name:string, value:unknown) {
    guard(); const file=path.join(directory,name), bytes=Buffer.from(canonical(value)+'\n');
    createRecord(file,bytes); observed.set(file,{bytes,stamp:fileStamp(file)}); guard();
  }
  async function run(args:readonly string[]):Promise<DockerReply> {
    guard();
    let reply: DockerReply;
    try { reply = await transport.run(args,{timeoutMs:10000,maxBytes:LIMIT}); }
    catch { guard(); throw Error('SERVICE_NETWORK: Docker outcome UNKNOWN; retain intent, use explicit prepare to reconcile; no automatic retry'); }
    guard();
    requireState(reply && Number.isInteger(reply.exitCode) && typeof reply.stdout==='string' && typeof reply.stderr==='string' &&
      Buffer.byteLength(reply.stdout)+Buffer.byteLength(reply.stderr)<=LIMIT, 'malformed or unbounded Docker reply');
    return reply;
  }
  async function engine() {
    const r=await run(['info','--format','{{json .ID}}']);
    requireState(r.exitCode===0, 'engine check failed; no absence inferred');
    let id:unknown; try { id=JSON.parse(r.stdout); } catch { throw Error('SERVICE_NETWORK: malformed engine identity'); }
    requireState(id===engineId, 'approved engine identity mismatch');
  }
  const labels = {'paircoach.installation':layout.installationId,'paircoach.project':layout.projectId,
    'paircoach.engine':engineId,'paircoach.role':'service-network'};
  async function observe():Promise<string|null> {
    await engine(); guard();
    const r=await run(['network','ls','--no-trunc','--filter',`name=^${name}$`,'--format','{{json .}}']);
    requireState(r.exitCode===0, 'exact network listing failed; no absence inferred');
    let rows:unknown[]; try { rows=r.stdout.trim()===''?[]:r.stdout.trim().split('\n').map(line=>JSON.parse(line)); }
    catch { throw Error('SERVICE_NETWORK: malformed exact network listing'); }
    requireState(rows.length<=1, 'ambiguous network name');
    await engine(); guard();
    if (!rows.length) return null;
    const row=rows[0] as Record<string,unknown>;
    requireState(row && row.Name===name && id64(row.ID), 'unexpected exact-name listing');
    const inspected=await run(['network','inspect',row.ID]);
    requireState(inspected.exitCode===0, 'network inspect failed; no absence inferred');
    let data:unknown; try { data=JSON.parse(inspected.stdout); } catch { throw Error('SERVICE_NETWORK: malformed network inspect'); }
    requireState(Array.isArray(data) && data.length===1, 'ambiguous network inspect');
    const net=data[0];
    requireState(net && net.Id===row.ID && id64(net.Id) && net.Name===name && net.Internal===true && net.Driver==='bridge' &&
      net.Scope==='local' && canonical(net.Labels)===canonical(labels), 'foreign, external, malformed or replaced service bridge');
    await engine(); guard();
    return net.Id;
  }
  const binding = {installationId:layout.installationId,projectId:layout.projectId,engineId,name};
  function ledger() {
    guard();
    const entries=fs.readdirSync(directory);
    if (entries.includes('lease')) requireState(read('lease')!.length===0, 'invalid persistent lock inode');
    requireState(entries.length<=3*MAX_ATTEMPTS+2 && entries.every(e=>e==='lease' || e==='receipt.json' || /^(intent|absence|response)-\d{3}\.json$/.test(e)), 'unknown or unbounded durable ledger');
    const intents:Intent[]=[];
    for (const filename of entries.filter(e=>e.startsWith('intent-')).sort()) {
      const value=decode(read(filename)!);
      requireState(exact(value,['schemaVersion','kind',...Object.keys(binding),'requestId','sequence']) && value.schemaVersion===1 && value.kind==='CREATE_INTENT' &&
        validId(value.requestId) && value.sequence===intents.length+1 && filename===intentFile(value.sequence as number) &&
        Object.entries(binding).every(([k,v])=>value[k]===v), 'foreign or corrupt intent');
      requireState(!intents.some(i=>i.requestId===value.requestId), 'duplicate durable request ID');
      intents.push(value as Intent);
    }
    requireState(intents.length<=MAX_ATTEMPTS, 'attempt budget exhausted');
    for (const file of entries.filter(e=>e.startsWith('absence-'))) {
      const n=Number(file.slice(8,11)), intent=intents[n-1], value=decode(read(file)!);
      requireState(intent && exact(value,['schemaVersion','kind','intentSha256']) && value.schemaVersion===1 && value.kind==='ABSENCE_CONFIRMED' &&
        value.intentSha256===sha256(Buffer.from(canonical(intent)+'\n')), 'corrupt absence proof');
    }
    const responses=new Map<number,Response>();
    for (const file of entries.filter(e=>e.startsWith('response-'))) {
      const n=Number(file.slice(9,12)), intent=intents[n-1], value=decode(read(file)!);
      requireState(intent && exact(value,['schemaVersion','kind','intentSha256','outcome','networkId']) && value.schemaVersion===1 && value.kind==='CREATE_RESPONSE' &&
        ['CONFIRMED_ID','UNKNOWN','INVALID_SUCCESS'].includes(value.outcome as string) && (value.outcome==='CONFIRMED_ID'?id64(value.networkId):value.networkId===null) &&
        value.intentSha256===sha256(Buffer.from(canonical(intent)+'\n')), 'corrupt create response');
      responses.set(n,value as Response);
    }
    for (const i of intents.slice(0,-1)) requireState(entries.includes(absenceFile(i.sequence)), 'unreconciled prior intent');
    const bytes=read('receipt.json'); let receipt:Receipt|null=null;
    if (bytes) {
      const value=decode(bytes), last=intents.at(-1);
      requireState(last && exact(value,['schemaVersion','status',...Object.keys(binding),'networkId','intentSha256']) && value.schemaVersion===1 && value.status==='PREPARED' && id64(value.networkId) &&
        Object.entries(binding).every(([k,v])=>value[k]===v) && value.intentSha256===sha256(Buffer.from(canonical(last)+'\n')), 'foreign or corrupt receipt');
      const response=responses.get(last.sequence);
      requireState(response?.outcome!=='INVALID_SUCCESS' && (response?.networkId==null || response.networkId===value.networkId), 'receipt contradicts persisted create response');
      receipt={schemaVersion:1,status:'PREPARED',...binding,networkId:value.networkId as string,intentSha256:value.intentSha256 as string};
    }
    return {intents,receipt,entries,responses};
  }
  return {guard,exists,read,write,run,engine,observe,binding,ledger,directory,
    lock() { guard(); privateDirectory(directory); childIdentity=directoryIdentity(directory); guard(); lease=new JournalLease(path.join(directory,'lease')); guard(); },
    close() { lease?.close(); },
  };
}
const intentFile=(n:number)=>`intent-${String(n).padStart(3,'0')}.json`;
const absenceFile=(n:number)=>`absence-${String(n).padStart(3,'0')}.json`;
const publicReceipt=({intentSha256:_,...value}:Receipt):PreparedServiceNetwork=>Object.freeze(value);

export async function inspectRuntimeServiceNetwork(context:RuntimeServiceNetworkContext):Promise<PreparedServiceNetwork|null> {
  const a=authority(context), present=a.exists();
  const state=present?a.ledger():null;
  const id=await a.observe(); a.guard();
  if (state?.receipt) {
    requireState(id===state.receipt.networkId, 'receipted bridge missing or replaced; reconcile, never recreate');
    return publicReceipt(state.receipt);
  }
  requireState(id===null, 'SERVICE_NETWORK_PREPARE_REQUIRED: unreceipted bridge; explicit reconciliation required');
  return null;
}
export async function prepareRuntimeServiceNetwork(context:RuntimeServiceNetworkContext & {readonly requestId:string}):Promise<PreparedServiceNetwork> {
  requireState(validId(context.requestId), 'invalid maintenance request ID');
  const requestId=context.requestId, a=authority(context);
  try {
    a.lock();
    const state=a.ledger();
    let id=await a.observe(); a.guard();
    if (state.receipt) {
      requireState(id===state.receipt.networkId, 'receipted bridge missing or replaced; no recreate');
      return publicReceipt(state.receipt);
    }
    let last=state.intents.at(-1);
    const prior=last?state.responses.get(last.sequence):undefined;
    requireState(prior?.outcome!=='INVALID_SUCCESS', 'malformed successful create response; retain for manual reconciliation');
    if (id!==null) {
      requireState(last, 'preexisting unreceipted network is not adoptable');
      requireState(prior?.networkId==null || prior.networkId===id, 'persisted create/readback ID mismatch; no adoption');
      // Only durable local intent on this exact engine/name/labels permits recovery.
      const receipt:Receipt={schemaVersion:1,status:'PREPARED',...a.binding,networkId:id,intentSha256:sha256(Buffer.from(canonical(last)+'\n'))};
      a.write('receipt.json',receipt); return publicReceipt(receipt);
    }
    if (last) {
      if (!state.entries.includes(absenceFile(last.sequence))) {
        a.write(absenceFile(last.sequence),{schemaVersion:1,kind:'ABSENCE_CONFIRMED',intentSha256:sha256(Buffer.from(canonical(last)+'\n'))});
        throw Error('SERVICE_NETWORK: prior create outcome UNKNOWN; fresh absence recorded. Use a separately explicit NEW request after reconciliation; same request never recreates');
      }
      requireState(!state.intents.some(i=>i.requestId===requestId), 'original request retained; no duplicate create');
    }
    requireState(state.intents.length<MAX_ATTEMPTS, 'attempt budget exhausted; manual reconciliation required');
    last={schemaVersion:1,kind:'CREATE_INTENT',...a.binding,requestId,sequence:state.intents.length+1};
    a.write(intentFile(last.sequence),last);
    await a.engine(); a.guard();
    // No caller-selected flags/name/labels, no rm/connect/disconnect/prune or Run invocation.
    const args=['network','create','--driver','bridge','--internal'];
    const labels={'paircoach.installation':a.binding.installationId,'paircoach.project':a.binding.projectId,
      'paircoach.engine':a.binding.engineId,'paircoach.role':'service-network'};
    args.push(...Object.entries(labels).flatMap(([k,v])=>['--label',`${k}=${v}`]),a.binding.name);
    let returnedId:string|null=null, outcome:Response['outcome']='UNKNOWN';
    try {
      a.guard();
      const reply=await a.run(args); a.guard();
      if (reply.exitCode===0) {
        outcome=id64(reply.stdout.trim())?'CONFIRMED_ID':'INVALID_SUCCESS';
        if (outcome==='CONFIRMED_ID') returnedId=reply.stdout.trim();
      }
    } catch { a.guard(); /* Outcome unknown, NEVER repeat create; exact readback below. */ }
    a.write(`response-${String(last.sequence).padStart(3,'0')}.json`,{schemaVersion:1,kind:'CREATE_RESPONSE',intentSha256:sha256(Buffer.from(canonical(last)+'\n')),outcome,networkId:returnedId});
    id=await a.observe(); a.guard();
    requireState(id!==null, 'create outcome UNKNOWN; retain intent and explicitly reconcile, no automatic retry');
    requireState(outcome!=='INVALID_SUCCESS', 'malformed successful create response; manual reconciliation required');
    requireState(returnedId===null || returnedId===id, 'create/readback ID mismatch; retain intent');
    const receipt:Receipt={schemaVersion:1,status:'PREPARED',...a.binding,networkId:id,intentSha256:sha256(Buffer.from(canonical(last)+'\n'))};
    a.write('receipt.json',receipt); return publicReceipt(receipt);
  } finally { a.close(); }
}
