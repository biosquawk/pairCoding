/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useRef, useState } from 'react';
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
import { HeaderBar } from './components/HeaderBar';
import { DevSimulatorBar } from './components/DevSimulatorBar';
import { FileTree } from './components/FileTree';
import { EditorPanel } from './components/EditorPanel';
import { BottomPanel } from './components/BottomPanel';
import { FinishModal } from './components/FinishModal';
import { ProjectSettingsModal } from './components/ProjectSettingsModal';
import { MOCK_SCENARIOS } from './data/mockScenarios';

export default function App() {
  const [state, setState] = useState(client.getState());
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
  const [isSettingsModalOpen, setIsSettingsModalOpen] = useState(false);
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

  return (
    <div className="flex flex-col h-screen w-screen overflow-hidden bg-zinc-950 font-sans text-zinc-100">
      {/* Top Header Bar */}
      <HeaderBar
        writeOwner={state.writeOwner}
        coachMode={state.coachMode}
        aiStatus={state.aiStatus}
        sessionStatus={state.sessionStatus}
        elapsedMs={state.elapsedMs}
        limitMs={state.limitMs}
        pauseOnHidden={state.pauseOnHidden}
        taskMode={state.scenario.taskMode}
        capabilities={state.capabilities}
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

      <div className="flex flex-wrap items-center gap-2 px-3 py-1.5 text-xs border-b border-zinc-800 bg-zinc-900" role="status">
        <strong>{state.transportMode === 'LIVE_BACKEND' ? 'LIVE — lokalny backend' : 'MOCK — jawna symulacja, bez zapisu na dysk'}</strong>
        {state.transportMode === 'LIVE_BACKEND' && <>
          <span>{state.isOffline ? 'Synchronizacja / Offline — niepotwierdzone zmiany pozostają lokalne.' : state.pendingPaths.length ? 'Zapis oczekuje na ACK.' : 'Połączono z backendem.'}</span>
          <button className="underline" disabled={state.isOffline} onClick={() => setIsSettingsModalOpen(true)}>Otwórz folder</button>
          <button className="underline" onClick={() => client.reconnect()}>Połącz ponownie</button>
        </>}
        {state.connectionError && <span role="alert" className="text-amber-300 break-words">{state.connectionError}</span>}
        {state.storageError && <span role="alert" className="text-rose-300">{state.storageError}</span>}
      </div>
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
              projectId={state.scenario.id}
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

      {/* Project Settings Modal */}
      <ProjectSettingsModal
        isOpen={isSettingsModalOpen}
        settings={projectSettings}
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
