/** UNIT ONLY: no plan execution, subprocess, Docker or real provider. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { MISSING, PassiveImportTrace, completionMatches, diagnosticMatches, validateImportPlan, PROOF_BUDGET, rawDependencyInventory, type ImportPlan } from './real-import-harness';
import type { OpenOrChange, DiagnosticsResult, CompleteResult } from '../../src/shared/language-v2';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync,symlinkSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import * as codec from '../../src/language/uriCodec';
const hash='a'.repeat(64);
const doc=(content='import pytest\nvalue.undo()\n'+MISSING+'\n',version=1):OpenOrChange=>({content,reason:'OPEN',stamp:{
  projectId:'p',sessionId:'s',profileId:'python-3.13',configurationGeneration:'c',providerGeneration:'p',shadowGeneration:'sh',connectionGeneration:'cn',
  path:'main.py',modelLifetime:'m',localModelVersion:version,requestGeneration:version,baseDocumentVersion:1,documentVersion:null,controlEpoch:0,contentSha256:codec.contentSha256(content)}});
const diagnostic=(d=doc()):DiagnosticsResult=>({sourceStamp:d.stamp,presentationStamp:d.stamp,association:null,truncated:false,
  provenance:{kind:'IMMUTABLE_GENERATION',launchId:'launch1',lspVersion:1,inputManifestSha256:hash},
  items:[{severity:'ERROR',message:MISSING+' cannot be resolved to a variable',code:'undefined',range:{startLine:3,startColumn:1,endLine:3,endColumn:20}}]});
function plan():ImportPlan {
  const cases=([['java21','java-maven-21'],['java27','java-maven-27'],['python313','python-3.13']] as const).map(([id,profileId])=>({id,profileId,
    configPath:'/input/config/'+id+'.json',sourceRoot:'/input/source/'+id,sourceFiles:[{path:'main.py',bytes:1,sha256:hash}],
    run:{kind:'RUN_MAIN' as const,timeoutMs:1000,task:{workingDirectory:'.',entry:{kind:'SCRIPT' as const,path:'main.py'},tests:{paths:[],names:[]}}},
    document:{path:'main.py',bad:'import pytest\nvalue.undo()\n'+MISSING+'\n',good:'import pytest\nvalue.undo()\n',completion:{line:2,column:8,identifier:'undo'}},
    dependency:{path:id==='python313'?'site-packages/pytest/__init__.py':'m2/junit.jar',sha256:hash,importLine:'import pytest'}}));
  return {schemaVersion:1,policy:'PRODUCTION_IMPORT_ONLY_NO_PREPARE',sourceRevision:'1'.repeat(40),expectedEngineId:'engine',
    dockerExecutable:'/usr/bin/docker',evidenceRoot:'/output/fresh',languageReceiptPath:'/input/language-receipt.json',preparedOutputRoots:['/input/prepared'],
    frozenInputs:[{path:'/input/config/java21.json',sha256:hash}],cases};
}
test('new plan validator admits only fixed 3-profile bounded subset; pure validation is NOT readiness',()=>{
  validateImportPlan(plan());assert.equal(PROOF_BUDGET.activeMs,180000);assert.equal(PROOF_BUDGET.maxContainers,9);assert.equal(PROOF_BUDGET.simultaneous,2);
});
for(const mutation of ['missing-case','overlap','duplicate-root','unfrozen','traversal','missing-marker','invalid-position','missing-import'] as const)
  test('new plan refuses '+mutation+' before any subprocess/Docker',()=>{
    const p=plan();
    if(mutation==='missing-case')p.cases.pop();
    if(mutation==='overlap')p.evidenceRoot=p.cases[0].sourceRoot+'/output';
    if(mutation==='duplicate-root')p.preparedOutputRoots.push(p.preparedOutputRoots[0]);
    if(mutation==='unfrozen')p.frozenInputs[0].sha256='not hash';
    if(mutation==='traversal')p.cases[0].document.path='../main.py';
    if(mutation==='missing-marker')p.cases[0].document.good=p.cases[0].document.bad;
    if(mutation==='invalid-position')p.cases[0].document.completion.column=999;
    if(mutation==='missing-import')p.cases[0].dependency.importLine='import imaginary';
    assert.throws(()=>validateImportPlan(p));
  });
test('new diagnostic oracle requires exact fresh immutable ERROR, not warning/empty/foreign/truncated',()=>{
  const d=doc(),r=diagnostic(d);assert.equal(diagnosticMatches(r,d,'error'),true);
  for(const mutate of [(r:DiagnosticsResult)=>{r.items=[];},(r:DiagnosticsResult)=>{r.items[0].severity='WARNING';},
    (r:DiagnosticsResult)=>{Object.assign(r,{sourceStamp:{...r.sourceStamp,localModelVersion:2}});},(r:DiagnosticsResult)=>{r.items[0].range.startLine=1;},
    (r:DiagnosticsResult)=>{r.truncated=true;},(r:DiagnosticsResult)=>{r.items[0].message='unrelated error';},
    (r:DiagnosticsResult)=>{Object.assign(r,{provenance:{kind:'VERSIONED_PUSH',lspVersion:1,inputManifestSha256:hash}});}]) {
    const bad=structuredClone(r);mutate(bad);assert.equal(diagnosticMatches(bad,d,'error'),false);
  }
});
test('new clear oracle rejects original invalidation-empty, dependency warnings and old launch',()=>{
  const bad=doc(),good=doc('import pytest\nvalue.undo()\n',2),r=diagnostic(good);r.items=[];
  assert.equal(diagnosticMatches(r,good,'clear','launch0'),true);
  assert.equal(diagnosticMatches({...diagnostic(bad),items:[]},good,'clear','launch0'),false);
  assert.equal(diagnosticMatches(r,good,'clear','launch1'),false);
  r.items=[{...diagnostic().items[0],severity:'WARNING',message:'not on classpath'}];
  assert.equal(diagnosticMatches(r,good,'clear','launch0'),false);
});
test('new completion oracle matches actual inserted identifier and exact stamp/path, never label-only',()=>{
  const d=doc(),r:CompleteResult={requestId:'q',stamp:d.stamp,isIncomplete:false,items:[{id:'i',label:'undo',detail:null,
    primary:{path:'main.py',text:'undo()',range:{startLine:2,startColumn:7,endLine:2,endColumn:11}},additionalTextEdits:[]}]};
  assert.equal(completionMatches(r,d,'undo'),true);
  for(const text of ['','other','undoing()']) {const bad=structuredClone(r);bad.items[0].primary.text=text;assert.equal(completionMatches(bad,d,'undo'),false);}
  const stale=structuredClone(r);stale.stamp.localModelVersion++;assert.equal(completionMatches(stale,d,'undo'),false);
});
const frame=(value:unknown)=>{const b=Buffer.from(JSON.stringify(value));return Buffer.concat([Buffer.from('Content-Length: '+b.length+'\r\n\r\n'),b]);};
const initialized=(t:PassiveImportTrace)=>{
  t.observe('client',frame({jsonrpc:'2.0',id:'init',method:'initialize',params:{}}));
  t.observe('server',frame({jsonrpc:'2.0',id:'init',result:{capabilities:{}}}));
};
const opened=(t:PassiveImportTrace,d:OpenOrChange)=>t.observe('client',frame({jsonrpc:'2.0',method:'textDocument/didOpen',params:{textDocument:{uri:codec.toWorkspaceUri(d.stamp.path),text:d.content}}}));
test('new passive trace split framing waits for exact sent bytes AND matched JDT project response',()=>{
  const t=new PassiveImportTrace('file:///workspace'),d=doc();initialized(t);opened(t,d);assert.equal(t.ready(d,false),true);assert.equal(t.ready(d,true),false);
  t.observe('server',frame({jsonrpc:'2.0',id:'foreign',result:['file:///workspace']}));assert.equal(t.ready(d,true),false);
  t.observe('client',frame({jsonrpc:'2.0',id:'projects',method:'workspace/executeCommand',params:{command:'java.project.getAll',arguments:[]}}));
  const bytes=frame({jsonrpc:'2.0',id:'projects',result:['file:///workspace/']});for(const byte of bytes)t.observe('server',Buffer.from([byte]));
  assert.equal(t.ready(d,true),true);const next=doc('new text',2);assert.equal(t.ready(next,true),false);
  t.observe('client',frame({jsonrpc:'2.0',method:'textDocument/didChange',params:{textDocument:{uri:codec.toWorkspaceUri(d.stamp.path)},contentChanges:[{text:next.content}]}}));
  assert.equal(t.ready(next,true),true);assert.equal(t.ready(d,true),false);
});
for(const negative of ['duplicate-length','oversize','wrong-project','error-response'] as const)
  test('new passive trace refuses '+negative+' without sending RPC',()=>{
    const t=new PassiveImportTrace('file:///workspace'),d=doc();initialized(t);opened(t,d);
    if(negative==='duplicate-length')t.observe('server',Buffer.from('Content-Length: 2\r\nContent-Length: 2\r\n\r\n{}'));
    if(negative==='oversize')t.observe('server',Buffer.from('Content-Length: 999999999\r\n\r\n'));
    if(negative==='wrong-project'||negative==='error-response') {
      t.observe('client',frame({jsonrpc:'2.0',id:'p',method:'workspace/executeCommand',params:{command:'java.project.getAll'}}));
      t.observe('server',frame({jsonrpc:'2.0',id:'p',...(negative==='wrong-project'?{result:['file:///other']}:{error:{code:-1,message:'failed'}})}));
    }
    assert.equal(t.invalid,true);assert.equal(t.ready(d,true),false);
  });

test('new proof inventory includes excluded-looking raw cache files and detects mutation/link',t=>{
 const root=mkdtempSync(join(process.env.TMPDIR??tmpdir(),'proof-inventory-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 mkdirSync(join(root,'target'));writeFileSync(join(root,'target','binary'),Buffer.from([0,255]));
 const before=rawDependencyInventory(root);assert.equal(before[0].path,'target/binary');assert.equal(before[0].bytes,2);
 writeFileSync(join(root,'target','binary'),Buffer.from([255,0]));assert.notDeepEqual(rawDependencyInventory(root),before);
 symlinkSync(join(root,'target','binary'),join(root,'link'));assert.throws(()=>rawDependencyInventory(root));
});
