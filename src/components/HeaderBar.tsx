/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import {
  AiStatus,
  Capabilities,
  CoachMode,
  ExecutionStatus,
  SessionStatus,
  TaskMode,
  WriteOwner,
} from '../types/paircoach';
import {
  AlertTriangle,
  Bot,
  BrainCircuit,
  CheckCircle2,
  Clock,
  Code2,
  FileCheck,
  HelpCircle,
  Pause,
  Play,
  RotateCcw,
  ShieldAlert,
  Sparkles,
  Square,
  Wrench,
  XCircle,
} from 'lucide-react';

interface HeaderBarProps {
  writeOwner: WriteOwner;
  coachMode: CoachMode;
  aiStatus: AiStatus;
  sessionStatus: SessionStatus;
  elapsedMs: number;
  limitMs: number;
  pauseOnHidden: boolean;
  taskMode: TaskMode;
  capabilities: Capabilities;
  executionStatus: ExecutionStatus;
  isDevSimulatorOpen: boolean;
  onEmergencyVeto: () => void;
  onStartTimer: () => void;
  onPauseTimer: () => void;
  onResumeTimer: () => void;
  onTogglePauseOnHidden: (val: boolean) => void;
  onRunMain: () => void;
  onRunTests: () => void;
  onStopExecution: () => void;
  onOpenFinishModal: (reason: 'COMPLETED' | 'ABANDONED') => void;
  onToggleDevSimulator: () => void;
}

export const HeaderBar: React.FC<HeaderBarProps> = ({
  writeOwner,
  coachMode,
  aiStatus,
  sessionStatus,
  elapsedMs,
  limitMs,
  pauseOnHidden,
  taskMode,
  capabilities,
  executionStatus,
  isDevSimulatorOpen,
  onEmergencyVeto,
  onStartTimer,
  onPauseTimer,
  onResumeTimer,
  onTogglePauseOnHidden,
  onRunMain,
  onRunTests,
  onStopExecution,
  onOpenFinishModal,
  onToggleDevSimulator,
}) => {
  // Format MM:SS
  const formatTime = (ms: number) => {
    const totalSeconds = Math.floor(ms / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  };

  const isCoachWriting = writeOwner === 'COACH';
  const isProcessRunning = executionStatus === 'RUNNING' || executionStatus === 'QUEUED';
  const isOvertime = sessionStatus === 'OVERTIME';

  // Label for coachMode
  const getCoachModeBadge = () => {
    switch (coachMode) {
      case 'ACTIVE_WATCHING':
        return { label: 'Obserwuje', color: 'bg-emerald-950 text-emerald-400 border-emerald-800' };
      case 'INTERVENING':
        return { label: 'Pokazuje w kodzie', color: 'bg-blue-950 text-blue-300 border-blue-600 animate-pulse' };
      case 'COOLDOWN_AFTER_VETO':
        return { label: 'Wstrzymany po wecie', color: 'bg-amber-950 text-amber-300 border-amber-800' };
      case 'MUTED_WINDOW_HIDDEN':
        return { label: 'Wyciszony (okno ukryte)', color: 'bg-zinc-800 text-zinc-400 border-zinc-700' };
      case 'MUTED_MANUAL':
        return { label: 'Wyciszony ręcznie', color: 'bg-zinc-800 text-zinc-400 border-zinc-700' };
      case 'UNAVAILABLE':
        return { label: 'Niedostępny', color: 'bg-zinc-900 text-zinc-500 border-zinc-800' };
    }
  };

  const coachBadge = getCoachModeBadge();

  return (
    <header className="bg-zinc-950 border-b border-zinc-800 select-none text-zinc-200">
      {/* Main Top Row */}
      <div className="flex flex-wrap items-center justify-between px-3 py-2 gap-2">
        {/* Left Section: Brand & Write Owner Status */}
        <div className="flex flex-wrap min-w-0 items-center gap-3">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-red-600 via-rose-600 to-blue-600 flex items-center justify-center font-bold text-white shadow-md text-sm tracking-wider">
              PC
            </div>
            <div className="hidden sm:block">
              <span className="font-bold text-sm tracking-tight text-zinc-100">PairCoach</span>
              <span className="text-[10px] ml-1.5 px-1.5 py-0.5 rounded bg-zinc-800 text-zinc-400 font-mono">v3.0</span>
            </div>
          </div>

          <div className="h-5 w-px bg-zinc-800 hidden md:block" />

          {/* Write Owner Indicator */}
          <div className="flex items-center gap-2">
            {writeOwner === 'STUDENT' ? (
              <div
                title="Masz potwierdzone prawo zapisu w edytorze"
                className="flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-semibold bg-red-950/80 text-red-300 border border-red-700 shadow-sm"
              >
                <span className="w-2 h-2 rounded-full bg-red-500 animate-ping" />
                <span>Piszesz Ty</span>
              </div>
            ) : writeOwner === 'COACH' ? (
              <div
                title="Trener demonstruje kod — wciśnij dwukrotnie Escape, aby natychmiast przerwać"
                className="flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-semibold bg-blue-950 text-blue-200 border border-blue-500 shadow-md animate-pulse"
              >
                <Bot className="w-3.5 h-3.5 text-blue-400" />
                <span>Pisze trener — 2× Esc przerywa</span>
              </div>
            ) : (
              <div
                title="Synchronizacja lub brak połączenia z serwerem. Zmiany niepotwierdzone."
                className="flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-semibold bg-zinc-800 text-zinc-400 border border-zinc-700"
              >
                <span className="w-2 h-2 rounded-full bg-zinc-500" />
                <span>Synchronizacja / Zapis niepotwierdzony</span>
              </div>
            )}

            {/* Coach Mode Sub-status */}
            <span className={`text-[11px] px-2 py-0.5 rounded border ${coachBadge.color} hidden lg:inline-flex items-center gap-1`}>
              <BrainCircuit className="w-3 h-3" />
              <span>Trener: {coachBadge.label}</span>
            </span>

            {/* AI Status */}
            <span
              title={`Status silnika AI: ${aiStatus}`}
              className="text-[11px] px-2 py-0.5 rounded bg-zinc-900 border border-zinc-800 text-zinc-400 inline-flex items-center gap-1"
            >
              <Sparkles className={`w-3 h-3 ${aiStatus === 'THINKING' ? 'text-amber-400 animate-spin' : 'text-zinc-500'}`} />
              <span className="font-mono text-[10px]">AI: {aiStatus}</span>
            </span>
          </div>

          {/* Emergency Veto Button */}
          <button
            onClick={onEmergencyVeto}
            className={`flex items-center gap-1.5 px-3 py-1 rounded text-xs font-bold transition-all shadow-sm ${
              isCoachWriting
                ? 'bg-red-600 hover:bg-red-700 text-white ring-2 ring-red-400 ring-offset-1 ring-offset-zinc-950 animate-bounce'
                : 'bg-zinc-900 hover:bg-zinc-800 text-zinc-300 border border-zinc-700 hover:border-zinc-500'
            }`}
            title="Przerwij pisanie trenerowi natychmiast (działa identycznie jak 2× Escape)"
          >
            <ShieldAlert className="w-3.5 h-3.5 text-red-400" />
            <span>Przerwij trenerowi (2× Esc)</span>
          </button>
        </div>

        {/* Center: Session Timer */}
        <div className="flex items-center gap-2 bg-zinc-900/90 px-3 py-1 rounded-md border border-zinc-800">
          <Clock className={`w-4 h-4 ${isOvertime ? 'text-rose-400 animate-pulse' : 'text-zinc-400'}`} />
          <div className="flex flex-col">
            <span
              className={`font-mono text-sm font-bold tracking-wider ${
                isOvertime ? 'text-rose-400 animate-pulse' : sessionStatus === 'RUNNING' ? 'text-zinc-100' : 'text-zinc-400'
              }`}
            >
              {formatTime(elapsedMs)}
              <span className="text-[10px] text-zinc-500 font-normal ml-1">/ {formatTime(limitMs)}</span>
            </span>
            {isOvertime && (
              <span className="text-[9px] text-rose-400 font-semibold tracking-wide uppercase leading-none">
                Overtime (+{formatTime(elapsedMs - limitMs)})
              </span>
            )}
          </div>

          <div className="flex items-center gap-1 ml-2">
            {sessionStatus === 'RUNNING' || sessionStatus === 'OVERTIME' ? (
              <button
                onClick={onPauseTimer}
                className="p-1 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-300"
                title="Pauza czasu"
              >
                <Pause className="w-3 h-3" />
              </button>
            ) : (
              <button
                onClick={sessionStatus === 'STOPPED' ? onStartTimer : onResumeTimer}
                className="p-1 rounded bg-blue-900/80 hover:bg-blue-800 text-blue-200"
                title={sessionStatus === 'PAUSED' ? 'Wznów czas' : 'Start sesji'}
              >
                <Play className="w-3 h-3" />
              </button>
            )}
          </div>

          {/* Pause on Hidden Checkbox */}
          <label
            className="hidden md:flex items-center gap-1.5 text-[11px] text-zinc-400 ml-2 pl-2 border-l border-zinc-800 cursor-pointer hover:text-zinc-300"
            title="Automatycznie wstrzymaj naliczanie czasu, gdy zminimalizujesz okno lub przejdziesz do innej karty"
          >
            <input
              type="checkbox"
              checked={pauseOnHidden}
              onChange={(e) => onTogglePauseOnHidden(e.target.checked)}
              className="rounded bg-zinc-950 border-zinc-700 text-blue-600 focus:ring-0 text-xs"
            />
            <span>Pauzuj przy ukryciu</span>
          </label>
        </div>

        {/* Right Section: Task Mode, Capabilities, Execution & Finish */}
        <div className="flex items-center gap-2">
          {/* Task Mode Badge */}
          <div
            title={`Tryb zadania: ${taskMode}`}
            className="hidden xl:flex items-center gap-1 px-2 py-0.5 rounded bg-zinc-900 border border-zinc-800 text-[11px] text-zinc-300"
          >
            {taskMode === 'IMPLEMENTATION' ? <Code2 className="w-3 h-3 text-cyan-400" /> : <FileCheck className="w-3 h-3 text-amber-400" />}
            <span className="font-medium">{taskMode}</span>
          </div>

          {/* Plugins indicator */}
          <div className="hidden 2xl:flex items-center gap-1.5 text-[10px] text-zinc-500 border border-zinc-800/80 px-2 py-0.5 rounded bg-zinc-950">
            <span title="Moduł dokumentacji F1 — niezainstalowany w MVP" className="opacity-60 cursor-not-allowed">
              Docs: <strong className="text-zinc-600">N/A</strong>
            </span>
            <span className="text-zinc-700">|</span>
            <span title="Moduł autouzupełniania — niezainstalowany w MVP" className="opacity-60 cursor-not-allowed">
              AutoComp: <strong className="text-zinc-600">N/A</strong>
            </span>
          </div>

          {/* Run Main Button */}
          <button
            onClick={onRunMain}
            disabled={!capabilities.canRunMain || isProcessRunning}
            title={capabilities.canRunMain ? 'Uruchom program główny (Run Main)' : capabilities.runMainReason || 'Niedostępne'}
            className={`flex items-center gap-1 px-2.5 py-1 rounded text-xs font-semibold transition-all ${
              capabilities.canRunMain && !isProcessRunning
                ? 'bg-zinc-800 hover:bg-zinc-700 text-zinc-100 border border-zinc-700'
                : 'bg-zinc-900/50 text-zinc-600 border border-zinc-800 cursor-not-allowed'
            }`}
          >
            <Play className="w-3 h-3 text-emerald-400 fill-emerald-400" />
            <span className="hidden sm:inline">Run Main</span>
          </button>

          {/* Run Tests Button */}
          <button
            onClick={onRunTests}
            disabled={!capabilities.canRunTests || isProcessRunning}
            title={capabilities.canRunTests ? 'Uruchom zestaw testów automatycznych' : capabilities.runTestsReason || 'Brak profilu testów dla tego zadania'}
            className={`flex items-center gap-1 px-2.5 py-1 rounded text-xs font-semibold transition-all ${
              capabilities.canRunTests && !isProcessRunning
                ? 'bg-emerald-950 hover:bg-emerald-900 text-emerald-200 border border-emerald-700'
                : 'bg-zinc-900/50 text-zinc-600 border border-zinc-800 cursor-not-allowed'
            }`}
          >
            <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />
            <span>Run Tests</span>
          </button>

          {/* Stop Process Button (only active during process execution) */}
          {isProcessRunning && (
            <button
              onClick={onStopExecution}
              className="flex items-center gap-1 px-2.5 py-1 rounded text-xs font-semibold bg-rose-950 text-rose-300 border border-rose-700 hover:bg-rose-900 animate-pulse"
              title="Zatrzymaj trwające uruchomienie programu lub testów (odrębne od weta trenera)"
            >
              <Square className="w-3 h-3 fill-rose-400 text-rose-400" />
              <span>Stop</span>
            </button>
          )}

          {/* Finish & Abandon Buttons */}
          <div className="flex items-center gap-1 border-l border-zinc-800 pl-2">
            <button
              onClick={() => onOpenFinishModal('COMPLETED')}
              className="flex items-center gap-1 px-2.5 py-1 rounded text-xs font-semibold bg-blue-600 hover:bg-blue-500 text-white shadow-sm transition-all"
              title="Zakończ próbę i wygeneruj raport z oceny"
            >
              <span>🏁 Zakończ</span>
            </button>

            <button
              onClick={() => onOpenFinishModal('ABANDONED')}
              className="px-2 py-1 rounded text-xs text-zinc-400 hover:text-zinc-200 hover:bg-zinc-900 transition-all"
              title="Porzuć bieżącą próbę"
            >
              Porzuć
            </button>
          </div>

          {/* Dev Simulator Toggle */}
          <button
            onClick={onToggleDevSimulator}
            className={`p-1.5 rounded text-xs border transition-all ${
              isDevSimulatorOpen
                ? 'bg-amber-950 text-amber-300 border-amber-700'
                : 'bg-zinc-900 text-zinc-400 hover:text-zinc-200 border-zinc-800 hover:border-zinc-700'
            }`}
            title="Przełącz pasek narzędzi deweloperskich (symulator zdarzeń serwera)"
          >
            <Wrench className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>
    </header>
  );
};
