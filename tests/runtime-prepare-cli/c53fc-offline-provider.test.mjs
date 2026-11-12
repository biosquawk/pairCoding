/** Exact image dispatcher + real private FS; Maven/javac/tool subprocesses are controlled, NOT host/Docker proof. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { XMLParser, XMLBuilder } from 'fast-xml-parser';
import { fileURLToPath } from 'node:url';
const dispatcher = new URL('../../scripts/runtime-cache.mjs', import.meta.url);
const parser = new XMLParser({parseTagValue:false,ignoreAttributes:false,processEntities:true});
const asList = v => v === undefined ? [] : Array.isArray(v) ? v : [v];

async function scenario(mode) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'c53fc-provider-'));
  const real = Object.fromEntries(['mkdirSync','cpSync','readFileSync','writeFileSync','existsSync','mkdtempSync','rmSync'].map(k => [k,fs[k]]));
  const map = p => typeof p === 'string' && /^\/(?:input|workspace|cache)(?:\/|$)/.test(p) ? path.join(root,p) : p;
  const put = (p,b) => { real.mkdirSync(path.dirname(map(p)),{recursive:true}); real.writeFileSync(map(p),b); };
  const exists = p => real.existsSync(map(p));
  const read = p => real.readFileSync(map(p),'utf8');
  const version = mode === 'different-versions' ? '3.4.0' : '3.5.3';
  const platform = mode === 'different-versions' ? '1.12.2' : '1.11.4';
  const provider = `/cache/0/m2/org/apache/maven/surefire/surefire-junit-platform/${version}/provider.jar`;
  const launcher = `/cache/0/m2/org/junit/platform/junit-platform-launcher/${platform}/launcher.jar`;
  const effective = {project:{modelVersion:'4.0.0',groupId:'example',artifactId:'student',version:'1',
    properties:{'maven.compiler.release':'11'},
    dependencies:{dependency:{groupId:'org.junit.jupiter',artifactId:'junit-jupiter',version:mode==='different-versions'?'5.12.2':'5.11.4',scope:'test'}},
    repositories:{repository:{id:'unit-project',url:'https://example.invalid/maven?a=1&b=2'}},
    pluginRepositories:{pluginRepository:{id:'unit-plugin',url:'https://example.invalid/plugins'}},
    build:{outputDirectory:'/workspace/target/classes',testOutputDirectory:'/workspace/target/test-classes',
      plugins:{plugin:[{groupId:'org.apache.maven.plugins',artifactId:'maven-compiler-plugin',version:'3.14.0'},
        {groupId:'org.apache.maven.plugins',artifactId:'maven-surefire-plugin',version,
          configuration:{testClassesDirectory:'/workspace/target/test-classes',dependenciesToScan:{dependency:'student:code'},suiteXmlFiles:{suiteXmlFile:'pupil-suite.xml'},argLine:'-Dstudent=true'},
          executions:{execution:{id:'pupil-lifecycle'}}}]}}}};
  let xml = new XMLBuilder({ignoreAttributes:false}).build(effective);
  if(mode === 'plugin-dependencies') { effective.project.build.plugins.plugin[1].dependencies={dependency:{groupId:'org.example',artifactId:'provider-extension',version:'1.0'}}; xml=new XMLBuilder().build(effective); }
  if(mode === 'parallel-provider') { effective.project.build.plugins.plugin[1].configuration.parallel='classes'; xml=new XMLBuilder().build(effective); }
  if(mode === 'missing-plugin') { effective.project.build.plugins.plugin.pop(); xml=new XMLBuilder().build(effective); }
  if(mode === 'unsafe-xml') xml='<!DOCTYPE project [<!ENTITY secret SYSTEM "file:///etc/passwd">]>'+xml;
  if(mode === 'duplicate-plugin') effective.project.build.plugins.plugin.push({...effective.project.build.plugins.plugin[1]});
  if(mode === 'duplicate-plugin') xml=new XMLBuilder().build(effective);
  if(mode === 'unresolved-version') xml=xml.replace(`<version>${version}</version>`,'<version>${unresolved}</version>');
  put('/input/pom.xml','UNCHANGED_SOURCE_POM');
  put('/input/src/test/java/IntentionallyFailingTest.java','NOT_VALID_JAVA: must never compile or execute pupil code in prepare');
  put('/input/package.json','{}');
  put('/cache/0/retained-private-receipt','UNCHANGED');
  const calls=[]; let offlineChecked=false, onlineChecked=false, probes=0;
  const expected=[{name:'java',version:'21'},{name:'maven',version:'3.9.12'}];
  const success={status:0,signal:null,stdout:'',stderr:''};
  const fakeSpawn = (exe,args,options) => {
    calls.push({exe,args,cwd:options.cwd});
    assert.equal(options.shell,false);
    assert.equal(options.env.JAVA_HOME,'/opt/java/openjdk');
    assert.equal(options.env.TMPDIR,'/tmp');
    if(exe==='/opt/paircoach/node/bin/node') {
      probes++;
      return {...success,stdout:JSON.stringify({tools:expected})};
    }
    if(exe==='/opt/java/openjdk/bin/javac') {
      assert.ok(args.includes('-proc:none'),'no annotation processors');
      const file=args.at(-1),source=read(file);
      assert.match(source,/public (?:final )?class PairCoachPrepareProviderProbeTest\s*\{\s*\}/);
      assert.doesNotMatch(source,/@|static|void|extends|implements/,'empty inert probe, not a pupil test');
      assert.ok(file.includes('/.paircoach/runtime/'));
      put(args[args.indexOf('-d')+1]+'/PairCoachPrepareProviderProbeTest.class','CONTROLLED_JAVAC_RESULT');
      return success;
    }
    assert.equal(exe,'/usr/share/maven/bin/mvn');
    assert.ok(args.includes('-Dmaven.repo.local=/cache/0/m2'));
    if(args.some(a=>a.endsWith(':effective-pom'))) {
      put('/cache/0/effective-pom.xml',xml);return success;
    }
    if(args.some(a=>a.endsWith(':go-offline'))) {
      put('/cache/0/m2/plugins-ready','plugins, project dependencies only; NO lazy provider');return success;
    }
    // BEFORE: existing production path claims complete after skipTests, but never selects provider.
    if(args.includes('test') && args.includes('-DskipTests')) return success;
    assert.ok(args.includes(`org.apache.maven.plugins:maven-surefire-plugin:${version}:test`),'resolved exact plugin version');
    assert.ok(!args.includes('test') && !args.includes('test-compile') && !args.includes('-DskipTests'),'direct goal only, no pupil lifecycle/skip');
    const file=args[args.indexOf('--file')+1],pom=parser.parse(read(file)).project;
    assert.ok(file.includes('/.paircoach/runtime/'));
    assert.equal(options.cwd,path.dirname(file),'isolated cwd');
    assert.deepEqual(pom.dependencies,effective.project.dependencies);
    assert.deepEqual(pom.repositories,effective.project.repositories);
    assert.deepEqual(pom.pluginRepositories,effective.project.pluginRepositories);
    assert.equal(pom.parent,undefined);assert.equal(pom.profiles,undefined);assert.equal(pom.properties,undefined);
    const plugins=asList(pom.build.plugins.plugin);assert.equal(plugins.length,1);
    const plugin=plugins[0];assert.equal(plugin.artifactId,'maven-surefire-plugin');assert.equal(plugin.version,version);
    assert.equal(plugin.dependencies,undefined,'no copied plugin dependency/extension');
    assert.equal(plugin.executions,undefined,'no pupil plugin executions');
    assert.equal(plugin.configuration.dependenciesToScan,undefined);assert.equal(plugin.configuration.suiteXmlFiles,undefined);assert.equal(plugin.configuration.argLine,undefined);
    const config=plugin.configuration;
    assert.equal(config.failIfNoTests,'false');assert.equal(config.failIfNoSpecifiedTests,'false');
    for(const dir of [pom.build.outputDirectory,pom.build.testOutputDirectory,config.classesDirectory,config.testClassesDirectory,config.reportsDirectory]) {
      assert.ok(dir.startsWith(path.dirname(file)+'/'),'all outputs/class roots private probe only');
    }
    assert.equal(config.testClassesDirectory,pom.build.testOutputDirectory);
    assert.equal(config.classesDirectory,pom.build.outputDirectory);
    assert.equal(config.includes.include,'**/PairCoachPrepareProviderProbeTest.class');
    assert.ok(exists(config.testClassesDirectory+'/PairCoachPrepareProviderProbeTest.class'),'nonempty Surefire scan reaches provider selection');
    assert.equal(fs.readdirSync(map(config.classesDirectory)).length,0,'no student production classes');
    assert.equal(options.stdio,'pipe');assert.equal(options.maxBuffer,4*1024*1024);
    if(args.includes('--offline')) {
      offlineChecked=true;
      if(mode==='offline-provider-missing') real.rmSync(map(provider));
      if(mode==='offline-launcher-missing') real.rmSync(map(launcher));
      if(!exists(provider)||!exists(launcher)) return {...success,status:1,stderr:'offline provider/launcher unavailable'};
    } else {
      onlineChecked=true;
      if(mode==='online-provider-refused') return {...success,status:1,stderr:'provider resolution refused'};
      put(provider,'DYNAMIC_PROVIDER');put(launcher,'ALIGNED_TRANSITIVE_LAUNCHER');
    }
    return {...success,stdout:mode==='online-no-provider'||args.includes('--offline')&&mode==='offline-no-provider'?'[INFO] No tests to run.\n':`[INFO] Using auto detected provider ${args.includes('--offline')&&mode==='offline-other-provider'?'org.apache.maven.surefire.junit4.JUnit4Provider':'org.apache.maven.surefire.junitplatform.JUnitPlatformProvider'}\n`};
  };
  fs.mkdirSync=(p,...args)=>real.mkdirSync(map(p),...args);
  fs.mkdtempSync=(p,...args)=>real.mkdtempSync(map(p),...args);
  fs.cpSync=(a,b,...args)=>real.cpSync(map(a),map(b),...args);
  fs.readFileSync=(p,...args)=>real.readFileSync(map(p),...args);
  fs.writeFileSync=(p,...args)=>real.writeFileSync(map(p),...args);
  fs.existsSync=p=>real.existsSync(map(p));
  childProcess.spawnSync=fakeSpawn;syncBuiltinESMExports();
  process.argv=[process.execPath,fileURLToPath(dispatcher),mode==='node-control'?'node':'java-maven',Buffer.from(JSON.stringify(expected)).toString('base64url'),'.','a'.repeat(64)];
  let failure;
  try { await import(dispatcher.href); } catch(error) { failure=error; }
  try {
    assert.equal(read('/input/pom.xml'),'UNCHANGED_SOURCE_POM');
    assert.equal(read('/input/src/test/java/IntentionallyFailingTest.java'),'NOT_VALID_JAVA: must never compile or execute pupil code in prepare');
    assert.equal(read('/cache/0/retained-private-receipt'),'UNCHANGED');
    const marker=exists('/cache/0/dependencies-prepared.json');
    if(['online-provider-refused','offline-provider-missing','offline-launcher-missing','unsafe-xml','duplicate-plugin','unresolved-version','plugin-dependencies','parallel-provider','missing-plugin','online-no-provider','offline-no-provider','offline-other-provider'].includes(mode)) {
      assert.ok(failure,'incomplete/unsafe cache must fail preparation');
      assert.notEqual(failure.code,'ERR_ASSERTION','a transport-oracle failure is NOT an expected prepare refusal');
      assert.match(failure.message,/Invalid\/unsafe effective POM|Surefire must be pinned|Custom Surefire provider selection|Prepare failed 1|provider selection/);
      if(['online-provider-refused','offline-provider-missing','offline-launcher-missing','online-no-provider','offline-no-provider','offline-other-provider'].includes(mode)) {
        assert.equal(onlineChecked,true,'must actually reach the provider path');
        assert.equal(offlineChecked,mode.startsWith('offline-'),'offline negatives must reach the offline resolver');
      } else assert.equal(calls.some(c=>c.exe.endsWith('/javac')),false,'model rejected before compilation');
      assert.equal(marker,false,'never publish dependencies-prepared.json after incomplete cache');
      assert.equal(probes,0,'do not advance to final tools/receipt');
    } else {
      if(failure) throw failure;
      assert.equal(marker,true);
      if(mode!=='node-control') {
        assert.equal(exists(provider),true,'skipTests did not materialize dynamic provider (C53fc regression)');
        assert.equal(exists(launcher),true);assert.equal(onlineChecked,true);assert.equal(offlineChecked,true);
      } else assert.equal(calls.length,1,'non-Maven preparation unchanged');
      assert.equal(probes,1);
      const evidence=JSON.parse(read('/cache/0/dependencies-prepared.json'));
      assert.equal(evidence.dependencySha256,'a'.repeat(64));assert.deepEqual(evidence.tools,expected);
    }
    console.log(JSON.stringify({mode,onlineChecked,offlineChecked,published:marker,calls:calls.map(c=>[c.exe,...c.args]),controlledSubprocesses:true,liveMaven:false}));
  } finally { real.rmSync(root,{recursive:true,force:true}); }
}
if(process.argv[2]==='--worker') {
  await scenario(process.argv[3]);
} else {
  for(const mode of ['complete','different-versions','online-provider-refused','offline-provider-missing','offline-launcher-missing','unsafe-xml','duplicate-plugin','unresolved-version','plugin-dependencies','parallel-provider','missing-plugin','online-no-provider','offline-no-provider','offline-other-provider','node-control']) {
    test('C53fc actual cache dispatcher / controlled tool processes: '+mode,()=>{
      const result=childProcess.spawnSync(process.execPath,[fileURLToPath(import.meta.url),'--worker',mode],{env:process.env,encoding:'utf8',timeout:15000,maxBuffer:1024*1024});
      assert.equal(result.error,undefined);assert.equal(result.status,0,result.stdout+result.stderr);
      console.log(result.stdout.trim());
    });
  }
}
