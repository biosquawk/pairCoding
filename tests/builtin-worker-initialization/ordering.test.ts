/** Actual registry bundled with ONLY the lazy mode dependency controlled. Not real Monaco proof. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { resolve, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { stamp } from '../editor-language/fixtures';

function deferred<T=void>() {let resolve!:(v:T)=>void,reject!:(e:unknown)=>void;const promise=new Promise<T>((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};}
async function fixture(language:'typescript'|'javascript'='typescript') {
  const key=`__mode_${crypto.randomUUID().replaceAll('-','')}`,load=deferred(),events:string[]=[];
  const state={load:load.promise,registered:false,events};(globalThis as any)[key]=state;
  const entry=resolve(process.env.REGISTRY_SOURCE??'src/services/builtinLanguageRegistry.ts');
  const source=await readFile(entry);const sourceSha256=createHash('sha256').update(source).digest('hex');
  const output=await build({entryPoints:[entry],bundle:true,write:false,platform:'node',format:'esm',target:'es2022',plugins:[{
    name:'controlled-lazy-mode-only',setup(b){
      b.onLoad({filter:/\.ts$/},args=>args.path===entry?{contents:source.toString(),loader:'ts',resolveDir:dirname(resolve('src/services/builtinLanguageRegistry.ts'))}:undefined);
      b.onResolve({filter:/monaco-editor\/esm\/vs\/language\/typescript\/tsMode\.js$/},()=>({path:'controlled-mode',namespace:'test'}));
      b.onLoad({filter:/.*/,namespace:'test'},()=>({contents:`const s=globalThis.${key};s.events.push('import');await s.load;s.registered=true;s.events.push('controlled-mode-ready');export {};`,loader:'js'}));
    },
  }]});
  const module=await import(`data:text/javascript;base64,${Buffer.from(output.outputFiles[0].text).toString('base64')}#${key}`);
  let version=1,disposed=false,currentLanguage=language,workerText='obj.',diagnosticError:unknown=null;
  const model:any={uri:{toString:()=> 'paircoach://projekt/main.ts'},getLanguageId:()=>currentLanguage,getVersionId:()=>version,isDisposed:()=>disposed,
    getValue:()=> 'obj.',getValueLength:()=>4,getOffsetAt:()=>4,getPositionAt:(n:number)=>({lineNumber:1,column:n+1}),getWordUntilPosition:()=>({startColumn:5,endColumn:5})};
  const proxy={getScriptText:async()=>{events.push('scriptText');return workerText;},getSyntacticDiagnostics:async()=>{if(diagnosticError)throw diagnosticError;return [];},getSemanticDiagnostics:async()=>[],getCompletionsAtPosition:async()=>({entries:[{name:'method'}]})};
  const getter=(kind:string)=>async()=>{events.push('getter/'+kind);if(!state.registered)throw `${kind} not registered!`;return async()=>{events.push('proxy');return proxy;};};
  const mode=()=>({modeConfiguration:{completionItems:false,hovers:true,diagnostics:true},setModeConfiguration(c:any){this.modeConfiguration=c;}});
  const modes=[mode(),mode()];
  const registry=module.createBuiltinLanguageRegistry({typescript:{typescriptDefaults:modes[0],javascriptDefaults:modes[1],getTypeScriptWorker:getter('typescript'),getJavaScriptWorker:getter('javascript')},MarkerSeverity:{Error:8,Warning:4,Info:2}});
  const request={requestId:'current-request',stamp:stamp(),position:{line:1,column:5},trigger:null};
  return {registry,model,request,load,events,state,modes,cleanup(){delete (globalThis as any)[key];},
    change(){version++;},dispose(){disposed=true;},switchLanguage(){currentLanguage=language==='typescript'?'javascript':'typescript';},
    set workerText(v:string){workerText=v;},set diagnosticError(v:unknown){diagnosticError=v;},sourceSha256};
}
for(const language of ['typescript','javascript'] as const) {
  test(`${language}: delayed initial lazy setup precedes ALL public getters (source-bound regression)`,async t=>{
    const f=await fixture(language);t.after(()=>f.cleanup());
    const ready=f.registry.ready(f.model),completion=f.registry(f.model,f.request,new AbortController().signal),diagnostics=f.registry.diagnostics(f.model);
    // All promises are observed immediately so the original regression is an assertion, not unhandled rejection.
    const settled=Promise.allSettled([ready,completion,diagnostics]);
    await new Promise<void>(r=>setImmediate(r));
    assert.deepEqual(f.events,['import'],'no getter may run while the controlled language setup is pending');
    f.load.resolve();const results=await settled;
    assert.ok(results.every(r=>r.status==='fulfilled'),JSON.stringify(results));
    assert.equal((results[0] as any).value,true);assert.equal((results[1] as any).value.items[0].label,'method');
    assert.equal(f.events.filter(e=>e==='import').length,1);
    assert.ok(f.events.indexOf('controlled-mode-ready')<f.events.findIndex(e=>e.startsWith('getter/')));
    assert.ok(f.modes.every(m=>m.modeConfiguration.completionItems===false&&m.modeConfiguration.diagnostics===false&&m.modeConfiguration.hovers));
  });
}
test('lazy initialization rejection remains an actual failure; no getter or false ready',async t=>{
  const f=await fixture();t.after(()=>f.cleanup());
  const pending=f.registry.ready(f.model),rejected=assert.rejects(pending,/load rejected/);
  f.load.reject(Error('load rejected'));await rejected;assert.ok(!f.events.some(e=>e.startsWith('getter/')));
  await assert.rejects(f.registry.ready(f.model),/load rejected/);
});
for(const transition of ['change','dispose','switchLanguage','abort'] as const) {
  test(`late lazy module after ${transition}: stale completion cannot return edits`,async t=>{
    const f=await fixture();t.after(()=>f.cleanup());const abort=new AbortController();
    const pending=f.registry(f.model,f.request,abort.signal),settled=Promise.allSettled([pending]);
    if(transition==='abort')abort.abort();else f[transition]();
    f.load.resolve();const [result]=await settled;
    if(transition==='dispose'||transition==='switchLanguage') {
      assert.equal(result.status,'rejected');assert.ok(!f.events.some(e=>e.startsWith('getter/')));
    } else {assert.equal(result.status,'fulfilled');assert.equal((result as any).value.items.length,0);}
  });
}
test('ready requires actual synchronized bytes; worker RPC errors are not hidden',async t=>{
  const f=await fixture();t.after(()=>f.cleanup());f.load.resolve();
  f.workerText='stale';assert.equal(await f.registry.ready(f.model),false);
  f.workerText='obj.';assert.equal(await f.registry.ready(f.model),true);
  f.diagnosticError=Error('real worker failure');await assert.rejects(f.registry.diagnostics(f.model),/real worker failure/);
});
test('Java/Python current-document words remain independent of TS mode loading',async t=>{
  const f=await fixture();t.after(()=>f.cleanup());
  for(const language of ['java','python']) {
    const model={...f.model,getLanguageId:()=>language};assert.equal(await f.registry.ready(model),true);assert.equal(f.registry.hasDiagnostics(model),false);assert.equal(await f.registry.diagnostics(model),null);
  }
  assert.deepEqual(f.events,[]);
});
