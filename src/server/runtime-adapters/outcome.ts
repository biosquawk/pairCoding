import path from 'node:path';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import type { AdapterOutcome, CollectedArtifacts, ExecutionExit, ExecutionPlan } from '../execution/ports';
import { parseJUnit, REPORT_LIMIT, type JUnitCounts } from './junit';
export type ArtifactReader = (file: string, maxBytes: number) => Promise<Uint8Array>;
/** Bounded regular non-symlink read. Executor supplies scoped, immutable collection, never workspace. */
export const readArtifact: ArtifactReader = async (file, maxBytes) => {
  const fd = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await fd.stat();
    if (!stat.isFile() || stat.size > maxBytes) throw new Error('Artifact not bounded regular file');
    const buffer = Buffer.alloc(stat.size + 1); const { bytesRead } = await fd.read(buffer, 0, buffer.length, 0);
    const after = await fd.stat();
    if (bytesRead !== stat.size || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs) throw new Error('Artifact changed');
    return buffer.subarray(0, bytesRead);
  } finally { await fd.close(); }
};
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
