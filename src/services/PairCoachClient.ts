/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  ActionProposal,
  CoachEditStep,
  EndReason,
  HintBubbleSeverity,
  ProjectFile,
  ProjectSettings,
  ProposalType,
  TrainingScenario,
  WindowPresence,
} from '../types/paircoach';
import { simulator } from './simulator';
import { LiveBackend, type LiveOptions } from './LiveBackend';
import type { ClientState, TransportMode, UpdatedFile } from './liveTypes';

export type StateListener = (state: ClientState) => void;
export type CoachStepListener = (step: CoachEditStep) => void;

export class PairCoachClient {
  private static instance: PairCoachClient;
  private authToken: string | null = null;

  private live: LiveBackend;
  public readonly transportMode: TransportMode;

  public constructor(options: LiveOptions & { mode?: TransportMode } = {}) {
    this.transportMode = options.mode ?? (typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('mock') === '1' ? 'MOCK_SIMULATOR' : 'LIVE_BACKEND');
    // Contract 3.0.0: Read and clean token from window.location.hash (#token=...)
    if (typeof window !== 'undefined' && window.location.hash) {
      const hash = window.location.hash.substring(1);
      const params = new URLSearchParams(hash);
      const token = params.get('token');
      if (token) {
        this.authToken = token;
        // Clean URL hash without reloading
        window.history.replaceState(null, '', window.location.pathname + window.location.search);
      }
    }
    let storage = options.storage;
    if (!storage && typeof window !== 'undefined') {
      try { storage = window.localStorage; } catch { /* Reported below, editor must remain usable. */ }
    }
    const localOrigin = typeof window !== 'undefined' && ['127.0.0.1', 'localhost'].includes(window.location.hostname)
      && window.location.protocol === 'http:' && window.location.port !== '3000' ? window.location.origin : undefined;
    this.live = new LiveBackend({ ...options, baseUrl: options.baseUrl ?? localOrigin, storage, token: options.token ?? this.authToken });
    if (this.transportMode === 'LIVE_BACKEND' && typeof window !== 'undefined') queueMicrotask(() => void this.live.connect());
  }

  public static getInstance(): PairCoachClient {
    if (!PairCoachClient.instance) {
      PairCoachClient.instance = new PairCoachClient();
    }
    return PairCoachClient.instance;
  }

  public getAuthToken(): string | null {
    return this.transportMode === 'LIVE_BACKEND' ? this.live.getAuthToken() : this.authToken;
  }

  // Subscriptions
  public onStateChanged(cb: StateListener): () => void {
    if (this.transportMode === 'LIVE_BACKEND') return this.live.subscribe('state', cb);
    return simulator.subscribe('STATE_CHANGED', () => {
      cb(this.getState());
    });
  }

  public onCoachStep(cb: CoachStepListener): () => void {
    if (this.transportMode === 'LIVE_BACKEND') return this.live.subscribe('step', cb);
    return simulator.subscribe('COACH_STEP', (_, step) => {
      cb(step);
    });
  }

  public onVetoExecuted(cb: (payload: any) => void): () => void {
    if (this.transportMode === 'LIVE_BACKEND') return this.live.subscribe('veto', cb);
    return simulator.subscribe('VETO_EXECUTED', (_, payload) => {
      cb(payload);
    });
  }

  public onFileUpdated(cb: (file: UpdatedFile) => void): () => void {
    if (this.transportMode === 'LIVE_BACKEND') return this.live.subscribe('file', cb);
    return simulator.subscribe('FILE_UPDATED', (_, file) => {
      cb(file);
    });
  }

  // Getters
  public getState() {
    if (this.transportMode === 'LIVE_BACKEND') return this.live.getState();
    return { ...simulator.getFullState(), transportMode: this.transportMode, connectionError: null, storageError: null, pendingPaths: [] } satisfies ClientState;
  }

  // Scenario loading
  public loadScenario(scenario: TrainingScenario) {
    if (this.transportMode === 'LIVE_BACKEND') return;
    simulator.loadScenario(scenario);
  }

  // File operations
  public selectFile(path: string) {
    if (this.transportMode === 'LIVE_BACKEND') return this.live.selectFile(path);
    simulator.setActivePath(path);
  }

  public saveFileContent(path: string, content: string) {
    if (this.transportMode === 'LIVE_BACKEND') return this.live.saveFileContent(path, content);
    simulator.updateFileContent(path, content, true);
  }

  public createFile(path: string, content = '') {
    if (this.transportMode === 'LIVE_BACKEND') return this.live.mutateFile('CREATE', path, null, content);
    simulator.createFile(path, content);
  }

  public renameFile(oldPath: string, newPath: string) {
    if (this.transportMode === 'LIVE_BACKEND') return this.live.mutateFile('RENAME', oldPath, newPath);
    simulator.renameFile(oldPath, newPath);
  }

  public deleteFile(path: string) {
    if (this.transportMode === 'LIVE_BACKEND') return this.live.mutateFile('DELETE', path);
    simulator.deleteFile(path);
  }

  // VETO
  public triggerVeto(source: 'KEY_DOUBLE_ESC' | 'EMERGENCY_BUTTON' | 'TAB_SWITCH' = 'KEY_DOUBLE_ESC') {
    if (this.transportMode === 'LIVE_BACKEND') return this.live.triggerVeto();
    simulator.triggerVeto(source);
  }

  // Timer controls
  public startTimer() {
    if (this.transportMode === 'LIVE_BACKEND') return this.live.startTimer();
    simulator.startTimer();
  }

  public pauseTimer() {
    if (this.transportMode === 'LIVE_BACKEND') return this.live.pauseTimer();
    simulator.pauseTimer();
  }

  public resumeTimer() {
    if (this.transportMode === 'LIVE_BACKEND') return this.live.resumeTimer();
    simulator.resumeTimer();
  }

  public setPauseOnHidden(enabled: boolean) {
    if (this.transportMode === 'LIVE_BACKEND') return this.live.setPauseOnHidden(enabled);
    simulator.setPauseOnHidden(enabled);
  }

  // Presence
  public sendWindowState(presence: WindowPresence) {
    if (this.transportMode === 'LIVE_BACKEND') return this.live.sendWindowState(presence);
    simulator.setWindowPresence(presence);
  }

  // Chat
  public sendChatMessage(message: string) {
    if (this.transportMode === 'LIVE_BACKEND') return this.live.sendChatMessage(message);
    simulator.addChatMessage('STUDENT', message);
  }

  // Proposals
  public respondToProposal(proposalId: string, accept: boolean) {
    if (this.transportMode === 'LIVE_BACKEND') return this.live.respondToProposal(proposalId, accept);
    simulator.answerProposal(proposalId, accept);
  }

  // Coach hint bubble & pointer
  public dismissHintBubble() {
    if (this.transportMode === 'LIVE_BACKEND') return this.live.dismissHintBubble();
    simulator.dismissHintBubble();
  }

  public updateBubblePos(x: number, y: number) {
    if (this.transportMode === 'LIVE_BACKEND') return this.live.updateBubblePos(x, y);
    simulator.updateBubblePosition(x, y);
  }

  public clearCoachPointer() {
    if (this.transportMode === 'LIVE_BACKEND') return this.live.clearCoachPointer();
    simulator.clearCoachPointer();
  }

  // Execution
  public runMain() {
    if (this.transportMode === 'LIVE_BACKEND') return this.live.run(false);
    simulator.runProgram(false);
  }

  public runTests() {
    if (this.transportMode === 'LIVE_BACKEND') return this.live.run(true);
    simulator.runProgram(true);
  }

  public stopExecution() {
    if (this.transportMode === 'LIVE_BACKEND') return this.live.stopExecution();
    simulator.stopExecution();
  }

  // Finish & Report
  public finishSession(reason: EndReason, simulateFailure = false) {
    if (this.transportMode === 'LIVE_BACKEND') return this.live.finishSession(reason);
    simulator.finishExercise(reason, simulateFailure);
  }

  public retryReport() {
    if (this.transportMode === 'LIVE_BACKEND') return this.live.retryReport();
    simulator.retryReport();
  }

  public resolveConflict(choice: 'KEEP_LOCAL' | 'LOAD_DISK') {
    if (this.transportMode === 'LIVE_BACKEND') return this.live.resolveConflict(choice);
    simulator.resolveConflict(choice);
  }

  public updateProjectSettings(settings: ProjectSettings) {
    if (this.transportMode === 'LIVE_BACKEND') return this.live.updateProjectSettings(settings);
    simulator.updateProjectSettings(settings);
  }

  public getSnapshots() {
    if (this.transportMode === 'LIVE_BACKEND') return this.live.getState().snapshots;
    return simulator.getSnapshots();
  }

  public restoreSnapshotById(snapshotId: string) {
    if (this.transportMode === 'LIVE_BACKEND') return this.live.restoreSnapshotById(snapshotId);
    simulator.restoreSnapshotById(snapshotId);
  }

  public connect() { return this.live.connect(); }
  public reconnect() { return this.live.reconnect(); }
  public close() { this.live.close(); }
  public stepRendered(step: CoachEditStep, content: string) {
    if (this.transportMode === 'LIVE_BACKEND') this.live.stepRendered(step, content);
    else simulator.updateFileContent(step.path, content, false);
  }
  public canApplyStep(step: CoachEditStep) {
    const state = this.getState();
    return state.writeOwner === 'COACH' && !state.isOffline && (step.controlEpoch === undefined || state.controlEpoch === step.controlEpoch);
  }
  public setTransportMode(mode: TransportMode) {
    if (typeof window === 'undefined' || mode === this.transportMode) return;
    const url = new URL(window.location.href);
    if (mode === 'MOCK_SIMULATOR') url.searchParams.set('mock', '1'); else url.searchParams.delete('mock');
    this.live.close(); window.location.assign(url.href);
  }

  // Dev simulator triggers
  public devStartCoachDemo() {
    if (this.transportMode !== 'MOCK_SIMULATOR') return;
    simulator.startCoachDemonstration();
  }

  public devShowBubble(severity: HintBubbleSeverity, text: string, line: number) {
    if (this.transportMode !== 'MOCK_SIMULATOR') return;
    simulator.showCoachHintBubble(line, text, severity);
  }

  public devShowPointer(startLine: number, endLine: number) {
    if (this.transportMode !== 'MOCK_SIMULATOR') return;
    simulator.showCoachPointer(startLine, endLine);
  }

  public devTriggerProposal(type: ProposalType) {
    if (this.transportMode !== 'MOCK_SIMULATOR') return;
    simulator.triggerProposal(type);
  }

  public devSimulateExternalSync() {
    if (this.transportMode !== 'MOCK_SIMULATOR') return;
    simulator.simulateExternalFileSync();
  }

  public devToggleOffline() {
    if (this.transportMode !== 'MOCK_SIMULATOR') return;
    simulator.toggleOffline();
  }
}

export const client = PairCoachClient.getInstance();
