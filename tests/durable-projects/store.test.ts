/** Changed-path tests; no provider/network/Run. Real native journal lease and atomic file IO. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {DurableProjectStore} from '../../src/server/DurableProjectStore';
import {validProjectWorkspace} from '../../src/shared/durable-project';
import {snapshotAllowed} from '../../src/server/SnapshotStorage';
import {isContextPathAllowed,isCoachWriteAllowed} from '../../src/server/coach/context';
import {localizeDiagnostic} from '../../src/shared/localizeDiagnostic';

test('durable project restores all chat, original time/locale, rules, notes, transitions, workspace and actual native IDs',t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'durable-project-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const p=DurableProjectStore.create(dir,'Training','en'),id=p.view().id,file=p.projectFile;
 const at='2026-11-14T10:00:00.000Z';
 const chat=Array.from({length:105},(_,i)=>({messageId:randomUUID(),author:'STUDENT' as const,text:i===0?'/rule Use Java 21 without streams.':'question '+i,createdAt:at,locale:'en' as const}));
 p.recordExercise(path.join(dir,'external-A'));p.capture(chat,null);p.remember('Next: finish the condition, then explicitly Run Tests.');
 p.recordExercise(path.join(dir,'external-B'));p.setWorkspace({openTabs:['Main.java','challenge.md'],activePath:'Main.java',sidebarTab:'chat',bottomTab:'report'});
 const nativeId=randomUUID();p.nativeSession('default:gpt-6.1-sol:high').started(nativeId);p.close();
 const reopened=DurableProjectStore.open(file);t.after(()=>reopened.close());
 assert.equal(reopened.view().id,id);assert.equal(reopened.view().locale,'en');assert.equal(reopened.view().exercisePath,path.join(dir,'external-B'));
 assert.deepEqual(reopened.snapshot().chat,chat);assert.equal(reopened.snapshot().chat.length,105,'no historical 100-message truncation');
 assert.equal(reopened.coachContext().rules[0],'Use Java 21 without streams.');assert.match(reopened.coachContext().notes[0],/Next:/);
 assert.equal(reopened.coachContext().transitions.length,2);assert.equal(reopened.view().workspace.sidebarTab,'chat');
 assert.equal(reopened.nativeSession('default:gpt-6.1-sol:high').id(),nativeId);
 assert.throws(()=>reopened.nativeSession('default:gpt-6.1-sol:high').started(randomUUID()),/silent replacement/);
 assert.equal(fs.readdirSync(path.join(dir,'.pairCoding','codex')).some(n=>/auth|reasoning|token/.test(n)),false);
});

test('P and Q can reference the same exercise without chat/rules/notes/native session leakage',t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'durable-isolation-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const a=path.join(root,'P'),b=path.join(root,'Q');fs.mkdirSync(a);fs.mkdirSync(b);
 const p=DurableProjectStore.create(a,'P'),q=DurableProjectStore.create(b,'Q');t.after(()=>{p.close();q.close();});
 p.recordExercise(root);q.recordExercise(root);p.capture([{messageId:randomUUID(),author:'STUDENT',text:'/rule P-only',createdAt:new Date().toISOString(),locale:'pl'}],null);p.remember('P note');p.nativeSession('teacher').started(randomUUID());
 assert.notEqual(p.view().id,q.view().id);assert.deepEqual(q.snapshot().chat,[]);assert.deepEqual(q.coachContext().rules,[]);assert.deepEqual(q.coachContext().notes,[]);assert.equal(q.nativeSession('teacher').id(),undefined);
});

test('unsafe, unknown and model-origin rule updates are rejected; metadata excluded from source/context/snapshots',t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'durable-protect-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const p=DurableProjectStore.create(root,'P');t.after(()=>p.close());
 for(const w of [{openTabs:['../escape'],activePath:'../escape'},{openTabs:['.pairCoding/codex/state.json'],activePath:null},{openTabs:[],activePath:'Main.java'},{openTabs:[],activePath:null,rules:['unauthorized']},{openTabs:[],activePath:null,sidebarTab:'unknown'}])assert.equal(validProjectWorkspace(w),false,JSON.stringify(w));
 p.capture([{messageId:randomUUID(),author:'COACH',text:'/rule untrusted',createdAt:new Date().toISOString()}],null);assert.deepEqual(p.coachContext().rules,[]);
 for(const file of ['.pairCoding/codex/state.json','P.paircoding.json']) {assert.equal(snapshotAllowed(file),false);assert.equal(isContextPathAllowed(file),false);assert.equal(isCoachWriteAllowed(file,{} as any),false);}
 assert.throws(()=>DurableProjectStore.create(root,'Other'),/already/);
});

test('single owner, symlink/hardlink protection, disk conflicts and unknown versions fail closed',t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'durable-atomic-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const p=DurableProjectStore.create(root,'P'),file=p.projectFile,state=path.join(p.desk,'state.json');
 assert.throws(()=>DurableProjectStore.open(file),/owner|lock|lease/i);
 fs.writeFileSync(state,fs.readFileSync(state,'utf8')+' ');assert.throws(()=>p.setLocale('en'),/metadata changed/);p.close();
 const original=fs.readFileSync(state,'utf8');fs.unlinkSync(state);fs.writeFileSync(path.join(root,'foreign.json'),original);fs.symlinkSync(path.join(root,'foreign.json'),state);
 assert.throws(()=>DurableProjectStore.open(file),/Unsafe/);fs.unlinkSync(state);fs.linkSync(path.join(root,'foreign.json'),state);assert.throws(()=>DurableProjectStore.open(file),/Unsafe/);fs.unlinkSync(state);
 fs.writeFileSync(state,original);const manifest=JSON.parse(fs.readFileSync(file,'utf8'));fs.writeFileSync(file,JSON.stringify({...manifest,schemaVersion:99}));assert.throws(()=>DurableProjectStore.open(file),/unsupported/);
});

test('diagnostics are explicit-locale, reversible and do not translate arbitrary task/log text',()=>{
 assert.match(localizeDiagnostic('PROJECT_SAVE_FAILED: EACCES','en'),/Keep the application open/);
 assert.match(localizeDiagnostic('PROJECT_SAVE_FAILED: EACCES','pl'),/Nie zapisano/);
 assert.equal(localizeDiagnostic('Brak bieżącego projektu.','en'),'No project is open.');
 assert.equal(localizeDiagnostic('No project is open.','pl'),'Brak bieżącego projektu.');
 assert.equal(localizeDiagnostic('raw user code print("hello")','en'),'raw user code print("hello")');
});

test('editor view DTO accepts bounded known state only for open tabs and rejects arbitrary Monaco blobs',()=>{
 const view={position:{lineNumber:1,column:2},selection:{startLineNumber:1,startColumn:1,endLineNumber:1,endColumn:2},scrollTop:0,scrollLeft:4};
 assert.equal(validProjectWorkspace({openTabs:['Main.java'],activePath:'Main.java',editorViews:{'Main.java':view}}),true);
 for(const editorViews of [{'Other.java':view},{'Main.java':{...view,scrollTop:Infinity}},{'Main.java':{...view,position:{lineNumber:-1,column:1}}},{'Main.java':{...view,extra:'unsafe'}},{'Main.java':{...view,selection:{startLineNumber:2,startColumn:1,endLineNumber:1,endColumn:1}}}])
  assert.equal(validProjectWorkspace({openTabs:['Main.java'],activePath:'Main.java',editorViews}),false);
});
