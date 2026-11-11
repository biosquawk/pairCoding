import '../shared/monacoSetup';
/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import Editor, { Monaco, OnMount } from '@monaco-editor/react';
import type * as monacoType from 'monaco-editor';
import { MonacoLspBridge, SAFE_SUGGEST_OPTIONS, disableNativeCompletionProviders, toModelUri, fromModelUri, normalizeContent, type EditorLanguageBinding } from '../services/monacoLspBridge';
import { observeMonacoViewP2 } from '../services/editorViewP2';
import { CoachHintBubble as HintBubble } from './CoachHintBubble';
import type { HintRect } from './hintBubbleGeometryP2';
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
  Info,
  ShieldAlert,
  X,
} from 'lucide-react';

export interface EditorPanelProps {
  /** Optional wave1 injection; transport owner must provide the synchronous pre-CONTROL_PREPARE hook. */
  languageBinding?: EditorLanguageBinding;
  projectId: string;
  files: ProjectFile[];
  openTabs: string[];
  activePath: string;
  writeOwner: WriteOwner;
  isOffline?: boolean;
  pendingPaths?: string[];
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
  projectId,
  languageBinding,
  files,
  openTabs,
  activePath,
  writeOwner,
  isOffline,
  pendingPaths = [],
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
  const languageBridgeRef = useRef<MonacoLspBridge | null>(null);
  const editorRef = useRef<monacoType.editor.IStandaloneCodeEditor | null>(null);
  const monacoRef = useRef<Monaco | null>(null);
  const isApplyingCoachStepRef = useRef(false);
  const [editorGeneration, setEditorGeneration] = useState(0);
  const interventionModelsRef = useRef(new Map<string, monacoType.editor.ITextModel>());
  const decorationsRef = useRef<string[]>([]);
  const viewStatesRef = useRef<Map<string, monacoType.editor.ICodeEditorViewState | null>>(new Map());

  const contentContainerRef = useRef<HTMLDivElement>(null);
  const [hintContainer, setHintContainer] = useState({ width: 0, height: 0 });
  const [protectedCode, setProtectedCode] = useState<HintRect | null>(null);

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

  const modelUri = (monaco: Monaco, path: string) => monaco.Uri.parse(toModelUri(projectId,path));
  const pathForModel = (model: monacoType.editor.ITextModel | null, scope = projectId) => {
    try { return model ? fromModelUri(scope,model.uri.toString()) : null; } catch { return null; }
  };

  // Handle Monaco Editor mount
  const handleEditorMount: OnMount = (editor, monaco) => {
    editorRef.current = editor;
    monacoRef.current = monaco;
    // The new instance starts locked until the pre-paint model/ownership effects run.
    disableNativeCompletionProviders(monaco);
    editor.updateOptions({ ...SAFE_SUGGEST_OPTIONS, readOnly: true });
    // Monaco owns disposal. Never leave callbacks pointing at its disposed instance.
    editor.onDidDispose(() => {
      if (editorRef.current !== editor) return;
      editorRef.current = null; monacoRef.current = null;
      decorationsRef.current = [];
      setEditorGeneration(generation => generation + 1);
    });

    // Define custom themes or subtle decorations
    monaco.editor.defineTheme('paircoach-solarized-dark', {
      base: 'vs-dark',
      inherit: true,
      rules: [
        { token: '', foreground: '839496', background: '002b36' },
        { token: 'comment', foreground: '586e75', fontStyle: 'italic' },
        { token: 'keyword', foreground: '859900' },
        { token: 'string', foreground: '2aa198' },
        { token: 'number', foreground: 'd33682' },
        { token: 'type', foreground: 'b58900' },
        { token: 'delimiter', foreground: '839496' },
        { token: 'operator', foreground: '859900' },
        { token: 'identifier', foreground: '839496' },
      ],
      colors: {
        'editor.background': '#002b36',
        'editor.foreground': '#839496',
        'editorLineNumber.foreground': '#586e75',
        'editorLineNumber.activeForeground': '#93a1a1',
        'editor.selectionBackground': '#285460',
        'editor.inactiveSelectionBackground': '#164550',
        'editor.lineHighlightBackground': '#073642',
        'editorCursor.foreground': '#93a1a1',
        'editorWidget.background': '#073642',
        'editorSuggestWidget.background': '#073642',
        'editorGutter.background': '#002b36',
        'editorBracketHighlight.foreground1': '#839496',
        'editorBracketHighlight.foreground2': '#839496',
        'editorBracketHighlight.foreground3': '#839496',
        'editorBracketHighlight.foreground4': '#839496',
        'editorBracketHighlight.foreground5': '#839496',
        'editorBracketHighlight.foreground6': '#839496',

      },
    });

    monaco.editor.setTheme('paircoach-solarized-dark');
    setEditorGeneration(generation => generation + 1);
  };

  // Switch before paint: never reveal an old project's model in a new workspace.
  // Switch models cleanly between tabs, preserving viewState & undo stack
  useLayoutEffect(() => {
    const editor = editorRef.current;
    const monaco = monacoRef.current;
    if (!editor || !monaco) return;
    if (!activeFile || activeFile.loaded === false) {
      const currentModel = editor.getModel();
      if (currentModel) {
        viewStatesRef.current.set(currentModel.uri.toString(), editor.saveViewState());
        editor.setModel(null);
      }
      editor.updateOptions({ readOnly: true });
      return;
    }

    const uri = modelUri(monaco, activeFile.path);
    let model = monaco.editor.getModel(uri);

    if (!model) {
      model = monaco.editor.createModel(normalizeContent(activeFile.content), getLanguageForPath(activeFile.path), uri);
    } else {
      // Model exists; ensure language is correct
      monaco.editor.setModelLanguage(model, getLanguageForPath(activeFile.path));
    }

    if (editor.getModel() !== model) {
      // Save view state of current model
      const currentModel = editor.getModel();
      if (currentModel) {
        const currentPath = currentModel.uri.toString();
        viewStatesRef.current.set(currentPath, editor.saveViewState());
      }

      isApplyingCoachStepRef.current = true;
      try { editor.setModel(model); } finally { isApplyingCoachStepRef.current = false; }

      // Restore view state if previously saved
      const savedState = viewStatesRef.current.get(uri.toString());
      if (savedState) {
        editor.restoreViewState(savedState);
      }
    }
  }, [projectId, activePath, editorGeneration, activeFile?.loaded]);

  // Binding lifecycle is per project/editor; no second model, socket or persistence path.
  useLayoutEffect(() => {
    const editor=editorRef.current,monaco=monacoRef.current;
    if (!editor || !monaco || !languageBinding || languageBinding.projectId!==projectId) return;
    const bridge=new MonacoLspBridge(monaco,editor,languageBinding);
    languageBridgeRef.current=bridge;
    return () => { if (languageBridgeRef.current===bridge) languageBridgeRef.current=null; bridge.dispose(); };
  }, [projectId, languageBinding, editorGeneration]);

  // A listener generation is bound to the actual Monaco model and authenticated connection.
  useLayoutEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;
    let scope: string | null = null;
    let model: monacoType.editor.ITextModel | null = null;
    let disposeObservation = () => {};
    const bind = () => {
      const nextScope = client.getEditorViewScope(), nextModel = editor.getModel();
      if (scope === nextScope && model === nextModel) return;
      const previousScope = scope, previousModel = model;
      disposeObservation(); scope = nextScope; model = nextModel;
      // A model disappearing/replacing is not permission to reuse its coordinates.
      if (previousModel && previousModel !== nextModel) client.clearEditorView(previousScope);
      const boundScope = scope;
      if (!boundScope) return;
      // Adapt only the legacy VIEW observer's URI shape; the actual model has ONE canonical URI.
      const observationModel = nextModel && pathForModel(nextModel) === activePath ? {
        uri:{scheme:'paircoach',authority:projectId,path:`/${activePath}`},
        getValue: () => nextModel.getValue(), isDisposed: () => nextModel.isDisposed(),
      } : null;
      const viewEditor = {
        getModel: () => editor.getModel()===nextModel ? observationModel : null,
        getPosition: () => editor.getPosition(), getSelection: () => editor.getSelection(),
        onDidChangeCursorPosition: editor.onDidChangeCursorPosition.bind(editor),
        onDidChangeCursorSelection: editor.onDidChangeCursorSelection.bind(editor),
        onDidChangeModelContent: editor.onDidChangeModelContent.bind(editor),
      };
      disposeObservation = observeMonacoViewP2(viewEditor, projectId, activePath,
        () => boundScope === client.getEditorViewScope(), view => client.updateEditorView(view));
    };
    const modelListener = editor.onDidChangeModel(bind);
    const unsubscribe = client.onStateChanged(bind);
    bind();
    return () => { disposeObservation(); modelListener.dispose(); unsubscribe(); client.clearEditorView(scope); };
  }, [projectId, activePath, editorGeneration]);

  // External/snapshot synchronization updates inactive models too. Ordinary ACK never calls setValue.
  useEffect(() => client.onFileUpdated((file) => {
    if (!file.isExternalOrSnapshot || !monacoRef.current) return;
    const model = monacoRef.current.editor.getModel(modelUri(monacoRef.current, file.path));
    if (model && normalizeContent(model.getValue()) !== normalizeContent(file.content)) {
      isApplyingCoachStepRef.current = true;
      try {
        const mutate=()=>model.setValue(normalizeContent(file.content));
        if (languageBridgeRef.current) languageBridgeRef.current.withMutationReason(model,'EXTERNAL_FILE_SYNC',mutate); else mutate();
      } finally { isApplyingCoachStepRef.current = false; }
    }
  }), [projectId]);

  // Protocol 3.0 has no stepIndex/totalSteps. Close the whole intervention at STUDENT/veto.
  const closeInterventions = () => {
    interventionModelsRef.current.forEach(model => { if (!model.isDisposed()) model.pushStackElement(); });
    interventionModelsRef.current.clear();
  };
  useEffect(() => {
    if (writeOwner !== 'COACH') closeInterventions();
  }, [writeOwner]);

  useEffect(() => client.onVetoExecuted(() => {
    closeInterventions();
    editorRef.current?.updateOptions({ readOnly: false });
  }), []);

  // Subscribe to Coach Step Edits directly on Monaco model
  useEffect(() => {
    const unsubStep = client.onCoachStep((step: CoachEditStep) => {
      const editor = editorRef.current;
      const monaco = monacoRef.current;
      if (!editor || !monaco) return;

      // Read synchronous client state, not the potentially stale React render's epoch.
      if (!client.canApplyStep(step)) return;
      const uri = modelUri(monaco, step.path);
      let model = monaco.editor.getModel(uri);
      if (!model) {
        const file = client.getState().files.find(f => f.path === step.path);
        if (!file || file.loaded === false) return;
        model = monaco.editor.createModel(normalizeContent(file.content), getLanguageForPath(step.path), uri);
      }
      if (editor.getModel() !== model) {
        const old = editor.getModel();
        if (old) viewStatesRef.current.set(old.uri.toString(), editor.saveViewState());
        isApplyingCoachStepRef.current = true;
        try { editor.setModel(model); } finally { isApplyingCoachStepRef.current = false; }
        const view = viewStatesRef.current.get(uri.toString()); if (view) editor.restoreViewState(view);
      }

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
      if (!interventionModelsRef.current.has(step.interventionId)) {
        model.pushStackElement();
        interventionModelsRef.current.set(step.interventionId, model);
      }

      isApplyingCoachStepRef.current = true;
      try {
        const mutate = () => model.pushEditOperations(
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

        if (languageBridgeRef.current) languageBridgeRef.current.withMutationReason(model,'COACH_STEP_EDIT',mutate); else mutate();

        // Only the actual Monaco mutation may acknowledge STEP_RENDERED. Never echo CODE_CHANGED.
        client.stepRendered(step, model.getValue());
      } finally {
        isApplyingCoachStepRef.current = false;
      }
    });

    return unsubStep;
  }, [projectId,editorGeneration]);

  // Transport events lock Monaco synchronously; React rerender is not the write barrier.
  useEffect(() => client.onStateChanged(state => {
    const model = editorRef.current?.getModel();
    const path = pathForModel(model ?? null,state.scenario.id);
    const file = path ? state.files.find(f => f.path === path) : undefined;
    editorRef.current?.updateOptions({ readOnly: state.writeOwner === 'COACH' || (state.writeOwner === 'SYNCING' && !state.isOffline) || !file || file.loaded === false || !!file.readOnly });
    if (state.writeOwner !== 'COACH') closeInterventions();
  }), []);

  // Apply the current ownership lock before the editor can become visible.
  // Handle readOnly property based on writeOwner
  useLayoutEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;

    editor.updateOptions({ readOnly: writeOwner === 'COACH' || (writeOwner === 'SYNCING' && !isOffline) || !activeFile || activeFile.loaded === false || !!activeFile.readOnly, domReadOnly: false });
  }, [writeOwner, isOffline, activeFile?.readOnly, activeFile?.loaded, activePath, editorGeneration]);

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
  }, [activePointer, activePath, editorGeneration]);

  // Protect the whole active line/selection band (including wrapped lines), not only
  // a one-pixel caret. Selection, scroll and splitter/layout changes all invalidate it.
  useLayoutEffect(() => {
    const container = contentContainerRef.current;
    if (!container) return;
    const editor = editorRef.current;
    const update = () => {
      const bounds = container.getBoundingClientRect();
      setHintContainer(old => old.width === bounds.width && old.height === bounds.height ? old : { width: bounds.width, height: bounds.height });
      const selection = editor?.getSelection();
      const node = editor?.getDomNode();
      if (!editor || !selection || !node || !editor.getModel()) { setProtectedCode(null); return; }
      const offset = node.getBoundingClientRect().top - bounds.top;
      const top = Math.max(0, offset + editor.getTopForLineNumber(selection.startLineNumber) - editor.getScrollTop());
      const bottom = Math.min(bounds.height, offset + editor.getBottomForLineNumber(selection.endLineNumber) - editor.getScrollTop());
      const next = bottom > top ? { left: 0, top, width: bounds.width, height: bottom - top } : null;
      setProtectedCode(old => JSON.stringify(old) === JSON.stringify(next) ? old : next);
    };
    const observer = new ResizeObserver(update); observer.observe(container);
    const disposables = editor ? [editor.onDidChangeCursorSelection(update), editor.onDidScrollChange(update), editor.onDidLayoutChange(update), editor.onDidChangeModel(update), editor.onDidChangeModelContent(update)] : [];
    window.addEventListener('resize', update); update();
    return () => { observer.disconnect(); disposables.forEach(d => d.dispose()); window.removeEventListener('resize', update); };
  }, [editorGeneration, activePath]);

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
        <div role="tablist" aria-label="Otwarte pliki" className="flex items-center gap-1 min-w-0">
          {openTabs.map((tabPath) => {
            const isActive = tabPath === activePath;
            const fileName = tabPath.split('/').pop() || tabPath;
            return (
              <div
                key={tabPath}
                role="tab"
                tabIndex={0}
                aria-selected={isActive}
                onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onSelectTab(tabPath); } }}
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
          {activeFile && (
            <span className="text-zinc-500 text-[10px] bg-zinc-800/80 border border-zinc-700/60 px-1.5 py-0.5 rounded font-mono">
              v{activeFile.version}
            </span>
          )}
          {writeOwner === 'COACH' ? (
            <span className="text-blue-400 font-semibold animate-pulse flex items-center gap-1">
              <Bot className="w-3.5 h-3.5" />
              Pisze Trener AI
            </span>
          ) : writeOwner === 'STUDENT' ? (
            <div className="flex items-center gap-1.5">
              <span className="text-red-400 font-medium">Tryb ucznia (Piszesz Ty)</span>
              <span className="text-zinc-600">·</span>
              {pendingPaths.includes(activePath) ? (
                <span className="text-amber-400 font-normal">Zapis oczekuje na ACK</span>
              ) : isOffline ? (
                <span className="text-amber-400 font-normal">Niezapisany draft (Offline)</span>
              ) : (
                <span className="text-emerald-400 font-normal">Zapisano</span>
              )}
            </div>
          ) : (
            <span className="text-zinc-400">{isOffline ? 'Offline — lokalny draft' : 'Synchronizacja / Zapis niepotwierdzony'}</span>
          )}
        </div>
      </div>

      {/* Conflict Banner (Item 3) */}
      {fileConflict && fileConflict.path === activePath && (
        <div className="bg-amber-950/95 border-b-2 border-amber-500 px-4 py-2 flex flex-wrap items-center justify-between gap-3 text-xs text-amber-200 z-30 shadow-lg">
          <div className="flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0" />
            <span>
              <strong>Konflikt synchronizacji:</strong> {fileConflict.diskDeleted ? 'Plik usunięto na dysku; lokalny draft zachowano. Zachowanie draftu odtworzy plik po Twojej decyzji.' : 'Plik na dysku uległ zmianie, ale posiadasz lokalny niepotwierdzony draft.'}
            </span>
          </div>
          <details className="w-full">
            <summary className="cursor-pointer">Porównaj zachowane wersje</summary>
            <div className="grid sm:grid-cols-2 gap-2 mt-2">
              <label>Draft lokalny<textarea aria-label="Draft lokalny konfliktu" readOnly value={fileConflict.localDraftContent} className="w-full h-28 bg-zinc-900 text-zinc-100" /></label>
              <label>Wersja z dysku<textarea aria-label="Wersja z dysku konfliktu" readOnly value={fileConflict.diskContent} className="w-full h-28 bg-zinc-900 text-zinc-100" /></label>
            </div>
          </details>
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
      <div ref={contentContainerRef} data-testid="editor-content-container" className="flex-1 min-h-0 relative overflow-hidden flex flex-col">
        {activeHintBubble && activeHintBubble.path === activePath && hintContainer.width > 0 && hintContainer.height > 0 && (
          <HintBubble key={activeHintBubble.id} hint={activeHintBubble} container={hintContainer} protectedCode={protectedCode} onDismiss={onDismissBubble} onPosition={onBubblePosChange} />
        )}
        {/* Keep one editor instance across loading/resnapshot/project-open transitions. */}
        <div className="flex-1 min-h-0" hidden={!editorRef.current || !activeFile || activeFile.loaded === false}>
          <Editor
            height="100%"
            defaultLanguage={activeFile ? getLanguageForPath(activeFile.path) : 'plaintext'}
            defaultValue={activeFile?.content ?? ''}
            theme="paircoach-solarized-dark"
            onMount={handleEditorMount}
            onChange={(newVal) => {
              if (!isApplyingCoachStepRef.current && newVal !== undefined) {
                const model = editorRef.current?.getModel();
                const path=pathForModel(model ?? null,client.getState().scenario.id);
                if (!path) return;
                onContentChange(path, normalizeContent(newVal));
              }
            }}
            options={{
              ...SAFE_SUGGEST_OPTIONS,
              readOnly: !editorRef.current || writeOwner === 'COACH' || (writeOwner === 'SYNCING' && !isOffline) || !activeFile || activeFile.loaded === false || !!activeFile.readOnly,
              ariaLabel: activeFile && activeFile.loaded !== false ? `Edytor pliku ${activeFile.path}` : 'Edytor bez otwartego pliku',
              quickSuggestions: false,
              suggestOnTriggerCharacters: false,
              wordBasedSuggestions: 'off',
              minimap: { enabled: false },
              bracketPairColorization: { enabled: false },
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
        </div>
        {(!editorRef.current || !activeFile || activeFile.loaded === false) && (
          <div className="h-full flex items-center justify-center text-zinc-500 text-sm">
            {activeFile?.loadError ? `Nie można otworzyć pliku: ${activeFile.loadError}. Wybierz inny plik.` : activeFile?.loaded === false ? 'Wczytywanie pliku…' : activeFile ? 'Uruchamianie edytora…' : 'Brak otwartego pliku. Wybierz plik z drzewa po lewej stronie.'}
          </div>
        )}

        {/* Selection intersection warning note */}
        {selectionNotice && (
          <div className="absolute top-2 left-1/2 -translate-x-1/2 bg-amber-950/90 border border-amber-600 text-amber-200 text-xs px-3 py-1.5 rounded shadow-lg flex items-center gap-2 animate-fade-in z-20">
            <Info className="w-4 h-4 text-amber-400" />
            <span>{selectionNotice}</span>
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
