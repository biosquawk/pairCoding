import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync, rmSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { sha256 } from '../../src/server/language/LanguageProcessJournal';
import { fixture, logs, policyPath } from './fixture';
const marker = 'collection-policy-required.json';
const maximum = 4 * 1024 * 1024;
const markerFile = (f: ReturnType<typeof fixture>) => join(f.receipts, f.launchId, marker);

test('NEW combined count readback rejects formerly admitted259 without changing receipt schema', t => {
  const f = fixture(t, false); f.write('config.opaque', '');
  const c = f.journal.collect(f.intent, logs);
  // Re-author UNIT metadata with matching selected refs/hashes so the count guard, not corruption,
  // is the distinguishing failure. No production journal or prior evidence is touched.
  const selected = c.files.filter(e => e.path !== policyPath);
  while (selected.length < 257) selected.push({ ...selected[0] });
  const p = JSON.parse(readFileSync(f.artifact(policyPath), 'utf8')); p.selected = [...selected].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  const bytes = Buffer.from(JSON.stringify(p)); writeFileSync(f.artifact(policyPath), bytes);
  const changed = { ...c, files: [...selected, { path: policyPath, bytes: bytes.length, sha256: sha256(bytes) }] };
  assert.equal(changed.files.length, 258); f.journal.putReceipt(f.launchId, f.receipt(changed));
  assert.throws(() => f.journal.readReceipt(f.launchId), /budget/);
});

test('NEW selected logs+policy+marker together hit exact4MiB and plus1 is rejected', t => {
  // Equal-length private roots/UUIDs make serialized policy length deterministic across fixtures.
  const reference = fixture(t, false); reference.write('config.opaque', '');
  for (const n of ['a.log', 'b.log', 'c.log']) reference.write(n, Buffer.alloc(1024 * 1024));
  const rc = reference.journal.collect(reference.intent, { stdout: '', stderr: '', truncated: false });
  const rp = JSON.parse(readFileSync(reference.artifact(policyPath), 'utf8'));
  const markerBytes = readFileSync(markerFile(reference)).length;
  // JSON decimal sizes affect serialized policy length; solve using production-shaped policy,
  // then assert ACTUAL persisted bytes, not a guessed constant or a mock storage counter.
  const overhead = rc.files.reduce((sum, e) => sum + e.bytes, 0) + markerBytes - 3 * 1024 * 1024;
  let stdout = 1024 * 1024 - overhead;
  const entry = rp.selected.find((e: { path: string }) => e.path === 'stdout.log');
  entry.bytes = stdout;
  stdout -= Buffer.byteLength(JSON.stringify(rp)) - rc.files.find(e => e.path === policyPath)!.bytes;
  for (const extra of [0, 1]) {
    const f = fixture(t, false); f.write('config.opaque', '');
    for (const n of ['a.log', 'b.log', 'c.log']) f.write(n, Buffer.alloc(1024 * 1024));
    const streams = { stdout: 'x'.repeat(stdout + extra), stderr: '', truncated: false };
    if (extra) assert.throws(() => f.journal.collect(f.intent, streams), /budget/);
    else {
      const c = f.journal.collect(f.intent, streams);
      assert.equal(c.files.reduce((sum, e) => sum + e.bytes, 0) + readFileSync(markerFile(f)).length, maximum);
      f.journal.putReceipt(f.launchId, f.receipt(c)); assert.ok(f.journal.readReceipt(f.launchId));
    }
  }
});

test('NEW aggregate readback charges marker bytes even when receipt-selected bytes alone fit4MiB', t => {
  const f = fixture(t, false); f.write('config.opaque', ''); f.write('large.log', Buffer.alloc(1024 * 1024));
  const c = f.journal.collect(f.intent, { stdout: '', stderr: '', truncated: false });
  const p = JSON.parse(readFileSync(f.artifact(policyPath), 'utf8'));
  const large = c.files.find(e => e.path === 'boot/large.log')!;
  const markerBytes = readFileSync(markerFile(f)).length;
  const originalPolicySize = c.files.find(e => e.path === policyPath)!.bytes;
  const selected = c.files.filter(e => e.path !== policyPath);
  selected.push({ ...large }, { ...large });
  p.selected = [...selected].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  const sizeWithDuplicates = Buffer.byteLength(JSON.stringify(p));
  // Place selected artifacts just1 byte over the aggregate WITH marker. stdout remains <=1MiB.
  const stdout = maximum - markerBytes - (selected.reduce((sum, e) => sum + e.bytes, 0) + sizeWithDuplicates) + 1;
  const output = selected.find(e => e.path === 'stdout.log')!;
  output.bytes = stdout; output.sha256 = sha256(Buffer.from('x'.repeat(stdout)));
  const digitDelta = Buffer.byteLength(JSON.stringify(p)) - sizeWithDuplicates;
  output.bytes -= digitDelta; output.sha256 = sha256(Buffer.from('x'.repeat(output.bytes)));
  assert.ok(output.bytes >= 0 && output.bytes <= 1024 * 1024); assert.ok(originalPolicySize > 0);
  writeFileSync(f.artifact('stdout.log'), 'x'.repeat(output.bytes));
  p.selected = [...selected].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  const bytes = Buffer.from(JSON.stringify(p)); writeFileSync(f.artifact(policyPath), bytes);
  const changed = { ...c, files: [...selected, { path: policyPath, bytes: bytes.length, sha256: sha256(bytes) }] };
  const sum = changed.files.reduce((n, e) => n + e.bytes, 0);
  assert.equal(sum + markerBytes, maximum + 1); assert.ok(sum <= maximum);
  f.journal.putReceipt(f.launchId, f.receipt(changed));
  assert.throws(() => f.journal.readReceipt(f.launchId), /budget/);
});

test('NEW marker-before-policy partial is durable and retry preserves exact bytes; missing/corrupt marker fails closed', t => {
  const f = fixture(t, false); f.write('config.opaque', 'evidence'); let stopped = false;
  f.hooks((kind, path) => {
    if (kind === 'directory' && path === join(f.receipts, f.launchId) && existsSync(markerFile(f)) && !existsSync(f.artifact(policyPath))) {
      stopped = true; throw new Error('UNIT interrupted after durable marker');
    }
  });
  assert.throws(() => f.journal.collect(f.intent, logs), /interrupted/); f.hooks();
  assert.equal(stopped, true); assert.equal(existsSync(f.artifact(policyPath)), false); assert.equal(f.journal.readReceipt(f.launchId), null);
  const before = readFileSync(markerFile(f)); const c = f.journal.collect(f.intent, logs);
  assert.deepEqual(readFileSync(markerFile(f)), before);
  f.journal.putReceipt(f.launchId, f.receipt(c)); assert.ok(f.journal.readReceipt(f.launchId));
  rmSync(markerFile(f)); assert.throws(() => f.journal.readReceipt(f.launchId), /record mismatch/);
  writeFileSync(markerFile(f), '{}'); assert.throws(() => f.journal.readReceipt(f.launchId), /record mismatch/);
  // Recollect never silently replaces corrupt immutable partial metadata.
  assert.throws(() => f.journal.collect(f.intent, logs), /conflict/);
});

test('NEW legacy optional-missing-log collections store neither policy nor marker under both providers', t => {
  for (const provider of ['jdt', 'pylsp'] as const) {
    const f = fixture(t, false, provider); f.write('osgi.log', 'boot');
    // state/.metadata/.log deliberately absent: three artifacts, no retroactive discriminator.
    const c = f.journal.collect(f.intent, logs); assert.equal(c.files.length, 3);
    assert.deepEqual(c.missing, ['state/.metadata/.log']);
    f.journal.putReceipt(f.launchId, f.receipt(c)); assert.ok(f.journal.readReceipt(f.launchId));
    assert.equal(existsSync(markerFile(f)), false); assert.equal(existsSync(f.artifact(policyPath)), false);
    assert.equal(readdirSync(join(f.receipts, f.launchId)).length, 5); // intent+3artifacts+receipt
  }
});
