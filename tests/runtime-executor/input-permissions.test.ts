/** Real copy/ACK/filesystem regression; child-only umask, no Docker or task-UID claim. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import {
  copyAcknowledgedInput, inputManifestHash, verifyAcknowledgedInput,
  type SettledAcknowledgement
} from '../../src/server/execution/ImmutableInput';
import { canonicalJson, sha256 } from '../../src/server/execution/files';

async function scenario(guard: boolean) {
  // Isolated subprocess: never change the test runner/application's umask.
  process.umask(0o077);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sealed-input-permissions-'));
  const workspace = path.join(root, 'workspace'), runs = path.join(root, 'runs');
  const source = new Map([
    ['pom.xml', { bytes: Buffer.from('<project/>\n'), mode: 0o600 }],
    ['src/main/java/demo/Main.java', { bytes: Buffer.from('\ufeffclass Main {}\r\n'), mode: 0o640 }],
    ['src/test/java/demo/MainTest.java', { bytes: Buffer.from('class MainTest {}\n'), mode: 0o400 }],
    ['README.txt', { bytes: Buffer.from('zażółć 😀\r\n'), mode: 0o644 }]
  ]);
  async function snapshot(dir: string): Promise<unknown[]> {
    const result: unknown[] = [];
    for (const name of (await fs.readdir(dir)).sort()) {
      const p = path.join(dir, name), st = await fs.lstat(p, { bigint: true });
      result.push([p, String(st.dev), String(st.ino), String(st.mode), String(st.nlink),
        String(st.uid), String(st.gid), String(st.mtimeNs), String(st.ctimeNs),
        st.isDirectory() ? await snapshot(p) : sha256(await fs.readFile(p))]);
    }
    return result;
  }
  async function cleanup(dir: string) {
    await fs.chmod(dir, 0o700);
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) await cleanup(path.join(dir, entry.name));
    }
  }
  try {
    await fs.mkdir(workspace, { mode: 0o700 });
    await fs.mkdir(runs, { mode: 0o700 });
    for (const [relative, file] of source) {
      const p = path.join(workspace, relative);
      await fs.mkdir(path.dirname(p), { recursive: true, mode: 0o700 });
      await fs.writeFile(p, file.bytes, { mode: file.mode });
      await fs.chmod(p, file.mode);
    }
    // Private material is NOT a staged input and must never be chmodded/copied.
    await fs.writeFile(path.join(workspace, '.env'), 'SECRET=not-input', { mode: 0o600 });
    const retained = path.join(runs, 'retained');
    await fs.mkdir(retained, { mode: 0o700 });
    await fs.writeFile(path.join(retained, 'receipt.json'), '{"retained":true}', { mode: 0o600 });
    const original = await snapshot(workspace), retainedBefore = await snapshot(retained);
    let fences = 0;
    const ack: SettledAcknowledgement = {
      projectId: 'project', sessionId: 'session', workspaceVersion: 9,
      files: [...source].map(([p, file]) => ({ path: p, documentVersion: 3,
        sha256: sha256(file.bytes), bytes: file.bytes.length })),
      assertCurrent: async () => { fences++; }
    };
    const runDirectory = path.join(runs, 'fresh');
    const options = { workspaceDirectory: workspace, runDirectory, runId: 'fresh',
      profileId: 'java-maven-21', configurationGeneration: 'config', acknowledgement: ack };
    if (guard) {
      const outside = path.join(retained, 'receipt.json');
      await assert.rejects(copyAcknowledgedInput({ ...options,
        afterFileCopied: async relative => {
          const dest = path.join(runDirectory, 'input', relative);
          await fs.unlink(dest);
          await fs.symlink(outside, dest);
        }
      }), /RUN_INPUT_CHANGED/);
      await assert.rejects(fs.stat(path.join(runDirectory, 'input-manifest.json')), { code: 'ENOENT' });
      assert.deepEqual(await snapshot(workspace), original);
      assert.deepEqual(await snapshot(retained), retainedBefore);
      console.log('PASS symlink substitution rejected; no manifest; original/private receipt unchanged');
      return;
    }
    const input = await copyAcknowledgedInput(options);
    assert.equal(fences, 2, 'both authoritative ACK fences');
    assert.equal(process.umask(), 0o077, 'product must not change umask');
    assert.deepEqual(input.files, [...ack.files].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    assert.equal(input.identity.manifestSha256, inputManifestHash(input));
    assert.equal(await fs.readFile(path.join(runDirectory, 'input-manifest.json'), 'utf8'), canonicalJson(input));
    await verifyAcknowledgedInput(input);
    // Check security/independence before readability so red baseline still exercises them.
    for (const p of [root, workspace, runs, runDirectory, input.buildDirectory, input.artifactsDirectory, retained]) {
      assert.equal((await fs.stat(p)).mode & 0o777, 0o700, `private parent/control directory: ${p}`);
    }
    assert.equal((await fs.stat(path.join(runDirectory, 'input-manifest.json'))).mode & 0o777, 0o600);
    assert.deepEqual(await snapshot(workspace), original);
    assert.deepEqual(await snapshot(retained), retainedBefore);
    const dirs = new Set([input.immutableDirectory]);
    for (const [relative, file] of source) {
      const dest = path.join(input.immutableDirectory, relative);
      const st = await fs.lstat(dest), src = await fs.lstat(path.join(workspace, relative));
      assert.ok(st.isFile() && !st.isSymbolicLink());
      assert.equal(st.nlink, 1);
      assert.ok(st.dev !== src.dev || st.ino !== src.ino, 'independent copy, not source hardlink');
      assert.deepEqual(await fs.readFile(dest), file.bytes);
      assert.equal(st.mode & 0o222, 0, 'no input write bits');
      for (let dir = path.dirname(dest); dir !== input.immutableDirectory; dir = path.dirname(dir)) dirs.add(dir);
    }
    for (const dir of dirs) assert.equal((await fs.stat(dir)).mode & 0o777, 0o555, 'traversable RO input directories');
    await assert.rejects(copyAcknowledgedInput(options), { code: 'EEXIST' });
    console.log('PASS four bytes/hashes/ACK/manifest, independent inodes, RO directories, private controls and no existing-run overwrite');
    for (const relative of source.keys()) {
      const mode = (await fs.stat(path.join(input.immutableDirectory, relative))).mode & 0o777;
      assert.equal(mode, 0o444, `fresh ${relative} readable by nonowner task UID under umask077`);
    }
    // Editing workspace after publication cannot change the sealed bytes/hash.
    await fs.writeFile(path.join(workspace, 'pom.xml'), '<project>new draft</project>');
    assert.deepEqual(await fs.readFile(path.join(input.immutableDirectory, 'pom.xml')), source.get('pom.xml')!.bytes);
    await verifyAcknowledgedInput(input);
    console.log('PASS all four fresh file modes0444; later workspace edit does not change acknowledged input');
  } finally {
    await cleanup(root);
    await fs.rm(root, { recursive: true, force: true });
  }
}

if (process.argv[2] === '--sealed-input-permissions-worker') {
  await scenario(process.argv[3] === 'guard');
} else {
  for (const guard of [false, true]) test(guard
    ? 'UNIT POSIX: restrictive umask copy still rejects symlink substitution without touching private receipt'
    : 'UNIT POSIX: fresh acknowledged input is readonly/nonowner-readable under umask077; sources/control data stay private',
  { skip: process.platform === 'win32' ? 'POSIX mode/umask regression; Windows ACL boundary unchanged' : false }, () => {
    const result = spawnSync(process.execPath, ['--import', 'tsx', fileURLToPath(import.meta.url),
      '--sealed-input-permissions-worker', guard ? 'guard' : 'copy'], { encoding: 'utf8', timeout: 30000 });
    process.stdout.write(result.stdout ?? '');
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stderr);
  });
}
