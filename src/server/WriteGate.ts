import type { Document, Snapshot } from '../shared/protocol';
import { WorkspaceService } from './WorkspaceService';
import { SessionController } from './SessionController';
import { AppError } from './errors';
import type { AcknowledgedRunInput, InputFile } from './execution/ports';
import type { SettingsTransactionIdentity, SettingsWriteLease } from './settings-v2';

export type MutationAuth = { clientId: string; sessionId: string; controlEpoch: number; actor: 'STUDENT' | 'COACH' };
export type FileMutation = MutationAuth & { operation: 'CREATE' | 'RENAME' | 'DELETE'; path: string;
  newPath: string | null; content: string | null; baseVersion: number | null };
/** Internal retained gate authority, not a wire callback or complete filesystem/source proof. */
export interface LanguageSourceLease {
  /** Required throughout preparation and EVERY actual shadow copy/current check. */
  assertCurrent(): void;
  /** Scope/control/settings/version authority after copy, NOT permission to copy without FIFO.
   * Language owner must additionally re-scan its complete raw source/overlay vector. */
  assertRetainedCurrent(): void;
}

export class WriteGate {
  constructor(private readonly workspace: WorkspaceService, private readonly session: SessionController) {
    this.workspace._recoverSnapshots();
  }

  private authorize(input: MutationAuth): void {
    this.session.assertClient(input.clientId, input.sessionId);
    const state = this.session.state;
    if (!Number.isSafeInteger(input.controlEpoch) || input.controlEpoch !== state.controlEpoch) {
      throw new AppError(409, 'STALE_EPOCH', 'Control epoch is no longer current.');
    }
    if (input.actor !== 'STUDENT' && input.actor !== 'COACH') throw new AppError(400, 'INVALID_ACTOR', 'Invalid mutation actor.');
    if (input.actor !== state.writeOwner) throw new AppError(409, 'WRITE_OWNER_CONFLICT', 'Another actor currently owns the editor.');
    // Manual editing remains possible after finish; coach never gets that exception.
    if (input.actor === 'COACH' && !this.session.canCoach()) throw new AppError(403, 'COACH_FORBIDDEN', 'Coach authority is unavailable.');
  }

  private coachPath(relative: string): void {
    const settings = this.workspace.settings;
    const parts = relative.toLowerCase().split('/');
    const name = parts[parts.length - 1];
    // Hard exclusions precede the review-notes exception and never trust model instructions.
    if (parts.some(p => /^(tests?|__tests__|specs?|fixtures?|goldens?|\.git|\.paircoach|\.aws|\.ssh|credentials?)$/.test(p)) ||
        /^\.env/i.test(name) || /\.(pem|key|pfx|p12|keystore)$/i.test(name) ||
        /(?:^|[._-])(test|spec|golden|fixture)(?:[._-]|$)/i.test(name) || /(?:test|tests|spec)\.[^.]+$/i.test(name) ||
        relative.toLowerCase() === settings.taskFilePath?.toLowerCase()) {
      throw new AppError(403, 'COACH_PATH_FORBIDDEN', 'Coach cannot modify task, tests, secrets, or protected files.');
    }
    if (settings.taskMode === 'CODE_REVIEW') {
      if (relative !== settings.reviewNotesPath) throw new AppError(403, 'COACH_REVIEW_ONLY', 'Coach may write only the configured review notes.');
      return;
    }
    // Allow actual code, not arbitrary configuration/scripts disguised as source.
    if (!/\.(java|py|js|jsx|ts|tsx)$/i.test(name) ||
        /^(package(?:-lock)?\.json|.*config\.[^.]+|vite\..*|setup\.py|conftest\.py|.*\.d\.ts)$/i.test(name) ||
        parts.some(p => /^(config|configs|scripts|build|\.github|\.idea)$/.test(p))) {
      throw new AppError(403, 'COACH_PATH_FORBIDDEN', 'Coach edits are limited to task source code.');
    }
  }

  write(input: MutationAuth & { path: string; baseVersion: number; content: string }): Document {
    return this.workspace._withMutation(() => this.writeAuthorized(input));
  }

  /** Ordered server admission path, including writes queued before a Run capture. */
  writeAsync(input: MutationAuth & { path: string; baseVersion: number; content: string }, assertScopeCurrent:()=>void = ()=>{}): Promise<Document> {
    const accepted = structuredClone(input);
    return this.workspace._withQueuedMutation(async () => this.writeAuthorized(accepted,assertScopeCurrent));
  }

  /** Frozen copy-helper signature; implementation stays executor-owned and is injected until reviewed. */
  captureRun(input: MutationAuth & { runId: string; profileId: string; configurationGeneration: string; expectedWorkspaceVersion: number;
      runDirectory: string }, collaborators: {
        inventory(root: string): Promise<readonly { path: string; sha256: string; bytes: number }[]>;
        copy(options: { workspaceDirectory: string; runDirectory: string; runId: string; profileId: string; configurationGeneration: string;
          acknowledgement: { projectId: string; sessionId: string; workspaceVersion: number; files: readonly InputFile[]; assertCurrent(): Promise<void> } }): Promise<AcknowledgedRunInput>;
        /** Trusted coordinator only: prepare/verify selected cache under this SAME capture lease. */
        prepare?(lease: { assertCurrent(): void }): Promise<void>;
        assertCurrent?(): void;
      }): Promise<AcknowledgedRunInput> {
    const accepted = structuredClone(input);
    return this.workspace._withQueuedMutation(async () => {
      let held = true;
      const assertLease = () => {
        if (!held) throw new AppError(409, 'RUN_INPUT_CHANGED', 'Immutable input lease has already been released.');
        this.authorize(accepted);
        collaborators.assertCurrent?.();
        if (accepted.actor !== 'STUDENT') throw new AppError(403, 'RUN_FORBIDDEN', 'Only student authority may capture Run input.');
        if (this.workspace.workspaceVersion !== accepted.expectedWorkspaceVersion) throw new AppError(409, 'WORKSPACE_VERSION_CONFLICT', 'Run requires the current settled workspace.');
      };
      try {
        assertLease();
        await collaborators.prepare?.(Object.freeze({ assertCurrent: assertLease }));
        assertLease();
        const capture = await this.workspace._settledRunInput(collaborators.inventory, assertLease);
        const acknowledgement = Object.freeze({ projectId: this.workspace.projectId, sessionId: accepted.sessionId,
          workspaceVersion: capture.workspaceVersion, files: capture.files, assertCurrent: capture.assertCurrent });
        await acknowledgement.assertCurrent();
        const copied = await collaborators.copy({ workspaceDirectory: this.workspace.rootPath, runDirectory: accepted.runDirectory,
          runId: accepted.runId, profileId: accepted.profileId, configurationGeneration: accepted.configurationGeneration, acknowledgement });
        await acknowledgement.assertCurrent();
        // A helper result is not authority to substitute another run/scope/inventory.
        if (copied.projectId !== acknowledgement.projectId || copied.sessionId !== acknowledgement.sessionId ||
            copied.identity.runId !== accepted.runId || copied.identity.profileId !== accepted.profileId ||
            copied.identity.configurationGeneration !== accepted.configurationGeneration || copied.identity.workspaceVersion !== capture.workspaceVersion ||
            JSON.stringify(copied.files) !== JSON.stringify(capture.files)) throw new AppError(409, 'RUN_INPUT_CHANGED', 'Immutable copy did not retain the captured authority.');
        return copied;
      } finally { held = false; }
    });
  }

  /** @internal Prevent accidental composition with a gate from another project instance. */
  _assertSettingsWorkspace(workspace: WorkspaceService): void {
    if (workspace !== this.workspace) throw new AppError(409, 'WORKSPACE_SCOPE_MISMATCH', 'Settings authority and WriteGate must share the actual workspace instance.');
  }

  /** @internal Settings use the SAME FIFO/root exclusion as writes and immutable Run capture.
   * Recovery is trusted server work, not browser authority to mutate an old session. */
  _withSettingsLease<T>(identity: Readonly<SettingsTransactionIdentity>, recovery: boolean,
      action: (lease: SettingsWriteLease) => T): Promise<T> {
    const accepted = structuredClone(identity);
    const auth: MutationAuth = { clientId: accepted.clientId, sessionId: accepted.sessionId,
      controlEpoch: this.session.state.controlEpoch, actor: 'STUDENT' };
    return this.workspace._withQueuedMutation(async () => {
      let held = true;
      const lease: SettingsWriteLease = { assertCurrent: () => {
        if (!held) throw new AppError(409, 'SETTINGS_LEASE_RELEASED', 'Settings lease is no longer held.');
        this.workspace._settingsVersionStore().assertCurrent();
        if (recovery) {
          if (this.session.state.writeOwner !== 'STUDENT') throw new AppError(409, 'WRITE_OWNER_CONFLICT', 'Student authority is required for settings recovery.');
        } else {
          this.authorize(auth);
        }
      } };
      try {
        lease.assertCurrent(); return action(lease);
      } finally { held = false; }
    }, true);
  }

  private writeAuthorized(input: MutationAuth & { path: string; baseVersion: number; content: string }, assertScopeCurrent:()=>void = ()=>{}): Document {
    assertScopeCurrent();this.authorize(input);
    this.workspace._safePath(input.path);
    if (input.actor === 'COACH') this.coachPath(input.path);
    const result = this.workspace._replace(input.path, input.baseVersion, input.content, input.actor, () => {assertScopeCurrent();this.authorize(input);});
    if (input.actor === 'STUDENT') this.session.noteStudentEdit(input.path, result.content);
    return result;
  }

  restoreSnapshot(input: MutationAuth & { snapshotId: string; paths: string[]; expectedWorkspaceVersion: number }): Promise<Snapshot> {
    // Caller-owned DTOs may change while we yield: retain the ORIGINAL authority and selection.
    const accepted = { ...input, paths: Array.isArray(input.paths) ? [...input.paths] : input.paths };
    return this.workspace._withMutationAsync(async () => {
      this.authorize(accepted);
      if (accepted.actor !== 'STUDENT') throw new AppError(403, 'COACH_RESTORE_FORBIDDEN', 'Only the student may accept a restore.');
      return this.workspace._restoreSnapshot(accepted.snapshotId, accepted.paths, accepted.expectedWorkspaceVersion, () => this.authorize(accepted));
    });
  }

  mutate(input: FileMutation): void {
    return this.workspace._withMutation(() => this.mutateAuthorized(input));
  }

  mutateAsync(input: FileMutation): Promise<void> {
    const accepted = structuredClone(input);
    return this.workspace._withQueuedMutation(async () => this.mutateAuthorized(accepted));
  }

  /** @internal SAME FIFO/root exclusion through async prepare AND synchronous materialize/dispatch.
   * Source owner must ADD its retained full synchronous scanner proof; workspaceVersion/watchers
   * alone cannot prove external sources. Coordinator callback checks actual scope/ALL overlays,
   * config/settings-source/preparation revocation before every sensitive operation.
   */
  _withLanguageSourceLease<T>(input: MutationAuth & { expectedWorkspaceVersion: number },
      assertScopeCurrent: () => void, action: (lease: LanguageSourceLease) => Promise<T>): Promise<T> {
    const accepted = structuredClone(input);
    return this.workspace._withQueuedMutation(async () => {
      let held = true, completed = false;
      const assertRetainedCurrent = () => {
        if (!held && !completed) throw new AppError(409, 'LANGUAGE_LEASE_RELEASED', 'Failed language preparation has no retained authority.');
        this.authorize(accepted);
        this.workspace._settingsVersionStore().assertCurrent();
        if (this.workspace.workspaceVersion !== accepted.expectedWorkspaceVersion)
          throw new AppError(409, 'WORKSPACE_VERSION_CONFLICT', 'Language source requires the current settled workspace.');
        assertScopeCurrent();
      };
      const lease: LanguageSourceLease = Object.freeze({ assertRetainedCurrent, assertCurrent: () => {
        if (!held) throw new AppError(409, 'LANGUAGE_LEASE_RELEASED', 'Language source lease is no longer held.');
        assertRetainedCurrent();
      } });
      try {
        lease.assertCurrent();
        const result = await action(lease);
        lease.assertCurrent();
        completed = true;
        return result;
      } finally { held = false; }
    });
  }

  private mutateAuthorized(input: FileMutation): void {
    this.authorize(input);
    this.workspace._safePath(input.path, true);
    // AI plans propose edits to existing documents, never arbitrary filesystem mutations.
    if (input.actor === 'COACH') throw new AppError(403, 'COACH_MUTATION_FORBIDDEN', 'Coach cannot create, rename, or delete files.');
    const authorize = () => this.authorize(input);
    if (input.operation === 'CREATE') {
      if (input.baseVersion !== null || input.newPath !== null || typeof input.content !== 'string') {
        throw new AppError(400, 'INVALID_MUTATION', 'CREATE requires content, null baseVersion and null newPath.');
      }
      const doc = this.workspace._create(input.path, input.content, input.actor, authorize);
      this.session.noteStudentEdit(input.path, doc.content);
    } else if (input.operation === 'RENAME') {
      if (typeof input.newPath !== 'string' || input.content !== null || !Number.isSafeInteger(input.baseVersion)) {
        throw new AppError(400, 'INVALID_MUTATION', 'RENAME requires newPath, baseVersion and null content.');
      }
      this.workspace._safePath(input.newPath, true);
      this.workspace._rename(input.path, input.newPath, input.baseVersion!, input.actor, authorize);
    } else if (input.operation === 'DELETE') {
      if (input.newPath !== null || input.content !== null || !Number.isSafeInteger(input.baseVersion)) {
        throw new AppError(400, 'INVALID_MUTATION', 'DELETE requires baseVersion and null newPath/content.');
      }
      this.workspace._delete(input.path, input.baseVersion!, input.actor, authorize);
      this.session.noteStudentEdit(input.path, '');
    } else throw new AppError(400, 'INVALID_MUTATION', 'Only CREATE, RENAME, and DELETE are supported.');
  }
}
