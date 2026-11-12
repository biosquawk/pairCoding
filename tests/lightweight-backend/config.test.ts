import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import catalog from '../../runtimes/catalog.json';
import {loadRuntimeConfiguration} from '../../src/server/runtime-config';
import {validateRuntimeProfile,validateRuntimeCatalog,validateCatalogImageReferences} from '../../src/shared/validation-v2';

export const measuredLock = () => ({schemaVersion:1,images:catalog.profiles.map(p=>({key:p.imageLockKey,
  image:'paircoach/runtime-'+p.id+':unit',imageId:'sha256:'+'a'.repeat(64),digest:'sha256:'+'b'.repeat(64),tools:p.expectedTools}))});

test('LIGHT config: all seven builtin profiles load with execution-only lock, relative paths and explicit precedence',t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'light-config-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const lock=measuredLock();fs.writeFileSync(path.join(root,'catalog.json'),JSON.stringify(catalog));fs.writeFileSync(path.join(root,'images.json'),JSON.stringify(lock));
  assert.equal(validateRuntimeCatalog(catalog),true);assert.equal(validateCatalogImageReferences(catalog,lock),true);
  assert.equal(catalog.profiles.length,7);
  for(const profile of catalog.profiles){
    assert.deepEqual(profile.language,{provider:'builtin',imageLockKey:null,serverJvm:null});
    const config={schemaVersion:1,activeProfile:profile.id,workspaceRoot:'workspace',runtimeCatalog:'catalog.json',imageLock:'images.json',languageFeatures:{completion:false,diagnostics:true},execution:{backend:'docker',pullPolicy:'never'}};
    const configPath=path.join(root,'runtime.json');fs.writeFileSync(configPath,JSON.stringify(config));
    const first=loadRuntimeConfiguration({configPath,environment:{}});assert.ok(first.resolved);assert.equal(first.resolved.languageImage,null);
    assert.equal(first.resolved.workspaceRoot,path.join(root,'workspace'));assert.deepEqual(first.resolved.config.languageFeatures,config.languageFeatures);
    const second=loadRuntimeConfiguration({configPath,environment:{PAIRCOACH_RUNTIME_PROFILE:'javascript-node',PAIRCOACH_WORKSPACE_DIR:'env-workspace'},explicitWorkspaceRoot:path.join(root,'gui-workspace')});
    assert.equal(second.resolved?.profile.id,'javascript-node');assert.equal(second.resolved?.workspaceRoot,path.join(root,'gui-workspace'));
    assert.notEqual(second.configurationGeneration,first.configurationGeneration);
    assert.equal(validateRuntimeProfile({...profile,language:{...profile.language,imageLockKey:'jdt-runtime-27'}}),false);
    if(profile.compilerRelease)assert.equal(validateRuntimeProfile({...profile,analysis:{...profile.analysis,languageLevel:'1'}}),false);
  }
});

test('LIGHT generator: fresh templates reproduce seven local profiles without changing task templates',t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'light-generator-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  fs.mkdirSync(path.join(root,'runtimes'));
  fs.cpSync('examples',path.join(root,'examples'),{recursive:true});
  const before=fs.readdirSync(path.join(root,'examples')).filter(dir=>fs.statSync(path.join(root,'examples',dir)).isDirectory()).map(dir=>[dir,fs.readFileSync(path.join(root,'examples',dir,'task.v2.json'),'utf8')]);
  const child=spawnSync(process.execPath,[path.resolve('scripts/runtime-generate-templates.mjs')],{cwd:root,encoding:'utf8'});
  assert.equal(child.status,0,child.stderr);assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root,'runtimes/catalog.json'),'utf8')),catalog);
  for(const [dir,bytes] of before)assert.equal(fs.readFileSync(path.join(root,'examples',dir,'task.v2.json'),'utf8'),bytes);
});

test('LIGHT selected-only assets: full seven-profile catalog loads Java21 only; absent inactive pins are not required, supplied bad pins still fail',t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'light-selected-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  fs.writeFileSync(path.join(root,'catalog.json'),JSON.stringify(catalog));
  const only={schemaVersion:1,images:measuredLock().images.filter(i=>i.key==='java-maven-21')};
  const lock=path.join(root,'images.json');fs.writeFileSync(lock,JSON.stringify(only));
  const configPath=path.join(root,'runtime.json');fs.writeFileSync(configPath,JSON.stringify({schemaVersion:1,activeProfile:'java-maven-21',workspaceRoot:'workspace',runtimeCatalog:'catalog.json',imageLock:'images.json',languageFeatures:{completion:true,diagnostics:true},execution:{backend:'docker',pullPolicy:'never'}}));
  assert.equal(validateCatalogImageReferences(catalog,only),false,'default complete cross-file contract remains strict');
  const selected=loadRuntimeConfiguration({configPath,environment:{}});assert.equal(selected.resolved?.profile.id,'java-maven-21');assert.equal(selected.resolved?.languageImage,null);
  assert.equal(loadRuntimeConfiguration({configPath,environment:{PAIRCOACH_RUNTIME_PROFILE:'java-maven-27'}}).resolved,null,'profile27 still needs its real pin; no fabricated readiness');
  const bad=measuredLock().images.find(i=>i.key==='python-3.13')!;bad.tools[0].version='wrong';
  fs.writeFileSync(lock,JSON.stringify({schemaVersion:1,images:[...only.images,bad]}));assert.equal(loadRuntimeConfiguration({configPath,environment:{}}).resolved,null,'supplied inactive mismatches are not silently accepted');
  fs.writeFileSync(lock,JSON.stringify(only));const broken=structuredClone(catalog);broken.profiles[0].analysis.preview=true;broken.profiles[0].compilerRelease=21;
  fs.writeFileSync(path.join(root,'catalog.json'),JSON.stringify(broken));assert.equal(loadRuntimeConfiguration({configPath,environment:{}}).resolved,null,'whole inactive profile semantics stay validated');
});
