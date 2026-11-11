/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useState, useRef } from 'react';
import { ProjectSettings, SnapshotItem, TaskMode } from '../types/paircoach';
import { parseRunProfiles, parseContextPatterns } from '../services/settingsValidation';
import { Bot, Code2, FileCheck, RotateCcw, Settings, X } from 'lucide-react';

interface ProjectSettingsModalProps {
  settingsVersion?:number; connected?:boolean; canSave?:boolean; onOpenRuntimeSettings?:()=>void;
  isOpen: boolean;
  settings: ProjectSettings;
  snapshots?: SnapshotItem[];
  snapshotsError?: string | null;
  rootPath?: string;
  onOpenProject?: (rootPath: string) => Promise<boolean>;
  onClose: () => void;
  onSave: (updated: ProjectSettings) => void | Promise<boolean>;
  onRestoreSnapshot?: (id: string) => void;
}

export const ProjectSettingsModal: React.FC<ProjectSettingsModalProps> = ({
  settingsVersion=0,connected=true,canSave=true,onOpenRuntimeSettings,
  isOpen,
  settings,
  snapshots = [],
  snapshotsError,
  rootPath,
  onOpenProject,
  onClose,
  onSave,
  onRestoreSnapshot,
}) => {
  const dialogRef = useRef<HTMLDivElement>(null);
  const [folderPath, setFolderPath] = useState(rootPath ?? '');
  const [opening, setOpening] = useState(false);
  const [folderError, setFolderError] = useState('');
  const [profilesJson, setProfilesJson] = useState('[]');
  const [patternsJson, setPatternsJson] = useState('[]');
  const [settingsError, setSettingsError] = useState('');
  const wasOpen=useRef(false),openingVersion=useRef(settingsVersion);
  const [saving, setSaving] = useState(false);
  useEffect(() => { if (isOpen) { setFolderPath(rootPath ?? ''); setFolderError(''); } }, [isOpen, rootPath]);
  useEffect(() => {
    if (!isOpen) return;
    const previous = document.activeElement as HTMLElement | null;
    const dialog = dialogRef.current;
    const focusable = () => Array.from(dialog?.querySelectorAll<HTMLElement>('button, input, textarea, select, [tabindex="0"]') ?? []).filter(el => !el.hasAttribute('disabled') && el.getClientRects().length > 0);
    focusable()[0]?.focus();
    const keys = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); if(!dialog?.getAttribute('aria-busy') || dialog.getAttribute('aria-busy')==='false')onClose(); }
      if (event.key !== 'Tab') return;
      const targets = focusable(), first = targets[0], last = targets[targets.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    dialog?.addEventListener('keydown', keys);
    return () => { dialog?.removeEventListener('keydown', keys); previous?.focus(); };
  }, [isOpen]);
  const [aiConsent, setAiConsent] = useState(settings.aiConsent);
  const [taskMode, setTaskMode] = useState<TaskMode>(settings.taskMode);
  const [taskFilePath, setTaskFilePath] = useState(settings.taskFilePath);
  const [reviewNotesPath, setReviewNotesPath] = useState(settings.reviewNotesPath);


  // Sync internal state whenever modal opens or external settings change
  useEffect(() => {
    if (isOpen && !wasOpen.current) {
      openingVersion.current=settingsVersion;
      setAiConsent(settings.aiConsent);
      setTaskMode(settings.taskMode);
      setTaskFilePath(settings.taskFilePath);
      setReviewNotesPath(settings.reviewNotesPath);
      setProfilesJson(JSON.stringify(settings.wireRunProfiles ?? [], null, 2));
      setPatternsJson(JSON.stringify(settings.contextPatterns ?? [], null, 2));
      setSettingsError('');

    }
    wasOpen.current=isOpen;
  }, [isOpen, settings,settingsVersion]);

  if (!isOpen) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault(); setSettingsError('');
    if(saving || !connected || !canSave || openingVersion.current!==settingsVersion) {setSettingsError('Sesja, uprawnienia lub wersja zmieniły się. Zachowano formularz.');return;}
    try {
      const wireRunProfiles = onOpenRuntimeSettings ? settings.wireRunProfiles : parseRunProfiles(profilesJson);
      const contextPatterns = parseContextPatterns(patternsJson);
      setSaving(true);
      const accepted = await onSave({ ...settings, aiConsent, taskMode, taskFilePath, reviewNotesPath, wireRunProfiles, contextPatterns });
      if (accepted === false) setSettingsError('Serwer nie potwierdził ustawień. Sprawdź błąd połączenia u góry; formularz pozostaje otwarty.');
      else onClose();
    } catch (error) { setSettingsError(error instanceof Error ? error.message : 'Niepoprawne ustawienia.'); }
    finally { setSaving(false); }
  };

  return (
    <div className="fixed inset-0 bg-black/70 backdrop-blur-xs flex items-center justify-center z-50 p-4 select-none">
      <div ref={dialogRef} aria-busy={saving} role="dialog" aria-modal="true" aria-label="Ustawienia Projektu i Trenera AI" className="bg-zinc-900 border border-zinc-800 rounded-xl max-w-lg max-h-[90vh] overflow-y-auto w-full shadow-2xl p-5 text-zinc-200">
        <div className="flex items-center justify-between pb-3 border-b border-zinc-800">
          <div className="flex items-center gap-2 font-bold text-sm text-zinc-100">
            <Settings className="w-4 h-4 text-blue-400" />
            <span>Ustawienia Projektu i Trenera AI</span>
          </div>
          <button aria-label="Zamknij ustawienia" onClick={onClose} className="p-1 rounded hover:bg-zinc-800 text-zinc-400">
            <X className="w-4 h-4" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="py-4 space-y-4 text-xs">
          {onOpenProject && <fieldset disabled={opening || saving || !connected || !canSave || openingVersion.current!==settingsVersion} className="p-3 rounded bg-zinc-950 border border-zinc-800 space-y-2">
            <label htmlFor="project-folder" className="block font-semibold">Lokalny folder zadania</label>
            <input id="project-folder" value={folderPath} onChange={event => setFolderPath(event.target.value)} className="w-full bg-zinc-900 border border-zinc-700 rounded px-2 py-1" placeholder="C:/Zadania/kata" />
            <p className="text-zinc-400">Pełna ścieżka na komputerze serwera. Nowy folder: plik challenge.md, zgoda AI wyłączona, bez odziedziczonych poleceń uruchamiania. Najpierw potwierdzimy autosave; konflikt blokuje otwarcie.</p>
            <button type="button" className="px-3 py-1.5 bg-blue-700 rounded" onClick={async () => {
              if (!folderPath.trim()) { setFolderError('Podaj ścieżkę lokalnego folderu.'); return; }
              setOpening(true); setFolderError('');
              try { if (await onOpenProject(folderPath.trim())) onClose(); else setFolderError('Nie otwarto folderu. Sprawdź błąd połączenia lub rozstrzygnij draft.'); }
              finally { setOpening(false); }
            }}>{opening ? 'Otwieranie…' : 'Otwórz wskazany folder'}</button>
            {folderError && <p role="alert" className="text-amber-300">{folderError}</p>}
          </fieldset>}
          {/* AI Consent */}
          <div className="p-3 rounded-lg bg-zinc-950 border border-zinc-800 space-y-2">
            <div className="flex items-center justify-between">
              <label htmlFor="ai-consent" className="font-semibold text-zinc-200 flex items-center gap-1.5 cursor-pointer">
                <Bot className="w-4 h-4 text-purple-400" />
                <span>Zgoda na asystę Trenera AI (aiConsent)</span>
              </label>
              <input
                id="ai-consent"
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
              <label htmlFor="task-file" className="block text-zinc-400 mb-1">Ścieżka pliku zadania:</label>
              <input
                id="task-file"
                type="text"
                value={taskFilePath}
                onChange={(e) => setTaskFilePath(e.target.value)}
                className="w-full bg-zinc-950 border border-zinc-800 rounded px-2.5 py-1.5 text-zinc-200 focus:outline-none focus:border-blue-500"
              />
            </div>
            <div>
              <label htmlFor="review-file" className="block text-zinc-400 mb-1">Ścieżka notatek z review:</label>
              <input
                id="review-file"
                type="text"
                value={reviewNotesPath}
                onChange={(e) => setReviewNotesPath(e.target.value)}
                className="w-full bg-zinc-950 border border-zinc-800 rounded px-2.5 py-1.5 text-zinc-200 focus:outline-none focus:border-blue-500"
              />
            </div>
          </div>

          {onOpenRuntimeSettings && <button type="button" className="underline" onClick={onOpenRuntimeSettings}>Ustawienia wykonania V2</button>}
          {/* Run Profiles Info */}
          <div className="p-2.5 rounded bg-zinc-950/60 border border-zinc-800/80 text-[11px] text-zinc-400">
            <p>{onOpenRuntimeSettings ? 'Uruchomienia wymagają jawnej konfiguracji V2 i gotowego środowiska. Brak gotowości nie blokuje ręcznej edycji.' : 'Jawny tryb developerskiej symulacji.'}</p><span className="font-semibold text-zinc-300">Profile wykonawcze: </span>
            {settings.runProfiles.map((p) => p.name).join(', ')}
          </div>

          <details className="p-3 rounded bg-zinc-950 border border-zinc-800">
            <summary className="cursor-pointer font-semibold">Konfiguracja Run/Test i kontekstu AI</summary>
            {!onOpenRuntimeSettings ? <><label htmlFor="run-profiles" className="block mb-1">Profile symulacji (JSON)</label>
            <textarea id="run-profiles" value={profilesJson} onChange={event=>setProfilesJson(event.target.value)} spellCheck={false} className="w-full h-48 bg-zinc-900 border border-zinc-700 rounded p-2 font-mono text-xs" /></> :
              <p>Program i testy edytuj przez „Ustawienia wykonania V2”. Stare lub nieznane ustawienia zachowujemy bez automatycznego przenoszenia poleceń. Jeśli serwer nie dostarczył szkicu migracji, zachowaj kopię istniejącego pliku ustawień i przygotuj jawny plik schemaVersion 2 zgodnie z dokumentacją profilu, następnie uruchom ponownie projekt.</p>}
            <label htmlFor="context-patterns" className="block mb-1 mt-3">Wzorce plików kontekstu AI (JSON)</label>
            <textarea id="context-patterns" value={patternsJson} onChange={event => setPatternsJson(event.target.value)} spellCheck={false} className="w-full h-24 bg-zinc-900 border border-zinc-700 rounded p-2 font-mono text-xs" />
            <p className="text-zinc-500">Np. ["**/*.ts", "**/*.md"]. Bez zgody AI nic nie jest wysyłane. Sekrety są wykluczone niezależnie od wzorców.</p>
          </details>
          {settingsError && <p role="alert" className="text-amber-300">{settingsError}</p>}

          {/* Kopie odzyskiwania (Snapshots) */}
          <div className="p-3 rounded-lg bg-zinc-950 border border-zinc-800 space-y-2">
            <div className="flex items-center justify-between">
              <label className="font-semibold text-zinc-200 flex items-center gap-1.5">
                <RotateCcw className="w-3.5 h-3.5 text-blue-400" />
                <span>Kopie odzyskiwania (Snapshots)</span>
              </label>
              <span className="text-[10px] text-zinc-500 font-mono">
                {snapshots.length} {snapshots.length === 1 ? 'kopia' : 'kopii'}
              </span>
            </div>

            {snapshotsError && <p role="alert" className="text-amber-300">Nie można pobrać kopii: {snapshotsError}</p>}
            {snapshots.length === 0 ? (
              <p className="text-[11px] text-zinc-500 italic">Brak zapisanych migawek stanu projektu.</p>
            ) : (
              <div className="max-h-36 overflow-y-auto space-y-1.5 pr-1">
                {snapshots.map((snap) => (
                  <div
                    key={snap.id}
                    className="flex items-center justify-between p-2 rounded bg-zinc-900/90 border border-zinc-800/80 text-[11px] hover:border-zinc-700 transition-colors"
                  >
                    <div className="min-w-0 flex-1 pr-2">
                      <div className="font-medium text-zinc-200 truncate">{snap.label}</div>
                      <div className="text-[10px] text-zinc-500 font-mono">
                        {new Date(snap.timestamp).toLocaleTimeString()} · {snap.files.length} plików
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => {
                        onRestoreSnapshot?.(snap.id);
                        onClose(); // Actual restore requires a server proposal and explicit confirmation.
                      }}
                      className="px-2.5 py-1 rounded text-xs font-semibold shrink-0 bg-zinc-800 hover:bg-blue-600 text-zinc-200 border border-zinc-700"
                    >
                      <RotateCcw className="w-3 h-3" />
                      Poproś o przywrócenie
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>

          {(!connected || !canSave || openingVersion.current!==settingsVersion) && <p role="alert">Zapis niedostępny: offline, brak uprawnienia lub konflikt wersji. Zachowano formularz; skopiuj pola przed odświeżeniem.</p>}
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
              disabled={opening || saving || !connected || !canSave || openingVersion.current!==settingsVersion}
              className="px-4 py-1.5 rounded bg-blue-600 hover:bg-blue-500 text-white font-semibold text-xs shadow-sm"
            >
              {saving ? 'Zapisywanie…' : 'Zapisz Ustawienia'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
