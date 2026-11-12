/** Durable original public RUN acceptance. This does not claim process start or terminal success.
 * No effect replay, no later Runner/current Project inference, no wire callbacks. */
import type { RunRequestV2, RunV2 } from '../../shared/runtime-v2';
import { validateV2Request, validateRunV2 } from '../../shared/validation-v2';
import { AppError } from '../errors';
import type { RuntimeWorkspace } from './RuntimeWorkspace';
import type { OriginalRunAdmission } from './RuntimeExecution';
import { DurableMutationJournal, type MutationIdentity, type MutationOutcome, type RunAdmissionStage } from './MutationJournal';

export interface OriginalRunExecution {
  /** Actual neutral coordinator must call admit synchronously AFTER final plan validation,
   * before its first ExecutionPort.start. If admit throws it MUST NOT invoke that port. */
  start(request: RunRequestV2, admit: OriginalRunAdmission): Promise<RunV2>;
}
export class RuntimeRunMutation {
  constructor(private readonly core: RuntimeWorkspace, private readonly journal: DurableMutationJournal,
    private readonly execution: OriginalRunExecution) {}
  private identity(request: RunRequestV2): MutationIdentity {
    if (!validateV2Request('RunRequest', request)) throw Error('Invalid original RUN request');
    return { projectId: this.core.workspace.projectId, sessionId: request.sessionId, clientId: request.clientId,
      requestId: request.requestId, kind: 'RUN', payload: structuredClone(request) };
  }
  validate(request: RunRequestV2, stage: RunAdmissionStage): void {
    const { result: run, plan } = stage;
    if (!validateV2Request('RunRequest',request) || !validateRunV2(run) || run.status !== 'QUEUED' || run.mode !== request.mode ||
        run.configurationGeneration !== request.configurationGeneration || run.workspaceVersionAtStart !== request.expectedWorkspaceVersion ||
        run.startedAt !== null || run.finishedAt !== null || run.exitCode !== null || run.outputTail !== '' || run.outputTruncated ||
        run.workspaceChangedDuringRun || run.processProblem !== null || run.serviceReadiness !== null ||
        run.testOutcome !== (request.mode === 'RUN_TESTS' ? 'UNKNOWN' : 'NOT_APPLICABLE') || run.testCount !== null ||
        plan.ownership.runId !== run.runId || plan.profile.id !== run.profileId || plan.mode !== request.mode ||
        plan.input.projectId !== this.core.workspace.projectId || plan.input.sessionId !== request.sessionId ||
        plan.input.identity.runId !== run.runId || plan.input.identity.profileId !== run.profileId ||
        plan.input.identity.configurationGeneration !== request.configurationGeneration ||
        plan.input.identity.workspaceVersion !== request.expectedWorkspaceVersion)
      throw Error('Original RUN admission does not match the retained immutable request/plan');
  }
  async execute(original: RunRequestV2): Promise<MutationOutcome<RunV2>> {
    const request = structuredClone(original), identity = this.identity(request);
    // Capture BEFORE journal admission yields. A Veto/settings change while queued must
    // not become the original operation's new authority, even if coordinator.start runs later.
    const epoch = this.core.session.state.controlEpoch, source = this.core.readSettings().sourceSha256;
    const assertAdmission = () => {
      this.core.session.assertClient(request.clientId, request.sessionId);
      if (this.core.session.state.controlEpoch !== epoch || this.core.session.state.writeOwner !== 'STUDENT' ||
          this.core.workspace.workspaceVersion !== request.expectedWorkspaceVersion || this.core.readSettings().sourceSha256 !== source)
        throw new AppError(409, 'RUN_INPUT_CHANGED', 'Original RUN authority changed during durable admission.');
    };
    return this.journal.executeRun(identity, async () => {
      assertAdmission();
      await this.execution.start(request, (run, plan, policy) => {
        assertAdmission();
        const stage = structuredClone({ result: run, plan, policy });
        this.validate(request, stage);
        this.journal.stageRun(identity, stage);
        return () => this.journal.claimRunDispatch(identity, stage);
      });
      const stage = this.journal.readRunReservation(identity).stage;
      if (!stage) throw Error('RUN returned without durable original admission');
      this.validate(request, stage);
      // The public original result is QUEUED acceptance, never the later returned current Run.
      return { state: 'COMMITTED', result: stage.result };
    });
  }
  recover(original: RunRequestV2): Promise<MutationOutcome<RunV2>> {
    const request = structuredClone(original), identity = this.identity(request);
    return this.journal.recover(identity, async () => {
      const reservation = this.journal.readRunReservation(identity);
      // An unrelated generic RUN effect cannot be classified from missing stage/empty RAM.
      if (!reservation.protocol) return { state: 'UNKNOWN', result: null };
      if (!reservation.stage) return { state: 'DEFINITIVELY_ABORTED', result: null };
      this.validate(request, reservation.stage);
      return { state: 'COMMITTED', result: reservation.stage.result };
    });
  }
}
