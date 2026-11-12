import type {RunV2} from '../../shared/runtime-v2';

/** Explicit outbound allowlist shared by Coach and report AI. Local Run stays lossless. */
export type RunFacts = Pick<RunV2, 'runId'|'mode'|'status'|'exitCode'|'workspaceVersionAtStart'|
  'workspaceChangedDuringRun'|'testOutcome'|'testCount'|'startedAt'|'finishedAt'> & Partial<Pick<RunV2,'profileId'|'configurationGeneration'>>;
export function projectRunFacts(run:RunFacts):RunFacts {
  return {...(typeof run.profileId==='string'?{profileId:run.profileId}:{}),
    ...(typeof run.configurationGeneration==='string'?{configurationGeneration:run.configurationGeneration}:{}),runId:run.runId,mode:run.mode,status:run.status,exitCode:run.exitCode,
    workspaceVersionAtStart:run.workspaceVersionAtStart,workspaceChangedDuringRun:run.workspaceChangedDuringRun,
    testOutcome:run.testOutcome,testCount:run.testCount,startedAt:run.startedAt,finishedAt:run.finishedAt};
}
