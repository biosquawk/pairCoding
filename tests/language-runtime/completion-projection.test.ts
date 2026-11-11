import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { projectCompletion } from '../../src/server/language/CompletionProjection';
import type { CompleteRequest } from '../../src/shared/language-v2';
import { validateCompleteResult } from '../../src/shared/validation-v2';
// Finite-fixture mapper ONLY, not a copy of the central URI/CRLF implementation.
const content='😀.\nimport x;',rawContent='😀.\r\nimport x;';
const codec={normalizeContent:(s:string)=>s===rawContent?content:s,contentSha256:(s:string)=>createHash('sha256').update(s===rawContent?content:s).digest('hex'),
  toWorkspaceUri:(p:string)=>{assert.equal(p,'Main.java');return 'fixture:Main';}};
const request:CompleteRequest={requestId:'complete1',stamp:{projectId:'project',sessionId:'session',path:'Main.java',profileId:'java21',
  connectionGeneration:'connection',configurationGeneration:'config',providerGeneration:'provider',shadowGeneration:'shadow',modelLifetime:'model',
  localModelVersion:3,baseDocumentVersion:1,documentVersion:null,contentSha256:codec.contentSha256(content),controlEpoch:0,requestGeneration:3},
  position:{line:1,column:4},trigger:'.'};
const input=()=>({request:structuredClone(request),content:rawContent,workspaceUri:'fixture:Main'});
const edit=(line=0,start=3,end=3,text='method()')=>({range:{start:{line,character:start},end:{line,character:end}},newText:text});
const item=()=>({label:'method',detail:'public method()',textEdit:edit()});
test('projects complete plain primary+same-document additional edits, drops JDT command/data/docs permanently',()=>{
  const v={...item(),command:{command:'java.apply.workspaceEdit',arguments:['evil']},data:{resolve:'evil'},documentation:{kind:'markdown',value:'<script>'},
    additionalTextEdits:[edit(1,0,0,'import z;\n')]};
  const result=projectCompletion({isIncomplete:true,items:[v]},input(),codec);assert.equal(validateCompleteResult(result),true);
  assert.equal(result.items.length,1);assert.equal(result.isIncomplete,true);assert.deepEqual(result.stamp,request.stamp);
  assert.deepEqual(Object.keys(result.items[0]),['id','label','detail','primary','additionalTextEdits']);
  assert.deepEqual(result.items[0].primary,{path:'Main.java',range:{startLine:1,startColumn:4,endLine:1,endColumn:4},text:'method()'});
  assert.equal(result.items[0].additionalTextEdits[0].path,'Main.java');assert.equal(JSON.stringify(result).includes('evil'),false);
});
test('no self-contained primary: insertText/label only, resolve and InsertReplaceEdit never manufacture edits',()=>{
  for(const v of [{label:'x'},{label:'x',insertText:'x'},{label:'x',data:{resolve:true}},
    {label:'x',textEdit:{newText:'x',insert:edit().range,replace:edit().range}}]) assert.equal(projectCompletion([v],input(),codec).items.length,0);
});
test('snippets/adjustIndentation/itemDefaults are not plain edit semantics',()=>{
  for(const v of [{...item(),insertTextFormat:2},{...item(),insertTextMode:2},{...item(),insertTextFormat:'1'}])
    assert.equal(projectCompletion([v],input(),codec).items.length,0);
  assert.equal(projectCompletion({isIncomplete:false,items:[item()],itemDefaults:{insertTextFormat:2}},input(),codec).items.length,0);
});
test('UTF16 bounds/surrogate split/reversed/negative/fractional positions reject instead of clamping',()=>{
  for(const e of [edit(0,1,1),edit(0,0,1),edit(0,4,4),edit(2,0,0),edit(0,3,2),edit(-1,0,0),edit(0,1.5,2)])
    assert.equal(projectCompletion([{...item(),textEdit:e}],input(),codec).items.length,0,JSON.stringify(e));
  assert.equal(projectCompletion([{...item(),textEdit:edit(0,0,2,'plain')}],input(),codec).items.length,1);
});
test('overlap/ambiguous boundary insertions and multifile edit objects reject the entire item',()=>{
  for(const e of [edit(0,2,3),edit(0,3,3),{...edit(1,0,0),uri:'file:///other'},
    {textDocument:{uri:'file:///other'},edits:[edit()]}]) {
    const r=projectCompletion([{...item(),additionalTextEdits:[e]}],input(),codec);assert.equal(r.items.length,0,JSON.stringify(e));
  }
});
test('byte/count/edit/detail/label/response limits are enforced before or after projection',()=>{
  const cases=[{...item(),label:'x'.repeat(257)},{...item(),detail:'x'.repeat(1025)},{...item(),textEdit:edit(0,3,3,'x'.repeat(4097))},
    {...item(),additionalTextEdits:new Array(101).fill(edit(1,0,0))}];
  for(const v of cases) assert.equal(projectCompletion([v],input(),codec).items.length,0);
  assert.equal(projectCompletion(new Array(101).fill(item()),input(),codec).items.length,0);
  assert.equal(projectCompletion([{...item(),data:'x'.repeat(256*1024)}],input(),codec).items.length,0);
  assert.equal(projectCompletion(new Array(100).fill(item()),input(),codec).items.length,100);
});
test('null/unknown/malformed responses safely produce empty captured result',()=>{
  for(const raw of [null,undefined,17,'oops',{}, {items:[item()]},{items:[item()],isIncomplete:'false'},[null,{},'x']])
    assert.equal(projectCompletion(raw,input(),codec).items.length,0);
});
test('captured source/URI/hash/cursor must match; output is detached, no later-stamp rebinding',()=>{
  for(const patch of [{workspaceUri:'other'},{content:'newer'}, {request:{...request,position:{line:1,column:2}}}])
    assert.throws(()=>projectCompletion([item()],{...input(),...patch},codec),/Invalid captured/);
  const captured=input(),result=projectCompletion([item()],captured,codec);captured.request.stamp.localModelVersion=999;
  assert.equal(result.stamp.localModelVersion,3);assert.notEqual(result.stamp,captured.request.stamp);
});
