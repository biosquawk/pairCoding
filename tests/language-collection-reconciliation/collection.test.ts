import test from 'node:test';
import assert from 'node:assert/strict';
import { lstatSync, mkdirSync, readFileSync, writeFileSync, rmSync, linkSync, symlinkSync, renameSync, chmodSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { DiskLanguageProcessJournal, sha256 } from '../../src/server/language/LanguageProcessJournal';
import { fixture, logs, shape, deep, policy, policyPath } from './fixture';

test('actual71shape collection keeps genuine evidence and accounts all 47 deep binaries without copying them', t => {
  const f = fixture(t), collection = f.journal.collect(f.intent, logs), p = policy(f);
  assert.equal(p.entries.length, 71); assert.equal(p.entries.filter(e => e.type === 'directory').length, 16);
  const excluded = p.entries.filter(e => e.selection === 'excluded');
  assert.equal(excluded.length, 47); assert.equal(excluded.reduce((n, e) => n + e.bytes, 0), 7758187);
  assert.equal(collection.files.length, 12); // 8 original config/control + exact state log + 2 streams + policy
  assert.equal(p.entries.filter(e => e.selection === 'selected').reduce((n, e) => n + e.bytes, 0), 10171);
  for (const e of shape.entries.filter(e => e.base64 !== undefined)) {
    const selected = collection.files.find(file => file.path === `boot/${e.path}`)!; assert.ok(selected, e.path);
    assert.equal(selected.sha256, e.sha256); assert.deepEqual(readFileSync(f.artifact(selected.path)), Buffer.from(e.base64!, 'base64'));
  }
  for (const e of excluded) { assert.equal(e.reason, 'JDT_EXTRACTED_BINARY_CACHE'); assert.equal(existsSync(f.artifact(e.path)), false); }
  assert.equal(p.completeness, 'COMPLETE_POLICY_SELECTION_NOT_BINARY_CONTENT_ARCHIVE');
  assert.equal(p.version, 'JDT_BOOT_EVIDENCE_V1'); assert.equal(p.intentSha256, f.receipt(collection).intentSha256);
  assert.equal(p.selected.length, 11); assert.equal(p.selected.some(file => file.path === policyPath), false);
  assert.equal(collection.logs.truncated, true); assert.deepEqual(collection.missing, []);
  f.journal.putReceipt(f.launchId, f.receipt(collection)); assert.deepEqual(f.journal.readReceipt(f.launchId), f.receipt(collection));
  assert.ok(f.flushed().files > 12); assert.ok(f.flushed().directories > 12);
});
test('deep text and unknown opaque leaves inside cache branches are selected, never hidden as binaries', t => {
  const f = fixture(t); f.write(`${deep}/diagnostic.txt`, 'real diagnostic\n'); f.write(`${deep}/diagnostic.payload`, 'opaque important\n');
  const c = f.journal.collect(f.intent, logs), p = policy(f);
  for (const name of ['diagnostic.txt', 'diagnostic.payload']) {
    const entry = p.entries.find(e => e.path === `boot/${deep}/${name}`)!; assert.equal(entry.selection, 'selected');
    assert.ok(c.files.some(e => e.path === entry.path));
  }
});
test('original shallow JDT and pylsp log-only exact four artifacts and historical schema1 remain readable', t => {
  for (const provider of ['jdt', 'pylsp'] as const) {
    const f = fixture(t, false, provider);
    f.write('osgi.log', 'boot log\n'); mkdirSync(join(f.state, '.metadata')); writeFileSync(join(f.state, '.metadata', '.log'), 'state log\n');
    symlinkSync('/UNIT-outside-must-not-crawl', join(f.state, '.metadata', 'binary-index'));
    const c = f.journal.collect(f.intent, logs); assert.equal(c.files.length, 4); assert.equal(existsSync(f.artifact(policyPath)), false);
    assert.deepEqual(c.files.map(e => e.path), ['boot/osgi.log', 'state/.metadata/.log', 'stdout.log', 'stderr.log']);
    f.journal.putReceipt(f.launchId, f.receipt(c)); assert.deepEqual(new DiskLanguageProcessJournal(f.receipts).readReceipt(f.launchId), f.receipt(c));
  }
});
test('ordinary newly-selected JSON/XML/opaque files have a deterministic policy and unchanged generic depth4', t => {
  const f = fixture(t, false); f.write('a/b/c/d/config.json', '{"diagnostic":"keep"}'); f.write('config.xml', '<config/>');
  const c = f.journal.collect(f.intent, logs); assert.ok(c.files.some(e => e.path.endsWith('/config.json'))); assert.ok(policy(f));
  f.write('a/b/c/d/e/too-deep.log', 'no'); assert.throws(() => f.journal.collect(f.intent, logs), /depth limit/);
});
test('partial durable config retry reuses bytes/inode and deterministic manifest, no overwriting conflicts', t => {
  const f = fixture(t); let count = 0;
  f.hooks(kind => { if (kind === 'file' && ++count === 2) throw new Error('UNIT interrupted file flush'); });
  assert.throws(() => f.journal.collect(f.intent, logs), /interrupted/); f.hooks();
  const path = f.artifact('boot/jdt-config/config.ini'), initial = readFileSync(path), inode = lstatSync(path, { bigint: true }).ino;
  const c = f.journal.collect(f.intent, logs), before = readFileSync(f.artifact(policyPath));
  assert.deepEqual(f.journal.collect(f.intent, logs), c); assert.deepEqual(readFileSync(f.artifact(policyPath)), before);
  assert.deepEqual(readFileSync(path), initial); assert.equal(lstatSync(path, { bigint: true }).ino, inode);
  f.write('jdt-config/config.ini', 'different'); assert.throws(() => f.journal.collect(f.intent, logs), /conflict|oversize/);
  assert.deepEqual(readFileSync(path), initial); assert.equal(f.journal.readReceipt(f.launchId), null);
});
test('directory durability failure propagates and same journal can reconcile; no receipt fabricated', t => {
  const f = fixture(t); let calls = 0; f.hooks(kind => { if (kind === 'directory' && ++calls === 3) throw new Error('UNIT directory EIO'); });
  assert.throws(() => f.journal.collect(f.intent, logs), /directory EIO/); f.hooks();
  assert.equal(f.journal.readReceipt(f.launchId), null); assert.ok(f.journal.collect(f.intent, logs).files.length);
});
test('unknown JDT directory/deeper jars/large numeric segment cannot downgrade to generic depth traversal', t => {
  for (const path of ['jdt-config/unknown', `${deep}/nested`, 'jdt-config/org.eclipse.osgi/0001', 'jdt-config/org.eclipse.osgi/1234567890',
    'jdt-config/org.eclipse.equinox.launcher/other-version']) {
    const f = fixture(t); f.write(`${path}/diagnostic.log`, 'must not hide');
    assert.throws(() => f.journal.collect(f.intent, logs), /Unknown JDT/); assert.equal(f.journal.readReceipt(f.launchId), null);
  }
});
test('nonbinary jar/ELF and oversize extracted binary fail closed, not selected or silently excluded', t => {
  for (const [path, bytes] of [[`${deep}/evil.jar`, Buffer.from('text-not-jar')],
    [shape.entries.find(e => e.path.endsWith('.so'))!.path, Buffer.from('text-not-ELF')],
    [`${deep}/huge.jar`, Buffer.alloc(1024 * 1024 + 1)]] as const) {
    const f = fixture(t); f.write(path, bytes); assert.throws(() => f.journal.collect(f.intent, logs), /Malformed|oversize/);
  }
});
test('link/hardlink/special-file checks apply equally to deep binary and selected text/ancestor', t => {
  for (const kind of ['symlink', 'hardlink', 'dirlink', 'selected-hardlink'] as const) {
    const f = fixture(t), source = join(f.boot, 'jdt-config', 'config.ini');
    if (kind === 'symlink') symlinkSync(source, join(f.boot, deep, 'bad.jar'));
    if (kind === 'hardlink') linkSync(join(f.boot, shape.entries.find(e => e.path.endsWith('.jar'))!.path), join(f.boot, deep, 'hard.jar'));
    if (kind === 'dirlink') { rmSync(join(f.boot, deep), { recursive: true }); symlinkSync('/UNIT-outside', join(f.boot, deep)); }
    if (kind === 'selected-hardlink') linkSync(source, join(f.boot, 'duplicate.txt'));
    assert.throws(() => f.journal.collect(f.intent, logs), /Unsafe|unsafe|directory\/link/);
  }
});
test('all 256 entries still enforced, selected per-file and aggregate include actual logs and policy bytes', t => {
  const tooMany = fixture(t, false); for (let i = 0; i < 257; i++) tooMany.write(`${i}.log`, '');
  assert.throws(() => tooMany.journal.collect(tooMany.intent, logs), /entry limit/);
  const large = fixture(t, false); large.write('large.log', Buffer.alloc(1024 * 1024 + 1));
  assert.throws(() => large.journal.collect(large.intent, logs), /oversize/);
  const agg = fixture(t, false); for (let i = 0; i < 4; i++) agg.write(`${i}.log`, Buffer.alloc(1024 * 1024));
  assert.throws(() => agg.journal.collect(agg.intent, logs), /budget/); // streams over exact 4MiB
  const streams = fixture(t, false); assert.throws(() => streams.journal.collect(streams.intent, { ...logs, stdout: 'x'.repeat(1024 * 1024 + 1) }), /budget/);
  const metadata = fixture(t, false);
  for (let i = 0; i < 4; i++) metadata.write(`${i}.opaque`, Buffer.alloc(1024 * 1024 - 1));
  assert.throws(() => metadata.journal.collect(metadata.intent, { stdout: '', stderr: '', truncated: false }), /budget/); // policy is not free
});
test('missing state log differs from unsafe .metadata and unsafe log; index/dependencies never walked', t => {
  const f = fixture(t, false); const c = f.journal.collect(f.intent, logs); assert.deepEqual(c.missing, ['state/.metadata/.log']);
  symlinkSync('/UNIT-outside', join(f.state, '.metadata')); assert.throws(() => f.journal.collect(f.intent, logs), /directory\/link/);
  const g = fixture(t, false); mkdirSync(join(g.state, '.metadata')); symlinkSync('/UNIT-outside', join(g.state, '.metadata', '.log'));
  assert.throws(() => g.journal.collect(g.intent, logs), /Unsafe/);
});
test('final rechecks reject inserted directory names and changed excluded binary even after output flush', t => {
  for (const kind of ['insert', 'rename', 'binary', 'mode', 'state-appears'] as const) {
    const f = fixture(t); if (kind === 'state-appears') rmSync(join(f.state, '.metadata', '.log'));
    let done = false; f.hooks(k => {
      if (k !== 'file' || done) return;
      if (['state-appears', 'binary'].includes(kind) && !existsSync(f.artifact('stderr.log'))) return;
      done = true;
      if (kind === 'insert') f.write('late.log', 'must not omit');
      if (kind === 'rename') { renameSync(join(f.boot, deep), join(f.boot, deep + '-old')); mkdirSync(join(f.boot, deep)); }
      if (kind === 'binary') {
        const b = join(f.boot, shape.entries.find(e => e.path.endsWith('.jar'))!.path); writeFileSync(b, readFileSync(b));
      }
      if (kind === 'mode') chmodSync(join(f.boot, 'jdt-config'), 0o700);
      if (kind === 'state-appears') writeFileSync(join(f.state, '.metadata', '.log'), 'late');
    });
    assert.throws(() => f.journal.collect(f.intent, logs), /changed|appeared|Unknown/); assert.equal(done, true);
  }
});
test('durable selected/policy corruption, missing policy and removed policy reference block receipt readback', t => {
  for (const kind of ['selected', 'policy', 'missing-policy', 'missing-reference', 'missing-both', 'marker'] as const) {
    const f = fixture(t), c = f.journal.collect(f.intent, logs); f.journal.putReceipt(f.launchId, f.receipt(c));
    if (kind === 'selected') writeFileSync(f.artifact('boot/jdt-config/config.ini'), 'corruption');
    if (kind === 'policy') writeFileSync(f.artifact(policyPath), '{}');
    if (kind === 'missing-policy') rmSync(f.artifact(policyPath));
    if (kind === 'marker') writeFileSync(join(f.receipts, f.launchId, 'collection-policy-required.json'), '{}');
    if (kind === 'missing-both') rmSync(f.artifact(policyPath));
    if (kind === 'missing-reference' || kind === 'missing-both') {
      const receipt = f.receipt(c); receipt.collection.files = c.files.filter(e => e.path !== policyPath);
      writeFileSync(join(f.receipts, f.launchId, 'receipt.json'), JSON.stringify(receipt));
    }
    assert.throws(() => f.journal.readReceipt(f.launchId), /changed|mismatch|ENOENT|missing/i);
  }
});

test('combined artifact ceiling258 admits254 opaque leaves+streams+policy+marker but rejects255', t => {
  for (const count of [254, 255]) {
    const f = fixture(t, false); for (let i = 0; i < count; i++) f.write(`${i}.opaque`, '');
    if (count === 254) { const c = f.journal.collect(f.intent, logs); assert.equal(c.files.length + 1, 258); f.journal.putReceipt(f.launchId, f.receipt(c)); assert.ok(f.journal.readReceipt(f.launchId)); }
    else assert.throws(() => f.journal.collect(f.intent, logs), /budget/);
  }
});
test('state-log output failure ENOENT is not reclassified as missing evidence', t => {
  const f = fixture(t); let fired = false;
  // State log is flushed after8 selected boot records. Simulate file/directory durability ENOENT,
  // not actual optional source absence; the read has succeeded and the failure MUST propagate.
  let count = 0; f.hooks(kind => { if (kind === 'file' && ++count === 9) { fired = true; throw Object.assign(new Error('UNIT flush ENOENT'), { code: 'ENOENT' }); } });
  assert.throws(() => f.journal.collect(f.intent, logs), /flush ENOENT/); assert.equal(fired, true);
  assert.equal(f.journal.readReceipt(f.launchId), null);
});
