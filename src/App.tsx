/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { client } from './services/PairCoachClient';
import { observeWindowPresence } from './services/windowPresence';
import {
  ActionProposal,
  CoachHintBubble,
  CoachPointer,
  EndReason,
  HintBubbleSeverity,
  ProjectFile,
  ProjectSettings,
  ProposalType,
  TrainingScenario,
} from './types/paircoach';
import { RuntimeStatusV2 } from './components/RuntimeStatusV2';
import { RuntimeSettingsV2 } from './components/RuntimeSettingsV2';
import { HeaderBar } from './components/HeaderBar';
import { DevSimulatorBar } from './components/DevSimulatorBar';
import { FileTree } from './components/FileTree';
import { EditorPanel } from './components/EditorPanel';
import { BottomPanel } from './components/BottomPanel';
import { FinishModal } from './components/FinishModal';
import { ProjectSettingsModal } from './components/ProjectSettingsModal';
import { FolderPicker } from './components/FolderPicker';
import { MOCK_SCENARIOS } from './data/mockScenarios';

export default function App() {
  const [state, setState] = useState(client.getState());
  const [theme,setTheme]=useState<'dark'|'light'>(()=>{
    try {return window.localStorage.getItem('paircoach:theme')==='light'?'light':'dark';}
    catch {return 'dark';}
  });
  const [contentFontSize,setContentFontSize]=useState(()=>{
    try {
      const saved=window.localStorage.getItem('paircoach:content-font-size');
      const size=saved===null?13:Number(saved);
      return Number.isInteger(size) && size>=10 && size<=30 ? size : 13;
    } catch {return 13;}
  });
  useLayoutEffect(()=>{
    try {window.localStorage.setItem('paircoach:content-font-size',String(contentFontSize));}
    catch { /* Reading controls remain usable without storage. */ }
  },[contentFontSize]);
  useLayoutEffect(()=>{
    document.documentElement.dataset.theme=theme;
    try {window.localStorage.setItem('paircoach:theme',theme);} catch { /* Appearance remains usable without storage. */ }
  },[theme]);
  const [openTabs, setOpenTabs] = useState<string[]>([state.activePath]);
  const [isDevSimulatorOpen, setIsDevSimulatorOpen] = useState(client.transportMode === 'MOCK_SIMULATOR');

  // Resizable panel dimensions
  const [fileTreeWidth, setFileTreeWidth] = useState(240);
  const [bottomPanelHeight, setBottomPanelHeight] = useState(260);
  const [isBottomCollapsed, setIsBottomCollapsed] = useState(false);
  const [isBottomMaximized, setIsBottomMaximized] = useState(false);
  const [activeBottomTab, setActiveBottomTab] = useState<'task' | 'chat' | 'console' | 'report'>('task');

  // Modals
  const [isFinishModalOpen, setIsFinishModalOpen] = useState(false);
  const [finishReason, setFinishReason] = useState<EndReason>('COMPLETED');
  const [isRuntimeSettingsOpen,setIsRuntimeSettingsOpen]=useState(false);
  const [isReconcilingRuntime,setIsReconcilingRuntime]=useState(false);
  const [runtimeReconcileResult,setRuntimeReconcileResult]=useState<{scope:string|null;message:string}|null>(null);
  const [isSettingsModalOpen, setIsSettingsModalOpen] = useState(false);
  const [isEnvironmentOpen,setIsEnvironmentOpen]=useState(false);
  const [isFolderPickerOpen,setIsFolderPickerOpen]=useState(false);
  const projectSettings = state.projectSettings;

  // Splitter dragging refs
  const isDraggingHorizontalRef = useRef(false);
  const isDraggingVerticalRef = useRef(false);

  // Double-escape detection ref
  const lastEscapeTimeRef = useRef<number>(0);

  // Subscribe to client state changes
  useEffect(() => {
    const unsub = client.onStateChanged((newState) => {
      setState(newState);
      // Clean up deleted/renamed tabs and ensure active path is valid
      setOpenTabs((prev) => {
        const existingPaths = new Set(newState.files.filter(f => f.kind === 'FILE').map((f) => f.path));
        let validTabs = prev.filter((p) => existingPaths.has(p));
        if (newState.activePath && existingPaths.has(newState.activePath) && !validTabs.includes(newState.activePath)) {
          validTabs = [...validTabs, newState.activePath];
        }
        if (validTabs.length === 0 && newState.files.length > 0) {
          validTabs = [newState.activePath || newState.files[0].path];
        }
        return validTabs;
      });
    });
    setState(client.getState());
    return unsub;
  }, []);

  // Handle Double-Escape Keydown for VETO (<= 400ms interval, !e.repeat)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.repeat) {
        const now = Date.now();
        const diff = now - lastEscapeTimeRef.current;
        if (diff > 0 && diff <= 400) {
          // Double Escape detected!
          e.preventDefault();
          e.stopPropagation();
          client.triggerVeto('KEY_DOUBLE_ESC');
          lastEscapeTimeRef.current = 0;
        } else {
          lastEscapeTimeRef.current = now;
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown, true);
    return () => {
      window.removeEventListener('keydown', handleKeyDown, true);
    };
  }, []);

  // Presence detection: Page Visibility API & Window focus/blur
  useEffect(() => observeWindowPresence(document, window, presence => client.sendWindowState(presence)), []);

  // Resizable Splitter mouse handlers
  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (isDraggingHorizontalRef.current) {
        const newWidth = Math.max(160, Math.min(480, e.clientX));
        setFileTreeWidth(newWidth);
      }
      if (isDraggingVerticalRef.current) {
        const newHeight = Math.max(120, Math.min(window.innerHeight - 150, window.innerHeight - e.clientY));
        setBottomPanelHeight(newHeight);
      }
    };

    const handleMouseUp = () => {
      isDraggingHorizontalRef.current = false;
      isDraggingVerticalRef.current = false;
      document.body.style.cursor = 'default';
      document.body.style.userSelect = 'auto';
    };

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, []);

  // Tab management
  const handleSelectTab = (path: string) => {
    client.selectFile(path);
    if (!openTabs.includes(path)) {
      setOpenTabs((prev) => [...prev, path]);
    }
  };

  const handleCloseTab = (path: string) => {
    const nextTabs = openTabs.filter((t) => t !== path);
    setOpenTabs(nextTabs);
    if (state.activePath === path) {
      const nextActive = nextTabs[nextTabs.length - 1] || state.files[0]?.path || '';
      if (nextActive) client.selectFile(nextActive);
    }
  };

  const handleScenarioChange = (scenario: TrainingScenario) => {
    client.loadScenario(scenario);
    setOpenTabs([scenario.files[0].path]);

  };

  const handleOpenFinish = (reason: 'COMPLETED' | 'ABANDONED') => {
    setFinishReason(reason);
    setIsFinishModalOpen(true);
  };

  const handleConfirmFinish = (reason: EndReason) => {
    setIsFinishModalOpen(false);
    client.finishSession(reason);
    setActiveBottomTab('report');
    setIsBottomCollapsed(false);
  };

  const taskFile = state.files.find((f) => f.path === state.scenario.taskFilePath);
  const taskMarkdownContent = taskFile?.loaded === false && !state.taskReadError ? '# Wczytywanie zadania…' : taskFile?.content ?? '# Treść zadania nie została znaleziona.';

  const connectionStatus = (
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] leading-relaxed min-w-0 [overflow-wrap:anywhere]" role="status">
        <strong>{state.transportMode === 'LIVE_BACKEND' ? 'LIVE — lokalny backend' : 'MOCK — jawna symulacja, bez zapisu na dysk'}</strong>
        {state.transportMode === 'LIVE_BACKEND' && <>
          <span>{state.isOffline ? 'Synchronizacja / Offline — niepotwierdzone zmiany pozostają lokalne.' : state.pendingPaths.length ? 'Zapis oczekuje na ACK.' : 'Połączono z backendem.'}</span>
          <button className="underline" disabled={state.isOffline} onClick={() => setIsFolderPickerOpen(true)}>Otwórz folder…</button>
          <button className="underline" onClick={() => client.reconnect()}>Połącz ponownie</button>
        </>}
        {state.connectionError && <span role="alert" className="text-amber-300 break-words">{state.connectionError}</span>}
        {state.runtime?.reconciliationRequired && <button type="button" disabled={state.isOffline || isReconcilingRuntime} onClick={async()=>{const scope=client.getReportHistoryScope();setIsReconcilingRuntime(true);setRuntimeReconcileResult(null);try {const ok=await client.reconcileRuntimeMutation();if(scope===client.getReportHistoryScope())setRuntimeReconcileResult({scope,message:ok?'Potwierdzono rozstrzygnięcie operacji. Sprawdź bieżący stan w sekcji środowiska.':client.getState().runtime?.error ?? 'Nie potwierdzono wyniku. Blokada zachowana.'});} finally {setIsReconcilingRuntime(false);}}} className="underline px-2 py-1">{isReconcilingRuntime ? 'Sprawdzanie wyniku…' : 'Sprawdź wynik operacji'}</button>}
        {(isReconcilingRuntime || (runtimeReconcileResult && runtimeReconcileResult.scope===client.getReportHistoryScope())) && <span role="status" aria-live="polite">{isReconcilingRuntime ? 'Sprawdzanie autoryzowanego wyniku…' : runtimeReconcileResult?.message}</span>}
        {state.runtime?.reconciliationRequired && <span role="alert" className="text-amber-300">Wynik Run lub zapisu jest nieznany. Nowy Run i zapis zablokowane do autoryzowanego rozstrzygnięcia dokładnego żądania. Ponowne połączenie nie usuwa blokady; nie odświeżaj strony, zachowaj draft. Ręczna edycja i Stop znanego wykonania pozostają dostępne.</span>}
        {state.storageError && <span role="alert" className="text-rose-300">{state.storageError}</span>}
      </div>
  );
  const environmentDetails = state.transportMode==='LIVE_BACKEND' && isEnvironmentOpen ? (
    <div id="project-environment-panel" className="min-w-0 text-xs [overflow-wrap:anywhere]">
        <RuntimeStatusV2 execution={state.runtime?.execution && (state.runtime.reconciliationRequired || state.writeOwner!=='STUDENT' || !!state.fileConflict) ? {...state.runtime.execution,modes:{RUN_MAIN:{...state.runtime.execution.modes.RUN_MAIN,canRun:false},RUN_TESTS:{...state.runtime.execution.modes.RUN_TESTS,canRun:false}}} : state.runtime?.execution ?? null} language={state.language ?? null} diagnostics={state.languageDiagnostics}
          run={state.runtime?.run ?? null} connected={!state.isOffline} canExecute={!state.isOffline}
          preparation={state.runtime?.maintenance} onPrepare={state.transportMode==='LIVE_BACKEND'?reconcile=>{void client.prepareRuntimeEnvironment(reconcile);}:undefined}
          pending={!!state.runtime?.pending}
          error={state.runtime?.reconciliationRequired ? 'Wynik Run lub zapisu nieznany. Wymagany autoryzowany odczyt dokładnego requestId; ponowne połączenie nie usuwa blokady. Ręczna edycja dostępna.' : state.runtime?.error}
          onRun={mode=>mode==='RUN_TESTS'?client.runTests():client.runMain()} onStop={()=>client.stopExecution()} onSettings={()=>setIsRuntimeSettingsOpen(true)} />
        {state.languageProblem && <p role="status">{state.languageProblem}</p>}
    </div>
  ) : undefined;
  const projectFooter = <div className="space-y-2">
    {connectionStatus}
    {state.transportMode==='LIVE_BACKEND' && <button type="button"
      className="w-full flex items-start gap-1 text-left text-[11px] leading-relaxed [overflow-wrap:anywhere] hover:text-zinc-100"
      aria-expanded={isEnvironmentOpen} aria-controls="project-environment-panel"
      onClick={()=>setIsEnvironmentOpen(open=>!open)}>
      <span aria-hidden="true" className="shrink-0">{isEnvironmentOpen?'▾':'▸'}</span>
      <span>Profil / środowisko: {state.runtime?.execution?.runtime.label || 'nieustalony'} · {state.runtime?.execution?.runtime.state || 'Ładowanie'} · AutoComp {state.language?.autocomplete ?? 'OFF'} · Docs N/A</span>
    </button>}
  </div>;

  return (
    <div className="flex flex-col h-screen w-screen overflow-hidden bg-zinc-950 font-sans text-zinc-100"
      style={{'--pc-reading-scale':contentFontSize/13} as React.CSSProperties}>
      {/* Top Header Bar */}
      <HeaderBar
        theme={theme}
        onToggleTheme={()=>setTheme(value=>value==='dark'?'light':'dark')}
        contentFontSize={contentFontSize}
        onDecreaseContentFont={()=>setContentFontSize(size=>Math.max(10,size-1))}
        onIncreaseContentFont={()=>setContentFontSize(size=>Math.min(30,size+1))}
        writeOwner={state.writeOwner}
        coachMode={state.coachMode}
        aiStatus={state.aiStatus}
        sessionStatus={state.sessionStatus}
        elapsedMs={state.elapsedMs}
        limitMs={state.limitMs}
        pauseOnHidden={state.pauseOnHidden}
        taskMode={state.scenario.taskMode}
        capabilities={state.transportMode==='LIVE_BACKEND' ? {...state.capabilities,
          canRunMain:state.capabilities.canRunMain && !state.isOffline && state.writeOwner==='STUDENT' && !state.runtime?.pending && !state.runtime?.reconciliationRequired && !state.runtime?.maintenance?.blocked,
          canRunTests:state.capabilities.canRunTests && !state.isOffline && state.writeOwner==='STUDENT' && !state.runtime?.pending && !state.runtime?.reconciliationRequired && !state.runtime?.maintenance?.blocked} : state.capabilities}
        executionStatus={state.activeRun?.status || 'IDLE'}
        isDevSimulatorOpen={isDevSimulatorOpen}
        onEmergencyVeto={() => client.triggerVeto('EMERGENCY_BUTTON')}
        onStartTimer={() => client.startTimer()}
        onPauseTimer={() => client.pauseTimer()}
        onResumeTimer={() => client.resumeTimer()}
        onTogglePauseOnHidden={(val) => client.setPauseOnHidden(val)}
        onRunMain={() => {
          client.runMain();
          setActiveBottomTab('console');
          setIsBottomCollapsed(false);
        }}
        onRunTests={() => {
          client.runTests();
          setActiveBottomTab('console');
          setIsBottomCollapsed(false);
        }}
        onStopExecution={() => client.stopExecution()}
        onOpenFinishModal={handleOpenFinish}
        onToggleDevSimulator={() => setIsDevSimulatorOpen(!isDevSimulatorOpen)}
      />

      {/* Dev Simulator Bar (Togglable) */}
      {isDevSimulatorOpen && (
        <DevSimulatorBar
          transportMode={state.transportMode}
          onTransportMode={(mode) => client.setTransportMode(mode)}
          currentScenarioId={state.scenario.id}
          isOffline={state.isOffline}
          onSelectScenario={handleScenarioChange}
          onStartCoachDemo={() => client.devStartCoachDemo()}
          onShowBubble={(severity, text, line) => client.devShowBubble(severity, text, line)}
          onShowPointer={(start, end) => client.devShowPointer(start, end)}
          onTriggerProposal={(type) => client.devTriggerProposal(type)}
          onExternalFileSync={() => client.devSimulateExternalSync()}
          onToggleOffline={() => client.devToggleOffline()}
          onSimulateReportFailure={() => client.finishSession('COMPLETED', true)}
        />
      )}

      {/* Main Workspace Area */}
      <div className="flex-1 min-h-0 flex overflow-hidden relative">
        {/* Left Panel: File Tree */}
        <div style={{ width: `min(${fileTreeWidth}px, 36vw)` }} className="shrink-0 h-full overflow-hidden">
          <FileTree
            footer={projectFooter}
            details={environmentDetails}
            files={state.files}
            activePath={state.activePath}
            taskFilePath={state.scenario.taskFilePath}
            reviewNotesPath={state.scenario.reviewNotesPath}
            taskMode={state.scenario.taskMode}
            onSelectFile={handleSelectTab}
            onCreateFile={(path) => client.createFile(path)}
            onRenameFile={(oldP, newP) => client.renameFile(oldP, newP)}
            onDeleteFile={(p) => client.deleteFile(p)}
            onOpenSettings={() => setIsSettingsModalOpen(true)}
          />
        </div>

        {/* Horizontal Resizable Splitter */}
        <div
          onMouseDown={() => {
            isDraggingHorizontalRef.current = true;
            document.body.style.cursor = 'col-resize';
            document.body.style.userSelect = 'none';
          }}
          className="w-1 hover:w-1.5 bg-zinc-800 hover:bg-blue-500 cursor-col-resize transition-all z-10 shrink-0"
          title="Przeciągnij, aby zmienić szerokość drzewa plików"
        />

        {/* Center & Bottom: Editor and Bottom Panels */}
        <div className="flex-1 min-h-0 min-w-0 flex flex-col h-full overflow-hidden">
          {/* Middle: Shared Monaco Editor */}
          <div className="flex-1 min-h-0 overflow-hidden relative">
            <EditorPanel
              theme={theme}
              contentFontSize={contentFontSize}
              projectId={state.scenario.id}
              languageBinding={client.getEditorLanguageBinding()}
              files={state.files}
              openTabs={openTabs}
              activePath={state.activePath}
              writeOwner={state.writeOwner}
              isOffline={state.isOffline}
              pendingPaths={state.pendingPaths}
              controlEpoch={state.controlEpoch}
              fileConflict={state.fileConflict}
              activePointer={state.activePointer}
              activeHintBubble={state.activeHintBubble}
              activeProposal={state.activeProposal}
              isBottomPanelVisible={!isBottomCollapsed}
              activeBottomTab={activeBottomTab}
              onSelectTab={handleSelectTab}
              onCloseTab={handleCloseTab}
              onContentChange={(path, content) => client.saveFileContent(path, content)}
              onDismissBubble={() => client.dismissHintBubble()}
              onBubblePosChange={(x, y) => client.updateBubblePos(x, y)}
              onProposalResponse={(id, accept) => client.respondToProposal(id, accept)}
              onResolveConflict={(choice) => client.resolveConflict(choice)}
            />
          </div>

          {/* Vertical Resizable Splitter */}
          {!isBottomCollapsed && !isBottomMaximized && (
            <div
              onMouseDown={() => {
                isDraggingVerticalRef.current = true;
                document.body.style.cursor = 'row-resize';
                document.body.style.userSelect = 'none';
              }}
              className="h-1 hover:h-1.5 bg-zinc-800 hover:bg-blue-500 cursor-row-resize transition-all z-10 shrink-0"
              title="Przeciągnij, aby zmienić wysokość dolnego panelu"
            />
          )}

          {/* Bottom Panel: Zadanie, Czat, Konsola, Raport */}
          {activeBottomTab === 'task' && !isBottomCollapsed && state.taskReadError && (
            <div role="alert" aria-label="Błąd pliku zadania" className="px-3 py-2 text-xs text-amber-200 bg-amber-950 border-t border-amber-700 break-words">
              Nie można odczytać zadania „{state.taskReadError.path}”: {state.taskReadError.message} Popraw ścieżkę pliku zadania w ustawieniach lub przywróć plik.
            </div>
          )}
          <BottomPanel
            activeTab={activeBottomTab}
            taskContent={taskMarkdownContent}
            chatEntries={state.chatEntries}
            activeProposal={state.activeProposal}
            activeRun={state.activeRun}
            report={state.report}
            reportHistorySource={state.transportMode === 'LIVE_BACKEND' ? client : undefined}
            reportHistoryScope={client.getReportHistoryScope()}
            height={bottomPanelHeight}
            isMaximized={isBottomMaximized}
            isCollapsed={isBottomCollapsed}
            onSelectTab={(tab) => setActiveBottomTab(tab)}
            onSendMessage={(msg) => client.sendChatMessage(msg)}
            onProposalResponse={(id, accept) => client.respondToProposal(id, accept)}
            onRetryReport={() => client.retryReport()}
            onToggleCollapse={() => setIsBottomCollapsed(!isBottomCollapsed)}
            onToggleMaximize={() => setIsBottomMaximized(!isBottomMaximized)}
          />
        </div>
      </div>

      {/* Finish Session Confirmation Modal */}
      <FinishModal
        isOpen={isFinishModalOpen}
        initialReason={finishReason}
        onClose={() => setIsFinishModalOpen(false)}
        onConfirm={handleConfirmFinish}
      />

      <RuntimeSettingsV2 open={isRuntimeSettingsOpen} settings={state.projectSettings.rawSettings}
        expectedWorkspaceVersion={state.workspaceVersion} execution={state.runtime?.execution ?? null}
        connected={!state.isOffline} canSave={state.writeOwner==='STUDENT' && !state.runtime?.pending && !state.runtime?.reconciliationRequired && !state.runtime?.maintenance?.blocked}
        onSave={(settings,version)=>client.saveRuntimeSettings(settings,version)} onClose={()=>setIsRuntimeSettingsOpen(false)} />
      {/* Project Settings Modal */}
      {isFolderPickerOpen && <FolderPicker key={state.scenario.id}
        list={(path,signal)=>client.listFolders(path,signal)} open={async path=>{
          const opened=await client.openProject(path);if(opened)setIsFolderPickerOpen(false);return opened;
        }}
        blocked={client.folderOpenProblem()} onClose={()=>setIsFolderPickerOpen(false)} />}
      <ProjectSettingsModal
        isOpen={isSettingsModalOpen}
        settings={projectSettings}
        settingsVersion={state.workspaceVersion}
        connected={!state.isOffline}
        canSave={state.transportMode!=='LIVE_BACKEND' || (state.writeOwner==='STUDENT' && !state.runtime?.pending && !state.runtime?.reconciliationRequired && !state.runtime?.maintenance?.blocked)}
        rootPath={state.transportMode === 'LIVE_BACKEND' ? state.scenario.title : undefined}
        onOpenProject={state.transportMode === 'LIVE_BACKEND' ? (root) => client.openProject(root) : undefined}
        snapshots={state.snapshots}
        snapshotsError={state.snapshotsError}
        onClose={() => setIsSettingsModalOpen(false)}
        onSave={(updated) => client.updateProjectSettings(updated)}
        onRestoreSnapshot={(snapshotId) => {
          client.restoreSnapshotById(snapshotId);
        }}
      />
    </div>
  );
}
