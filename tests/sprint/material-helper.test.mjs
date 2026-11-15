import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {selectTasks,main} from '../../scripts/verify-learning-pack.mjs';
const root=fileURLToPath(new URL('../../',import.meta.url));
const pack=JSON.parse(fs.readFileSync(path.join(root,'learning-packs/rest-spring/curriculum.json'),'utf8'));
const temporary=t=>{const dir=fs.mkdtempSync(path.join(os.tmpdir(),'material-helper-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return dir;};
test('explicit IDs preserve order and reject empty, duplicate, unknown and malformed lists',()=>{
 assert.deepEqual(selectTasks(pack,'validate-input,map-dto').map(t=>t.id),['validate-input','map-dto']);
 for(const ids of [undefined,'','map-dto,','map-dto,map-dto','missing','../map-dto',' map-dto'])assert.throws(()=>selectTasks(pack,ids));
});
test('verify requires explicit IDs before creating output or calling Docker',t=>{
 const dir=temporary(t),out=path.join(dir,'output');
 for(const args of [['verify',out,dir],['verify',out,dir,'--ids',''],['verify',out,dir,'--ids','missing'],['stage',out,'--ids','map-dto,map-dto'],['stage',out,'--ids','map-dto','unexpected']]){
  assert.throws(()=>main(args));assert.equal(fs.existsSync(out),false);
 }
});
test('stage copies only selected exercises, leaves originals untouched and refuses overwrite',t=>{
 const dir=temporary(t),out=path.join(dir,'stage');
 main(['stage',out,'--ids','map-dto,validate-input']);
 assert.deepEqual(fs.readdirSync(out).sort(),['map-dto','validate-input']);
 for(const id of fs.readdirSync(out)){
  const settings=fs.readFileSync(path.join(out,id,'settings.v2.json'));
  assert.deepEqual(fs.readFileSync(path.join(out,id,'.paircoach/settings.json')),settings);
  assert.equal(fs.existsSync(path.join(out,id,'references')),false);
  assert.deepEqual(fs.readFileSync(path.join(out,id,'src/main/java/demo/ApiApplication.java')),fs.readFileSync(path.join(root,'learning-packs/rest-spring/tasks',id,'src/main/java/demo/ApiApplication.java')));
 }
 assert.throws(()=>main(['stage',out,'--ids','map-dto']),/already exists/);
});
// Simulation tests CLI ownership/limits/oracle accounting, NOT Java compilation or MATERIAL evidence.
function fakeDocker(t,counts={tests:1,errors:0,skipped:0},referenceFails=false){
 const dir=temporary(t),bin=path.join(dir,'bin');fs.mkdirSync(bin);
 const docker=path.join(bin,'docker');
 fs.writeFileSync(docker,`#!${process.execPath}\nimport fs from 'node:fs';\nimport path from 'node:path';
const args=process.argv.slice(2),stateFile=${JSON.stringify(path.join(dir,'state.json'))},calls=${JSON.stringify(path.join(dir,'calls.jsonl'))};
fs.appendFileSync(calls,JSON.stringify(args)+'\\n');
if(args[0]==='create'){
 const name=args[args.indexOf('--name')+1],id=(name.includes('missing')?'b':'a').repeat(64);
 const artifact=args.find(a=>a.includes('target=/artifacts')).split(',')[1].slice(7);
 const input=args.find(a=>a.includes('target=/input')).split(',')[1].slice(7);
 const reference=input.includes('-reference/');
 fs.mkdirSync(path.join(artifact,'junit'));
 fs.writeFileSync(path.join(artifact,'junit/TEST-demo.ApiContractTest.xml'),'<testsuite tests="${counts.tests}" errors="${counts.errors}" skipped="${counts.skipped}" failures="'+(reference?${referenceFails?1:0}:1)+'"/>');
 fs.writeFileSync(stateFile,JSON.stringify({Id:id,Config:{Image:args[args.length-4],Labels:{'paircoach.material':name}},State:{Running:false,ExitCode:reference?${referenceFails?1:0}:1}}));console.log(id);
}else if(args[0]==='inspect')console.log('['+fs.readFileSync(stateFile,'utf8')+']');
`,{mode:0o755});
 const prepared=path.join(dir,'prepared');fs.mkdirSync(prepared);
 fs.writeFileSync(path.join(prepared,'receipt.json'),JSON.stringify({status:'PREPARED_REQUIRES_OFFLINE_AND_TOOL_VALIDATION',imageId:'sha256:'+'1'.repeat(64),request:{family:'java-maven',workingDirectory:'.'},cacheEvidence:{root:dir}}));
 const out=path.join(dir,'evidence');
 const result=spawnSync(process.execPath,['scripts/verify-learning-pack.mjs','verify',out,prepared,'--ids','map-dto'],{cwd:root,encoding:'utf8',env:{...process.env,PATH:bin+path.delimiter+process.env.PATH}});
 return {result,out,calls:JSON.parse('['+fs.readFileSync(path.join(dir,'calls.jsonl'),'utf8').trim().split('\n').join(',')+']')};
}
test('verify CLI keeps exact test oracle, selected-only accounting and Docker limits (simulated)',t=>{
 const {result,out,calls}=fakeDocker(t);assert.equal(result.status,0,result.stderr);
 const evidence=JSON.parse(fs.readFileSync(path.join(out,'results.json'),'utf8'));
 assert.deepEqual(evidence.selectedTaskIds,['map-dto']);assert.equal(evidence.results.length,1);
 assert.equal(evidence.results[0].pair[0].testSha256,evidence.results[0].pair[1].testSha256);
 for(const create of calls.filter(c=>c[0]==='create'))for(const arg of ['--pull=never','--network=none','--cap-drop=ALL','--read-only','--memory=2g','--cpus=2','--pids-limit=256','--log-driver=json-file','--log-opt=max-size=10m','--log-opt=max-file=3'])assert(create.includes(arg),arg);
 assert.equal(calls.filter(c=>c[0]==='rm').length,2);
});
for(const [name,counts,referenceFails] of [['zero tests',{tests:0,errors:0,skipped:0},false],['errors',{tests:1,errors:1,skipped:0},false],['skips',{tests:1,errors:0,skipped:1},false],['red reference',{tests:1,errors:0,skipped:0},true]])test('verify rejects '+name+' and preserves failure artifacts (simulated)',t=>{
 const {result,out,calls}=fakeDocker(t,counts,referenceFails);assert.notEqual(result.status,0);
 assert.equal(fs.existsSync(path.join(out,'results.json')),false);assert.equal(fs.existsSync(path.join(out,'cleanup.json')),true);
 assert.equal(calls.filter(c=>c[0]==='rm').length,referenceFails?1:0);
});
