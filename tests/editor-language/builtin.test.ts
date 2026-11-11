import test from 'node:test';
import assert from 'node:assert/strict';
import { createBuiltinCompletionProvider } from '../../src/services/editor-language/builtin';
import { stamp } from './fixtures';
const model:any={uri:{toString:()=> 'paircoach://p-70/a.ts'},getVersionId:()=>1,isDisposed:()=>false,getValue:()=> 'obj.',getValueLength:()=>4,getOffsetAt:()=>4,getPositionAt:(n:number)=>({lineNumber:1,column:n+1}),getWordUntilPosition:()=>({startColumn:5,endColumn:5})};
const request={requestId:'builtin-request',stamp:stamp(),position:{line:1,column:5},trigger:'.'};
test('actual public worker method projected to plain independent safe edits, never resolve/command',async()=>{
  const calls:any[]=[];const provider=createBuiltinCompletionProvider(async()=>({getCompletionsAtPosition:async(...args)=>{calls.push(args);return {entries:[{name:'method',insertText:'method',replacementSpan:{start:4,length:0}}, {name:'snippet',isSnippet:true},{name:'import',hasAction:true},{name:'remote',source:'module'},{name:'opaque',data:{x:1}},{name:'out',replacementSpan:{start:99,length:1}}]};}}));
  const response=await provider(model,request,new AbortController().signal);assert.equal(calls.length,1);assert.deepEqual(response.items.map(i=>i.label),['method']);assert.deepEqual(Object.keys(response.items[0]).sort(),['additionalTextEdits','detail','id','label','primary']);
});
test('builtin cancellation/version change during worker wait drops result without mutation',async()=>{
  let release!:(v:any)=>void;const wait=new Promise<any>(r=>release=r);const provider=createBuiltinCompletionProvider(async()=>({getCompletionsAtPosition:()=>wait}));
  const abort=new AbortController(),pending=provider(model,request,abort.signal);await Promise.resolve();abort.abort();release({entries:[{name:'late'}]});assert.equal((await pending).items.length,0);
});
