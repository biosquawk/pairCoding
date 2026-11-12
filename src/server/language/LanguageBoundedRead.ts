import { Worker } from 'node:worker_threads';
import { isAbsolute, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const MiB = 1024 * 1024;
type Request = Readonly<{ path: string; limit: number }>;
type Options = Readonly<{ workers?: number; maxTotalBytes?: number; signal?: AbortSignal }>;
type Reader = { worker: Worker; pending: number | null; stopping: boolean; exited: boolean };
const abortError = (): Error => Object.assign(new Error('Language read aborted'), { name: 'AbortError' });

/** Backend-only bytes from an ALREADY complete, trusted inventory. Never wire/path discovery or
 * freshness authority. Caller MUST retain its full root/source/ALL-overlay/commit/lease fences.
 * Source execution requires the existing Node22 + tsx installation. No caller loader is inherited.
 * The sum of requested budgets is reserved up front: <=256MiB payload + <=16000 retained EOF sentinel bytes,
 * bounded metadata (16000 jobs), plus Node/tsx worker runtime overhead. Transfers do NOT clone bytes.
 * Failure/abort stops dispatch; settlement waits for ALL reads' finally-close AND all worker exits.
 */
export async function readLanguageFilesBounded(requests: readonly Request[], options: Options = {}): Promise<readonly Buffer[]> {
  const workers = options.workers ?? 4, budget = options.maxTotalBytes ?? 256 * MiB, signal = options.signal;
  if (!Number.isSafeInteger(workers) || workers < 1 || workers > 4 ||
      !Number.isSafeInteger(budget) || budget < 0 || budget > 256 * MiB ||
      !Array.isArray(requests) || requests.length > 16000) throw new Error('Invalid bounded language read options');
  let reserved = 0;
  const jobs = requests.map(request => {
    if (!request || typeof request.path !== 'string' || request.path.length > 32768 || request.path.includes('\0') ||
        !isAbsolute(request.path) || resolve(request.path) !== request.path ||
        !Number.isSafeInteger(request.limit) || request.limit < 0 || request.limit > 64 * MiB) throw new Error('Invalid bounded language read request');
    reserved += request.limit;
    if (reserved > budget) throw new Error('Bounded language read requested budgets exceeded');
    return Object.freeze({ path: request.path, limit: request.limit });
  });
  if (signal?.aborted) throw abortError();
  if (!jobs.length) return Object.freeze([]);
  return new Promise((resolveResult, rejectResult) => {
    const readers: Reader[] = [], output: Buffer[] = new Array(jobs.length);
    let next = 0, completed = 0, returnedBytes = 0, failed = false, failure: unknown, spawning = true;
    const stop = (reader: Reader): void => {
      if (reader.stopping || reader.exited) return;
      reader.stopping = true;
      // STOP queues behind an in-progress synchronous native read, never terminates it.
      try { reader.worker.postMessage({ type: 'STOP' }); } catch { /* exit/error event owns settlement */ }
    };
    const fail = (error: unknown): void => {
      if (!failed) { failed = true; failure = error; }
      readers.forEach(stop);
    };
    const settle = (): void => {
      if (spawning || readers.some(reader => !reader.exited)) return;
      signal?.removeEventListener('abort', onAbort);
      if (failed) { output.length = 0; rejectResult(failure); }
      else if (completed !== jobs.length) { output.length = 0; rejectResult(new Error('Language read workers exited before drain')); }
      else resolveResult(Object.freeze(output));
    };
    const onAbort = (): void => { fail(abortError()); };
    const dispatch = (reader: Reader): void => {
      if (failed || next === jobs.length) { stop(reader); return; }
      const id = next++;
      reader.pending = id;
      try { reader.worker.postMessage({ type: 'READ', id, ...jobs[id] }); }
      catch (error) { fail(error); }
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      for (let i = 0; i < Math.min(workers, jobs.length) && !failed; i++) {
        const reader: Reader = { worker: new Worker(new URL('./LanguageBoundedRead.worker.mjs', import.meta.url), {
          execArgv: [], env: { TMPDIR: tmpdir(), TSX_DISABLE_CACHE: '1' }, trackUnmanagedFds: true,
        }), pending: null, stopping: false, exited: false };
        readers.push(reader);
        reader.worker.on('error', fail);
        reader.worker.on('message', message => {
          if (failed) return; // STOP is already queued; still wait for exit, never reuse late bytes.
          const id = reader.pending;
          if (id === null || message?.id !== id) { fail(new Error('Invalid language read worker response')); return; }
          reader.pending = null;
          if (message.error) {
            const reason = new Error(String(message.error.message).slice(0, 1024));
            reason.name = String(message.error.name).slice(0, 80);
            if (typeof message.error.code === 'string') Object.assign(reason, { code: message.error.code.slice(0, 64) });
            fail(reason); return;
          }
          if (!(message.data instanceof ArrayBuffer) || !Number.isSafeInteger(message.bytes) || message.bytes < 0 ||
              message.bytes > jobs[id].limit || message.offset !== 0 || message.data.byteLength !== message.bytes + 1) {
            fail(new Error('Invalid bounded language read payload')); return;
          }
          returnedBytes += message.bytes;
          if (returnedBytes > reserved) { fail(new Error('Bounded language read returned budget exceeded')); return; }
          output[id] = Buffer.from(message.data, 0, message.bytes); // zero-copy transferred allocation
          completed++;
          dispatch(reader);
        });
        reader.worker.once('exit', code => {
          reader.exited = true;
          if (!failed && (code !== 0 || reader.pending !== null || !reader.stopping)) fail(new Error('Language read worker exited unexpectedly'));
          settle();
        });
        dispatch(reader);
      }
    } catch (error) { fail(error); }
    spawning = false;
    // Abort can occur during worker construction/dispatch; no freshness/abort token is cached.
    if (signal?.aborted) onAbort();
    settle();
  });
}
