import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {stageInputs} from '../../scripts/runtime-stage-inputs.mjs';
import {buildPublicPreparePlan} from '../../scripts/runtime-prepare-cli.mjs';
import {buildOperatorPlan} from '../../scripts/runtime-operator.mjs';
const hash=b=>createHash('sha256').update(b).digest('hex');

test('LIGHT cold staging: real verified execution wheel is staged, language getter never read; bad hash remains rejected',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'light-stage-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const bytes=Buffer.from('UNIT wheel contents; no network proof'),artifact={kind:'wheel',name:'pytest',filename:'pytest-8.4.2-py3-none-any.whl',bytes:bytes.length,sha256:hash(bytes),url:'https://files.pythonhosted.org/pytest.whl'};
  const lock={artifacts:[artifact],get language(){throw Error('Retired language metadata accessed');}};let calls=0;
  const fetcher=async url=>{calls++;assert.equal(url,artifact.url);return {ok:true,url,body:(async function*(){yield bytes;})()};};
  const output=path.join(root,'stage');const receipt=await stageInputs(output,{lock,fetcher});
  assert.equal(receipt.status,'STAGED_NOT_PREPARED');assert.equal(calls,1);assert.deepEqual(receipt.artifacts,[{name:'pytest',sha256:hash(bytes),bytes:bytes.length}]);
  assert.deepEqual(fs.readFileSync(path.join(output,'stage/wheels',artifact.filename)),bytes);assert.equal(fs.existsSync(path.join(output,'stage/language')),false);
  await assert.rejects(stageInputs(path.join(root,'bad'),{lock:{artifacts:[{...artifact,sha256:'0'.repeat(64)}]},fetcher}),/hash differ/);
});

test('LIGHT public cold prepare plans all seven profiles with no LSP assets, writes or children',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'light-prepare-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const profiles=[['javascript-node','javascript-counter'],['typescript-node','typescript-counter'],['python-3.13','python-calculator'],...[11,17,21,27].map(n=>['java-maven-'+n,'java-pattern'])];
  for(const [profile,example] of profiles){
    const project=path.join(root,profile);fs.cpSync(path.resolve('examples',example),project,{recursive:true});
    fs.mkdirSync(path.join(project,'.paircoach'),{mode:0o700});
    fs.writeFileSync(path.join(project,'.paircoach/settings.json'),JSON.stringify({schemaVersion:2,taskFilePath:null,taskMode:'IMPLEMENTATION',reviewNotesPath:'review.md',contextPatterns:[],aiConsent:false,runProfiles:JSON.parse(fs.readFileSync(path.join(project,'task.v2.json'))).runProfiles}));
    const output=path.join(root,profile+'-out'),argv=['--project',project,'--profile',profile,'--output',output];
    const plan=await buildPublicPreparePlan(argv);assert.equal(plan.languageRequired,null);assert.equal(plan.profile.language.provider,'builtin');assert.equal(plan.offlineFixtureContainers,0);assert.equal(fs.existsSync(output),false);
    assert.ok(plan.request.expectedTools.every(t=>!['pylsp','jdt'].includes(t.name)));
    const child=spawnSync(process.execPath,['--permission','--allow-fs-read=*',path.resolve('scripts/runtime-prepare-cli.mjs'),...argv],{env:{PATH:'',HOME:root},encoding:'utf8'});
    assert.equal(child.status,0,child.stderr);assert.equal(JSON.parse(child.stdout).languageRequired,null);assert.equal(fs.existsSync(output),false);
  }
  const plan=buildOperatorPlan(path.join(root,'operator'));
  assert.deepEqual(plan.language,[]);assert.ok(plan.jobs.every(j=>j.profile.language.provider==='builtin'));
});
