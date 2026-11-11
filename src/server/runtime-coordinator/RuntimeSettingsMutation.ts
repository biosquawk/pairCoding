/** Original SAVE response lifecycle. NOT a current-state projection or HTTP authorization port.
 * Caller first validates/authenticates the public request and binds current config/scope. The
 * synchronous builder must produce the exact intended postcommit Project under the actual lease.
 */
import type { FileEntry } from '../../shared/protocol';
import type { ProjectV2, UpdateSettingsRequestV2 } from '../../shared/runtime-v2';
import { validateUpdateSettingsRequestV2, validateV2WireShape } from '../../shared/validation-v2';
import type { SaveSettingsInput, SettingsSaveReceipt, SettingsWriteLease } from '../settings-v2';
import type { RuntimeWorkspace } from './RuntimeWorkspace';
import { DurableMutationJournal, type MutationIdentity, type MutationOutcome, type SettingsResultStage } from './MutationJournal';
import { canonical } from './storage';

export class RuntimeSettingsMutation {
  constructor(private readonly core: RuntimeWorkspace, private readonly journal: DurableMutationJournal) {}
  private identity(original: UpdateSettingsRequestV2): MutationIdentity {
    if (!validateUpdateSettingsRequestV2(original)) throw Error('Invalid original SAVE request');
    return { projectId: this.core.workspace.projectId, sessionId: original.sessionId, clientId: original.clientId,
      requestId: original.requestId, kind: 'SAVE', payload: structuredClone(original) };
  }
  private validateProject(request: UpdateSettingsRequestV2, project: ProjectV2): void {
    if (!validateV2WireShape('Project', project) || project.projectId !== this.core.workspace.projectId ||
        project.rootPath !== this.core.workspace.rootPath || project.sessionId !== request.sessionId ||
        project.workspaceVersion !== request.expectedWorkspaceVersion + 1 || canonical(project.settings) !== canonical(request.settings))
      throw Error('Original staged SAVE Project does not match the exact operation');
  }
  private validateStage(request: UpdateSettingsRequestV2, stage: SettingsResultStage<ProjectV2>): void {
    this.validateProject(request, stage.result);
    const i = stage.identity;
    if (i.requestId !== request.requestId || i.clientId !== request.clientId || i.sessionId !== request.sessionId ||
        i.expectedWorkspaceVersion !== request.expectedWorkspaceVersion) throw Error('Original staged SAVE identity mismatch');
  }
  private validateReceipt(stage: SettingsResultStage<ProjectV2>, receipt: SettingsSaveReceipt): void {
    if (Object.entries(stage.identity).some(([k,v]) => receipt[k as keyof SettingsSaveReceipt] !== v) ||
        receipt.workspaceVersion !== stage.result.workspaceVersion || !['OK','DUPLICATE'].includes(receipt.status))
      throw Error('Actual SAVE receipt does not prove the original staged response');
  }
  async execute(original: SaveSettingsInput, buildOriginal: (lease: SettingsWriteLease, files: FileEntry[]) => ProjectV2): Promise<MutationOutcome<ProjectV2>> {
    const input = structuredClone(original), identity = this.identity(input.request);
    // Capture BEFORE durable admission yields; Store request has no epoch field. A Veto
    // between journal reservation and authority FIFO admission must not adopt the new epoch.
    const epoch = this.core.session.state.controlEpoch;
    return this.journal.execute(identity, async () => {
      const receipt = await this.core.settingsAuthority.saveStaged(this.core.settingsStore, input, (actualIdentity, lease) => {
        lease.assertCurrent();
        if (this.core.session.state.controlEpoch !== epoch) throw Error('Original SAVE control epoch was revoked');
        const files = this.core.workspace._settingsFileProjection(lease);
        const project = structuredClone(buildOriginal(lease, structuredClone(files)));
        this.validateProject(input.request, project);
        // Verify actual files NOW, not a stale precomputed list. Version/settings/source and
        // live student/epoch/session checks are held by the Store's real authority/lease.
        if (canonical(project.files) !== canonical(files)) throw Error('Original SAVE file projection changed');
        lease.assertCurrent();
        this.journal.stageSettings(identity, { identity: structuredClone(actualIdentity), result: project });
      });
      const stage = this.journal.readSettingsStage<ProjectV2>(identity);
      if (!stage) throw Error('Store committed without original SAVE result stage');
      this.validateStage(input.request, stage); this.validateReceipt(stage, receipt);
      return { state: 'COMMITTED', result: stage.result };
    });
  }
  /** After actual Store startup recovery, or a completed failed execute. Journal excludes every
   * live admitted effect. A missing stage proves this helper never entered beginSettings/Store
   * effect, not absence-in-RAM/current-bytes proof. No stage/result recreation or effect replay.
   */
  recover(original: UpdateSettingsRequestV2): Promise<MutationOutcome<ProjectV2>> {
    const request = structuredClone(original), identity = this.identity(request);
    return this.journal.recover(identity, async () => {
      const stage = this.journal.readSettingsStage<ProjectV2>(identity);
      if (!stage) return await this.core.settingsAuthority.proveUnstaged(this.core.settingsStore, request)
        ? { state: 'DEFINITIVELY_ABORTED', result: null } : { state: 'UNKNOWN', result: null };
      this.validateStage(request, stage);
      return this.core.settingsAuthority.reconcile(stage.identity, (outcome, lease) => {
        lease.assertCurrent();
        if (outcome.state === 'UNKNOWN') return { state: 'UNKNOWN', result: null };
        if (outcome.state === 'ABORTED') return { state: 'DEFINITIVELY_ABORTED', result: null };
        this.validateReceipt(stage, outcome.receipt);
        return { state: 'COMMITTED', result: structuredClone(stage.result) };
      });
    });
  }
}
