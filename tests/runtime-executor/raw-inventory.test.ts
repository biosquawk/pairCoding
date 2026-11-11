/** Real files; inventory and acknowledged immutable copy, not backend/WriteGate integration proof. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fixture } from './fixtures';
import { readRunSourceInventory, INPUT_LIMITS, verifyAcknowledgedInput } from '../../src/server/execution/ImmutableInput';
import { sha256 } from '../../src/server/execution/files';

test('raw inventory uses exact BOM/CRLF/Unicode/binary bytes and the identical sorted inventory as copy/verify', async () => {
  const f = await fixture();
  try {
    const raw = Buffer.from('\ufeffconsole.log("zażółć 😀");\r\n');
    await fs.writeFile(path.join(f.workspace, 'main.js'), raw);
    await fs.mkdir(path.join(f.workspace, 'src'));
    await fs.writeFile(path.join(f.workspace, 'src', 'empty.txt'), '');
    await fs.writeFile(path.join(f.workspace, 'src', 'bytes.bin'), Buffer.from([0, 255, 128, 13, 10]));
    const before = await readRunSourceInventory(f.workspace);
    assert.deepEqual(before.map(x => x.path), ['main.js', 'src/bytes.bin', 'src/empty.txt', 'zażółć 😀.txt']);
    assert.deepEqual(before[0], { path: 'main.js', sha256: sha256(raw), bytes: raw.length });
    assert.notEqual(before[0].sha256, sha256(raw.toString('utf8').replace(/^\ufeff/, '').replace(/\r\n/g, '\n')));
    assert.ok(Object.isFrozen(before)); for (const entry of before) assert.ok(Object.isFrozen(entry));
    assert.throws(() => (before as any).push({}));
    assert.throws(() => { (before[0] as any).sha256 = '0'.repeat(64); });
    assert.notStrictEqual(before, await readRunSourceInventory(f.workspace));
    // The authoritative version join remains caller-owned: explicit known fixture versions, not fabricated by the export.
    f.ack.files = before.map(entry => ({ ...entry, documentVersion: 2 }));
    const copy = await f.copy('rawcopy');
    assert.deepEqual(copy.files.map(({ path, sha256, bytes }) => ({ path, sha256, bytes })), before);
    assert.deepEqual(await verifyAcknowledgedInput(copy), before);
    assert.deepEqual(await fs.readFile(path.join(copy.immutableDirectory, 'main.js')), raw);
  } finally { await f.cleanup(); }
});

test('raw inventory shares the existing secret/build/report exclusion policy with acknowledged copy', async () => {
  const f = await fixture();
  try {
    for (const name of ['.env', '.env.local', 'private.key', 'junit.xml', 'TEST-old.xml']) await fs.writeFile(path.join(f.workspace, name), 'EXCLUDED');
    for (const name of ['node_modules', 'target', '.git', '.paircoach', '.aws', 'build', '__pycache__']) {
      await fs.mkdir(path.join(f.workspace, name));
      await fs.writeFile(path.join(f.workspace, name, 'secret.txt'), 'EXCLUDED');
    }
    const rows = await readRunSourceInventory(f.workspace);
    assert.deepEqual(rows, f.ack.files.map(({ path, sha256, bytes }) => ({ path, sha256, bytes })));
    const copied = await f.copy('excluded');
    assert.deepEqual(await verifyAcknowledgedInput(copied), rows);
  } finally { await f.cleanup(); }
});

for (const kind of ['symlink', 'hardlink', 'case-collision', 'oversize'] as const) test(`raw inventory and copy both reject existing ${kind} boundary`, async () => {
  const f = await fixture();
  try {
    const target = path.join(f.workspace, 'included.txt');
    if (kind === 'symlink') await fs.symlink(path.join(f.workspace, 'main.js'), target);
    if (kind === 'hardlink') await fs.link(path.join(f.workspace, 'main.js'), target);
    if (kind === 'case-collision') await fs.writeFile(path.join(f.workspace, 'MAIN.js'), 'same folded path');
    if (kind === 'oversize') await fs.writeFile(target, Buffer.alloc(INPUT_LIMITS.fileBytes + 1));
    await assert.rejects(readRunSourceInventory(f.workspace));
    await assert.rejects(f.copy('rejected'), /RUN_INPUT_CHANGED/);
    await assert.rejects(fs.lstat(path.join(f.runs, 'rejected', 'input-manifest.json')), { code: 'ENOENT' });
  } finally { await f.cleanup(); }
});
