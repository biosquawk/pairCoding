/** Production V2 workspace construction. Caller must await completion BEFORE publishing a
 * session, peer bootstrap or routes. No runtime readiness or language ACK is inferred here.
 */
import path from 'node:path';
import fs from 'node:fs';
import { AppError } from '../errors';
import { WorkspaceService } from '../WorkspaceService';
import { SessionController } from '../SessionController';
import { WriteGate } from '../WriteGate';
import { SettingsV2Store, type SettingsReadResult } from '../settings-v2';
import { GateSettingsAuthority } from './GateSettingsAuthority';
import { canonicalDirectory, privateDirectory } from './storage';
import { readRuntimeProjectSettings, applyRuntimeSettingsMetadata } from './RuntimeProject';

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
export async function createRuntimeWorkspace(options: { rootPath: string; dataDir?: string }): Promise<RuntimeWorkspace> {
  // No discovery or second ledger for the same canonical settings authority. Validate explicit
  // storage BEFORE initialization (including when another core already owns the same root).
  const root = path.resolve(options.rootPath);
  canonicalDirectory(root);
  const canonicalData = path.join(root, '.paircoach');
  if (options.dataDir !== undefined && options.dataDir !== canonicalData)
    throw new AppError(400, 'INVALID_V2_DATA_DIR', 'V2 workspace storage must be the canonical project .paircoach directory; separate report storage is not workspace authority.');
  const exists = (file: string) => {
    try { fs.lstatSync(file); return true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
  };
  if (exists(path.join(canonicalData, 'settings.json.v2-state')) && !exists(path.join(canonicalData, 'workspace-v2', 'versions.json')))
    throw new AppError(409, 'WORKSPACE_RECOVERY_REQUIRED', 'Prior settings transaction material has no durable workspace history. Preserve it; do not initialize a replacement version-zero authority.');
  // Stable kernel ownership is acquired BEFORE snapshot recovery or source version observation.
  // Observers stay stopped across asynchronous settings recovery; no partial core escapes.
  const workspace = new WorkspaceService(root, canonicalData, {
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
    // Preserve safe nonexecution source metadata even for migration-required raw settings.
    // This required DTO/form NEVER changes readSettings().settings:null into accepted settings.
    applyRuntimeSettingsMetadata(workspace, readRuntimeProjectSettings({ workspace, settingsStore }).form);
    workspace._startObservation();
    return { workspace, session, gate, settingsStore, settingsAuthority, settingsRecovery, readSettings,
      close() { try { session!.close(); } finally { workspace.close(); } } };
  } catch (error) {
    try { session?.close(); } finally { workspace.close(); }
    throw error;
  }
}
