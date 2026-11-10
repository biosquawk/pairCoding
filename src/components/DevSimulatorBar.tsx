/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import {
  AlertCircle,
  Bot,
  CheckCircle,
  HelpCircle,
  Lightbulb,
  RefreshCw,
  Send,
  Wifi,
  WifiOff,
  Zap,
} from 'lucide-react';
import { HintBubbleSeverity, ProposalType, TrainingScenario } from '../types/paircoach';
import type { TransportMode } from '../services/liveTypes';
import { MOCK_SCENARIOS } from '../data/mockScenarios';

interface DevSimulatorBarProps {
  transportMode: TransportMode;
  onTransportMode: (mode: TransportMode) => void;
  currentScenarioId: string;
  isOffline: boolean;
  onSelectScenario: (scenario: TrainingScenario) => void;
  onStartCoachDemo: () => void;
  onShowBubble: (severity: HintBubbleSeverity, text: string, line: number) => void;
  onShowPointer: (startLine: number, endLine: number) => void;
  onTriggerProposal: (type: ProposalType) => void;
  onExternalFileSync: () => void;
  onToggleOffline: () => void;
  onSimulateReportFailure: () => void;
}

export const DevSimulatorBar: React.FC<DevSimulatorBarProps> = ({
  transportMode,
  onTransportMode,
  currentScenarioId,
  isOffline,
  onSelectScenario,
  onStartCoachDemo,
  onShowBubble,
  onShowPointer,
  onTriggerProposal,
  onExternalFileSync,
  onToggleOffline,
  onSimulateReportFailure,
}) => {
  return (
    <div className="bg-amber-950/40 border-b border-amber-800/60 px-3 py-2 text-xs text-amber-200">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="font-bold text-[11px] tracking-wider uppercase text-amber-400 flex items-center gap-1">
            <Zap className="w-3.5 h-3.5 fill-amber-400" />
            Dev Simulator (Faza 1):
          </span>

          <label>Transport (zmiana przeładuje stronę):
            <select aria-label="Tryb transportu" value={transportMode} onChange={event => onTransportMode(event.target.value as TransportMode)} className="bg-zinc-900 border border-amber-700 rounded ml-2">
              <option value="LIVE_BACKEND">LIVE — rzeczywisty backend</option>
              <option value="MOCK_SIMULATOR">MOCK — jawny symulator</option>
            </select>
          </label>
          {/* Scenario Selector */}
          {transportMode === 'MOCK_SIMULATOR' && (
          <select
            value={currentScenarioId}
            onChange={(e) => {
              const sc = MOCK_SCENARIOS.find((s) => s.id === e.target.value);
              if (sc) onSelectScenario(sc);
            }}
            className="bg-zinc-900 border border-amber-700/80 rounded px-2 py-0.5 text-xs text-zinc-200 focus:outline-none"
          >
            {MOCK_SCENARIOS.map((sc) => (
              <option key={sc.id} value={sc.id}>
                {sc.title} [{sc.taskMode}]
              </option>
            ))}
          </select>)}
        </div>

        {/* Action Triggers */}
        {transportMode === 'MOCK_SIMULATOR' && <div className="flex flex-wrap items-center gap-1.5">
          {/* Coach takeover */}
          <button
            onClick={onStartCoachDemo}
            className="flex items-center gap-1 px-2 py-0.5 rounded bg-blue-900/80 hover:bg-blue-800 text-blue-200 border border-blue-700 font-medium"
            title="Rozpocznij autonomiczny pokaz trenera (pisanie na żywo w edytorze)"
          >
            <Bot className="w-3 h-3" />
            <span>Pokaz Trenera (Live Typing)</span>
          </button>

          {/* Bubbles */}
          <button
            onClick={() => onShowBubble('POSITIVE', 'Świetny krok! Prawidłowo przewidujesz potrzebę optymalizacji struktury.', 4)}
            className="flex items-center gap-1 px-2 py-0.5 rounded bg-emerald-950 hover:bg-emerald-900 text-emerald-300 border border-emerald-700"
            title="Dymek: Dobry kierunek (POSITIVE)"
          >
            <CheckCircle className="w-3 h-3 text-emerald-400" />
            <span>Dymek +</span>
          </button>

          <button
            onClick={() => onShowBubble('NEUTRAL', 'Wskazówka: Zastanów się, czy tablica asocjacyjna Map nie zmniejszy złożoności do O(N).', 8)}
            className="flex items-center gap-1 px-2 py-0.5 rounded bg-yellow-950 hover:bg-yellow-900 text-yellow-300 border border-yellow-700"
            title="Dymek: Wskazówka (NEUTRAL)"
          >
            <Lightbulb className="w-3 h-3 text-yellow-400" />
            <span>Dymek ?</span>
          </button>

          <button
            onClick={() => {
              onShowPointer(6, 12);
              onShowBubble('WARNING', 'Uwaga: Ta podwójna pętla ma złożoność O(N²). Testy wydajnościowe na 10k elementów zwrócą Timeout!', 7);
            }}
            className="flex items-center gap-1 px-2 py-0.5 rounded bg-red-950 hover:bg-red-900 text-red-300 border border-red-700"
            title="Wskaźnik kodu + Dymek ostrzegawczy (WARNING)"
          >
            <AlertCircle className="w-3 h-3 text-red-400" />
            <span>Wskaźnik + Dymek !</span>
          </button>

          {/* Proposal trigger */}
          <button
            onClick={() => onTriggerProposal('RESTORE_SNAPSHOT')}
            className="flex items-center gap-1 px-2 py-0.5 rounded bg-purple-950 hover:bg-purple-900 text-purple-300 border border-purple-700"
            title="Wyślij kartę propozycji Tak/Nie (ACTION_PROPOSAL)"
          >
            <HelpCircle className="w-3 h-3 text-purple-400" />
            <span>Karta Propozycji</span>
          </button>

          {/* External conflict */}
          <button
            onClick={onExternalFileSync}
            className="flex items-center gap-1 px-2 py-0.5 rounded bg-zinc-900 hover:bg-zinc-800 text-zinc-300 border border-zinc-700"
            title="Symuluj zewnętrzną zmianę pliku na dysku (EXTERNAL_FILE_SYNC)"
          >
            <RefreshCw className="w-3 h-3" />
            <span>Zewnętrzny plik</span>
          </button>

          {/* Offline toggle */}
          <button
            onClick={onToggleOffline}
            className={`flex items-center gap-1 px-2 py-0.5 rounded border ${
              isOffline
                ? 'bg-red-900/80 text-red-200 border-red-600'
                : 'bg-zinc-900 hover:bg-zinc-800 text-zinc-300 border-zinc-700'
            }`}
            title="Włącz/wyłącz symulację braku połączenia (status szary)"
          >
            {isOffline ? <WifiOff className="w-3 h-3" /> : <Wifi className="w-3 h-3" />}
            <span>{isOffline ? 'Offline (Szary)' : 'Online'}</span>
          </button>

          {/* Report failure */}
          <button
            onClick={onSimulateReportFailure}
            className="px-2 py-0.5 rounded bg-zinc-900 hover:bg-zinc-800 text-zinc-400 border border-zinc-700 text-[11px]"
            title="Zakończ z błędem generowania raportu (test przycisku Ponów)"
          >
            Błąd Raportu
          </button>
        </div>}
      </div>
    </div>
  );
};
