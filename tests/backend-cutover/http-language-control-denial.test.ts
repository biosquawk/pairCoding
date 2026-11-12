/** NEW actual HTTP/WS caller proof. Real CoachAdapter, control messages, kernel/gate,
 * source, owner, registry and journal; ONLY provider decision and Docker/OCI/process I/O
 * are synthetic. No real model, Docker or native-runtime availability claim. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {httpLanguage,until} from './http-language-owner-fixture';
import {validateV2WireShape} from '../../src/shared/validation-v2';

test('HTTP LANG CONTROL_PREPARE revokes synchronously, starts no replacement before CONTROL_STATE; denial bootstraps without another model event',async t=>{
  let decisions=0;
  const f=await httpLanguage(t,true,{name:'UNIT_CONTROL_DENIAL',mode:'INJECTED',async decide(c){
    decisions++;
    if(c.trigger?.reason!=='CHAT')return {kind:'SILENT',reason:'Only the explicit test chat requests control'};
    const document=c.documents.find(d=>d.path.endsWith('.java'));assert.ok(document,'Real provider context includes the writable Java original, not the default non-code active file');
    return {kind:'EDIT',purpose:'UNIT denied demonstration',path:document.path,documentVersion:document.version,
      workspaceVersion:c.workspaceVersion,steps:[{range:{startLine:1,startColumn:1,endLine:1,endColumn:1},textBlock:'denied edit'}]};
  }}),p=f.peer;
  // Isolate this control-denial case from startup capture: observe real protocol readiness
  // and pass the real FIFO; no fabricated readiness, timeout extension or sleep.
  await until(()=>f.driver.frames.filter(m=>m.method==='initialized').length>=2,'Initial HTTP owner actually initialized both language processes');
  await f.app.workspace._withQueuedMutation(async()=>{});
  const started=await f.http('/api/session/start','POST',{requestId:crypto.randomUUID(),clientId:f.clientId,sessionId:f.sessionId,limitMs:null,pauseOnHidden:true});
  assert.equal(started.status,200,JSON.stringify(started.value));
  await p.wait(m=>m.type==='CONTROL_STATE'); // Let the real START/SILENT coordinator finish first.
  const d=f.document(p),epoch=f.app.session.state.controlEpoch,workspaceVersion=f.app.workspace.workspaceVersion;
  const before=fs.readFileSync(path.join(f.workspace,f.path),'utf8');
  p.send('LANGUAGE_OPEN',d);
  await until(()=>f.driver.frames.filter(m=>m.method==='textDocument/didOpen').length>=2,'Both genuine HTTP language lanes opened A');
  f.driver.diagnostics(f.path);
  const original=await p.wait(m=>m.type==='DIAGNOSTICS'&&m.payload.items.length===1);
  const creates=f.driver.commands.filter(a=>a[0]==='create').length;
  const chat=p.send('CHAT_MESSAGE',{text:'Please demonstrate the edit',path:null,documentVersion:null,selection:null});
  const ack=await p.wait(m=>m.type==='ACK'&&m.payload.replyTo===chat);assert.equal(ack.payload.status,'OK');
  const prepare=await p.wait(m=>m.type==='CONTROL_PREPARE'||m.type==='ERROR');
  assert.equal(prepare.type,'CONTROL_PREPARE',JSON.stringify(prepare));
  const cleared=p.frames.find(m=>m.type==='DIAGNOSTICS'&&m.seq>original.seq&&m.payload.items.length===0);
  assert.ok(cleared,'Actual old decorations were cleared');
  assert.ok(cleared.seq<prepare.seq,'Synchronous revoke emits invalidation BEFORE the actual CONTROL_PREPARE broadcast');
  assert.equal(f.app.session.state.controlEpoch,epoch,'Prepare has not acquired control');
  assert.equal(f.app.session.state.writeOwner,'STUDENT');
  await until(()=>f.driver.containers.size===0,'Exact old process owners retired while actual CONTROL_READY remains pending');
  const stale=p.send('LANGUAGE_COMPLETE',{requestId:'denied-old-owner',stamp:d.stamp,position:{line:1,column:5},trigger:'.'});
  const rejected=await p.wait(m=>m.type==='ACK'&&m.payload.replyTo===stale);
  assert.equal(rejected.payload.status,'REJECTED');assert.equal(rejected.payload.error.code,'LANGUAGE_OWNER_REQUIRED');
  const project=await f.http('/api/project');assert.equal(project.status,200);
  assert.equal(f.driver.commands.filter(a=>a[0]==='create').length,creates,'No replacement during the pending prepare, including after exact old owners finish');
  assert.equal(p.frames.some(m=>m.type==='CONTROL_STATE'&&m.seq>prepare.seq),false,'Assertions occurred before release, not after the one-second timeout');
  assert.equal(p.frames.some(m=>m.type==='SESSION_SNAPSHOT'&&m.seq>prepare.seq&&m.payload.languageBootstrap),false);
  const deny=p.send('CONTROL_READY',{requestId:prepare.payload.requestId,workspaceVersion:prepare.payload.basedOnWorkspaceVersion,ready:false});
  const denied=await p.wait(m=>m.type==='ACK'&&m.payload.replyTo===deny);assert.equal(denied.payload.status,'OK');
  const released=await p.wait(m=>m.type==='CONTROL_STATE'&&m.seq>prepare.seq);
  assert.equal(released.payload.writeOwner,'STUDENT');assert.equal(released.payload.controlEpoch,epoch);
  const fresh=await p.wait(m=>m.type==='SESSION_SNAPSHOT'&&m.seq>released.seq&&m.payload.languageBootstrap&&
    m.payload.languageBootstrap.shadowGeneration!==p.snapshot.payload.languageBootstrap.shadowGeneration);
  assert.ok(validateV2WireShape('ServerMessage',fresh));
  assert.notEqual(fresh.payload.project.capabilities.language.providerGeneration,p.snapshot.payload.project.capabilities.language.providerGeneration);
  assert.equal(fresh.payload.languageBootstrap.connectionGeneration,p.snapshot.payload.languageBootstrap.connectionGeneration,'Same authenticated peer, no reconnect');
  assert.equal(fresh.payload.session.controlEpoch,epoch,'Explicit denial requires fresh bootstrap even with unchanged epoch');
  assert.equal(fresh.payload.project.capabilities.language.problem,null);
  assert.notEqual(fresh.payload.project.capabilities.language.state,'FAILED');
  assert.equal(p.frames.some(m=>m.type==='COACH_STEP_EDIT'||m.type==='ERROR'&&m.payload.code==='COACH_READY_TIMEOUT'),false);
  assert.equal(p.frames.some(m=>m.seq>prepare.seq&&(m.type==='COMPLETE_RESULT'||m.type==='DIAGNOSTICS'&&m.payload.items.length>0)),false,'No stale result survives denial');
  assert.equal(f.app.workspace.workspaceVersion,workspaceVersion);assert.equal(fs.readFileSync(path.join(f.workspace,f.path),'utf8'),before,'Denied coach never writes originals');
  assert.equal(f.driver.frames.filter(m=>m.method==='textDocument/didOpen').length,2,'No synthetic/new model open was used to obtain the bootstrap');
  assert.equal(decisions,2,'Only the genuine START and explicit CHAT provider calls');
});
