// Same exact-ID oracle for old raw cleanup block and new exported cleanup used by operator.
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import assert from 'node:assert/strict';
const source=path.resolve(process.argv[2]),text=fs.readFileSync(source,'utf8');let cleanup;
if(text.includes('export function cleanupOfflineFixture'))cleanup=(await import(pathToFileURL(source).href)).cleanupOfflineFixture;
else {
 const start=text.indexOf('    const final=JSON.parse('),end=text.indexOf("entry.status='OFFLINE_FIXTURE_SMOKE_PASS_REMOVED'",start);
 assert.ok(start>=0 && end>start);const exactOldBlock=text.slice(start,end);
 cleanup=new Function('state','imageId','run',"const prepared={imageId},name='reusable-container-name';\n"+exactOldBlock);
}
const id='a'.repeat(64),imageId='sha256:'+'b'.repeat(64),state={Id:id,State:{Running:false,ExitCode:0},Config:{Image:imageId,Labels:{'paircoach.installation':'stage09-runtime-assets','paircoach.role':'offline-smoke'}}},seen=[];
cleanup(state,imageId,args=>{seen.push(args);return {stdout:JSON.stringify([state])};});
assert.deepEqual(seen.at(-1),['rm',id]);
const mismatch={...state,Id:'c'.repeat(64)},bad=[];
assert.throws(()=>cleanup(state,imageId,args=>{bad.push(args);return {stdout:JSON.stringify([mismatch])};}),/identity/);
assert.equal(bad.some(args=>args[0]==='rm'),false);
console.log(JSON.stringify({scope:'UNIT_EXACT_CLEANUP_BLOCK_NOT_DOCKER_PROOF',cleanup:seen,mismatch:'REFUSED_WITHOUT_RM'}));
