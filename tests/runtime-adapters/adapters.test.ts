import { readRegularArtifact } from '../../src/server/runtime-adapters/outcome';
import { exportMavenReports } from '../../scripts/runtime-artifacts.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, writeFile, symlink, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { createTaskRuntimeAdapterRegistry, JavaMavenAdapter, TaskRuntimeAdapterRegistry, NodeAdapter, parseJUnit, interpretOutcome, readArtifact, dependencyHash } from '../../src/server/runtime-adapters/index';
import type { RuntimeProfile, RunProfileV2, AdapterFamily } from '../../src/shared/runtime-v2';
import type { PlanContext, ExecutionPlan, CollectedArtifacts, ExecutionExit } from '../../src/server/execution/ports';
import { parseJUnit as legacyParse } from '../../src/server/Runner';
import { verifyBuildCopy, buildChildEnvironment } from '../../scripts/runtime-task.mjs';
import { verifySelectedJdk } from '../../scripts/runtime-task.mjs';
import { inspectEffectivePom } from '../../scripts/runtime-pom.mjs';
import { validateSpec, encodeSpec, decodeSpec, canonicalJSON } from '../../scripts/runtime-spec.mjs';
import { validatePrepareRequest, prepare } from '../../scripts/runtime-prepare.mjs';
const sha=(s:string|Uint8Array)=>createHash('sha256').update(s).digest('hex'), H='a'.repeat(64), I='sha256:'+H;
const profile=(family:AdapterFamily='node',release:11|17|21|27|null=null):RuntimeProfile=>({id:family+(release??''),label:family,adapterFamily:family,imageLockKey:'fixture',expectedTools:['node',...(family==='typescript'?['typescript']:family==='python'?['python','pytest']:family==='java-maven'?['java','javac','maven']:[])].map(name=>({name,version:'fixture-only'})),compilerRelease:release,analysis:{languageLevel:String(release??'ES2022'),preview:false},language:family==='java-maven'?{provider:'jdt',imageLockKey:'jdt',serverJvm:'fixture-only'}:family==='python'?{provider:'pylsp',imageLockKey:'pylsp',serverJvm:null}:{provider:'builtin',imageLockKey:null,serverJvm:null},taskFields:[]});
const run=(family:AdapterFamily='node',kind:'RUN_MAIN'|'RUN_TESTS'='RUN_TESTS'):RunProfileV2=>({kind,timeoutMs:1000,task:{workingDirectory:'.',entry:family==='java-maven'?{kind:'JAVA_MAIN',className:'another.DifferentMain'}:{kind:'SCRIPT',path:family==='python'?'unrelated.py':family==='typescript'?'unrelated.ts':'unrelated.js'},tests:{paths:family==='java-maven'?[]:[family==='python'?'different_test.py':family==='typescript'?'different.test.ts':'different.test.js'],names:family==='java-maven'?['another.DifferentTest#works']:[]}}});
const context=(p:RuntimeProfile,r:RunProfileV2=run(p.adapterFamily)):PlanContext=>({ownership:{installationId:'fixture',runId:'run-1',profileId:p.id,engineId:'fixture',containerName:'fixture',imageId:I},input:{projectId:'project',sessionId:'session',identity:{runId:'run-1',profileId:p.id,configurationGeneration:'gen',workspaceVersion:1,manifestSha256:H},files:[...r.task.tests.paths,...(r.task.entry.kind==='SCRIPT'?[r.task.entry.path]:[]),'pom.xml','tsconfig.json'].map(path=>({path,documentVersion:1,sha256:H,bytes:1})),immutableDirectory:'/fixture/input',buildDirectory:'/fixture/build',artifactsDirectory:'/fixture/artifacts'},profile:p,lockedImage:{key:'fixture',image:'fixture/runtime:fixture',imageId:I,digest:I,tools:p.expectedTools},caches:[{directory:'/fixture/cache',family:p.adapterFamily,toolchainHash:H,dependencyHash:dependencyHash(['pom.xml','tsconfig.json'].map(path=>({path,sha256:H}))),readOnly:true}]});
const preparedReader = async(file:string) => Buffer.from(file.endsWith('dependencies-prepared.json') ? JSON.stringify({family:'java-maven',workingDirectory:'.',dependencySha256:dependencyHash(context(profile('java-maven',21),run('java-maven')).input.files),tools:profile('java-maven',21).expectedTools}) : pom(file.includes('release') ? file.match(/release(\d+)/)![1] : '21'));
const javaDeps = (release:number) => ({readPreparedFile:async(file:string,max:number) => file.endsWith('effective-pom.xml') ? Buffer.from(pom(String(release))) : preparedReader(file)});
const decode=(p:ExecutionPlan)=>JSON.parse(Buffer.from(p.command.args[1],'base64url').toString());
test('registry: four families, ONE Java class parameterized 11/17/21/27; unrelated project selectors',async()=>{
 let reg=createTaskRuntimeAdapterRegistry();
 for(const family of ['node','typescript','python','java-maven'] as AdapterFamily[]) for(const release of family==='java-maven'?[11,17,21,27] as const:[null]) {
   reg=createTaskRuntimeAdapterRegistry(javaDeps(release??21));
   const p=profile(family,release),r=run(family),a=reg.get(p); assert.equal((await a.validate(p,r)).valid,true);
   if(family==='java-maven') assert.ok(a instanceof JavaMavenAdapter);
   const plan=await a.buildPlan(context(p,r),r); assert.equal(plan.command.executable,'/opt/paircoach/node/bin/node'); assert.equal(plan.command.workingDirectory,'/workspace');
   assert.equal(decode(plan).release,release); assert.deepEqual(decode(plan).task,r.task); assert.equal(plan.isolation.network,'none'); assert.equal(validateSpec(decode(plan)).runId,'run-1');
 }
 assert.throws(()=>new TaskRuntimeAdapterRegistry([new NodeAdapter(),new NodeAdapter()]));
 assert.throws(()=>new TaskRuntimeAdapterRegistry([]).get(profile()));
});
test('selectors are literal data; reject flags/globs/Maven DSL/traversal/unknown fields',async()=>{
 const a=new NodeAdapter(),p=profile();
 for(const path of ['--eval','../x.js','x/*.js','x;env.js','x\\y.js','/tmp/x.js','x/-flag.js','x\u0000.js']) {const r=run();r.task.tests.paths=[path];assert.equal((await a.validate(p,r)).valid,false,path);}
 const extra=run();(extra.task as any).executable='sh';assert.equal((await a.validate(p,extra)).valid,false);
 const j=run('java-maven');j.task.tests.names=['Demo,!Other'];assert.equal((await new JavaMavenAdapter().validate(profile('java-maven',21),j)).valid,false);
 const py=run('python');py.task.tests.names=['test_one'];assert.equal((await createTaskRuntimeAdapterRegistry().get(profile('python')).validate(profile('python'),py)).valid,false);
});
test('explicit tests-only selectors; service is Java21/27 task data with nonterminal loopback plan',async()=>{
 for(const family of ['node','python','java-maven'] as AdapterFamily[]) {
  const p=profile(family,family==='java-maven'?21:null),r=run(family);r.task.entry={kind:'TESTS'};r.task.tests.paths=[];
  const a=createTaskRuntimeAdapterRegistry().get(p);assert.equal((await a.validate(p,r)).valid,family==='java-maven');
 }
 for(const release of [11,17,21,27] as const) {
  const p=profile('java-maven',release),r=run('java-maven','RUN_MAIN');r.task.entry={kind:'SPRING_BOOT',containerPort:8123,healthPath:'/ready'};const a=new JavaMavenAdapter(javaDeps(release));
  assert.equal((await a.validate(p,r)).valid,release>=21);
  if(release>=21) {const plan=await a.buildPlan(context(p,r),r);assert.equal(plan.service?.bindHost,'127.0.0.1');assert.equal(plan.isolation.network,'loopback');assert.equal(plan.service.containerPort,8123);}
 }
});
test('plan rejects malformed/mismatched pins, tools, cache family/readiness, manifest or selected file',async()=>{
 const p=profile(),r=run(),a=new NodeAdapter();
 for(const modify of [(c:PlanContext)=>c.lockedImage.imageId='missing',(c:PlanContext)=>c.lockedImage.digest='missing',(c:PlanContext)=>c.lockedImage.tools=[],(c:PlanContext)=>c.caches=[],(c:PlanContext)=>c.caches[0].readOnly=false,(c:PlanContext)=>c.caches[0].family='python',(c:PlanContext)=>c.input.files=[],(c:PlanContext)=>c.input.identity={...c.input.identity,runId:'old-run'}]) {
  const c=structuredClone(context(p,r));modify(c);await assert.rejects(a.buildPlan(c,r));
 }
 const java=profile('java-maven',21);java.expectedTools=[{name:'node',version:'fixture'}];await assert.rejects(new JavaMavenAdapter().buildPlan(context(java,run('java-maven')),run('java-maven')),/tool versions/);
});
const xmls=[
 '<testsuite tests="1"><testcase name="a"/></testsuite>',
 '<testsuite tests="1" failures="1"><testcase><failure/></testcase></testsuite>',
 '<testsuite tests="1" errors="1"><testcase><error/></testcase></testsuite>',
 '<testsuite tests="1" skipped="1"><testcase><skipped/></testcase></testsuite>',
 '<testsuite tests="0"/>',
 '<testsuites tests="2"><testsuite tests="1"><testcase/></testsuite><testsuite tests="1"><testcase/></testsuite></testsuites>',
 '<testsuites tests="1"><testsuite><testsuite tests="1"><testcase/></testsuite></testsuite></testsuites>',
 '<testsuite tests="2"><testcase/></testsuite>',
 '<testsuite tests="1" failures="1" skipped="1"><testcase><failure/><skipped/></testcase></testsuite>',
 '<testsuite tests="-1"/>','<testsuite tests="1"/>','<testsuite tests="1"><testcase></testsuite>',
 '<testsuites><testcase/></testsuites>','<testsuite tests="0"/><testsuites/>',
 '<!DOCTYPE x [<!ENTITY x SYSTEM "file:///etc/passwd">]><testsuite tests="0"/>',
 '<!ENTITY x "x"><testsuite tests="0"/>','<testsuite tests="9007199254740992"/>',
];
test('pure parser preserves legacy conservative oracles with separate errors, bounded XML/entity/depth',()=>{
 for(const xml of xmls) {const old=legacyParse(xml),current=parseJUnit(xml);assert.deepEqual(current?{count:current.count,failures:current.failures+current.errors,skipped:current.skipped}:null,old,xml);}
 assert.equal(parseJUnit(' '.repeat(4*1024*1024+1)),null);
 assert.equal(parseJUnit('<testsuites>'+ '<testsuite>'.repeat(70)+'<testsuite tests="0"/>'+ '</testsuite>'.repeat(70)+'</testsuites>'),null);
});
async function outcome(xml:string|null,exitCode=0,modify?:(a:CollectedArtifacts)=>void,modifyPlan?:(p:ExecutionPlan)=>void) {
 const p=profile(),r=run(),c=context(p,r),root=path.join('/fixture/runs',c.ownership.runId);
 // Match the executor's run-owned sibling layout. JUnit is interpreted from the
 // immutable collection, NEVER from the container-writable artifacts directory.
 Object.assign(c.input,{immutableDirectory:path.join(root,'input'),buildDirectory:path.join(root,'build'),artifactsDirectory:path.join(root,'artifacts')});
 const plan=await new NodeAdapter().buildPlan(c,r),handle={runId:'run-1',opaqueId:'handle'};
 const a:CollectedArtifacts={handle,inputManifestSha256:H,collectionSha256:H,stdoutPath:path.join(root,'collected/stdout'),stderrPath:path.join(root,'collected/stderr'),tools:[],files:xml===null?[]:[{kind:'JUNIT_XML',path:path.join(root,'collected/files/run-1.xml'),sha256:sha(xml),bytes:Buffer.byteLength(xml),freshForRun:true}]};
 modify?.(a);modifyPlan?.(plan);return interpretOutcome(plan,{handle,exitCode,exitedAt:new Date().toISOString()},a,async()=>Buffer.from(xml??''));
}
test('current-input JUnit outcome: positive vs noXML/zero/allSkipped/nonzero/stale/mismatched bytes',async()=>{
 assert.equal((await outcome(xmls[0])).testOutcome,'PASSED');
 assert.equal((await outcome(null)).testOutcome,'UNKNOWN');
 assert.equal((await outcome(xmls[4])).testOutcome,'NO_TESTS');
 for(const [xml,code] of [[xmls[0],1],[xmls[3],0],[xmls[1],0],[xmls[2],0]] as const) {const o=await outcome(xml,code);assert.equal(o.testOutcome,'FAILED');assert.equal(o.status,'FAILED');}
 for(const alter of [(a:CollectedArtifacts)=>a.inputManifestSha256='old',(a:CollectedArtifacts)=>a.files[0].freshForRun=false,(a:CollectedArtifacts)=>a.files[0].path='/fixture/old.xml',(a:CollectedArtifacts)=>a.files[0].bytes++,(a:CollectedArtifacts)=>a.files[0].sha256='0'.repeat(64),(a:CollectedArtifacts)=>a.handle={runId:'old',opaqueId:'handle'},(a:CollectedArtifacts)=>a.files=[...a.files,a.files[0]]]) assert.notEqual((await outcome(xmls[0],0,alter)).testOutcome,'PASSED');
 // The positive fixture must not conceal the original layout guard: current
 // container output and another run's collected XML remain untrusted too.
 for(const location of ['/fixture/runs/run-1/artifacts/run-1.xml','/fixture/runs/old/collected/files/run-1.xml'])
   assert.notEqual((await outcome(xmls[0],0,a=>{a.files[0].path=location;})).testOutcome,'PASSED');
 for(const alter of [(p:ExecutionPlan)=>Object.assign(p.input,{immutableDirectory:'/fixture/input'}),
   (p:ExecutionPlan)=>Object.assign(p.input,{buildDirectory:'/fixture/other/build'}),
   (p:ExecutionPlan)=>Object.assign(p.input,{artifactsDirectory:'/fixture/other/artifacts'})])
   assert.notEqual((await outcome(xmls[0],0,undefined,alter)).testOutcome,'PASSED');
 assert.equal((await outcome(xmls[2])).errors,1);assert.equal((await outcome(xmls[1])).failures,1);
});
test('artifact reader uses actual regular files, rejects symlinks and bounded overread',async()=>{
 const root=await mkdtemp(path.join(process.env.TMPDIR!,'runtime-artifact-')),file=path.join(root,'fresh.xml');await writeFile(file,xmls[0]);
 assert.equal(Buffer.from(await readArtifact(file,4096)).toString(),xmls[0]);
 await assert.rejects(readArtifact(file,2));await symlink(file,path.join(root,'alias.xml'));await assert.rejects(readArtifact(path.join(root,'alias.xml'),4096));
 await mkdir(path.join(root,'dir'));await assert.rejects(readArtifact(path.join(root,'dir'),4096));
});
const pom=(release='21',configuration='')=>`<project><properties><maven.compiler.release>${release}</maven.compiler.release></properties><build><plugins><plugin><artifactId>maven-compiler-plugin</artifactId><version>3.14.0</version><configuration>${configuration}</configuration></plugin><plugin><artifactId>maven-surefire-plugin</artifactId><version>3.5.3</version></plugin></plugins></build></project>`;
test('effective-pom Maven target is independent of JDK; source/test/preview/toolchain guards retained',()=>{
 for(const r of [11,17,21,27]) assert.equal(inspectEffectivePom(pom(String(r)),r,false).release,r);
 for(const actualJDK of [11,17,21,27]) for(const target of [11,17,21,27]) {
  const model=inspectEffectivePom(pom(String(target)),actualJDK,false);
  assert.equal(model.actualJDK,actualJDK);assert.equal(model.targetRelease,target);
 } // even newer target on older JDK reaches the real compiler, not an artificial profile veto
 for(const target of ['', '21oops', '${java.version}', '0']) assert.throws(()=>inspectEffectivePom(pom(target),21,false),/CONFLICT/);
 for(const c of ['<release>17</release>','<source>17</source>','<target>17</target>','<testRelease>17</testRelease>','<enablePreview>true</enablePreview>','<fork>true</fork>','<jdkToolchain><version>17</version></jdkToolchain>','<compilerId>eclipse</compilerId>','<compilerArgs><arg>--release</arg></compilerArgs>']) assert.throws(()=>inspectEffectivePom(pom('21',c),21,false),c);
 assert.throws(()=>inspectEffectivePom('<!DOCTYPE a>'+pom(),21,false));assert.throws(()=>inspectEffectivePom(pom().replace('<maven.compiler.release>21</maven.compiler.release>',''),21,false),/absent/);
});
test('image dispatcher independent guard rejects injected commands/data mismatches',async()=>{
 const plan=await new NodeAdapter().buildPlan(context(profile()),run()),spec=decode(plan);assert.equal(validateSpec(spec).family,'node');
 for(const change of [(s:any)=>s.command='sh',(s:any)=>s.task.tests.paths=['--eval'],(s:any)=>s.task.entry={kind:'SCRIPT',path:'../secret.js'},(s:any)=>s.cache='/home/student/.m2',(s:any)=>s.runId='../../escape',(s:any)=>s.preview=true]) {const s=structuredClone(spec);change(s);assert.throws(()=>validateSpec(s));}
});
test('explicit prepare requires all pins, safe inventories/hash, no arbitrary Docker/env/commands',()=>{
 const files=[{path:'main.js',sha256:H}],req={schemaVersion:1,workingDirectory:'.',installationId:'fixture',family:'node',key:'node',imageTag:'paircoach/runtime-node:fixture',baseImage:'fixture/base@'+I,nodeImage:'fixture/node@'+I,tools:{root:'/fixture/tools',files:[{path:'node_modules/fast-xml-parser/package.json',sha256:H}]},project:{root:'/fixture/project',files},expectedTools:[{name:'node',version:'fixture'}],dependencySha256:dependencyHash(files),outputRoot:'/fixture/output'};
 assert.equal(validatePrepareRequest(req).key,'node');
 for(const mutate of [(r:any)=>r.baseImage='node:latest',(r:any)=>r.env={TOKEN:'x'},(r:any)=>r.tools.files[0].path='../escape',(r:any)=>r.project.files[0].path='.env',(r:any)=>r.expectedTools=[],(r:any)=>r.dependencySha256='b'.repeat(64)]) {const r=structuredClone(req);mutate(r);assert.throws(()=>validatePrepareRequest(r));}
});

test('prepare plan checks real bounded inventories and writes PLAN_ONLY, never Docker',async()=>{
 const root=await mkdtemp(path.join(process.env.TMPDIR!,'runtime-prepare-')),tools=path.join(root,'tools'),project=path.join(root,'project');
 await mkdir(tools);await mkdir(project);await writeFile(path.join(tools,'package.json'),'{}');await writeFile(path.join(project,'main.js'),'export const n=1;');
 const files=[{path:'main.js',sha256:sha('export const n=1;')}],request={schemaVersion:1,workingDirectory:'.',installationId:'fixture',family:'node',key:'node',imageTag:'paircoach/runtime-node:fixture',baseImage:'fixture/base@'+I,nodeImage:'fixture/node@'+I,tools:{root:tools,files:[{path:'package.json',sha256:sha('{}')}]},project:{root:project,files},expectedTools:[{name:'node',version:'fixture'}],dependencySha256:dependencyHash(files),outputRoot:path.join(root,'plan')};
 const result=prepare(request);assert.equal(result.status,'PLAN_ONLY_NOT_PREPARED');assert.deepEqual(result.commands,[]);
 assert.throws(()=>prepare(request)); // exclusive output; no implicit overwrite/retry
 await writeFile(path.join(project,'main.js'),'changed');assert.throws(()=>prepare({...request,outputRoot:path.join(root,'changed')}),/inventory differs/);
 await writeFile(path.join(project,'main.js'),'export const n=1;');await symlink(path.join(project,'main.js'),path.join(project,'alias.js'));
 assert.throws(()=>prepare({...request,outputRoot:path.join(root,'linked')}),/Nonregular/);
});

test('dependency identity changes on manifests/config, not ordinary source edits; cached actual Maven model before plan',async()=>{
 const files=[{path:'pom.xml',sha256:H},{path:'src/App.java',sha256:H}];
 assert.equal(dependencyHash(files),dependencyHash([files[0],{path:'src/App.java',sha256:'b'.repeat(64)}]));
 assert.notEqual(dependencyHash(files),dependencyHash([{path:'pom.xml',sha256:'b'.repeat(64)},files[1]]));
 const p=profile('java-maven',21),r=run('java-maven'),c=context(p,r),a=new JavaMavenAdapter(javaDeps(17));
 const allowed=await a.buildPlan(c,r);assert.equal(decode(allowed).release,21); // target17 retained in prepared POM, actual JDK21 in dispatcher spec
 const changed=structuredClone(c);changed.input.files=changed.input.files.map(f=>f.path==='pom.xml'?{...f,sha256:'c'.repeat(64)}:f);
 await assert.rejects(new JavaMavenAdapter(javaDeps(21)).buildPlan(changed,r),/identity changed/);
});

test('final convention: canonical<=4096 spec, exact plan env/cwd/cache; reject malformed/duplicate/oversized',async()=>{
 const p=profile(),r=run(),plan=await new NodeAdapter().buildPlan(context(p,r),r),encoded=plan.command.args[1];
 assert.equal(plan.command.workingDirectory,'/workspace');assert.equal(decodeSpec(encoded).cache,'/cache/0');assert.equal(encodeSpec(decodeSpec(encoded)),encoded);
 assert.deepEqual(plan.command.environment,{CI:'true',LANG:'C.UTF-8',LC_ALL:'C.UTF-8',TZ:'UTC',PYTHONDONTWRITEBYTECODE:'1'});
 for(const invalid of [encoded+'=',Buffer.from(JSON.stringify(decodeSpec(encoded),null,2)).toString('base64url'),'YQ','_w','a'.repeat(4097),Buffer.from('{"schemaVersion":1,"schemaVersion":1}').toString('base64url')]) assert.throws(()=>decodeSpec(invalid));
 const big=decodeSpec(encoded);big.task.tests.paths=Array.from({length:100},(_,i)=>'a'.repeat(60)+i+'.test.js');assert.throws(()=>encodeSpec(big),/budget/);
});
test('dispatcher verifies executor-populated copy, never recopies empty/different workspace; no host env',async()=>{
 const root=await mkdtemp(path.join(process.env.TMPDIR!,'runtime-build-')),input=path.join(root,'input'),work=path.join(root,'workspace');await mkdir(input);await mkdir(work);await writeFile(path.join(input,'main.js'),'current');
 assert.throws(()=>verifyBuildCopy(input,work),/differs/);await writeFile(path.join(work,'main.js'),'current');verifyBuildCopy(input,work);
 await writeFile(path.join(work,'main.js'),'old');assert.throws(()=>verifyBuildCopy(input,work),/differs/);
 const env=buildChildEnvironment('node','/workspace/subtask');assert.equal(env.HOME,'/workspace/.paircoach/runtime/home');assert.equal(Object.hasOwn(env,'PYTHONPATH'),false);assert.equal(Object.hasOwn(env,'NODE_OPTIONS'),false);assert.equal(Object.hasOwn(env,'GEMINI_API_KEY'),false);assert.equal(Object.hasOwn(env,'JAVA_TOOL_OPTIONS'),false);
 assert.equal(buildChildEnvironment('python','/workspace/subtask').PYTHONPATH,'/cache/0/site-packages:/workspace/subtask');assert.throws(()=>buildChildEnvironment('python','/workspace/../escape'));
});

test('fresh Maven standard reports are bounded-exported only after exit; missing/links never synthetic success',async()=>{
 const root=await mkdtemp(path.join(process.env.TMPDIR!,'runtime-junit-')),task=path.join(root,'task'),out=path.join(root,'artifacts');await mkdir(task);await mkdir(out);
 assert.equal(exportMavenReports(task,out),0);
 const reports=path.join(task,'target','surefire-reports');await mkdir(reports,{recursive:true});await writeFile(path.join(reports,'TEST-Example.xml'),xmls[0]);
 assert.equal(exportMavenReports(task,out),1);
 assert.throws(()=>exportMavenReports(task,out)); // never overwrite current artifacts with old content
 const other=path.join(root,'out2');await mkdir(other);await symlink(path.join(reports,'TEST-Example.xml'),path.join(reports,'TEST-Alias.xml'));
 assert.throws(()=>exportMavenReports(task,other),/Unsafe/);
});

test('portable artifact identity: absent O_NOFOLLOW still rejects final/parent symlinks',async()=>{
 const root=await mkdtemp(path.join(process.env.TMPDIR!,'runtime-portable-')),dir=path.join(root,'real');await mkdir(dir);const file=path.join(dir,'fresh.xml');await writeFile(file,xmls[0]);
 assert.equal(Buffer.from(await readRegularArtifact(file,4096,0)).toString(),xmls[0]);
 await symlink(file,path.join(root,'alias.xml'));await assert.rejects(readRegularArtifact(path.join(root,'alias.xml'),4096,0),/regular/);
 await symlink(dir,path.join(root,'linked-parent'));await assert.rejects(readRegularArtifact(path.join(root,'linked-parent','fresh.xml'),4096,0),/parent/);
});

test('selected actual javac guard remains strict while Maven target is independent',()=>{
 for(const jdk of [11,17,21,27]) {
  assert.equal(verifySelectedJdk(`javac ${jdk}.0.1\n`,jdk),jdk);
  assert.throws(()=>verifySelectedJdk(`javac ${jdk}.0.1\n`,jdk===21?27:21),/actual javac/);
 }
 for(const output of ['', 'javac 21spoof', 'java 21.0.1', 'ignored\njavac 21.0.1']) assert.throws(()=>verifySelectedJdk(output,21),/actual javac/);
});

test('Spring startup budget follows the explicitly approved 15min Run timeout, never a hidden 30s cap', async()=>{
 const p=profile('java-maven',21), r=run('java-maven','RUN_MAIN');
 r.timeoutMs=900000; r.task.entry={kind:'SPRING_BOOT',containerPort:8123,healthPath:'/ready'};
 const plan=await new JavaMavenAdapter(javaDeps(21)).buildPlan(context(p,r),r);
 assert.equal(plan.timeoutMs,900000); assert.equal(plan.service?.readinessTimeoutMs,900000);
 assert.equal(plan.service?.bindHost,'127.0.0.1'); assert.equal(plan.service?.healthPath,'/ready'); assert.equal(plan.isolation.network,'loopback');
 for(const budget of [0,3600001]) {const invalid=structuredClone(r);invalid.timeoutMs=budget;assert.equal((await new JavaMavenAdapter(javaDeps(21)).validate(p,invalid)).valid,false);}
});
