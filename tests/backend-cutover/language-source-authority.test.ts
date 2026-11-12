/** Actual canonical workspace/kernel FIFO + accepted full scanner and central codec.
 * No provider/Docker/preparation/HTTP or overall language readiness claim. */
import test, {type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {RuntimeLanguageSource} from '../../src/server/runtime-coordinator/RuntimeLanguageSource';
import {createRuntimeWorkspace} from '../../src/server/runtime-coordinator/RuntimeWorkspace';
import {loadRuntimeConfiguration} from '../../src/server/runtime-config';
import * as codec from '../../src/language/uriCodec';
import type {LanguageProjectScope} from '../../src/server/language/ports';
import type {LanguageClientMessage,OpenOrChange} from '../../src/shared/language-v2';
import type {SelectedLanguageLease} from '../../src/server/language/SelectedCacheLanguageAuthority';
const barrier=()=>{let resolve!:()=>void;const promise=new Promise<void>(r=>resolve=r);return {promise,resolve};};
async function fixture(t:TestContext) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'language-source-authority-')),workspace=path.join(root,'workspace'),owned=path.join(root,'language');
  fs.mkdirSync(workspace);fs.mkdirSync(owned,{mode:0o700});fs.mkdirSync(path.join(workspace,'.paircoach'),{mode:0o700});
  fs.writeFileSync(path.join(workspace,'Main.java'),'class Main {}\n');fs.writeFileSync(path.join(workspace,'Other.java'),'class Other {}\n');fs.writeFileSync(path.join(workspace,'pom.xml'),'<project/>');
  fs.writeFileSync(path.join(workspace,'.paircoach','settings.json'),JSON.stringify({schemaVersion:2,taskFilePath:null,taskMode:'IMPLEMENTATION',reviewNotesPath:'review.md',runProfiles:[{kind:'RUN_MAIN',task:{workingDirectory:'.',entry:{kind:'JAVA_MAIN',className:'Main'},tests:{paths:[],names:[]}},timeoutMs:30000}],aiConsent:false,contextPatterns:[]}));
  const catalog=path.join(root,'catalog.json'),lock=path.join(root,'images.json'),config=path.join(root,'runtime.json');
  const approved=JSON.parse(fs.readFileSync(path.resolve('runtimes/catalog.json'),'utf8')).profiles.find((p:{id:string})=>p.id==='java-maven-21');
  fs.writeFileSync(catalog,JSON.stringify({schemaVersion:1,profiles:[approved]}));
  fs.writeFileSync(lock,JSON.stringify({schemaVersion:1,images:[{key:approved.imageLockKey,image:'paircoach/run:unit',imageId:'sha256:'+'1'.repeat(64),digest:'sha256:'+'2'.repeat(64),tools:approved.expectedTools},{key:approved.language.imageLockKey,image:'paircoach/language:unit',imageId:'sha256:'+'3'.repeat(64),digest:'sha256:'+'4'.repeat(64),tools:[{name:'java',version:approved.language.serverJvm}]}]}));
  fs.writeFileSync(config,JSON.stringify({schemaVersion:1,activeProfile:'java-maven-21',workspaceRoot:workspace,runtimeCatalog:catalog,imageLock:lock,languageFeatures:{completion:true,diagnostics:true},execution:{backend:'docker',pullPolicy:'never'}}));
  const configuration=loadRuntimeConfiguration({configPath:config,environment:{}});assert.ok(configuration.resolved,JSON.stringify(configuration));const runtime=configuration.resolved;
  const core=await createRuntimeWorkspace({rootPath:workspace});core.session.claimLease('tab');
  t.after(()=>{core.close();fs.rmSync(root,{recursive:true,force:true});});
  const scope:LanguageProjectScope={projectId:core.workspace.projectId,sessionId:core.session.state.sessionId,profile:runtime.profile,configurationGeneration:runtime.configurationGeneration,connectionGeneration:'connection',providerGeneration:'provider',shadowGeneration:'shadow',shadowDirectory:owned};
  let current=true,peer=true;
  const source=new RuntimeLanguageSource({core,runtime,scope,installationId:'installation',assertCurrent(){if(!current)throw Error('binding revoked');},assertPeer(p,m){if(!peer || p!=='transport' || m.clientId!=='tab')throw Error('peer revoked');}});
  const document=(p='Main.java',content='class Main { int draft; }\n',version=2):OpenOrChange=>({stamp:{projectId:scope.projectId,sessionId:scope.sessionId,profileId:scope.profile.id,path:p,configurationGeneration:scope.configurationGeneration,connectionGeneration:scope.connectionGeneration,providerGeneration:scope.providerGeneration,shadowGeneration:scope.shadowGeneration,modelLifetime:'model-'+p,localModelVersion:version,baseDocumentVersion:1,documentVersion:null,contentSha256:codec.contentSha256(content),controlEpoch:core.session.state.controlEpoch,requestGeneration:version},content,reason:'OPEN'});
  const wire=(id:string,d:OpenOrChange,type:'LANGUAGE_OPEN'|'LANGUAGE_CHANGE'='LANGUAGE_OPEN'):LanguageClientMessage=>({protocolVersion:'3.0',messageId:id,sessionId:scope.sessionId,clientId:'tab',type,payload:type==='LANGUAGE_CHANGE'?{...d,reason:'TYPING'}:d});
  return {root,workspace,core,scope,source,document,wire,revoke(){current=false;},revokePeer(){peer=false;}};
}
test('SOURCE actual immutable ALL-overlay authority includes inactive draft and source, uses real monotonic identities, rejects caller mutation and stale copies',async t=>{
  const f=await fixture(t),a=f.document(),b=f.document('Other.java','class Other { int inactive; }\n');
  const original=f.wire('a',a),pending=f.source.admit('transport',original);a.content='CALLER MUTATED';await pending;
  await f.source.admit('transport',f.wire('b',b));const before=f.source.capture(f.scope);
  assert.equal(before.documents.length,2);assert.equal(before.documents[0].content,'class Main { int draft; }\n');assert.equal(before.documents[1].content,b.content);
  assert.ok(Object.isFrozen(before.documents[0].stamp));assert.equal(f.source.isCurrent(f.scope,structuredClone(before)),true);
  await f.source.admit('transport',f.wire('b2',f.document('Other.java',b.content,3),'LANGUAGE_CHANGE'));
  assert.equal(f.source.isCurrent(f.scope,before),false);const after=f.source.capture(f.scope);assert.notEqual(after.revision,before.revision);
  assert.equal(after.documents[1].stamp.localModelVersion,3);assert.equal(f.source.readCurrent('foreign','Main.java'),null);
});
test('SOURCE actual selected lease holds SAME root FIFO across await/copy/transfer, releases before process phase and revokes on inactive overlay',async t=>{
  const f=await fixture(t);await f.source.admit('transport',f.wire('a',f.document()));const snapshot=f.source.capture(f.scope),entered=barrier(),resume=barrier();let retained!:SelectedLanguageLease,settled=false;
  const operation=f.source.withSourceLease(f.scope,snapshot,async token=>{retained=token;assert.equal(token.source.leaseId,snapshot.revision);assert.equal(token.source.projectRoot,f.workspace);assert.equal(token.source.overlays.length,1);token.assertCurrent();entered.resolve();await resume.promise;token.assertCurrent();assert.ok(token.source.files.some(x=>x.path==='Other.java'));});
  await entered.promise;const queued=f.source.admit('transport',f.wire('b',f.document('Other.java','class Other { int inactive; }\n'))).then(()=>{settled=true;});
  await new Promise<void>(r=>setImmediate(r));assert.equal(settled,false);
  assert.throws(()=>f.core.gate.write({clientId:'tab',sessionId:f.scope.sessionId,controlEpoch:0,actor:'STUDENT',path:'Main.java',baseVersion:1,content:'LEAPFROG'}),{code:'WORKSPACE_BUSY'});
  resume.resolve();await operation;assert.throws(()=>retained.assertCurrent(),{code:'LANGUAGE_LEASE_RELEASED'});await queued;assert.throws(()=>retained.assertRetainedCurrent());
});
test('SOURCE unchanged retained full token remains current after successful release, not a copy lease',async t=>{
  const f=await fixture(t);await f.source.admit('transport',f.wire('a',f.document()));let retained!:SelectedLanguageLease;
  await f.source.withSourceLease(f.scope,f.source.capture(f.scope),async token=>{retained=token;});
  retained.assertRetainedCurrent();assert.throws(()=>retained.assertCurrent(),{code:'LANGUAGE_LEASE_RELEASED'});
  fs.writeFileSync(path.join(f.workspace,'Other.java'),'class Other { int external; }\n');assert.throws(()=>retained.assertRetainedCurrent());
});
test('SOURCE scanner detects actual external inactive source and empty directory without waiting for watchers, no old-vector resurrection after observed ABA',async t=>{
  const f=await fixture(t);const before=f.source.capture(f.scope);fs.mkdirSync(path.join(f.workspace,'new-empty'));
  assert.equal(f.source.isCurrent(f.scope,before),false);const during=f.source.capture(f.scope);assert.notEqual(during.revision,before.revision);
  fs.rmdirSync(path.join(f.workspace,'new-empty'));const after=f.source.capture(f.scope);assert.notEqual(after.revision,before.revision);assert.equal(f.source.isCurrent(f.scope,before),false);
});
test('SOURCE foreign scope/peer, bad hash, stale base and nonadvancing model/request never pollute admitted capture',async t=>{
  const f=await fixture(t),original=f.document();await f.source.admit('transport',f.wire('a',original));const snapshot=f.source.capture(f.scope);
  const foreign=f.document('Other.java');foreign.stamp.connectionGeneration='foreign';await assert.rejects(f.source.admit('transport',f.wire('foreign',foreign)));
  const bad=f.document('Other.java');bad.stamp.contentSha256='0'.repeat(64);await assert.rejects(f.source.admit('transport',f.wire('bad',bad)));
  const stale=f.document('Other.java');stale.stamp.baseDocumentVersion=9;await assert.rejects(f.source.admit('transport',f.wire('stale',stale)));
  await assert.rejects(f.source.admit('foreign',f.wire('peer',f.document('Other.java'))));
  await assert.rejects(f.source.admit('transport',f.wire('same-version',original,'LANGUAGE_CHANGE')));
  assert.equal(f.source.isCurrent(f.scope,snapshot),true);assert.equal(f.source.capture(f.scope).documents.length,1);
});
test('SOURCE delayed selected prepare refuses real Veto/control revocation and raw dependency mutation, never dispatches',async t=>{
  const f=await fixture(t);await f.source.admit('transport',f.wire('a',f.document()));const entered=barrier(),resume=barrier();let dispatch=false;
  const operation=f.source.withSourceLease(f.scope,f.source.capture(f.scope),async token=>{entered.resolve();await resume.promise;token.assertCurrent();dispatch=true;});
  await entered.promise;f.core.session.releaseLease('tab');resume.resolve();await assert.rejects(operation);assert.equal(dispatch,false);
});
test('SOURCE failed preparation token cannot remain retained; source CLOSE invalidates exact correlation',async t=>{
  const f=await fixture(t),d=f.document();await f.source.admit('transport',f.wire('a',d));let retained!:SelectedLanguageLease;
  await assert.rejects(f.source.withSourceLease(f.scope,f.source.capture(f.scope),async token=>{retained=token;throw Error('preparation failed');}),/preparation failed/);
  assert.throws(()=>retained.assertRetainedCurrent(),{code:'LANGUAGE_LEASE_RELEASED'});
  await f.source.admit('transport',{protocolVersion:'3.0',messageId:'close',clientId:'tab',sessionId:f.scope.sessionId,type:'LANGUAGE_CLOSE',payload:{stamp:d.stamp}});
  assert.equal(f.source.capture(f.scope).documents.length,0);assert.equal(f.source.readCurrent('transport','Main.java'),null);
});

test('SOURCE raw dependency mutation while FIFO is held revokes full token before copy/owner transfer',async t=>{
  const f=await fixture(t),snapshot=f.source.capture(f.scope);let copied=false;
  await assert.rejects(f.source.withSourceLease(f.scope,snapshot,async token=>{
    fs.writeFileSync(path.join(f.workspace,'pom.xml'),'<project><changed/></project>');token.assertCurrent();copied=true;
  }));assert.equal(copied,false);assert.equal(f.source.isCurrent(f.scope,snapshot),false);
});
