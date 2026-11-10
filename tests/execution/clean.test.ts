import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

for (const linked of [false, true]) {
  test(`clean script only removes generated dist and ${linked ? 'refuses junction/symlink' : 'preserves evidence and recovery'}`, t => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'paircoach-clean-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    mkdirSync(path.join(root, 'scripts'));
    copyFileSync(fileURLToPath(new URL('../../scripts/clean.mjs', import.meta.url)), path.join(root, 'scripts/clean.mjs'));
    mkdirSync(path.join(root, '.paircoach')); writeFileSync(path.join(root, '.paircoach/facts'), 'preserve');
    mkdirSync(path.join(root, 'artifacts')); writeFileSync(path.join(root, 'artifacts/evidence'), 'preserve');
    if (linked) {
      mkdirSync(path.join(root, 'important')); writeFileSync(path.join(root, 'important/keep'), 'preserve');
      symlinkSync(path.join(root, 'important'), path.join(root, 'dist'), process.platform === 'win32' ? 'junction' : 'dir');
    } else { mkdirSync(path.join(root, 'dist')); writeFileSync(path.join(root, 'dist/index.html'), 'generated'); }
    const result = spawnSync(process.execPath, [path.join(root, 'scripts/clean.mjs')], { encoding: 'utf8' });
    assert.equal(result.status, linked ? 1 : 0);
    assert.equal(existsSync(path.join(root, 'dist')), linked);
    assert.ok(existsSync(path.join(root, '.paircoach/facts')));
    assert.ok(existsSync(path.join(root, 'artifacts/evidence')));
    if (linked) assert.ok(existsSync(path.join(root, 'important/keep')));
  });
}
