import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {XMLParser,XMLValidator} from 'fast-xml-parser';
import {buildOperatorPlan,junitSmoke,correctedExercise} from '../../scripts/runtime-operator.mjs';
import {validateProductionRequest} from '../../scripts/runtime-prepare.mjs';
const root='/operator-owned/stage09';
test('production plan is deterministic/no operations: seven profiles, nine example-target caches, official immutable pins',()=>{
 const p=buildOperatorPlan(root);assert.deepEqual(p,buildOperatorPlan(root));assert.equal(p.maxHeavyConcurrency,1);assert.equal(p.jobs.length,9);assert.equal(new Set(p.jobs.map((j:any)=>j.profile.id)).size,7);
 for(const j of p.jobs){const fixed=correctedExercise(j);assert.deepEqual(fixed.filter((f:any,i:number)=>f.sha256!==j.assets[i].sha256).map((f:any)=>f.path),[j.correction.path]);assert.match(j.request.baseImage,/@sha256:[a-f0-9]{64}$/);validateProductionRequest(j.request);
   for(const a of j.assets)assert.equal(createHash('sha256').update(Buffer.from(a.bytes,'base64')).digest('hex'),a.sha256);
   if(j.profile.compilerRelease){const pom=Buffer.from(j.assets.find((a:any)=>a.path==='pom.xml').bytes,'base64').toString();assert.equal(pom,readFileSync(`examples/${j.example}/pom.xml`,'utf8'));assert.ok(pom.includes(`<maven.compiler.release>${j.example==='java-pattern'?11:21}</maven.compiler.release>`));assert.equal(j.profile.expectedTools.find((t:any)=>t.name==='maven').version,'3.9.12');}
 }
 const n=structuredClone(p.jobs[0].request);n.baseImage='node@sha256:'+'a'.repeat(64);assert.throws(()=>validateProductionRequest(n),/pin differs/);
 const wrong=structuredClone(p.jobs[0].request);wrong.tools.files[0].sha256='a'.repeat(64);assert.throws(()=>validateProductionRequest(wrong),/inventory differs/);
});
test('pytest real transitive Linux3.13 hashlock exactly matches official wheel lock; image readiness remains NOTREADY',()=>{
 const lock=JSON.parse(readFileSync('runtimes/production-inputs.lock.json','utf8')),requirements=readFileSync('examples/python-calculator/requirements.txt','utf8');
 assert.equal(lock.readiness,'NOTREADY_UNTIL_HOST_RECEIPTS');assert.equal(lock.artifacts.filter((a:any)=>a.kind==='wheel').length,5);
 for(const a of lock.artifacts.filter((a:any)=>a.kind==='wheel')) {assert.ok(requirements.includes(`${a.name}==${a.version} --hash=sha256:${a.sha256}`));assert.match(a.url,/^https:\/\/files.pythonhosted.org\//);}
 assert.deepEqual(JSON.parse(readFileSync('runtimes/images.lock.json','utf8')).images,[]);
 const docker=readFileSync('docker/runtime.Dockerfile','utf8');assert.ok(docker.includes('FROM '+lock.images.maven.reference+' AS maven'));
});
test('offline smoke does not turn missing/zero/skipped/malformed/failure JUnit into success (not product oracle replacement)',()=>{
 const parse=(xml:string)=>[{xml,parser:XMLParser,validator:XMLValidator}];
 assert.equal(junitSmoke(parse('<testsuite tests="1"><testcase name="x"/></testsuite>'),false).tests,1);
 assert.equal(junitSmoke(parse('<testsuite tests="1"><testcase><failure/></testcase></testsuite>'),true).failures,1);
 assert.throws(()=>junitSmoke([],false));
 for(const xml of ['<testsuite tests="0"/>','<testsuite tests="1"><testcase><skipped/></testcase></testsuite>','<testsuite tests="1"><testcase><failure/></testcase></testsuite>','<notJUnit/>','<!DOCTYPE x><testsuite tests="0"/>','<testsuite>'])assert.throws(()=>junitSmoke(parse(xml),false));
});
// Task1 owner064364a7: retired LSP recipe test removed; history stays in Git.
