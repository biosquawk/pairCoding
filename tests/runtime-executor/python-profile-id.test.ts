/** Actual WriteGate/immutable copy/Python adapter/plan/executor, synthetic trusted cache + FakeDocker.
 * No actual Docker/pytest/GUI claim. Uses the unchanged builtin Python profile and example tasks.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fixture } from './fixtures';
import { createRuntimeWorkspace } from '../../src/server/runtime-coordinator/RuntimeWorkspace';
import { copyAcknowledgedInput, readRunSourceInventory, verifyAcknowledgedInput } from '../../src/server/execution/ImmutableInput';
import { PythonAdapter, dependencyHash } from '../../src/server/runtime-adapters';
import { validatePlan } from '../../src/server/execution/PlanPolicy';
import { DockerExecutor } from '../../src/server/execution/DockerExecutor';
import { safeId } from '../../src/server/execution/files';
import type { RuntimeCatalog, SettingsV2 } from '../../src/shared/runtime-v2';

async function pythonFixture(t:test.TestContext) {
  const f=await fixture();let closeCore:(()=>void)|undefined;t.after(async()=>{try{closeCore?.();}finally{await f.cleanup();}});
  const workspace=path.join(f.root,'python-workspace');await fs.mkdir(workspace);
  const example=new URL('../../examples/python-calculator/',import.meta.url);
  for(const name of ['calculator.py','test_calculator.py','requirements.txt','task.v2.json'])
    await fs.copyFile(new URL(name,example),path.join(workspace,name));
  const task=JSON.parse(await fs.readFile(new URL('task.v2.json',example),'utf8'));
  const settings:SettingsV2={schemaVersion:2,taskFilePath:null,taskMode:'IMPLEMENTATION',reviewNotesPath:'review.md',runProfiles:task.runProfiles,aiConsent:false,contextPatterns:[]};
  await fs.mkdir(path.join(workspace,'.paircoach'),{mode:0o700});await fs.writeFile(path.join(workspace,'.paircoach/settings.json'),JSON.stringify(settings),{mode:0o600});
  const core=await createRuntimeWorkspace({rootPath:workspace});closeCore=()=>core.close();core.session.claimLease('tab');
  const old=core.workspace.getDocument('calculator.py');
  const ack=await core.gate.writeAsync({clientId:'tab',sessionId:core.session.state.sessionId,actor:'STUDENT',controlEpoch:core.session.state.controlEpoch,
    path:old.path,baseVersion:old.version,content:old.content+'\n# ordinary ACK before Main\n'});
  const catalog:RuntimeCatalog=JSON.parse(await fs.readFile(new URL('../../runtimes/catalog.json',import.meta.url),'utf8'));
  const profile=catalog.profiles.find(p=>p.id==='python-3.13')!;assert.ok(profile);
  const image={...f.plan.lockedImage,key:profile.imageLockKey,tools:profile.expectedTools};
  const capture=(profileId=profile.id,runId='python-regression')=>core.gate.captureRun({clientId:'tab',sessionId:core.session.state.sessionId,
    actor:'STUDENT',controlEpoch:core.session.state.controlEpoch,expectedWorkspaceVersion:core.workspace.workspaceVersion,runId,profileId,configurationGeneration:'configuration',
    runDirectory:path.join(f.runs,runId)},{inventory:readRunSourceInventory,copy:copyAcknowledgedInput});
  return {...f,core,workspace,ack,profile,image,capture,settings};
}

test('builtin python-3.13: acknowledged immutable input and real Python plan reach exact executor once',async t=>{
  const f=await pythonFixture(t),before=await readRunSourceInventory(f.workspace),input=await f.capture();
  assert.equal(input.identity.profileId,'python-3.13');assert.equal(input.identity.workspaceVersion,f.core.workspace.workspaceVersion);
  assert.equal(input.files.find(v=>v.path==='calculator.py')!.documentVersion,f.ack.version);
  await verifyAcknowledgedInput(input);
  const caches=f.plan.caches.map(c=>({...c,family:'python' as const,dependencyHash:dependencyHash(input.files)}));
  const ownership={...f.plan.ownership,runId:input.identity.runId,profileId:f.profile.id,containerName:`paircoach-install-${f.profile.id}-${input.identity.runId}`};
  const plan=await new PythonAdapter().buildPlan({input,profile:f.profile,lockedImage:f.image,caches,ownership},f.settings.runProfiles[0]);
  const policy={...f.policy,runtimes:[{profile:f.profile,image:f.image,caches,commandAllowed:f.policy.runtimes[0].commandAllowed}]};
  await validatePlan(policy,plan);
  for(const patch of [{runId:'python-3.13'},{profileId:'another-profile'},{engineId:'another-engine'},{installationId:'install.v1'}])
    await assert.rejects(validatePlan(policy,{...plan,ownership:{...plan.ownership,...patch}}),/Unapproved ownership/);
  await assert.rejects(validatePlan(policy,{...plan,input:{...plan.input,identity:{...plan.input.identity,manifestSha256:'0'.repeat(64)}}}),/Input identity mismatch/);
  const executor=new DockerExecutor({policy,journal:f.journal,transport:f.fake});
  const handle=await executor.start(plan);assert.equal(handle.runId,ownership.runId);
  assert.equal(f.fake.calls.filter(a=>a[0]==='create').length,1);assert.equal(f.fake.calls.filter(a=>a[0]==='start').length,1);
  const retained=await f.journal.read(handle.runId);assert.deepEqual(retained.plan,plan);assert.equal(retained.phase,'RUNNING');
  assert.deepEqual(await readRunSourceInventory(f.workspace),before);
  const changed=await f.core.gate.writeAsync({clientId:'tab',sessionId:f.core.session.state.sessionId,actor:'STUDENT',controlEpoch:f.core.session.state.controlEpoch,
    path:'calculator.py',baseVersion:f.ack.version,content:f.ack.content+'# later edit\n'});assert.ok(changed.version>f.ack.version);
  await verifyAcknowledgedInput(input);assert.notEqual(await fs.readFile(path.join(input.immutableDirectory,'calculator.py'),'utf8'),changed.content);
});

test('profile-only dot support never permits unsafe identity/path or changes global filesystem IDs',async t=>{
  const f=await pythonFixture(t);
  for(const profileId of ['../python','python/3','python\\3','python:3','-python','python\0x','a'.repeat(81)])
    await assert.rejects(f.capture(profileId),/Unsafe input identity/);
  for(const runId of ['python-3.13','../run','run/name','run:other']) {
    assert.equal(safeId(runId),false);await assert.rejects(f.capture(f.profile.id,runId),/Unsafe input identity/);
  }
  assert.equal(safeId('legacy-run_1'),true);assert.equal(f.fake.calls.length,0);
});
