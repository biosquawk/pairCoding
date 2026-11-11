/** Actual accepted executor→actual accepted adapter handoff, fake Docker ONLY. No runtime proof. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fixture } from '../runtime-executor/fixtures';
import { createTaskRuntimeAdapterRegistry } from '../../src/server/runtime-adapters';
test('UNIT genuine executor collection passes fresh Run JUnit to actual adapter without path/plan rewriting', async () => {
  const f = await fixture();
  try {
    const handle = await f.executor.start(f.plan);
    await fs.writeFile(path.join(f.input.artifactsDirectory, 'junit.xml'), '<testsuite tests="1" failures="0" errors="0" skipped="0"><testcase name="fresh"/></testsuite>');
    f.fake.finish(); const exit = await f.executor.wait(handle), collection = await f.executor.collect(handle, exit);
    assert.equal(collection.inputManifestSha256, f.plan.input.identity.manifestSha256);
    assert.equal(collection.files.length, 1); assert.equal(collection.files[0].freshForRun, true);
    assert.equal(await fs.readFile(collection.files[0].path, 'utf8'), await fs.readFile(path.join(f.input.artifactsDirectory, 'junit.xml'), 'utf8'));
    const outcome = await createTaskRuntimeAdapterRegistry().get(f.plan.profile).interpret(f.plan, exit, collection);
    assert.equal(outcome.testOutcome, 'PASSED'); assert.equal(outcome.testCount, 1); assert.equal(outcome.status, 'SUCCEEDED');
  } finally { await f.cleanup(); }
});
