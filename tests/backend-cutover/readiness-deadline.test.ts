/** Actual coordinator/resolver/executor with real private FS; Docker/tool identity controlled.
 * These tests do not claim native Docker/GUI success. No Run or source/cache mutation is admitted. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { executionFixture } from './execution-composition-fixture';
import { aggregateRuntimeReadiness } from '../../src/server/runtime-config';
import { validateExecutionView } from '../../src/shared/validation-v2';

function snapshot(root: string): unknown {
  const walk = (directory: string): unknown => fs.readdirSync(directory).sort().map(name => {
    const file = path.join(directory,name), stat = fs.lstatSync(file,{bigint:true});
    return [name,String(stat.mode),String(stat.mtimeNs),String(stat.ctimeNs),stat.isDirectory() ? walk(file) : fs.readFileSync(file).toString('base64')];
  });
  return walk(root);
}

test('COMPOSITION delayed prepared measurement is TIMEOUT, explicit executor engine failure is DAEMON_OFF; both deny without writes', async t => {
  const f = await executionFixture(t), original = f.prepared.resolve.bind(f.prepared);
  const config = { configurationGeneration:'cfg', resolved:f.runtime, problem:null } as const;
  const settings = f.core.readSettings().settings!;
  const sources = ['main.js','test.js','package.json'].map(name=>fs.readFileSync(path.join(f.workspace,name)));
  const cache = snapshot(f.preparedRoot);
  let release!:()=>void, complete!:()=>void;
  const held = new Promise<void>(resolve=>{release=resolve;}), done = new Promise<void>(resolve=>{complete=resolve;});
  f.prepared.resolve = async (...args) => { await held; return original(...args); };
  const dependencies = {...f.execution.readiness, timeoutMs:20, execution:{readiness:async (...args: Parameters<typeof f.execution.readiness.execution.readiness>) => {
    try { return await f.execution.readiness.execution.readiness(...args); } finally { complete(); }
  }}};
  const pending = await aggregateRuntimeReadiness(config,settings,dependencies);
  assert.equal(pending.runtime.state,'PREPARE_REQUIRED'); assert.equal(pending.runtime.problem?.code,'RUNTIME_READINESS_TIMEOUT');
  assert.equal(pending.modes.RUN_MAIN.canRun,false); assert.equal(pending.modes.RUN_TESTS.canRun,false); assert.ok(validateExecutionView(pending));
  release(); await done; f.prepared.resolve = original;
  assert.equal(pending.runtime.problem?.code,'RUNTIME_READINESS_TIMEOUT');
  f.fake.daemon = false;
  const off = await aggregateRuntimeReadiness(config,settings,f.execution.readiness);
  assert.equal(off.runtime.state,'DAEMON_OFF'); assert.equal(off.runtime.problem?.code,'DAEMON_UNAVAILABLE');
  assert.equal(off.modes.RUN_MAIN.canRun,false); assert.equal(off.modes.RUN_TESTS.canRun,false); assert.ok(validateExecutionView(off));
  f.fake.daemon = true;
  const current = await aggregateRuntimeReadiness(config,settings,f.execution.readiness);
  assert.equal(current.modes.RUN_MAIN.canRun,true); assert.equal(current.modes.RUN_TESTS.canRun,true);
  assert.deepEqual(snapshot(f.preparedRoot),cache);
  assert.deepEqual(['main.js','test.js','package.json'].map(name=>fs.readFileSync(path.join(f.workspace,name))),sources);
  assert.equal(f.fake.calls.some(args=>['create','start','stop','rm'].includes(args[0])),false);
});

test('COMPOSITION changed dependency and malformed prepared evidence stay PREPARE_REQUIRED, never daemon failure or READY', async t => {
  const f = await executionFixture(t), config = {configurationGeneration:'cfg',resolved:f.runtime,problem:null} as const;
  const settings=f.core.readSettings().settings!, original=fs.readFileSync(path.join(f.workspace,'package.json'));
  fs.writeFileSync(path.join(f.workspace,'package.json'),'{"dependencies":{"changed":"1.0.0"}}');
  let view=await aggregateRuntimeReadiness(config,settings,f.execution.readiness);
  assert.equal(view.runtime.state,'PREPARE_REQUIRED'); assert.equal(view.modes.RUN_MAIN.canRun,false); assert.equal(view.modes.RUN_TESTS.canRun,false);
  fs.writeFileSync(path.join(f.workspace,'package.json'),original);
  fs.writeFileSync(path.join(f.preparedRoot,'receipt.json'),'{"secret":"private-malformed-receipt"}');
  const cache=snapshot(f.preparedRoot);
  view=await aggregateRuntimeReadiness(config,settings,f.execution.readiness);
  assert.equal(view.runtime.state,'PREPARE_REQUIRED'); assert.equal(view.modes.RUN_MAIN.canRun,false); assert.equal(view.modes.RUN_TESTS.canRun,false);
  assert.ok(!JSON.stringify(view).includes('private-malformed-receipt')); assert.ok(validateExecutionView(view));
  assert.deepEqual(snapshot(f.preparedRoot),cache); assert.deepEqual(fs.readFileSync(path.join(f.workspace,'package.json')),original);
  assert.equal(f.fake.calls.some(args=>['create','start','stop','rm'].includes(args[0])),false);
});

for(const budget of [900000,3600000]) test(`COMPOSITION explicit settings save ${budget}ms reaches actual executor plan unchanged; Stop does not wait`,async t=>{
  const f=await executionFixture(t), source=f.core.readSettings(), settings=structuredClone(source.settings!);
  for(const run of settings.runProfiles)run.timeoutMs=budget;
  await f.core.settingsStore.save({humanConfirmed:true,expectedSourceSha256:source.sourceSha256,
    request:{requestId:'save-long',clientId:'tab',sessionId:f.core.session.state.sessionId,expectedWorkspaceVersion:f.core.workspace.workspaceVersion,settings}});
  assert.equal(f.core.readSettings().settings!.runProfiles[0].timeoutMs,budget);
  const run=await f.execution.start(f.request()), record=await f.execution.journal.read(run.runId);
  assert.equal(record.plan.timeoutMs,budget);assert.equal(run.status,'RUNNING');
  const stopped=await f.execution.runner.stop(run.runId);
  assert.equal(stopped.status,'CANCELLED');assert.equal(f.fake.calls.filter(a=>a[0]==='stop').length,1);
  assert.equal((await f.execution.journal.read(run.runId)).phase,'REMOVED');
});

test('COMPOSITION old catalog PENDING and measured fields agree; explicit existing descriptor is never overwritten',async t=>{
  const {readRuntimeProject}=await import('../../src/server/runtime-coordinator/RuntimeProject');
  const {runtimeTaskFields}=await import('../../src/server/runtime-config');
  const f=await executionFixture(t), config={configurationGeneration:'cfg',resolved:f.runtime,problem:null} as const;
  const read=(measureReadiness:boolean)=>readRuntimeProject({core:f.core,configuration:config,sessionId:f.core.session.state.sessionId,readiness:f.execution.readiness,measureReadiness,assertCurrent:()=>{},
    readLanguage:()=>({projectId:f.core.workspace.projectId,profileId:f.runtime.profile.id,configurationGeneration:'cfg',providerGeneration:'unit',state:'OFF',autocomplete:'OFF',docs:'N/A',problem:null})});
  const pending=await read(false), measured=await read(true);
  assert.deepEqual(pending.capabilities.execution.runtime.taskFields,measured.capabilities.execution.runtime.taskFields);
  assert.equal(pending.capabilities.execution.modes.RUN_MAIN.canRun,false);
  assert.equal(pending.capabilities.execution.runtime.taskFields.find(f=>f.key==='timeoutMs')?.max,3600000);
  assert.equal(f.runtime.profile.taskFields.length,0);
  const explicit={key:'timeoutMs' as const,label:'Custom budget',input:'INTEGER' as const,help:'Explicit policy',required:true,choices:[],min:1000,max:120000};
  const profile={...f.runtime.profile,taskFields:[explicit]};
  assert.deepEqual(runtimeTaskFields(profile),[explicit]);assert.deepEqual(profile.taskFields,[explicit]);
});
