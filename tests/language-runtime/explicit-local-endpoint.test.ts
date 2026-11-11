/** Controlled spawner UNIT ONLY: no Docker invocation. Old driver tests are unchanged. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { DockerLanguageDriver } from '../../src/server/language/DockerLanguageDriver';
const host=process.platform==='win32'?'npipe:////./pipe/docker_engine':'unix:///var/run/docker.sock';
test('explicit approved local endpoint prefixes actual language info argv with sanitized env',async t=>{
 const dir=mkdtempSync(join(process.env.TMPDIR??tmpdir(),'explicit-endpoint-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const calls:any[]=[];
 const driver=new DockerLanguageDriver({executable:'/trusted/docker',dockerConfigDirectory:dir,host,spawn:(exe,args,opts)=>{
   calls.push({exe,args,opts});const c=Object.assign(new EventEmitter(),{stdin:new PassThrough(),stdout:new PassThrough(),stderr:new PassThrough(),kill:()=>true});
   queueMicrotask(()=>{c.stdout.end('"engine"');c.stderr.end();c.emit('close',0);});return c as any;
 }});
 assert.equal(await driver.engineId(),'engine');assert.deepEqual(calls[0].args,['--host',host,'info','--format','{{json .ID}}']);
 assert.equal(calls[0].opts.shell,false);assert.deepEqual(Object.keys(calls[0].opts.env).sort(),process.platform==='win32'&&process.env.SystemRoot?['DOCKER_CONFIG','SystemRoot']:['DOCKER_CONFIG']);
});
test('explicit endpoint refuses remote/socket alternative and context mixture before spawn',t=>{
 const dir=mkdtempSync(join(process.env.TMPDIR??tmpdir(),'explicit-endpoint-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 for(const options of [{host:''},{host:'tcp://remote:2375'},{host:'unix:///tmp/other.sock'},{host,context:'default'}]) {
   assert.throws(()=>new DockerLanguageDriver({executable:'/trusted/docker',dockerConfigDirectory:dir,...options,spawn:()=>{throw Error('MUST NOT SPAWN');}}),/approved explicit local/);
 }
});
