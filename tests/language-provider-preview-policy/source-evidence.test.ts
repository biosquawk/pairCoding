/** Static pinned-source/evidence checks ONLY: no Java compiler or language server is executed. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
const root=new URL('../../investigations/stage09/provider-preview-policy/',import.meta.url);
const text=(p:string)=>readFileSync(new URL(p,root),'utf8');
const json=(p:string)=>JSON.parse(text(p));
test('all retained upstream and prior evidence bytes match recorded SHA256',()=>{
  for(const r of json('sources.json')) {
    assert.equal(createHash('sha256').update(readFileSync(new URL(r.file,root))).digest('hex'),r.sha256,r.file);
    if(r.url) assert.ok(r.url.includes('d98abba8f04cf041542d9ebb6df0d472a1395606'));
  }
});
test('pinned LS consumes initialization settings and java.settings.url Properties as global options, not arbitrary preview JSON',()=>{
  const prefs=text('raw/Preferences.java'), init=text('raw/BaseInitHandler.java'), server=text('raw/JDTLanguageServer.java'), manager=text('raw/StandardProjectsManager.java');
  assert.match(init,/Preferences\.createFrom\(\(Map<String, Object>\) settings\)/);
  assert.match(server,/Preferences\.updateFrom\(preferenceManager\.getPreferences\(\), \(Map<String, Object>\) settings\)/);
  assert.match(prefs,/JAVA_SETTINGS_URL = "java.settings.url"/);
  assert.match(prefs,/containsKey\(configuration, JAVA_SETTINGS_URL\)/);
  assert.equal(/enablePreviewFeatures|analysis\.preview|compile\.enablePreview/.test(prefs),false);
  assert.match(manager,/settingsUri\.toURL\(\)\.openStream\(\)/);
  assert.match(manager,/properties\.load\(inputStream\)/);
  assert.match(manager,/EclipsePreferences\.decodePath\(path\)/);
  assert.match(manager,/javaOptions\.put\(key, value\)/);
  assert.match(manager,/JavaCore\.setOptions\(javaOptions\)/);
});
test('existing actual5a already disabled preview yet FAIL with raw warning4195412; no relabelled semantic pass',()=>{
  const prior=json('prior/actual5a-summary.json');
  assert.equal(prior.source_sha,'5a10b46fe74b8d956591a6ebb484f07d2509c27f'); assert.equal(prior.status,'FAIL');
  const java=prior.cases.java21; assert.equal(java.status,'FAIL');
  assert.equal(java.compilerPolicy.actual['org.eclipse.jdt.core.compiler.problem.enablePreviewFeatures'],'disabled');
  assert.equal(java.compilerPolicy.actual['org.eclipse.jdt.core.compiler.problem.reportPreviewFeatures'],'warning');
  assert.equal(java.compilerPolicy.actual['org.eclipse.jdt.core.compiler.compliance'],'21');
  const observed=json('prior/observations.json').java21.diagnosticVersionFields.flatMap((r:any)=>r.diagnostics);
  assert.ok(observed.length>0); assert.ok(observed.every((d:any)=>d.severity===2 && d.code==='4195412'));
});
test('pinned compiler older-than-latest branch and permitted report values rule out guessed config repair',()=>{
  const reporter=text('prior/raw/jdt-ProblemReporter.java'), api=text('prior/raw/jdt-JavaCore.java');
  assert.match(reporter,/if \(!this.options.enablePreviewFeatures\) \{\s*if \(this.options.complianceLevel < ClassFileConstants.getLatestJDKLevel\(\)\) \{\s*problemId = IProblem.PreviewAPIUsed;/);
  assert.match(api,/Possible values:<\/dt><dd><code>\{ "warning", "info", "ignore" \}/);
  const bytecode=json('prior/bytecode.json');
  assert.equal(bytecode.sha256,'f667bb3666d9875a2309fa2447a19e6cdd960281473bd7125a22c5a435246d21');
  assert.ok(bytecode.methods.some((m:any)=>m.name==='previewAPIUsed'));
});
