/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useRef, useState } from 'react';
import Editor, { Monaco, OnMount } from '@monaco-editor/react';
import type * as monacoType from 'monaco-editor';
import { client } from '../services/PairCoachClient';
import {
  ActionProposal,
  CoachEditStep,
  CoachHintBubble,
  CoachPointer,
  FileConflict,
  ProjectFile,
  WriteOwner,
} from '../types/paircoach';
import {
  AlertTriangle,
  Bot,
  CheckCircle2,
  GripHorizontal,
  Info,
  Lightbulb,
  ShieldAlert,
  X,
} from 'lucide-react';

interface EditorPanelProps {
  files: ProjectFile[];
  openTabs: string[];
  activePath: string;
  writeOwner: WriteOwner;
  controlEpoch: number;
  fileConflict: FileConflict | null;
  activePointer: CoachPointer | null;
  activeHintBubble: CoachHintBubble | null;
  activeProposal: ActionProposal | null;
  isBottomPanelVisible: boolean;
  activeBottomTab: string;
  onSelectTab: (path: string) => void;
  onCloseTab: (path: string) => void;
  onContentChange: (path: string, content: string) => void;
  onDismissBubble: () => void;
  onBubblePosChange: (x: number, y: number) => void;
  onProposalResponse: (proposalId: string, accept: boolean) => void;
  onResolveConflict: (choice: 'KEEP_LOCAL' | 'LOAD_DISK') => void;
}

export const EditorPanel: React.FC<EditorPanelProps> = ({
  files,
  openTabs,
  activePath,
  writeOwner,
  controlEpoch,
  fileConflict,
  activePointer,
  activeHintBubble,
  activeProposal,
  isBottomPanelVisible,
  activeBottomTab,
  onSelectTab,
  onCloseTab,
  onContentChange,
  onDismissBubble,
  onBubblePosChange,
  onProposalResponse,
  onResolveConflict,
}) => {
  const editorRef = useRef<monacoType.editor.IStandaloneCodeEditor | null>(null);
  const monacoRef = useRef<Monaco | null>(null);
  const isApplyingCoachStepRef = useRef(false);
  const decorationsRef = useRef<string[]>([]);
  const viewStatesRef = useRef<Map<string, monacoType.editor.ICodeEditorViewState | null>>(new Map());

  // Bubble dragging state
  const [bubblePos, setBubblePos] = useState<{ x: number; y: number }>({ x: 20, y: 40 });
  const [isDraggingBubble, setIsDraggingBubble] = useState(false);
  const dragStartRef = useRef<{ mouseX: number; mouseY: number; startX: number; startY: number }>({
    mouseX: 0,
    mouseY: 0,
    startX: 0,
    startY: 0,
  });

  const [selectionNotice, setSelectionNotice] = useState<string | null>(null);

  const activeFile = files.find((f) => f.path === activePath);

  // Helper to map file extensions to Monaco language IDs
  const getLanguageForPath = (path: string): string => {
    if (path.endsWith('.java')) return 'java';
    if (path.endsWith('.py')) return 'python';
    if (path.endsWith('.js') || path.endsWith('.mjs') || path.endsWith('.cjs')) return 'javascript';
    if (path.endsWith('.ts') || path.endsWith('.tsx')) return 'typescript';
    if (path.endsWith('.md') || path.endsWith('.markdown')) return 'markdown';
    if (path.endsWith('.json')) return 'json';
    if (path.endsWith('.html')) return 'html';
    if (path.endsWith('.css')) return 'css';
    return 'plaintext';
  };

  // Handle Monaco Editor mount
  const handleEditorMount: OnMount = (editor, monaco) => {
    editorRef.current = editor;
    monacoRef.current = monaco;

    // Define custom themes or subtle decorations
    monaco.editor.defineTheme('paircoach-dark', {
      base: 'vs-dark',
      inherit: true,
      rules: [
        { token: 'comment', foreground: '6b7280', fontStyle: 'italic' },
        { token: 'keyword', foreground: '60a5fa' },
        { token: 'string', foreground: '34d399' },
        { token: 'number', foreground: 'f59e0b' },
      ],
      colors: {
        'editor.background': '#09090b', // zinc-950
        'editor.foreground': '#f4f4f5',
        'editorLineNumber.foreground': '#52525b',
        'editorLineNumber.activeForeground': '#a1a1aa',
        'editor.selectionBackground': '#1e3a5f80',
        'editor.inactiveSelectionBackground': '#1e293b60',
      },
    });

    monaco.editor.setTheme('paircoach-dark');
  };

  // Switch models cleanly between tabs, preserving viewState & undo stack
  useEffect(() => {
    const editor = editorRef.current;
    const monaco = monacoRef.current;
    if (!editor || !monaco || !activeFile) return;

    const uri = monaco.Uri.parse(`file:///${activeFile.path}`);
    let model = monaco.editor.getModel(uri);

    if (!model) {
      model = monaco.editor.createModel(activeFile.content, getLanguageForPath(activeFile.path), uri);
    } else {
      // Model exists; ensure language is correct
      monaco.editor.setModelLanguage(model, getLanguageForPath(activeFile.path));
      // Item 3: Synchronize model if content changed from external file sync or snapshot restore
      if (model.getValue() !== activeFile.content && !isApplyingCoachStepRef.current) {
        isApplyingCoachStepRef.current = true;
        try {
          model.setValue(activeFile.content);
        } finally {
          isApplyingCoachStepRef.current = false;
        }
      }
    }

    if (editor.getModel() !== model) {
      // Save view state of current model
      const currentModel = editor.getModel();
      if (currentModel) {
        const currentPath = currentModel.uri.path.replace(/^\//, '');
        viewStatesRef.current.set(currentPath, editor.saveViewState());
      }

      editor.setModel(model);

      // Restore view state if previously saved
      const savedState = viewStatesRef.current.get(activeFile.path);
      if (savedState) {
        editor.restoreViewState(savedState);
      }
    }
  }, [activePath, activeFile]);

  // Item 2: Close Undo stack boundary immediately upon Veto
  useEffect(() => {
    const unsubVeto = client.onVetoExecuted(() => {
      const editor = editorRef.current;
      if (editor) {
        const model = editor.getModel();
        model?.pushStackElement();
      }
    });
    return unsubVeto;
  }, []);

  // Subscribe to Coach Step Edits directly on Monaco model
  useEffect(() => {
    const unsubStep = client.onCoachStep((step: CoachEditStep) => {
      const editor = editorRef.current;
      const monaco = monacoRef.current;
      if (!editor || !monaco) return;

      // Item 4: Reject late coach steps where controlEpoch does not match currentControlEpoch (TEST-010)
      if (step.controlEpoch !== undefined && step.controlEpoch !== controlEpoch) {
        console.warn(
          `[PairCoach] Odrzucono spóźniony krok trenera (step.controlEpoch=${step.controlEpoch} !== currentControlEpoch=${controlEpoch})`
        );
        return;
      }

      const model = editor.getModel();
      if (!model) return;

      const modelPath = model.uri.path.replace(/^\//, '');
      if (modelPath !== step.path) return;

      // Check if step intersects with user's current selection
      const currentSelection = editor.getSelection();
      const stepRange = new monaco.Range(
        step.range.startLine,
        step.range.startColumn,
        step.range.endLine,
        step.range.endColumn
      );

      if (currentSelection && !currentSelection.isEmpty()) {
        if (monaco.Range.intersectRanges(currentSelection, stepRange)) {
          // Clear outdated selection & show subtle note
          editor.setSelection(new monaco.Selection(step.range.endLine, 1, step.range.endLine, 1));
          setSelectionNotice('Trener AI zaktualizował czytany przez Ciebie fragment kodu.');
          setTimeout(() => setSelectionNotice(null), 3500);
        }
      }

      // Grouping undo stack: before step 1
      if (step.stepIndex === 1) {
        model.pushStackElement();
      }

      isApplyingCoachStepRef.current = true;
      try {
        model.pushEditOperations(
          [],
          [
            {
              range: stepRange,
              text: step.text,
              forceMoveMarkers: true,
            },
          ],
          () => null
        );

        // Grouping undo stack: after last step
        if (step.stepIndex === step.totalSteps) {
          model.pushStackElement();
        }

        // Keep file content synchronized in state without dispatching CODE_CHANGED
        onContentChange(step.path, model.getValue());
      } finally {
        isApplyingCoachStepRef.current = false;
      }
    });

    return unsubStep;
  }, [activePath, controlEpoch, onContentChange]);

  // Handle readOnly property based on writeOwner
  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;

    if (writeOwner === 'COACH') {
      // Block all mutations, but allow mouse selection, scroll, and copy Ctrl+C!
      editor.updateOptions({
        readOnly: true,
        domReadOnly: false,
      });
    } else {
      editor.updateOptions({
        readOnly: false,
        domReadOnly: false,
      });
    }
  }, [writeOwner]);

  // Handle Coach Pointer highlighting
  useEffect(() => {
    const editor = editorRef.current;
    const monaco = monacoRef.current;
    if (!editor || !monaco) return;

    if (activePointer && activePointer.path === activePath && !activePointer.clear) {
      const newDecorations = [
        {
          range: new monaco.Range(
            activePointer.startLine,
            activePointer.startColumn || 1,
            activePointer.endLine,
            activePointer.endColumn || 100
          ),
          options: {
            isWholeLine: true,
            className: 'bg-blue-500/20 border-l-4 border-blue-500',
            glyphMarginClassName: 'bg-blue-500 rounded-full',
            hoverMessage: { value: '**Wskaźnik Trenera AI**' },
          },
        },
      ];
      decorationsRef.current = editor.deltaDecorations(decorationsRef.current, newDecorations);
    } else {
      decorationsRef.current = editor.deltaDecorations(decorationsRef.current, []);
    }
  }, [activePointer, activePath]);

  // Bubble dragging handlers
  const handleMouseDown = (e: React.MouseEvent) => {
    setIsDraggingBubble(true);
    dragStartRef.current = {
      mouseX: e.clientX,
      mouseY: e.clientY,
      startX: bubblePos.x,
      startY: bubblePos.y,
    };
  };

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!isDraggingBubble) return;
      const dx = e.clientX - dragStartRef.current.mouseX;
      const dy = e.clientY - dragStartRef.current.mouseY;
      // Item 1: Correct formula for right-anchored position (dx > 0 reduces right, moving element right)
      const newX = Math.max(10, Math.min(window.innerWidth - 390, dragStartRef.current.startX - dx));
      const newY = Math.max(10, Math.min(window.innerHeight - 200, dragStartRef.current.startY + dy));
      setBubblePos({ x: newX, y: newY });
      onBubblePosChange(newX, newY);
    };

    const handleMouseUp = () => {
      if (isDraggingBubble) {
        setIsDraggingBubble(false);
      }
    };

    if (isDraggingBubble) {
      window.addEventListener('mousemove', handleMouseMove);
      window.addEventListener('mouseup', handleMouseUp);
    }
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, [isDraggingBubble]);

  // Frame styling based on WriteOwner (4px solid)
  const getBorderColor = () => {
    if (writeOwner === 'STUDENT') return 'border-red-600'; // #ef4444
    if (writeOwner === 'COACH') return 'border-blue-500'; // #3b82f6
    return 'border-zinc-500'; // #6b7280 (syncing/offline)
  };

  const shouldShowFloatingProposal =
    activeProposal && (!isBottomPanelVisible || activeBottomTab !== 'chat');

  return (
    <div className={`h-full flex flex-col bg-zinc-950 border-[4px] ${getBorderColor()} transition-colors duration-200 relative`}>
      {/* Tabs Header */}
      <div className="flex items-center justify-between bg-zinc-950 border-b border-zinc-800 px-2 py-1 select-none overflow-x-auto">
        <div className="flex items-center gap-1 min-w-0">
          {openTabs.map((tabPath) => {
            const isActive = tabPath === activePath;
            const fileName = tabPath.split('/').pop() || tabPath;
            return (
              <div
                key={tabPath}
                onClick={() => onSelectTab(tabPath)}
                className={`flex items-center gap-2 px-3 py-1 text-xs rounded-t cursor-pointer border-t-2 transition-all ${
                  isActive
                    ? 'bg-zinc-900 text-zinc-100 border-blue-500 font-semibold'
                    : 'bg-zinc-950/60 text-zinc-400 border-transparent hover:bg-zinc-900/40 hover:text-zinc-200'
                }`}
              >
                <span className="truncate max-w-[140px]">{fileName}</span>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    onCloseTab(tabPath);
                  }}
                  className="p-0.5 rounded hover:bg-zinc-800 text-zinc-500 hover:text-zinc-300"
                  title="Zamknij zakładkę (plik pozostaje w projekcie)"
                >
                  <X className="w-3 h-3" />
                </button>
              </div>
            );
          })}
        </div>

        {/* Right Tab Status Label */}
        <div className="text-[11px] px-2 py-0.5 font-mono hidden sm:flex items-center gap-2">
          {writeOwner === 'COACH' ? (
            <span className="text-blue-400 font-semibold animate-pulse flex items-center gap-1">
              <Bot className="w-3.5 h-3.5" />
              Pisze Trener AI
            </span>
          ) : writeOwner === 'STUDENT' ? (
            <span className="text-red-400 font-medium">Tryb ucznia (Piszesz Ty)</span>
          ) : (
            <span className="text-zinc-400">Synchronizacja...</span>
          )}
        </div>
      </div>

      {/* Conflict Banner (Item 3) */}
      {fileConflict && fileConflict.path === activePath && (
        <div className="bg-amber-950/95 border-b-2 border-amber-500 px-4 py-2 flex flex-wrap items-center justify-between gap-3 text-xs text-amber-200 z-30 shadow-lg">
          <div className="flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0" />
            <span>
              <strong>Konflikt synchronizacji:</strong> Plik na dysku uległ zmianie, ale posiadasz lokalny niepotwierdzony draft.
            </span>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => onResolveConflict('KEEP_LOCAL')}
              className="px-3 py-1 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-100 border border-zinc-600 font-medium text-xs transition-colors"
            >
              Zachowaj mój lokalny draft
            </button>
            <button
              onClick={() => onResolveConflict('LOAD_DISK')}
              className="px-3 py-1 rounded bg-amber-600 hover:bg-amber-500 text-white font-semibold text-xs shadow transition-colors"
            >
              Załaduj wersję z dysku
            </button>
          </div>
        </div>
      )}

      {/* Editor Body */}
      <div className="flex-1 relative overflow-hidden">
        {activeFile ? (
          <Editor
            height="100%"
            path={activeFile.path}
            defaultLanguage={getLanguageForPath(activeFile.path)}
            value={activeFile.content}
            theme="paircoach-dark"
            onMount={handleEditorMount}
            onChange={(newVal) => {
              if (!isApplyingCoachStepRef.current && newVal !== undefined) {
                onContentChange(activePath, newVal);
              }
            }}
            options={{
              minimap: { enabled: false },
              fontSize: 13,
              fontFamily: "'JetBrains Mono', 'Fira Code', 'Consolas', monospace",
              fontLigatures: true,
              lineNumbers: 'on',
              scrollBeyondLastLine: false,
              automaticLayout: true,
              tabSize: 2,
              wordWrap: 'on',
              glyphMargin: true,
              cursorBlinking: writeOwner === 'COACH' ? 'solid' : 'blink',
              renderLineHighlight: 'line',
              overviewRulerBorder: false,
              hideCursorInOverviewRuler: true,
            }}
          />
        ) : (
          <div className="h-full flex items-center justify-center text-zinc-500 text-sm">
            Brak otwartego pliku. Wybierz plik z drzewa po lewej stronie.
          </div>
        )}

        {/* Selection intersection warning note */}
        {selectionNotice && (
          <div className="absolute top-2 left-1/2 -translate-x-1/2 bg-amber-950/90 border border-amber-600 text-amber-200 text-xs px-3 py-1.5 rounded shadow-lg flex items-center gap-2 animate-fade-in z-20">
            <Info className="w-4 h-4 text-amber-400" />
            <span>{selectionNotice}</span>
          </div>
        )}

        {/* Coach Hint Bubble (Draggable, max 400 chars, 3 severities) */}
        {activeHintBubble && activeHintBubble.path === activePath && (
          <div
            style={{
              position: 'absolute',
              top: `${bubblePos.y}px`,
              right: `${bubblePos.x}px`,
              zIndex: 30,
              maxWidth: '380px',
            }}
            className={`rounded-lg shadow-2xl border text-xs p-3 transition-shadow select-none ${
              activeHintBubble.severity === 'POSITIVE'
                ? 'bg-emerald-950/95 border-emerald-600 text-emerald-100 shadow-emerald-950/50'
                : activeHintBubble.severity === 'WARNING'
                ? 'bg-rose-950/95 border-rose-600 text-rose-100 shadow-rose-950/50'
                : 'bg-yellow-950/95 border-yellow-600 text-yellow-100 shadow-yellow-950/50'
            }`}
          >
            {/* Handle & Close Header */}
            <div
              onMouseDown={handleMouseDown}
              className="flex items-center justify-between pb-1.5 mb-1.5 border-b border-white/10 cursor-move"
            >
              <div className="flex items-center gap-1.5 font-bold tracking-wide text-[11px]">
                {activeHintBubble.severity === 'POSITIVE' && (
                  <>
                    <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />
                    <span className="text-emerald-300">Dobry kierunek</span>
                  </>
                )}
                {activeHintBubble.severity === 'NEUTRAL' && (
                  <>
                    <Lightbulb className="w-3.5 h-3.5 text-yellow-400" />
                    <span className="text-yellow-300">Wskazówka trenera</span>
                  </>
                )}
                {activeHintBubble.severity === 'WARNING' && (
                  <>
                    <AlertTriangle className="w-3.5 h-3.5 text-rose-400" />
                    <span className="text-rose-300">Uwaga / Ryzyko błędu</span>
                  </>
                )}
                <span className="opacity-60 text-[10px] ml-1 font-normal">(linia {activeHintBubble.line})</span>
              </div>

              <div className="flex items-center gap-1">
                <GripHorizontal className="w-3.5 h-3.5 opacity-50" />
                <button
                  onClick={onDismissBubble}
                  className="p-0.5 rounded hover:bg-black/30 text-white/70 hover:text-white"
                  title="Zamknij dymek"
                >
                  <X className="w-3 h-3" />
                </button>
              </div>
            </div>

            {/* Bubble Content */}
            <div className="text-xs leading-relaxed select-text font-sans">
              {activeHintBubble.text}
            </div>
          </div>
        )}

        {/* Floating Action Proposal (if bottom panel collapsed or not on Chat) */}
        {shouldShowFloatingProposal && (
          <div className="absolute bottom-4 right-4 max-w-md bg-zinc-900 border-2 border-purple-500 rounded-lg p-3 shadow-2xl z-30 animate-in fade-in slide-in-from-bottom-2 text-zinc-100">
            <div className="flex items-center gap-2 mb-1.5 text-purple-400 font-bold text-xs">
              <Bot className="w-4 h-4" />
              <span>Szybka Decyzja Trenera</span>
            </div>
            <p className="text-xs text-zinc-200 mb-3">{activeProposal.questionText}</p>
            <div className="flex items-center gap-2">
              <button
                onClick={() => {
                  onProposalResponse(activeProposal.id, true);
                  editorRef.current?.focus();
                }}
                className="px-3 py-1.5 rounded bg-purple-600 hover:bg-purple-500 text-white font-semibold text-xs shadow transition-all"
              >
                {activeProposal.yesLabel}
              </button>
              <button
                onClick={() => {
                  onProposalResponse(activeProposal.id, false);
                  editorRef.current?.focus();
                }}
                className="px-3 py-1.5 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-300 text-xs transition-all"
              >
                {activeProposal.noLabel}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
