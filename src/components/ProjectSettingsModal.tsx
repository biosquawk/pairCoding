/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState } from 'react';
import { ProjectSettings, TaskMode } from '../types/paircoach';
import { Bot, Code2, FileCheck, Settings, X } from 'lucide-react';

interface ProjectSettingsModalProps {
  isOpen: boolean;
  settings: ProjectSettings;
  onClose: () => void;
  onSave: (updated: ProjectSettings) => void;
}

export const ProjectSettingsModal: React.FC<ProjectSettingsModalProps> = ({
  isOpen,
  settings,
  onClose,
  onSave,
}) => {
  const [aiConsent, setAiConsent] = useState(settings.aiConsent);
  const [taskMode, setTaskMode] = useState<TaskMode>(settings.taskMode);
  const [taskFilePath, setTaskFilePath] = useState(settings.taskFilePath);
  const [reviewNotesPath, setReviewNotesPath] = useState(settings.reviewNotesPath);

  if (!isOpen) return null;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    onSave({
      ...settings,
      aiConsent,
      taskMode,
      taskFilePath,
      reviewNotesPath,
    });
    onClose();
  };

  return (
    <div className="fixed inset-0 bg-black/70 backdrop-blur-xs flex items-center justify-center z-50 p-4 select-none">
      <div className="bg-zinc-900 border border-zinc-800 rounded-xl max-w-lg w-full shadow-2xl p-5 text-zinc-200">
        <div className="flex items-center justify-between pb-3 border-b border-zinc-800">
          <div className="flex items-center gap-2 font-bold text-sm text-zinc-100">
            <Settings className="w-4 h-4 text-blue-400" />
            <span>Ustawienia Projektu i Trenera AI</span>
          </div>
          <button onClick={onClose} className="p-1 rounded hover:bg-zinc-800 text-zinc-400">
            <X className="w-4 h-4" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="py-4 space-y-4 text-xs">
          {/* AI Consent */}
          <div className="p-3 rounded-lg bg-zinc-950 border border-zinc-800 space-y-2">
            <div className="flex items-center justify-between">
              <label className="font-semibold text-zinc-200 flex items-center gap-1.5 cursor-pointer">
                <Bot className="w-4 h-4 text-purple-400" />
                <span>Zgoda na asystę Trenera AI (aiConsent)</span>
              </label>
              <input
                type="checkbox"
                checked={aiConsent}
                onChange={(e) => setAiConsent(e.target.checked)}
                className="rounded bg-zinc-900 border-zinc-700 text-blue-600 focus:ring-0"
              />
            </div>
            <p className="text-[11px] text-zinc-400">
              Umożliwia trenerowi monitorowanie pisania w czasie rzeczywistym, wyświetlanie dymków wskazówek oraz autonomiczny pokaz w edytorze.
            </p>
          </div>

          {/* Task Mode */}
          <div className="space-y-1">
            <label className="font-semibold text-zinc-300">Tryb Zadania (taskMode):</label>
            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => setTaskMode('IMPLEMENTATION')}
                className={`p-2.5 rounded-lg border flex items-center gap-2 text-left transition-all ${
                  taskMode === 'IMPLEMENTATION'
                    ? 'bg-blue-950/80 border-blue-500 text-blue-200'
                    : 'bg-zinc-950 border-zinc-800 text-zinc-400 hover:border-zinc-700'
                }`}
              >
                <Code2 className="w-4 h-4 text-cyan-400 shrink-0" />
                <div>
                  <div className="font-semibold text-xs">IMPLEMENTATION</div>
                  <div className="text-[10px] opacity-75">Pisanie algorytmu / Code Kata</div>
                </div>
              </button>

              <button
                type="button"
                onClick={() => setTaskMode('CODE_REVIEW')}
                className={`p-2.5 rounded-lg border flex items-center gap-2 text-left transition-all ${
                  taskMode === 'CODE_REVIEW'
                    ? 'bg-amber-950/80 border-amber-500 text-amber-200'
                    : 'bg-zinc-950 border-zinc-800 text-zinc-400 hover:border-zinc-700'
                }`}
              >
                <FileCheck className="w-4 h-4 text-amber-400 shrink-0" />
                <div>
                  <div className="font-semibold text-xs">CODE_REVIEW</div>
                  <div className="text-[10px] opacity-75">Przegląd kodu w review.md</div>
                </div>
              </button>
            </div>
          </div>

          {/* Paths */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-zinc-400 mb-1">Ścieżka pliku zadania:</label>
              <input
                type="text"
                value={taskFilePath}
                onChange={(e) => setTaskFilePath(e.target.value)}
                className="w-full bg-zinc-950 border border-zinc-800 rounded px-2.5 py-1.5 text-zinc-200 focus:outline-none focus:border-blue-500"
              />
            </div>
            <div>
              <label className="block text-zinc-400 mb-1">Ścieżka notatek z review:</label>
              <input
                type="text"
                value={reviewNotesPath}
                onChange={(e) => setReviewNotesPath(e.target.value)}
                className="w-full bg-zinc-950 border border-zinc-800 rounded px-2.5 py-1.5 text-zinc-200 focus:outline-none focus:border-blue-500"
              />
            </div>
          </div>

          {/* Run Profiles Info */}
          <div className="p-2.5 rounded bg-zinc-950/60 border border-zinc-800/80 text-[11px] text-zinc-400">
            <span className="font-semibold text-zinc-300">Profile wykonawcze: </span>
            {settings.runProfiles.map((p) => p.name).join(', ')}
          </div>

          <div className="flex items-center justify-end gap-2 pt-3 border-t border-zinc-800">
            <button
              type="button"
              onClick={onClose}
              className="px-3 py-1.5 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-300 text-xs"
            >
              Anuluj
            </button>
            <button
              type="submit"
              className="px-4 py-1.5 rounded bg-blue-600 hover:bg-blue-500 text-white font-semibold text-xs shadow-sm"
            >
              Zapisz Ustawienia
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
