import type { SettingsV2, RunV2 } from '../shared/runtime-v2';
import { validateSettingsV2 } from '../shared/validation-v2';
import type * as Wire from '../shared/protocol';
import type { ActionProposal, ExecutionRun, ProjectFile, ProjectSettings, SessionReport } from '../types/paircoach';
import type { ClientState } from './liveTypes';

export function mapSettings(settings: unknown): ProjectSettings {
  const raw = settings && typeof settings === 'object' ? settings as Record<string,unknown> : {};
  const common: Omit<ProjectSettings,'runProfiles'> = { rawSettings: structuredClone(settings),
    contextPatterns: Array.isArray(raw.contextPatterns) && raw.contextPatterns.every(v=>typeof v==='string') ? raw.contextPatterns as string[] : [],
    aiConsent: raw.aiConsent === true, taskMode: raw.taskMode === 'CODE_REVIEW' ? 'CODE_REVIEW' : 'IMPLEMENTATION',
    taskFilePath: typeof raw.taskFilePath==='string' ? raw.taskFilePath : '',reviewNotesPath:typeof raw.reviewNotesPath==='string' ? raw.reviewNotesPath : '' };
  if (validateSettingsV2(settings)) return { ...common, runtimeSettings: structuredClone(settings), runProfiles: settings.runProfiles.map(p => ({
    id: p.kind, name: p.kind === 'RUN_MAIN' ? 'Run Main' : 'Run Tests', command: '', isTest: p.kind === 'RUN_TESTS'
  })) };
  // Preserve mixed/unknown JSON unchanged. Never interpret it as executable or coerce to V2.
  return { ...common, wireRunProfiles: Array.isArray(raw.runProfiles) ? structuredClone(raw.runProfiles) as Wire.RunProfile[] : [], runProfiles: [] };
}
export const mapDocument = (doc: Wire.Document): ProjectFile => ({ path: doc.path, kind: 'FILE', version: doc.version, content: doc.content, loaded: true, readOnly: doc.readOnly });
export const mapProposal = (p: Wire.Proposal): ActionProposal => ({ ...p, id: p.proposalId, type: p.kind, expiresAt: Date.parse(p.expiresAt) });
export const mapReport = (r: Wire.Report): SessionReport => ({ status: r.status, reason: r.reason, markdown: r.markdown ?? undefined, error: r.error ? `${r.error.code}: ${r.error.message}` : undefined });
export function mapRun(run: Wire.Run | RunV2, previous: ExecutionRun | null): ExecutionRun {
  const same = previous?.runId === run.runId;
  return { ...run, profileName: run.mode === 'RUN_TESTS' ? 'Run Tests' : 'Run Main', exitCode: run.exitCode ?? undefined,
    logs: same ? previous.logs : run.outputTail ? [{ id: `${run.runId}-tail`, timestamp: Date.now(), type: 'SYSTEM', text: run.outputTail }] : [] };
}
export function emptyLiveState(): ClientState {
  const capabilities = { canRunMain: false, canRunTests: false, docsPlugin: 'NOT_INSTALLED', autocompletePlugin: 'NOT_INSTALLED' } as const;
  return { durableProject:null,projectError:null,locale:'pl',transportMode: 'LIVE_BACKEND', connectionError: null, taskReadError: null, pendingPaths: [], storageError: null, snapshotsError: null,
    scenario: { id: 'live', title: 'Lokalny projekt', category: 'Algorytmy', taskMode: 'IMPLEMENTATION', description: '', defaultTimeLimitMs: 0, files: [], taskFilePath: '', reviewNotesPath: 'review.md', capabilities },
    files: [], activePath: '', writeOwner: 'SYNCING', coachMode: 'UNAVAILABLE', aiStatus: 'OFF', sessionStatus: 'STOPPED', elapsedMs: 0, limitMs: 0,
    pauseOnHidden: true, windowPresence: 'FOCUSED', capabilities, activePointer: null, activeHintBubble: null, activeProposal: null,
    chatEntries: [], activeRun: null, report: null, isOffline: true, controlEpoch: 0, workspaceVersion: 0, fileConflict: null,
    projectSettings: { aiConsent: false, taskMode: 'IMPLEMENTATION', taskFilePath: '', reviewNotesPath: 'review.md', runProfiles: [] }, snapshots: [],
    stats: { coachInterventionsCount: 0, userVetoCount: 0, testRunsCount: 0 } };
}
