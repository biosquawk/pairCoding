/** Stable private execution identity. Never derive installation ownership from a container/PID.
 * The composition root supplies an approved application-state directory OUTSIDE the workspace.
 */
import path from 'node:path';
import fs from 'node:fs';
const requireEmptyState = (directory: string) => fs.readdirSync(directory).length === 0;
import { randomUUID } from 'node:crypto';
import { validId, AppError } from '../errors';
import { canonical, canonicalDirectory, createRecord, privateDirectory, readRecord, sha256 } from './storage';
export interface RuntimeExecutionLayout {
  readonly stateDirectory: string;
  readonly runRoot: string;
  readonly journalDirectory: string;
  readonly installationId: string;
  readonly projectId: string;
  readonly workspaceRoot: string;
}
const inside = (root: string, candidate: string) => candidate === root || candidate.startsWith(root + path.sep);
export function createRuntimeExecutionLayout(applicationStateDirectory: string, workspaceRoot: string, projectId: string, readOnlyRoots: readonly string[] = []): RuntimeExecutionLayout {
  canonicalDirectory(workspaceRoot);
  if (!validId(projectId) || !path.isAbsolute(applicationStateDirectory) ||
      path.normalize(applicationStateDirectory) !== applicationStateDirectory ||
      inside(workspaceRoot, applicationStateDirectory) || inside(applicationStateDirectory, workspaceRoot) ||
      readOnlyRoots.some(root => !path.isAbsolute(root) || inside(root, applicationStateDirectory) || inside(applicationStateDirectory, root)))
    throw new AppError(409, 'UNSAFE_RUNTIME_STATE', 'Execution state must be an approved private directory separate from original sources.');
  privateDirectory(applicationStateDirectory);
  const projects = path.join(applicationStateDirectory, 'projects'); privateDirectory(projects);
  const stateDirectory = path.join(projects, sha256(workspaceRoot)); privateDirectory(stateDirectory);
  const file = path.join(stateDirectory, 'installation.json');
  let bytes = readRecord(file, 4096, true);
  if (bytes === null) {
    if (requireEmptyState(stateDirectory) === false) throw new AppError(409, 'RUNTIME_OWNERSHIP_CHANGED', 'Prior runtime state has no durable installation identity. Preserve it for recovery.');
    const next = Buffer.from(canonical({ version: 1, workspaceRoot, projectId, installationId: randomUUID() }));
    try { createRecord(file, next); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    bytes = readRecord(file, 4096)!;
  }
  const record = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  if (!record || canonical(Object.keys(record).sort()) !== canonical(['installationId','projectId','version','workspaceRoot']) ||
      record.version !== 1 || record.workspaceRoot !== workspaceRoot || record.projectId !== projectId || !validId(record.installationId))
    throw new AppError(409, 'RUNTIME_OWNERSHIP_CHANGED', 'Retain original execution ownership; do not replace installation identity.');
  const runRoot = path.join(stateDirectory, 'runs'); privateDirectory(runRoot);
  const journalDirectory = path.join(stateDirectory, 'journal'); privateDirectory(journalDirectory);
  return Object.freeze({ stateDirectory, runRoot, journalDirectory, installationId: record.installationId, projectId, workspaceRoot });
}
