import { readFileSync } from 'node:fs';
import type { RuntimeCatalog, RuntimeProfile, JavaRelease } from '../../src/shared/runtime-v2';
import type { TrustedPreparedLanguageDependencies } from '../../src/server/language/LanguageProviderConfiguration';
const catalog = JSON.parse(readFileSync(new URL('../../runtimes/catalog.json', import.meta.url), 'utf8')) as RuntimeCatalog;
export function profile(release: JavaRelease | 'python' = 21): RuntimeProfile {
  const p = catalog.profiles.find(p => release === 'python' ? p.adapterFamily === 'python' : p.compilerRelease === release);
  if (!p) throw new Error(`Missing production profile ${release}`);
  return structuredClone(p);
}
// Unit metadata ONLY, not a real prepared cache or proof of semantic import.
export function cache(family: 'java-maven' | 'python' = 'java-maven'): TrustedPreparedLanguageDependencies {
  return { family, workingDirectory: '.', dependencySha256: 'a'.repeat(64), toolchainSha256: 'b'.repeat(64), files:
    ['tools.json', 'dependencies-prepared.json', ...(family === 'java-maven' ? ['effective-pom.xml','m2/example.jar'] : ['site-packages/example.py'])]
      .map(path => ({path, bytes: 1, sha256: 'c'.repeat(64)})) };
}
