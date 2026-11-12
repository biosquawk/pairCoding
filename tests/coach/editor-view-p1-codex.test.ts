/** Executable JSONL boundary, deterministic synthetic child; no real AI/network/credentials. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {coreFixture} from '../qa/helpers';
import {buildContext} from '../../src/server/coach/context';
import {CodexCoachProvider} from '../../src/server/coach/CodexProvider';

test('Codex stdin explicitly carries every allowed view field, drops nested future metadata, emits null for absence',async t=>{
  const f=await coreFixture(t,{'main.py':'hello 😀 world\n'});
  f.workspace.updateSettings({...f.workspace.settings,aiConsent:true,contextPatterns:['*.py']});
  f.session.setEditorView(f.clientId,f.sessionId,{path:'main.py',documentVersion:1,cursor:{line:1,column:9},
    selection:{startLine:1,startColumn:7,endLine:1,endColumn:9}});
  const context=buildContext(f.workspace,f.session.getSession(),[],null,[],[],f.session.getEditorView());
  const record=path.join(f.base,'child-input.json'),exe=path.join(f.base,'capture.cjs');
  await fs.writeFile(exe,`#!${process.execPath}
const fs=require('node:fs');let input='';process.stdin.setEncoding('utf8');process.stdin.on('data',s=>input+=s);process.stdin.on('end',()=>{
 fs.writeFileSync(${JSON.stringify(record)},input);const emit=v=>process.stdout.write(JSON.stringify(v)+'\\n');
 emit({type:'item.completed',item:{type:'agent_message',text:JSON.stringify({decision:{kind:'SILENT',reason:'synthetic'}})}});emit({type:'turn.completed'});
});\n`,{mode:0o700});
  const provider=new CodexCoachProvider(exe,5000);
  const dirty={...context,privateRoot:'PRIVATE_ROOT',view:{...context.view!,privateRoot:'PRIVATE_VIEW_ROOT',
    cursor:{...context.view!.cursor!,secret:'PRIVATE_CURSOR'},selection:{...context.view!.selection!,secret:'PRIVATE_RANGE'}}};
  await provider.decide(dirty,new AbortController().signal);
  const sent=JSON.parse(await fs.readFile(record,'utf8'));
  assert.deepEqual(sent.view,context.view);assert.equal(sent.view.selectedText,'😀');
  assert.deepEqual(Object.keys(sent.view).sort(),['cursor','documentVersion','path','projectId','selectedText','selection','selectionTruncated'].sort());
  assert.doesNotMatch(JSON.stringify(sent),/PRIVATE_ROOT|PRIVATE_VIEW_ROOT|PRIVATE_CURSOR|PRIVATE_RANGE/);
  const {view:_,...legacy}=context;
  await provider.decide(legacy,new AbortController().signal);
  assert.equal(JSON.parse(await fs.readFile(record,'utf8')).view,null);
  await provider.decide({...context,view:{...context.view!,cursor:null,selection:null,selectedText:null}},new AbortController().signal);
  assert.deepEqual(JSON.parse(await fs.readFile(record,'utf8')).view,{...context.view!,cursor:null,selection:null,selectedText:null});
});
