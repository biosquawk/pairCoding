import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DockerLanguageProcess, LanguageProcessAdmission } from '../../src/server/language/DockerLanguageProcess';
import { intentHash, receiptHash } from '../../src/server/language/LanguageProcessJournal';
import { fixture, logs, policyPath } from './fixture';

// UNIT: fake driver models only a retained exited137 container. Journal, filesystem, fsync,
// actual policy serialization/hashes/readback and process retirement ordering are production code.
test('UNIT recovery reconciles same stopped owner/partial artifact before exact nonforce remove; zero create/start', async t => {
  const f = fixture(t), cid = 'b'.repeat(64); f.journal.markStart(f.launchId, intentHash(f.intent), cid);
  let interrupted = false;
  f.hooks(kind => { if (kind === 'file' && !interrupted) { interrupted = true; throw new Error('UNIT partial interruption'); } });
  assert.throws(() => f.journal.collect(f.intent, logs), /interruption/); f.hooks();
  const events: string[] = []; let present = true;
  const driver = {
    engineId: async () => 'UNIT-engine',
    inspect: async () => present ? { id: cid, name: f.intent.name, imageId: f.intent.imageId, labels: f.intent.labels,
      running: false, status: 'exited', startedAt: '2026-11-12T03:00:00Z', exitCode: 137 } : null,
    attach: () => { throw new Error('no attach allowed during recovery'); },
    command: async (args: readonly string[]) => {
      events.push(args[0]);
      if (args[0] === 'logs') return { exitCode: 0, ...logs };
      assert.deepEqual([...args], ['rm', cid]);
      const receipt = f.journal.readReceipt(f.launchId)!;
      assert.equal(receipt.exitCode, 137); assert.equal(receipt.containerId, cid);
      assert.ok(receipt.collection.files.some(e => e.path === policyPath));
      assert.ok(existsSync(f.artifact(policyPath))); assert.ok(f.flushed().files > 12);
      present = false; return { exitCode: 0, stdout: '', stderr: '', truncated: false };
    }
  };
  const options = { ...f.options, driver, admission: new LanguageProcessAdmission() };
  const p = DockerLanguageProcess.recover(f.launchId, options);
  assert.deepEqual(await p.retire(), { confirmed: true, removed: true, problem: null });
  assert.deepEqual(events, ['logs', 'rm']); assert.equal(present, false);
  const receipt = f.journal.readReceipt(f.launchId)!;
  assert.equal(JSON.parse(readFileSync(join(f.receipts, f.launchId, 'removed.json'), 'utf8')).receiptSha256, receiptHash(receipt));
  assert.deepEqual(await p.retire(), { confirmed: true, removed: true, problem: null }); assert.deepEqual(events, ['logs', 'rm']);
});
test('UNIT corrupt policy fences actual retirement/removal while retaining same stopped owner', async t => {
  const f = fixture(t), cid = 'b'.repeat(64), c = f.journal.collect(f.intent, logs);
  f.journal.markStart(f.launchId, intentHash(f.intent), cid); f.journal.putReceipt(f.launchId, f.receipt(c));
  writeFileSync(f.artifact(policyPath), 'corrupt'); let mutations = 0;
  const driver = { engineId: async () => 'UNIT-engine', inspect: async () => ({ id: cid, name: f.intent.name, imageId: f.intent.imageId,
    labels: f.intent.labels, running: false, status: 'exited', startedAt: '2026-11-12T03:00:00Z', exitCode: 137 }),
    attach: () => { throw new Error('no attach'); }, command: async () => { mutations++; throw new Error('must not remove'); } };
  const p = DockerLanguageProcess.recover(f.launchId, { ...f.options, driver });
  const result = await p.retire(); assert.equal(result.removed, false); assert.match(result.problem!, /mismatch|changed/i);
  assert.equal(mutations, 0); assert.equal(existsSync(join(f.receipts, f.launchId, 'removed.json')), false);
});

test('UNIT legacy four-artifact recovered exit137 receipt still precedes exact nonforce removal', async t => {
  for (const provider of ['jdt', 'pylsp'] as const) {
    const f = fixture(t, false, provider), cid = 'b'.repeat(64);
    f.write('osgi.log', 'boot log\n'); mkdirSync(join(f.state, '.metadata')); writeFileSync(join(f.state, '.metadata', '.log'), 'state log\n');
    f.journal.markStart(f.launchId, intentHash(f.intent), cid); let present = true; const mutations: string[] = [];
    const driver = { engineId: async () => 'UNIT-engine', inspect: async () => present ? ({ id: cid, name: f.intent.name, imageId: f.intent.imageId,
      labels: f.intent.labels, running: false, status: 'exited', startedAt: '2026-11-12T03:00:00Z', exitCode: 137 }) : null,
      attach: () => { throw new Error('no attach'); }, command: async (args: readonly string[]) => {
        mutations.push(args[0]);
        if (args[0] === 'logs') return { exitCode: 0, ...logs };
        assert.deepEqual([...args], ['rm', cid]); const receipt = f.journal.readReceipt(f.launchId)!;
        assert.equal(receipt.exitCode, 137); assert.equal(receipt.collection.files.length, 4);
        assert.deepEqual(receipt.collection.files.map(e => e.path), ['boot/osgi.log', 'state/.metadata/.log', 'stdout.log', 'stderr.log']);
        assert.equal(existsSync(f.artifact(policyPath)), false); present = false;
        return { exitCode: 0, stdout: '', stderr: '', truncated: false };
      } };
    const process = DockerLanguageProcess.recover(f.launchId, { ...f.options, driver });
    assert.deepEqual(await process.retire(), { confirmed: true, removed: true, problem: null }); assert.deepEqual(mutations, ['logs', 'rm']);
  }
});
