/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  ActionProposal,
  AiStatus,
  Capabilities,
  ChatEntry,
  CoachEditStep,
  CoachHintBubble,
  CoachMode,
  CoachPointer,
  ConsoleOutputEntry,
  EndReason,
  ExecutionRun,
  ExecutionStatus,
  HintBubbleSeverity,
  ProjectFile,
  ProjectSettings,
  ProposalType,
  SessionReport,
  SessionStatus,
  SnapshotItem,
  TaskMode,
  TestOutcome,
  TrainingScenario,
  WindowPresence,
  WriteOwner,
} from '../types/paircoach';
import { MOCK_SCENARIOS } from '../data/mockScenarios';

export type SimulatorEventCallback = (eventName: string, payload: any) => void;

export class MockBackendSimulator {
  private listeners: Map<string, Set<SimulatorEventCallback>> = new Map();

  // State
  private currentScenario: TrainingScenario;
  private files: Map<string, ProjectFile> = new Map();
  private activePath: string;
  private writeOwner: WriteOwner = 'STUDENT';
  private coachMode: CoachMode = 'ACTIVE_WATCHING';
  private aiStatus: AiStatus = 'READY';
  private sessionStatus: SessionStatus = 'STOPPED';
  private pauseOnHidden: boolean = true;
  private windowPresence: WindowPresence = 'FOCUSED';

  // Versioning and Control Epoch (Contract 3.0.0)
  private controlEpoch: number = 1;
  private workspaceVersion: number = 1;
  private vetoBaselineContent: Map<string, string> = new Map();
  private cooldownDebounceTimer: any = null;
  private fileConflict: { path: string; diskContent: string; localDraftContent: string } | null = null;
  private projectSettings: ProjectSettings;
  private snapshots: SnapshotItem[] = [];

  // Timer
  private startTime: number = 0;
  private elapsedMs: number = 0;
  private limitMs: number = 15 * 60 * 1000;
  private timerInterval: any = null;

  // Intervention & Steps
  private currentInterventionId: string | null = null;
  private isInterventionAborted: boolean = false;
  private coachInterventionsCount: number = 0;
  private userVetoCount: number = 0;
  private testRunsCount: number = 0;

  // Active Pointers and Bubbles
  private activePointer: CoachPointer | null = null;
  private activeHintBubble: CoachHintBubble | null = null;
  private activeProposal: ActionProposal | null = null;

  // Chat & Console
  private chatEntries: ChatEntry[] = [];
  private activeRun: ExecutionRun | null = null;
  private executionTimer: any = null;

  // Report
  private report: SessionReport | null = null;
  private isOffline: boolean = false;

  constructor() {
    this.currentScenario = MOCK_SCENARIOS[0];
    this.limitMs = this.currentScenario.defaultTimeLimitMs;
    this.activePath = 'src/solution.ts';
    this.projectSettings = {
      aiConsent: true,
      taskMode: this.currentScenario.taskMode,
      taskFilePath: this.currentScenario.taskFilePath,
      reviewNotesPath: this.currentScenario.reviewNotesPath,
      runProfiles: [
        { id: 'main', name: 'Run Main', command: 'node dist/index.js', isTest: false },
        { id: 'test', name: 'Run Tests', command: 'vitest run', isTest: true },
      ],
    };
    this.loadScenario(this.currentScenario);
  }

  public loadScenario(scenario: TrainingScenario) {
    this.currentScenario = scenario;
    this.limitMs = scenario.defaultTimeLimitMs;
    this.files.clear();
    for (const f of scenario.files) {
      this.files.set(f.path, { ...f });
    }

    // Pick reasonable active file
    const defaultActive = scenario.files.find((f) => f.path.endsWith('.ts') || f.path.endsWith('.py')) || scenario.files[0];
    this.activePath = defaultActive.path;

    this.writeOwner = 'STUDENT';
    this.coachMode = this.projectSettings.aiConsent ? 'ACTIVE_WATCHING' : 'UNAVAILABLE';
    this.aiStatus = this.projectSettings.aiConsent ? 'READY' : 'OFF';
    this.sessionStatus = 'STOPPED';
    this.elapsedMs = 0;
    this.controlEpoch = 1;
    this.workspaceVersion = 1;
    this.fileConflict = null;
    this.vetoBaselineContent.clear();
    this.snapshots = [
      {
        id: 'snap-initial',
        label: 'Stan początkowy zadania (Baseline)',
        timestamp: Date.now(),
        files: scenario.files.map((f) => ({ path: f.path, content: f.content })),
      },
    ];
    this.stopTimer();

    this.activePointer = null;
    this.activeHintBubble = null;
    this.activeProposal = null;
    this.report = null;

    this.chatEntries = [
      {
        id: `sys-${Date.now()}`,
        sender: 'SYSTEM',
        message: `Załadowano zadanie: "${scenario.title}". Trener AI jest w trybie czuwania. Jeśli trener przejmie pisanie, możesz w każdej chwili cofnąć jego działanie wciskając dwukrotnie Escape (2× Esc) lub klikając przycisk weta.`,
        timestamp: Date.now(),
      },
    ];

    this.emit('STATE_CHANGED', this.getFullState());
  }

  public subscribe(event: string, cb: SimulatorEventCallback) {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }
    this.listeners.get(event)!.add(cb);
    return () => {
      this.listeners.get(event)?.delete(cb);
    };
  }

  private emit(event: string, payload: any) {
    const list = this.listeners.get(event);
    if (list) {
      for (const cb of list) {
        cb(event, payload);
      }
    }
    const allList = this.listeners.get('*');
    if (allList) {
      for (const cb of allList) {
        cb(event, payload);
      }
    }
  }

  // State snapshot
  public getFullState() {
    return {
      scenario: this.currentScenario,
      files: Array.from(this.files.values()),
      activePath: this.activePath,
      writeOwner: this.isOffline ? 'SYNCING' : this.writeOwner,
      coachMode: this.coachMode,
      aiStatus: this.aiStatus,
      sessionStatus: this.sessionStatus,
      elapsedMs: this.elapsedMs,
      limitMs: this.limitMs,
      pauseOnHidden: this.pauseOnHidden,
      windowPresence: this.windowPresence,
      capabilities: this.currentScenario.capabilities,
      activePointer: this.activePointer,
      activeHintBubble: this.activeHintBubble,
      activeProposal: this.activeProposal,
      chatEntries: this.chatEntries,
      activeRun: this.activeRun,
      report: this.report,
      isOffline: this.isOffline,
      controlEpoch: this.controlEpoch,
      workspaceVersion: this.workspaceVersion,
      fileConflict: this.fileConflict,
      projectSettings: this.projectSettings,
      snapshots: this.snapshots,
      stats: {
        coachInterventionsCount: this.coachInterventionsCount,
        userVetoCount: this.userVetoCount,
        testRunsCount: this.testRunsCount,
      },
    };
  }

  // File system operations
  public getFile(path: string): ProjectFile | undefined {
    return this.files.get(path);
  }

  public setActivePath(path: string) {
    if (this.writeOwner === 'COACH') {
      // Switching tabs during coach demonstration acts as a VETO!
      this.triggerVeto('TAB_SWITCH');
    }
    this.activePath = path;
    // Clear pointer or bubble if path changes
    if (this.activePointer && this.activePointer.path !== path) {
      this.activePointer = null;
    }
    if (this.activeHintBubble && this.activeHintBubble.path !== path) {
      this.activeHintBubble = null;
    }
    this.emit('STATE_CHANGED', this.getFullState());
  }

  public updateFileContent(path: string, content: string, fromUser = true, isExternalOrSnapshot = false) {
    const file = this.files.get(path);
    if (!file) return;

    file.content = content;
    file.version += 1;
    this.workspaceVersion += 1;

    // Invalidate pointer or hint bubble if document version changed
    if (this.activePointer && this.activePointer.path === path) {
      this.activePointer = null;
    }
    if (this.activeHintBubble && this.activeHintBubble.path === path) {
      this.activeHintBubble = null;
    }

    if (fromUser) {
      // Rule 4: Do not immediately exit COOLDOWN_AFTER_VETO on first keystroke.
      // Compare non-whitespace content with baseline recorded at veto time,
      // and require a 2000 ms debounce pause before returning to ACTIVE_WATCHING.
      if (this.coachMode === 'COOLDOWN_AFTER_VETO') {
        const baseline = this.vetoBaselineContent.get(path) || '';
        const hasSubstantialEdit = content.replace(/\s+/g, '') !== baseline.replace(/\s+/g, '');

        if (hasSubstantialEdit) {
          if (this.cooldownDebounceTimer) {
            clearTimeout(this.cooldownDebounceTimer);
          }
          this.cooldownDebounceTimer = setTimeout(() => {
            if (this.coachMode === 'COOLDOWN_AFTER_VETO') {
              this.coachMode = 'ACTIVE_WATCHING';
              this.addChatMessage(
                'SYSTEM',
                '👁️ Trener AI powrócił do aktywnej obserwacji po Twojej samodzielnej zmianie kodu (2s pauzy).'
              );
              this.emit('STATE_CHANGED', this.getFullState());
            }
          }, 2000);
        }
      }
    }

    this.emit('FILE_UPDATED', { ...file, isExternalOrSnapshot });
    this.emit('STATE_CHANGED', this.getFullState());
  }

  public createFile(path: string, content = '') {
    if (this.files.has(path)) {
      throw new Error(`Plik o ścieżce ${path} już istnieje.`);
    }
    const newFile: ProjectFile = {
      path,
      kind: 'FILE',
      version: 1,
      content,
    };
    this.files.set(path, newFile);
    this.setActivePath(path);
    this.emit('STATE_CHANGED', this.getFullState());
  }

  public renameFile(oldPath: string, newPath: string) {
    const file = this.files.get(oldPath);
    if (!file) return;
    this.files.delete(oldPath);
    file.path = newPath;
    file.version += 1;
    this.files.set(newPath, file);
    if (this.activePath === oldPath) {
      this.activePath = newPath;
    }
    this.emit('STATE_CHANGED', this.getFullState());
  }

  public deleteFile(path: string) {
    if (path === this.currentScenario.taskFilePath || path === this.currentScenario.reviewNotesPath) {
      throw new Error('Nie można usunąć pliku systemowego zadania ani notatek.');
    }
    this.files.delete(path);
    if (this.activePath === path) {
      const remaining = Array.from(this.files.keys())[0] || '';
      this.activePath = remaining;
    }
    this.emit('STATE_CHANGED', this.getFullState());
  }

  // Timer Control
  public startTimer() {
    if (this.sessionStatus === 'RUNNING') return;
    this.sessionStatus = this.elapsedMs >= this.limitMs ? 'OVERTIME' : 'RUNNING';
    const lastTick = Date.now();

    if (this.timerInterval) clearInterval(this.timerInterval);
    this.timerInterval = setInterval(() => {
      if (this.sessionStatus === 'RUNNING' || this.sessionStatus === 'OVERTIME') {
        this.elapsedMs += 1000;
        if (this.elapsedMs >= this.limitMs && this.sessionStatus === 'RUNNING') {
          this.sessionStatus = 'OVERTIME';
          this.addChatMessage(
            'SYSTEM',
            '⏱️ Uwaga: Przekroczono zaplanowany limit czasu sesji! Możesz kontynuować pisanie kodu bez ograniczeń.'
          );
        }
        this.emit('TIMER_TICK', { elapsedMs: this.elapsedMs, limitMs: this.limitMs, status: this.sessionStatus });
        this.emit('STATE_CHANGED', this.getFullState());
      }
    }, 1000);

    this.emit('STATE_CHANGED', this.getFullState());
  }

  public pauseTimer() {
    if (this.sessionStatus !== 'RUNNING' && this.sessionStatus !== 'OVERTIME') return;
    this.sessionStatus = 'PAUSED';
    this.emit('STATE_CHANGED', this.getFullState());
  }

  public resumeTimer() {
    this.startTimer();
  }

  public stopTimer() {
    if (this.timerInterval) {
      clearInterval(this.timerInterval);
      this.timerInterval = null;
    }
    this.sessionStatus = 'STOPPED';
  }

  public setPauseOnHidden(value: boolean) {
    this.pauseOnHidden = value;
    this.emit('STATE_CHANGED', this.getFullState());
  }

  // Window presence
  public setWindowPresence(presence: WindowPresence) {
    this.windowPresence = presence;
    if (presence === 'HIDDEN') {
      if (this.pauseOnHidden && (this.sessionStatus === 'RUNNING' || this.sessionStatus === 'OVERTIME')) {
        this.pauseTimer();
      }
      if (this.coachMode === 'ACTIVE_WATCHING') {
        this.coachMode = 'MUTED_WINDOW_HIDDEN';
      }
    } else if (presence === 'FOCUSED') {
      if (this.coachMode === 'MUTED_WINDOW_HIDDEN') {
        this.coachMode = 'ACTIVE_WATCHING';
      }
    }
    this.emit('STATE_CHANGED', this.getFullState());
  }

  // Chat
  public addChatMessage(sender: 'STUDENT' | 'COACH' | 'SYSTEM', message: string, proposal?: ActionProposal) {
    const entry: ChatEntry = {
      id: `chat-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
      sender,
      message,
      timestamp: Date.now(),
      proposal,
    };
    this.chatEntries.push(entry);
    if (sender === 'STUDENT' && this.coachMode === 'COOLDOWN_AFTER_VETO') {
      this.coachMode = 'ACTIVE_WATCHING';
    }
    this.emit('CHAT_UPDATED', this.chatEntries);
    this.emit('STATE_CHANGED', this.getFullState());
  }

  // Coach Intervention: live typing demonstration
  public async startCoachDemonstration(stepsOverride?: CoachEditStep[]) {
    if (this.writeOwner === 'COACH') return;

    if (!this.projectSettings.aiConsent) {
      this.addChatMessage('SYSTEM', 'Pokaz trenera jest niedostępny: zgoda AI (aiConsent) jest wyłączona w ustawieniach projektu.');
      return;
    }

    // DEC-004 & Requirement 3: Automatic file selection before coach demo
    if (this.currentScenario.taskMode === 'CODE_REVIEW') {
      const reviewPath = this.currentScenario.reviewNotesPath || 'review.md';
      if (this.activePath !== reviewPath) {
        this.setActivePath(reviewPath);
      }
    } else {
      const isTaskOrTest =
        this.activePath === this.currentScenario.taskFilePath ||
        this.activePath.includes('test') ||
        this.activePath.includes('.test.') ||
        this.activePath.startsWith('test_');
      if (isTaskOrTest) {
        const mainImpl =
          this.currentScenario.files.find(
            (f) =>
              (f.path.endsWith('.ts') || f.path.endsWith('.py') || f.path.endsWith('.js')) &&
              !f.path.includes('test') &&
              f.path !== this.currentScenario.taskFilePath
          ) ||
          this.currentScenario.files.find(
            (f) => f.path !== this.currentScenario.taskFilePath && f.path !== this.currentScenario.reviewNotesPath
          );
        if (mainImpl && this.activePath !== mainImpl.path) {
          this.setActivePath(mainImpl.path);
        }
      }
    }

    const interventionId = `interv-${Date.now()}`;
    this.currentInterventionId = interventionId;
    this.isInterventionAborted = false;
    this.coachInterventionsCount += 1;

    // Record automatic recovery snapshot before coach intervention
    this.snapshots.unshift({
      id: `snap-${Date.now()}`,
      label: `Przed pokazem trenera (${new Date().toLocaleTimeString()})`,
      timestamp: Date.now(),
      files: Array.from(this.files.values()).map((f) => ({ path: f.path, content: f.content })),
    });

    this.writeOwner = 'COACH';
    this.coachMode = 'INTERVENING';
    this.aiStatus = 'THINKING';

    this.addChatMessage(
      'COACH',
      this.currentScenario.taskMode === 'CODE_REVIEW'
        ? '🤖 Przejmuję klawiaturę w review.md, aby pokazać Ci przykładową profesjonalną uwagę z przeglądu kodu. Wciśnij 2× Esc lub kliknij przycisk na pasku, jeśli chcesz mi przerwać!'
        : '🤖 Przejmuję klawiaturę, aby pokazać Ci zoptymalizowaną konstrukcję w kodzie. Wciśnij 2× Esc lub kliknij przycisk na pasku, jeśli chcesz mi przerwać!'
    );

    this.emit('COACH_DEMO_STARTED', { interventionId, path: this.activePath, controlEpoch: this.controlEpoch });
    this.emit('STATE_CHANGED', this.getFullState());

    // Prepare steps depending on active file and scenario
    let steps: CoachEditStep[] = [];
    if (stepsOverride && stepsOverride.length > 0) {
      steps = stepsOverride;
    } else if (this.currentScenario.taskMode === 'CODE_REVIEW') {
      // In CODE_REVIEW, coach notes are added strictly to reviewNotesPath (review.md)
      steps = [
        {
          path: this.activePath,
          interventionId,
          controlEpoch: this.controlEpoch,
          stepIndex: 1,
          totalSteps: 2,
          range: { startLine: 6, startColumn: 1, endLine: 7, endColumn: 1 },
          text: `- [x] [KRYTYCZNY] services/PaymentProcessor.ts:18 - Dane karty (CVV i numer karty) logowane jawnym tekstem. Krytyczne naruszenie PCI-DSS §3.2.\n`,
          explanation: 'Krok 1/2: Wskazanie wycieku danych karty płatniczej do pliku audytu',
          delayMs: 1400,
        },
        {
          path: this.activePath,
          interventionId,
          controlEpoch: this.controlEpoch,
          stepIndex: 2,
          totalSteps: 2,
          range: { startLine: 10, startColumn: 1, endLine: 11, endColumn: 1 },
          text: `- [x] [WYSOKI] services/PaymentProcessor.ts:10 - Brak sprawdzania klucza idempotencji transakcji (nagłówek Idempotency-Key). Ryzyko wielokrotnego obciążenia.\n`,
          explanation: 'Krok 2/2: Wskazanie podatności na podwójne obciążenie płatności',
          delayMs: 1600,
        },
      ];
    } else if (this.activePath.endsWith('solution.ts')) {
      steps = [
        {
          path: this.activePath,
          interventionId,
          controlEpoch: this.controlEpoch,
          stepIndex: 1,
          totalSteps: 3,
          range: { startLine: 7, startColumn: 1, endLine: 16, endColumn: 1 },
          text: `  // Trener AI: Utwórzmy mapę dopasowań O(N) zamiast podwójnej pętli O(N^2)
  const map = new Map<number, number>();
`,
          explanation: 'Krok 1/3: Inicjalizacja tablicy asocjacyjnej dla liczb i ich indeksów',
          delayMs: 1400,
        },
        {
          path: this.activePath,
          interventionId,
          controlEpoch: this.controlEpoch,
          stepIndex: 2,
          totalSteps: 3,
          range: { startLine: 9, startColumn: 1, endLine: 9, endColumn: 1 },
          text: `  for (let i = 0; i < nums.length; i++) {
    const complement = target - nums[i];
    if (map.has(complement)) {
      return [map.get(complement)!, i];
    }
    map.set(nums[i], i);
  }
`,
          explanation: 'Krok 2/3: Jedno przejście po tablicy — sprawdzanie czy różnica istnieje w mapie',
          delayMs: 1600,
        },
        {
          path: this.activePath,
          interventionId,
          controlEpoch: this.controlEpoch,
          stepIndex: 3,
          totalSteps: 3,
          range: { startLine: 17, startColumn: 1, endLine: 17, endColumn: 1 },
          text: `  throw new Error("Brak pary spełniającej warunek targetu");\n`,
          explanation: 'Krok 3/3: Zwrócenie błędu w przypadku braku rozwiązania',
          delayMs: 1200,
        },
      ];
    } else if (this.activePath.endsWith('.py')) {
      steps = [
        {
          path: this.activePath,
          interventionId,
          controlEpoch: this.controlEpoch,
          stepIndex: 1,
          totalSteps: 2,
          range: { startLine: 4, startColumn: 1, endLine: 6, endColumn: 1 },
          text: `        # Trener AI: Zastosujmy OrderedDict dla operacji O(1)
        from collections import OrderedDict
        self.cache = OrderedDict()
`,
          explanation: 'Krok 1/2: Zastosowanie OrderedDict w Pythonie',
          delayMs: 1400,
        },
        {
          path: this.activePath,
          interventionId,
          controlEpoch: this.controlEpoch,
          stepIndex: 2,
          totalSteps: 2,
          range: { startLine: 8, startColumn: 1, endLine: 11, endColumn: 1 },
          text: `    def get(self, key: int) -> int:
        if key in self.cache:
            self.cache.move_to_end(key)
            return self.cache[key]
        return -1
`,
          explanation: 'Krok 2/2: Przeniesienie elementu na koniec jako ostatnio używanego',
          delayMs: 1600,
        },
      ];
    } else {
      steps = [
        {
          path: this.activePath,
          interventionId,
          controlEpoch: this.controlEpoch,
          stepIndex: 1,
          totalSteps: 2,
          range: { startLine: 1, startColumn: 1, endLine: 1, endColumn: 1 },
          text: `// [Komentarz trenera: Pamiętaj o obsłudze sytuacji brzegowych!]\n`,
          explanation: 'Wskazówka trenera dodana na początku pliku',
          delayMs: 1200,
        },
      ];
    }

    // Apply steps sequentially with delay
    for (const step of steps) {
      step.controlEpoch = this.controlEpoch;

      if (this.isInterventionAborted || this.currentInterventionId !== interventionId) {
        break;
      }

      await new Promise((resolve) => setTimeout(resolve, step.delayMs || 1200));

      if (this.isInterventionAborted || this.currentInterventionId !== interventionId) {
        break;
      }

      // Emit step to client
      this.emit('COACH_STEP', step);
    }

    // Finished or aborted
    if (!this.isInterventionAborted && this.currentInterventionId === interventionId) {
      this.writeOwner = 'STUDENT';
      this.coachMode = this.projectSettings.aiConsent ? 'ACTIVE_WATCHING' : 'UNAVAILABLE';
      this.aiStatus = this.projectSettings.aiConsent ? 'READY' : 'OFF';
      this.currentInterventionId = null;
      this.addChatMessage('COACH', '🏁 Zakończyłem pokaz. Oddaję Ci kontrolę nad edytorem. Sprawdź testy!');
      this.emit('COACH_DEMO_FINISHED', { interventionId });
      this.emit('STATE_CHANGED', this.getFullState());
    }
  }

  // VETO Action (< 100ms response)
  public triggerVeto(source: 'KEY_DOUBLE_ESC' | 'EMERGENCY_BUTTON' | 'TAB_SWITCH' = 'KEY_DOUBLE_ESC') {
    if (this.writeOwner !== 'COACH' && this.coachMode !== 'INTERVENING') {
      // User pressed 2x Esc even if coach wasn't typing
      return;
    }

    const oldEpoch = this.controlEpoch;
    this.controlEpoch += 1;
    this.isInterventionAborted = true;
    this.userVetoCount += 1;
    this.currentInterventionId = null;

    // Transition immediately: write owner restored to student, coach enters cooldown
    this.writeOwner = 'STUDENT';
    this.coachMode = 'COOLDOWN_AFTER_VETO';
    this.aiStatus = this.projectSettings.aiConsent ? 'READY' : 'OFF';

    // Store veto baseline content for active file
    const activeFile = this.files.get(this.activePath);
    if (activeFile) {
      this.vetoBaselineContent.set(this.activePath, activeFile.content);
    }

    const sourceLabel =
      source === 'KEY_DOUBLE_ESC'
        ? 'skrót klawiszowy 2× Escape'
        : source === 'EMERGENCY_BUTTON'
        ? 'awaryjny przycisk weta'
        : 'zmianę zakładki';

    this.addChatMessage(
      'SYSTEM',
      `🛑 Zgłoszono WETO przez ${sourceLabel}! Trener AI natychmiast przerwał pisanie i przeszedł w stan wstrzymania. Edytor jest w Twoich rękach.`
    );

    this.emit('VETO_EXECUTED', { source, controlEpoch: this.controlEpoch });
    this.emit('STATE_CHANGED', this.getFullState());

    // TEST-010: Simulate late coach step with stale controlEpoch (Editor must drop it!)
    setTimeout(() => {
      this.emit('COACH_STEP', {
        path: this.activePath,
        interventionId: 'stale-interv',
        controlEpoch: oldEpoch,
        stepIndex: 99,
        totalSteps: 99,
        range: { startLine: 1, startColumn: 1, endLine: 1, endColumn: 1 },
        text: '// [STALE STEP POST-VETO - DROPPED BY EDITOR]\n',
        explanation: 'Opóźniony krok trenera ze starej epoki sterowania',
      });
    }, 40);
  }

  // Pointer & Hint Bubble
  public showCoachPointer(startLine: number, endLine: number) {
    this.activePointer = {
      path: this.activePath,
      documentVersion: this.files.get(this.activePath)?.version || 1,
      startLine,
      startColumn: 1,
      endLine,
      endColumn: 100,
    };
    this.emit('STATE_CHANGED', this.getFullState());
  }

  public clearCoachPointer() {
    this.activePointer = null;
    this.emit('STATE_CHANGED', this.getFullState());
  }

  public showCoachHintBubble(line: number, text: string, severity: HintBubbleSeverity) {
    // Truncate to max 400 chars per spec
    const truncatedText = text.length > 400 ? text.substring(0, 397) + '...' : text;
    this.activeHintBubble = {
      id: `bubble-${Date.now()}`,
      path: this.activePath,
      documentVersion: this.files.get(this.activePath)?.version || 1,
      line,
      text: truncatedText,
      severity,
      createdAt: Date.now(),
    };

    // Also add to chat log
    const severityPrefix =
      severity === 'POSITIVE' ? '🟢 [Dobry kierunek]' : severity === 'NEUTRAL' ? '💡 [Wskazówka]' : '⚠️ [Uwaga / Ryzyko]';
    this.addChatMessage('COACH', `${severityPrefix} (linia ${line}): ${truncatedText}`);

    this.emit('STATE_CHANGED', this.getFullState());
  }

  public updateBubblePosition(posX: number, posY: number) {
    if (this.activeHintBubble) {
      this.activeHintBubble.posX = posX;
      this.activeHintBubble.posY = posY;
      this.emit('STATE_CHANGED', this.getFullState());
    }
  }

  public dismissHintBubble() {
    this.activeHintBubble = null;
    this.emit('STATE_CHANGED', this.getFullState());
  }

  // Action Proposal
  public triggerProposal(type: ProposalType) {
    let proposal: ActionProposal;
    if (type === 'RESTORE_SNAPSHOT' || type === 'RETRY_FROM_SNAPSHOT') {
      proposal = {
        id: `prop-${Date.now()}`,
        type,
        questionText: 'Czy chcesz przywrócić ostatnią zapisaną stabilną migawkę kodu (przed rozpoczęciem refaktoringu)?',
        paths: [this.activePath],
        yesLabel: 'Tak, przywróć migawkę',
        noLabel: 'Nie, pracuję dalej',
      };
    } else if (type === 'GENERATE_TESTS') {
      proposal = {
        id: `prop-${Date.now()}`,
        type,
        questionText: 'Trener AI może wygenerować dodatkowe testy wydajnościowe dla Twojego rozwiązania. Czy chcesz je dołączyć?',
        paths: ['src/solution.test.ts'],
        yesLabel: 'Tak, wygeneruj testy',
        noLabel: 'Pomiń generowanie',
      };
    } else {
      proposal = {
        id: `prop-${Date.now()}`,
        type,
        questionText: 'Twój kod przechodzi wszystkie testy! Czy chcesz zakończyć ćwiczenie i wygenerować raport końcowy?',
        paths: [],
        yesLabel: 'Tak, zakończ ćwiczenie',
        noLabel: 'Chcę jeszcze poćwiczyć',
      };
    }

    this.activeProposal = proposal;
    this.addChatMessage('COACH', `Pytanie do Ciebie: ${proposal.questionText}`, proposal);
    this.emit('STATE_CHANGED', this.getFullState());
  }

  public answerProposal(proposalId: string, accepted: boolean) {
    if (!this.activeProposal || this.activeProposal.id !== proposalId) return;

    const current = this.activeProposal;
    this.activeProposal = null; // Immediately dismiss

    this.addChatMessage(
      'STUDENT',
      accepted ? `Wybrano: [${current.yesLabel}]` : `Wybrano: [${current.noLabel}]`
    );

    if (accepted) {
      if (current.type === 'RESTORE_SNAPSHOT' || current.type === 'RETRY_FROM_SNAPSHOT') {
        // Reset file to original
        const orig = this.currentScenario.files.find((f) => f.path === this.activePath);
        if (orig) {
          this.updateFileContent(this.activePath, orig.content, false, true);
          this.addChatMessage('SYSTEM', `Przywrócono pierwotną zawartość pliku ${this.activePath}.`);
        }
      } else if (current.type === 'GENERATE_TESTS') {
        this.addChatMessage('COACH', 'Dodano nowe testy krawędziowe do pliku testów.');
      } else if (current.type === 'FINISH_EXERCISE') {
        this.finishExercise('COMPLETED');
      }
    }

    this.emit('STATE_CHANGED', this.getFullState());
  }

  // Execution: Run Main & Run Tests
  public runProgram(isTest: boolean) {
    if (this.activeRun && (this.activeRun.status === 'RUNNING' || this.activeRun.status === 'QUEUED')) {
      return;
    }

    if (isTest && !this.currentScenario.capabilities.canRunTests) {
      this.addChatMessage('SYSTEM', `Niedostępne: ${this.currentScenario.capabilities.runTestsReason || 'Brak testów'}`);
      return;
    }

    const runId = `run-${Date.now()}`;
    const profileName = isTest ? 'Run Tests (Vitest / Pytest)' : 'Run Main (Node / Python)';

    this.activeRun = {
      runId,
      profileName,
      status: 'QUEUED',
      testOutcome: isTest ? 'UNKNOWN' : 'NOT_APPLICABLE',
      workspaceChangedDuringRun: false,
      outputTruncated: false,
      logs: [
        {
          id: `log-1`,
          timestamp: Date.now(),
          type: 'SYSTEM',
          text: `[KOMPILATOR] Inicjalizacja środowiska wykonawczego dla: ${profileName}...`,
        },
      ],
    };

    if (isTest) this.testRunsCount += 1;
    this.emit('STATE_CHANGED', this.getFullState());

    // Switch to RUNNING after brief queue
    setTimeout(() => {
      if (!this.activeRun || this.activeRun.runId !== runId) return;
      this.activeRun.status = 'RUNNING';
      this.activeRun.logs.push({
        id: `log-2`,
        timestamp: Date.now(),
        type: 'STDOUT',
        text: `> Wykonywanie polecenia procesu...`,
      });
      this.emit('STATE_CHANGED', this.getFullState());

      // Simulate execution time
      this.executionTimer = setTimeout(() => {
        if (!this.activeRun || this.activeRun.runId !== runId) return;

        if (isTest) {
          // Check solution content to see if it's O(N) or O(N^2)
          const solContent = this.files.get('src/solution.ts')?.content || '';
          const hasMap = solContent.includes('Map') || solContent.includes('map.set') || solContent.includes('dict');
          const hasBruteForce = solContent.includes('for (let j = i + 1') || solContent.includes('j in range');

          if (hasMap) {
            this.activeRun.status = 'SUCCEEDED';
            this.activeRun.exitCode = 0;
            this.activeRun.testOutcome = 'PASSED';
            this.activeRun.logs.push(
              { id: `log-t1`, timestamp: Date.now(), type: 'STDOUT', text: `✓ Test 1: [2, 7, 11, 15] target 9 (PASSED 1.2ms)` },
              { id: `log-t2`, timestamp: Date.now(), type: 'STDOUT', text: `✓ Test 2: [3, 2, 4] target 6 (PASSED 0.8ms)` },
              { id: `log-t3`, timestamp: Date.now(), type: 'STDOUT', text: `✓ Test 3: [3, 3] target 6 (PASSED 0.7ms)` },
              { id: `log-t4`, timestamp: Date.now(), type: 'STDOUT', text: `✓ Test 4: Wydajność 10k elementów < 50ms (PASSED 4.12ms - Złożoność O(N) potwierdzona!)` },
              { id: `log-t5`, timestamp: Date.now(), type: 'SYSTEM', text: `\n4 testy zakończone sukcesem (100% zaliczone). Kod wyjścia: 0.` }
            );

            // Propose finish
            setTimeout(() => {
              this.triggerProposal('FINISH_EXERCISE');
            }, 1000);
          } else if (hasBruteForce) {
            this.activeRun.status = 'FAILED';
            this.activeRun.exitCode = 1;
            this.activeRun.testOutcome = 'FAILED';
            this.activeRun.logs.push(
              { id: `log-t1`, timestamp: Date.now(), type: 'STDOUT', text: `✓ Test 1: [2, 7, 11, 15] target 9 (PASSED 1.4ms)` },
              { id: `log-t2`, timestamp: Date.now(), type: 'STDOUT', text: `✓ Test 2: [3, 2, 4] target 6 (PASSED 0.9ms)` },
              { id: `log-t3`, timestamp: Date.now(), type: 'STDOUT', text: `✓ Test 3: [3, 3] target 6 (PASSED 0.7ms)` },
              { id: `log-t4`, timestamp: Date.now(), type: 'STDERR', text: `✗ Test 4: Wydajność 10k elementów (FAILED: Timeout 248ms > 50ms - O(N^2) jest zbyt wolne!)` },
              { id: `log-t5`, timestamp: Date.now(), type: 'SYSTEM', text: `\nZakończono: 3 przeszły, 1 niepowodzenie. Kod wyjścia: 1.` }
            );
          } else {
            this.activeRun.status = 'SUCCEEDED';
            this.activeRun.exitCode = 0;
            this.activeRun.testOutcome = 'PASSED';
            this.activeRun.logs.push(
              { id: `log-t1`, timestamp: Date.now(), type: 'STDOUT', text: `✓ Wszystkie asercje programu zostały spełnione.` }
            );
          }
        } else {
          // Main program run
          this.activeRun.status = 'SUCCEEDED';
          this.activeRun.exitCode = 0;
          this.activeRun.testOutcome = 'NOT_APPLICABLE';
          this.activeRun.logs.push(
            { id: `log-m1`, timestamp: Date.now(), type: 'STDOUT', text: `[OUT] Program uruchomiony pomyślnie.` },
            { id: `log-m2`, timestamp: Date.now(), type: 'STDOUT', text: `[OUT] twoSum([2, 7, 11, 15], 9) => [0, 1]` },
            { id: `log-m3`, timestamp: Date.now(), type: 'SYSTEM', text: `Proces zakończony z kodem 0.` }
          );
        }

        this.emit('STATE_CHANGED', this.getFullState());
      }, 1800);
    }, 400);
  }

  public stopExecution() {
    if (this.activeRun && (this.activeRun.status === 'RUNNING' || this.activeRun.status === 'QUEUED')) {
      if (this.executionTimer) {
        clearTimeout(this.executionTimer);
        this.executionTimer = null;
      }
      this.activeRun.status = 'CANCELLED';
      this.activeRun.logs.push({
        id: `log-stop`,
        timestamp: Date.now(),
        type: 'SYSTEM',
        text: '⏹ Wykonywanie procesu zatrzymane na żądanie użytkownika.',
      });
      this.emit('STATE_CHANGED', this.getFullState());
    }
  }

  // External sync conflict simulation
  public simulateExternalFileSync() {
    const file = this.files.get(this.activePath);
    if (!file) return;

    const newDiskContent = `// [ZMIANA ZEWNĘTRZNA Z DYSKU ${new Date().toLocaleTimeString()}]\n` + file.content;

    // Item 3: If user is offline (unconfirmed draft) or has unconfirmed changes, trigger CONFLICT state!
    if (this.isOffline) {
      this.fileConflict = {
        path: this.activePath,
        diskContent: newDiskContent,
        localDraftContent: file.content,
      };
      this.addChatMessage(
        'SYSTEM',
        `⚠️ Konflikt synchronizacji: Plik ${this.activePath} został zmodyfikowany na dysku, ale posiadasz lokalny niepotwierdzony draft w trybie Offline.`
      );
      this.emit('STATE_CHANGED', this.getFullState());
      return;
    }

    file.content = newDiskContent;
    file.version += 1;
    this.workspaceVersion += 1;

    this.addChatMessage(
      'SYSTEM',
      `⚠️ Wykryto zewnętrzną zmianę pliku ${this.activePath} na dysku! Zaktualizowano model dokumentu.`
    );
    this.emit('FILE_UPDATED', { ...file, isExternalOrSnapshot: true });
    this.emit('STATE_CHANGED', this.getFullState());
  }

  public resolveConflict(choice: 'KEEP_LOCAL' | 'LOAD_DISK') {
    if (!this.fileConflict) return;
    const file = this.files.get(this.fileConflict.path);
    if (file) {
      if (choice === 'LOAD_DISK') {
        file.content = this.fileConflict.diskContent;
        file.version += 1;
        this.workspaceVersion += 1;
        this.addChatMessage('SYSTEM', `Rozwiązano konflikt: Załadowano wersję pliku ${file.path} z dysku.`);
        this.emit('FILE_UPDATED', { ...file, isExternalOrSnapshot: true });
      } else {
        file.version += 1;
        this.workspaceVersion += 1;
        this.addChatMessage('SYSTEM', `Rozwiązano konflikt: Zachowano Twój lokalny draft pliku ${file.path}.`);
        this.emit('FILE_UPDATED', { ...file, isExternalOrSnapshot: false });
      }
    }
    this.fileConflict = null;
    this.emit('STATE_CHANGED', this.getFullState());
  }

  public updateProjectSettings(settings: ProjectSettings) {
    this.projectSettings = settings;

    // AI consent effect
    if (!settings.aiConsent) {
      this.aiStatus = 'OFF';
      this.coachMode = 'UNAVAILABLE';
      this.addChatMessage('SYSTEM', 'Ustawienia zaktualizowane: Wyłączono zgodę AI (aiConsent = false). Trener AI nie będzie interweniował.');
    } else if (this.aiStatus === 'OFF') {
      this.aiStatus = 'READY';
      this.coachMode = 'ACTIVE_WATCHING';
      this.addChatMessage('SYSTEM', 'Ustawienia zaktualizowane: Włączono zgodę AI (aiConsent = true). Trener AI jest gotowy.');
    }

    // Task mode effect
    this.currentScenario.taskMode = settings.taskMode;
    this.currentScenario.taskFilePath = settings.taskFilePath;
    this.currentScenario.reviewNotesPath = settings.reviewNotesPath;

    if (settings.taskMode === 'CODE_REVIEW') {
      this.currentScenario.capabilities.canRunTests = false;
      this.currentScenario.capabilities.runTestsReason = 'Zadanie Code Review nie posiada zestawu testów jednostkowych — ocena następuje na podstawie review.md';
    } else {
      this.currentScenario.capabilities.canRunTests = true;
      this.currentScenario.capabilities.runTestsReason = undefined;
    }

    this.emit('STATE_CHANGED', this.getFullState());
  }

  public getSnapshots(): SnapshotItem[] {
    return this.snapshots;
  }

  public restoreSnapshotById(snapshotId: string) {
    const snap = this.snapshots.find((s) => s.id === snapshotId);
    if (!snap) return;

    for (const snapFile of snap.files) {
      const file = this.files.get(snapFile.path);
      if (file) {
        file.content = snapFile.content;
        file.version += 1;
        this.emit('FILE_UPDATED', { ...file, isExternalOrSnapshot: true });
      }
    }

    this.workspaceVersion += 1;
    this.addChatMessage(
      'SYSTEM',
      `🔄 Przywrócono stan z migawki: "${snap.label}". Modele dokumentów zostały zsynchronizowane.`
    );
    this.emit('STATE_CHANGED', this.getFullState());
  }

  // Connectivity toggle
  public toggleOffline(force?: boolean) {
    this.isOffline = force !== undefined ? force : !this.isOffline;
    if (this.isOffline) {
      this.addChatMessage('SYSTEM', '🔌 Utracono połączenie z serwerem. Zmiany niepotwierdzone (status szary).');
    } else {
      this.addChatMessage('SYSTEM', '🟢 Połączenie z serwerem przywrócone. Wszystkie wersje zsynchronizowane.');
    }
    this.emit('STATE_CHANGED', this.getFullState());
  }

  // Finish Exercise & Generate Report
  public finishExercise(reason: EndReason, simulateFailure = false) {
    this.stopTimer();

    this.report = {
      status: 'PENDING',
      reason,
      metrics: {
        durationFormatted: `${Math.floor(this.elapsedMs / 60000)}m ${Math.floor((this.elapsedMs % 60000) / 1000)}s`,
        coachInterventionsCount: this.coachInterventionsCount,
        userVetoCount: this.userVetoCount,
        testRunsCount: this.testRunsCount,
        linesChanged: 28,
        scorePercentage: reason === 'COMPLETED' ? 95 : reason === 'TIME_LIMIT_REVIEW' ? 70 : 40,
      },
    };

    this.emit('STATE_CHANGED', this.getFullState());

    setTimeout(() => {
      if (simulateFailure) {
        this.report = {
          status: 'FAILED',
          reason,
          error: 'Błąd generowania podsumowania: Przekroczono limit czasu oczekiwania na silnik LLM (504 Gateway Timeout).',
        };
      } else {
        const scenarioTitle = this.currentScenario.title;
        const passedReason =
          reason === 'COMPLETED'
            ? 'Pomyślne ukończenie zadania i zaliczenie testów'
            : reason === 'TIME_LIMIT_REVIEW'
            ? 'Przegląd po upływie zaplanowanego czasu'
            : 'Próba porzucona na życzenie użytkownika';

        const markdown = `# Raport Końcowy Sesji Treningowej: PairCoach

## 📌 Podsumowanie Zadania
- **Zadanie:** ${scenarioTitle}
- **Status zakończenia:** \`${reason}\` (${passedReason})
- **Łączny czas sesji:** ${Math.floor(this.elapsedMs / 60000)} min ${Math.floor((this.elapsedMs % 60000) / 1000)} sek
- **Ocena łączna:** **${this.report?.metrics?.scorePercentage || 85}%**

---

### 📊 Metryki Pracy i Współpracy z Trenerem AI:
| Wskaźnik | Wartość | Ocena trenera |
| :--- | :--- | :--- |
| **Interwencje trenera** | ${this.coachInterventionsCount} | W normie (asysta w kluczowych momentach) |
| **Weta użytkownika (2× Esc)** | ${this.userVetoCount} | Samodzielność i asertywność |
| **Uruchomienia testów** | ${this.testRunsCount} | Dobra pętla zwrotna TDD |
| **Złożoność obliczeniowa** | **O(N)** | Optymalna (zastosowano Map) |

---

### 💡 Wnioski i Rekomendacje Mentora:
1. **Zastosowanie struktur asocjacyjnych:** Prawidłowe zastąpienie podwójnej pętli przez \`Map<number, number>\` pozwoliło osiągnąć docelową wydajność O(N) i zaliczyć testy wydajnościowe.
2. **Reakcja na interwencje:** Wykorzystano podpowiedzi trenera z zachowaniem pełnej kontroli nad kodem.
3. **Czystość kodu:** Kod jest zwięzły, a obsługa brakującego rozwiązania rzuca czytelny błąd.
`;

        this.report = {
          status: 'READY',
          reason,
          markdown,
          metrics: this.report?.metrics,
        };
      }
      this.emit('STATE_CHANGED', this.getFullState());
    }, 1500);
  }

  public retryReport() {
    if (!this.report) return;
    const reason = this.report.reason || 'COMPLETED';
    this.finishExercise(reason, false);
  }
}

// Global simulator singleton for Phase 1
export const simulator = new MockBackendSimulator();
