import { t, problemText, useLocale, setUiLocale } from './i18n';
/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import type {ProjectWorkspace} from './shared/durable-project';
import {SprintPanel} from './components/SprintPanel';
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
import { SessionPanel } from './components/BottomPanel';
import { FinishModal } from './components/FinishModal';
import { ProjectSettingsModal } from './components/ProjectSettingsModal';
import { FolderPicker } from './components/FolderPicker';
import { RecentProjects } from './components/RecentProjects';
import {RECENT_PROJECTS_KEY, parseRecentProjects, rememberProject} from './services/recentProjects';
import { MOCK_SCENARIOS } from './data/mockScenarios';

export default function App() {
  const [state, setState] = useState(client.getState());
  const locale=useLocale();
  const [theme,setTheme]=useState<'darcula'|'dark'|'light'>(()=>{
    try {const saved=window.localStorage.getItem('paircoach:theme');return saved==='light'||saved==='dark'?saved:'darcula';}
    catch {return 'darcula';}
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
  const [openTabs, setOpenTabs] = useState<string[]>(state.activePath?[state.activePath]:[]);
  const [isDevSimulatorOpen, setIsDevSimulatorOpen] = useState(client.transportMode === 'MOCK_SIMULATOR');

  // Resizable panel dimensions
  const [fileTreeWidth, setFileTreeWidth] = useState(340);
  const [bottomPanelHeight, setBottomPanelHeight] = useState(260);
  const [isBottomCollapsed, setIsBottomCollapsed] = useState(false);
  const [isBottomMaximized, setIsBottomMaximized] = useState(false);
  const [activeBottomTab, setActiveBottomTab] = useState<'console' | 'report'>('console');

  // Modals
  const [isFinishModalOpen, setIsFinishModalOpen] = useState(false);
  const [finishReason, setFinishReason] = useState<EndReason>('COMPLETED');
  const [isRuntimeSettingsOpen,setIsRuntimeSettingsOpen]=useState(false);
  const [isReconcilingRuntime,setIsReconcilingRuntime]=useState(false);
  const [runtimeReconcileResult,setRuntimeReconcileResult]=useState<{scope:string|null;message:string}|null>(null);
  const [isSettingsModalOpen, setIsSettingsModalOpen] = useState(false);
  const [sidebarTab,setSidebarTab]=useState<'files'|'task'|'chat'|'environment'>('files');
  const [lastReadChat,setLastReadChat]=useState(0);
  useEffect(()=>{if(sidebarTab==='chat')setLastReadChat(state.chatEntries.length);},[sidebarTab,state.chatEntries.length]);
  const [folderPickerMode,setFolderPickerMode]=useState<null|'exercise'|'create'|'project'>(null);
  const [projectBusy,setProjectBusy]=useState(false);
  const [projectActionError,setProjectActionError]=useState('');
  const [recentProjects,setRecentProjects]=useState(()=>{
    try {return parseRecentProjects(window.localStorage.getItem(RECENT_PROJECTS_KEY));}
    catch {return [];}
  });
  const [recentStorageUnavailable,setRecentStorageUnavailable]=useState(false);
  useEffect(()=>{
    try {window.localStorage.setItem(RECENT_PROJECTS_KEY,JSON.stringify(recentProjects));setRecentStorageUnavailable(false);}
    catch {setRecentStorageUnavailable(true);}
  },[recentProjects]);
  // Only server-confirmed projects enter the list; canceled/failed attempts never do.
  useEffect(()=>{
    if(state.transportMode!=='LIVE_BACKEND'||!state.durableProject)return;
    const {name,projectFile}=state.durableProject;
    setRecentProjects(entries=>rememberProject(entries,{name,projectFile}));
  },[state.transportMode,state.durableProject?.id,state.durableProject?.name,state.durableProject?.projectFile]);
  const projectActionLock=useRef(false);
  const workspaceIdentity=useRef('');
  const editorViews=useRef<NonNullable<ProjectWorkspace['editorViews']>>(Object.create(null));
  const [viewRevision,setViewRevision]=useState(0);
  const viewTimer=useRef<ReturnType<typeof setTimeout>|null>(null);
  const workspaceSaveChain=useRef<Promise<boolean>>(Promise.resolve(true));
  const workspaceSaveVersion=useRef(0);
  // Serialize metadata only; skip superseded queued views. This never writes source bytes.
  function saveWorkspace(workspace:ProjectWorkspace):Promise<boolean> {
    const project=client.getState().durableProject;
    if(!project)return Promise.resolve(false);
    const version=++workspaceSaveVersion.current;
    const operation=workspaceSaveChain.current.catch(()=>false).then(()=>{
      if(version!==workspaceSaveVersion.current)return true;
      const current=client.getState().durableProject;
      if(current?.id!==project.id||current.exercisePath!==project.exercisePath)return false;
      return client.saveProjectWorkspace(workspace);
    });
    workspaceSaveChain.current=operation;return operation;
  }
  function workspaceSnapshot():ProjectWorkspace {
    const tabs=openTabs.filter(Boolean);
    return {openTabs:tabs,activePath:tabs.includes(state.activePath)?state.activePath:null,sidebarTab,bottomTab:activeBottomTab,
      editorViews:Object.fromEntries(Object.entries(editorViews.current).filter(([path])=>tabs.includes(path)))};
  }
  function captureEditorView(owner:string,path:string,view:NonNullable<ProjectWorkspace['editorViews']>[string]) {
    const current=client.getState().durableProject;
    if(!current||owner!==workspaceIdentity.current||owner!==current.id+':'+(current.exercisePath??''))return;
    editorViews.current[path]=view;
    if(viewTimer.current===null)viewTimer.current=setTimeout(()=>{viewTimer.current=null;setViewRevision(v=>v+1);},180);
  }
  useEffect(()=>()=>{if(viewTimer.current!==null)clearTimeout(viewTimer.current);},[]);
  const previousProject=useRef<string|null>(null);
  const localeChange=useRef(0);
  const isLive=state.transportMode==='LIVE_BACKEND';
  const hasProject=!isLive||!!state.durableProject;
  const hasExercise=!isLive||!!state.durableProject?.exercisePath;
  const emptyWorkspaceLabel=!hasProject?'Brak otwartego projektu':!hasExercise?'Brak otwartego ćwiczenia':undefined;
  async function changeLocale() {
    const next=locale==='pl'?'en':'pl', request=++localeChange.current;
    setProjectActionError('');
    if(!isLive){setUiLocale(next);return;}
    const accepted=await client.setLocale(next);
    if(request!==localeChange.current)return;
    if(accepted)setUiLocale(next);else setProjectActionError(t('Preferencja języka nie została potwierdzona przez serwer.'));
  }
  useEffect(()=>{if(state.locale)setUiLocale(state.locale);},[state.locale]);
  useEffect(()=>{
    if(!isLive)return;
    const project=state.durableProject;
    const identity=project?project.id+':'+(project.exercisePath??''):'';
    if(identity===workspaceIdentity.current)return;
    workspaceIdentity.current=identity;
    editorViews.current=Object.assign(Object.create(null),structuredClone(project?.workspace.editorViews??{}));
    if(viewTimer.current!==null){clearTimeout(viewTimer.current);viewTimer.current=null;}
    setOpenTabs(project?.workspace.openTabs??[]);
    setSidebarTab(project?.workspace.sidebarTab??'files');
    setActiveBottomTab(project?.workspace.bottomTab??'console');
    setLastReadChat(0);
    if(previousProject.current!==project?.id){setProjectActionError('');setIsSettingsModalOpen(false);setIsFinishModalOpen(false);setIsRuntimeSettingsOpen(false);}
    previousProject.current=project?.id??null;
  },[isLive,state.durableProject?.id,state.durableProject?.exercisePath]);
  // Only the current backend-acknowledged workspace owns this view-state write.
  // Source drafts continue to use the existing WriteGate/ACK path, never this metadata save.
  useEffect(()=>{
    const project=state.durableProject;
    if(!isLive||!project||!project.exercisePath||projectBusy||state.isOffline||state.workspaceVersion===0)return;
    const identity=project.id+':'+project.exercisePath;
    if(workspaceIdentity.current!==identity)return;
    const current=client.getState();
    if(current.durableProject?.id!==project.id||current.durableProject?.exercisePath!==project.exercisePath)return;
    // Defer so restoring project state cannot be overwritten by a previous render.
    const timer=window.setTimeout(()=>{
      const latest=client.getState().durableProject;
      if(latest?.id!==project.id||latest.exercisePath!==project.exercisePath)return;
      void saveWorkspace(workspaceSnapshot());
    },180);
    return()=>window.clearTimeout(timer);
  },[isLive,state.durableProject?.id,state.durableProject?.exercisePath,openTabs,state.activePath,sidebarTab,activeBottomTab,viewRevision,projectBusy,state.isOffline,state.workspaceVersion]);
  async function projectAction(action:()=>Promise<boolean>) {
    if(projectActionLock.current)return false;
    projectActionLock.current=true;setProjectBusy(true);setProjectActionError('');
    try {
      const current=client.getState().durableProject;
      if(current?.exercisePath&&!await saveWorkspace(workspaceSnapshot())) {
        setProjectActionError(client.getState().projectError??t('Zapis projektu niepotwierdzony'));return false;
      }
      if(await action()) {
        const opened=client.getState().durableProject;
        if(opened)setRecentProjects(entries=>rememberProject(entries,opened));
        return true;
      }
      setProjectActionError(client.getState().projectError??t('Nie zmieniono bieżącego projektu. Sprawdź komunikat błędu.'));return false;
    }catch(error){setProjectActionError(error instanceof Error?error.message:String(error));return false;}
    finally {projectActionLock.current=false;setProjectBusy(false);}
  }
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
        // Empty transport shell is not a deletion inventory. Keep restored tabs until the real snapshot arrives.
        if(newState.transportMode==='LIVE_BACKEND'&&newState.durableProject?.exercisePath&&(newState.isOffline||newState.workspaceVersion===0))return prev;
        const existingPaths = new Set(newState.files.filter(f => f.kind === 'FILE').map((f) => f.path));
        let validTabs = prev.filter((p) => existingPaths.has(p));
        if (newState.activePath && existingPaths.has(newState.activePath) && !validTabs.includes(newState.activePath)) {
          validTabs = [...validTabs, newState.activePath];
        }
        if (validTabs.length === 0 && newState.files.length > 0) {
          validTabs = [newState.activePath || newState.files[0].path];
        }
        return validTabs.length===prev.length&&validTabs.every((path,index)=>path===prev[index])?prev:validTabs;
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
    if(!openTabs.includes(path)&&openTabs.length>=100){setProjectActionError(t('Otwartych jest już 100 plików. Zamknij zakładkę przed otwarciem kolejnego pliku.'));return;}
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
  const taskMarkdownContent = taskFile?.loaded === false && !state.taskReadError ? t('Wczytywanie zadania…') : taskFile?.content ?? t('Treść zadania nie została znaleziona.');

  const connectionStatus = (
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] leading-relaxed min-w-0 [overflow-wrap:anywhere]" role="status">
        <strong>{state.transportMode === 'LIVE_BACKEND' ? t("LIVE — lokalny backend") : t("MOCK — jawna symulacja, bez zapisu na dysk")}</strong>
        {state.transportMode === 'LIVE_BACKEND' && <>
          <span>{state.isOffline ? t("Synchronizacja / Offline — niepotwierdzone zmiany pozostają lokalne.") : state.pendingPaths.length ? t("Zapis oczekuje na ACK.") : t("Połączono z backendem.")}</span>
          <button className="underline" disabled={state.isOffline||!hasProject||projectBusy} onClick={() => setFolderPickerMode('exercise')}>{t("Otwórz folder…")}</button>
          <button className="underline" onClick={() => {setProjectActionError('');client.reconnect();}}>{t("Połącz ponownie")}</button>
        </>}
        {state.connectionError && <span role="alert" className="text-amber-300 break-words">{problemText(state.connectionError)}</span>}
        {state.runtime?.reconciliationRequired && <button type="button" disabled={state.isOffline || isReconcilingRuntime} onClick={async()=>{const scope=client.getReportHistoryScope();setIsReconcilingRuntime(true);setRuntimeReconcileResult(null);try {const ok=await client.reconcileRuntimeMutation();if(scope===client.getReportHistoryScope())setRuntimeReconcileResult({scope,message:ok?t("Potwierdzono rozstrzygnięcie operacji. Sprawdź bieżący stan w sekcji środowiska."):client.getState().runtime?.error ?? t("Nie potwierdzono wyniku. Blokada zachowana.")});} finally {setIsReconcilingRuntime(false);}}} className="underline px-2 py-1">{isReconcilingRuntime ? t("Sprawdzanie wyniku…") : t("Sprawdź wynik operacji")}</button>}
        {(isReconcilingRuntime || (runtimeReconcileResult && runtimeReconcileResult.scope===client.getReportHistoryScope())) && <span role="status" aria-live="polite">{isReconcilingRuntime ? t("Sprawdzanie autoryzowanego wyniku…") : problemText(runtimeReconcileResult?.message)}</span>}
        {state.runtime?.reconciliationRequired && <span role="alert" className="text-amber-300">{t("Wynik Run lub zapisu jest nieznany. Nowy Run i zapis zablokowane do autoryzowanego rozstrzygnięcia dokładnego żądania. Ponowne połączenie nie usuwa blokady; nie odświeżaj strony, zachowaj draft. Ręczna edycja i Stop znanego wykonania pozostają dostępne.")}</span>}
        {state.storageError && <span role="alert" className="text-rose-300">{problemText(state.storageError)}</span>}
      </div>
  );
  const environmentDetails = state.transportMode==='LIVE_BACKEND' ? (
    <div id="project-environment-panel" className="min-w-0 text-xs [overflow-wrap:anywhere]">
        <RuntimeStatusV2 execution={state.runtime?.execution && (state.runtime.reconciliationRequired || state.writeOwner!=='STUDENT' || !!state.fileConflict) ? {...state.runtime.execution,modes:{RUN_MAIN:{...state.runtime.execution.modes.RUN_MAIN,canRun:false},RUN_TESTS:{...state.runtime.execution.modes.RUN_TESTS,canRun:false}}} : state.runtime?.execution ?? null} language={state.language ?? null} diagnostics={state.languageDiagnostics}
          run={state.runtime?.run ?? null} connected={!state.isOffline} canExecute={!state.isOffline}
          preparation={state.runtime?.maintenance} onPrepare={state.transportMode==='LIVE_BACKEND'?reconcile=>{void client.prepareRuntimeEnvironment(reconcile);}:undefined}
          pending={!!state.runtime?.pending}
          error={state.runtime?.reconciliationRequired ? t("Wynik Run lub zapisu nieznany. Wymagany autoryzowany odczyt dokładnego requestId; ponowne połączenie nie usuwa blokady. Ręczna edycja dostępna.") : state.runtime?.error}
          onRun={mode=>mode==='RUN_TESTS'?client.runTests():client.runMain()} onStop={()=>client.stopExecution()} onSettings={()=>setIsRuntimeSettingsOpen(true)} />
        {state.languageProblem && <p role="status">{problemText(state.languageProblem)}</p>}
    </div>
  ) : undefined;
  const projectControls=<div className="flex flex-wrap gap-2 text-xs [overflow-wrap:anywhere]">
    {state.durableProject && <strong className="basis-full break-all" title={state.durableProject.projectFile}>{state.durableProject.name}</strong>}
    <button type="button" disabled={projectBusy||state.isOffline} onClick={()=>{setProjectActionError('');setFolderPickerMode('create');}} className="underline">{t('Utwórz projekt')}</button>
    <button type="button" disabled={projectBusy||state.isOffline} onClick={()=>{setProjectActionError('');setFolderPickerMode('project');}} className="underline">{t('Otwórz projekt')}</button>
    {state.durableProject && <button type="button" disabled={projectBusy||state.isOffline} className="underline"
      onClick={()=>void projectAction(()=>client.closeDurableProject())}>{t('Zamknij projekt')}</button>}
    <RecentProjects projects={recentProjects} disabled={projectBusy||state.isOffline}
      storageUnavailable={recentStorageUnavailable}
      onOpen={path=>void projectAction(()=>client.openDurableProject(path))}
      onRemove={path=>setRecentProjects(entries=>entries.filter(entry=>entry.projectFile!==path))}/>
  </div>;
  const projectFooter = <div className="space-y-2">
    {isLive && projectControls}
    {connectionStatus}
  </div>;

  return (
    <div className="flex flex-col h-screen w-screen overflow-hidden bg-zinc-950 font-sans text-zinc-100"
      style={{'--pc-reading-scale':contentFontSize/13} as React.CSSProperties}>
      {/* Top Header Bar */}
      <HeaderBar
        emptyWorkspaceLabel={emptyWorkspaceLabel}
        theme={theme}
        onToggleTheme={()=>setTheme(value=>value==='darcula'?'dark':value==='dark'?'light':'darcula')}
        locale={locale}
        onToggleLocale={()=>void changeLocale()}
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

      {(projectActionError||state.projectError) && <div role="alert" className="shrink-0 border-b border-rose-700 bg-rose-950 px-3 py-2 text-xs text-rose-200 break-words">
        {problemText(projectActionError||state.projectError)}
      </div>}
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
        <aside style={{ width: `min(${fileTreeWidth}px, 42vw)` }} className="shrink-0 h-full min-w-0 overflow-hidden flex flex-col border-r border-zinc-800">
          <div role="tablist" aria-label={t('Panel projektu')} className="flex flex-wrap gap-1 p-1 border-b border-zinc-800 text-[11px]">
            {(['files','task','chat','environment'] as const).map(tab=><button key={tab} id={'sidebar-tab-'+tab} type="button" role="tab"
              aria-selected={sidebarTab===tab} aria-controls={'sidebar-panel-'+tab}
              onClick={()=>setSidebarTab(tab)} className={'px-2 py-1 rounded '+(sidebarTab===tab?'bg-zinc-700 text-zinc-100':'text-zinc-400 hover:bg-zinc-800')}>
              {t(tab==='files'?'Pliki projektu':tab==='task'?'Zadanie':tab==='chat'?'Czat':'Środowisko')}
              {tab==='chat' && (state.chatEntries.length>lastReadChat || state.activeProposal) && <span aria-label={t('Nieprzeczytane wiadomości')} className="ml-1 text-purple-300">●</span>}
            </button>)}
          </div>
          <div role="tabpanel" id="sidebar-panel-files" aria-labelledby="sidebar-tab-files" hidden={sidebarTab!=='files'} className="flex-1 min-h-0">
          {!hasExercise ? <div className="p-3 text-sm space-y-3 overflow-y-auto h-full">
            <p>{t(hasProject?'Brak otwartego ćwiczenia.':'Nie ma otwartego projektu.')}</p>
            <p className="text-zinc-400">{t('Utwórz lub otwórz projekt, a następnie wybierz folder ćwiczenia.')}</p>
            {projectControls}{connectionStatus}
          </div> : <FileTree
            footer={projectFooter}
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
          />}
          </div>
          <div role="tabpanel" id="sidebar-panel-environment" aria-labelledby="sidebar-tab-environment" hidden={sidebarTab!=='environment'} className="flex-1 min-h-0 overflow-y-auto p-2">{environmentDetails}</div>
          <div role="tabpanel" id={'sidebar-panel-'+(sidebarTab==='chat'?'chat':'task')} aria-labelledby={'sidebar-tab-'+(sidebarTab==='chat'?'chat':'task')}
            hidden={sidebarTab!=='task'&&sidebarTab!=='chat'} className="flex-1 min-h-0">
            {sidebarTab==='task' && isLive && state.durableProject && <SprintPanel
              key={state.durableProject.id} client={client} state={state} />}
            {sidebarTab==='task' && state.taskReadError && <div role="alert" className="p-2 text-xs text-amber-300">{t('Błąd pliku zadania')}: {problemText(state.taskReadError.message)}</div>}
            <SessionPanel key={state.durableProject?.id??'empty'} sidebar activeTab={sidebarTab==='chat'?'chat':'task'} taskContent={taskMarkdownContent}
              chatEntries={state.chatEntries} activeProposal={state.activeProposal} activeRun={null} report={null}
              height={0} isMaximized={false} isCollapsed={false} onSelectTab={tab=>{if(tab==='task'||tab==='chat')setSidebarTab(tab);}}
              onSendMessage={msg=>client.sendChatMessage(msg)} onProposalResponse={(id,accept)=>client.respondToProposal(id,accept)}
              onRetryReport={()=>{}} onToggleCollapse={()=>{}} onToggleMaximize={()=>{}} />
          </div>
        </aside>

        {/* Horizontal Resizable Splitter */}
        <div
          onMouseDown={() => {
            isDraggingHorizontalRef.current = true;
            document.body.style.cursor = 'col-resize';
            document.body.style.userSelect = 'none';
          }}
          className="w-1 hover:w-1.5 bg-zinc-800 hover:bg-blue-500 cursor-col-resize transition-all z-10 shrink-0"
          title={t("Przeciągnij, aby zmienić szerokość drzewa plików")}
        />

        {/* Center & Bottom: Editor and Bottom Panels */}
        <div className="flex-1 min-h-0 min-w-0 flex flex-col h-full overflow-hidden">
          {/* Middle: Shared Monaco Editor */}
          <div className="flex-1 min-h-0 overflow-hidden relative">
            <EditorPanel
              emptyWorkspaceLabel={emptyWorkspaceLabel}
              theme={theme}
              contentFontSize={contentFontSize}
              initialEditorViews={state.durableProject?.workspace.editorViews}
              onEditorViewChange={(path,view)=>captureEditorView((state.durableProject?.id??'')+':'+(state.durableProject?.exercisePath??''),path,view)}
              key={(state.durableProject?.id??'mock')+':'+state.scenario.id}
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
              isBottomPanelVisible={sidebarTab==='chat'}
              activeBottomTab={sidebarTab}
              onOpenChat={()=>setSidebarTab('chat')}
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
              title={t("Przeciągnij, aby zmienić wysokość dolnego panelu")}
            />
          )}

          {/* Bottom Panel: Zadanie, Czat, Konsola, Raport */}
          <SessionPanel
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
            onSelectTab={tab=>{if(tab==='console'||tab==='report')setActiveBottomTab(tab);}}
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
      {folderPickerMode && <FolderPicker key={folderPickerMode+':'+(state.durableProject?.id??'empty')}
        mode={folderPickerMode} actionError={projectActionError} list={(path,signal)=>client.listFolders(path,signal)}
        open={path=>projectAction(()=>folderPickerMode==='project'?client.openDurableProject(path):client.openProject(path))}
        create={(directory,name)=>projectAction(()=>client.createDurableProject(directory,name))}
        blocked={projectBusy?t('Otwieranie…'):folderPickerMode==='exercise'?client.folderOpenProblem():null}
        onClose={()=>setFolderPickerMode(null)} />}
      <ProjectSettingsModal
        isOpen={isSettingsModalOpen}
        settings={projectSettings}
        settingsVersion={state.workspaceVersion}
        connected={!state.isOffline}
        canSave={state.transportMode!=='LIVE_BACKEND' || (state.writeOwner==='STUDENT' && !state.runtime?.pending && !state.runtime?.reconciliationRequired && !state.runtime?.maintenance?.blocked)}
        rootPath={state.transportMode === 'LIVE_BACKEND' ? state.scenario.title : undefined}
        onOpenProject={state.transportMode === 'LIVE_BACKEND' ? (root) => projectAction(()=>client.openProject(root)) : undefined}
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
