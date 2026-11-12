/** NEW actual owner/core/FIFO/source/binding/registry calls. Docker/process/OCI preparation
 * are injected UNIT observations from the unchanged fixture, not Docker/LSP/native proof. */
import test from 'node:test';
import type {TestContext} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fixture} from '../runtime-language-binding/fixture';
import {createRuntimeStartup} from '../../src/server/runtime-coordinator/RuntimeStartup';
import {createRuntimeExecutionLayout} from '../../src/server/runtime-coordinator/RuntimeExecutionLayout';
import {RuntimeLanguageOwner} from '../../src/server/runtime-coordinator/RuntimeLanguageOwner';
import type {OpenOrChange,LanguageClientMessage} from '../../src/shared/language-v2';
import * as codec from '../../src/language/uriCodec';

async function until(check:()=>boolean,detail:string) {const end=Date.now()+15000;while(!check()&&Date.now()<end)await new Promise(r=>setTimeout(r,10));assert.ok(check(),detail);}

async function actualOwner(t:TestContext,features:{completion:boolean;diagnostics:boolean},receipt:boolean) {
  let cleanup=async()=>{};t.after(()=>cleanup());
  const f=await fixture(t,'java-maven'),runtime=f.lease().runtime;
  f.driver.beforeCreate=null;
  fs.mkdirSync(path.join(f.workspace,'.paircoach'),{mode:0o700});
  fs.writeFileSync(path.join(f.workspace,'.paircoach','settings.json'),JSON.stringify({schemaVersion:2,taskFilePath:null,taskMode:'IMPLEMENTATION',reviewNotesPath:'review.md',runProfiles:[f.lease().run],aiConsent:false,contextPatterns:[]}));
  fs.writeFileSync(path.join(f.root,'catalog.json'),JSON.stringify({...runtime.catalog,profiles:runtime.catalog.profiles.filter(p=>p.adapterFamily==='java-maven')}));
  fs.writeFileSync(path.join(f.root,'lock.json'),JSON.stringify({schemaVersion:1,images:[...runtime.imageLock.images,...runtime.catalog.profiles.filter(p=>p.adapterFamily==='java-maven'&&p.id!==runtime.profile.id).map(p=>({...runtime.image,key:p.imageLockKey,image:'paircoach/runtime-'+p.id+':stage09',tools:p.expectedTools}))]}));
  fs.writeFileSync(runtime.configPath,JSON.stringify({...runtime.config,languageFeatures:features}));
  const startup=await createRuntimeStartup({argv:['--runtime-config',runtime.configPath,'--prepared-runtime',f.options.selected.preparedOutputRoots[0],...(receipt?['--language-receipt',f.options.selected.languageReceiptPath!]:[])],transport:f.options.selected.transport,environment:{}});
  assert.ok(startup.core);assert.ok(startup.configuration.resolved);
  assert.deepEqual(startup.configuration.resolved.config.languageFeatures,features);
  assert.equal(startup.configuration.resolved.profile.language.provider,'jdt','Real remote profile is NEVER rewritten to off');
  const core=startup.core;core.session.claimLease('tab');
  const layout=createRuntimeExecutionLayout(path.join(f.root,'owner-state'),f.workspace,core.workspace.projectId);
  const events:typeof f.events=[];
  const owner=new RuntimeLanguageOwner({startup,layout,driver:f.driver,transport:f.options.selected.transport,admission:f.admission,assertCurrent(){assert.equal(core.session.state.sessionId,sessionId);}});
  const sessionId=core.session.state.sessionId;
  cleanup=async()=>{f.driver.unreachable=false;await owner.retire();startup.close();};
  await owner.connect({id:'actual-peer',clientId:'tab',connectionGeneration:'actual-connection',assertCurrent(){core.session.assertClient('tab',sessionId);},emit(e){events.push(e);}});
  owner.published();
  const bootstrap=owner.bootstrap(),view=owner.view();
  const document:OpenOrChange={...f.document,content:codec.normalizeContent(f.document.content),stamp:{...f.document.stamp,
    projectId:core.workspace.projectId,sessionId,configurationGeneration:view.configurationGeneration,providerGeneration:view.providerGeneration,
    connectionGeneration:bootstrap?.connectionGeneration??'no-bootstrap',shadowGeneration:bootstrap?.shadowGeneration??'no-bootstrap',
    controlEpoch:core.session.state.controlEpoch,contentSha256:codec.contentSha256(codec.normalizeContent(f.document.content))}};
  const wire=(type:LanguageClientMessage['type'],payload:LanguageClientMessage['payload'],messageId='model'):LanguageClientMessage=>({protocolVersion:'3.0',sessionId,clientId:'tab',messageId,type,payload}) as LanguageClientMessage;
  return {...f,startup,core,owner,events,document,wire};
}

test('OWNER bothfalse retains actual remote identity without receipt; admitted model + authentic ordinary commit publishes once, zero verification/process/evidence',async t=>{
  const f=await actualOwner(t,{completion:false,diagnostics:false},false),{owner,core,document}=f;
  assert.ok(owner.bootstrap(),'Missing receipt MUST NOT disable the actual bothfalse owner');
  assert.equal(owner.bootstrap()!.provider,'remote');
  assert.equal(owner.view().state,'OFF');assert.equal(owner.view().autocomplete,'OFF');assert.equal(owner.view().problem,null);
  await owner.handle('actual-peer',f.wire('LANGUAGE_OPEN',document));
  await assert.rejects(owner.handle('actual-peer',f.wire('LANGUAGE_COMPLETE',{requestId:'disabled',stamp:document.stamp,position:{line:1,column:5},trigger:'.'})));
  let publishes=0,captures=0;
  const saved=await owner.writeWithAck({clientId:'tab',sessionId:core.session.state.sessionId,controlEpoch:core.session.state.controlEpoch,actor:'STUDENT',path:f.path,baseVersion:1,content:document.content},
    {peerId:'actual-peer',transactionMessageId:'save',languageDocumentMessageId:'model',receiptId:'ordinary-receipt'},
    ()=>core.session.assertClient('tab',core.session.state.sessionId),d=>{publishes++;assert.equal(d.version,2);},()=>{captures++;});
  assert.equal(saved.version,2);assert.equal(publishes,1);assert.equal(captures,1);assert.equal(core.workspace.workspaceVersion,1);
  assert.equal(fs.readFileSync(path.join(f.workspace,f.path),'utf8'),document.content);
  await core.workspace._withQueuedMutation(async()=>{});
  assert.equal(owner.view().state,'OFF');assert.equal(owner.view().autocomplete,'OFF');assert.equal(owner.view().problem,null);
  assert.equal(f.calls.length,0,'No selected image/cache/receipt verifier');assert.equal(f.driver.commands.length,0);assert.equal(f.driver.frames.length,0);
  assert.equal(f.events.some(e=>e.type==='DIAGNOSTICS'),false,'No fake successful empty analysis or evidence');
});

for(const features of [{completion:true,diagnostics:false},{completion:false,diagnostics:true}]) {
  const lane=features.completion?'completion':'diagnostics';
  test(`OWNER actual resolved ${lane}-only policy reaches SAME binding/registry; disabled sibling cannot launch`,async t=>{
    const f=await actualOwner(t,features,true);await f.owner.handle('actual-peer',f.wire('LANGUAGE_OPEN',f.document));
    await until(()=>f.driver.frames.some(m=>m.method==='textDocument/didOpen'),'Enabled lane sent actual owner overlay');
    await f.core.workspace._withQueuedMutation(async()=>{});
    assert.deepEqual(f.driver.commands.filter(a=>a[0]==='create').map(a=>a.find(v=>v.startsWith('paircoach.phase='))),['paircoach.phase='+lane]);
    if(features.completion) {
      const result=await f.owner.handle('actual-peer',f.wire('LANGUAGE_COMPLETE',{requestId:'enabled',stamp:f.document.stamp,position:{line:1,column:5},trigger:'.'}));
      assert.ok(result);assert.equal(result.items[0].label,'safeMethod');
      assert.equal(f.owner.view().autocomplete,'ON');assert.equal(f.events.some(e=>e.type==='DIAGNOSTICS'),false);
    } else {
      const before=f.driver.frames.length;
      await assert.rejects(f.owner.handle('actual-peer',f.wire('LANGUAGE_COMPLETE',{requestId:'disabled',stamp:f.document.stamp,position:{line:1,column:5},trigger:'.'})));
      assert.equal(f.driver.frames.length,before,'Disabled explicit completion never requests a list');
      f.driver.diagnostics(f.path);await until(()=>f.events.some(e=>e.type==='DIAGNOSTICS'&&e.result.items.length===1),'Enabled diagnostics publication');
      assert.equal(f.owner.view().autocomplete,'OFF');
    }
    assert.ok(f.calls.length>0,'Enabled remote lane keeps real selected verifier');
  });
  test(`OWNER missing receipt remains fail-closed with ${lane} enabled`,async t=>{
    const f=await actualOwner(t,features,false);
    assert.equal(f.owner.bootstrap(),null);assert.equal(f.owner.view().state,'FAILED');assert.equal(f.owner.view().problem?.code,'LANGUAGE_RECEIPT_REQUIRED');
    assert.equal(f.calls.length,0);assert.equal(f.driver.commands.length,0);assert.equal(f.driver.frames.length,0);
  });
}
