import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {javaCompilerOptions,javaProjectPreferences,javaSettingsRequest,assertEffectiveJavaSettings,runCases,runOutcome} from './spike-policy.mjs';

test('target21/27 have explicit release and preview disabled, independent of server JVM',()=>{
  for(const target of [21,27]){
    const options=javaCompilerOptions(target);
    const prefs=Object.fromEntries(javaProjectPreferences(target).trim().split('\n').map(line=>line.split('=')));
    assert.equal(prefs['eclipse.preferences.version'],'1');delete prefs['eclipse.preferences.version'];
    assert.deepEqual(prefs,options);
    for(const key of ['codegen.targetPlatform','compliance','source'])assert.equal(options[`org.eclipse.jdt.core.compiler.${key}`],String(target));
    assert.equal(options['org.eclipse.jdt.core.compiler.release'],'enabled');
    assert.equal(options['org.eclipse.jdt.core.compiler.problem.enablePreviewFeatures'],'disabled');
    // Reporting preview remains warning; this must NOT manufacture severity1.
    assert.equal(options['org.eclipse.jdt.core.compiler.problem.reportPreviewFeatures'],'warning');
  }
  for(const target of [11,17,'21',undefined])assert.throws(()=>javaCompilerOptions(target));
});
test('fixed source-reviewed read-only request captures inherited options and assigned VM',()=>{
  for(const target of [21,27]){
    const request=javaSettingsRequest(target);
    assert.equal(request.command,'java.project.getSettings');assert.equal(request.arguments[0],'file:///work/src/Demo.java');
    assert.deepEqual(request.arguments[1],[...Object.keys(javaCompilerOptions(target)),'org.eclipse.jdt.ls.core.vm.location']);
    assert.equal(request.arguments[1].length,7);
    const actual={...javaCompilerOptions(target),'org.eclipse.jdt.ls.core.vm.location':target===21?'/opt/java/openjdk':'/opt/jdk27'};
    assert.equal(assertEffectiveJavaSettings(target,actual).status,'PASS');
    for(const key of Object.keys(actual)){
      const bad={...actual,[key]:'wrong'};assert.throws(()=>assertEffectiveJavaSettings(target,bad),/mismatch/);
      delete bad[key];assert.throws(()=>assertEffectiveJavaSettings(target,bad),/mismatch/);
    }
    for(const bad of [null,[],{},'enabled'])assert.throws(()=>assertEffectiveJavaSettings(target,bad));
  }
});
test('old c9 policy without preview flags cannot satisfy new policy (not proof of cause)',()=>{
  const old={...javaCompilerOptions(21),'org.eclipse.jdt.ls.core.vm.location':'/opt/java/openjdk'};
  delete old['org.eclipse.jdt.core.compiler.problem.enablePreviewFeatures'];
  delete old['org.eclipse.jdt.core.compiler.problem.reportPreviewFeatures'];
  assert.throws(()=>assertEffectiveJavaSettings(21,old),/enablePreviewFeatures/);
});
test('default FULL order unchanged, diagnostic mode explicit and never whole PASS',()=>{
  assert.deepEqual(runCases('run'),[['java',27],['java',21],['python',null]]);
  assert.equal(runOutcome('run').status,'PASS');
  assert.deepEqual(runCases('python-only'),[['python',null]]);
  assert.equal(runOutcome('python-only').status,'PASS_PYTHON_DIAGNOSTIC_ONLY');
  assert.match(runOutcome('python-only').scope,/Java NOT_RUN; NOT full suite/);
  for(const mode of [undefined,'','python','skip-java','prepare']){
    assert.throws(()=>runCases(mode));assert.throws(()=>runOutcome(mode));
  }
  const source=readFileSync(new URL('./spike.mjs',import.meta.url),'utf8');
  assert.ok(source.includes('results.push(await exercise(language,target,images.images[language].imageId))'));
  assert.ok(source.includes('of runCases(mode)'));
  assert.ok(source.indexOf('effective-settings.json')<source.indexOf('summary.compilerPolicy=assertEffectiveJavaSettings(target,actual)'));
});
