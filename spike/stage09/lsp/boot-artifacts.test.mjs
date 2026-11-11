import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,symlinkSync,rmSync,truncateSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {javaLaunch,prepareBootDirectory,readJavaVersions,readBoundedFile,collectBootArtifacts,bootLimits} from './boot-artifacts.mjs';
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
  assert.deepEqual(result.missing,['shadow/.jdt-data/.metadata/.log']);
  assert.ok(result.files.some(file=>file.path==='jdt-config/123.log'&&file.sha256.length===64));
  assert.equal(readFileSync(join(boot,'jdt-config','123.log'),'utf8'),'Unresolved requirement: JavaSE-25\n');
  assert.deepEqual(JSON.parse(readFileSync(join(out,`${kind}-boot-artifacts.json`))),result);
});
test('workspace log bounded collection is repeatable for post-timeout recovery',t=>{
  const {out,boot,kind}=fixture(t);
  mkdirSync(join(out,`shadow-${kind}`,'.jdt-data','.metadata'),{recursive:true});
  writeFileSync(join(out,`shadow-${kind}`,'.jdt-data','.metadata','.log'),'workspace failure\n');
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
