import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,symlinkSync,rmSync,truncateSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {javaLaunch,prepareBootDirectory,prepareJdtStateDirectory,readJavaVersions,readBoundedFile,collectBootArtifacts,bootLimits,assertJavaProjectImported,assertJavaProjectDiagnostics} from './boot-artifacts.mjs';
const launcher='org.eclipse.equinox.launcher_1.8.0.v20260804-1928.jar';
function fixture(t,kind='java27'){
  const out=mkdtempSync(join(process.env.PAIRCOACH_TEST_TMP??tmpdir(),'paircoach-boot-test-'));
  t.after(()=>rmSync(out,{recursive:true,force:true}));
  const boot=prepareBootDirectory(out,kind);
  return {out,boot,kind};
}
function versions(boot,target=27,server=27){
  writeFileSync(join(boot,'server-java-version.txt'),`openjdk version "${server}.0.1" 2026-10-20\n`);
  writeFileSync(join(boot,'target-java-version.txt'),`openjdk version "${target}.0.1" 2026-10-20\n`);
  writeFileSync(join(boot,'target-javac-version.txt'),`javac ${target}.0.1\n`);
  writeFileSync(join(boot,'versions-ready.txt'),'ready\n');
}
test('server JVM27 stays independent of both analysis targets; boot output not stdout',()=>{
  for(const target of [21,27]){
    const launch=javaLaunch(target,launcher),script=launch.argv[2];
    assert.equal(launch.serverJava,'/opt/jdk27/bin/java');assert.equal(launch.targetRelease,target);
    assert.equal(launch.targetHome,target===21?'/opt/java/openjdk':'/opt/jdk27');
    assert.ok(script.includes('exec /opt/jdk27/bin/java '));
    assert.ok(script.includes('-configuration /artifacts/jdt-config'));
    assert.ok(script.includes('-Dosgi.logfile=/artifacts/osgi.log'));
    assert.ok(script.indexOf('versions-ready.txt')<script.indexOf('exec /opt/jdk27/bin/java'));
    assert.ok(script.includes('-version > /artifacts/server-java-version.txt 2>&1'));
    assert.ok(script.includes('--version > /artifacts/target-javac-version.txt 2>&1'));
    assert.equal(script.includes('-consoleLog'),false);assert.equal(script.includes('/tmp/jdt-config'),false);
  }
  assert.throws(()=>javaLaunch(11,launcher));assert.throws(()=>javaLaunch(27,'bad; echo bypass'));
});
test('actual versions require prelaunch readiness; server/target mismatches fail',t=>{
  const {boot}=fixture(t,'java21');
  assert.throws(()=>readJavaVersions(boot,21),/ENOENT/);
  versions(boot,21);const result=readJavaVersions(boot,21);
  assert.equal(result.server.major,27);assert.equal(result.target.javaMajor,21);assert.equal(result.target.javacMajor,21);
  versions(boot,21,21);assert.throws(()=>readJavaVersions(boot,21),/version conflict/);
  versions(boot,27);assert.throws(()=>readJavaVersions(boot,21),/version conflict/);
});
test('bootstrap failure logs survive without workspace metadata (not inferred LSP PASS)',t=>{
  const {out,boot,kind}=fixture(t);
  mkdirSync(join(boot,'jdt-config'));writeFileSync(join(boot,'jdt-config','config.ini'),'osgi.configuration.cascaded=false\n');
  writeFileSync(join(boot,'jdt-config','123.log'),'Unresolved requirement: JavaSE-25\n');
  versions(boot);
  const result=collectBootArtifacts(out,kind);
  assert.equal(result.status,'PASS');assert.match(result.scope,/NOT LSP PASS/);
  assert.deepEqual(result.missing,['jdt-state/.metadata/.log']);
  assert.ok(result.files.some(file=>file.path==='jdt-config/123.log'&&file.sha256.length===64));
  assert.equal(readFileSync(join(boot,'jdt-config','123.log'),'utf8'),'Unresolved requirement: JavaSE-25\n');
  assert.deepEqual(JSON.parse(readFileSync(join(out,`${kind}-boot-artifacts.json`))),result);
});
test('workspace log bounded collection is repeatable for post-timeout recovery',t=>{
  const {out,boot,kind}=fixture(t);
  const state=prepareJdtStateDirectory(out,kind);
  mkdirSync(join(state,'.metadata'));
  writeFileSync(join(state,'.metadata','.log'),'workspace failure\n');
  for(let i=0;i<2;i++){
    const result=collectBootArtifacts(out,kind);assert.equal(result.status,'PASS');
    assert.ok(result.files.some(file=>file.path==='jdt-workspace.log'));
    assert.equal(readFileSync(join(boot,'jdt-workspace.log'),'utf8'),'workspace failure\n');
  }
});
test('artifact bounds and symlinks fail closed; no reading link target',t=>{
  const {out,boot,kind}=fixture(t);
  writeFileSync(join(out,'unrelated.txt'),'not evidence');symlinkSync(join(out,'unrelated.txt'),join(boot,'escape.log'));
  assert.throws(()=>readBoundedFile(join(boot,'escape.log')),/Unsafe/);
  assert.equal(collectBootArtifacts(out,kind).status,'FAIL');
  rmSync(join(boot,'escape.log'));writeFileSync(join(boot,'huge.log'),'');truncateSync(join(boot,'huge.log'),bootLimits.fileBytes+1);
  const result=collectBootArtifacts(out,kind);assert.equal(result.status,'FAIL');assert.equal(result.totalBytes,0);
  assert.equal(result.files.length,0);assert.match(result.errors[0],/oversize/);
  assert.throws(()=>prepareBootDirectory(out,'../foreign'));assert.throws(()=>collectBootArtifacts(out,'../foreign'));
});

test('JDT data bind is disjoint from imported project; binary metadata never crawled',t=>{
  const {out,boot,kind}=fixture(t);
  const state=prepareJdtStateDirectory(out,kind);
  assert.equal(state,join(out,`jdt-state-${kind}`));
  assert.notEqual(state,boot);assert.notEqual(state,join(out,`shadow-${kind}`));
  for(const target of [21,27]){
    const script=javaLaunch(target,launcher).argv[2];
    assert.ok(script.endsWith('-data /jdt-state'));
    assert.equal(script.includes('-data /work'),false);
    assert.equal(script.includes('-data /artifacts'),false);
  }
  mkdirSync(join(state,'.metadata','.plugins'),{recursive:true});
  writeFileSync(join(state,'.metadata','.log'),'Workspace initialized in 15ms\n');
  // Even a symlink/oversized binary cache must never be traversed or collected.
  writeFileSync(join(out,'foreign-index'),'');truncateSync(join(out,'foreign-index'),bootLimits.fileBytes+1);
  symlinkSync(join(out,'foreign-index'),join(state,'.metadata','.plugins','index'));
  const result=collectBootArtifacts(out,kind);assert.equal(result.status,'PASS');
  assert.deepEqual(result.missing,[]);
  assert.deepEqual(result.files.map(file=>file.path),['jdt-workspace.log']);
  assert.equal(readFileSync(join(boot,'jdt-workspace.log'),'utf8'),'Workspace initialized in 15ms\n');
  assert.throws(()=>prepareJdtStateDirectory(out,kind),/EEXIST/);
  assert.throws(()=>prepareJdtStateDirectory(out,'../foreign'));
});
test('dedicated state and metadata symlinks fail closed without copying foreign logs',t=>{
  const {out,boot,kind}=fixture(t);
  const foreign=join(out,'foreign');mkdirSync(join(foreign,'.metadata'),{recursive:true});
  writeFileSync(join(foreign,'.metadata','.log'),'not owned evidence');
  const state=join(out,`jdt-state-${kind}`);symlinkSync(foreign,state);
  assert.equal(collectBootArtifacts(out,kind).status,'FAIL');
  assert.throws(()=>readFileSync(join(boot,'jdt-workspace.log')),/ENOENT/);
  rmSync(state);mkdirSync(state);symlinkSync(join(foreign,'.metadata'),join(state,'.metadata'));
  assert.equal(collectBootArtifacts(out,kind).status,'FAIL');
  assert.throws(()=>readFileSync(join(boot,'jdt-workspace.log')),/ENOENT/);
  assert.equal(readFileSync(join(foreign,'.metadata','.log'),'utf8'),'not owned evidence');
});
test('actual imported Java project and Started status required, not completion/default workspace',()=>{
  for(const uri of ['file:///work','file:/work/']){
    const result=assertJavaProjectImported({type:'Started',message:'Ready'},[uri]);
    assert.equal(result.status,'PASS');assert.equal(result.importedProject,'file:///work');
  }
  for(const projects of [[],['file:///jdt-state/jdt.ls-java-project'],['file:///work/nested'],['file:///work2'],['https://host/work'],['file://host/work'],['file:///work?x=1'],[null]]){
    assert.throws(()=>assertJavaProjectImported({type:'Started'},projects),/missing|Invalid/);
  }
  for(const type of ['Starting','Error',undefined])assert.throws(()=>assertJavaProjectImported({type,message:'Invalid project description'},['file:///work']),/initialization failed/);
});
test('non-project and classpath warnings fail semantic guard without filtering real diagnostics',()=>{
  const uri='file:///work/src/Demo.java';
  const event=(message,severity=2,path=uri)=>({message:{method:'textDocument/publishDiagnostics',params:{uri:path,diagnostics:[{message,severity}]}}});
  const real=event('Type mismatch: cannot convert from String to int',1);
  assert.equal(assertJavaProjectDiagnostics([real],uri).status,'PASS');
  assert.equal(real.message.params.diagnostics[0].severity,1); // never hide required type/release checks
  for(const message of ['Demo.java is a non-project file, only syntax errors are reported','Demo.java is not on the classpath of project lsp-probe','Only syntax errors are reported']){
    assert.throws(()=>assertJavaProjectDiagnostics([real,event(message)],uri),/non-project\/classpath diagnostics/);
  }
  assert.equal(assertJavaProjectDiagnostics([event('non-project file',2,'file:///unrelated.java')],uri).status,'PASS');
});

test('state log symlink or oversized log retains evidence and fails collection',t=>{
  const {out,boot,kind}=fixture(t),state=prepareJdtStateDirectory(out,kind);
  mkdirSync(join(state,'.metadata'));
  const log=join(state,'.metadata','.log'),foreign=join(out,'foreign.log');
  writeFileSync(foreign,'not owned evidence');symlinkSync(foreign,log);
  assert.equal(collectBootArtifacts(out,kind).status,'FAIL');
  assert.throws(()=>readFileSync(join(boot,'jdt-workspace.log')),/ENOENT/);
  rmSync(log);writeFileSync(log,'');truncateSync(log,bootLimits.fileBytes+1);
  assert.equal(collectBootArtifacts(out,kind).status,'FAIL');
  assert.throws(()=>readFileSync(join(boot,'jdt-workspace.log')),/ENOENT/);
  assert.equal(readFileSync(foreign,'utf8'),'not owned evidence');
});
