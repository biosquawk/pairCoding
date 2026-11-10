import fs from 'node:fs';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { userInfo } from 'node:os';
import { require as tsRequire } from 'tsx/cjs/api';
import type { ServerOptions } from '../../../src/server/http';
import type { CoachContext } from '../../../src/server/coach/context';
import type { CoachProvider } from '../../../src/server/coach/provider';
import type { Settings, Snapshot } from '../../../src/shared/protocol';
const { createPairCoachServer } = tsRequire('../../../src/server/http.ts', import.meta.url) as typeof import('../../../src/server/http');
export const seed = 'value = 0\n';
export const reviewSeed = '# Existing human notes\n';
export const brokenSource = 'module.exports = (a, b) => a - b;\n';
export const silent = { kind: 'SILENT', reason: 'G3 provider boundary only; NOT Gemini' };
export type Generate = (facts: any, signal: AbortSignal) => Promise<string>;
export class Provider implements CoachProvider {
  readonly name = 'G3_AI_BOUNDARY_ONLY'; readonly mode = 'INJECTED' as const;
  calls: { context: Readonly<CoachContext>; signal: AbortSignal }[] = [];
  decideData: (c: Readonly<CoachContext>, s: AbortSignal) => unknown = () => silent;
  async decide(c: Readonly<CoachContext>, signal: AbortSignal) {
    this.calls.push({ context: structuredClone(c), signal }); return this.decideData(c, signal);
  }
}
export const approvedSettings: Settings = { taskFilePath: 'challenge.md', taskMode: 'IMPLEMENTATION',
  reviewNotesPath: 'review.md', runProfiles: [], aiConsent: true, contextPatterns: ['**/*'] };
export const programs: Record<string, string> = {
  'main.py': seed, 'challenge.md': '# G3 independent acceptance fixture\n',
  'review.md': reviewSeed, 'bug.js': brokenSource,
  'qa-pass.cjs': `const fs=require('node:fs');const assert=require('node:assert/strict');let failed=false;try{assert.equal(1+1,Number(process.argv[2]??2));}catch{failed=true;}fs.writeFileSync('qa-'+process.env.PAIRCOACH_RUN_ID+'.xml','<testsuite name="actual-assert" tests="1" failures="'+Number(failed)+'" errors="0" skipped="0"><testcase classname="arithmetic" name="addition">'+(failed?'<failure message="actual assertion failed"/>':'')+'</testcase></testsuite>');console.log('Executed actual assertion: '+(failed?'FAILED':'PASSED'));process.exitCode=failed?1:0;`,
  'qa-zero.cjs': `const fs=require('node:fs');fs.writeFileSync('qa-'+process.env.PAIRCOACH_RUN_ID+'.xml','<testsuite tests="0" failures="0" errors="0" skipped="0"/>');console.log('Executed zero test cases');`,
  'qa-unknown.cjs': `console.log('PASSED is just stdout, not a test report');`,
  'qa-tree.cjs': `const fs=require('node:fs');const {spawn}=require('node:child_process');fs.writeFileSync('parent.pid',String(process.pid));const child=spawn(process.execPath,['-e',"const fs=require('node:fs');fs.writeFileSync('child.pid',String(process.pid));setTimeout(()=>fs.writeFileSync('orphan-marker','SURVIVED'),4500);setInterval(()=>{},100);"],{stdio:'ignore',windowsHide:true});console.log('TREE_STARTED');setInterval(()=>console.log('alive'),100);`,
};
export async function fixture(options: { snapshot?: boolean; taskMode?: Settings['taskMode']; generate?: Generate; files?: Record<string, string | Buffer> } = {}) {
  const runtime = path.resolve('artifacts/g3'); fs.mkdirSync(runtime, { recursive: true });
  const base = fs.mkdtempSync(path.join(runtime, 'case-'));
  const rootPath = path.join(base, 'project'), dataDir = path.join(base, 'data');
  fs.mkdirSync(rootPath); fs.mkdirSync(dataDir);
  for (const [p, value] of Object.entries(options.files ?? programs)) fs.writeFileSync(path.join(rootPath, p), value);
  const provider = new Provider(), token = `g3-qa-${randomUUID()}`;
  // Contract agreed by K. On base867 these options are not wired: that is NOT_READY,
  // never a fallback to fake executionFactory/Runner/Report or a skipped acceptance.
  const config: ServerOptions & { enableExecution: boolean; reportGenerate?: Generate } = {
    rootPath, dataDir, token, port: 0, devBootstrap: true, staticDir: path.resolve('dist'),
    enableCoach: true, coachProvider: provider, enableExecution: true,
    ...(options.generate ? { reportGenerate: options.generate } : {}),
  };
  const app = createPairCoachServer(config);
  let snapshot: Snapshot | undefined;
  try {
    app.workspace.updateSettings({ ...approvedSettings, taskMode: options.taskMode ?? 'IMPLEMENTATION' });
    // Real seed capture only, before serving any user operation. No fabricated manifests.
    if (options.snapshot) snapshot = app.workspace.createSnapshot('G3 original', ['main.py', 'review.md']);
    const port = await app.listen();
    const read = (p = 'main.py') => fs.readFileSync(path.join(rootPath, p), 'utf8');
    const frozen = (id: string) => {
      const workspace = app.workspace as typeof app.workspace & { readSnapshot(id: string): { snapshot: Snapshot; files: { path: string; rawBase64: string | null }[] } };
      if (typeof workspace.readSnapshot !== 'function') throw new Error('NOT_READY: real Workspace.readSnapshot missing');
      return workspace.readSnapshot(id);
    };
    return { app, provider, base, rootPath, dataDir, token, snapshot, read, frozen,
      baseURL: `http://127.0.0.1:${port}`, close: () => app.close() };
  } catch (error) { await app.close(); throw error; }
}
export type Fixture = Awaited<ReturnType<typeof fixture>>;
export function profile(kind: 'RUN_MAIN' | 'RUN_TESTS', mode: 'tree' | 'pass' | 'zero' | 'unknown', timeoutMs = 10000) {
  return { kind, executable: process.execPath,
    args: [`qa-${mode}.cjs`],
    cwd: '.', timeoutMs, testReportFormat: mode === 'zero' || mode === 'pass' ? 'JUNIT_XML' : 'NONE',
    testReportGlob: mode === 'zero' || mode === 'pass' ? 'qa-{runId}.xml' : null };
}
export function filesBelow(root: string): Record<string, string> {
  const result: Record<string, string> = {};
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.isFile()) result[path.relative(root, full).replaceAll(path.sep, '/')] = createHash('sha256').update(fs.readFileSync(full)).digest('hex');
    }
  }; walk(root); return result;
}
export function factsFiles(f: Fixture) {
  return Object.fromEntries(Object.keys(filesBelow(f.dataDir)).filter(p => p.endsWith('/facts.json'))
    .map(p => [p, fs.readFileSync(path.join(f.dataDir, p), 'utf8')]));
}
export function alive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('Invalid owned fixture PID');
  try { process.kill(pid, 0); return true; } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ESRCH') return false; throw e; }
}
export function sentinel(f: Fixture) {
  const file = path.join(f.base, 'unrelated-sentinel');
  const child = spawn(process.execPath, ['-e', `const fs=require('node:fs');const p=process.argv[1];setInterval(()=>fs.writeFileSync(p,String(Date.now())),75);`, file],
    { stdio: 'ignore', windowsHide: true });
  return { child, file, async close() {
    if (child.exitCode !== null || child.signalCode !== null) return;
    await new Promise<void>(resolve => { child.once('close', () => resolve()); child.kill(); });
  } };
}
/** Real OS write denial on only the new-snapshot parent. Existing snapshot bytes stay readable.
 * No monkeypatch, disk-full impersonation, randomUUID stub or gate DI. Restore in finally. */
export function denySnapshotWrites(f: Fixture) {
  const parent = path.join(f.app.workspace.dataDir, 'snapshots-v1');
  if (!fs.statSync(parent).isDirectory()) throw new Error('Snapshot store layout changed: review failure injection, do not guess');
  const mode = fs.statSync(parent).mode & 0o777;
  const account = process.env.USERDOMAIN ? `${process.env.USERDOMAIN}\\${userInfo().username}` : userInfo().username;
  const acl = (args: string[]) => {
    const result = spawnSync('icacls.exe', [parent, ...args], { encoding: 'utf8', shell: false, windowsHide: true });
    if (result.status !== 0) throw new Error(`Fixture ACL operation failed exit=${result.status}: ${result.stderr}`);
  };
  if (process.platform === 'win32') acl(['/deny', `${account}:(WD,AD)`]);
  else fs.chmodSync(parent, 0o500);
  const restore = () => { if (process.platform === 'win32') acl(['/remove:d', account]); else fs.chmodSync(parent, mode); };
  try {
    const probe = path.join(parent, 'qa-write-must-be-denied');
    try { fs.mkdirSync(probe); fs.rmdirSync(probe); throw new Error('No real write denial: backup-failure case cannot run'); }
    catch (e) { if (!['EACCES', 'EPERM'].includes((e as NodeJS.ErrnoException).code ?? '')) throw e; }
    return restore;
  } catch (e) { restore(); throw e; }
}
