import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { createHash } from 'node:crypto';
import { readLanguageFilesBounded } from '../../src/server/language/LanguageBoundedRead';
import { readRegular } from '../../src/server/language/LanguageProcessJournal';
const digest = (v: Buffer) => createHash('sha256').update(v).digest('hex');
const temporary = (): string => fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'pc-bounded-'));
function observe() {
  const proto = Worker.prototype as any, post = proto.postMessage, emit = proto.emit;
  const live = new Set<Worker>(), pending = new Set<Worker>();
  const stats = { created: 0, exits: 0, maxLive: 0, maxPending: 0, jobs: 0, jobsAtFirstError: -1, nonzeroExits: 0 };
  proto.postMessage = function(message: any, ...args: any[]) {
    if (message?.type === 'READ') {
      if (!live.has(this)) { live.add(this); stats.created++; }
      pending.add(this); stats.jobs++; stats.maxLive = Math.max(stats.maxLive, live.size); stats.maxPending = Math.max(stats.maxPending, pending.size);
    }
    return post.call(this, message, ...args);
  };
  proto.emit = function(event: string, ...args: any[]) {
    if (event === 'message') { pending.delete(this); if (args[0]?.error && stats.jobsAtFirstError < 0) stats.jobsAtFirstError = stats.jobs; }
    if (event === 'exit') { if (live.delete(this)) { stats.exits++; if (args[0] !== 0) stats.nonzeroExits++; } pending.delete(this); }
    return emit.call(this, event, ...args);
  };
  return { stats, live, pending, restore() { proto.postMessage = post; proto.emit = emit; } };
}
function fileFDs(root: string): string[] {
  // Actual Linux OS descriptor witness, not a mock. Windows uses native-final QA separately.
  return fs.readdirSync('/proc/self/fd').flatMap(fd => { try { return fs.readlinkSync('/proc/self/fd/' + fd).startsWith(root) ? [fd] : []; } catch { return []; } });
}
for (const workers of [1, 4]) test(`native bytes/hash/order, finite ${workers}-worker dispatch, immutable input and exit drain`, async () => {
  const root = temporary(), witness = observe();
  try {
    const values = [Buffer.alloc(0), Buffer.from('Zażółć 😀\n'), Buffer.from([0, 255, 1]), Buffer.alloc(128 * 1024, 7)];
    const requests = Object.freeze(Array.from({ length: 12 }, (_, i) => {
      const file = path.join(root, `f ${i} λ`); fs.writeFileSync(file, values[i % values.length]);
      return Object.freeze({ path: file, limit: values[i % values.length].length });
    }));
    const before = JSON.stringify(requests), result = await readLanguageFilesBounded(requests, { workers });
    assert.equal(JSON.stringify(requests), before); assert.equal(result.length, requests.length); assert(Object.isFrozen(result));
    for (let i = 0; i < requests.length; i++) {
      assert(Buffer.isBuffer(result[i])); assert.deepEqual(result[i], readRegular(requests[i].path, requests[i].limit));
      assert.equal(digest(result[i]), digest(values[i % values.length]));
    }
    assert.equal(witness.stats.created, workers); assert.equal(witness.stats.exits, workers); assert.equal(witness.stats.jobs, requests.length);
    assert(witness.stats.maxPending <= workers); assert(witness.stats.maxLive <= workers); assert.equal(witness.stats.nonzeroExits, 0);
    assert.equal(witness.live.size, 0); assert.equal(witness.pending.size, 0); if (process.platform === 'linux') assert.deepEqual(fileFDs(root), []);
  } finally { witness.restore(); fs.rmSync(root, { recursive: true, force: true }); }
});
test('zero/invalid requests, budgets, worker bounds, and pre-abort refuse before any worker', async () => {
  const root = temporary(), witness = observe();
  try {
    assert.deepEqual(await readLanguageFilesBounded([]), []);
    const f = path.join(root, 'x'); fs.writeFileSync(f, 'x');
    const jobs = [{ path: f, limit: 1 }];
    for (const options of [{ workers: 0 }, { workers: 5 }, { workers: 1.5 }, { maxTotalBytes: -1 }, { maxTotalBytes: 256*1024*1024+1 }, { maxTotalBytes: 0 }]) await assert.rejects(readLanguageFilesBounded(jobs, options));
    for (const item of [{ path: 'relative', limit: 1 }, { path: root + '/./x', limit: 1 }, { path: f, limit: -1 }, { path: f, limit: NaN }, { path: f, limit: 64*1024*1024+1 }]) await assert.rejects(readLanguageFilesBounded([item]));
    await assert.rejects(readLanguageFilesBounded(Array.from({ length: 16001 }, () => jobs[0])));
    await assert.rejects(readLanguageFilesBounded(Array.from({ length: 5 }, () => ({ path: f, limit: 64*1024*1024 }))));
    const control = new AbortController(); control.abort(); await assert.rejects(readLanguageFilesBounded(jobs, { signal: control.signal }), { name: 'AbortError' });
    assert.equal(witness.stats.created, 0);
  } finally { witness.restore(); fs.rmSync(root, { recursive: true, force: true }); }
});
for (const mode of ['missing', 'symlink', 'hardlink', 'oversize']) test(`native ${mode} rejects, first failure stops new dispatch, ALL worker exits before reject`, async () => {
  const root = temporary(), witness = observe();
  try {
    const good = path.join(root, 'good'), bad = path.join(root, 'bad'); fs.writeFileSync(good, 'abcdef');
    if (mode === 'symlink') fs.symlinkSync(good, bad); if (mode === 'hardlink') fs.linkSync(good, bad);
    if (mode === 'oversize') fs.writeFileSync(bad, 'abcdef');
    const requests = [{ path: bad, limit: mode === 'oversize' ? 2 : 16 }, ...Array.from({ length: 12 }, () => ({ path: good, limit: 16 }))];
    await assert.rejects(readLanguageFilesBounded(requests));
    assert.equal(witness.stats.jobs, witness.stats.jobsAtFirstError); assert.equal(witness.stats.created, witness.stats.exits);
    assert.equal(witness.live.size, 0); assert.equal(witness.pending.size, 0); assert.equal(witness.stats.nonzeroExits, 0);
    if (process.platform === 'linux') assert.deepEqual(fileFDs(root), []);
  } finally { witness.restore(); fs.rmSync(root, { recursive: true, force: true }); }
});
test('abort WHILE real default worker file FD is open drains all native reads/worker exits', async t => {
  if (process.platform !== 'linux') { t.skip('Actual /proc FD witness is Linux-only; Windows native final QA pending'); return; }
  const root = temporary(), witness = observe();
  let timer: NodeJS.Timeout | undefined;
  try {
    const file = path.join(root, 'large'); fs.writeFileSync(file, Buffer.alloc(32*1024*1024, 19));
    const control = new AbortController(); let observedFDs: string[] = [], polls = 0;
    const ending = readLanguageFilesBounded(Array.from({ length: 8 }, () => ({ path: file, limit: 32*1024*1024 })), { signal: control.signal }).then(() => null, error => error);
    timer = setInterval(() => { polls++; const open = fileFDs(root); if (open.length) { observedFDs = open; control.abort(); } }, 1);
    const result = await ending; clearInterval(timer); timer = undefined;
    assert(observedFDs.length > 0, 'Must observe an actual worker-native file descriptor before abort'); assert(polls > 0);
    assert.equal(result?.name, 'AbortError'); assert.equal(witness.live.size, 0); assert.equal(witness.pending.size, 0);
    assert.equal(witness.stats.created, witness.stats.exits); assert.equal(witness.stats.nonzeroExits, 0); assert.deepEqual(fileFDs(root), []);
    t.diagnostic(JSON.stringify({ observedActualFDs: observedFDs.length, ...witness.stats, settledOutstandingFDs: 0, settledWorkers: 0 }));
  } finally { if (timer) clearInterval(timer); witness.restore(); fs.rmSync(root, { recursive: true, force: true }); }
});
for (const schedule of ['none', 'opened-stamp', 'leaf-replace', 'parent-replace', 'grow', 'native-read-error', 'reported-close-error', 'ancestor-alias-restored']) test(`canonical real-IO scheduled race: ${schedule}`, async () => {
  const root = temporary(), parent = path.join(root, 'parent'); fs.mkdirSync(parent); const file = path.join(parent, 'file'); fs.writeFileSync(file, 'abcdef');
  try {
    const worker = new Worker(new URL('./race.worker.mjs', import.meta.url), { workerData: { file, schedule }, execArgv: [], env: { TMPDIR: os.tmpdir(), TSX_DISABLE_CACHE: '1' }, trackUnmanagedFds: true });
    let evidence: any; const exit = await new Promise<number>((resolveExit, reject) => { worker.on('message', m => { evidence = m; }); worker.on('error', reject); worker.on('exit', resolveExit); });
    assert.equal(exit, 0); assert.equal(evidence.fdOpen, 0);
    if (schedule === 'none') { assert.equal(evidence.ok, true); assert.equal(evidence.bytes, 'abcdef'); }
    else { assert.equal(evidence.ok, false); assert.equal(evidence.fired, true); }
    if (schedule === 'ancestor-alias-restored') {
      assert.match(evidence.reason, /canonical alias/); assert(evidence.events.some((e: any[]) => e[0] === 'restored'));
      assert(!evidence.events.some((e: any[]) => e[0] === 'opened')); // initial ancestor guard, not merely final-prefix test
      assert.equal(fs.realpathSync.native(parent), parent); assert.equal(fs.readFileSync(file, 'utf8'), 'abcdef');
    } else { assert(evidence.events.some((e: any[]) => e[0] === 'closed')); }
    if (process.platform === 'linux') assert.deepEqual(fileFDs(root), []);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
