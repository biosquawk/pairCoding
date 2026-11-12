import test from 'node:test';
import assert from 'node:assert/strict';
import { createCurrentDocumentWordsProvider } from '../../src/services/editor-language/currentDocumentWords';
import { createBuiltinLanguageRegistry } from '../../src/services/builtinLanguageRegistry';
import { stamp } from '../editor-language/fixtures';
import { contentSha256 } from '../../src/language/uriCodec';
const provider=createCurrentDocumentWordsProvider();
function model(content:string,language='java') {
  return {uri:{toString:()=> 'paircoach://p/a.java'},getVersionId:()=>1,isDisposed:()=>false,getLanguageId:()=>language,
    getValue:()=>content,getValueLength:()=>content.length,getOffsetAt:(p:any)=>p.column-1,
    getPositionAt:(offset:number)=>({lineNumber:1,column:offset+1})} as any;
}
function request(content:string,column=content.length+1){return {requestId:'word-request',stamp:{...stamp(),contentSha256:contentSha256(content)},position:{line:1,column},trigger:null};}
test('Java and Python prefix results read ONLY the current model bytes without ACK',async()=>{
  for(const language of ['java','python']) {
    const content='apple apply foreignWord app';
    const r=await provider(model(content,language),request(content),new AbortController().signal);
    assert.deepEqual(r.items.map(i=>i.label),['apple','apply']);
    assert.equal(r.items[0].primary.range.startColumn,content.length-2);
    assert.deepEqual(r.items[0].additionalTextEdits,[]);
    const edited='apricot foreignWord apr';
    assert.deepEqual((await provider(model(edited,language),request(edited),new AbortController().signal)).items.map(i=>i.label),['apricot']);
  }
});
test('empty prefix, dot member, stale hash/version and abort give no invented semantic suggestions',async()=>{
  for(const content of ['apple apply ','apple obj.ap'])assert.equal((await provider(model(content),request(content),new AbortController().signal)).items.length,0);
  const content='apple app',m=model(content),abort=new AbortController();abort.abort();
  assert.equal((await provider(m,request(content),abort.signal)).items.length,0);
  assert.equal((await provider(m,request('other'),new AbortController().signal)).items.length,0);
  m.getVersionId=()=>2;assert.equal((await provider(m,request(content),new AbortController().signal)).items.length,0);
});
test('registry routes Java/Python to current model, not TS worker or allDocuments; honest diagnostics N/A',async()=>{
  const mode={modeConfiguration:{diagnostics:true},setModeConfiguration(c:any){this.modeConfiguration=c;}};
  const monaco:any={typescript:{typescriptDefaults:{...mode},javascriptDefaults:{...mode},getJavaScriptWorker:()=>{throw Error('no JS worker for Java');},getTypeScriptWorker:()=>{throw Error('no TS worker for Python');}}};
  const registry=createBuiltinLanguageRegistry(monaco);
  for(const language of ['java','python']){
    const content='apricot apr',m=model(content,language);assert.equal(await registry.ready!(m),true);
    assert.equal(registry.hasDiagnostics!(m),false);assert.equal(await registry.diagnostics!(m),null);
    assert.deepEqual((await registry(m,request(content),new AbortController().signal))?.items.map(i=>i.label),['apricot']);
  }
});
