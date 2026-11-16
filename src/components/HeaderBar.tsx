import { t, problemText, stateText } from '../i18n';
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
  Sun,
  Moon,
} from 'lucide-react';

interface HeaderBarProps {
  /** Presentation only: an empty durable workspace has no source save to confirm. */
  emptyWorkspaceLabel?: string;
  locale?: 'pl'|'en'; onToggleLocale?:()=>void;
  theme?: 'darcula'|'dark'|'light'; onToggleTheme?:()=>void;
  contentFontSize?: number;
  onDecreaseContentFont?: () => void;
  onIncreaseContentFont?: () => void;
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
  emptyWorkspaceLabel,
  theme='darcula',onToggleTheme,
  locale='pl',onToggleLocale,
  contentFontSize=13,onDecreaseContentFont,onIncreaseContentFont,
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
  const isProcessRunning = ['RUNNING','QUEUED','STOPPING','PROCESS_STOP_UNCONFIRMED'].includes(executionStatus);
  const isOvertime = sessionStatus === 'OVERTIME';

  // Label for coachMode
  const getCoachModeBadge = () => {
    switch (coachMode) {
      case 'ACTIVE_WATCHING':
        return { label: t("Obserwuje"), color: 'bg-emerald-950 text-emerald-400 border-emerald-800' };
      case 'INTERVENING':
        return { label: t("Pokazuje w kodzie"), color: 'bg-blue-950 text-blue-300 border-blue-600 animate-pulse' };
      case 'COOLDOWN_AFTER_VETO':
        return { label: t("Wstrzymany po wecie"), color: 'bg-amber-950 text-amber-300 border-amber-800' };
      case 'MUTED_WINDOW_HIDDEN':
        return { label: t("Wyciszony (okno ukryte)"), color: 'bg-zinc-800 text-zinc-400 border-zinc-700' };
      case 'MUTED_MANUAL':
        return { label: t("Wyciszony ręcznie"), color: 'bg-zinc-800 text-zinc-400 border-zinc-700' };
      case 'UNAVAILABLE':
        if (aiStatus === 'READY' && sessionStatus === 'STOPPED')
          return { label: t("Gotowy"), color: 'bg-emerald-950 text-emerald-400 border-emerald-800' };
        return { label: t("Niedostępny"), color: 'bg-zinc-900 text-zinc-500 border-zinc-800' };
    }
  };

  const coachBadge = getCoachModeBadge();

  return (
    <header aria-label={t("Pasek menu")} className="app-menu shrink-0 border-b border-zinc-800 select-none text-zinc-200 overflow-x-auto [scrollbar-width:thin]">
      {/* Main Top Row */}
      <div className="flex min-w-max items-center whitespace-nowrap px-3 py-1.5 gap-2">
        {/* Left Section: Brand & Write Owner Status */}
        <div className="flex shrink-0 items-center gap-2">
          <div className="flex items-center gap-2">
            <svg
              role="img"
              aria-label="PC"
              width="26" height="26" viewBox="0 0 26 26"
              className="shrink-0 rounded-md bg-zinc-800 border border-zinc-700 text-zinc-300"
              fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round"
            >
              <path d="M5 19V7h4a3 3 0 0 1 0 6H5" />
              <path d="M21 8a5 5 0 0 0-3-1c-6 0-6 12 0 12a5 5 0 0 0 3-1" />
            </svg>

          </div>

          <div className="h-5 w-px bg-zinc-800 hidden md:block" />

          {/* Write Owner Indicator */}
          <div className="flex items-center gap-2">
            {emptyWorkspaceLabel ? (
              <div className="px-2.5 py-1 rounded-md text-xs font-semibold bg-zinc-800 text-zinc-400 border border-zinc-700">
                {t(emptyWorkspaceLabel)}
              </div>
            ) : writeOwner === 'STUDENT' ? (
              <div
                title={t("Masz potwierdzone prawo zapisu w edytorze")}
                className="flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-semibold bg-red-950/80 text-red-300 border border-red-700 shadow-sm"
              >
                <span className="w-2 h-2 rounded-full bg-red-500 animate-ping" />
                <span>{t("Ty")}</span>
              </div>
            ) : writeOwner === 'COACH' ? (
              <div
                title={t("Trener demonstruje kod — wciśnij dwukrotnie Escape, aby natychmiast przerwać")}
                className="flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-semibold bg-blue-950 text-blue-200 border border-blue-500 shadow-md animate-pulse"
              >
                <Bot className="w-3.5 h-3.5 text-blue-400" />
                <span>{t("Pisze trener")}</span>
              </div>
            ) : (
              <div
                title={t("Synchronizacja lub brak połączenia z serwerem. Zmiany niepotwierdzone.")}
                className="flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-semibold bg-zinc-800 text-zinc-400 border border-zinc-700"
              >
                <span className="w-2 h-2 rounded-full bg-zinc-500" />
                <span>{t("Synchronizacja / Zapis niepotwierdzony")}</span>
              </div>
            )}

            {/* Coach Mode Sub-status */}
            <span className={`text-[11px] px-2 py-0.5 rounded border ${coachBadge.color} hidden lg:inline-flex items-center gap-1`}>
              <BrainCircuit className="w-3 h-3" />
              <span>{t("Trener:")}{' '}{coachBadge.label}</span>
            </span>

            {/* AI Status */}
            <span
              title={t("Status silnika AI: {0}",{0: stateText(aiStatus)})}
              className="text-[11px] px-2 py-0.5 rounded bg-zinc-900 border border-zinc-800 text-zinc-400 inline-flex items-center gap-1"
            >
              <Sparkles className={`w-3 h-3 ${aiStatus === 'THINKING' ? 'text-amber-400 animate-spin' : 'text-zinc-500'}`} />
              <span className="font-mono text-[10px]">AI: {aiStatus}</span>
            </span>
          </div>

          {/* Emergency Veto Button */}
          <button
            onClick={onEmergencyVeto}
            aria-label={t("Przerwij trenerowi")}
            className={`flex items-center gap-1.5 px-3 py-1 rounded text-xs font-bold transition-all shadow-sm ${
              isCoachWriting
                ? 'bg-red-600 hover:bg-red-700 text-white ring-2 ring-red-400 ring-offset-1 ring-offset-zinc-950 animate-bounce'
                : 'bg-zinc-900 hover:bg-zinc-800 text-zinc-300 border border-zinc-700 hover:border-zinc-500'
            }`}
            title={t("Przerwij pisanie trenerowi natychmiast (działa identycznie jak 2× Escape)")}
          >
            <ShieldAlert className="w-3.5 h-3.5 text-red-400" />
            <span>?</span>
          </button>
        </div>

        {/* Right Section: Task Mode, Capabilities, Execution & Finish */}
        <div className="flex shrink-0 items-center gap-2">
          {/* Task Mode Badge */}
          <div
            title={t("Tryb zadania: {0}",{0: stateText(taskMode)})}
            className="flex items-center gap-1 px-2 py-0.5 rounded bg-zinc-900 border border-zinc-800 text-[11px] text-zinc-300"
          >
            {taskMode === 'IMPLEMENTATION' ? <Code2 className="w-3 h-3 text-cyan-400" /> : <FileCheck className="w-3 h-3 text-amber-400" />}
            <span className="font-medium">{t(taskMode === 'IMPLEMENTATION' ? "Implementacja" : "Przegląd kodu")}</span>
          </div>

          {/* Run Main Button */}
          <button
            onClick={onRunMain}
            disabled={!capabilities.canRunMain || isProcessRunning}
            title={capabilities.canRunMain ? t("Uruchom program główny (Run Main)") : problemText(capabilities.runMainReason) || t("Niedostępne")}
            className={`flex items-center gap-1 px-2.5 py-1 rounded text-xs font-semibold transition-all ${
              capabilities.canRunMain && !isProcessRunning
                ? 'bg-zinc-800 hover:bg-zinc-700 text-zinc-100 border border-zinc-700'
                : 'bg-zinc-900/50 text-zinc-600 border border-zinc-800 cursor-not-allowed'
            }`}
          >
            <Play className="w-3 h-3 text-emerald-400 fill-emerald-400" />
            <span className="hidden sm:inline">{t("Uruchom")}</span>
          </button>

          {/* Run Tests Button */}
          <button
            onClick={onRunTests}
            disabled={!capabilities.canRunTests || isProcessRunning}
            title={capabilities.canRunTests ? t("Uruchom zestaw testów automatycznych") : problemText(capabilities.runTestsReason) || t("Brak profilu testów dla tego zadania")}
            className={`flex items-center gap-1 px-2.5 py-1 rounded text-xs font-semibold transition-all ${
              capabilities.canRunTests && !isProcessRunning
                ? 'bg-emerald-950 hover:bg-emerald-900 text-emerald-200 border border-emerald-700'
                : 'bg-zinc-900/50 text-zinc-600 border border-zinc-800 cursor-not-allowed'
            }`}
          >
            <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />
            <span>{t("Uruchom testy")}</span>
          </button>

          {/* Stop Process Button (only active during process execution) */}
          {isProcessRunning && (
            <button
              onClick={onStopExecution}
              className="flex items-center gap-1 px-2.5 py-1 rounded text-xs font-semibold bg-rose-950 text-rose-300 border border-rose-700 hover:bg-rose-900 animate-pulse"
              title={t("Zatrzymaj trwające uruchomienie programu lub testów (odrębne od weta trenera)")}
            >
              <Square className="w-3 h-3 fill-rose-400 text-rose-400" />
              <span>{t("Zatrzymaj")}</span>
            </button>
          )}

          {/* Finish & Abandon Buttons */}
          <div className="flex items-center gap-1 border-l border-zinc-800 pl-2">
            <button
              onClick={() => onOpenFinishModal('COMPLETED')}
              className="flex items-center gap-1 px-2.5 py-1 rounded text-xs font-semibold bg-blue-600 hover:bg-blue-500 text-white shadow-sm transition-all"
              title={t("Zakończ próbę i wygeneruj raport z oceny")}
            >
              <span>{t("🏁 Zakończ")}</span>
            </button>

            <button
              onClick={() => onOpenFinishModal('ABANDONED')}
              className="px-2 py-1 rounded text-xs text-zinc-400 hover:text-zinc-200 hover:bg-zinc-900 transition-all"
              title={t("Porzuć bieżącą próbę")}
            >
              {t("Porzuć")}{' '}</button>
          </div>

          {/* Dev Simulator Toggle */}
          <button
            onClick={onToggleDevSimulator}
            className={`p-1.5 rounded text-xs border transition-all ${
              isDevSimulatorOpen
                ? 'bg-amber-950 text-amber-300 border-amber-700'
                : 'bg-zinc-900 text-zinc-400 hover:text-zinc-200 border-zinc-800 hover:border-zinc-700'
            }`}
            title={t("Przełącz pasek narzędzi deweloperskich (symulator zdarzeń serwera)")}
          >
            <Wrench className="w-3.5 h-3.5" />
          </button>
        </div>

        {onToggleTheme && <button type="button" aria-label={t('Zmień motyw')} title={t('Zmień motyw')+': '+(theme==='darcula'?'Darcula':theme==='dark'?'Solarized Dark':'Solarized Light')} onClick={onToggleTheme}
          className="shrink-0 flex items-center gap-1 p-1 rounded-full border border-zinc-700 bg-zinc-900">
          {theme==='light'?<Sun className="w-5 h-5 p-0.5"/>:<Moon className="w-5 h-5 p-0.5"/>}
          <span className="text-[10px]">{theme==='darcula'?'Darcula':theme==='dark'?'Solarized Dark':'Solarized Light'}</span>
        </button>}
        <div role="group" aria-label={t("Rozmiar czcionki treści")} className="flex shrink-0 gap-1">
          <button type="button" aria-label={t("Zmniejsz czcionkę treści")}
            title={t("Zmniejsz czcionkę treści (obecnie {0} px w edytorze)",{0: contentFontSize})}
            disabled={!onDecreaseContentFont || contentFontSize<=10} onClick={onDecreaseContentFont}
            className="px-2 py-1 text-xs font-semibold rounded border border-zinc-700 bg-zinc-900 text-zinc-200 hover:bg-zinc-800 disabled:opacity-40 disabled:cursor-not-allowed">A-</button>
          <button type="button" aria-label={t("Zwiększ czcionkę treści")}
            title={t("Zwiększ czcionkę treści (obecnie {0} px w edytorze)",{0: contentFontSize})}
            disabled={!onIncreaseContentFont || contentFontSize>=30} onClick={onIncreaseContentFont}
            className="px-2 py-1 text-xs font-semibold rounded border border-zinc-700 bg-zinc-900 text-zinc-200 hover:bg-zinc-800 disabled:opacity-40 disabled:cursor-not-allowed">A+</button>
        </div>
        {onToggleLocale && <button type="button" onClick={onToggleLocale} aria-label={t('Język interfejsu i trenera')+': '+locale.toUpperCase()}
          title={t('Zmień język')} className="shrink-0 rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-xs">
          <span aria-hidden="true">{locale==='pl'?'🇵🇱':'🇺🇸'}</span> {locale.toUpperCase()}
        </button>}
        {/* Center: Session Timer */}
        <div className="ml-auto flex shrink-0 items-center gap-2 bg-zinc-900/90 px-2 py-1 rounded-md border border-zinc-800">
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
                {t("Po limicie")} (+{formatTime(elapsedMs - limitMs)})
              </span>
            )}
          </div>

          <div className="flex items-center gap-1 ml-2">
            {sessionStatus === 'RUNNING' || sessionStatus === 'OVERTIME' ? (
              <button
                onClick={onPauseTimer}
                className="p-1 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-300"
                title={t("Pauza czasu")}
              >
                <Pause className="w-3 h-3" />
              </button>
            ) : (
              <button
                onClick={sessionStatus === 'STOPPED' ? onStartTimer : onResumeTimer}
                className="p-1 rounded bg-blue-900/80 hover:bg-blue-800 text-blue-200"
                title={sessionStatus === 'PAUSED' ? t("Wznów czas") : t("Start sesji")}
              >
                <Play className="w-3 h-3" />
              </button>
            )}
          </div>

          {/* Pause on Hidden Checkbox */}
          <label
            className="hidden md:flex items-center gap-1.5 text-[11px] text-zinc-400 ml-2 pl-2 border-l border-zinc-800 cursor-pointer hover:text-zinc-300"
            title={t("Automatycznie wstrzymaj naliczanie czasu, gdy zminimalizujesz okno lub przejdziesz do innej karty")}
          >
            <input
              type="checkbox"
              checked={pauseOnHidden}
              onChange={(e) => onTogglePauseOnHidden(e.target.checked)}
              className="rounded bg-zinc-950 border-zinc-700 text-blue-600 focus:ring-0 text-xs"
            />
            <span>{t("Pauzuj przy ukryciu")}</span>
          </label>
        </div>

      </div>
    </header>
  );
};
