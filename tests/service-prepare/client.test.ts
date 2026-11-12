import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,prepared,deferred,MemoryStorage,storageKey} from './fixture';
import {run} from '../client-v2/fixtures';

test('explicit action only: same authenticated exact POST6/controlEpoch, durable original then fresh GET; Main/Tests independent',async t=>{
  const f=await fixture(t);assert.equal(f.posts().length,0);assert.equal(f.maintenance().canPrepare,true);
  f.b.session.controlEpoch=7;await f.snapshot();f.calls.length=0;
  assert.equal(await f.live.prepareRuntimeEnvironment(),true);
  assert.equal(f.posts().length,1);const sent=f.posts()[0];
  assert.equal(sent.headers.Authorization,'Bearer same-authenticated');assert.equal(sent.method,'POST');
  assert.deepEqual(sent.body,{requestId:sent.body.requestId,clientId:'c1',sessionId:'s1',expectedWorkspaceVersion:1,configurationGeneration:'cfg1',controlEpoch:7});
  assert.deepEqual(f.calls.map(c=>c.path),['/api/runtime/service-network/prepare','/api/project']);
  assert.equal(f.live.getState().runtime?.execution?.modes.RUN_MAIN.canRun,false);assert.equal(f.live.getState().runtime?.execution?.modes.RUN_TESTS.canRun,true);
  assert.equal(f.maintenance().blocked,false);assert.deepEqual(JSON.parse(f.storage.data.get(storageKey)!).entries,[]);
});
test('lost response keeps SAME original, explicit recovery only; reconnect/version/epoch/session change never rewrites original',async t=>{
  const f=await fixture(t);f.post=async()=>{throw Error('response lost after server admission');};
  assert.equal(await f.live.prepareRuntimeEnvironment(),false);const original=f.posts()[0];assert.equal(f.maintenance().uncertain,true);
  assert.equal(await f.live.prepareRuntimeEnvironment(),false);assert.equal(f.posts().length,1);
  f.b.session.sessionId=f.b.project.sessionId='s2';f.b.session.controlEpoch=8;f.b.project.workspaceVersion=f.b.session.workspaceVersion=2;
  f.b.project.capabilities.execution.runtime.configurationGeneration=f.b.project.capabilities.language.configurationGeneration='cfg2';
  await f.snapshot();assert.equal(f.posts().length,1);f.post=async()=>prepared();
  assert.equal(await f.live.prepareRuntimeEnvironment(true),true);assert.equal(f.posts()[1].raw,original.raw);assert.equal(f.maintenance().uncertain,false);
  assert.equal(f.calls.some(c=>c.path==='/api/runtime/mutation/reconcile'),false);
});
test('restore original and same client before HELLO, never auto POST; only explicit SAME request recovery',async t=>{
  const first=await fixture(t);first.post=async()=>{throw Error('lost');};await first.live.prepareRuntimeEnvironment();
  const original=first.posts()[0].raw;first.live.close();const restored=await fixture(t,{storage:first.storage});
  assert.equal(restored.posts().length,0);assert.equal(restored.maintenance().uncertain,true);
  assert.equal(await restored.live.prepareRuntimeEnvironment(true),true);assert.equal(restored.posts()[0].raw,original);
});
test('singleflight persists UNKNOWN before dispatch; Run/SAVE blocked while unknown, manual editor survives',async t=>{
  const f=await fixture(t),g=deferred();f.post=async()=>g.promise;
  const pending=f.live.prepareRuntimeEnvironment();assert.equal(f.maintenance().pending,true);
  assert.equal(await f.live.prepareRuntimeEnvironment(),false);assert.equal(await f.live.prepareRuntimeEnvironment(true),false);
  await f.live.run(true);assert.equal((await f.live.saveRuntimeSettings(f.b.project.settings,1)).ok,false);
  assert.equal(f.calls.some(c=>c.path==='/api/run'||c.path==='/api/project/settings'),false);
  f.live.saveFileContent('main.txt','manual remains usable');assert.equal(f.live.getState().files[0].content,'manual remains usable');
  g.resolve(prepared());assert.equal(await pending,false);assert.equal(f.maintenance().uncertain,true);assert.equal(f.posts().length,1);
});
for(const code of ['SERVICE_NETWORK_NOT_DISPATCHED','SERVICE_NETWORK_ABSENCE_CONFIRMED'])test(`genuine ${code} allows only separately explicit NEW action/ID`,async t=>{
  const f=await fixture(t);f.post=async()=>Response.json({code,message:'definitive absence'},{status:409});
  assert.equal(await f.live.prepareRuntimeEnvironment(),false);const id=f.posts()[0].body.requestId;
  assert.equal(f.maintenance().uncertain,false);assert.match(f.maintenance().message!,/osobnego kliknięcia/);
  assert.equal(await f.live.prepareRuntimeEnvironment(true),false);assert.equal(f.posts().length,1);
  f.post=async()=>prepared();assert.equal(await f.live.prepareRuntimeEnvironment(),true);assert.notEqual(f.posts()[1].body.requestId,id);
});
for(const response of [null,{}, {...prepared(),extra:true},{...prepared(),projectId:'foreign'},{...prepared(),name:'foreign'},{...prepared(),networkId:'invalid'},{...prepared(),engineId:'bad id'},{...prepared(),installationId:'.bad'}])test(`invalid successful response ${JSON.stringify(response)} retains original/no readiness refresh`,async t=>{
  const f=await fixture(t);f.post=async()=>response;f.calls.length=0;
  assert.equal(await f.live.prepareRuntimeEnvironment(),false);assert.equal(f.maintenance().uncertain,true);assert.deepEqual(f.calls.map(c=>c.path),['/api/runtime/service-network/prepare']);
});
for(const response of [()=>Response.json({code:'SERVICE_NETWORK_OUTCOME_UNKNOWN'},{status:503}),()=>Response.json({code:'SERVICE_NETWORK_CHANGED'},{status:409}),()=>Response.json({code:'SERVICE_NETWORK_ABSENCE_CONFIRMED'},{status:503}),()=>new Response('broken',{status:409})])test('only exact definitive absence409 clears; other errors and unreadable bodies retain original',async t=>{
  const f=await fixture(t);f.post=async()=>response();await f.live.prepareRuntimeEnvironment();assert.equal(f.maintenance().uncertain,true);
});
test('refresh failure never forces READY, retains confirmed receipt; later changed receipt cannot overwrite',async t=>{
  const f=await fixture(t);f.get=async()=>{throw Error('GET lost');};
  assert.equal(await f.live.prepareRuntimeEnvironment(),false);assert.equal(f.maintenance().uncertain,true);
  f.post=async()=>({...prepared(),networkId:'b'.repeat(64)});f.get=async()=>f.b.project;
  assert.equal(await f.live.prepareRuntimeEnvironment(true),false);assert.equal(f.maintenance().uncertain,true);
  f.post=async()=>Object.fromEntries(Object.entries(prepared()).reverse());
  assert.equal(await f.live.prepareRuntimeEnvironment(true),true);
});
for(const change of ['project','session','epoch','generation','version','snapshot','veto'] as const)test(`late prepare response fenced by ${change}`,async t=>{
  const f=await fixture(t),g=deferred();f.post=async()=>g.promise;const pending=f.live.prepareRuntimeEnvironment();
  if(change==='project')f.b.project.projectId=f.b.session.projectId='p2';
  if(change==='session')f.b.project.sessionId=f.b.session.sessionId='s2';
  if(change==='epoch')f.b.session.controlEpoch++;
  if(change==='generation')f.b.project.capabilities.execution.runtime.configurationGeneration=f.b.project.capabilities.language.configurationGeneration='cfg2';
  if(change==='version')f.b.project.workspaceVersion=f.b.session.workspaceVersion=2;
  if(change==='veto')f.live.triggerVeto();else await f.snapshot();
  const gets=f.calls.filter(c=>c.path==='/api/project').length;g.resolve(prepared());assert.equal(await pending,false);
  assert.equal(f.calls.filter(c=>c.path==='/api/project').length,gets);assert.ok(JSON.parse(f.storage.data.get(storageKey)!).entries.some((e:any)=>e.projectId==='p1'));
});
test('foreign project cannot read old request; return restores unchanged original fence without POST',async t=>{
  const f=await fixture(t);f.post=async()=>{throw Error('lost');};await f.live.prepareRuntimeEnvironment();const original=f.posts()[0].raw;
  f.b.project.projectId=f.b.session.projectId=f.b.project.capabilities.language.projectId='p2';await f.snapshot();
  assert.equal(f.maintenance().uncertain,false);assert.equal(await f.live.prepareRuntimeEnvironment(true),false);assert.equal(f.posts().length,1);
  f.b.project.projectId=f.b.session.projectId=f.b.project.capabilities.language.projectId='p1';await f.snapshot();
  assert.equal(f.maintenance().uncertain,true);f.post=async()=>prepared();await f.live.prepareRuntimeEnvironment(true);assert.equal(f.posts()[1].raw,original);
});
for(const failure of ['write','readback','malformed','foreign-client','other-tab'] as const)test(`storage ${failure} fails closed BEFORE effects, editor still usable`,async t=>{
  const storage=new MemoryStorage();if(failure==='malformed')storage.data.set(storageKey,'broken');
  const f=await fixture(t,{storage});
  if(failure==='write')storage.failSet=true;if(failure==='readback')storage.failReadback=true;
  if(failure==='other-tab')storage.data.set(storageKey,JSON.stringify({version:1,clientId:'c1',entries:[]}));
  if(failure==='foreign-client') {f.live.close();storage.data.set(storageKey,JSON.stringify({version:1,clientId:'foreign',entries:[]}));const foreign=await fixture(t,{storage});assert.equal(await foreign.live.prepareRuntimeEnvironment(),false);assert.equal(foreign.posts().length,0);return;}
  assert.equal(await f.live.prepareRuntimeEnvironment(),false);assert.equal(f.posts().length,0);
  f.live.saveFileContent('main.txt','still editable');assert.equal(f.live.getState().files[0].content,'still editable');
});
for(const gate of ['coach','finished','draft','conflict','activeRun','prepare','veto','unknownSave','offline','sourceRequest'] as const)test(`existing ${gate} authority excludes prepare`,async t=>{
  const f=await fixture(t);
  if(gate==='coach')f.b.session.writeOwner='COACH';if(gate==='finished')f.b.session.lifecycle='FINISHED';
  if(gate==='coach'||gate==='finished')await f.snapshot();
  if(gate==='draft')f.live.saveFileContent('main.txt','a new actual draft');
  if(gate==='conflict')(f.live as any).state.fileConflict={path:'main.txt'};
  if(gate==='activeRun'){(f.b as any).lastRun=run();await f.snapshot();}
  if(gate==='prepare')f.receive('CONTROL_PREPARE',{requestId:'prepare',purpose:'demo',path:'main.txt',basedOnWorkspaceVersion:1});
  if(gate==='veto')f.live.triggerVeto();
  if(gate==='unknownSave'){(f.live as any).runtimeMutations.set('unused',{});(f.live as any).wiring.runtime.unresolved.set('scope',{mutation:{projectId:'p1',sessionId:'s1',clientId:'c1'},inFlight:false});}
  if(gate==='offline')f.live.close();if(gate==='sourceRequest')(f.live as any).sourceRequests=1;
  assert.equal(await f.live.prepareRuntimeEnvironment(),false);assert.equal(f.posts().length,0);
});
test('GET validation/stale binding wins; no overwrite from malformed or stale readiness',async t=>{
  for(const variant of ['malformed','wrongsession','wrongversion','newer-binding']) {
    const f=await fixture(t),before=structuredClone(f.live.getState().runtime!.execution);
    f.get=async()=>{if(variant==='newer-binding'){f.b.session.controlEpoch++;await f.snapshot();return f.b.project;}return variant==='malformed'?{}:{...f.b.project,...(variant==='wrongsession'?{sessionId:'s2'}:{workspaceVersion:0})};};
    assert.equal(await f.live.prepareRuntimeEnvironment(),false);assert.equal(f.maintenance().uncertain,true);assert.deepEqual(f.live.getState().runtime!.execution,before);
  }
});

for(const dropped of [true,false])test(`HUMAN664 controlled server ledger: dropped before admission=${dropped}, SAME explicit original; exactly one first effect`,async t=>{
  const f=await fixture(t),ledger=new Map<string,unknown>();let effects=0,packets=0;
  f.post=async body=>{
    if(++packets===1&&dropped)throw Error('packet never admitted');
    if(!ledger.has(body.requestId)){ledger.set(body.requestId,structuredClone(body));effects++;}
    else assert.deepEqual(ledger.get(body.requestId),body);
    if(packets===1)throw Error('admitted, reply lost');
    return prepared();
  };
  await f.live.prepareRuntimeEnvironment();const original=f.posts()[0].raw;
  assert.equal(effects,dropped?0:1);await f.snapshot();assert.equal(packets,1);
  assert.equal(await f.live.prepareRuntimeEnvironment(),false);assert.equal(packets,1);
  assert.equal(await f.live.prepareRuntimeEnvironment(true),true);assert.equal(f.posts()[1].raw,original);assert.equal(effects,1);
});
test('missing storage rejects only preparation before effects; existing editor and ordinary settings path remain separate',async t=>{
  const f=await fixture(t);(f.live as any).servicePreparation.initialize(undefined,storageKey,'c1');
  assert.equal(await f.live.prepareRuntimeEnvironment(),false);assert.equal(f.posts().length,0);assert.equal(f.maintenance().blocked,false);
  f.live.saveFileContent('main.txt','draft still editable');assert.equal(f.live.getState().files[0].content,'draft still editable');
});
