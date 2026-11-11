/** Production V2 workspace construction. Caller must await completion BEFORE publishing a
 * session, peer bootstrap or routes. No runtime readiness or language ACK is inferred here.
 */
import path from 'node:path';
import { WorkspaceService } from '../WorkspaceService';
import { SessionController } from '../SessionController';
import { WriteGate } from '../WriteGate';
import { SettingsV2Store, type SettingsReadResult } from '../settings-v2';
import { GateSettingsAuthority } from './GateSettingsAuthority';
import { privateDirectory } from './storage';

export interface RuntimeWorkspace {
  readonly workspace: WorkspaceService;
  readonly session: SessionController;
  readonly gate: WriteGate;
  readonly settingsStore: SettingsV2Store;
  readonly settingsAuthority: GateSettingsAuthority;
  readonly settingsRecovery: 'NONE' | 'COMMITTED' | 'ABORTED';
  readSettings(): SettingsReadResult;
  close(): void;
}
export async function createRuntimeWorkspace(options: { rootPath: string }): Promise<RuntimeWorkspace> {
  // Stable kernel ownership is acquired BEFORE snapshot recovery or source version observation.
  // Observers stay stopped across asynchronous settings recovery; no partial core escapes.
  const workspace = new WorkspaceService(options.rootPath, undefined, {
    durableVersions: true, recoverSnapshotsBeforeVersions: true, deferObservation: true,
  });
  let session: SessionController | undefined;
  try {
    const settingsDirectory = path.join(workspace.rootPath, '.paircoach');
    privateDirectory(settingsDirectory);
    session = new SessionController(workspace);
    const gate = new WriteGate(workspace, session);
    const settingsAuthority = new GateSettingsAuthority(workspace, gate);
    // Exactly the canonical project settings, NOT a dataDir/project.json alias or implicit discovery.
    const settingsStore = new SettingsV2Store({ settingsPath: path.join(settingsDirectory, 'settings.json'), authority: settingsAuthority });
    const settingsRecovery = await settingsAuthority.recoverStore(settingsStore);
    const readSettings = () => settingsStore.read();
    const current = readSettings();
    if (current.settings) {
      const { runProfiles: _profiles, schemaVersion: _version, ...metadata } = current.settings;
      // Legacy core policy consumes only neutral metadata. V2 execution MUST use settingsStore,
      // never legacy profiles/host commands. No conversion of TaskRunConfig to an executable.
      workspace.settings = { ...metadata, runProfiles: [] };
    }
    workspace._startObservation();
    return { workspace, session, gate, settingsStore, settingsAuthority, settingsRecovery, readSettings,
      close() { try { session!.close(); } finally { workspace.close(); } } };
  } catch (error) {
    try { session?.close(); } finally { workspace.close(); }
    throw error;
  }
}
