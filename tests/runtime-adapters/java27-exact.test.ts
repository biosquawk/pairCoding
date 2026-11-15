/** Actual ROOT tool observation frozen here as UNIT fixture, not a Docker replay. */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { validateRuntimeCatalog } from '../../src/shared/validation-v2';
const repo=process.cwd(),read=(p:string)=>JSON.parse(fs.readFileSync(path.join(repo,p),'utf8'));
const actual=[{name:'java',version:'27.0.1.0.2'},{name:'javac',version:'27.0.1.0.2'}];
const matches=(expected:typeof actual,observed:typeof actual)=>expected.every(t=>observed.some(a=>a.name===t.name&&a.version===t.version));
test('same exact-version predicate: original metadata rejects actual tools, corrected agrees; near misses still reject',()=>{
 assert.equal(matches(actual.map(t=>({...t,version:'27.0.1.0'})),actual),false);
 const catalog=read('runtimes/catalog.json'),profile=catalog.profiles.find((p:any)=>p.id==='java-maven-27');
 assert.ok(validateRuntimeCatalog(catalog)); assert.ok(matches(profile.expectedTools.filter((t:any)=>['java','javac'].includes(t.name)),actual));
 for(const bad of ['27.0.1.0','27.0.1.0.3','27','26.0.1'])assert.equal(matches(actual,actual.map(t=>({...t,version:bad}))),false);
 for(const p of catalog.profiles.filter((p:any)=>p.adapterFamily==='java-maven'))assert.deepEqual(p.language,{provider:'builtin',imageLockKey:null,serverJvm:null});
 assert.equal(profile.compilerRelease,27);
 const lock=read('runtimes/production-inputs.lock.json');assert.deepEqual(lock.images.java27.observedTools,actual);
 assert.ok(lock.images.java27.env.includes('JAVA_VERSION=jdk-27.0.1.0'));assert.equal(lock.language.jdt.serverJvm,27);
});
test('generator output byte-exact approved catalog/task fragments; no actual installs or toolchain processes',t=>{
 const root=fs.mkdtempSync(path.join(process.env.TMPDIR??path.dirname(repo),'java27-generate-'));
 t.after(()=>fs.rmSync(root,{recursive:true,force:true}));fs.mkdirSync(path.join(root,'runtimes'));fs.mkdirSync(path.join(root,'examples'));
 const dirs=['javascript-counter','typescript-counter','python-calculator','java-pattern','spring-counter'];
 for(const dir of dirs)fs.mkdirSync(path.join(root,'examples',dir));
 const result=spawnSync(process.execPath,[path.join(repo,'scripts/runtime-generate-templates.mjs')],{cwd:root,env:{PATH:''},encoding:'utf8'});
 assert.equal(result.status,0,result.stderr);assert.deepEqual(fs.readFileSync(path.join(root,'runtimes/catalog.json')),fs.readFileSync(path.join(repo,'runtimes/catalog.json')));
 for(const dir of dirs)assert.deepEqual(fs.readFileSync(path.join(root,'examples',dir,'task.v2.json')),fs.readFileSync(path.join(repo,'examples',dir,'task.v2.json')));
 // LSP recipe assertions removed by Task1 owner064364a7; Run catalog/generator checks above retained.
});
