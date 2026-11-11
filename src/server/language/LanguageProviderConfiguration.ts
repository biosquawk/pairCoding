import type { RuntimeProfile } from '../../shared/runtime-v2';
import { validateRuntimeProfile } from '../../shared/validation-v2';
import { assertRelativePath, toWorkspaceUri } from '../../language/uriCodec';
import { sha256 } from './LanguageProcessJournal';
import { LANGUAGE_DEPENDENCY_DIRECTORY, type ShadowFile } from './LanguageShadowStore';
import type { ConfigurationRequestMethod } from './JsonRpcTransport';
/** Backend verified actual prepare receipt/cache inventory, NOT task/wire booleans or image-ready proof. */
export interface TrustedPreparedLanguageDependencies {
  family: 'java-maven' | 'python'; workingDirectory: '.' | string;
  dependencySha256: string; toolchainSha256: string;
  /** Complete regular files read from verified immutable prepared cache; shadow copies cache root as-is. */
  files: readonly ShadowFile[];
}
export interface LanguageProviderConfiguration {
  provider: 'jdt' | 'pylsp'; argv: readonly string[]; settings: Readonly<Record<string, unknown>>;
  bootFiles: Readonly<Record<string, string>>;
  expectedProjectUri: string; analysisSettingsSha256: string;
  dependencyCopyDirectory: typeof LANGUAGE_DEPENDENCY_DIRECTORY;
}
const freeze = <T>(v: T): T => { if (v && typeof v === 'object') { Object.values(v).forEach(freeze); Object.freeze(v); } return v; };
const hash = (v: string) => /^[a-f0-9]{64}$/.test(v);
const targetHomes = { 11: '/opt/jdk11', 17: '/opt/jdk17', 21: '/opt/java/openjdk', 27: '/opt/jdk27' } as const;
const dependencyRoot = '/workspace/' + LANGUAGE_DEPENDENCY_DIRECTORY;
/**
 * Pure pinned launch+init construction. No download/install/host command or inferred ready image/cache.
 * Source-grounded JDT metadata redirect preserves /workspace RO; actual m2e/Jedi import still requires
 * distinct bounded real proof. Java compiler release remains original effective POM, NEVER rewritten.
 */
export function buildLanguageProviderConfiguration(profile: RuntimeProfile, cache: TrustedPreparedLanguageDependencies): Readonly<LanguageProviderConfiguration> {
  if (!validateRuntimeProfile(profile) || !['jdt', 'pylsp'].includes(profile.language.provider) ||
    cache.family !== profile.adapterFamily || !hash(cache.dependencySha256) || !hash(cache.toolchainSha256) ||
    !Array.isArray(cache.files) || cache.files.length > 16000) throw new Error('Invalid trusted language preparation/profile');
  if (cache.workingDirectory !== '.') assertRelativePath(cache.workingDirectory);
  const seen = new Set<string>();
  for (const file of cache.files) {
    assertRelativePath(file.path);
    if (seen.has(file.path) || !hash(file.sha256) || !Number.isSafeInteger(file.bytes) || file.bytes < 0) throw new Error('Invalid language dependency inventory');
    seen.add(file.path);
  }
  for (const path of ['tools.json', 'dependencies-prepared.json']) if (!seen.has(path)) throw new Error('Missing actual prepared dependency metadata');
  const cwd = cache.workingDirectory === '.' ? '/workspace' : '/workspace/' + cache.workingDirectory;
  const expectedProjectUri = cache.workingDirectory === '.' ? 'file:///workspace' : toWorkspaceUri(cache.workingDirectory);
  let provider: 'jdt' | 'pylsp', argv: string[], settings: Record<string, unknown>, bootFiles: Record<string, string> = {};
  if (profile.language.provider === 'jdt') {
    if (profile.compilerRelease === null || !/^27(?:\.\d+)*$/.test(profile.language.serverJvm ?? '') || !seen.has('effective-pom.xml') || !cache.files.some(f => f.path.startsWith('m2/')))
      throw new Error('Prepared Maven/target/server27 data required');
    provider = 'jdt';
    // No task-derived shell data: every path/token in this program is a fixed pinned constant.
    const program = [
      'set -eu', 'cp -R /opt/jdt/config_linux /artifacts/jdt-config',
      `cp -R ${dependencyRoot}/m2 /jdt-state/m2`, 'chmod -R u+w /jdt-state/m2',
      'exec /opt/jdk27/bin/java -Declipse.application=org.eclipse.jdt.ls.core.id1 -Dosgi.bundles.defaultStartLevel=4 -Declipse.product=org.eclipse.jdt.ls.core.product ' +
        '-Djava.import.generatesMetadataFilesAtProjectRoot=false -Dosgi.logfile=/artifacts/osgi.log -XX:ErrorFile=/artifacts/hs_err_pid%p.log -Xmx1024m ' +
        '--add-modules=ALL-SYSTEM --add-opens java.base/java.util=ALL-UNNAMED --add-opens java.base/java.lang=ALL-UNNAMED ' +
        '-jar /opt/jdt/plugins/org.eclipse.equinox.launcher_1.8.0.v20260804-1928.jar -configuration /artifacts/jdt-config -data /jdt-state',
    ].join(' && ');
    argv = ['/bin/sh', '-c', program];
    bootFiles = { 'maven-settings.xml': '<?xml version="1.0" encoding="UTF-8"?>\n<settings xmlns="http://maven.apache.org/SETTINGS/1.2.0"><localRepository>/jdt-state/m2</localRepository><offline>true</offline><interactiveMode>false</interactiveMode></settings>\n' };
    settings = { java: { configuration: { runtimes: Object.entries(targetHomes).map(([release, path]) => ({ name: `JavaSE-${release}`, path, default: Number(release) === profile.compilerRelease })),
      maven: { userSettings: '/artifacts/maven-settings.xml', globalSettings: '/artifacts/maven-settings.xml' }, updateBuildConfiguration: 'automatic' },
      import: { maven: { enabled: true, offline: { enabled: true } }, gradle: { enabled: false } },
      maven: { downloadSources: false, updateSnapshots: false }, autobuild: { enabled: false }, completion: { enabled: true } } };
  } else {
    if (!cache.files.some(f => f.path.startsWith('site-packages/'))) throw new Error('Prepared Python site-packages required');
    provider = 'pylsp'; argv = ['/usr/local/bin/python', '-m', 'pylsp'];
    // Server packages stay immutable PYTHONPATH=/opt/pylsp; task dependencies are analyzer search paths,
    // NEVER prepended to server module import path. Fixed project cwd is DATA in RPC, not shell text.
    settings = { pylsp: { plugins: { jedi: { extra_paths: [cwd, dependencyRoot + '/site-packages'], auto_import_modules: [] },
      jedi_completion: { enabled: true, include_params: false }, pyflakes: { enabled: true }, pycodestyle: { enabled: false } } } };
  }
  const unsigned = { provider, argv, settings, bootFiles, expectedProjectUri, dependencyCopyDirectory: LANGUAGE_DEPENDENCY_DIRECTORY as typeof LANGUAGE_DEPENDENCY_DIRECTORY };
  return freeze({ ...unsigned, analysisSettingsSha256: sha256(JSON.stringify(unsigned)) });
}
/** Narrow trusted workspace/configuration service; no file reads, writes, commands or wire key authority. */
export function readLanguageProviderConfiguration(config: Readonly<LanguageProviderConfiguration>, method: ConfigurationRequestMethod, params: unknown): unknown {
  if (method === 'workspace/workspaceFolders') return [{ uri: 'file:///workspace', name: 'PairCoach' }];
  const p = params as { items?: unknown } | null;
  if (!p || !Array.isArray(p.items) || p.items.length > 32) throw new Error('Invalid provider configuration request');
  return p.items.map(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
    const { section, scopeUri } = item as { section?: unknown; scopeUri?: unknown };
    if (scopeUri !== undefined && scopeUri !== null && scopeUri !== 'file:///workspace' && scopeUri !== config.expectedProjectUri) return null;
    if (section === undefined || section === null || section === '') return config.settings;
    if (typeof section !== 'string' || section.length > 128) return null;
    let current: unknown = config.settings;
    for (const key of section.split('.')) {
      if (!key || !current || typeof current !== 'object' || !Object.hasOwn(current, key)) return null;
      current = (current as Record<string, unknown>)[key];
    }
    return current ?? null;
  });
}
