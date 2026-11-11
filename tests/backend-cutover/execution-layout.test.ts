/** Real filesystem/layout ownership; no Docker/LSP/native proof. */
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRuntimeExecutionLayout } from '../../src/server/runtime-coordinator/RuntimeExecutionLayout';
function fixture(t: TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'execution-layout-'));
  const project = path.join(root, 'project'), state = path.join(root, 'runtime-state'); fs.mkdirSync(project);
  t.after(() => fs.rmSync(root, { recursive: true, force: true })); return { root, project, state };
}
test('SEAM installation ownership is durable, project scoped and survives exact reopen without changing bytes', t => {
  const f = fixture(t), first = createRuntimeExecutionLayout(f.state, f.project, 'project-id');
  const file = path.join(first.stateDirectory, 'installation.json'), original = fs.readFileSync(file);
  assert.deepEqual(createRuntimeExecutionLayout(f.state, f.project, 'project-id'), first);
  assert.deepEqual(fs.readFileSync(file), original); assert.ok(!first.runRoot.startsWith(f.project + path.sep));
  assert.equal(fs.readdirSync(f.project).length, 0);
  assert.throws(() => createRuntimeExecutionLayout(f.state, f.project, 'different-project-id'), { code: 'RUNTIME_OWNERSHIP_CHANGED' });
  const other = path.join(f.root, 'other'); fs.mkdirSync(other);
  const different = createRuntimeExecutionLayout(f.state, other, 'different-project-id');
  assert.notEqual(different.installationId, first.installationId); assert.notEqual(different.journalDirectory, first.journalDirectory);
  for (const directory of [f.state, first.stateDirectory, first.runRoot, first.journalDirectory]) assert.equal(fs.statSync(directory).mode & 0o077, 0);
});
test('SEAM overlap/relative/symlink/nonprivate paths refuse before inventing ownership', t => {
  const f = fixture(t);
  for (const directory of [f.project, path.join(f.project, 'state'), f.root, 'relative'])
    assert.throws(() => createRuntimeExecutionLayout(directory, f.project, 'project-id'), { code: 'UNSAFE_RUNTIME_STATE' });
  fs.mkdirSync(f.state, { mode: 0o755 }); fs.chmodSync(f.state, 0o755);
  assert.throws(() => createRuntimeExecutionLayout(f.state, f.project, 'project-id'), /not private/);
  assert.equal(fs.readdirSync(f.state).length, 0);
  const alias = path.join(f.root, 'alias'); fs.symlinkSync(f.state, alias);
  assert.throws(() => createRuntimeExecutionLayout(alias, f.project, 'project-id'), /Unsafe/);
});
test('SEAM corrupted/foreign identity never resets, discards or overwrites retained journal evidence', t => {
  const f = fixture(t), first = createRuntimeExecutionLayout(f.state, f.project, 'project-id');
  const file = path.join(first.stateDirectory, 'installation.json'), body = JSON.parse(fs.readFileSync(file, 'utf8'));
  const evidence = path.join(first.journalDirectory, 'retained.txt'); fs.writeFileSync(evidence, 'KEEP');
  for (const bad of [{ ...body, projectId: 'foreign' }, { ...body, workspaceRoot: f.root }, { ...body, extra: true }, { ...body, installationId: '../invalid' }]) {
    const bytes = JSON.stringify(bad); fs.writeFileSync(file, bytes);
    assert.throws(() => createRuntimeExecutionLayout(f.state, f.project, 'project-id'), { code: 'RUNTIME_OWNERSHIP_CHANGED' });
    assert.equal(fs.readFileSync(file, 'utf8'), bytes); assert.equal(fs.readFileSync(evidence, 'utf8'), 'KEEP');
  }
});

test('SEAM read-only prepared roots cannot become writable runtime state, checks precede ANY mkdir', t => {
  const f = fixture(t);
  for (const selected of [f.state, path.join(f.state, 'prepared'), f.root]) {
    assert.throws(() => createRuntimeExecutionLayout(f.state, f.project, 'project-id', [selected]), { code: 'UNSAFE_RUNTIME_STATE' });
    assert.equal(fs.existsSync(f.state), false);
  }
});
test('SEAM absent installation record with retained Run journal refuses a replacement identity', t => {
  const f = fixture(t), layout = createRuntimeExecutionLayout(f.state, f.project, 'project-id');
  fs.writeFileSync(path.join(layout.journalDirectory, 'old.json'), 'KEEP');
  fs.unlinkSync(path.join(layout.stateDirectory, 'installation.json'));
  assert.throws(() => createRuntimeExecutionLayout(f.state, f.project, 'project-id'), { code: 'RUNTIME_OWNERSHIP_CHANGED' });
  assert.equal(fs.existsSync(path.join(layout.stateDirectory, 'installation.json')), false);
  assert.equal(fs.readFileSync(path.join(layout.journalDirectory, 'old.json'), 'utf8'), 'KEEP');
});
