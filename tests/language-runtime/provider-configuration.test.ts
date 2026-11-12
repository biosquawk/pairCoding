import test from 'node:test';
import assert from 'node:assert/strict';
import { buildLanguageProviderConfiguration, readLanguageProviderConfiguration, type TrustedPreparedLanguageDependencies } from '../../src/server/language/LanguageProviderConfiguration';
import { profile } from '../runtime-contract/fixtures';
import { validateRuntimeProfile } from '../../src/shared/validation-v2';
const cache = (family: 'java-maven' | 'python'): TrustedPreparedLanguageDependencies => ({ family, workingDirectory: '.', dependencySha256: 'a'.repeat(64), toolchainSha256: 'b'.repeat(64),
  files: ['tools.json', 'dependencies-prepared.json', ...(family === 'java-maven' ? ['effective-pom.xml', 'm2/example/1.0/example.jar'] : ['site-packages/example/__init__.py'])].map(path => ({ path, bytes: 1, sha256: 'c'.repeat(64) })) });
test('pure pinned JDT configuration serves all targets with server JVM27 independent, no arbitrary shell/task data', () => {
  for (const release of [11, 17, 21, 27] as const) {
    const p = profile('java-maven'); p.compilerRelease = release; p.analysis.languageLevel = String(release); assert.equal(validateRuntimeProfile(p), true);
    const config = buildLanguageProviderConfiguration(p, cache('java-maven'));
    assert.equal(config.provider, 'jdt'); assert.equal(config.argv[0], '/bin/sh'); assert.match(config.argv[2], /exec \/opt\/jdk27\/bin\/java/);
    assert.match(config.argv[2], /-Djava.import.generatesMetadataFilesAtProjectRoot=false/); assert.match(config.argv[2], /launcher_1\.8\.0\.v20260804-1928.jar/);
    assert.match(config.argv[2], /-data \/jdt-state/); assert.equal(config.expectedProjectUri, 'file:///workspace');
    const settings = config.settings as any; assert.equal(settings.java.configuration.runtimes.filter((r: any) => r.default).length, 1);
    assert.equal(settings.java.configuration.runtimes.find((r: any) => r.default).name, `JavaSE-${release}`);
    assert.equal(settings.java.import.maven.offline.enabled, true); assert.equal(settings.java.import.gradle.enabled, false);
    assert.match(config.bootFiles['maven-settings.xml'], /<offline>true<\/offline>/); assert.match(config.bootFiles['maven-settings.xml'], /<localRepository>\/jdt-state\/m2<\/localRepository>/);
    assert.equal(/https:|pip |mvn |severity|reportPreviewFeatures/.test(config.argv.join(' ') + JSON.stringify(config.settings)), false);
    assert.equal(config.analysisSettingsSha256.length, 64); assert.equal(Object.isFrozen(config.settings), true);
  }
});
test('Python keeps server executable/imports immutable, task dependencies ONLY in analyzer extra_paths', () => {
  const c = cache('python'); c.workingDirectory = 'src/Zażółć space'; const config = buildLanguageProviderConfiguration(profile(), c);
  assert.deepEqual(config.argv, ['/usr/local/bin/python', '-m', 'pylsp']); assert.equal(config.expectedProjectUri, 'file:///workspace/src/Za%C5%BC%C3%B3%C5%82%C4%87%20space');
  assert.deepEqual((config.settings as any).pylsp.plugins.jedi.extra_paths, ['/workspace/src/Zażółć space', '/workspace/.paircoach-dependencies/site-packages']);
  assert.equal(config.argv.join(' ').includes('PYTHONPATH'), false); assert.deepEqual(config.bootFiles, {});
});
test('bad profile/family/metadata/cache paths/server JVM/absent actual dependency inventory fail closed', () => {
  const p = profile('java-maven');
  for (const mutate of [(c: any) => c.files = [], (c: any) => c.family = 'python', (c: any) => c.workingDirectory = '../escape',
    (c: any) => c.files.push({ ...c.files[0] }), (c: any) => c.files[0].path = '/absolute', (c: any) => c.dependencySha256 = 'unknown',
    (c: any) => c.files = c.files.filter((f: any) => !f.path.startsWith('m2/'))]) {
    const c = cache('java-maven'); mutate(c); assert.throws(() => buildLanguageProviderConfiguration(p, c));
  }
  p.language.serverJvm = '21'; assert.throws(() => buildLanguageProviderConfiguration(p, cache('java-maven')), /server27/);
});
test('configuration hash covers exact target/argv/settings/task cwd without claim prepared or real import', () => {
  const c = cache('python'), p = profile(); const a = buildLanguageProviderConfiguration(p, c), b = buildLanguageProviderConfiguration(p, c);
  assert.equal(a.analysisSettingsSha256, b.analysisSettingsSha256); c.workingDirectory = 'other'; const d = buildLanguageProviderConfiguration(p, c);
  assert.notEqual(a.analysisSettingsSha256, d.analysisSettingsSha256); assert.equal('ready' in a, false);
});
test('workspace/configuration only allows frozen settings sections in exact project scope', () => {
  const config = buildLanguageProviderConfiguration(profile(), cache('python'));
  const read = (items: unknown[]) => readLanguageProviderConfiguration(config, 'workspace/configuration', { items });
  assert.deepEqual(read([{ section: 'pylsp.plugins.pyflakes' }]), [{ enabled: true }]);
  assert.deepEqual(read([{ section: '__proto__' }, { section: 'pylsp.constructor' }, { section: 'pylsp', scopeUri: 'file:///foreign' }]), [null, null, null]);
  assert.deepEqual(read([{}]), [config.settings]); assert.throws(() => read(new Array(33).fill({})), /Invalid/);
  assert.deepEqual(readLanguageProviderConfiguration(config, 'workspace/workspaceFolders', {}), [{ uri: 'file:///workspace', name: 'PairCoach' }]);
});
