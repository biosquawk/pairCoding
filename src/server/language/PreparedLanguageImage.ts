/** Read-only admission of the SEPARATE language image. No builds/probes/pulls at editor startup.
 * Exact producer tool-probe receipts are evidence only alongside CURRENT OCI/config/engine inspect.
 */
import { isDeepStrictEqual as same } from 'node:util';
import { isAbsolute } from 'node:path';
import type { ImageLockEntry } from '../../shared/runtime-v2';
import type { ResolvedRuntime } from '../runtime-config';
import { createPreparedRuntimeInspection, type PreparedCacheLease } from '../runtime-coordinator/PreparedRuntimeResolver';
import type { DockerTransport } from '../execution/DockerTransport';
import { readRegular } from './LanguageProcessJournal';
import pins from '../../../runtimes/production-inputs.lock.json';

type Obj = Record<string, any>;
const assertLease = (lease: PreparedCacheLease): void => { if (lease.assertCurrent() !== undefined) throw new Error('Synchronous current lease required'); };
const requireThat: (value: unknown) => asserts value = value => { if (!value) throw new Error('Language image/tools require explicit verified preparation'); };
const obj = (value: unknown): Obj => { requireThat(value && typeof value === 'object' && !Array.isArray(value)); return value as Obj; };
const digest = (value: unknown): value is string => typeof value === 'string' && /^sha256:[a-f0-9]{64}$/.test(value);
const toolsEqual = (a: ImageLockEntry['tools'], b: ImageLockEntry['tools']) => same([...a].sort((x,y) => x.name.localeCompare(y.name)), [...b].sort((x,y) => x.name.localeCompare(y.name)));
function inspectedImage(value: unknown, lock: ImageLockEntry): void {
  const image = obj(Array.isArray(value) ? (requireThat(value.length === 1), value[0]) : value), config = obj(image.Config);
  requireThat(digest(lock.imageId) && digest(lock.digest) && image.Id === lock.imageId && image.Os === 'linux' && image.Architecture === 'amd64' &&
    config.User === '10001:10001' && (config.Entrypoint == null || Array.isArray(config.Entrypoint) && config.Entrypoint.length === 0));
  const descriptor = image.Descriptor == null ? null : obj(image.Descriptor);
  const descriptorMatch = descriptor && descriptor.digest === lock.digest && Number.isSafeInteger(descriptor.size) && descriptor.size > 0 && [
    'application/vnd.oci.image.manifest.v1+json', 'application/vnd.oci.image.index.v1+json',
    'application/vnd.docker.distribution.manifest.v2+json', 'application/vnd.docker.distribution.manifest.list.v2+json',
  ].includes(descriptor.mediaType);
  const repoMatch = Array.isArray(image.RepoDigests) && image.RepoDigests.some((s: unknown) => typeof s === 'string' &&
    /^[a-z0-9]+(?:[._-][a-z0-9]+)*(?::[0-9]{1,5})?(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)*@sha256:[a-f0-9]{64}$/.test(s) && s.endsWith('@' + lock.digest));
  requireThat(descriptorMatch || repoMatch); // config Id alone NEVER establishes manifest identity.
}
function engine(value: unknown): Obj {
  const e = obj(value);
  requireThat(typeof e.ID === 'string' && /^[A-Za-z0-9:_.-]{1,200}$/.test(e.ID) && typeof e.ServerVersion === 'string' && e.ServerVersion.length > 0 &&
    e.OSType === 'linux' && ['amd64','x86_64'].includes(e.Architecture));
  return { ID: e.ID, ServerVersion: e.ServerVersion, OSType: e.OSType, Architecture: e.Architecture };
}
function measuredTools(item: Obj, runtime: ResolvedRuntime): ImageLockEntry['tools'] {
  const tools = item.tools;
  requireThat(item.status === 'BUILT_TOOLS_CHECKED_NOT_LSP_FUNCTIONAL_ACCEPTANCE' && Array.isArray(tools) && tools.length > 0 && tools.length <= 5);
  const names = new Set<string>(), containers = new Set<string>();
  for (const value of tools) {
    const p = obj(value), c = obj(p.container), state = obj(c.State), config = obj(c.Config), labels = obj(config.Labels);
    requireThat(typeof p.name === 'string' && !names.has(p.name) && typeof c.Id === 'string' && /^[a-f0-9]{64}$/.test(c.Id) && !containers.has(c.Id) &&
      p.status === 'TOOL_PROBE_PASS_REMOVED' && state.Running === false && state.ExitCode === 0 && config.Image === item.observedImage.Id &&
      labels['paircoach.installation'] === 'stage09-runtime-assets' && labels['paircoach.role'] === 'language-tool-probe' &&
      typeof p.stdout === 'string' && typeof p.stderr === 'string' && Buffer.byteLength(p.stdout + p.stderr) <= 128 * 1024);
    names.add(p.name); containers.add(c.Id);
  }
  if (runtime.profile.language.provider === 'jdt') {
    const expected = [{ name: 'jdt-server-java', version: runtime.profile.language.serverJvm }, ...[11,17,21,27].map(release => ({
      name: 'target-javac-' + release, version: runtime.catalog.profiles.find(p => p.adapterFamily === 'java-maven' && p.compilerRelease === release)?.expectedTools.find(t => t.name === 'javac')?.version,
    }))];
    requireThat(tools.length === expected.length);
    return expected.map(e => {
      requireThat(typeof e.version === 'string' && e.version.length > 0);
      const p = tools.find(p => p.name === 'paircoach-stage09-language-' + e.name); requireThat(p);
      const observed = (p.stdout + p.stderr).trim().match(e.name === 'jdt-server-java' ? /version "([^"]+)"/ : /^javac (\S+)/)?.[1];
      requireThat(observed === e.version && p.version === observed);
      return { name: e.name === 'jdt-server-java' ? 'java' : e.name, version: observed };
    });
  }
  requireThat(runtime.profile.language.provider === 'pylsp' && tools.length === 1 && tools[0].name === 'paircoach-stage09-language-python-pylsp-inventory');
  const actual = obj(JSON.parse(tools[0].stdout)), packages = obj(actual.packages);
  requireThat(same(actual, tools[0].inventory) && actual.python === pins.language.pylsp.pythonVersion &&
    pins.language.artifacts.filter(a => a.kind === 'language-wheel').every(a => packages[a.name] === a.version));
  return [{ name: 'python', version: actual.python }, ...['python-lsp-server','jedi','pyflakes'].map(name => ({ name, version: packages[name] }))];
}
export interface VerifiedLanguageImage {
  readonly engineId: string; readonly imageId: string;
  /** Exact retained lease + evidence bytes; actual process driver separately rechecks engine at effects. */
  assertCurrent(): void;
}
/** Actual installed producer layout (operator aggregate or public CLI receipt.language), not a wire DTO.
 * Caller supplies a trusted explicit receipt path; no filesystem discovery or fallback to Run receipts.
 */
export class PreparedLanguageImageVerifier {
  private readonly inspection: ReturnType<typeof createPreparedRuntimeInspection>;
  constructor(private readonly receiptPath: string, transport: Pick<DockerTransport, 'run'>) {
    requireThat(isAbsolute(receiptPath)); this.inspection = createPreparedRuntimeInspection(transport);
  }
  async verify(runtime: ResolvedRuntime, expectedEngineId: string, lease: PreparedCacheLease): Promise<VerifiedLanguageImage> {
    assertLease(lease);
    const bytes = readRegular(this.receiptPath, 4 * 1024 * 1024), receipt = obj(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
    const lock = runtime.languageImage;
    requireThat(lock && lock.key === runtime.profile.language.imageLockKey && lock.imageId !== runtime.image.imageId &&
      Array.isArray(receipt.language) && receipt.language.length > 0 && receipt.language.length <= 2);
    const matches = receipt.language.filter((i: unknown) => obj(i).key === lock.key); requireThat(matches.length === 1);
    const item = obj(matches[0]), recordedEngine = engine(item.engine), observed = obj(item.observedImage);
    requireThat(item.imageTag === lock.image && observed.Id === lock.imageId && recordedEngine.ID === expectedEngineId &&
      toolsEqual(measuredTools(item, runtime), lock.tools));
    const before = engine(await this.inspection.inspectEngine()); assertLease(lease);
    requireThat(same(before, recordedEngine));
    inspectedImage(await this.inspection.inspectImage(lock.imageId), lock); assertLease(lease);
    const after = engine(await this.inspection.inspectEngine()); assertLease(lease); requireThat(same(before, after));
    const assertCurrent = () => { assertLease(lease); requireThat(readRegular(this.receiptPath, 4 * 1024 * 1024).equals(bytes)); assertLease(lease); };
    assertCurrent(); return Object.freeze({ engineId: expectedEngineId, imageId: lock.imageId, assertCurrent });
  }
}
