import { isDeepStrictEqual as same } from 'node:util';
import { LANGUAGE_LIMITS } from '../../shared/language-v2';
import * as codec from '../../language/uriCodec';
import { DockerLanguageProcess, type DockerLanguageProcessOptions } from './DockerLanguageProcess';
import { LanguageServerSession } from './LanguageServerSession';
import { LanguageShadowStore, type LanguageShadow, type LanguageSnapshotAuthority, type TrustedLanguageSnapshot } from './LanguageShadowStore';
import { LanguageBootPublisher, type LanguageBootPublication } from './LanguageBootPublisher';
import { buildLanguageProviderConfiguration, readLanguageProviderConfiguration, type LanguageProviderConfiguration, type TrustedPreparedLanguageDependencies } from './LanguageProviderConfiguration';
import type { RegistryCallbacks, RegistryFactory, RegistryLaunch, RegistrySession, RegistrySnapshot } from './LanguageFeatureRegistry';
import type { ImmutableDiagnosticGeneration, LanguageProjectScope } from './ports';

/** Required trusted backend dependency, NOT a wire shape, prepare receipt parser or readiness flag.
 * The coordinator's selected prepared consumer must prove actual cache/tools/manifest/image/engine
 * admission and retain it under the SAME complete source/overlay/dependency authority. No default.
 */
export interface ProductionLanguageBinding {
  installationId: string; engineId: string; imageId: string;
  source: Omit<TrustedLanguageSnapshot, 'identity'>;
  prepared: TrustedPreparedLanguageDependencies;
}
export interface ProductionLanguageAuthority {
  capture(scope: Readonly<LanguageProjectScope>, snapshot: RegistrySnapshot): ProductionLanguageBinding;
  /** Complete currentness, including external sources, inactive overlays, dependency and preparation
   * revocation. Must support immutable copies; never identity-of-object or equal-byte-only authority.
   */
  isCurrent(scope: Readonly<LanguageProjectScope>, snapshot: RegistrySnapshot, binding: ProductionLanguageBinding): boolean;
}
export interface ProductionLanguageRegistryFactoryOptions extends Omit<DockerLanguageProcessOptions, 'rpc' | 'onTransportClosed'> {
  authority: ProductionLanguageAuthority;
}
const copy = <T>(v: T): T => { const cloned = structuredClone(v); const freeze = (x: unknown): void => {
  if (x && typeof x === 'object') { Object.values(x).forEach(freeze); Object.freeze(x); }
}; freeze(cloned); return cloned; };
const sorted = <T extends { path: string }>(v: readonly T[]): T[] => [...v].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
interface LaunchState {
  scope: Readonly<LanguageProjectScope>; snapshot: RegistrySnapshot; binding: ProductionLanguageBinding;
  config: Readonly<LanguageProviderConfiguration>; shadow: LanguageShadow; boot: LanguageBootPublication;
  session: LanguageServerSession;
}
/** Actual private filesystem -> pinned configuration -> durable boot -> Docker process -> framed
 * session composition. create is synchronous and transfers the session owner BEFORE start/await.
 * No host fallback, original source/cache mount, duplicated codec or implicit prepare execution.
 */
export class ProductionLanguageRegistryFactory implements RegistryFactory {
  private readonly store: LanguageShadowStore;
  private readonly boot: LanguageBootPublisher;
  private readonly states = new WeakMap<RegistrySession, LaunchState>();
  constructor(private readonly options: ProductionLanguageRegistryFactoryOptions) {
    this.store = new LanguageShadowStore(options.ownedRoot, codec);
    this.boot = new LanguageBootPublisher(shadow => this.store.assertIntegrity(shadow));
  }
  private current(scope: Readonly<LanguageProjectScope>, snapshot: RegistrySnapshot, binding: ProductionLanguageBinding): void {
    if (this.options.authority.isCurrent(scope, snapshot, binding) !== true) throw new Error('Stale production language binding');
  }
  private capture(scope: Readonly<LanguageProjectScope>, snapshot: RegistrySnapshot): {
    binding: ProductionLanguageBinding; config: Readonly<LanguageProviderConfiguration>; source: TrustedLanguageSnapshot;
  } {
    if (scope.shadowDirectory !== this.options.ownedRoot) throw new Error('Language scope outside controlled factory root');
    const original = this.options.authority.capture(scope, snapshot), binding = copy(original);
    this.current(scope, snapshot, original); this.current(scope, snapshot, binding);
    if (!binding.source || binding.source.leaseId !== snapshot.revision || !binding.source.dependencies ||
      !/^sha256:[a-f0-9]{64}$/.test(binding.imageId) || !Array.isArray(binding.prepared?.files) ||
      !same(sorted(binding.source.dependencies.files), sorted(binding.prepared.files)) ||
      !same(sorted(binding.source.overlays.map(d => ({ path: d.stamp.path, stamp: d.stamp, content: d.content }))),
        sorted(snapshot.documents.map(d => ({ path: d.stamp.path, stamp: d.stamp, content: d.content })))))
      throw new Error('Unbound complete source/selected preparation');
    const config = buildLanguageProviderConfiguration(scope.profile, binding.prepared);
    const source: TrustedLanguageSnapshot = copy({ ...binding.source, identity: {
      projectId: scope.projectId, sessionId: scope.sessionId, profileId: scope.profile.id,
      configurationGeneration: scope.configurationGeneration, providerGeneration: scope.providerGeneration,
      shadowGeneration: scope.shadowGeneration, connectionGeneration: scope.connectionGeneration,
      provider: config.provider, imageId: binding.imageId, toolchainSha256: binding.prepared.toolchainSha256,
      dependencyManifestSha256: binding.prepared.dependencySha256, analysisSettingsSha256: config.analysisSettingsSha256,
    } });
    this.current(scope, snapshot, binding); return { binding, config, source };
  }
  private authority(scope: Readonly<LanguageProjectScope>, snapshot: RegistrySnapshot, binding: ProductionLanguageBinding,
    source: TrustedLanguageSnapshot): LanguageSnapshotAuthority {
    return { capture: () => source, isCurrent: candidate => {
      if (!same(candidate, source)) return false;
      this.current(scope, snapshot, binding); return true;
    } };
  }
  private assertCurrent(state: LaunchState, shadow: LanguageShadow): void {
    if (state.shadow !== shadow) throw new Error('Stale production shadow handle');
    this.current(state.scope, state.snapshot, state.binding);
    this.store.assertIntegrity(shadow); this.boot.assertLaunchFiles(state.config, state.boot);
    this.current(state.scope, state.snapshot, state.binding);
  }
  create(scope: Readonly<LanguageProjectScope>, phase: 'completion' | 'diagnostics', snapshot: RegistrySnapshot,
    callbacks: RegistryCallbacks, requested?: Readonly<ImmutableDiagnosticGeneration>): RegistryLaunch {
    const capturedScope = copy(scope), capturedSnapshot = copy(snapshot), { binding, config, source } = this.capture(capturedScope, capturedSnapshot);
    const shadow = this.store.materialize(phase, this.authority(capturedScope, capturedSnapshot, binding, source));
    const generation: ImmutableDiagnosticGeneration | null = phase === 'diagnostics' ? copy({ launchId: shadow.launchId,
      inputManifestSha256: shadow.inputManifestSha256, wholeProjectManifestPath: shadow.wholeProjectManifestPath,
      immutableShadowDirectory: shadow.workspaceDirectory, policy: 'IMMUTABLE_WHOLE_PROJECT',
      maxAnalysisMs: LANGUAGE_LIMITS.diagnosticAnalysisMs, retirementDeadlineMs: LANGUAGE_LIMITS.diagnosticRetirementMs,
      sources: capturedSnapshot.documents.map(d => ({ sourceStamp: d.stamp, provenance: { kind: 'IMMUTABLE_GENERATION',
        launchId: shadow.launchId, lspVersion: 1, inputManifestSha256: shadow.inputManifestSha256 } })),
    }) : null;
    if (requested && !same(requested, generation)) throw new Error('Requested generation is not the actual fresh private shadow');
    const boot = this.boot.publish(shadow, config); this.current(capturedScope, capturedSnapshot, binding);
    const process = DockerLanguageProcess.prepare({ ...source.identity, launchId: shadow.launchId, phase,
      installationId: binding.installationId, engineId: binding.engineId, argv: config.argv }, { ...this.options,
      rpc: { configuration: (method, params) => readLanguageProviderConfiguration(config, method, params) } });
    let state!: LaunchState;
    const session = new LanguageServerSession({ process, shadow, codec, settings: config.settings,
      expectedProjectUri: config.expectedProjectUri, assertCurrent: current => this.assertCurrent(state, current), ...callbacks });
    state = { scope: capturedScope, snapshot: capturedSnapshot, binding, config, shadow, boot, session };
    this.states.set(session, state); this.assertCurrent(state, shadow);
    return { session, generation }; // No process admission/command/await has occurred before this transfer.
  }
  refreshCompletion(scope: Readonly<LanguageProjectScope>, snapshot: RegistrySnapshot, launch: RegistryLaunch): boolean {
    const state = this.states.get(launch.session);
    if (!state || launch.generation !== null || state.shadow.phase !== 'completion' || !same(scope, state.scope)) throw new Error('Foreign/immutable production launch');
    const capturedSnapshot = copy(snapshot), { binding, config, source } = this.capture(state.scope, capturedSnapshot);
    const before = state.binding;
    // Incompatible preparation/configuration returns BEFORE any mutable shadow or process operation.
    if (binding.installationId !== before.installationId || binding.engineId !== before.engineId || binding.imageId !== before.imageId ||
      binding.source.projectRoot !== before.source.projectRoot || binding.source.dependencies!.root !== before.source.dependencies!.root ||
      !same(binding.prepared, before.prepared) || !same(config, state.config)) return false;
    try {
      const next = this.store.refreshCompletion(state.shadow, this.authority(state.scope, capturedSnapshot, binding, source));
      state.binding = binding; state.snapshot = capturedSnapshot; state.shadow = next;
      state.session.replaceCompletionShadow(next); this.assertCurrent(state, next); return true;
    } catch (error) { state.session.invalidate(String(error)); throw error; }
  }
}
