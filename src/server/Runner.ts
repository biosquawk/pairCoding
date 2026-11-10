import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { minimatch } from 'minimatch';
import { XMLParser, XMLValidator } from 'fast-xml-parser';
import type { Run, RunProfile } from '../shared/protocol';
import { AppError } from './errors';

const TAIL_LIMIT = 65536;
const REPORT_LIMIT = 4 * 1024 * 1024;
const clone = <T>(value: T): T => structuredClone(value);
const terminal = (run: Run) => !['QUEUED', 'RUNNING'].includes(run.status);
const key = (p: RunProfile) => JSON.stringify([p.kind, p.executable, p.args, p.cwd,
  p.timeoutMs, p.testReportFormat, p.testReportGlob]);

type ReportFile = { file: string; signature: string; mtimeMs: number };
type Job = {
  run: Run; child: ChildProcess | null; profile: RunProfile; cwd: string;
  baseline: Map<string, string>; startedMs: number; outputSeq: number;
  timer?: ReturnType<typeof setTimeout>; poll?: ReturnType<typeof setInterval>;
  done: Promise<Run>; resolve: (run: Run) => void;
  termination?: Promise<void>; requested?: 'CANCELLED' | 'TIMED_OUT'; killFailed: boolean;
};

function safeCwd(root: string, cwd: string): string {
  const target = path.resolve(root, cwd);
  const relative = path.relative(root, target);
  if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) {
    throw new AppError(403, 'UNSAFE_RUN_CWD', 'Katalog wykonania musi należeć do projektu.');
  }
  let current = root;
  for (const part of relative.split(path.sep).filter(Boolean)) {
    if (/[:\x00-\x1f]/.test(part) || /[. ]$/.test(part) ||
        /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)) {
      throw new AppError(403, 'UNSAFE_RUN_CWD', 'Niedozwolona ścieżka wykonania.');
    }
    current = path.join(current, part);
    if (lstatSync(current).isSymbolicLink()) {
      throw new AppError(403, 'UNSAFE_RUN_CWD', 'Dowiązania i junctions nie są dozwolone.');
    }
  }
  if (!statSync(target).isDirectory() || realpathSync(target) !== target) {
    throw new AppError(403, 'UNSAFE_RUN_CWD', 'Niedozwolony katalog wykonania.');
  }
  return target;
}

function validateProfile(p: RunProfile): void {
  if (!p || !['RUN_MAIN', 'RUN_TESTS'].includes(p.kind) || typeof p.executable !== 'string' ||
      !p.executable.length || p.executable.length > 1024 || /[\x00\r\n]/.test(p.executable) ||
      !Array.isArray(p.args) || p.args.length > 100 || p.args.some(a => typeof a !== 'string' || a.length > 4096 || a.includes('\0')) ||
      typeof p.cwd !== 'string' || !p.cwd.length || /[\x00\r\n]/.test(p.cwd) ||
      !Number.isInteger(p.timeoutMs) || p.timeoutMs < 1000 || p.timeoutMs > 300000 ||
      !['NONE', 'JUNIT_XML'].includes(p.testReportFormat)) {
    throw new AppError(400, 'INVALID_RUN_PROFILE', 'Niepoprawny profil uruchomienia.');
  }
  if (p.testReportGlob !== null && (typeof p.testReportGlob !== 'string' ||
      !p.testReportGlob.length || p.testReportGlob.length > 1024 ||
      p.testReportGlob.split('/').some(s => s === '..' || s === '.') ||
      /[\\:\x00-\x1f]/.test(p.testReportGlob) || path.isAbsolute(p.testReportGlob))) {
    throw new AppError(403, 'UNSAFE_REPORT_PATH', 'Raport musi być względnym wzorcem POSIX w katalogu wykonania.');
  }
  if (p.testReportFormat === 'JUNIT_XML' && !p.testReportGlob) {
    throw new AppError(400, 'INVALID_RUN_PROFILE', 'Profil JUnit wymaga testReportGlob.');
  }
}

/** Bounded, non-following scan. No old report is deleted to manufacture freshness. */
function reports(cwd: string, glob: string | null): ReportFile[] {
  if (!glob) return [];
  const files: ReportFile[] = [];
  let visited = 0;
  const walk = (dir: string, relative: string, depth: number) => {
    if (depth > 20) throw new Error('Report scan depth exceeded');
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (++visited > 10000) throw new Error('Report scan limit exceeded');
      const rel = relative ? `${relative}/${entry.name}` : entry.name;
      const file = path.join(dir, entry.name);
      const st = lstatSync(file, { bigint: true });
      if (st.isSymbolicLink()) continue;
      if (st.isDirectory()) {
        if (!['.git', 'node_modules', '.paircoach', '.venv', '__pycache__'].includes(entry.name)) walk(file, rel, depth + 1);
      } else if (st.isFile() && minimatch(rel, glob, { dot: true, nocase: process.platform === 'win32' })) {
        if (files.length >= 128 || st.size > BigInt(REPORT_LIMIT)) throw new Error('Report size/count limit exceeded');
        const digest = createHash('sha256').update(readFileSync(file)).digest('hex');
        files.push({ file, signature: `${st.dev}:${st.ino}:${st.size}:${st.mtimeNs}:${st.ctimeNs}:${digest}`,
          mtimeMs: Number(st.mtimeNs / 1000000n) });
      }
    }
  };
  walk(cwd, '', 0);
  return files;
}

/** Conservative JUnit dialect: well-formed XML, real testcase elements, consistent counters. */
export function parseJUnit(xml: string): { count: number; failures: number; skipped: number } | null {
  if (Buffer.byteLength(xml) > REPORT_LIMIT || /<!\s*(DOCTYPE|ENTITY)/i.test(xml) || XMLValidator.validate(xml) !== true) return null;
  const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_',
    parseAttributeValue: false, processEntities: false, isArray: name => name === 'testsuite' || name === 'testcase' });
  try {
    const parsed = parser.parse(xml);
    if ((parsed.testsuite !== undefined) === (parsed.testsuites !== undefined)) return null;
    const integer = (value: unknown): number => {
      if (typeof value !== 'string' || !/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) throw new Error('Invalid count');
      return Number(value);
    };
    type Counts = { tests: number; failures: number; errors: number; skipped: number };
    const visit = (suite: any, aggregateRoot = false): Counts => {
      if (!suite || typeof suite !== 'object' || Array.isArray(suite) || suite.testsuites !== undefined) throw new Error('Invalid suite');
      let totals: Counts = { tests: 0, failures: 0, errors: 0, skipped: 0 };
      const aggregate = aggregateRoot || suite.testsuite !== undefined;
      if (aggregate) {
        if (suite.testcase !== undefined || !Array.isArray(suite.testsuite) || !suite.testsuite.length) throw new Error('Invalid aggregate suite');
        for (const child of suite.testsuite) {
          const counts = visit(child);
          for (const key of Object.keys(totals) as (keyof Counts)[]) {
            totals[key] += counts[key];
            if (!Number.isSafeInteger(totals[key])) throw new Error('Count overflow');
          }
        }
      } else {
        const cases = suite.testcase ?? [];
        totals.tests = cases.length;
        for (const testcase of cases) {
          const failed = testcase.failure !== undefined;
          const error = testcase.error !== undefined;
          const skipped = testcase.skipped !== undefined;
          if (Number(failed) + Number(error) + Number(skipped) > 1) throw new Error('Conflicting testcase outcomes');
          totals.failures += Number(failed); totals.errors += Number(error); totals.skipped += Number(skipped);
        }
      }
      for (const key of Object.keys(totals) as (keyof Counts)[]) {
        const declared = suite['@_' + key];
        // Leaves keep the conservative dialect: tests required, missing outcomes mean zero.
        // Aggregates may omit counters, but every declared counter must match all descendants.
        if (aggregate && declared === undefined) continue;
        const expected = declared === undefined && key !== 'tests' ? 0 : integer(declared);
        if (expected !== totals[key]) throw new Error('Inconsistent ' + key);
      }
      return totals; // Only leaf cases contribute, never add declared aggregate totals.
    };
    const totals = parsed.testsuites !== undefined ? visit(parsed.testsuites, true) :
      visit({ testsuite: parsed.testsuite }, true);
    return { count: totals.tests, failures: totals.failures + totals.errors, skipped: totals.skipped };
  } catch { return null; }
}

export class Runner {
  private root: string;
  private approved = new Set<string>();
  private jobs = new Map<string, Job>();
  constructor(private options: { rootPath: string; getWorkspaceVersion: () => number; emit: (type: string, payload: unknown) => void }) {
    this.root = realpathSync(options.rootPath);
  }

  /** Called only by trusted settings wiring; never accept profiles directly from AI or /run body. */
  setApprovedProfiles(profiles: RunProfile[]): void {
    if (!Array.isArray(profiles) || profiles.length > 2) throw new AppError(400, 'INVALID_RUN_PROFILE', 'Maksymalnie dwa profile.');
    profiles.forEach(validateProfile);
    this.approved = new Set(profiles.map(key));
  }

  start(profile: RunProfile): Run {
    validateProfile(profile);
    if (!this.approved.has(key(profile))) throw new AppError(403, 'RUN_PROFILE_NOT_APPROVED', 'Profil nie został zatwierdzony w ustawieniach.');
    if ([...this.jobs.values()].some(j => !terminal(j.run))) throw new AppError(409, 'RUN_IN_PROGRESS', 'Inne uruchomienie jest nadal aktywne.');
    const cwd = safeCwd(this.root, profile.cwd);
    const runId = randomUUID();
    const expanded = clone(profile);
    expanded.args = expanded.args.map(a => a.replaceAll('{runId}', runId));
    expanded.testReportGlob = expanded.testReportGlob?.replaceAll('{runId}', runId) ?? null;
    const baseline = new Map<string, string>();
    // Failure to inventory reports prevents a later PASSED, but never prevents manual Run.
    let inventoryValid = true;
    try { for (const r of reports(cwd, expanded.testReportGlob)) baseline.set(r.file, r.signature); }
    catch { inventoryValid = false; }
    const run: Run = { runId, mode: profile.kind, status: 'QUEUED', exitCode: null,
      workspaceVersionAtStart: this.options.getWorkspaceVersion(), workspaceChangedDuringRun: false,
      testOutcome: profile.kind === 'RUN_MAIN' ? 'NOT_APPLICABLE' : 'UNKNOWN', testCount: null,
      outputTail: '', outputTruncated: false, startedAt: null, finishedAt: null };
    let resolve!: (run: Run) => void;
    const done = new Promise<Run>(r => { resolve = r; });
    const job: Job = { run, child: null, profile: expanded, cwd, baseline, startedMs: Date.now(), outputSeq: 0,
      done, resolve, killFailed: false };
    this.jobs.set(runId, job);
    this.emitState(job);
    const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/(token|secret|password|api_?key|credential)/i.test(k)));
    env.PAIRCOACH_RUN_ID = runId;
    try {
      const child = spawn(expanded.executable, expanded.args, { cwd, shell: false, windowsHide: true,
        detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'], env });
      job.child = child;
      run.status = 'RUNNING'; run.startedAt = new Date(job.startedMs).toISOString();
      this.emitState(job);
      job.poll = setInterval(() => this.checkVersion(job), 20);
      job.timer = setTimeout(() => { void this.terminate(job, 'TIMED_OUT').catch(() => {}); }, profile.timeoutMs);
      for (const [stream, readable] of [['STDOUT', child.stdout], ['STDERR', child.stderr]] as const) {
        const decoder = new StringDecoder('utf8');
        readable!.on('data', (data: Buffer) => this.output(job, stream, decoder.write(data)));
        readable!.on('end', () => this.output(job, stream, decoder.end()));
      }
      child.once('error', error => {
        const code = (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'EXECUTABLE_NOT_FOUND' : 'EXECUTABLE_START_FAILED';
        this.output(job, 'STDERR', `${code}\n`); // do not echo environment or arbitrary error text
      });
      child.once('close', (code, signal) => {
        void (async () => {
          if (job.termination) await job.termination.catch(() => {});
          this.finish(job, code, signal, inventoryValid);
        })();
      });
    } catch {
      this.output(job, 'STDERR', 'EXECUTABLE_START_FAILED\n');
      this.finish(job, null, null, false);
    }
    return clone(run);
  }

  get(runId: string): Run { return clone(this.job(runId).run); }
  list(): Run[] { return [...this.jobs.values()].map(j => clone(j.run)); }
  async stop(runId: string): Promise<Run> {
    const job = this.job(runId);
    if (!terminal(job.run)) await this.terminate(job, 'CANCELLED');
    return clone(await job.done);
  }
  async stopAll(): Promise<void> { await Promise.all([...this.jobs.keys()].map(id => this.stop(id))); }

  private job(id: string): Job {
    const job = this.jobs.get(id);
    if (!job) throw new AppError(404, 'RUN_NOT_FOUND', 'Nie znaleziono uruchomienia.');
    return job;
  }
  private checkVersion(job: Job): void {
    if (this.options.getWorkspaceVersion() !== job.run.workspaceVersionAtStart) job.run.workspaceChangedDuringRun = true;
  }
  private emitState(job: Job): void { this.options.emit('RUN_STATE', clone(job.run)); }
  private output(job: Job, stream: 'STDOUT' | 'STDERR', text: string): void {
    if (!text) return;
    this.checkVersion(job);
    for (let i = 0; i < text.length; i += 16384) {
      const chunk = text.slice(i, i + 16384);
      job.run.outputTail += chunk;
      if (job.run.outputTail.length > TAIL_LIMIT) {
        job.run.outputTail = job.run.outputTail.slice(-TAIL_LIMIT); job.run.outputTruncated = true;
      }
      this.options.emit('RUN_OUTPUT', { runId: job.run.runId, outputSeq: ++job.outputSeq, stream, chunk });
    }
  }
  private terminate(job: Job, status: 'CANCELLED' | 'TIMED_OUT'): Promise<void> {
    if (job.termination) return job.termination;
    if (terminal(job.run)) return Promise.resolve();
    job.requested = status;
    const pid = job.child?.pid;
    job.termination = (async () => {
      if (!pid) return;
      if (process.platform === 'win32') {
        await new Promise<void>((resolve, reject) => {
          // Fixed executable and numeric PID; never interpolated into cmd.exe/PowerShell.
          const killer = spawn(path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe'),
            ['/PID', String(pid), '/T', '/F'], { shell: false, windowsHide: true, stdio: 'ignore' });
          const timer = setTimeout(() => { killer.kill(); reject(new Error('taskkill timeout')); }, 10000);
          killer.once('error', () => { clearTimeout(timer); reject(new Error('taskkill unavailable')); });
          killer.once('close', code => {
            clearTimeout(timer);
            if (code === 0) resolve();
            else reject(new Error('taskkill failed; tree stop not proven'));
          });
        });
      } else {
        try { process.kill(-pid, 'SIGKILL'); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
      }
    })().catch(() => {
      job.killFailed = true;
      this.output(job, 'STDERR', 'PROCESS_TREE_STOP_FAILED: zatrzymanie drzewa niepotwierdzone.\n');
      throw new AppError(503, 'PROCESS_TREE_STOP_FAILED', 'Nie potwierdzono zatrzymania drzewa procesów.');
    });
    return job.termination;
  }
  private finish(job: Job, code: number | null, signal: NodeJS.Signals | null, inventoryValid: boolean): void {
    if (terminal(job.run)) return;
    clearTimeout(job.timer); clearInterval(job.poll);
    this.checkVersion(job);
    job.run.exitCode = code;
    job.run.status = job.killFailed ? 'FAILED' : job.requested ?? (code === 0 && !signal ? 'SUCCEEDED' : 'FAILED');
    if (job.run.mode === 'RUN_TESTS' && !job.requested && job.profile.testReportFormat === 'JUNIT_XML' && inventoryValid) {
      try {
        const fresh = reports(job.cwd, job.profile.testReportGlob).filter(r =>
          r.mtimeMs >= job.startedMs && job.baseline.get(r.file) !== r.signature);
        const parsed = fresh.map(r => parseJUnit(readFileSync(r.file, 'utf8')));
        if (parsed.length && parsed.every(Boolean)) {
          const count = parsed.reduce((n, r) => n + r!.count, 0);
          const failures = parsed.reduce((n, r) => n + r!.failures, 0);
          const skipped = parsed.reduce((n, r) => n + r!.skipped, 0);
          job.run.testCount = count;
          job.run.testOutcome = count === 0 ? 'NO_TESTS' : failures || code !== 0 ? 'FAILED' :
            skipped === count ? 'UNKNOWN' : 'PASSED';
          if (failures) job.run.status = 'FAILED';
        }
      } catch { /* Missing/malformed/unsafe/oversized report stays UNKNOWN, never PASSED. */ }
    }
    job.run.finishedAt = new Date().toISOString();
    this.emitState(job);
    job.resolve(clone(job.run));
  }
}
