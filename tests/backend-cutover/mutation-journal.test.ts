import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { DurableMutationJournal, type MutationIdentity } from '../../src/server/runtime-coordinator/MutationJournal';

const identity = (requestId = 'request1'): MutationIdentity => ({ projectId: 'project1', sessionId: 'session1', clientId: 'client1', requestId,
  kind: 'RUN', payload: { mode: 'RUN_MAIN', configurationGeneration: 'config1', expectedWorkspaceVersion: 1 } });
const opened = new Map<string, DurableMutationJournal[]>();
function openJournal(directory: string): DurableMutationJournal {
  const journal = new DurableMutationJournal(directory);
  opened.set(directory, [...(opened.get(directory) ?? []), journal]); return journal;
}
const fixture = (t: test.TestContext) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'coordinator-journal-')), directory = path.join(root, 'journal');
  t.after(async () => { for (const journal of opened.get(directory) ?? []) await journal.close(); opened.delete(directory); fs.rmSync(root, { recursive: true, force: true }); });
  return directory;
};
const committed = (value: unknown) => ({ state: 'COMMITTED', result: value } as const);

test('UNIT real disk reserve -> commit, replay returns immutable original across reopen', async t => {
  const directory = fixture(t); let journal = openJournal(directory), effects = 0;
  const mutable = { runId: 'run1', state: 'QUEUED' };
  assert.deepEqual(await journal.execute(identity(), async () => { effects++; return committed(mutable); }), committed(mutable));
  mutable.state = 'RUNNING';
  await journal.close(); journal = openJournal(directory);
  assert.deepEqual(await journal.execute(identity(), async () => { effects++; return committed(null); }), committed({ runId: 'run1', state: 'QUEUED' }));
  assert.equal(effects, 1);
  await assert.rejects(journal.execute({ ...identity(), kind: 'SAVE' }, async () => committed(null)), { code: 'IDEMPOTENCY_CONFLICT' });
  await assert.rejects(journal.reconcile({ ...identity(), payload: { mode: 'other' } }), { code: 'IDEMPOTENCY_CONFLICT' });
});

test('UNIT absent reconciliation persists abort tombstone before delayed original admission/restart', async t => {
  const directory = fixture(t); let journal = openJournal(directory); let effects = 0;
  assert.deepEqual(await journal.reconcile(identity()), { state: 'DEFINITIVELY_ABORTED', result: null });
  await journal.close(); journal = openJournal(directory);
  assert.deepEqual(await journal.execute(identity(), async () => { effects++; return committed('late'); }), { state: 'DEFINITIVELY_ABORTED', result: null });
  assert.equal(effects, 0);
});

test('UNIT pending/lost response is UNKNOWN, fences new mutation and cannot be aborted by read', async t => {
  const directory = fixture(t), journal = openJournal(directory);
  let release!: () => void, entered!: () => void;
  const inside = new Promise<void>(r => { entered = r; }), wait = new Promise<void>(r => { release = r; });
  const pending = journal.execute(identity(), async () => { entered(); await wait; return committed('real'); });
  await inside;
  assert.deepEqual(await journal.reconcile(identity()), { state: 'UNKNOWN', result: null });
  assert.deepEqual(await journal.execute(identity(), async () => { assert.fail('must not rerun pending'); }), { state: 'UNKNOWN', result: null });
  await assert.rejects(journal.execute(identity('other'), async () => committed('different')), { code: 'MUTATION_PENDING' });
  await assert.rejects(journal.close(), { code: 'MUTATION_IN_FLIGHT' });
  release(); assert.deepEqual(await pending, committed('real'));
  assert.deepEqual(await journal.reconcile(identity()), committed('real'));
});

test('UNIT uncertain effect remains UNKNOWN after restart; no effect replay or assumed abort', async t => {
  const directory = fixture(t); let journal = openJournal(directory); let effects = 0;
  assert.deepEqual(await journal.execute(identity(), async () => { effects++; throw Error('response lost after side effect'); }), { state: 'UNKNOWN', result: null });
  await journal.close(); journal = openJournal(directory);
  assert.deepEqual(await journal.reconcile(identity()), { state: 'UNKNOWN', result: null });
  assert.deepEqual(await journal.execute(identity(), async () => { effects++; return committed('no'); }), { state: 'UNKNOWN', result: null });
  assert.equal(effects, 1);
  await assert.rejects(journal.execute(identity('new'), async () => committed(null)), { code: 'MUTATION_PENDING' });
});

test('UNIT same live process cannot acquire another journal lease; release keeps lock inode', async t => {
  const directory = fixture(t), first = openJournal(directory);
  assert.throws(() => openJournal(directory), /live kernel owner/);
  const before = fs.lstatSync(path.join(directory, 'lease.lock'), { bigint: true });
  await first.close(); const second = openJournal(directory);
  const after = fs.lstatSync(path.join(directory, 'lease.lock'), { bigint: true });
  assert.equal(before.ino, after.ino); assert.equal(before.dev, after.dev);
});

test('UNIT real child SIGKILL releases actual production kernel lease; reservation stays UNKNOWN', async t => {
  const directory = fixture(t);
  const moduleUrl = new URL('../../src/server/runtime-coordinator/MutationJournal.ts', import.meta.url).href;
  const script = `import { DurableMutationJournal } from ${JSON.stringify(moduleUrl)};
const journal = new DurableMutationJournal(${JSON.stringify(directory)});
await journal.execute(${JSON.stringify(identity())}, async () => { process.stdout.write('RESERVED\\n'); await new Promise(()=>{}); });`;
  const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env } });
  t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
  let stderr = ''; child.stderr.on('data', d => { stderr += d; });
  await new Promise<void>((resolve, reject) => {
    let text = '';
    child.stdout.on('data', d => { text += d; if (text.includes('RESERVED\n')) resolve(); });
    child.once('exit', () => reject(Error('Child exited before reservation: ' + stderr)));
    child.once('error', reject);
  });
  assert.throws(() => openJournal(directory), /live kernel owner/);
  const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited;
  const reopened = openJournal(directory);
  assert.deepEqual(await reopened.reconcile(identity()), { state: 'UNKNOWN', result: null });
  await assert.rejects(reopened.execute(identity('new'), async () => committed(null)), { code: 'MUTATION_PENDING' });
});

test('UNIT tampering or missing known record never means absent/abort; symlink/hardlink refused', async t => {
  const directory = fixture(t), journal = openJournal(directory);
  await journal.execute(identity(), async () => committed('saved'));
  const name = fs.readdirSync(directory).find(n => /^[a-f0-9]{64}\.json$/.test(n))!;
  const file = path.join(directory, name), saved = fs.readFileSync(file);
  fs.writeFileSync(file, '{}'); await assert.rejects(journal.reconcile(identity()));
  await assert.rejects(journal.execute(identity('new'), async () => committed('must-not-run')), {code:'MUTATION_JOURNAL_UNAVAILABLE'});
  await journal.close();
  fs.writeFileSync(file, saved); fs.linkSync(file, file + '.hardlink');
  assert.throws(()=>openJournal(directory), /Unsafe durable record/);
  fs.unlinkSync(file + '.hardlink');
  const target=path.join(path.dirname(directory),'symlink-target');fs.renameSync(file,target);fs.symlinkSync(target,file);
  assert.throws(()=>openJournal(directory), /Unsafe durable record/);
  fs.unlinkSync(file);fs.renameSync(target,file);
  const restored=openJournal(directory);fs.unlinkSync(file);
  await assert.rejects(restored.reconcile(identity()));
});

test('UNIT real child death after durable tombstone cannot allow delayed original to execute', async t => {
  const directory=fixture(t), moduleUrl=new URL('../../src/server/runtime-coordinator/MutationJournal.ts',import.meta.url).href;
  const script=`import {DurableMutationJournal} from ${JSON.stringify(moduleUrl)};
const journal=new DurableMutationJournal(${JSON.stringify(directory)});
const outcome=await journal.reconcile(${JSON.stringify(identity())});
process.stdout.write(outcome.state+'\\n'); setInterval(()=>{},1000);`;
  const child=spawn(process.execPath,['--import','tsx','--input-type=module','-e',script],{stdio:['ignore','pipe','pipe'],env:{...process.env}});
  t.after(()=>{if(child.exitCode===null)child.kill('SIGKILL');});
  let stderr='';child.stderr.on('data',d=>{stderr+=d;});
  await new Promise<void>((resolve,reject)=>{let text='';child.stdout.on('data',d=>{text+=d;if(text.includes('DEFINITIVELY_ABORTED'))resolve();});child.once('exit',()=>reject(Error(stderr)));child.once('error',reject);});
  const done=once(child,'exit');child.kill('SIGKILL');await done;
  const journal=openJournal(directory);let effects=0;
  assert.deepEqual(await journal.execute(identity(),async()=>{effects++;return committed('late');}),{state:'DEFINITIVELY_ABORTED',result:null});
  assert.equal(effects,0);
});
