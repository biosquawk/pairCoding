/** Finite real Linux CLI process-group regression; no Docker/Windows acceptance. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { spawnPrepareCommand } from '../../scripts/runtime-prepare-control.mjs';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const linux = { skip: process.platform !== 'linux', timeout: 10000 };
function proc(pid) {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const fields = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/);
    return { pid, state: fields[0], group: Number(fields[2]), session: Number(fields[3]), start: fields[19] };
  } catch (e) { if (['ENOENT','ESRCH'].includes(e.code)) return null; throw e; }
}
const live = identity => identity && !['Z','X'].includes(identity.state);
async function fixture(t, mode, { stubbornLeader = false, maxBuffer = 4096 } = {}) {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR ?? path.dirname(process.cwd()), 'owned-tree-'));
  const marker = path.join(dir, 'descendant.json'), controller = new AbortController();
  const sentinel = spawn(process.execPath, ['-e','setInterval(()=>{},1000)'], {stdio:'ignore'});
  let output = '', operation, leader, descendant;
  t.after(async () => {
    controller.abort('test final cleanup');
    if (operation) await operation;
    // Only exact, still-live test identities. Never a recycled PID or an unowned group.
    for (const identity of [descendant, leader]) {
      const current = identity && proc(identity.pid);
      if (live(current) && current.start === identity.start) process.kill(identity.pid, 'SIGKILL');
    }
    sentinel.kill('SIGKILL');
    await new Promise(resolve => sentinel.exitCode !== null || sentinel.signalCode !== null ? resolve() : sentinel.once('close',resolve));
    fs.rmSync(dir, {recursive:true, force:true});
  });
  const descendantCode = `process.on('SIGTERM',()=>{});require('node:fs').writeFileSync(${JSON.stringify(marker)},JSON.stringify({pid:process.pid}));setInterval(()=>{},1000)`;
  const leaderCode = `${stubbornLeader ? "process.on('SIGTERM',()=>{});" : ''}require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(descendantCode)}],{stdio:'ignore'});process.stdout.write(String(process.pid)+'\\n');process.on('SIGUSR1',()=>process.stdout.write('x'.repeat(8192)));setInterval(()=>{},1000)`;
  operation = spawnPrepareCommand(process.execPath, ['-e', leaderCode], {env:{PATH:process.env.PATH},timeout:mode === 'timeout' ? 700 : 5000,maxBuffer}, {signal:controller.signal,onProgress:e=>{if(e.phase==='docker-stdout')output+=e.text;}});
  for (let n=0; n<200 && (!fs.existsSync(marker) || !output); n++) await delay(10);
  assert.ok(fs.existsSync(marker) && output, 'both owned processes ready');
  leader = proc(Number(output.trim())); descendant = proc(JSON.parse(fs.readFileSync(marker)).pid);
  assert.ok(live(leader) && live(descendant));
  assert.equal(descendant.group, leader.pid); assert.equal(descendant.session, leader.pid);
  return {operation, controller, sentinel, leader, descendant};
}
for (const mode of ['abort','timeout','output-limit']) test(`owned stdio-ignore TERM-resistant descendant stops after leader close: ${mode}`, linux, async t => {
  const f = await fixture(t, mode, {maxBuffer:4096});
  let settled = false; f.operation.then(()=>{settled=true;});
  const started = Date.now();
  if (mode === 'abort') f.controller.abort('tree regression cancel');
  if (mode === 'output-limit') process.kill(f.leader.pid, 'SIGUSR1');
  // Observe actual leader death while its child has no inherited transport pipe.
  for(let n=0; n<150 && live(proc(f.leader.pid)); n++) await delay(10);
  assert.equal(live(proc(f.leader.pid)) ?? false, false, 'leader really exited before escalation');
  assert.ok(live(proc(f.descendant.pid)), 'descendant really resists TERM');
  assert.equal(settled, false, 'leader close alone cannot settle tree cancellation');
  const raw = await f.operation;
  assert.ok(Date.now()-started < 3500, 'bounded kill/readback completion');
  assert.equal(live(proc(f.descendant.pid)) ?? false, false, 'no live owned descendant when promise settles');
  assert.equal(raw.ownedProcessGroup, 'STOPPED');
  assert.ok(raw.error); assert.notEqual(raw.status, 0);
  assert.equal(raw.timedOut, mode === 'timeout');
  assert.equal(f.sentinel.exitCode, null); assert.equal(f.sentinel.signalCode, null, 'foreign sentinel untouched');
});
test('leader and descendant both resisting TERM are killed and read back', linux, async t => {
  const f = await fixture(t, 'abort', {stubbornLeader:true}); f.controller.abort('stubborn group');
  const raw = await f.operation;
  assert.equal(raw.ownedProcessGroup, 'STOPPED');
  assert.equal(live(proc(f.leader.pid)) ?? false, false); assert.equal(live(proc(f.descendant.pid)) ?? false, false);
  assert.equal(f.sentinel.exitCode, null); assert.equal(f.sentinel.signalCode, null);
});
test('changed process identity after leader close denies hardkill and reports UNKNOWN, not tree-closed', linux, async t => {
  const f = await fixture(t, 'abort');
  const read = fs.readFileSync.bind(fs), kill = process.kill.bind(process); let leaderExited = false, hardKills = 0;
  t.mock.method(fs, 'readFileSync', (file, ...args) => {
    const result = read(file, ...args);
    if (leaderExited && String(file) === `/proc/${f.descendant.pid}/stat`) {
      // Model reused numeric PGID/PID, with different kernel start time; never force real PID reuse.
      const split = result.lastIndexOf(')')+2, fields=result.slice(split).trim().split(/\s+/);
      fields[19] = String(BigInt(fields[19])+1n);
      return result.slice(0,split)+fields.join(' ');
    }
    return result;
  });
  t.mock.method(process, 'kill', (pid, signal) => {
    if(pid === -f.leader.pid && signal === 'SIGKILL') hardKills++;
    return kill(pid, signal);
  });
  f.controller.abort('identity drift');
  for(let n=0; n<150 && live(proc(f.leader.pid)); n++) await delay(10);
  leaderExited = true;
  const raw = await f.operation;
  t.mock.restoreAll(); // test cleanup needs actual, unmodified process identities
  assert.equal(hardKills, 0, 'never hardkill reused or unverified group');
  assert.equal(raw.ownedProcessGroup, 'UNKNOWN_RETAIN_AND_RECONCILE');
  assert.match(raw.error.message, /tree.*unconfirmed/i);
  assert.ok(live(proc(f.descendant.pid)), 'denied kill is not a false stopped claim');
  assert.equal(f.sentinel.exitCode, null); assert.equal(f.sentinel.signalCode, null);
});
test('ordinary successful and failed spawns keep their command contract', linux, async () => {
  const options = {env:{PATH:process.env.PATH},timeout:5000,maxBuffer:4096};
  const raw = await spawnPrepareCommand(process.execPath, ['-e',"process.stdout.write('ordinary output');process.stderr.write('ordinary stderr')"], options);
  assert.equal(raw.status, 0); assert.equal(raw.signal, null); assert.equal(raw.error, null);
  assert.equal(raw.stdout, 'ordinary output'); assert.equal(raw.stderr, 'ordinary stderr');
  assert.equal(raw.ownedProcessGroup, undefined, 'success is not a new tree-closure claim');
  const absent = await spawnPrepareCommand('/paircoach-test-no-such-executable', [], options);
  assert.match(absent.error.message, /ENOENT/); assert.notEqual(absent.status, 0);
});
test('pre-abort never spawns and immediate abort safely waits for spawn identity', linux, async t => {
  const c = new AbortController(); c.abort('before spawn');
  const options = {env:{PATH:process.env.PATH},timeout:5000,maxBuffer:4096};
  const before = await spawnPrepareCommand('/paircoach-test-no-such-executable', [], options, {signal:c.signal});
  assert.equal(before.error.message, 'before spawn'); assert.equal(before.status, null);
  const immediate = new AbortController();
  const operation = spawnPrepareCommand(process.execPath, ['-e','setInterval(()=>{},1000)'], options, {signal:immediate.signal});
  immediate.abort('immediate cancellation');
  const raw = await operation;
  assert.match(raw.error.message, /immediate cancellation/); assert.equal(raw.ownedProcessGroup, 'STOPPED');
  assert.notEqual(raw.status, 0);
});
