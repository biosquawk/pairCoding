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
  ProposalType,
  TrainingScenario,
  WindowPresence,
} from '../types/paircoach';
import { simulator } from './simulator';

export type StateListener = (state: ReturnType<typeof simulator.getFullState>) => void;
export type CoachStepListener = (step: CoachEditStep) => void;

export class PairCoachClient {
  private static instance: PairCoachClient;

  private constructor() {
    // Phase 1 uses the authoritative simulator
  }

  public static getInstance(): PairCoachClient {
    if (!PairCoachClient.instance) {
      PairCoachClient.instance = new PairCoachClient();
    }
    return PairCoachClient.instance;
  }

  // Subscriptions
  public onStateChanged(cb: StateListener): () => void {
    return simulator.subscribe('STATE_CHANGED', () => {
      cb(simulator.getFullState());
    });
  }

  public onCoachStep(cb: CoachStepListener): () => void {
    return simulator.subscribe('COACH_STEP', (_, step) => {
      cb(step);
    });
  }

  public onVetoExecuted(cb: (payload: any) => void): () => void {
    return simulator.subscribe('VETO_EXECUTED', (_, payload) => {
      cb(payload);
    });
  }

  public onFileUpdated(cb: (file: ProjectFile) => void): () => void {
    return simulator.subscribe('FILE_UPDATED', (_, file) => {
      cb(file);
    });
  }

  // Getters
  public getState() {
    return simulator.getFullState();
  }

  // Scenario loading
  public loadScenario(scenario: TrainingScenario) {
    simulator.loadScenario(scenario);
  }

  // File operations
  public selectFile(path: string) {
    simulator.setActivePath(path);
  }

  public saveFileContent(path: string, content: string) {
    simulator.updateFileContent(path, content, true);
  }

  public createFile(path: string, content = '') {
    simulator.createFile(path, content);
  }

  public renameFile(oldPath: string, newPath: string) {
    simulator.renameFile(oldPath, newPath);
  }

  public deleteFile(path: string) {
    simulator.deleteFile(path);
  }

  // VETO
  public triggerVeto(source: 'KEY_DOUBLE_ESC' | 'EMERGENCY_BUTTON' | 'TAB_SWITCH' = 'KEY_DOUBLE_ESC') {
    simulator.triggerVeto(source);
  }

  // Timer controls
  public startTimer() {
    simulator.startTimer();
  }

  public pauseTimer() {
    simulator.pauseTimer();
  }

  public resumeTimer() {
    simulator.resumeTimer();
  }

  public setPauseOnHidden(enabled: boolean) {
    simulator.setPauseOnHidden(enabled);
  }

  // Presence
  public sendWindowState(presence: WindowPresence) {
    simulator.setWindowPresence(presence);
  }

  // Chat
  public sendChatMessage(message: string) {
    simulator.addChatMessage('STUDENT', message);
  }

  // Proposals
  public respondToProposal(proposalId: string, accept: boolean) {
    simulator.answerProposal(proposalId, accept);
  }

  // Coach hint bubble & pointer
  public dismissHintBubble() {
    simulator.dismissHintBubble();
  }

  public updateBubblePos(x: number, y: number) {
    simulator.updateBubblePosition(x, y);
  }

  public clearCoachPointer() {
    simulator.clearCoachPointer();
  }

  // Execution
  public runMain() {
    simulator.runProgram(false);
  }

  public runTests() {
    simulator.runProgram(true);
  }

  public stopExecution() {
    simulator.stopExecution();
  }

  // Finish & Report
  public finishSession(reason: EndReason, simulateFailure = false) {
    simulator.finishExercise(reason, simulateFailure);
  }

  public retryReport() {
    simulator.retryReport();
  }

  // Dev simulator triggers
  public devStartCoachDemo() {
    simulator.startCoachDemonstration();
  }

  public devShowBubble(severity: HintBubbleSeverity, text: string, line: number) {
    simulator.showCoachHintBubble(line, text, severity);
  }

  public devShowPointer(startLine: number, endLine: number) {
    simulator.showCoachPointer(startLine, endLine);
  }

  public devTriggerProposal(type: ProposalType) {
    simulator.triggerProposal(type);
  }

  public devSimulateExternalSync() {
    simulator.simulateExternalFileSync();
  }

  public devToggleOffline() {
    simulator.toggleOffline();
  }
}

export const client = PairCoachClient.getInstance();
