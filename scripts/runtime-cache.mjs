// Image-internal explicit preparation only; never used by Run/Test.
import { literalPath } from './runtime-spec.mjs';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { XMLBuilder, XMLParser, XMLValidator } from 'fast-xml-parser';
const [family,expectedEncoded,workingDirectory,dependencySha256] = process.argv.slice(2);
if (process.argv.length !== 6 || workingDirectory!=='.' && !literalPath(workingDirectory) || !/^[a-f0-9]{64}$/.test(dependencySha256) || !/^[A-Za-z0-9_-]{1,16384}$/.test(expectedEncoded) || !['node','typescript','python','java-maven'].includes(family)) throw new Error('Explicit known family required');
const expected=JSON.parse(Buffer.from(expectedEncoded,'base64url').toString('utf8'));
if(!Array.isArray(expected) || !expected.length || expected.some(t=>!t || Object.keys(t).sort().join(',')!=='name,version' || typeof t.name!=='string' || typeof t.version!=='string')) throw new Error('Expected versions required');
mkdirSync('/workspace/.paircoach/runtime/home',{recursive:true}); cpSync('/input','/workspace',{recursive:true});
const cwd=workingDirectory==='.'?'/workspace':'/workspace/'+workingDirectory;
const env = { PATH:'/opt/paircoach/node/bin:/opt/java/openjdk/bin:/usr/share/maven/bin:/usr/local/bin:/usr/bin:/bin', JAVA_HOME:'/opt/java/openjdk', HOME:'/workspace/.paircoach/runtime/home', LANG:'C.UTF-8', TMPDIR:'/tmp', PIP_CONFIG_FILE:'/dev/null', PIP_DISABLE_PIP_VERSION_CHECK:'1', PYTHONNOUSERSITE:'1' };
mkdirSync(env.HOME,{recursive:true});
const run = (exe,args,runCwd=cwd,capture=false) => {
  const r=spawnSync(exe,args,{cwd:runCwd,env,shell:false,stdio:capture?'pipe':'inherit',encoding:'utf8',maxBuffer:4*1024*1024});
  if(capture) { process.stdout.write(r.stdout??''); process.stderr.write(r.stderr??''); }
  if(r.error || r.signal || r.status !== 0) throw new Error(`Prepare failed ${r.error?.message ?? r.signal ?? r.status}`);
  return (r.stdout??'')+'\n'+(r.stderr??'');
};
if (family === 'node' || family === 'typescript') {
  // Lock required for dependencies. No task lifecycle scripts during preparation.
  const pkg=JSON.parse(readFileSync(cwd+'/package.json','utf8'));
  if (Object.keys(pkg.dependencies ?? {}).length || Object.keys(pkg.devDependencies ?? {}).length) {
    if(!existsSync(cwd+'/package-lock.json')) throw new Error('Pinned package-lock required');
    run('/opt/paircoach/node/bin/node',['/usr/local/lib/node_modules/npm/bin/npm-cli.js','ci','--ignore-scripts','--no-audit','--no-fund','--cache=/cache/0/npm']);
    cpSync(cwd+'/node_modules','/cache/0/node_modules',{recursive:true});
  } else mkdirSync('/cache/0/node_modules',{recursive:true});
} else if(family === 'python') {
  // requirements includes pytest and all transitive dependencies with real hashes; never invent hashes.
  if(!/^[A-Za-z0-9_.-]+==[^\s]+.*--hash=sha256:/m.test(readFileSync(cwd+'/requirements.txt','utf8'))) throw new Error('NOTREADY: hash-locked pytest requirements required');
  run('/usr/local/bin/python3',['-m','pip','--isolated','install','--require-hashes','--only-binary=:all:','--no-compile','--target=/cache/0/site-packages','-r','requirements.txt']);
} else {
  const mvn='/usr/share/maven/bin/mvn',args=['--batch-mode','--no-transfer-progress','-Dmaven.repo.local=/cache/0/m2','-Dstyle.color=never'];
  run(mvn,[...args,'org.apache.maven.plugins:maven-help-plugin:3.5.1:effective-pom','-Doutput=/cache/0/effective-pom.xml']);
  run(mvn,[...args,'org.apache.maven.plugins:maven-dependency-plugin:3.8.1:go-offline']);
  // go-offline/skipTests do NOT load Surefire's dynamically selected provider.
  // Drive the actual pinned plugin against one inert class, never pupil classes,
  // tests, lifecycle executions or annotation processors. In particular a red
  // exercise must not have to pass (or even compile) to prepare dependencies.
  const xml=readFileSync('/cache/0/effective-pom.xml','utf8');
  if(Buffer.byteLength(xml)>4*1024*1024 || /<!\s*(DOCTYPE|ENTITY)/i.test(xml) || XMLValidator.validate(xml)!==true) throw new Error('Invalid/unsafe effective POM');
  const p=new XMLParser({ignoreAttributes:false,parseTagValue:false,processEntities:true}).parse(xml).project;
  const list=v=>v===undefined?[]:Array.isArray(v)?v:[v];
  if(!p || p.modules) throw new Error('Select one Maven module for prepare');
  const plugins=list(p.build?.plugins?.plugin).filter(v=>v.artifactId==='maven-surefire-plugin' && (v.groupId??'org.apache.maven.plugins')==='org.apache.maven.plugins');
  if(plugins.length!==1 || !/^\d+\.\d+\.\d+$/.test(plugins[0].version??'')) throw new Error('Surefire must be pinned in effective POM');
  const plugin=plugins[0],configuration=plugin.configuration??{},state=cwd+'/.paircoach/runtime';
  // Do not silently probe a different provider for a custom plugin/classpath.
  if(plugin.dependencies || plugin.extensions==='true' || ['parallel','threadCount','groups','excludedGroups'].some(k=>configuration[k]!==undefined)) throw new Error('NOTREADY: Custom Surefire provider selection requires reviewed prepare support');
  mkdirSync(state,{recursive:true});
  const probe=mkdtempSync(state+'/provider-probe-'),classes=probe+'/classes',tests=probe+'/test-classes';
  mkdirSync(classes); mkdirSync(tests);
  const source=probe+'/PairCoachPrepareProviderProbeTest.java';
  writeFileSync(source,'public final class PairCoachPrepareProviderProbeTest {}\n');
  run('/opt/java/openjdk/bin/javac',['-proc:none','-d',tests,source],probe);
  // Effective project dependencies (including transitive resolution)
  // determine provider/launcher versions. Do not duplicate Surefire's selector or
  // copy source-POM properties, executions, suites, extra classpaths or argLine.
  const model={project:{modelVersion:'4.0.0',groupId:'org.paircoach.prepare',artifactId:'provider-probe',version:'1',
    ...(p.dependencies?{dependencies:p.dependencies}:{}),
    ...(p.repositories?{repositories:p.repositories}:{}),
    ...(p.pluginRepositories?{pluginRepositories:p.pluginRepositories}:{}),
    build:{directory:probe+'/target',outputDirectory:classes,testOutputDirectory:tests,plugins:{plugin:{
      groupId:'org.apache.maven.plugins',artifactId:'maven-surefire-plugin',version:plugin.version,
      configuration:{classesDirectory:classes,testClassesDirectory:tests,reportsDirectory:probe+'/reports',
        includes:{include:'**/PairCoachPrepareProviderProbeTest.class'},failIfNoTests:false,failIfNoSpecifiedTests:false}
    }}}}};
  const file=probe+'/pom.xml',goal=`org.apache.maven.plugins:maven-surefire-plugin:${plugin.version}:test`;
  writeFileSync(file,new XMLBuilder({ignoreAttributes:false}).build(model));
  const selected=output=>output.match(/^\[INFO\] Using (?:auto detected|configured) provider ([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+)\s*$/m)?.[1];
  const provider=selected(run(mvn,[...args,'--file',file,goal],probe,true));
  if(!provider) throw new Error('Surefire provider selection not witnessed; cache not prepared');
  // Refuse publication unless the same provider/launcher closure resolves offline.
  // This is NOT a pupil test result and produces no run artifacts or JUnit claim.
  if(selected(run(mvn,[...args,'--offline','--file',file,goal],probe,true))!==provider) throw new Error('Offline Surefire provider selection differs or is absent');
}
const probe=spawnSync('/opt/paircoach/node/bin/node',['/opt/paircoach/runtime-tools.mjs',...expected.map(t=>t.name)],{cwd,env,shell:false,encoding:'utf8',maxBuffer:65536});
if(probe.error || probe.status!==0) throw new Error('Pinned tools probe failed: '+probe.stderr);
const actual=JSON.parse(probe.stdout).tools;
writeFileSync('/cache/0/tools.json',JSON.stringify(actual));
if(expected.some(t=>!actual.some(a=>a.name===t.name && a.version===t.version))) throw new Error('Actual tools differ from pinned expected versions');
writeFileSync('/cache/0/dependencies-prepared.json',JSON.stringify({family,workingDirectory,dependencySha256,tools:actual,preparedAt:new Date().toISOString()}));
