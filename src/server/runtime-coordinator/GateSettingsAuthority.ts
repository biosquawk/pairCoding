/** Actual SettingsV2Store authority. No callback-injected permissive version/idempotency stub. */
import type { SettingsTransactionAuthority, SettingsTransactionIdentity, SettingsWriteLease, SettingsMutation, SettingsSaveReceipt, SettingsTransactionOutcome, SaveSettingsInput } from '../settings-v2';
import { SettingsV2Store } from '../settings-v2';
import { WorkspaceService } from '../WorkspaceService';
import { WriteGate } from '../WriteGate';
import { canonical, sha256 } from './storage';
import { AppError } from '../errors';
export class GateSettingsAuthority implements SettingsTransactionAuthority {
  private readonly stages = new Map<string, { expected: SettingsTransactionIdentity;
    beforeBegin: (identity: Readonly<SettingsTransactionIdentity>, lease: SettingsWriteLease) => void;
    committed?: () => void }>();
  /** INTERNAL Store-owned identity reaches the projection only under the SAME real write lease.
   * Staging must be synchronous/durable and precede beginSettings and every Store side effect.
   * Never invoke a second lease or await a projection while holding this synchronous authority.
   */
  async saveStaged(store: SettingsV2Store, original: SaveSettingsInput,
      beforeBegin: (identity: Readonly<SettingsTransactionIdentity>, lease: SettingsWriteLease) => void,
      committed?: () => void): Promise<SettingsSaveReceipt> {
    const input = structuredClone(original), r = input.request;
    const identity: SettingsTransactionIdentity = { requestId: r.requestId, clientId: r.clientId, sessionId: r.sessionId,
      expectedWorkspaceVersion: r.expectedWorkspaceVersion,
      payloadSha256: sha256(JSON.stringify({ settings: r.settings, source: input.expectedSourceSha256 })) };
    const key = canonical([r.sessionId, r.clientId, r.requestId]);
    if (this.stages.has(key)) throw new AppError(409, 'SETTINGS_BUSY', 'Original SAVE staging is already in progress.');
    this.stages.set(key, { expected: identity, beforeBegin, committed });
    try { return await store.save(input); }
    finally { this.stages.delete(key); }
  }
  constructor(private readonly workspace: WorkspaceService, private readonly gate: WriteGate) {
    gate._assertSettingsWorkspace(workspace);
    workspace._settingsVersionStore(); // Never silently accept an ephemeral legacy workspace.
  }
  transact(identity: Readonly<SettingsTransactionIdentity>, effect: (lease: SettingsWriteLease) => SettingsMutation): Promise<SettingsSaveReceipt> {
    const original = structuredClone(identity);
    return this.gate._withSettingsLease(original, false, authLease => {
      const ledger = this.workspace._settingsVersionStore(), prior = ledger.outcome(original);
      if (prior?.state === 'COMMITTED') return { ...prior.receipt, status: 'DUPLICATE' as const };
      if (prior) throw new AppError(409, 'SETTINGS_RECOVERY_REQUIRED', 'Original settings intent must be reconciled, never replayed.');
      ledger.assertWritable();
      // No guessed version from a client snapshot; actual fresh disk may revoke admission.
      this.workspace._scanSettingsVersion();
      const lease: SettingsWriteLease = { assertCurrent: () => {
        authLease.assertCurrent();
        if (this.workspace.workspaceVersion !== original.expectedWorkspaceVersion)
          throw new AppError(409, 'WORKSPACE_VERSION_CONFLICT', 'Settings require the current workspace version.');
      } };
      lease.assertCurrent();
      const stage = this.stages.get(canonical([original.sessionId, original.clientId, original.requestId]));
      if (stage) {
        if (canonical(stage.expected) !== canonical(original)) throw Error('Settings staging identity mismatch');
        stage.beforeBegin(Object.freeze(structuredClone(original)), lease);
        lease.assertCurrent();
      }
      ledger.beginSettings(original);
      let mutation: SettingsMutation;
      try { mutation = effect(lease); }
      catch (e) {
        // Callback is synchronous and cannot resume after this boundary. Store recovery, under
        // the same exclusion, will restore its durable original bytes if needed. No version bump.
        ledger.finishSettings(original, null); throw e;
      }
      // A failed outcome publication is UNKNOWN, never guessed ABORTED or retried.
      const outcome = ledger.finishSettings(original, mutation);
      if (outcome.state !== 'COMMITTED') throw Error('Settings commit has no durable receipt');
      // The actual durable effect is authoritative now; update neutral policy BEFORE state publication.
      authLease.assertCurrent(); stage?.committed?.();
      try { this.workspace._publishSettingsReceipt(outcome.receipt); }
      catch { /* Durable outcome is already definitive. Listener failure cannot abort/replay it. */ }
      return outcome.receipt;
    });
  }
  /** INTERNAL no-stage proof only after journal excludes live effects. Do not confuse an
   * existing direct Store receipt with an original public Project which was never staged.
   */
  proveUnstaged(store: SettingsV2Store, request: Pick<SettingsTransactionIdentity, 'sessionId' | 'clientId' | 'requestId' | 'expectedWorkspaceVersion'>): Promise<boolean> {
    return this.gate._withSettingsLease(request, true, lease => {
      store.read(); lease.assertCurrent();
      return !this.workspace._settingsVersionStore().hasSettingsRequest(request);
    });
  }
  /** Trusted startup composition, BEFORE exposing V2 mutation routes. Handles death after the
   * durable authority reservation but BEFORE SettingsV2Store could publish its intent. */
  async recoverStore(store: SettingsV2Store): Promise<'NONE' | 'COMMITTED' | 'ABORTED'> {
    const recovered = await store.recover();
    const pending = this.workspace._settingsVersionStore().pendingSettings();
    if (!pending) return recovered;
    return this.gate._withSettingsLease(pending, true, lease => {
      const ledger = this.workspace._settingsVersionStore(), outcome = ledger.outcome(pending);
      if (outcome && outcome.state !== 'UNKNOWN') return outcome.state;
      // Actual store refuses read if ANY durable intent still exists. Absence here, under
      // exclusion, proves this Store never reached its intent-before-replace boundary.
      // This is not a RAM/settings-snapshot inference and never constructs a committed receipt.
      store.read(); lease.assertCurrent(); ledger.finishSettings(pending, null);
      return 'ABORTED';
    });
  }
  reconcile<T>(identity: Readonly<SettingsTransactionIdentity>, effect: (outcome: SettingsTransactionOutcome, lease: SettingsWriteLease) => T): Promise<T> {
    const original = structuredClone(identity);
    return this.gate._withSettingsLease(original, true, lease => {
      const ledger = this.workspace._settingsVersionStore();
      let outcome = ledger.outcome(original);
      // FIFO exclusion proves the original synchronous effect is no longer live. For an absent
      // or crashed pending intent, persist abort BEFORE restoring bytes/responding. Never call
      // transact again and never infer COMMITTED from current settings bytes/UI state.
      if (!outcome || outcome.state === 'UNKNOWN') outcome = ledger.finishSettings(original, null);
      lease.assertCurrent(); return effect(outcome, lease);
    });
  }
}
