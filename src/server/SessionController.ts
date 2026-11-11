import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import type { Session, Timer } from '../shared/protocol';
import { WorkspaceService } from './WorkspaceService';
import { AppError, validId } from './errors';
import { viewOffsets, type EditorViewPayload, type VersionedEditorView } from './EditorView';

export class SessionController extends EventEmitter {
  readonly state: Session;
  leaseClientId: string | null = null;
  private editorView: { clientId: string; sessionId: string; view: VersionedEditorView } | null = null;
  private elapsed = 0;
  private runningSince: number | null = null;
  private baseline = new Map<string, string>();
  private cooldownEdits = new Map<string, string>();
  private cooldownTimer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;
  private manualMute = false;
  private muteTimer: ReturnType<typeof setTimeout> | null = null;
  private overtimeSent = false;
  private clock: ReturnType<typeof setInterval>;
  private onChanged = (change: { actor: string; path?: string }) => {
    if (this.editorView && (!change.path || change.path === this.editorView.view.path)) this.clearEditorView();
    this.state.workspaceVersion = this.workspace.workspaceVersion;
    // Any external/settings change invalidates coach authority before another step.
    if (change.actor === 'EXTERNAL' || change.actor === 'SETTINGS') {
      if (this.state.writeOwner === 'COACH') this.releaseCoach();
      this.emit('invalidate');
    }
  };

  constructor(private readonly workspace: WorkspaceService) {
    super();
    this.state = { sessionId: randomUUID(), projectId: workspace.projectId, lifecycle: 'READY',
      workspaceVersion: workspace.workspaceVersion, controlEpoch: 0, writeOwner: 'STUDENT',
      coachMode: 'UNAVAILABLE', cooldownAfterVeto: false, presence: 'FOCUSED', aiStatus: 'OFF',
      timer: { status: 'STOPPED', elapsedMs: 0, limitMs: null, pauseOnHidden: true,
        manualPaused: false, serverTime: new Date().toISOString() },
      activeFilePath: workspace.listFiles().find(f => f.kind === 'FILE')?.path ?? null,
      interventionId: null, lastServerSeq: 0 };
    workspace.on('changed', this.onChanged);
    this.clock = setInterval(() => {
      const timer = this.computeTimer();
      if (timer.status === 'OVERTIME' && !this.overtimeSent) {
        this.overtimeSent = true;
        this.emit('overtime');
        this.publish();
      }
    }, 100);
    this.clock.unref();
  }

  claimLease(clientId: string): boolean {
    if (this.closed || !validId(clientId)) throw new AppError(400, 'INVALID_CLIENT', 'A valid clientId is required.');
    if (this.leaseClientId !== null && this.leaseClientId !== clientId) return false;
    this.leaseClientId = clientId;
    this.syncClock();
    return true;
  }

  releaseLease(clientId: string): void {
    if (this.leaseClientId !== clientId) return;
    // Revoke first, before notifying any consumer or abort listener.
    this.state.controlEpoch++;
    this.leaseClientId = null;
    this.clearEditorView();
    this.state.writeOwner = 'STUDENT';
    this.state.interventionId = null;
    this.syncClock();
    this.emit('invalidate');
    this.publish();
  }

  assertClient(clientId: string, sessionId: string): void {
    if (this.closed) throw new AppError(503, 'SESSION_CLOSED', 'Session is closed.');
    if (sessionId !== this.state.sessionId) throw new AppError(409, 'SESSION_MISMATCH', 'Session is no longer current.');
    if (!validId(clientId) || this.leaseClientId !== clientId) throw new AppError(403, 'LEASE_REQUIRED', 'Only the active browser tab may mutate this session.');
  }

  clearEditorView(): void { this.editorView = null; }

  setEditorView(clientId: string, sessionId: string, payload: EditorViewPayload): number | null {
    this.assertClient(clientId, sessionId);
    if (payload.path === null) {
      if (payload.documentVersion !== null || payload.cursor !== null || payload.selection !== null)
        throw new AppError(400, 'INVALID_VIEW', 'A cleared view must have null coordinates and version.');
      this.clearEditorView();
      this.state.activeFilePath = null;
      return null;
    }
    const document = this.workspace.getDocument(payload.path);
    if (!Number.isSafeInteger(payload.documentVersion) || payload.documentVersion !== document.version)
      throw new AppError(409, 'DOCUMENT_VERSION_CONFLICT', 'View document version is no longer current.', document.version);
    viewOffsets(document.content, payload.cursor, payload.selection);
    // All checks precede mutation. Copy the accepted DTO, never retain caller-owned coordinates.
    this.editorView = { clientId, sessionId, view: structuredClone({ projectId: this.workspace.projectId,
      path: document.path, documentVersion: document.version, cursor: payload.cursor, selection: payload.selection }) };
    this.state.activeFilePath = document.path;
    return document.version;
  }

  getEditorView(): VersionedEditorView | null {
    const stored = this.editorView;
    if (!stored) return null;
    const view = stored.view;
    try {
      if (this.closed || this.state.lifecycle === 'FINISHED' || stored.clientId !== this.leaseClientId ||
          stored.sessionId !== this.state.sessionId || view.projectId !== this.workspace.projectId ||
          view.projectId !== this.state.projectId || view.path !== this.state.activeFilePath ||
          this.workspace.getDocument(view.path).version !== view.documentVersion) {
        this.clearEditorView(); return null;
      }
      return structuredClone(view);
    } catch { this.clearEditorView(); return null; }
  }

  getSession(): Session {
    this.state.workspaceVersion = this.workspace.workspaceVersion;
    this.state.timer = this.computeTimer();
    this.updateMode();
    return structuredClone(this.state);
  }

  start(limitMs: number | null, pauseOnHidden: boolean): Session {
    if (this.closed) throw new AppError(503, 'SESSION_CLOSED', 'Session is closed.');
    if (this.state.lifecycle !== 'READY') throw new AppError(409, 'SESSION_ALREADY_STARTED', 'Start requires a READY session.');
    if (this.leaseClientId === null) throw new AppError(403, 'LEASE_REQUIRED', 'Connect an active browser before starting.');
    if (typeof pauseOnHidden !== 'boolean' || (limitMs !== null && (!Number.isSafeInteger(limitMs) || limitMs < 1000 || limitMs > 86400000))) {
      throw new AppError(400, 'INVALID_TIMER', 'limitMs must be null or 1000..86400000; pauseOnHidden must be boolean.');
    }
    this.state.lifecycle = 'RUNNING';
    this.state.timer.limitMs = limitMs;
    this.state.timer.pauseOnHidden = pauseOnHidden;
    this.syncClock();
    this.publish();
    return this.getSession();
  }

  veto(): Session {
    if (this.closed) throw new AppError(503, 'SESSION_CLOSED', 'Session is closed.');
    // Transport deduplicates command IDs across WS and HTTP. Repeated active veto
    // is also harmless here; new logical vetoes after cooldown still revoke plans.
    if (this.state.cooldownAfterVeto && this.state.writeOwner === 'STUDENT') return this.getSession();
    this.state.controlEpoch++; // THE CUTOFF: no await, filesystem read, or adapter callback before this.
    this.state.writeOwner = 'STUDENT';
    this.state.interventionId = null;
    this.state.cooldownAfterVeto = true;
    this.baseline = this.workspace._baseline(); // Already-computed normalized hashes, not disk I/O.
    this.cooldownEdits.clear();
    if (this.cooldownTimer) clearTimeout(this.cooldownTimer);
    this.cooldownTimer = null;
    this.updateMode();
    this.emit('veto'); // Adapter abort happens after old authority is already invalid.
    this.publish();
    return this.getSession();
  }

  canCoach(): boolean {
    return !this.closed && this.leaseClientId !== null && this.state.lifecycle === 'RUNNING' &&
      this.state.presence === 'FOCUSED' && !this.state.timer.manualPaused &&
      !this.state.cooldownAfterVeto && !this.manualMute && this.workspace.settings.aiConsent &&
      ['READY', 'THINKING'].includes(this.state.aiStatus);
  }

  setAiStatus(status: Session['aiStatus']): void {
    if (!['OFF', 'READY', 'THINKING', 'FAILED'].includes(status)) throw new AppError(400, 'INVALID_AI_STATUS', 'Invalid AI status.');
    this.state.aiStatus = status;
    if (status === 'OFF' || status === 'FAILED') {
      this.releaseCoach();
      this.emit('invalidate');
    }
    this.publish();
  }

  mute(durationSeconds: number | null): void {
    if (durationSeconds !== null && (!Number.isSafeInteger(durationSeconds) || durationSeconds < 1 || durationSeconds > 86400)) {
      throw new AppError(400, 'INVALID_MUTE', 'Mute duration must be null or 1..86400 seconds.');
    }
    if (this.muteTimer) clearTimeout(this.muteTimer);
    this.muteTimer = null;
    this.manualMute = true;
    this.releaseCoach();
    this.emit('invalidate');
    if (durationSeconds !== null) {
      this.muteTimer = setTimeout(() => {
        this.muteTimer = null;
        this.manualMute = false;
        this.publish();
      }, durationSeconds * 1000);
      this.muteTimer.unref();
    }
    this.publish();
  }

  acquireCoach(interventionId: string): number {
    if (!validId(interventionId)) throw new AppError(400, 'INVALID_INTERVENTION', 'Invalid interventionId.');
    if (!this.canCoach() || this.state.writeOwner !== 'STUDENT') throw new AppError(409, 'CONTROL_UNAVAILABLE', 'Coach may not acquire control now.');
    this.state.controlEpoch++;
    this.state.writeOwner = 'COACH';
    this.state.interventionId = interventionId;
    this.publish();
    return this.state.controlEpoch;
  }

  releaseCoach(): void {
    if (this.state.writeOwner !== 'COACH') return;
    this.state.controlEpoch++;
    this.state.writeOwner = 'STUDENT';
    this.state.interventionId = null;
    this.publish();
  }

  setPresence(presence: Session['presence']): void {
    if (!['FOCUSED', 'BLURRED', 'HIDDEN'].includes(presence)) throw new AppError(400, 'INVALID_PRESENCE', 'Invalid window presence.');
    this.state.presence = presence;
    if (presence !== 'FOCUSED') {
      this.releaseCoach();
      this.emit('invalidate');
    }
    this.syncClock();
    this.publish();
  }

  timerAction(action: 'PAUSE' | 'RESUME' | 'SET_HIDDEN_POLICY', pauseOnHidden: boolean | null = null): void {
    if (this.state.lifecycle !== 'RUNNING') throw new AppError(409, 'TIMER_NOT_RUNNING', 'Timer actions require a running session.');
    if (action === 'PAUSE') {
      this.state.timer.manualPaused = true;
      this.releaseCoach();
      this.emit('invalidate');
    } else if (action === 'RESUME') {
      if (this.state.presence === 'HIDDEN' || this.leaseClientId === null) throw new AppError(409, 'PRESENCE_REQUIRED', 'Resume from a connected visible browser.');
      this.state.timer.manualPaused = false;
    } else if (action === 'SET_HIDDEN_POLICY' && typeof pauseOnHidden === 'boolean') {
      this.state.timer.pauseOnHidden = pauseOnHidden;
    } else throw new AppError(400, 'INVALID_TIMER_ACTION', 'Invalid timer action or hidden policy.');
    this.syncClock();
    this.publish();
  }

  noteStudentEdit(relative: string, content: string): void {
    if (!this.state.cooldownAfterVeto) return;
    this.cooldownEdits.set(relative, this.workspace._signature(content));
    if (this.cooldownTimer) clearTimeout(this.cooldownTimer);
    this.cooldownTimer = setTimeout(() => {
      this.cooldownTimer = null;
      const current = this.workspace._baseline();
      const changed = [...this.cooldownEdits].some(([p, signature]) =>
        signature === (current.get(p) ?? this.workspace._signature('')) &&
        signature !== (this.baseline.get(p) ?? this.workspace._signature('')));
      if (changed) this.unlockCooldown();
    }, 2000);
    this.cooldownTimer.unref();
  }

  noteNewFact(kind: 'CHAT' | 'RUN'): void {
    if (kind !== 'CHAT' && kind !== 'RUN') throw new AppError(400, 'INVALID_FACT', 'Only explicit chat or a new run result unlocks cooldown.');
    if (this.state.cooldownAfterVeto) this.unlockCooldown();
  }

  private unlockCooldown(): void {
    this.state.cooldownAfterVeto = false;
    this.baseline.clear();
    this.cooldownEdits.clear();
    if (this.cooldownTimer) clearTimeout(this.cooldownTimer);
    this.cooldownTimer = null;
    this.publish();
    this.emit('cooldownEnded');
  }

  private computeTimer(): Timer {
    const elapsedMs = Math.max(0, Math.floor(this.elapsed + (this.runningSince === null ? 0 : performance.now() - this.runningSince)));
    let status: Timer['status'] = 'STOPPED';
    if (this.state.lifecycle === 'RUNNING') status = this.runningSince === null ? 'PAUSED' :
      this.state.timer.limitMs !== null && elapsedMs >= this.state.timer.limitMs ? 'OVERTIME' : 'RUNNING';
    return { ...this.state.timer, elapsedMs, status, serverTime: new Date().toISOString() };
  }

  private syncClock(): void {
    const now = performance.now();
    if (this.runningSince !== null) this.elapsed += now - this.runningSince;
    const run = !this.closed && this.state.lifecycle === 'RUNNING' && this.leaseClientId !== null &&
      !this.state.timer.manualPaused && !(this.state.presence === 'HIDDEN' && this.state.timer.pauseOnHidden);
    this.runningSince = run ? now : null;
    this.state.timer = this.computeTimer();
  }

  private updateMode(): void {
    const state = this.state;
    state.coachMode = this.leaseClientId === null || state.lifecycle !== 'RUNNING' ? 'UNAVAILABLE' :
      state.timer.manualPaused || this.manualMute ? 'MUTED_MANUAL' : state.presence === 'HIDDEN' ? 'MUTED_WINDOW_HIDDEN' :
      state.cooldownAfterVeto ? 'COOLDOWN_AFTER_VETO' :
      !this.workspace.settings.aiConsent || ['OFF', 'FAILED'].includes(state.aiStatus) ? 'UNAVAILABLE' :
      state.writeOwner === 'COACH' ? 'INTERVENING' : 'ACTIVE_WATCHING';
  }

  private publish(): void {
    const session = this.getSession();
    this.emit('control', { writeOwner: session.writeOwner, controlEpoch: session.controlEpoch, coachMode: session.coachMode,
      cooldownAfterVeto: session.cooldownAfterVeto, interventionId: session.interventionId, purpose: null });
    this.emit('state', session);
  }

  finish(): void {
    if (this.state.lifecycle === 'FINISHED') return;
    this.state.controlEpoch++;
    this.state.writeOwner = 'STUDENT';
    this.state.interventionId = null;
    this.state.lifecycle = 'FINISHED';
    this.clearEditorView();
    this.syncClock();
    this.emit('invalidate');
    this.publish();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.state.controlEpoch++;
    this.state.writeOwner = 'STUDENT';
    this.state.interventionId = null;
    this.leaseClientId = null;
    this.clearEditorView();
    this.syncClock();
    this.workspace.off('changed', this.onChanged);
    clearInterval(this.clock);
    if (this.muteTimer) clearTimeout(this.muteTimer);
    if (this.cooldownTimer) clearTimeout(this.cooldownTimer);
    this.emit('invalidate');
    this.removeAllListeners();
  }
}
