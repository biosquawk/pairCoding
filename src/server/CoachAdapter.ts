import { randomUUID } from 'node:crypto';
import type { ChatEntry, CoachDecision, Run, Session } from '../shared/protocol';
import type { WorkspaceService } from './WorkspaceService';
import type { SessionController } from './SessionController';
import type { WriteGate } from './WriteGate';
import { buildContext, contextFingerprint, isContextPathAllowed, isCoachWriteAllowed, redactSecrets } from './coach/context';
import type { CoachContext } from './coach/context';
import { applyTextEdit } from './coach/edits';
import { parseCoachDecision } from './coach/schema';
import { defaultCoachProvider } from './coach/provider';
import type { CoachProvider } from './coach/provider';
export type { CoachProvider } from './coach/provider';

export interface CoachOptions {
  workspace: WorkspaceService;
  session: SessionController;
  gate: WriteGate;
  emit: (type: string, payload: unknown) => void;
  onProposal: (decision: Extract<CoachDecision, { kind: 'PROPOSE' }>) => void;
  provider?: CoachProvider;
  sensitiveValues?: readonly string[];
}
type Ready = { requestId: string; workspaceVersion: number; ready: boolean };
type Rendered = { stepId: string; interventionId: string; documentVersion: number };
type Pending = { reason: string; message?: ChatEntry };

/** Bounded coordinator. Provider outputs are data; only WriteGate can commit mutations. */
export class CoachAdapter {
  private readonly provider: CoachProvider;
  private readonly messages: ChatEntry[] = [];
  private readonly interventions: CoachContext['previousInterventions'] = [];
  private readonly sensitive: readonly string[];
  private readonly fingerprints = new Set<string>();
  private lastRun: Run | null = null;
  private active = false;
  private pending: Pending | null = null;
  private activeRequest: Pending | null = null;
  private editTimer: ReturnType<typeof setTimeout> | null = null;
  private controller: AbortController | null = null;
  private analysisTimer: ReturnType<typeof setTimeout> | null = null;
  private readyWaiter: { requestId: string; accept: (payload: Ready) => void } | null = null;
  private renderedWaiter: { stepId: string; accept: (payload: Rendered) => void } | null = null;
  private closed = false;
  private generation = 0;
  private owned: { id: string; epoch: number } | null = null;
  private pointer: { id: string; path: string; version: number } | null = null;
  private fallbackAnnounced = false;

  constructor(private readonly options: CoachOptions) {
    this.provider = options.provider ?? defaultCoachProvider();
    this.sensitive = [...(options.sensitiveValues ?? []), ...(process.env.GEMINI_API_KEY ? [process.env.GEMINI_API_KEY] : [])];
    options.session.on('veto', this.onVeto);
    options.session.on('invalidate', this.onVeto);
    options.session.on('state', this.onState);
    options.workspace.on('changed', this.onChanged);
    options.workspace.on('external', this.onExternal);
    this.setStatus(options.workspace.settings.aiConsent && this.provider.mode !== 'LOCAL_FALLBACK' ? 'READY' : 'OFF');
  }

  private setStatus(status: Session['aiStatus']): void {
    this.options.session.setAiStatus(status);
  }

  private allowed(): boolean {
    const { session, workspace } = this.options;
    return !this.closed && workspace.settings.aiConsent && session.canCoach() &&
      session.getSession().lifecycle === 'RUNNING' && session.getSession().presence === 'FOCUSED';
  }

  trigger(reason: 'EDIT' | 'CHAT' | 'RUN' | 'START' | 'OVERTIME', message?: ChatEntry): void {
    if (this.closed) return;
    if (message?.author === 'STUDENT' && !this.messages.some(item => item.messageId === message.messageId)) {
      this.messages.push(structuredClone(message));
      if (this.messages.length > 20) this.messages.shift();
    }
    if (reason === 'CHAT' && message?.author === 'STUDENT') this.options.session.noteNewFact('CHAT');
    if (this.editTimer) { clearTimeout(this.editTimer); this.editTimer = null; }
    if (!this.options.workspace.settings.aiConsent) { this.abort(); this.setStatus('OFF'); return; }
    if (this.provider.mode === 'LOCAL_FALLBACK') {
      this.setStatus('OFF');
      if (!this.fallbackAnnounced) {
        this.fallbackAnnounced = true;
        this.options.emit('CHAT_REPLY', { replyTo: message?.messageId ?? null,
          text: 'Trener AI wyłączony: brak GEMINI_API_KEY. Edytor działa; lokalny fallback nie analizuje kodu ani nie udaje Gemini.' });
      }
      return;
    }
    if (this.options.session.getSession().aiStatus === 'OFF' || this.options.session.getSession().aiStatus === 'FAILED') this.setStatus('READY');
    const enqueue = () => {
      this.editTimer = null;
      // Explicit chat retains response/mute authorization while newer edits refresh its context.
      if (reason === 'CHAT' || this.pending?.reason !== 'CHAT') this.pending = { reason, message };
      void this.pump();
    };
    if (reason === 'EDIT') this.editTimer = setTimeout(enqueue, 350);
    else enqueue();
  }

  /** K calls with a real, completed Run, not arbitrary model claims. */
  updateRun(run: Run): void {
    if (this.closed || !run.finishedAt || this.lastRun?.runId === run.runId) return;
    this.lastRun = structuredClone(run);
    this.options.session.noteNewFact('RUN');
    this.trigger('RUN');
  }

  private async pump(): Promise<void> {
    if (this.active || !this.pending || !this.allowed()) return;
    const pending = this.pending;
    this.pending = null;
    const context = buildContext(this.options.workspace, this.options.session.getSession(), this.messages,
      this.lastRun, this.interventions, this.sensitive);
    const fingerprint = contextFingerprint(context);
    if (this.fingerprints.has(fingerprint)) return;
    this.fingerprints.add(fingerprint);
    if (this.fingerprints.size > 200) this.fingerprints.delete(this.fingerprints.values().next().value!);
    const generation = this.generation;
    const controller = new AbortController();
    this.controller = controller;
    this.active = true;
    this.activeRequest = pending;
    this.setStatus('THINKING');
    const analysisTimeout = setTimeout(() => {
      controller.abort();
      this.setStatus('FAILED');
      this.error('COACH_ANALYSIS_TIMEOUT', 'Przekroczono limit 30 s analizy trenera. Edytor pozostaje dostępny.');
    }, 30000);
    this.analysisTimer = analysisTimeout;
    try {
      // Keep at most one actual provider invocation alive even if an injected provider ignores abort.
      const raw = await this.provider.decide(structuredClone(context), controller.signal);
      clearTimeout(analysisTimeout);
      if (!this.fresh(context, generation, controller.signal)) return;
      const decision = parseCoachDecision(raw);
      this.setStatus('READY');
      await this.applyDecision(decision, context, pending, controller.signal);
    } catch {
      // Never log provider error/message/body: these can include request content or keys.
      if (!controller.signal.aborted && !this.closed) {
        this.setStatus('FAILED');
        this.error('COACH_RESPONSE_REJECTED', 'Odpowiedź trenera jest nieprawidłowa lub nieaktualna; zachowano pracę.');
      }
    } finally {
      clearTimeout(analysisTimeout);
      if (this.analysisTimer === analysisTimeout) this.analysisTimer = null;
      this.releaseOwned();
      this.publishControl(); // Also releases the frontend's CONTROL_PREPARE lock on timeout/rejection.
      if (this.controller === controller) this.controller = null;
      this.active = false;
      if (this.activeRequest === pending) this.activeRequest = null;
      if (!this.closed && this.options.session.getSession().aiStatus === 'THINKING') this.setStatus(this.options.workspace.settings.aiConsent ? 'READY' : 'OFF');
      if (this.pending && this.allowed()) queueMicrotask(() => void this.pump());
    }
  }

  private fresh(context: CoachContext, generation: number, signal: AbortSignal): boolean {
    return !signal.aborted && generation === this.generation && this.allowed() &&
      context.controlEpoch === this.options.session.getSession().controlEpoch &&
      context.workspaceVersion === this.options.workspace.workspaceVersion;
  }

  private async applyDecision(decision: CoachDecision, context: CoachContext, pending: Pending, signal: AbortSignal): Promise<void> {
    switch (decision.kind) {
      case 'SILENT': return;
      case 'REPLY':
        this.options.emit('CHAT_REPLY', { replyTo: pending.message?.messageId ?? null, text: redactSecrets(decision.text, this.sensitive) });
        return;
      case 'HINT': {
        if (decision.path) {
          const document = context.documents.find(doc => doc.path === decision.path);
          if (!document) throw new Error('STALE_HINT');
          const source = this.options.workspace.getDocument(decision.path);
          if (document.version !== decision.documentVersion || source.version !== decision.documentVersion) throw new Error('STALE_HINT');
          // A redacted view is not a coordinate system for the original document.
          if (document.content !== source.content) throw new Error('UNMAPPED_HINT');
          if (decision.range) applyTextEdit(document.content, { range: decision.range, textBlock: 'x' });
        }
        const evidence = new Set([...context.messages.map(message => message.messageId), ...(context.lastRun ? [context.lastRun.runId] : [])]);
        if (decision.evidenceIds.some(id => !evidence.has(id))) throw new Error('INVALID_EVIDENCE');
        const id = randomUUID();
        this.clearPointer();
        if (decision.showPointer && decision.path !== null && decision.documentVersion !== null) {
          this.pointer = { id, path: decision.path, version: decision.documentVersion };
          this.options.emit('COACH_POINTER', { id, path: decision.path, documentVersion: decision.documentVersion, range: decision.range, clear: false });
        }
        const { kind: _, showPointer: __, ...hint } = decision;
        this.options.emit('COACH_HINT_BUBBLE', { id, ...hint, text: redactSecrets(hint.text, this.sensitive) });
        this.remember(decision.kind, decision.path);
        return;
      }
      case 'PROPOSE':
        if (decision.paths.some(path => !isContextPathAllowed(path))) throw new Error('PROPOSAL_PATH_DENIED');
        this.options.onProposal({ ...decision, questionText: redactSecrets(decision.questionText, this.sensitive) });
        this.remember(decision.kind, null);
        return;
      case 'MUTE': {
        const message = pending.message;
        // File text/provider cannot authorize mute. Only the current explicit chat request.
        if (pending.reason !== 'CHAT' || message?.author !== 'STUDENT' || message.messageId !== decision.sourceUserMessageId ||
          !/^\s*(?:prosz[ęe][, ]+)?(?:nie\s+przerywaj|wycisz|zrób\s+przerwę|przerwa|pauza|mute|stop\s+interrupting|take\s+a\s+break)(?![\p{L}\p{N}\p{M}_])/iu.test(message.text)) throw new Error('MUTE_NOT_AUTHORIZED');
        this.options.session.mute(decision.durationSeconds);
        return;
      }
      case 'EDIT': return this.executePlan(decision, context, signal);
    }
  }

  private async executePlan(plan: Extract<CoachDecision, { kind: 'EDIT' }>, context: CoachContext, signal: AbortSignal): Promise<void> {
    const { workspace, session, gate, emit } = this.options;
    if (!isCoachWriteAllowed(plan.path, workspace.settings) || !context.documents.some(doc => doc.path === plan.path) ||
      plan.workspaceVersion !== workspace.workspaceVersion || plan.workspaceVersion !== context.workspaceVersion) throw new Error('STALE_OR_FORBIDDEN_PLAN');
    let document = workspace.getDocument(plan.path);
    const sentDocument = context.documents.find(doc => doc.path === plan.path)!;
    if (document.version !== plan.documentVersion || sentDocument.version !== plan.documentVersion || document.readOnly) throw new Error('STALE_DOCUMENT');
    // Reject the entire plan before CONTROL_PREPARE; never apply masked coordinates to raw bytes.
    if (sentDocument.content !== document.content) throw new Error('UNMAPPED_EDIT');
    // Check all sequential coordinates before taking control, but commit one step only after each ACK.
    let preview = document.content;
    for (const step of plan.steps) {
      if (redactSecrets(step.textBlock, this.sensitive) !== step.textBlock) throw new Error('SECRET_IN_EDIT');
      preview = applyTextEdit(preview, step);
    }
    const requestId = randomUUID();
    const ready = this.waitReady(requestId, plan.workspaceVersion, signal);
    emit('CONTROL_PREPARE', { requestId, purpose: redactSecrets(plan.purpose, this.sensitive), path: plan.path, basedOnWorkspaceVersion: plan.workspaceVersion });
    if (!await ready || signal.aborted || !this.allowed() || workspace.workspaceVersion !== plan.workspaceVersion ||
      session.getSession().controlEpoch !== context.controlEpoch || workspace.getDocument(plan.path).version !== plan.documentVersion) return;
    const id = randomUUID();
    const epoch = session.acquireCoach(id);
    this.owned = { id, epoch };
    const lease = session.leaseClientId;
    if (!lease) throw new Error('LEASE_MISSING');
    const deadline = Date.now() + 10000;
    const cutoff = setTimeout(() => this.abort(), 10000);
    try {
      for (const step of plan.steps) {
        signal.throwIfAborted();
        const state = session.getSession();
        if (Date.now() >= deadline || state.controlEpoch !== epoch || state.interventionId !== id ||
          state.writeOwner !== 'COACH' || state.presence !== 'FOCUSED' || !workspace.settings.aiConsent ||
          session.leaseClientId !== lease || !isCoachWriteAllowed(plan.path, workspace.settings)) throw new Error('CONTROL_REVOKED');
        const content = applyTextEdit(document.content, step);
        const baseVersion = document.version;
        // Synchronous auth+disk validation+atomic rename: no await before commit.
        document = gate.write({ clientId: lease, sessionId: state.sessionId, controlEpoch: epoch, actor: 'COACH',
          path: plan.path, baseVersion, content });
        const stepId = randomUUID();
        const rendered = this.waitRendered(stepId, id, document.version, Math.min(2000, Math.max(1, deadline - Date.now())), signal);
        emit('COACH_STEP_EDIT', { stepId, interventionId: id, controlEpoch: epoch, path: plan.path,
          baseVersion, version: document.version, workspaceVersion: workspace.workspaceVersion,
          range: step.range, textBlock: step.textBlock.replace(/\r\n?/g, '\n'), contentHash: document.contentHash });
        if (!await rendered) return;
      }
      this.remember('EDIT', plan.path);
    } finally {
      clearTimeout(cutoff);
      this.releaseOwned();
    }
  }

  private waitReady(requestId: string, version: number, signal: AbortSignal): Promise<boolean> {
    return new Promise(resolve => {
      const finish = (ok: boolean) => {
        clearTimeout(timer); signal.removeEventListener('abort', aborted);
        if (this.readyWaiter?.requestId === requestId) this.readyWaiter = null;
        resolve(ok);
      };
      const aborted = () => finish(false);
      const timer = setTimeout(() => { this.error('COACH_READY_TIMEOUT', 'Brak potwierdzenia CONTROL_READY w 1 s; anulowano pokaz.'); finish(false); }, 1000);
      this.readyWaiter = { requestId, accept: payload => finish(payload.ready && payload.workspaceVersion === version) };
      signal.addEventListener('abort', aborted, { once: true });
      if (signal.aborted) finish(false);
    });
  }
  private waitRendered(stepId: string, interventionId: string, version: number, timeout: number, signal: AbortSignal): Promise<boolean> {
    return new Promise(resolve => {
      const finish = (ok: boolean) => {
        clearTimeout(timer); signal.removeEventListener('abort', aborted);
        if (this.renderedWaiter?.stepId === stepId) this.renderedWaiter = null;
        resolve(ok);
      };
      const aborted = () => finish(false);
      const timer = setTimeout(() => { this.error('COACH_RENDER_TIMEOUT', 'Brak potwierdzenia STEP_RENDERED w wymaganym czasie; przerwano pokaz.'); finish(false); }, timeout);
      this.renderedWaiter = { stepId, accept: payload => {
        if (payload.interventionId === interventionId && payload.documentVersion === version) finish(true);
      } };
      signal.addEventListener('abort', aborted, { once: true });
      if (signal.aborted) finish(false);
    });
  }

  controlReady(payload: Ready): void {
    if (payload.requestId === this.readyWaiter?.requestId) this.readyWaiter.accept(payload);
  }
  stepRendered(payload: Rendered): void {
    if (payload.stepId === this.renderedWaiter?.stepId) this.renderedWaiter.accept(payload);
  }

  private remember(kind: string, path: string | null): void {
    this.interventions.push({ kind, path, workspaceVersion: this.options.workspace.workspaceVersion });
    if (this.interventions.length > 20) this.interventions.shift();
    // Own response/edit is not a new fact, nor a reason to reanalyze the resultant context.
    if (this.options.workspace.settings.aiConsent) {
      this.fingerprints.add(contextFingerprint(buildContext(this.options.workspace, this.options.session.getSession(),
        this.messages, this.lastRun, this.interventions, this.sensitive)));
    }
  }
  private clearPointer(): void {
    if (!this.pointer) return;
    const pointer = this.pointer; this.pointer = null;
    this.options.emit('COACH_POINTER', { id: pointer.id, path: pointer.path, documentVersion: pointer.version, range: null, clear: true });
  }
  private error(code: string, message: string): void {
    this.options.emit('ERROR', { code, message, retryable: false, requestId: null, currentVersion: null });
  }
  private publishControl(): void {
    if (this.closed) return;
    const state = this.options.session.getSession();
    this.options.emit('CONTROL_STATE', { writeOwner: state.writeOwner, controlEpoch: state.controlEpoch, coachMode: state.coachMode,
      cooldownAfterVeto: state.cooldownAfterVeto, interventionId: state.interventionId, purpose: null });
  }
  private releaseOwned(): void {
    if (!this.owned) return;
    const owned = this.owned; this.owned = null;
    const state = this.options.session.getSession();
    if (state.interventionId === owned.id && state.controlEpoch === owned.epoch && state.writeOwner === 'COACH') this.options.session.releaseCoach();
  }
  private readonly onVeto = () => { this.abort(); };
  private readonly onState = () => {
    if (this.closed) return;
    const state = this.options.session.getSession();
    if (!this.options.workspace.settings.aiConsent || state.lifecycle !== 'RUNNING' || state.presence !== 'FOCUSED' ||
        state.cooldownAfterVeto || state.timer.manualPaused || state.coachMode === 'MUTED_MANUAL') this.abort();
    else if (this.pending && !this.active) queueMicrotask(() => void this.pump());
  };
  private readonly onExternal = () => { this.clearPointer(); this.abort(); };
  private readonly onChanged = (event: { path: string; actor: string }) => {
    if (this.pointer?.path === event.path) this.clearPointer();
    if (event.actor !== 'COACH') {
      // Refresh code, not chat authorization. Full invalidation paths still discard both.
      const chat = this.pending?.reason === 'CHAT' ? this.pending :
        this.activeRequest?.reason === 'CHAT' ? this.activeRequest : null;
      this.abort();
      if (chat && this.allowed()) this.pending = chat;
      this.trigger('EDIT');
    }
  };

  abort(): void {
    this.generation++;
    this.pending = null;
    this.activeRequest = null;
    if (this.editTimer) { clearTimeout(this.editTimer); this.editTimer = null; }
    this.controller?.abort();
    if (this.analysisTimer) { clearTimeout(this.analysisTimer); this.analysisTimer = null; }
    this.releaseOwned();
    this.clearPointer();
    // No waiting for AI on veto path. SessionController has already invalidated epoch.
    if (!this.closed && this.options.session.getSession().aiStatus === 'THINKING') this.setStatus(this.options.workspace.settings.aiConsent ? 'READY' : 'OFF');
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.abort();
    this.options.session.off('veto', this.onVeto);
    this.options.session.off('invalidate', this.onVeto);
    this.options.session.off('state', this.onState);
    this.options.workspace.off('changed', this.onChanged);
    this.options.workspace.off('external', this.onExternal);
  }
}
