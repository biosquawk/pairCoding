import type * as Wire from '../shared/protocol';
import type { ActionProposal, ExecutionRun, ProjectFile, ProjectSettings, SessionReport } from '../types/paircoach';
import type { ClientState } from './liveTypes';

export function mapSettings(settings: Wire.Settings): ProjectSettings {
  return { ...settings, wireRunProfiles: settings.runProfiles, contextPatterns: settings.contextPatterns, taskFilePath: settings.taskFilePath ?? '', runProfiles: settings.runProfiles.map(p => ({
    id: p.kind, name: p.kind === 'RUN_MAIN' ? 'Run Main' : 'Run Tests', command: [p.executable, ...p.args].join(' '), isTest: p.kind === 'RUN_TESTS'
  })) };
}
export const mapDocument = (doc: Wire.Document): ProjectFile => ({ path: doc.path, kind: 'FILE', version: doc.version, content: doc.content, loaded: true, readOnly: doc.readOnly });
export const mapProposal = (p: Wire.Proposal): ActionProposal => ({ ...p, id: p.proposalId, type: p.kind, expiresAt: Date.parse(p.expiresAt) });
export const mapReport = (r: Wire.Report): SessionReport => ({ status: r.status, reason: r.reason, markdown: r.markdown ?? undefined, error: r.error ? `${r.error.code}: ${r.error.message}` : undefined });
export function mapRun(run: Wire.Run, previous: ExecutionRun | null): ExecutionRun {
  const same = previous?.runId === run.runId;
  return { ...run, profileName: run.mode === 'RUN_TESTS' ? 'Run Tests' : 'Run Main', exitCode: run.exitCode ?? undefined,
    logs: same ? previous.logs : run.outputTail ? [{ id: `${run.runId}-tail`, timestamp: Date.now(), type: 'SYSTEM', text: run.outputTail }] : [] };
}
export function emptyLiveState(): ClientState {
  const capabilities = { canRunMain: false, canRunTests: false, docsPlugin: 'NOT_INSTALLED', autocompletePlugin: 'NOT_INSTALLED' } as const;
  return { transportMode: 'LIVE_BACKEND', connectionError: null, taskReadError: null, pendingPaths: [], storageError: null, snapshotsError: null,
    scenario: { id: 'live', title: 'Lokalny projekt', category: 'Algorytmy', taskMode: 'IMPLEMENTATION', description: '', defaultTimeLimitMs: 0, files: [], taskFilePath: '', reviewNotesPath: 'review.md', capabilities },
    files: [], activePath: '', writeOwner: 'SYNCING', coachMode: 'UNAVAILABLE', aiStatus: 'OFF', sessionStatus: 'STOPPED', elapsedMs: 0, limitMs: 0,
    pauseOnHidden: true, windowPresence: 'FOCUSED', capabilities, activePointer: null, activeHintBubble: null, activeProposal: null,
    chatEntries: [], activeRun: null, report: null, isOffline: true, controlEpoch: 0, workspaceVersion: 0, fileConflict: null,
    projectSettings: { aiConsent: false, taskMode: 'IMPLEMENTATION', taskFilePath: '', reviewNotesPath: 'review.md', runProfiles: [] }, snapshots: [],
    stats: { coachInterventionsCount: 0, userVetoCount: 0, testRunsCount: 0 } };
}
