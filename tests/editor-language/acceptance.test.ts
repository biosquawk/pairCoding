import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createCompletionAcceptance } from '../../src/services/editor-language/acceptance';
import { contentSha256, normalizeContent } from '../../src/services/editor-language/codec';
import type { AcceptanceState, CompleteResult, CompletionCandidate, DocumentStamp } from '../../src/shared/language-v2';
export const stamp = (content='obj.', overrides:Partial<DocumentStamp>={}):DocumentStamp => ({
  projectId:'projekt',sessionId:'session',path:'src/Zażółć space 😀.ts',profileId:'neutral',connectionGeneration:'connection',configurationGeneration:'config',providerGeneration:'provider',shadowGeneration:'shadow',modelLifetime:'lifetime',localModelVersion:1,baseDocumentVersion:2,documentVersion:null,contentSha256:contentSha256(content),controlEpoch:0,requestGeneration:1,...overrides,
});
export const result = (s=stamp()):CompleteResult => ({requestId:'request',stamp:s,items:[{id:'method',label:'method',detail:null,primary:{path:s.path,range:{startLine:1,startColumn:5,endLine:1,endColumn:5},text:'method()'},additionalTextEdits:[]}],isIncomplete:false});
function fixture(content='obj.') {
  let state:AcceptanceState={stamp:stamp(content),content,writeOwner:'STUDENT',connected:true,synced:true,controlPrepare:false,vetoPending:false,conflict:false,readOnly:false};
  let shown:readonly CompletionCandidate[]=[],pushes:CompletionCandidate[]=[],cancels=0;
  const gate=createCompletionAcceptance({current:()=>state,push:c=>pushes.push(c),show:c=>shown=c,hide:()=>shown=[],cancelRequests:()=>cancels++});
  return {gate,get state(){return state;},set state(s){state=s;},get shown(){return shown;},pushes,get cancels(){return cancels;}};
}
test('synchronous SHA256 matches independent Node oracle incl normalized CRLF, Unicode and long buffers',()=>{
  for(const content of ['', 'abc','A😀B\r\nŻółć\rX', 'long 😀'.repeat(10000)])
    assert.equal(contentSha256(content),createHash('sha256').update(normalizeContent(content)).digest('hex'));
});
test('before-ACK current student completion accepts once, no async gate or disk-save dependency',()=>{
  const f=fixture();f.gate.present(result());const candidate=f.shown[0];assert.ok(candidate);
  assert.deepEqual(f.gate.accept(candidate),{accepted:true});assert.equal(f.pushes.length,1);
  assert.equal(f.gate.accept(candidate).accepted,false);assert.equal(f.pushes.length,1);
});
test('every synchronous authority flag is rechecked at ACCEPT, not only PRESENT',()=>{
  for(const [key,value] of Object.entries({writeOwner:'COACH',connected:false,synced:false,controlPrepare:true,vetoPending:true,conflict:true,readOnly:true})){
    const f=fixture();f.gate.present(result());const c=f.shown[0];assert.ok(c);(f.state as any)[key]=value;
    assert.equal(f.gate.accept(c).accepted,false,key);assert.equal(f.pushes.length,0,key);
  }
});
test('each full-stamp field and actual bytes are independent acceptance fences',()=>{
  for(const key of Object.keys(stamp()) as (keyof DocumentStamp)[]){
    const f=fixture();f.gate.present(result());const c=f.shown[0];assert.ok(c);
    (f.state.stamp as any)[key]=typeof f.state.stamp[key]==='number' ? Number(f.state.stamp[key])+1 : `${f.state.stamp[key]}-changed`;
    assert.equal(f.gate.accept(c).accepted,false,key);assert.equal(f.pushes.length,0);
  }
  const f=fixture();f.gate.present(result());const c=f.shown[0];f.state.content='new!';
  assert.equal(f.gate.accept(c).accepted,false);assert.equal(f.pushes.length,0);
});
test('CONTROL_PREPARE invalidation wins immediately even if prepare is later denied and stamp unchanged',()=>{
  const f=fixture();f.gate.present(result());const c=f.shown[0];f.gate.invalidate('CONTROL_PREPARE');
  assert.equal(f.shown.length,0);assert.equal(f.cancels,1);assert.equal(f.gate.accept(c).accepted,false);assert.equal(f.pushes.length,0);
});
test('ACK-only cannot rebind old completion; fresh exact result is required',()=>{
  const f=fixture();f.gate.present(result());const c=f.shown[0];f.state.stamp={...f.state.stamp,baseDocumentVersion:3,documentVersion:3};
  assert.equal(f.gate.accept(c).accepted,false);f.gate.present(result(f.state.stamp));assert.equal(f.shown.length,1);
});
test('caller mutation cannot alter stored candidate or inject command/additional edits',()=>{
  const f=fixture(),r=result();f.gate.present(r);const c=f.shown[0];r.items[0].primary.text='unsafe';
  c.item.primary.text='tampered';assert.equal(f.gate.accept(c).accepted,false);assert.equal(f.pushes.length,0);
  f.gate.present({...result(),items:[{...result().items[0],command:'bypass'} as any]});assert.equal(f.shown.length,0);
});
test('UTF16 surrogate splits, out-of-range, overlap, multi-file and action metadata fail all-or-none',()=>{
  const content='A😀B'; const good={startLine:1,startColumn:5,endLine:1,endColumn:5};
  const unsafe=[{range:{...good,startColumn:3}}, {range:{...good,endColumn:6}}, {path:'other.ts'}, {text:'x'.repeat(4097)}];
  for(const patch of unsafe){const f=fixture(content),r=result(f.state.stamp);Object.assign(r.items[0].primary,patch);f.gate.present(r);assert.equal(f.shown.length,0);assert.equal(f.pushes.length,0);}
  const f=fixture(content),r=result(f.state.stamp);r.items[0].additionalTextEdits=[{...r.items[0].primary,text:'duplicate'}];f.gate.present(r);assert.equal(f.shown.length,0);
});
test('disjoint same-document primary/additional edits share exactly one synchronous mutation call',()=>{
  const f=fixture('abc\nobj.'),r=result(f.state.stamp);r.items[0].primary.range={startLine:2,startColumn:5,endLine:2,endColumn:5};
  r.items[0].additionalTextEdits=[{path:r.stamp.path,range:{startLine:1,startColumn:1,endLine:1,endColumn:4},text:'imported'}];
  f.gate.present(r);assert.equal(f.shown.length,1);assert.equal(f.gate.accept(f.shown[0]).accepted,true);assert.equal(f.pushes.length,1);assert.equal(f.pushes[0].item.additionalTextEdits.length,1);
});
test('missing or truthy non-boolean authority state fails closed',()=>{
  for(const [key,value] of [['connected','yes'],['synced',1],['controlPrepare',undefined],['vetoPending',undefined],['conflict',undefined],['readOnly',undefined]]){
    const f=fixture();(f.state as any)[key as string]=value;f.gate.present(result());assert.equal(f.shown.length,0,String(key));assert.equal(f.pushes.length,0);
  }
});
