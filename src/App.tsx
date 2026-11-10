/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useRef, useState } from 'react';
import { client } from './services/PairCoachClient';
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
  WindowPresence,
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
  const [isDevSimulatorOpen, setIsDevSimulatorOpen] = useState(true);

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
  const [projectSettings, setProjectSettings] = useState<ProjectSettings>({
    aiConsent: true,
    taskMode: state.scenario.taskMode,
    taskFilePath: state.scenario.taskFilePath,
    reviewNotesPath: state.scenario.reviewNotesPath,
    runProfiles: [
      { id: 'main', name: 'Run Main', command: 'node dist/index.js', isTest: false },
      { id: 'test', name: 'Run Tests', command: 'vitest run', isTest: true },
    ],
  });

  // Splitter dragging refs
  const isDraggingHorizontalRef = useRef(false);
  const isDraggingVerticalRef = useRef(false);

  // Double-escape detection ref
  const lastEscapeTimeRef = useRef<number>(0);

  // Subscribe to client state changes
  useEffect(() => {
    const unsub = client.onStateChanged((newState) => {
      setState(newState);
      // Ensure active path is in open tabs
      if (newState.activePath && !openTabs.includes(newState.activePath)) {
        setOpenTabs((prev) => [...prev, newState.activePath]);
      }
    });
    return unsub;
  }, [openTabs]);

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
  useEffect(() => {
    const updatePresence = () => {
      if (document.hidden) {
        client.sendWindowState('HIDDEN');
      } else if (document.hasFocus()) {
        client.sendWindowState('FOCUSED');
      } else {
        client.sendWindowState('BLURRED');
      }
    };

    document.addEventListener('visibilitychange', updatePresence);
    window.addEventListener('focus', updatePresence);
    window.addEventListener('blur', updatePresence);

    return () => {
      document.removeEventListener('visibilitychange', updatePresence);
      window.removeEventListener('focus', updatePresence);
      window.removeEventListener('blur', updatePresence);
    };
  }, []);

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
    setProjectSettings((prev) => ({
      ...prev,
      taskMode: scenario.taskMode,
      taskFilePath: scenario.taskFilePath,
      reviewNotesPath: scenario.reviewNotesPath,
    }));
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
  const taskMarkdownContent = taskFile?.content || '# Treść zadania nie została znaleziona.';

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

      {/* Dev Simulator Bar (Togglable) */}
      {isDevSimulatorOpen && (
        <DevSimulatorBar
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
      <div className="flex-1 flex overflow-hidden relative">
        {/* Left Panel: File Tree */}
        <div style={{ width: `${fileTreeWidth}px` }} className="shrink-0 h-full overflow-hidden">
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
        <div className="flex-1 flex flex-col h-full overflow-hidden">
          {/* Middle: Shared Monaco Editor */}
          <div className="flex-1 overflow-hidden relative">
            <EditorPanel
              files={state.files}
              openTabs={openTabs}
              activePath={state.activePath}
              writeOwner={state.writeOwner}
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
        onClose={() => setIsSettingsModalOpen(false)}
        onSave={(updated) => setProjectSettings(updated)}
      />
    </div>
  );
}
