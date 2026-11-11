import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import type { RuntimeCatalog, RunProfileV2 } from '../../src/shared/runtime-v2';
import { validateRuntimeCatalog, validateSettingsV2 } from '../../src/shared/validation-v2';
import { createTaskRuntimeAdapterRegistry } from '../../src/server/runtime-adapters';
const catalog: RuntimeCatalog = JSON.parse(readFileSync('runtimes/catalog.json','utf8'));
const examples = ['javascript-counter','typescript-counter','python-calculator','java-pattern','spring-counter'];
const fragment = (example: string): { runProfiles: RunProfileV2[] } => JSON.parse(readFileSync(`examples/${example}/task.v2.json`,'utf8'));

test('catalog provides required complete discriminant-specific fields and optional selector lists, without changing pins',()=>{
  assert.equal(validateRuntimeCatalog(catalog),true);
  assert.equal(catalog.profiles.length,7);
  const branchFields: Record<string,string[]> = {SCRIPT:['entry.path'],MODULE:['entry.name'],JAVA_MAIN:['entry.className'],SPRING_BOOT:['entry.containerPort','entry.healthPath'],TESTS:[]};
  for(const p of catalog.profiles){
    const fields = new Map(p.taskFields.map(f=>[f.key,f]));
    assert.equal(fields.get('workingDirectory')?.required,true);
    assert.equal(fields.get('entry.kind')?.required,true);
    for(const key of ['tests.paths','tests.names'] as const) assert.equal(fields.get(key)?.required,false);
    const kinds = fields.get('entry.kind')!.choices.map(c=>c.value);
    assert.deepEqual(kinds,p.compilerRelease ? ['JAVA_MAIN',...([21,27].includes(p.compilerRelease)?['SPRING_BOOT']:[]),'TESTS'] : p.adapterFamily==='python'?['SCRIPT','MODULE','TESTS']:['SCRIPT','TESTS']);
    for(const kind of kinds) for(const key of branchFields[kind]) {
      const field=p.taskFields.find(f=>f.key===key);
      assert.ok(field,`${p.id}/${kind}: missing ${key}`); assert.equal(field.required,true);
    }
    const port=fields.get('entry.containerPort');
    if(kinds.includes('SPRING_BOOT')) {assert.equal(port?.input,'INTEGER');assert.equal(port.min,1);assert.equal(port.max,65535);}
    else assert.equal(port,undefined);
    assert.equal(fields.has('entry.name'),p.adapterFamily==='python');
  }
});

test('all seven examples and Spring21/27 remain structurally and adapter valid; selector guards stay authoritative',async()=>{
  const registry=createTaskRuntimeAdapterRegistry();
  for(const p of catalog.profiles){
    const example=p.compilerRelease?'java-pattern':p.adapterFamily==='node'?'javascript-counter':p.adapterFamily==='typescript'?'typescript-counter':'python-calculator';
    const base=fragment(example);
    const full={schemaVersion:2,taskFilePath:null,taskMode:'IMPLEMENTATION',reviewNotesPath:'REVIEW.md',aiConsent:false,contextPatterns:[],...base};
    assert.equal(validateSettingsV2(full),true);
    const adapter=registry.get(p);
    for(const run of base.runProfiles) assert.equal((await adapter.validate(p,run)).valid,true);
    const testRun=structuredClone(base.runProfiles.find(r=>r.kind==='RUN_TESTS')!);
    if(p.compilerRelease) testRun.task.tests.paths=['bad.java'];
    else testRun.task.tests.paths=[];
    assert.equal((await adapter.validate(p,testRun)).valid,false,`${p.id}: selector requirement was weakened`);
    const invalid=structuredClone(base.runProfiles[0]);
    if(p.compilerRelease) invalid.task.entry={kind:'SPRING_BOOT',containerPort:0,healthPath:'/health'};
    else invalid.task.entry={kind:'SCRIPT',path:'../escape.py'};
    assert.equal((await adapter.validate(p,invalid)).valid,false);
    if(p.compilerRelease && [21,27].includes(p.compilerRelease)) for(const run of fragment('spring-counter').runProfiles) assert.equal((await adapter.validate(p,run)).valid,true);
    if(p.adapterFamily==='python'){
      const module=structuredClone(base.runProfiles[0]);module.task.entry={kind:'MODULE',name:'calculator'};
      assert.equal((await adapter.validate(p,module)).valid,true);
      module.task.entry={kind:'MODULE',name:''};assert.equal((await adapter.validate(p,module)).valid,false);
    }
  }
});

test('pure generator reproduces frozen catalog and all five original task fragments byte-exact',()=>{
  const root=mkdtempSync(join(tmpdir(),'descriptor-generate-'));
  try {
    mkdirSync(join(root,'runtimes'));for(const example of examples) mkdirSync(join(root,'examples',example),{recursive:true});
    const run=spawnSync(process.execPath,[resolve('scripts/runtime-generate-templates.mjs')],{cwd:root,encoding:'utf8'});
    assert.equal(run.status,0,run.stderr);
    for(const path of ['runtimes/catalog.json',...examples.map(e=>`examples/${e}/task.v2.json`)]) assert.deepEqual(readFileSync(join(root,path)),readFileSync(path),path);
  } finally {rmSync(root,{recursive:true,force:true});}
});
