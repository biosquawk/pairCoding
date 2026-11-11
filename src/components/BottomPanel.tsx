/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useRef, useState } from 'react';
import {
  ActionProposal,
  ChatEntry,
  ExecutionRun,
  SessionReport,
} from '../types/paircoach';
import { SafeMarkdown } from './SafeMarkdown';
import { ReportHistory } from './ReportHistory';
import type { ReportHistorySource } from '../services/reportHistory';
import {
  AlertCircle,
  Bot,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  FileText,
  Maximize2,
  Minimize2,
  RefreshCw,
  Send,
  Terminal,
  User,
  XCircle,
} from 'lucide-react';

interface BottomPanelProps {
  activeTab: 'task' | 'chat' | 'console' | 'report';
  taskContent: string;
  chatEntries: ChatEntry[];
  activeProposal: ActionProposal | null;
  activeRun: ExecutionRun | null;
  report: SessionReport | null;
  reportHistorySource?: ReportHistorySource;
  reportHistoryScope?: string | null;
  height: number;
  isMaximized: boolean;
  isCollapsed: boolean;
  onSelectTab: (tab: 'task' | 'chat' | 'console' | 'report') => void;
  onSendMessage: (msg: string) => void;
  onProposalResponse: (proposalId: string, accept: boolean) => void;
  onRetryReport: () => void;
  onToggleCollapse: () => void;
  onToggleMaximize: () => void;
}

export const BottomPanel: React.FC<BottomPanelProps> = ({
  activeTab,
  taskContent,
  chatEntries,
  activeProposal,
  activeRun,
  report,
  reportHistorySource,
  reportHistoryScope,
  height,
  isMaximized,
  isCollapsed,
  onSelectTab,
  onSendMessage,
  onProposalResponse,
  onRetryReport,
  onToggleCollapse,
  onToggleMaximize,
}) => {
  const [inputText, setInputText] = useState('');
  const chatBottomRef = useRef<HTMLDivElement>(null);
  const consoleBottomRef = useRef<HTMLDivElement>(null);

  // Auto scroll chat
  useEffect(() => {
    if (activeTab === 'chat') {
      chatBottomRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [chatEntries, activeTab]);

  // Auto scroll console
  useEffect(() => {
    if (activeTab === 'console') {
      consoleBottomRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [activeRun?.logs, activeTab]);

  const handleSend = (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    if (!inputText.trim()) return;
    onSendMessage(inputText.trim());
    setInputText('');
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  return (
    <div
      style={{ height: isCollapsed ? '38px' : isMaximized ? '100%' : `min(${height}px, 45vh)` }}
      className="flex flex-col min-h-0 shrink-0 bg-zinc-950 border-t border-zinc-800 text-zinc-300 transition-all select-none relative"
    >
      {/* Panel Tab Bar & Window Controls */}
      <div className="flex flex-wrap items-center justify-between gap-1 bg-zinc-950 border-b border-zinc-800 px-3 py-1 select-none">
        {/* Tabs wrap before window controls can horizontally scroll the hidden panel. */}
        <div className="flex flex-wrap min-w-0 items-center gap-1">
          <button
            onClick={() => onSelectTab('task')}
            className={`flex items-center gap-1.5 px-3 py-1 text-xs rounded transition-all font-medium ${
              activeTab === 'task'
                ? 'bg-zinc-800 text-zinc-100 shadow-sm border border-zinc-700'
                : 'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-900'
            }`}
          >
            <FileText className="w-3.5 h-3.5 text-blue-400" />
            <span>Zadanie</span>
          </button>

          <button
            onClick={() => onSelectTab('chat')}
            className={`flex items-center gap-1.5 px-3 py-1 text-xs rounded transition-all font-medium relative ${
              activeTab === 'chat'
                ? 'bg-zinc-800 text-zinc-100 shadow-sm border border-zinc-700'
                : 'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-900'
            }`}
          >
            <Bot className="w-3.5 h-3.5 text-purple-400" />
            <span>Czat</span>
            {activeProposal && (
              <span className="w-2 h-2 rounded-full bg-purple-500 animate-ping absolute -top-0.5 -right-0.5" />
            )}
          </button>

          <button
            onClick={() => onSelectTab('console')}
            className={`flex items-center gap-1.5 px-3 py-1 text-xs rounded transition-all font-medium ${
              activeTab === 'console'
                ? 'bg-zinc-800 text-zinc-100 shadow-sm border border-zinc-700'
                : 'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-900'
            }`}
          >
            <Terminal className="w-3.5 h-3.5 text-emerald-400" />
            <span>Konsola</span>
            {activeRun && activeRun.status === 'RUNNING' && (
              <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse ml-1" />
            )}
          </button>

          <button
            onClick={() => onSelectTab('report')}
            className={`flex items-center gap-1.5 px-3 py-1 text-xs rounded transition-all font-medium ${
              activeTab === 'report'
                ? 'bg-zinc-800 text-zinc-100 shadow-sm border border-zinc-700'
                : 'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-900'
            }`}
          >
            <span>Raport</span>
            {report && report.status === 'READY' && (
              <span className="w-2 h-2 rounded-full bg-blue-500 ml-1" />
            )}
          </button>
        </div>

        {/* Window action buttons (Collapse / Maximize) */}
        <div className="flex shrink-0 items-center gap-1 ml-auto">
          <button
            onClick={onToggleMaximize}
            className="p-1 rounded hover:bg-zinc-800 text-zinc-400 hover:text-zinc-200"
            title={isMaximized ? 'Przywróć normalną wysokość' : 'Maksymalizuj dolny panel'}
          >
            {isMaximized ? <Minimize2 className="w-3.5 h-3.5" /> : <Maximize2 className="w-3.5 h-3.5" />}
          </button>
          <button
            onClick={onToggleCollapse}
            className="p-1 rounded hover:bg-zinc-800 text-zinc-400 hover:text-zinc-200"
            title={isCollapsed ? 'Rozwiń panel' : 'Zwiń panel'}
          >
            {isCollapsed ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
          </button>
        </div>
      </div>

      {/* Panel Body (hidden if collapsed) */}
      {!isCollapsed && (
        <div className="flex-1 min-h-0 overflow-hidden select-text">
          {/* TAB 1: Zadanie (Safe Markdown) */}
          {activeTab === 'task' && (
            <div className="h-full overflow-y-auto p-4 max-w-4xl mx-auto">
              <SafeMarkdown content={taskContent} />
            </div>
          )}

          {/* TAB 2: Czat */}
          {activeTab === 'chat' && (
            <div className="h-full flex flex-col">
              <div className="flex-1 overflow-y-auto p-3 space-y-3">
                {chatEntries.map((entry) => {
                  const isCoach = entry.sender === 'COACH';
                  const isUser = entry.sender === 'STUDENT';
                  const isSystem = entry.sender === 'SYSTEM';

                  if (isSystem) {
                    return (
                      <div key={entry.id} className="text-center my-2">
                        <span className="text-[11px] px-3 py-1 rounded-full bg-zinc-900 border border-zinc-800 text-zinc-400 inline-block max-w-xl">
                          {entry.message}
                        </span>
                      </div>
                    );
                  }

                  return (
                    <div
                      key={entry.id}
                      className={`flex items-start gap-2 max-w-2xl ${isUser ? 'ml-auto flex-row-reverse' : 'mr-auto'}`}
                    >
                      <div
                        className={`w-6 h-6 rounded-full flex items-center justify-center shrink-0 mt-0.5 ${
                          isUser ? 'bg-red-950 text-red-300 border border-red-700' : 'bg-blue-950 text-blue-300 border border-blue-700'
                        }`}
                      >
                        {isUser ? <User className="w-3.5 h-3.5" /> : <Bot className="w-3.5 h-3.5" />}
                      </div>

                      <div
                        className={`rounded-lg px-3 py-2 text-xs leading-relaxed ${
                          isUser
                            ? 'bg-zinc-800 text-zinc-100 border border-zinc-700'
                            : 'bg-zinc-900 text-zinc-200 border border-zinc-800'
                        }`}
                      >
                        <div className="font-semibold text-[10px] text-zinc-400 mb-0.5">
                          {isUser ? 'Ty (Uczeń)' : 'Trener AI'}
                        </div>
                        <div className="whitespace-pre-wrap">{entry.message}</div>

                        {/* Proposal in Chat card */}
                        {entry.proposal && activeProposal && activeProposal.id === entry.proposal.id && (
                          <div className="mt-2.5 p-2.5 bg-purple-950/40 border border-purple-700/80 rounded-md">
                            <div className="font-semibold text-purple-300 text-xs mb-1">
                              Wymagana szybka decyzja:
                            </div>
                            <div className="text-xs text-zinc-200 mb-2">{entry.proposal.questionText}</div>
                            <div className="flex items-center gap-2">
                              <button
                                onClick={() => onProposalResponse(entry.proposal!.id, true)}
                                className="px-3 py-1 rounded bg-purple-600 hover:bg-purple-500 text-white font-medium text-xs shadow-sm transition-all"
                              >
                                {entry.proposal.yesLabel}
                              </button>
                              <button
                                onClick={() => onProposalResponse(entry.proposal!.id, false)}
                                className="px-3 py-1 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-300 text-xs transition-all"
                              >
                                {entry.proposal.noLabel}
                              </button>
                            </div>
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })}
                <div ref={chatBottomRef} />
              </div>

              {/* Chat Input form (Native input/textarea supporting Windows+H dictation) */}
              <form onSubmit={handleSend} className="p-2 border-t border-zinc-800 bg-zinc-950 flex items-center gap-2">
                <textarea
                  value={inputText}
                  onChange={(e) => setInputText(e.target.value)}
                  onKeyDown={handleKeyDown}
                  placeholder="Napisz do Trenera AI... (Shift+Enter dla nowej linii, w pełni zgodne z dyktowaniem Win+H)"
                  rows={1}
                  className="flex-1 bg-zinc-900 border border-zinc-800 rounded px-3 py-2 text-xs text-zinc-100 resize-none focus:outline-none focus:border-blue-500"
                />
                <button
                  type="submit"
                  disabled={!inputText.trim()}
                  className="p-2 bg-blue-600 hover:bg-blue-500 disabled:bg-zinc-800 disabled:text-zinc-600 text-white rounded transition-colors"
                  title="Wyślij wiadomość"
                >
                  <Send className="w-3.5 h-3.5" />
                </button>
              </form>
            </div>
          )}

          {/* TAB 3: Konsola (Terminal STDOUT/STDERR) */}
          {activeTab === 'console' && (
            <div className="h-full flex flex-col font-mono text-xs bg-zinc-950">
              {/* Console Status Bar */}
              <div className="px-3 py-1.5 border-b border-zinc-900 bg-zinc-900/40 flex items-center justify-between text-[11px] text-zinc-400">
                <div className="flex items-center gap-2">
                  <span>Profil: <strong className="text-zinc-200">{activeRun?.profileName || 'Brak aktywnego procesu'}</strong></span>
                  {activeRun && (
                    <span
                      className={`px-1.5 py-0.2 rounded font-semibold ${
                        activeRun.status === 'RUNNING'
                          ? 'bg-blue-950 text-blue-300 border border-blue-800 animate-pulse'
                          : activeRun.status === 'SUCCEEDED'
                          ? 'bg-emerald-950 text-emerald-300 border border-emerald-800'
                          : activeRun.status === 'FAILED'
                          ? 'bg-rose-950 text-rose-300 border border-rose-800'
                          : 'bg-zinc-800 text-zinc-400'
                      }`}
                    >
                      {activeRun.status}
                    </span>
                  )}
                  {activeRun?.exitCode !== undefined && (
                    <span>exit: {activeRun.exitCode}</span>
                  )}
                </div>

                <div className="flex items-center gap-2">
                  {activeRun?.testOutcome && (
                    <span className="text-[10px]">
                      Testy: <strong className={activeRun.testOutcome === 'PASSED' ? 'text-emerald-400' : activeRun.testOutcome === 'FAILED' ? 'text-rose-400' : 'text-zinc-400'}>
                        {activeRun.testOutcome}
                      </strong>
                    </span>
                  )}
                  {activeRun?.workspaceChangedDuringRun && (
                    <span className="text-amber-400 text-[10px]">⚠️ Pliki zmienione w trakcie</span>
                  )}
                </div>
              </div>

              {/* Logs Stream */}
              <div className="flex-1 overflow-y-auto p-3 space-y-1 text-zinc-300">
                {activeRun?.logs && activeRun.logs.length > 0 ? (
                  activeRun.logs.map((log) => (
                    <div
                      key={log.id}
                      className={`leading-relaxed whitespace-pre-wrap ${
                        log.type === 'STDERR'
                          ? 'text-rose-400'
                          : log.type === 'SYSTEM'
                          ? 'text-cyan-400'
                          : 'text-zinc-300'
                      }`}
                    >
                      {log.text}
                    </div>
                  ))
                ) : (
                  <div className="text-zinc-600 italic py-4 text-center">
                    Brak danych wyjściowych konsoli. Kliknij "▶ Run Main" lub "✔ Run Tests" na górnym pasku, aby uruchomić program.
                  </div>
                )}
                <div ref={consoleBottomRef} />
              </div>
            </div>
          )}

          {/* TAB 4: Raport */}
          {activeTab === 'report' && (
            <div className="h-full overflow-y-auto p-4 max-w-4xl mx-auto">
              <ReportHistory key={reportHistoryScope ?? 'offline'} scope={reportHistoryScope ?? null}
                source={reportHistorySource} currentReport={report} onRetryCurrent={onRetryReport} />
            </div>
          )}
        </div>
      )}
    </div>
  );
};
