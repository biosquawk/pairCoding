import type {Run} from '../../shared/protocol';

/** Explicit outbound allowlist shared by Coach and report AI. Local Run stays lossless. */
export type RunFacts = Pick<Run, 'runId'|'mode'|'status'|'exitCode'|'workspaceVersionAtStart'|
  'workspaceChangedDuringRun'|'testOutcome'|'testCount'|'startedAt'|'finishedAt'>;
export function projectRunFacts(run:RunFacts):RunFacts {
  return {runId:run.runId,mode:run.mode,status:run.status,exitCode:run.exitCode,
    workspaceVersionAtStart:run.workspaceVersionAtStart,workspaceChangedDuringRun:run.workspaceChangedDuringRun,
    testOutcome:run.testOutcome,testCount:run.testCount,startedAt:run.startedAt,finishedAt:run.finishedAt};
}
