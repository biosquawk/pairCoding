/** Public prepare transport only. The producer keeps its synchronous ownership fences in a
 * worker; this responsive parent owns every Docker CLI child. No host toolchain/env fallback. */
import { Worker, MessageChannel, receiveMessageOnPort, isMainThread, workerData, parentPort } from 'node:worker_threads';
import path from 'node:path';
import { spawn } from 'node:child_process';

const clean = s => String(s).replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '');
export function prepareProgress(event) {
  process.stderr.write(`[prepare ${new Date().toISOString()}] ${clean(event.phase)} ${clean(event.text ?? '')}\n`);
}
/** Actual asynchronous child transport; bounded output, no shell, hard kill escalation.
 * An aborted Docker CLI is UNKNOWN, not evidence that its daemon operation was undone. */
export function spawnPrepareCommand(executable, argv, options, { signal, onProgress = () => {} } = {}) {
  return new Promise(resolve => {
    let stdout = '', stderr = '', error = null, timedOut = false, escalation, child;
    const killTree = hard => {
      if (!child?.pid) return;
      if (process.platform === 'win32') {
        // Only this spawned CLI PID/tree, never daemon names or unrelated containers.
        const killer = spawn(path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'], { shell: false, windowsHide: true, stdio: 'ignore' });
        const limit = setTimeout(() => killer.kill(), 2000);
        killer.on('error', () => {}); killer.on('close', () => clearTimeout(limit));
      } else {
        try { process.kill(-child.pid, hard ? 'SIGKILL' : 'SIGTERM'); } catch (e) { if (e.code !== 'ESRCH') error ??= e; }
      }
    };
    const stop = reason => {
      if (!error) error = reason;
      if (child && child.exitCode === null && child.signalCode === null) {
        killTree(false);
        escalation ??= setTimeout(() => killTree(true), 1000);
      }
    };
    if (signal?.aborted) { resolve({ status: null, signal: null, error: { message: String(signal.reason) }, stdout, stderr }); return; }
    const abort = () => stop(new Error(String(signal.reason)));
    try { child = spawn(executable, argv, { env: options.env, shell: false, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch (e) { resolve({ status: null, signal: null, error: { message: e.message }, stdout, stderr }); return; }
    const timer = setTimeout(() => { timedOut = true; stop(new Error('Prepare command timeout; daemon state retained/unknown')); }, options.timeout);
    signal?.addEventListener('abort', abort, { once: true });
    for (const [stream, name] of [[child.stdout, 'stdout'], [child.stderr, 'stderr']]) {
      stream.setEncoding('utf8');
      stream.on('data', chunk => {
        const previous = name === 'stdout' ? stdout : stderr;
        const combined = previous + chunk;
        if (Buffer.byteLength(combined) > options.maxBuffer) { stop(new Error('Prepare command output limit')); return; }
        if (name === 'stdout') stdout = combined; else stderr = combined;
        onProgress({ phase: `docker-${name}`, text: chunk });
      });
    }
    child.on('error', e => { error ??= e; });
    child.on('close', (status, childSignal) => {
      clearTimeout(timer); clearTimeout(escalation); signal?.removeEventListener('abort', abort);
      resolve({ status, signal: childSignal, error: error ? { message: error.message } : null, timedOut, stdout, stderr });
    });
    if (signal?.aborted) abort();
  });
}

/** No argv/env override for worker module, executable or transport. */
export async function supervisePublicPrepare(argv, { timeoutMs = 2700000, signal, onProgress = prepareProgress } = {}) {
  const controller = new AbortController(), shared = new Int32Array(new SharedArrayBuffer(4));
  const abort = reason => { if (!controller.signal.aborted && Atomics.compareExchange(shared, 0, 0, 1) !== 2) { controller.abort(reason); onProgress({ phase: 'cancelling', text: String(reason) }); } };
  const cancelled = () => abort(signal.reason ?? 'Prepare cancelled');
  signal?.addEventListener('abort', cancelled, { once: true });
  if (signal?.aborted) cancelled();
  const timer = setTimeout(() => abort('PREPARE_TIMEOUT: preparation budget exceeded'), timeoutMs);
  const { port1, port2 } = new MessageChannel();
  const worker = new Worker(new URL(import.meta.url), { workerData: { publicPrepare: true, argv, port: port2, shared: shared.buffer }, transferList: [port2] });
  let cleanupCommands = 0, active = false;
  // A single command at a time, including bounded cancellation readback. The worker owns
  // the unforgeable in-process Docker-client capability and durable per-command receipts.
  port1.on('message', async message => {
    if (message.kind !== 'command') return;
    const { executable, args, options } = message;
    let raw;
    if (active || executable !== 'docker' || options.prepareCleanup && ++cleanupCommands > 6) {
      raw = { status: null, signal: null, error: { message: 'Invalid/overlapping prepare transport operation' }, stdout: '', stderr: '' };
    } else {
      active = true;
      onProgress({ phase: options.prepareCleanup ? 'cancel-readback' : 'docker', text: args.slice(4, 7).join(' ') });
      raw = await spawnPrepareCommand(executable, args, options, { signal: options.prepareCleanup ? undefined : controller.signal, onProgress });
      if (raw.timedOut) abort('PREPARE_COMMAND_TIMEOUT: active operation interrupted; retain/reconcile');
      active = false;
    }
    port1.postMessage({ raw });
  });
  try {
    return await new Promise((resolve, reject) => {
      let settled = false;
      worker.on('message', message => {
        if (message.kind === 'progress') onProgress(message.event);
        if (message.kind === 'result') {
          settled = true;
          if (controller.signal.aborted) reject(new Error(String(controller.signal.reason)));
          else resolve(message.value);
        }
        if (message.kind === 'failure') { settled = true; reject(new Error(controller.signal.aborted ? String(controller.signal.reason) : message.problem)); }
      });
      worker.on('error', e => { abort('Prepare worker failed; retain/reconcile'); settled = true; reject(e); });
      worker.on('exit', code => { if (!settled) { abort('Prepare worker exited unexpectedly; retain/reconcile'); reject(new Error(`Prepare worker exit ${code}; retain/reconcile`)); } });
    });
  } finally {
    clearTimeout(timer); signal?.removeEventListener('abort', cancelled); port1.close();
    // Do not terminate a live worker mid-receipt or cancel readback. It closes its own port.
  }
}

if (!isMainThread && workerData?.publicPrepare === true) setImmediate(async () => {
  const { argv, port } = workerData, shared = new Int32Array(workerData.shared), sleeper = new Int32Array(new SharedArrayBuffer(4));
  const controller = new AbortController();
  const progress = event => parentPort.postMessage({ kind: 'progress', event });
  const cancelled = () => Atomics.load(shared, 0) === 1;
  const check = () => { if (cancelled()) { controller.abort('Prepare cancelled/timeout'); throw new Error('Prepare cancelled/timeout; retain receipts/resources'); } };
  // Runs while awaiting downloads; synchronous Docker waits are cancelled by the parent.
  const timer = setInterval(() => { if (cancelled()) controller.abort('Prepare cancelled/timeout'); }, 25);
  const command = (executable, args, options) => {
    port.postMessage({ kind: 'command', executable, args, options });
    for (;;) {
      const message = receiveMessageOnPort(port);
      if (message) return message.message.raw;
      Atomics.wait(sleeper, 0, 0, 20);
    }
  };
  try {
    const { main } = await import('./runtime-prepare-cli.mjs');
    check();
    const value = await main(argv, { spawnSync: command, signal: controller.signal, checkCancelled: check, control: { cancelled, progress, commit: () => { check(); if (Atomics.compareExchange(shared, 0, 0, 2) !== 0) throw new Error('Prepare cancelled before publication'); progress({phase:'publish',text:'Cancellation window closed; publishing measured runtime config'}); } }, onProgress: progress });
    check(); parentPort.postMessage({ kind: 'result', value });
  } catch (e) { parentPort.postMessage({ kind: 'failure', problem: e.message }); }
  finally { clearInterval(timer); port.close(); }
});
