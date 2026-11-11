import path from 'node:path';
import { constants } from 'node:fs';
import { open, lstat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import type { AdapterOutcome, CollectedArtifacts, ExecutionExit, ExecutionPlan } from '../execution/ports';
import { parseJUnit, REPORT_LIMIT, type JUnitCounts } from './junit';
export type ArtifactReader = (file: string, maxBytes: number) => Promise<Uint8Array>;
/** Bounded regular non-symlink read. Executor supplies scoped, immutable collection, never workspace. */
/** noFollowFlag is an optimization, NEVER the authority; tests can emulate Windows absence with0. */
export async function readRegularArtifact(file: string, maxBytes: number, noFollowFlag = constants.O_NOFOLLOW ?? 0): Promise<Uint8Array> {
  if (!path.isAbsolute(file) || !Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new Error('Invalid artifact read');
  for(let parent=path.dirname(file);;) {
    const info=await lstat(parent,{bigint:true});
    if(info.isSymbolicLink() || !info.isDirectory()) throw new Error('Symlink/non-directory artifact parent');
    const next=path.dirname(parent);if(next===parent)break;parent=next;
  }
  const before=await lstat(file,{bigint:true});
  if(before.isSymbolicLink() || !before.isFile() || before.size>BigInt(maxBytes)) throw new Error('Artifact not bounded regular file');
  const fd=await open(file,constants.O_RDONLY | noFollowFlag);
  const same=(a:typeof before,b:typeof before)=>a.dev===b.dev && a.ino===b.ino && a.size===b.size && a.mtimeNs===b.mtimeNs && a.ctimeNs===b.ctimeNs;
  try {
    const stat=await fd.stat({bigint:true});
    if(!stat.isFile() || !same(before,stat))throw new Error('Artifact identity changed before open');
    const buffer=Buffer.alloc(Number(stat.size)+1),{bytesRead}=await fd.read(buffer,0,buffer.length,0);
    const after=await fd.stat({bigint:true}),current=await lstat(file,{bigint:true});
    if(bytesRead!==Number(stat.size) || current.isSymbolicLink() || !same(stat,after) || !same(stat,current))throw new Error('Artifact identity changed');
    return buffer.subarray(0,bytesRead);
  } finally {await fd.close();}
}
export const readArtifact: ArtifactReader = (file,maxBytes)=>readRegularArtifact(file,maxBytes);
const base = (): AdapterOutcome => ({ status: 'FAILED', testOutcome: 'UNKNOWN', testCount: null, skipped: null, failures: null, errors: null, problem: null });
export async function interpretOutcome(plan: ExecutionPlan, exit: ExecutionExit, artifacts: CollectedArtifacts, read: ArtifactReader = readArtifact): Promise<AdapterOutcome> {
  const result = base();
  const sameHandle = exit.handle.runId === plan.ownership.runId && artifacts.handle.runId === exit.handle.runId && artifacts.handle.opaqueId === exit.handle.opaqueId;
  if (!sameHandle || artifacts.inputManifestSha256 !== plan.input.identity.manifestSha256 || !Number.isInteger(exit.exitCode)) {
    result.problem = { code: 'ARTIFACT_IDENTITY_MISMATCH', message: 'Exit/collection/input do not belong to this Run.', recovery: 'Reconcile the retained Run collection; never reuse old reports.', retryable: false }; return result;
  }
  if (plan.mode === 'RUN_MAIN') { result.status = exit.exitCode === 0 ? 'SUCCEEDED' : 'FAILED'; result.testOutcome = 'NOT_APPLICABLE'; return result; }
  const files = artifacts.files.filter(f => f.kind === 'JUNIT_XML');
  if (!files.length) return result; // exit0 is NOT test proof
  if (files.length > 64 || new Set(files.map(f => f.path)).size !== files.length) return result;
  const sum: JUnitCounts = { count: 0, failures: 0, errors: 0, skipped: 0 }; let total = 0;
  try {
    for (const file of files) {
      const root = path.resolve(plan.input.artifactsDirectory), location = path.resolve(file.path), relative = path.relative(root,location);
      if (!path.isAbsolute(file.path) || location !== file.path || !relative || relative === '..' || relative.startsWith('..'+path.sep) || path.isAbsolute(relative)) return result;
      if (!file.freshForRun || !/\.xml$/i.test(file.path) || !Number.isSafeInteger(file.bytes) || file.bytes < 0 || file.bytes > REPORT_LIMIT || (total += file.bytes) > 16*1024*1024) return result;
      const bytes = await read(file.path, REPORT_LIMIT);
      if (bytes.length !== file.bytes || createHash('sha256').update(bytes).digest('hex') !== file.sha256) return result;
      const parsed = parseJUnit(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
      if (!parsed) return result;
      for (const key of Object.keys(sum) as (keyof JUnitCounts)[]) { sum[key] += parsed[key]; if (!Number.isSafeInteger(sum[key])) return result; }
    }
  } catch { return result; }
  Object.assign(result, { testCount: sum.count, failures: sum.failures, errors: sum.errors, skipped: sum.skipped });
  result.testOutcome = sum.count === 0 ? 'NO_TESTS' : exit.exitCode === 0 && sum.count > sum.skipped && sum.failures === 0 && sum.errors === 0 ? 'PASSED' : 'FAILED';
  result.status = result.testOutcome === 'PASSED' ? 'SUCCEEDED' : 'FAILED';
  return result;
}
