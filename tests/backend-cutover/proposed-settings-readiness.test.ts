import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { executionFixture } from './execution-composition-fixture';
test('SAVE proposed-settings readiness consumes explicit retained proposal, never persisted old task selectors and never persists proposal',async t=>{
  const f=await executionFixture(t),before=fs.readFileSync(f.core.settingsStore.settingsPath),settings=structuredClone(f.core.readSettings().settings!);
  settings.runProfiles=[];
  const selected=f.execution.readinessForSettings(settings);settings.runProfiles=structuredClone(f.core.readSettings().settings!.runProfiles);
  const result=await selected.execution.readiness(f.runtime.profile,f.runtime.configurationGeneration);
  assert.equal(result.modes.RUN_MAIN.canRun,false);assert.equal(result.modes.RUN_MAIN.problem?.code,'TASK_CONFIG_INVALID');
  assert.equal(result.modes.RUN_TESTS.canRun,false);assert.equal(result.modes.RUN_TESTS.problem?.code,'TASK_CONFIG_INVALID');
  assert.deepEqual(fs.readFileSync(f.core.settingsStore.settingsPath),before);assert.equal(f.core.workspace.workspaceVersion,0);assert.equal(f.fake.calls.length,0);
});
