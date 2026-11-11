// Bounded A–B harness policy only; no product or Docker implementation.
import assert from 'node:assert/strict';

export function javaCompilerOptions(target) {
  if(![21,27].includes(target))throw new Error('Invalid Java analysis release');
  return {
    'org.eclipse.jdt.core.compiler.codegen.targetPlatform':String(target),
    'org.eclipse.jdt.core.compiler.compliance':String(target),
    'org.eclipse.jdt.core.compiler.source':String(target),
    'org.eclipse.jdt.core.compiler.release':'enabled',
    'org.eclipse.jdt.core.compiler.problem.enablePreviewFeatures':'disabled',
    'org.eclipse.jdt.core.compiler.problem.reportPreviewFeatures':'warning'
  };
}
export function javaProjectPreferences(target) {
  return 'eclipse.preferences.version=1\n'+Object.entries(javaCompilerOptions(target)).map(([key,value])=>`${key}=${value}\n`).join('');
}
const vmKey='org.eclipse.jdt.ls.core.vm.location';
export function javaSettingsRequest(target) {
  // Pinned JDTDelegateCommandHandler -> ProjectCommand.getProjectSettings.
  // Only six compiler values plus assigned VM, using getOption(key,true).
  return {command:'java.project.getSettings',arguments:['file:///work/src/Demo.java',[...Object.keys(javaCompilerOptions(target)),vmKey]]};
}
export function assertEffectiveJavaSettings(target,actual) {
  const expected={...javaCompilerOptions(target),[vmKey]:target===21?'/opt/java/openjdk':'/opt/jdk27'};
  assert.ok(actual&&typeof actual==='object'&&!Array.isArray(actual),'Missing effective JDT project settings');
  for(const [key,value]of Object.entries(expected))assert.equal(actual[key],value,`Effective JDT option mismatch: ${key}`);
  return {status:'PASS',expected,actual,scope:'Observed inherited project options; not a substitute for original semantic diagnostic oracle'};
}
export function runCases(mode) {
  if(mode==='run')return [['java',27],['java',21],['python',null]];
  if(mode==='python-only')return [['python',null]];
  throw new Error('Invalid LSP execution mode');
}
export function runOutcome(mode) {
  runCases(mode); // fail closed, no misspelled/default partial mode
  return mode==='run'
    ? {status:'PASS',scope:'LSP A–B only; not GUI LIVE, runtime or gate approval'}
    : {status:'PASS_PYTHON_DIAGNOSTIC_ONLY',scope:'Isolated Python LSP DIAGNOSTIC only; Java NOT_RUN; NOT full suite or A–B gate PASS'};
}
