import { isDeepStrictEqual as same } from 'node:util';
import type { RunProfileV2 } from '../../shared/runtime-v2';
import type { ResolvedRuntime } from '../runtime-config';
import type { DockerTransport } from '../execution/DockerTransport';
import { createPreparedRuntimeResolver, type PreparedRuntimeResolver, type PreparedCacheLease } from '../runtime-coordinator/PreparedRuntimeResolver';
import { PreparedLanguageImageVerifier, type VerifiedLanguageImage } from './PreparedLanguageImage';
import { ProductionLanguageRegistryFactory, type ProductionLanguageAuthority, type ProductionLanguageBinding, type ProductionLanguageRegistryFactoryOptions } from './ProductionLanguageRegistryFactory';
import type { LanguageProjectScope } from './ports';
import type { RegistrySnapshot } from './LanguageFeatureRegistry';
import { LanguageShadowStore, type LanguageSourceCapture, type TrustedLanguageSnapshot } from './LanguageShadowStore';
import * as codec from '../../language/uriCodec';

/** Backend-only actual current source/control/settings/preparation lease. Never deserialize this from
 * a client, manufacture an always-current callback or release serialization before ShadowStore copy.
 * assertCurrent MUST check root identity, complete source/ALL overlays, control/scope/settings and
 * preparation revocation. Source is CURRENT, never selected.preparationProjectRoot.
 */
export interface SelectedLanguageLease extends PreparedCacheLease {
  /** SAME captured vector/revocation checks after FIFO release; must NOT require gate still held. */
  assertRetainedCurrent(): void;
  readonly installationId: string;
  readonly runtime: ResolvedRuntime;
  readonly run: RunProfileV2;
  readonly source: Omit<TrustedLanguageSnapshot, 'identity' | 'dependencies'>;
}
const copy = <T>(v: T): T => { const cloned = structuredClone(v); const freeze = (x: unknown): void => {
  if (x && typeof x === 'object') { Object.values(x).forEach(freeze); Object.freeze(x); }
}; freeze(cloned); return cloned; };
const assertLease = (lease: PreparedCacheLease): void => { if (lease.assertCurrent() !== undefined) throw new Error('Synchronous current lease required'); };
const assertRetained = (lease: SelectedLanguageLease): void => { if (lease.assertRetainedCurrent() !== undefined) throw new Error('Synchronous retained current lease required'); };
const requireThat: (value: unknown) => asserts value = value => { if (!value) throw new Error('No current selected language lease'); };
type Selection = { scope: Readonly<LanguageProjectScope>; snapshot: RegistrySnapshot; binding: ProductionLanguageBinding;
  lease: SelectedLanguageLease; inputs: { installationId: string; runtime: ResolvedRuntime; run: RunProfileV2; source: SelectedLanguageLease['source'] }; image: VerifiedLanguageImage; disk: LanguageSourceCapture };
/** Async preparation is invoked under the SAME real backend authority by each registry capture
 * callback (or explicit manually-held factory caller). Sync copy operations recheck that lease;
 * no cached READY, empty dependency fallback, copied producer hash policy or swallowed cache errors.
 */
export class SelectedCacheLanguageAuthority implements ProductionLanguageAuthority {
  private selection: Selection | null = null;
  private request = 0;
  constructor(private readonly resolver: Pick<PreparedRuntimeResolver, 'resolveCache'>,
    private readonly images: Pick<PreparedLanguageImageVerifier, 'verify'>,
    private readonly sources: Pick<LanguageShadowStore, 'captureSource'>) {}
  invalidate(): void { this.request++; this.selection = null; }
  private inputs(lease: SelectedLanguageLease): Selection['inputs'] {
    return { installationId: lease.installationId, runtime: lease.runtime, run: lease.run, source: lease.source };
  }
  async prepare(scopeInput: Readonly<LanguageProjectScope>, snapshotInput: RegistrySnapshot, lease: SelectedLanguageLease): Promise<void> {
    // Preserve an independently retained current selection while a same-vector sibling prepares.
    // Its OWN full-vector/source/image guards still apply; only successful fresh preparation replaces
    // it. New/changed sources revoke the old lease independently, never through a readiness gap.
    const request = ++this.request;
    assertLease(lease); const scope = copy(scopeInput), snapshot = copy(snapshotInput), inputs = copy(this.inputs(lease));
    requireThat(inputs.installationId && inputs.source.leaseId === snapshot.revision && inputs.runtime.workspaceRoot === inputs.source.projectRoot &&
      inputs.runtime.configurationGeneration === scope.configurationGeneration && same(inputs.runtime.profile, scope.profile) &&
      same(inputs.source.overlays, snapshot.documents.map(d => ({ stamp: d.stamp, content: d.content }))));
    const disk = this.sources.captureSource(inputs.source.projectRoot);
    requireThat(same(disk.files, inputs.source.files));
    const assertCurrent = () => { assertLease(lease); disk.assertCurrent(); requireThat(request === this.request && same(inputs, this.inputs(lease)) && same(scopeInput, scope) && same(snapshotInput, snapshot)); };
    // Pass the actual SAME lease object to the actual selected consumer. Every async result is fenced
    // again by immutable captured inputs; no lease clone/replacement can upgrade that authority.
    const selected = await this.resolver.resolveCache(inputs.runtime, inputs.run.kind, inputs.run, lease); assertCurrent();
    requireThat(selected.family === 'java-maven' || selected.family === 'python');
    const image = await this.images.verify(inputs.runtime, selected.engineId, { assertCurrent: () => assertRetained(lease) }); assertCurrent(); image.assertCurrent();
    requireThat(image.engineId === selected.engineId && image.imageId === inputs.runtime.languageImage?.imageId);
    const binding: ProductionLanguageBinding = copy({ installationId: inputs.installationId, engineId: selected.engineId, imageId: image.imageId,
      source: { ...inputs.source, dependencies: { root: selected.cacheRoot, files: selected.files } },
      prepared: { family: selected.family, workingDirectory: selected.workingDirectory, dependencySha256: selected.dependencySha256,
        toolchainSha256: selected.toolchainSha256, files: selected.files } });
    assertCurrent(); this.selection = { scope, snapshot, binding, lease, inputs, image, disk };
  }
  capture(scope: Readonly<LanguageProjectScope>, snapshot: RegistrySnapshot): ProductionLanguageBinding {
    const s = this.selection; requireThat(s); this.assertCopyLease(scope, snapshot, s.binding); return s.binding;
  }
  assertCopyLease(scope: Readonly<LanguageProjectScope>, snapshot: RegistrySnapshot, binding: ProductionLanguageBinding): void {
    const s = this.selection; requireThat(s && this.isCurrent(scope, snapshot, binding)); assertLease(s.lease);
    s.disk.assertCurrent(); assertLease(s.lease);
  }
  isCurrent(scope: Readonly<LanguageProjectScope>, snapshot: RegistrySnapshot, binding: ProductionLanguageBinding): boolean {
    const s = this.selection;
    try {
      if (!s || !same(scope, s.scope) || !same(snapshot, s.snapshot) || !same(binding, s.binding)) return false;
      assertRetained(s.lease); s.disk.assertCurrent(); s.image.assertCurrent();
      requireThat(s === this.selection && same(s.inputs, this.inputs(s.lease)));
      assertRetained(s.lease); return true;
    } catch { return false; }
  }
}
export interface SelectedCacheLanguageFactoryOptions extends Omit<ProductionLanguageRegistryFactoryOptions, 'authority' | 'withCaptureLease'> {
  /** Actual backend-owned FIFO lease acquisition. Required when used by the asynchronous registry.
   * Omission supports direct manually-held factory use only; registry capture refuses, never bypasses.
   */
  withSourceLease?(scope: Readonly<LanguageProjectScope>, snapshot: RegistrySnapshot,
    action: (lease: SelectedLanguageLease) => Promise<void>): Promise<void>;
  preparedOutputRoots: readonly string[];
  /** Explicit actual language tool-probe receipt, NOT a Run image receipt or client upload. */
  languageReceiptPath?: string;
  transport: Pick<DockerTransport, 'run'>;
}
/** Concrete selected-consumer/OCI-reader -> production shadow/boot/process/session join. Registry
 * delayed capture and refresh acquire the actual backend callback, prepare and transfer synchronously.
 * Coordinator HTTP/Runner/wire ownership is deliberately not duplicated in this module.
 */
export function createSelectedCacheLanguageFactory(options: SelectedCacheLanguageFactoryOptions): {
  authority: SelectedCacheLanguageAuthority; factory: ProductionLanguageRegistryFactory;
  captureSource(projectRoot: string): LanguageSourceCapture;
} {
  const sources = new LanguageShadowStore(options.ownedRoot, codec);
  // Snapshot trusted selection once. Nonremote registry startup never verifies an image. Missing
  // selection is a hard refusal AT the real remote verification boundary, never a default path.
  const receiptPath=options.languageReceiptPath,transport=options.transport;
  let images:PreparedLanguageImageVerifier|undefined;
  const selectedImages:Pick<PreparedLanguageImageVerifier,'verify'>={async verify(runtime,engine,lease){
    if(receiptPath===undefined)throw new Error('Explicit trusted language receipt is required');
    images ??= new PreparedLanguageImageVerifier(receiptPath,transport);
    return images.verify(runtime,engine,lease);
  }};
  const authority = new SelectedCacheLanguageAuthority(createPreparedRuntimeResolver({ outputRoots: options.preparedOutputRoots }, options.transport),
    selectedImages, sources);
  const factory = new ProductionLanguageRegistryFactory({ ownedRoot: options.ownedRoot, driver: options.driver, journal: options.journal,
    admission: options.admission, authority, withCaptureLease: async (scope, snapshot, action) => {
      if (!options.withSourceLease) throw new Error('Actual backend language source FIFO acquisition required');
      await options.withSourceLease(scope, snapshot, async lease => {
        assertLease(lease);
        await authority.prepare(scope, snapshot, lease);
        assertLease(lease);
        action(); // Copy/refresh AND registry owner transfer occur before releasing this SAME lease.
        assertLease(lease);
      });
    } });
  return { authority, factory, captureSource: projectRoot => sources.captureSource(projectRoot) };
}
