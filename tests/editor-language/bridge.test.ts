import test from 'node:test';
import assert from 'node:assert/strict';
import { harness,Model } from './harness';
import { result } from './fixtures';
import type { DiagnosticsResult } from '../../src/shared/language-v2';
const diag=(h:ReturnType<typeof harness>):DiagnosticsResult=>({sourceStamp:structuredClone(h.bridge.acceptance.current().stamp),presentationStamp:structuredClone(h.bridge.acceptance.current().stamp),association:null,provenance:{kind:'IMMUTABLE_GENERATION',launchId:'launch',lspVersion:null,inputManifestSha256:'a'.repeat(64)},items:[{range:{startLine:1,startColumn:1,endLine:1,endColumn:4},severity:'WARNING',message:'raw warning',code:null}],truncated:false});
const shown=(h:ReturnType<typeof harness>)=>h.widgets[0].getDomNode().children;
test('all active AND inactive model mutations sync actual post-mutation bytes before ACK without a second save',()=>{
  const h=harness();assert.equal(h.sync.length,2);
  h.inactive.change('unsaved\r\n😀');assert.equal(h.sync.at(-1).document.content,'unsaved\n😀');assert.equal(h.sync.at(-1).document.stamp.documentVersion,null);
  assert.equal(h.sync.at(-1).document.reason,'TYPING');assert.equal(h.sync.at(-1).document.stamp.localModelVersion,2);
  h.bridge.withMutationReason(h.primary as any,'COACH_STEP_EDIT',()=>h.primary.change('coach'));
  assert.equal(h.sync.at(-1).document.reason,'COACH_STEP_EDIT');h.primary.change('undo',{isUndoing:true});assert.equal(h.sync.at(-1).document.reason,'UNDO');
  h.bridge.withMutationReason(h.inactive as any,'RESTORE_SNAPSHOT',()=>h.inactive.change('restored'));assert.equal(h.sync.at(-1).document.reason,'RESTORE_SNAPSHOT');
  h.bridge.dispose();assert.equal(h.primary.event.callbacks.size,0);assert.equal(h.inactive.event.callbacks.size,0);
});
test('actual bridge public facade push is one undo unit; ordinary model observer sees one completion change',async()=>{
  const h=harness();await h.bridge.requestCompletion('.');assert.equal(shown(h).length,1);
  const before=h.sync.length;h.key(3);assert.equal(h.primary.content,'obj.method()');assert.equal(h.primary.pushes,1);assert.equal(h.primary.boundaries,2);
  assert.equal(h.sync.length,before+1);assert.equal(h.sync.at(-1).document.reason,'COMPLETION');
  h.primary.undo();assert.equal(h.primary.content,'obj.');assert.equal(h.sync.at(-1).document.reason,'UNDO');h.bridge.dispose();
});
test('CONTROL_PREPARE first hides/cancels before await; denied prepare still invalidates old candidates',async()=>{
  const h=harness();await h.bridge.requestCompletion(null);const old=shown(h)[0];assert.ok(old);
  h.emit({type:'CONTROL_PREPARE'});assert.equal(shown(h).length,0);h.key(3);old.onmousedown({preventDefault(){}});assert.equal(h.primary.pushes,0);
  // A stale authority render cannot release prepare; a newer authoritative denial can allow only a fresh request.
  h.emit({type:'AUTHORITY_CHANGED'});await h.bridge.requestCompletion(null);assert.equal(shown(h).length,0);
  h.revision++;h.emit({type:'AUTHORITY_CHANGED'});await h.bridge.requestCompletion(null);assert.equal(shown(h).length,1);
  old.onmousedown({preventDefault(){}});assert.equal(h.primary.pushes,0);h.bridge.dispose();
});
test('late response cannot reopen after prepare/Veto/offline/model switch even when cancellation is ignored',async()=>{
  for(const event of ['CONTROL_PREPARE','VETO','DISCONNECTED','SCOPE'] as const){
    const h=harness();let resolve!:(v:any)=>void;h.complete=()=>new Promise(r=>resolve=r);
    const pending=h.bridge.requestCompletion(null);assert.equal(h.requests.length,1);h.emit({type:event});
    assert.equal(h.cancelled.length,1);resolve(result(h.requests[0].stamp,h.requests[0].requestId));await pending;
    assert.equal(shown(h).length,0);assert.equal(h.primary.pushes,0,event);h.bridge.dispose();
  }
  const h=harness();let resolve!:(v:any)=>void;h.complete=()=>new Promise(r=>resolve=r);const pending=h.bridge.requestCompletion(null);h.switch(h.inactive);resolve(result(h.requests[0].stamp,h.requests[0].requestId));await pending;assert.equal(shown(h).length,0);h.bridge.dispose();
});
test('coalesced queued typing request never rebinds to a new control scope or unchanged denied prepare',async()=>{
  const h=harness();h.primary.change('obj.');h.emit({type:'CONTROL_PREPARE'});h.revision++;h.emit({type:'AUTHORITY_CHANGED'});await Promise.resolve();assert.equal(h.requests.length,0);h.bridge.dispose();
});
test('ACK-only does not write/change/restart; source remains immutable and old queued presentation drops',()=>{
  const h=harness(),old=diag(h);h.emit({type:'DIAGNOSTICS',result:old});assert.equal(h.markers.get(h.primary)?.length,1);
  const sync=h.sync.length,version=h.primary.version;h.authorityStamp={...h.authorityStamp,baseDocumentVersion:3,documentVersion:3};h.revision++;h.emit({type:'AUTHORITY_CHANGED'});
  assert.equal(h.sync.length,sync);assert.equal(h.primary.version,version);h.emit({type:'DIAGNOSTICS',result:old});assert.equal(h.markers.get(h.primary)?.length,0);
  const alias={...old,presentationStamp:{...old.presentationStamp,baseDocumentVersion:3,documentVersion:3},association:{saveReceiptId:'receipt'}};
  h.verify=r=>r.association?.saveReceiptId==='receipt' && r.sourceStamp.baseDocumentVersion===2;
  h.emit({type:'DIAGNOSTICS',result:alias});assert.equal(h.markers.get(h.primary)?.length,1);assert.equal(alias.sourceStamp.baseDocumentVersion,2);h.bridge.dispose();
});
test('association field alone grants nothing; raw severity preserved; any project mutation immediately clears ALL markers',()=>{
  const h=harness(),r=diag(h);h.verify=()=>false;h.emit({type:'DIAGNOSTICS',result:r});assert.equal(h.markers.get(h.primary)?.length,undefined);
  h.verify=()=>true;h.emit({type:'DIAGNOSTICS',result:r});assert.equal(h.markers.get(h.primary)?.[0].severity,4);
  h.inactive.change('dependency changed');assert.equal(h.markers.get(h.primary)?.length,0);
  h.verify=(_r,models)=>models.find(m=>m.path==='other.ts')?.content==='other';h.emit({type:'DIAGNOSTICS',result:r});assert.equal(h.markers.get(h.primary)?.length,0);h.bridge.dispose();
});
test('authorized rename/delete retires old URI lifetime but preserves draft bytes and rejects its late acceptance',async()=>{
  const h=harness();await h.bridge.requestCompletion(null);const old=shown(h)[0];h.emit({type:'FILE_OPERATION',operation:'RENAME',path:h.primary.path,newPath:'renamed.ts'});
  old.onmousedown({preventDefault(){}});assert.equal(h.primary.content,'obj.');assert.equal(h.primary.pushes,0);assert.equal(h.sync.at(-1).kind,'CLOSE');
  const next=new Model('renamed.ts','obj.');h.add(next);h.switch(next);assert.notEqual(h.bridge.acceptance.current().stamp.modelLifetime,h.requests[0].stamp.modelLifetime);
  assert.equal(h.bridge.getModelSnapshots().some(m=>m.path===h.primary.path),false);h.bridge.dispose();
});
test('reconnect sends only current OPEN buffers in new scope, never replaying mutations or saving them',()=>{
  const h=harness();h.emit({type:'DISCONNECTED'});h.flags.connected=false;h.primary.change('offline draft');const count=h.sync.length;
  h.flags.connected=true;h.authorityStamp={...h.authorityStamp,connectionGeneration:'new-connection'};h.revision++;h.emit({type:'AUTHORITY_CHANGED'});
  assert.equal(h.sync.length,count+2);assert.equal(h.sync.at(-2).kind,'OPEN');assert.equal(h.sync.at(-2).document.content,'offline draft');assert.equal(h.sync.at(-2).document.stamp.connectionGeneration,'new-connection');h.bridge.dispose();
});
test('native completion routes remain fail-closed, Escape preserves global Veto route',async()=>{
  const h=harness();assert.equal(h.editor.options.acceptSuggestionOnEnter,'off');assert.equal(h.editor.options.inlineSuggest.enabled,false);
  assert.equal(h.editor.options.snippetSuggestions,'none');assert.ok(Object.entries(h.editor.options.suggest).filter(([k])=>k.startsWith('show')).every(([,v])=>v===false));
  await h.bridge.requestCompletion(null);h.key(9);assert.equal(shown(h).length,0);assert.equal(h.primary.pushes,0);h.bridge.dispose();
});
test('injected builtin completion cannot bypass the very same acceptance-time student gate',async()=>{
  const h=harness();h.binding.builtin=async(_model,r)=>result(r.stamp,r.requestId);
  await h.bridge.requestCompletion('.');assert.equal(h.requests.length,0);assert.equal(shown(h).length,1);
  h.flags.writeOwner='COACH';h.key(2);assert.equal(h.primary.pushes,0);h.bridge.dispose();
});
test('current safe reply after bytes changed without new request is not rebound',async()=>{
  const h=harness();let resolve!:(v:any)=>void;h.complete=()=>new Promise(r=>resolve=r);
  const pending=h.bridge.requestCompletion('.');const captured=structuredClone(h.requests[0]);
  h.bridge.withMutationReason(h.primary as any,'EXTERNAL_FILE_SYNC',()=>h.primary.change('external'));
  resolve(result(captured.stamp,captured.requestId));await pending;
  assert.equal(shown(h).length,0);assert.equal(h.primary.pushes,0);h.bridge.dispose();
});
test('scope reconnect cannot reopen while authority revision is old; malformed marker range is not clamped',()=>{
  const h=harness();h.emit({type:'SCOPE'});const count=h.sync.length;h.emit({type:'AUTHORITY_CHANGED'});assert.equal(h.sync.length,count);
  h.revision++;h.emit({type:'AUTHORITY_CHANGED'});assert.equal(h.sync.length,count+2);
  const r=diag(h);r.items[0].range.endColumn=999;h.emit({type:'DIAGNOSTICS',result:r});assert.equal(h.markers.get(h.primary)?.length,0);h.bridge.dispose();
});
test('public content observation triggers completion at post-type cursor, never at a rebound cursor',async()=>{
  const h=harness();h.primary.change('obj.');await Promise.resolve();await Promise.resolve();assert.equal(h.requests.length,1);assert.equal(h.requests[0].trigger,'.');assert.equal(shown(h).length,1);h.bridge.dispose();
  const moved=harness();moved.primary.change('obj.');moved.position={lineNumber:1,column:2};await Promise.resolve();assert.equal(moved.requests.length,0);moved.bridge.dispose();
});
