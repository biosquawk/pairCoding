import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {gzipSync} from 'node:zlib';
import {stageInputs,npmFiles} from '../../scripts/runtime-stage-inputs.mjs';
const sha=(b:Buffer)=>createHash('sha256').update(b).digest('hex');
function fixture(name='package/package.json') {
 const content=Buffer.from('{}'),header=Buffer.alloc(512);header.write(name);header.write(content.length.toString(8).padStart(11,'0')+'\0',124);header[156]=48;header.fill(32,148,156);let sum=0;for(const x of header)sum+=x;header.write(sum.toString(8).padStart(6,'0')+'\0 ',148);
 const bytes=gzipSync(Buffer.concat([header,content,Buffer.alloc(512-content.length+1024)]));
 const a={kind:'npm',name:'fixture',url:'https://registry.npmjs.org/fixture/-/fixture-1.0.0.tgz',bytes:bytes.length,sha256:sha(bytes),integrity:'sha512-'+createHash('sha512').update(bytes).digest('base64'),files:[{path:'package.json',sha256:sha(content)}]};
 return {bytes,a,lock:{artifacts:[a],language:{artifacts:[]}}};
}
const root=()=>fs.mkdtempSync(path.join(process.env.TMPDIR!,'stage-unit-'));
test('UNIT staging exact bytes/inventory and exclusive output, synthetic download only (no network/tool/Docker)',async()=>{
 const {bytes,lock}=fixture(),out=path.join(root(),'out'),fetcher=async()=>new Response(bytes);
 const result=await stageInputs(out,{lock,fetcher});assert.equal(result.status,'STAGED_NOT_PREPARED');assert.equal(fs.readFileSync(path.join(out,'stage/tools/node_modules/fixture/package.json'),'utf8'),'{}');
 await assert.rejects(stageInputs(out,{lock,fetcher}),/EEXIST/);
});
test('UNIT staging rejects hash mismatch, nonofficial URL before fetch, archive traversal, duplicate inventory',async()=>{
 const f=fixture(),out=path.join(root(),'out');f.lock.artifacts[0].sha256='a'.repeat(64);
 await assert.rejects(stageInputs(out,{lock:f.lock,fetcher:async()=>new Response(f.bytes)}),/hash differ/);
 assert.equal(JSON.parse(fs.readFileSync(path.join(out,'download-journal/receipt.json'),'utf8')).status,'FAILED_NOT_PREPARED_RETAIN');
 const bad=fixture();bad.a.url='https://untrusted.invalid/file';await assert.rejects(stageInputs(path.join(root(),'out'),{lock:bad.lock,fetcher:async()=>{throw Error('Must not fetch');}}),/Unapproved/);
 const traversal=fixture('package/../escape');assert.throws(()=>npmFiles(traversal.bytes,traversal.a.files),/Unsafe/);
 assert.throws(()=>npmFiles(fixture().bytes,[]),/inventory differs/);
});
