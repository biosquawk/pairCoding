/** Genuine canonical Store/gate/journal; synthetic OFF capability DTO, no runtime readiness claim. */
import path from 'node:path';
import { createRuntimeWorkspace } from '../../src/server/runtime-coordinator/RuntimeWorkspace';
import { DurableMutationJournal } from '../../src/server/runtime-coordinator/MutationJournal';
import { RuntimeSettingsMutation } from '../../src/server/runtime-coordinator/RuntimeSettingsMutation';
import type { FileEntry } from '../../src/shared/protocol';
import type { ProjectV2, SettingsV2 } from '../../src/shared/runtime-v2';
import { SettingsV2Store, type SettingsCheckpoint } from '../../src/server/settings-v2';
export const clientId = 'save-stage-tab';
export const settings: SettingsV2 = { schemaVersion: 2, taskFilePath: null, taskMode: 'IMPLEMENTATION', reviewNotesPath: 'review.md',
  runProfiles: [], aiConsent: false, contextPatterns: [] };
export async function open(root: string, checkpoint?: (phase: SettingsCheckpoint) => void) {
  const originalCore = await createRuntimeWorkspace({ rootPath: root });
  const core = checkpoint ? { ...originalCore, settingsStore: new SettingsV2Store({ settingsPath: originalCore.settingsStore.settingsPath,
    authority: originalCore.settingsAuthority, checkpoint }) } : originalCore;
  core.session.claimLease(clientId);
  const journal = new DurableMutationJournal(path.join(root, '.paircoach', 'mutation-results'));
  const mutations = new RuntimeSettingsMutation(core, journal);
  const input = (requestId = 'original-save') => ({ request: { requestId, clientId, sessionId: core.session.state.sessionId,
    expectedWorkspaceVersion: core.workspace.workspaceVersion, settings: structuredClone(settings) },
    humanConfirmed: true as const, expectedSourceSha256: core.readSettings().sourceSha256 });
  const project = (i: ReturnType<typeof input>, files?: FileEntry[]): ProjectV2 => {
    const problem = { code: 'RUNTIME_CONFIG_INVALID', message: 'Fixture has no runtime configuration.', recovery: 'Configure runtime.', retryable: false };
    return { projectId: core.workspace.projectId, rootPath: root, sessionId: i.request.sessionId,
      workspaceVersion: i.request.expectedWorkspaceVersion + 1, files: files ?? core.workspace.listFiles(), settings: structuredClone(i.request.settings),
      capabilities: { execution: { runtime: { profileId: null, label: 'No runtime', configurationGeneration: 'fixture-config', state: 'CONFIG_ERROR', problem, taskFields: [] },
        modes: { RUN_MAIN: { canRun: false, problem }, RUN_TESTS: { canRun: false, problem } } },
        language: { projectId: core.workspace.projectId, profileId: 'unconfigured', configurationGeneration: 'fixture-config', providerGeneration: 'fixture-provider',
          state: 'OFF', autocomplete: 'OFF', docs: 'N/A', problem } } };
  };
  return { core, journal, mutations, input, project, async close() { await journal.close(); core.close(); } };
}
