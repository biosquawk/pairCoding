import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateRuntimeConfigV1, validateSettingsV2 } from '../../src/shared/validation-v2';
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
test('shipped root config conforms to frozen RuntimeConfigV1 with package-relative sources and no fallback', () => {
  const config=JSON.parse(fs.readFileSync(path.join(repo,'paircoach.runtime.json'),'utf8'));
  assert.equal(validateRuntimeConfigV1(config),true);
  assert.equal(config.activeProfile,'java-maven-21');
  assert.equal(config.workspaceRoot,'./examples/java-pattern');
  assert.equal(config.runtimeCatalog,'./runtimes/catalog.json');
  assert.equal(config.imageLock,'./runtimes/images.lock.json');
  assert.deepEqual(config.execution,{backend:'docker',pullPolicy:'never'});
  assert.deepEqual(config.languageFeatures,{completion:true,diagnostics:true});
  for(const key of ['workspaceRoot','runtimeCatalog','imageLock'])assert.equal(path.isAbsolute(config[key]),false);
  const before=JSON.parse(fs.readFileSync(path.join(repo,'package.json'),'utf8'));
  assert.equal(before.scripts['runtime:prepare'],'node scripts/runtime-prepare-cli.mjs');
});

// Documentation contract checks only: not CLI/backend integration or runtime readiness.
test('guide supplies a full valid fresh-project SettingsV2 before public prepare', async (t) => {
  const source=fs.readFileSync(path.join(repo,'docs/windows-polyglot.md'),'utf8');
  for(const lineEnding of ['LF','CRLF']) await t.test(lineEnding, () => {
    const guide=source.replace(/\r?\n/g,lineEnding==='LF'?'\n':'\r\n');
    const examples=[...guide.matchAll(/```json\r?\n([\s\S]*?)\r?\n```/g)].map(block=>JSON.parse(block[1]));
    const settings=examples.find(value=>value.schemaVersion===2 && Array.isArray(value.runProfiles));
    assert.ok(settings,'full SettingsV2 example is required, not a runProfiles-only fragment');
    assert.equal(validateSettingsV2(settings),true);
    assert.equal(settings.aiConsent,false);
    assert.deepEqual(settings.runProfiles.map((p: {kind:string})=>p.kind),['RUN_MAIN','RUN_TESTS']);
    assert.deepEqual(settings.runProfiles[0].task,{workingDirectory:'.',entry:{kind:'JAVA_MAIN',className:'demo.StrategyDemo'},tests:{paths:[],names:['demo.StrategyDemoTest']}});
    assert.deepEqual(settings.runProfiles[1].task,{workingDirectory:'.',entry:{kind:'JAVA_MAIN',className:'demo.StrategyDemo'},tests:{paths:[],names:['demo.StrategyDemoTest']}});
    const template=JSON.parse(fs.readFileSync(path.join(repo,'examples/java-pattern/task.v2.json'),'utf8'));
    assert.deepEqual(settings.runProfiles,template.runProfiles);
    assert.ok(guide.indexOf('.paircoach/settings.json')<guide.indexOf('npm.cmd run runtime:prepare'));
    assert.match(guide,/\$example = 'java-pattern'/);
    assert.match(guide,/\$project = Join-Path \$base \$example/);
    assert.match(guide,/Copy-Item -LiteralPath \(Join-Path \$app/);
    assert.match(guide,/if \(Test-Path -LiteralPath \$settingsDir\) \{ throw/);
    assert.match(guide,/\$profile = 'java-maven-21'/);
    assert.match(guide,/runProfiles = @\(\$template.runProfiles\)/);
  });
});
test('guide selects generated config and exact job receipt parent, never execute envelope', () => {
  const guide=fs.readFileSync(path.join(repo,'docs/windows-polyglot.md'),'utf8');
  assert.match(guide,/Join-Path \$executeOut 'runtime-config.json'/);
  assert.match(guide,/Join-Path \(Join-Path \$executeOut 'jobs'\) \$profile/);
  assert.match(guide,/npm.cmd start -- --runtime-config \$runtimeConfig --prepared-runtime \$preparedRoot/);
  assert.doesNotMatch(guide,/--prepared-runtime \$executeOut/);
  assert.match(guide,/--prepare-timeout-ms 3600000 --execute 2> \$prepareLog/);
  assert.match(guide,/--prepare-timeout-ms 3600000 --execute 2> "\$prepareLog"/);
  assert.match(guide,/1000\.\.86400000ms/);
  assert.match(guide,/2700000ms \(45min\)/);
  assert.match(guide,/Ctrl\+C \(SIGINT\)/);
  assert.match(guide,/Get-Content -LiteralPath \$prepareLog -Wait/);
  assert.match(guide,/tail -f "\$prepareLog"/);
  assert.match(guide,/samo zabicie CLI nie dowodzi wycofania operacji daemona/);
  assert.ok(guide.includes('Po dokładnym komunikacie `Cancellation window closed; publishing measured runtime config`'));
  assert.ok(guide.includes('Samo `phase=publish` nie zamyka tego okna.'));
  assert.doesNotMatch(guide,/Po komunikacie `publish` okno anulowania jest już zamknięte/);

  for(const status of ['PLAN_ONLY','PREPARED_CONFIG_GENERATED_NOT_ACCEPTANCE','NOTREADY']) assert.ok(guide.includes(status));
  assert.match(guide,/Publiczne wykonanie prepare, Java21\/Spring21 GUI, native Windows i świeży ZIP[\s\S]*?NOT_RUN/);
});
