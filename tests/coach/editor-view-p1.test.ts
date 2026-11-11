import test from 'node:test';
import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
import path from 'node:path';
import { coreFixture } from '../qa/helpers';
import { buildContext } from '../../src/server/coach/context';
import type { EditorViewPayload } from '../../src/server/EditorView';

const range = (startColumn: number, endColumn: number) => ({startLine:1,startColumn,endLine:1,endColumn});
const payload = (selection: EditorViewPayload['selection'] = null): EditorViewPayload =>
  ({path:'main.py',documentVersion:1,cursor:{line:1,column:1},selection});

// Real workspace/session: shared schema and old fixtures are untouched.
test('editor view: exact UTF16/version validation is atomic, clones DTOs, clear/path-only never inherit', async t => {
  const f = await coreFixture(t, {'main.py':'a😀b\nsecond\n','other.py':'other'});
  f.session.setEditorView(f.clientId,f.sessionId,payload(range(2,4)));
  const original = f.session.getEditorView();
  for (const bad of [
    {...payload(),documentVersion:0}, {...payload(),documentVersion:null},
    {...payload(),cursor:{line:1,column:3}}, {...payload(),cursor:{line:4,column:1}},
    {...payload(),cursor:{line:1,column:6}}, {...payload(),selection:range(4,2)},
    {...payload(),selection:range(2,3)}, {...payload(),cursor:{line:1.5,column:1}},
    {path:null,documentVersion:1,cursor:null,selection:null},
  ]) {
    assert.throws(()=>f.session.setEditorView(f.clientId,f.sessionId,bad), (e:any)=>['INVALID_VIEW','DOCUMENT_VERSION_CONFLICT'].includes(e.code));
    assert.deepEqual(f.session.getEditorView(),original);
    assert.equal(f.session.getSession().activeFilePath,'main.py');
  }
  const accepted=payload(range(1,2));f.session.setEditorView(f.clientId,f.sessionId,accepted);
  accepted.cursor!.column=3;accepted.selection!.endColumn=5;
  assert.deepEqual(f.session.getEditorView().selection,range(1,2));
  const returned=f.session.getEditorView();returned.selection.endColumn=99;
  assert.deepEqual(f.session.getEditorView().selection,range(1,2));
  f.session.setEditorView(f.clientId,f.sessionId,{path:'other.py',documentVersion:1,cursor:null,selection:null});
  assert.equal(f.session.getEditorView().cursor,null);assert.equal(f.session.getEditorView().selection,null);
  f.session.setEditorView(f.clientId,f.sessionId,{path:null,documentVersion:null,cursor:null,selection:null});
  assert.equal(f.session.getEditorView(),null);assert.equal(f.session.getSession().activeFilePath,null);
});

test('editor view: lease/session/project/edit invalidation, rejected foreign authority cannot mutate', async t => {
  const f = await coreFixture(t, {'main.py':'one\n'});
  const accept=()=>f.session.setEditorView(f.clientId,f.sessionId,payload(range(1,4)));
  accept();const original=f.session.getEditorView();
  assert.throws(()=>f.session.setEditorView('foreign-client',f.sessionId,payload()),{code:'LEASE_REQUIRED'});
  assert.throws(()=>f.session.setEditorView(f.clientId,'foreign-session',payload()),{code:'SESSION_MISMATCH'});
  assert.deepEqual(f.session.getEditorView(),original);
  f.session.releaseLease(f.clientId);assert.equal(f.session.getEditorView(),null);
  f.session.claimLease(f.clientId);assert.equal(f.session.getEditorView(),null);accept();
  f.gate.write({clientId:f.clientId,sessionId:f.sessionId,controlEpoch:f.session.getSession().controlEpoch,
    actor:'STUDENT',path:'main.py',baseVersion:1,content:'two\n'});
  assert.equal(f.session.getEditorView(),null);
  f.session.setEditorView(f.clientId,f.sessionId,{...payload(),documentVersion:2});
  f.session.state.projectId='foreign-project';assert.equal(f.session.getEditorView(),null);
  f.session.state.projectId=f.workspace.projectId;
  f.session.setEditorView(f.clientId,f.sessionId,{...payload(),documentVersion:2});
  f.session.finish();assert.equal(f.session.getEditorView(),null);
});

test('context view: raw UTF16 multiline slice, redaction also masks partial sensitive/assignment selections', async t => {
  const source='a😀b\napi_key="never_send_this"\nend';
  const f=await coreFixture(t, {'main.py':source});
  f.workspace.updateSettings({...f.workspace.settings,aiConsent:true,contextPatterns:['**/*.py']});
  const context=(selection:EditorViewPayload['selection'],sensitive: string[]=[])=> {
    f.session.setEditorView(f.clientId,f.sessionId,{...payload(selection),cursor:{line:1,column:4}});
    return buildContext(f.workspace,f.session.getSession(),[],null,[],sensitive,f.session.getEditorView());
  };
  const c=context({startLine:1,startColumn:2,endLine:2,endColumn:25});
  assert.equal(c.view?.selectedText,'😀b\n[REDACTED]');
  assert.equal(c.view?.projectId,f.workspace.projectId);assert.equal(c.view?.documentVersion,1);
  assert.equal(c.view?.selectionTruncated,false);assert.doesNotMatch(JSON.stringify(c),/never_send_this/);
  const partial=context({startLine:2,startColumn:12,endLine:2,endColumn:17});
  assert.equal(partial.view?.selectedText,'[REDACTED]');
  assert.equal(context(range(2,4),['😀b']).view?.selectedText,'[REDACTED]');
  assert.equal(context(range(2,2)).view?.selectedText,'');
  assert.equal(context(null).view?.selectedText,null);
});

test('context view: post-redaction8192 bound keeps surrogate pairs; omitted/disallowed/stale/foreign views are null', async t => {
  const source='a'.repeat(8191)+'😀'+'z'.repeat(12);
  const f=await coreFixture(t, {'main.py':source,'.env.fixture':'SYNTHETIC_EXCLUDED','large.py':'x'.repeat(262145)});
  f.workspace.updateSettings({...f.workspace.settings,aiConsent:true,contextPatterns:['**/*']});
  const context=()=>buildContext(f.workspace,f.session.getSession(),[],null,[],[],f.session.getEditorView());
  f.session.setEditorView(f.clientId,f.sessionId,payload(range(1,source.length+1)));
  const valid=context();assert.equal(valid.view?.selectedText,'a'.repeat(8191));assert.equal(valid.view?.selectionTruncated,true);
  f.session.setEditorView(f.clientId,f.sessionId,{...payload(range(1,2)),path:'.env.fixture'});
  assert.equal(context().view,null);
  f.session.setEditorView(f.clientId,f.sessionId,{...payload(range(1,2)),path:'large.py'});
  const omitted=context();assert(omitted.omittedPaths.includes('large.py'));assert.equal(omitted.view,null);
  f.session.setEditorView(f.clientId,f.sessionId,payload(range(1,2)));
  const view=f.session.getEditorView(), state=f.session.getSession();
  for(const bad of [{...view,projectId:'other'},{...view,documentVersion:2},{...view,cursor:{line:99,column:1}}])
    assert.equal(buildContext(f.workspace,state,[],null,[],[],bad).view,null);
  f.workspace.updateSettings({...f.workspace.settings,contextPatterns:['*.md']});
  assert.equal(context().view,null);
});


test('context view: external document version change invalidates both stored and previously copied view',async t=>{
  const f=await coreFixture(t,{'main.py':'original'});
  f.workspace.updateSettings({...f.workspace.settings,aiConsent:true,contextPatterns:['*.py']});
  f.session.setEditorView(f.clientId,f.sessionId,payload(range(1,4)));
  const copied=f.session.getEditorView();
  await writeFile(path.join(f.rootPath,'main.py'),'EXTERNAL changed document');
  const c=buildContext(f.workspace,f.session.getSession(),[],null,[],[],copied);
  assert.equal(c.view,null);assert.equal(f.session.getEditorView(),null);
  assert.equal(c.documents.find(d=>d.path==='main.py')?.content,'EXTERNAL changed document');
});
