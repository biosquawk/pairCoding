/** Actual Registry -> SelectedCache authority/resolver -> ProductionFactory -> Store/native FS.
 * ONLY OCI receipts/info/inspect and process.start/provider transport are controlled fixtures.
 * Not actual RuntimeLanguageSource/WriteGate, Docker, Windows or performance evidence. */
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import { fixture } from './selected-fixture';
import { observe, treeWitness, fds } from './store-fixture';
import { LanguageFeatureRegistry, type RegistryLaunch, type RegistrySnapshot, type RegistryCaptureOperationHint } from '../../src/server/language/LanguageFeatureRegistry';
import { LanguageAckLedger } from '../../src/server/language/LanguageAckLedger';
import { JsonRpcTransport } from '../../src/server/language/JsonRpcTransport';
import { LanguageShadowStore } from '../../src/server/language/LanguageShadowStore';
import type { LanguageServerSession } from '../../src/server/language/LanguageServerSession';
import * as codec from '../../src/language/uriCodec';
import type { LanguageProjectScope } from '../../src/server/language/ports';
function meter(t:TestContext,f:Awaited<ReturnType<typeof fixture>>) {
 const counts={capture:0,current:0,held:0};
 for(const [method,key] of [['capture','capture'],['isCurrent','current'],['assertCopyLease','held']] as const){const native=f.authority[method].bind(f.authority) as (...a:any[])=>any;(f.authority as any)[method]=(...a:any[])=>{counts[key]++;return native(...a);};t.after(()=>{(f.authority as any)[method]=native;});}
 return counts;
}
async function composition(t:TestContext, diagnostics=false) {
 const f=await fixture(t),counts=meter(t,f),hints:RegistryCaptureOperationHint[]=[],launches:RegistryLaunch[]=[],frames:any[]=[],effects:string[]=[];
 let refreshes=0,starts=0;let race:((phase:string,path:string)=>void)|null=null;const workers=observe(t,f,(phase,path)=>{if(phase==='dispatch'||phase==='result'||phase==='exit'){assert.ok(f.held(),'SAME FIFO held for entire native pool including exits');}race?.(phase,path);});
 const nativeCreate=f.factory.create.bind(f.factory),nativeRefresh=f.factory.refreshCompletion.bind(f.factory),nativeLease=f.factory.withCaptureLease.bind(f.factory);
 let registry!:LanguageFeatureRegistry;
 f.factory.create=(...args)=>{f.lease.assertCurrent();workers.drained();effects.push('create');const launch=nativeCreate(...args);launches.push(launch);
  const session=launch.session as LanguageServerSession,process=(session as unknown as {options:{process:{start:()=>Promise<JsonRpcTransport>}}}).options.process;
  process.start=async()=>{starts++;effects.push('start');assert.ok(!f.held(),'provider start only AFTER FIFO action/release');assert.ok([(registry as any).completion,(registry as any).diagnostics].some(l=>l.active?.launch.session===session),'actual registry owns session BEFORE start');
   const input=new PassThrough(),output=new Writable({write(chunk,_encoding,callback){const message=JSON.parse(Buffer.from(chunk).toString().split('\r\n\r\n')[1]);frames.push(message);effects.push(message.method??'response');
    if(message.id){const result=message.method==='initialize'?{capabilities:{completionProvider:{},textDocumentSync:{openClose:true,change:1},positionEncoding:'utf-16'}}:[];const body=Buffer.from(JSON.stringify({jsonrpc:'2.0',id:message.id,result}));queueMicrotask(()=>input.write(Buffer.concat([Buffer.from('Content-Length: '+body.length+'\r\n\r\n'),body])));}callback();}});
   return new JsonRpcTransport(input,output,{connectionId:'fixture-'+launches.length});};return launch;};
 f.factory.refreshCompletion=(...args)=>{f.lease.assertCurrent();workers.drained();effects.push('refresh');refreshes++;return nativeRefresh(...args);};
 f.factory.withCaptureLease=(scope,snapshot,action,operation)=>{if(operation)hints.push(operation);return nativeLease(scope,snapshot,()=>{workers.drained();f.lease.assertCurrent();effects.push('action');action();},operation);};
 const timers=new Map<object,()=>void>();
 registry=new LanguageFeatureRegistry({factory:f.factory,ackLedger:new LanguageAckLedger({readCurrent:()=>null,readAnalysisSource:()=>null,readCommittedSave:()=>null},codec),authority:{capture:()=>structuredClone(f.snapshot),isCurrent:(_scope,s)=>JSON.stringify(s)===JSON.stringify(f.snapshot)},languageFeatures:{completion:true,diagnostics},clock:{set(_ms,cb){const token={};timers.set(token,cb);return token;},clear(token){timers.delete(token as object);}}});
 const settled=async()=>{const lane=(registry as any).completion;await lane.pumping;};
 const start=async()=>{await registry.startProject(f.scope);await settled();assert.equal(launches.length,1);assert.equal(starts,1);assert.equal((registry as any).completion.active.opened,true);};
 t.after(async()=>{await registry.disposeProject(f.scope);});
 return {f,counts,workers,registry,hints,frames,effects,launches,start,settled,fireDiagnostics:async()=>{for(const [token,cb] of [...timers]){timers.delete(token);cb();}await (registry as any).diagnostics.pumping;},refreshes:()=>refreshes,starts:()=>starts,race:(hook:typeof race)=>{race=hook;}};
}
test('actual registry CREATE -> ordinary overlay REFRESH uses one selected capture per action, bounded native bytes, SAME FIFO and stable dependency/root witnesses',async t=>{
 const c=await composition(t),{f}=c;await c.start();const first=c.launches[0],session=first.session as LanguageServerSession,ws=(session as unknown as {shadow:{workspaceDirectory:string}}).shadow.workspaceDirectory;
 const original={source:treeWitness(f.workspace),cache:treeWitness(f.cache)},deps=treeWitness(join(ws,'.paircoach-dependencies')),root=fs.statSync(ws,{bigint:true});
 const createCounts={...c.counts};assert.equal(createCounts.capture,1,'no second nested capture in CREATE action');const workerBefore=c.workers.created();
 const changed=f.update('ordinary new draft\n');await c.registry.change(changed);await c.settled();c.workers.drained();
 assert.equal(c.refreshes(),1);assert.equal(c.launches.length,1);assert.equal(c.starts(),1);assert.ok(c.workers.created()>workerBefore,'REFRESH really reads with native bounded workers');
 assert.equal(c.counts.capture-createCounts.capture,1,'no second nested capture in REFRESH action');
 assert.deepEqual(c.hints,[{kind:'CREATE',phase:'completion'},{kind:'REFRESH',phase:'completion'}]);
 assert.ok(c.hints.every(Object.isFrozen));assert.deepEqual(treeWitness(join(ws,'.paircoach-dependencies')),deps);assert.equal(fs.statSync(ws,{bigint:true}).ino,root.ino);
 assert.equal(fs.readFileSync(join(ws,f.path),'utf8'),'ordinary new draft\n');assert.deepEqual({source:treeWitness(f.workspace),cache:treeWitness(f.cache)},original);
 assert.equal(c.frames.filter(m=>m.method==='textDocument/didOpen').length,1);assert.equal(c.frames.filter(m=>m.method==='textDocument/didChange').length,1);
 assert.ok(c.effects.indexOf('refresh')<c.effects.indexOf('textDocument/didChange'),'provider didChange AFTER sync durable shadow replacement');assert.deepEqual(f.fifoEvents,['acquire','release','acquire','release']);assert.deepEqual(f.mutations,[]);
 console.log('ACTUAL_CALLER_WITNESS '+JSON.stringify({createCounts,refreshCounts:{capture:c.counts.capture-createCounts.capture,current:c.counts.current-createCounts.current,held:c.counts.held-createCounts.held},hints:c.hints,effects:c.effects,fifo:f.fifoEvents,workers:c.workers.events,original,after:{source:treeWitness(f.workspace),cache:treeWitness(f.cache)},depBefore:deps,depAfter:treeWitness(join(ws,'.paircoach-dependencies')),fds:fds(f.root)}));
});
for(const effect of ['epoch','source','dependency','inactive-overlay','empty-dir','revoke'] as const)test('actual Registry REFRESH worker await '+effect+' drains then 0action/0newowner/0manifest/0didChange',async t=>{
 const c=await composition(t),{f}=c;await c.start();const before=treeWitness(f.owned),launchCount=c.launches.length;
 // Replace ONLY observer hook while keeping all reads/worker exits native. Captures happen in
 // production Selected.prepare BEFORE the pool; mutation runs on first admitted READ dispatch.
 let applied=false;
 c.race(phase=>{
  if(phase==='dispatch'&&!applied){applied=true;
   if(effect==='epoch')c.registry.invalidateSource(f.scope);
   if(effect==='source')fs.writeFileSync(join(f.workspace,'inactive.txt'),'changed');
   if(effect==='dependency')fs.writeFileSync(join(f.cache,'site-packages/dependency.py'),'changed');
   if(effect==='empty-dir')fs.mkdirSync(join(f.workspace,'new-empty'));
   if(effect==='inactive-overlay')Object.assign(f.lease.source,{overlays:[...f.lease.source.overlays,{stamp:{...f.document.stamp,path:'inactive.txt',modelLifetime:'inactive'},content:'changed inactive'}]});
   if(effect==='revoke')f.revoke();
  }
 });
 const changed=f.update('new draft before race\n');await c.registry.change(changed);await c.settled();assert.ok(applied);c.workers.drained();
 assert.equal(c.refreshes(),0);assert.equal(c.launches.length,launchCount);assert.equal(c.frames.filter(m=>m.method==='textDocument/didChange').length,0);assert.deepEqual(treeWitness(f.owned),before);assert.equal(f.fifoEvents.at(-1),'release');assert.deepEqual(f.mutations,[]);
});
for(const effect of ['epoch','revoke'] as const)test('actual Registry CREATE '+effect+' during bounded READ retains 0owner/0start/0manifest after drain',async t=>{
 const c=await composition(t),{f}=c;let applied=false;
 c.race(phase=>{if(phase==='dispatch'&&!applied){applied=true;if(effect==='epoch')c.registry.invalidateSource(f.scope);else f.revoke();}});
 await c.registry.startProject(f.scope);await c.settled();assert.ok(applied);c.workers.drained();assert.equal(c.launches.length,0);assert.equal(c.starts(),0);assert.deepEqual(fs.readdirSync(f.owned),[]);assert.equal(c.effects.filter(e=>e==='create').length,0);assert.deepEqual(f.mutations,[]);assert.equal(f.fifoEvents.at(-1),'release');
});
test('actual selected REFRESH incompatible installation returns false without private mutation; Registry retires and creates a separately owned replacement',async t=>{
 const c=await composition(t),{f}=c;await c.start();Object.assign(f.lease,{installationId:'install-v2'});const refresh=f.factory.refreshCompletion.bind(f.factory);let incompatible=false;
 f.factory.refreshCompletion=(...args)=>{const before=treeWitness(f.owned);const result=refresh(...args);if(!result){incompatible=true;assert.deepEqual(treeWitness(f.owned),before,'incompatible REFRESH has no mutable tree effect');}return result;};
 await c.registry.change(f.update('new installation draft\n'));await c.settled();assert.ok(incompatible);assert.equal(c.refreshes(),1);assert.equal(c.launches.length,2);assert.equal(c.starts(),2);assert.deepEqual(c.hints.map(h=>h.kind),['CREATE','REFRESH','CREATE']);c.workers.drained();assert.deepEqual(f.mutations,[]);
});
test('selected no-hint legacy and unused REFRESH preparation are synchronous-compatible and dispose unused read vector with no owned mutation',async t=>{
 const f=await fixture(t),o=observe(t,f);let launch!:RegistryLaunch;const callback={onState:()=>{},onSourceSent:()=>{},onDiagnostics:()=>{}};
 await f.factory.withCaptureLease(f.scope,f.snapshot,()=>{launch=f.factory.create(f.scope,'completion',f.snapshot,callback);});assert.equal(o.created(),0);
 const before=treeWitness(f.owned);await f.factory.withCaptureLease(f.scope,f.snapshot,()=>{f.lease.assertCurrent();},Object.freeze({kind:'REFRESH',phase:'completion'}));o.drained();assert.ok(o.created()>0);assert.deepEqual(treeWitness(f.owned),before);assert.equal((f.factory as any).staged,null);await launch.session.retire();
});
test('actual Registry both CREATE lanes keep exact immutable diagnostic generation/source bytes through ordinary completion REFRESH',async t=>{
 const c=await composition(t,true),{f}=c;await c.start();await c.fireDiagnostics();assert.equal(c.launches.length,2);assert.equal(c.starts(),2);
 const diagnostic=c.launches.find(l=>l.generation!==null)!,generation=structuredClone(diagnostic.generation),before=treeWitness(generation!.immutableShadowDirectory);assert.equal(generation!.sources.length,1);
 assert.equal(generation!.sources[0].sourceStamp.contentSha256,f.document.stamp.contentSha256);
 await c.registry.change(f.update('next completion-only draft\n'));await c.settled();await (c.registry as any).diagnostics.pumping;c.workers.drained();
 assert.equal(c.refreshes(),1);assert.deepEqual(diagnostic.generation,generation);assert.deepEqual(treeWitness(generation!.immutableShadowDirectory),before);assert.equal(c.launches.length,2,'no unrequested diagnostic replacement before coalescing');
 assert.deepEqual(c.hints,[{kind:'CREATE',phase:'completion'},{kind:'CREATE',phase:'diagnostics'},{kind:'REFRESH',phase:'completion'}]);assert.equal(c.counts.capture,3,'one actual selected capture per staged operation');assert.deepEqual(f.mutations,[]);
});
for(const effect of ['mismatch','reuse'] as const)test('actual selected staged action '+effect+' cannot consume a foreign vector or reuse action token',async t=>{
 const f=await fixture(t),o=observe(t,f),callbacks={onState:()=>{},onSourceSent:()=>{},onDiagnostics:()=>{}};let launch:RegistryLaunch|undefined;
 await f.factory.withCaptureLease(f.scope,f.snapshot,()=>{
  if(effect==='mismatch')assert.throws(()=>f.factory.create(f.scope,'completion',{...f.snapshot,revision:'foreign'},callbacks),/Mismatched\/reused/);
  else{launch=f.factory.create(f.scope,'completion',f.snapshot,callbacks);assert.throws(()=>f.factory.create(f.scope,'completion',f.snapshot,callbacks),/Mismatched\/reused/);}
 },Object.freeze({kind:'CREATE',phase:'completion'}));
 o.drained();if(launch)await launch.session.retire();else assert.deepEqual(fs.readdirSync(f.owned),[]);assert.equal((f.factory as any).staged,null);assert.deepEqual(f.mutations,[]);
});
