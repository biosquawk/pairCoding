import type { RunV2, SettingsV2, RunRequestV2, UpdateSettingsRequestV2 } from '../shared/runtime-v2';
import type { MutationIdentity } from '../shared/runtime-mutation-v2';
import type { LanguageAuthorityV2, AutosaveAckEnvelope } from './runtimeWiringV2';
import { validateMutationOutcomeV2, validateReconcileMutationRequestV2, validateLanguageView, validateExecutionView, validateRunV2, validateV2WireShape, validateLanguageServerMessage } from '../shared/validation-v2';
import { RuntimeWiringV2, type WiringControllerV2 } from './runtimeWiringV2';
import type { SettingsSaveResultV2 } from './RuntimeClientV2';
import type { EditorLanguageBinding } from './monacoLspBridge';
import type * as Wire from '../shared/protocol';
import { EditorViewThrottleP2, sameEditorViewP2, type EditorViewObservationP2 } from './editorViewP2';
import type { ReportSummary } from './reportHistory';
import type { CoachEditStep, EndReason, ProjectSettings, WindowPresence } from '../types/paircoach';
import type { ClientState, ServerMessage, ServerPayloads, UpdatedFile, ProjectSnapshot, BundleSnapshot } from './liveTypes';
import { emptyLiveState, mapDocument, mapProposal, mapReport, mapRun, mapSettings } from './liveMapper';

type Socket = Pick<WebSocket, 'readyState' | 'send' | 'close' | 'onopen' | 'onmessage' | 'onerror' | 'onclose'>;
export interface LiveOptions {
  baseUrl?: string;
  token?: string | null;
  fetch?: typeof fetch;
  socket?: (url: string) => Socket;
  storage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
  clientId?: string;
}
type Draft = { content: string; baseVersion: number };
type Flight = { messageId: string; content: string; stamp?: import('../shared/language-v2').DocumentStamp; projectId?: string; sessionId?: string; generation?: number; baseVersion?: number; controlEpoch?: number; timer?: ReturnType<typeof setTimeout> };
type Save = { draft: Draft; flight?: Flight; timer?: ReturnType<typeof setTimeout>; conflict: boolean };
type ProposalDecision = {
  messageId: string; sessionId: string; clientId: string; proposalId: string; accepted: boolean;
  raw: string; wait: Promise<void>; done: () => void; timer?: ReturnType<typeof setTimeout>;
  notice: string | null; disconnected: boolean; replayed: boolean;
};
type FinishAttempt = {
  requestId: string; clientId: string; sessionId: string; expectedWorkspaceVersion: number; reason: EndReason;
  unknown: boolean; replaced: boolean; notice: string | null; previousError: string | null;
  observedReport: Wire.Report | null; reading: boolean; readAgain: boolean;
};
class HttpDeadlineError extends Error {}
// A received rejection status is authoritative except for the server's explicit
// ambiguous ledger503 codes. Those are not proof that the effect was rejected.
// Fetch failures and successful responses with unreadable bodies are NOT rejections.
class HttpRejectedError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string, readonly bodyUnreadable = false) { super(message); }
  get ambiguous() {
    return this.status === 503 && (this.bodyUnreadable || this.code === 'COMMAND_RESULT_UNAVAILABLE' || this.code === 'COMMAND_STORAGE_UNAVAILABLE');
  }
}
const id = () => globalThis.crypto.randomUUID();
const sameJSON=(a:unknown,b:unknown):boolean=>{
  if(a===b)return true;if(!a||!b||typeof a!=='object'||typeof b!=='object')return false;
  const keys=Object.keys(a);return keys.length===Object.keys(b).length&&keys.every(k=>Object.hasOwn(b,k)&&sameJSON((a as Record<string,unknown>)[k],(b as Record<string,unknown>)[k]));
};

// UTF-16 positions, exactly as Monaco and the wire contract. Reject clamped/invalid ranges.
export function applyWireEdit(content: string, range: Wire.Range, text: string): string {
  const lines = content.split('\n');
  const offset = (line: number, column: number) => {
    if (!Number.isInteger(line) || !Number.isInteger(column) || line < 1 || line > lines.length || column < 1 || column > lines[line - 1].length + 1) throw new Error('Niepoprawny zakres kroku trenera.');
    return lines.slice(0, line - 1).reduce((sum, l) => sum + l.length + 1, 0) + column - 1;
  };
  const start = offset(range.startLine, range.startColumn), end = offset(range.endLine, range.endColumn);
  if (end < start) throw new Error('Odwrócony zakres kroku trenera.');
  return content.slice(0, start) + text + content.slice(end);
}

export class LiveBackend {
  private state: ClientState = emptyLiveState();
  private listeners = new Map<string, Set<(value: any) => void>>();
  private documents = new Map<string, Wire.Document>();
  private loadErrors = new Map<string, string>();
  private saves = new Map<string, Save>();
  private pendingSteps = new Map<string, { step: ServerPayloads['COACH_STEP_EDIT']; content: string }>();
  private invalidInterventions = new Set<string>();
  private proposals = new Map<string, Wire.Proposal>();
  private outputSeq = new Map<string, number>();
  private project: ProjectSnapshot | null = null;
  private session: Wire.Session | null = null;
  private ws: Socket | null = null;
  private token: string | null;
  private baseUrl: string;
  private fetcher: typeof fetch;
  private socketFactory: (url: string) => Socket;
  private storage?: LiveOptions['storage'];
  private clientId: string;
  private lastSeq = 0;
  private synced = false;
  private latestPresence: WindowPresence | null = null;
  private connecting = false;
  private stopped = false;
  private retries = 0;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private connectionTimer?: ReturnType<typeof setTimeout>;
  private tick?: ReturnType<typeof setInterval>;
  private preparing: string | null = null;
  private prepareLoaded = false;
  private readySent = false;
  private vetoPending: string | null = null;
  private vetoCutoff: { sessionId: string; epoch: number } | null = null;
  private vetoTimer?: ReturnType<typeof setTimeout>;
  // One unresolved user decision, including its ORIGINAL immutable wire bytes.
  // A deadline stops waiting, not the remote effect or ACK correlation.
  private proposalDecision: ProposalDecision | null = null;
  private decisionResultError: string | null = null;
  private helloSnapshot: { ws: Socket; sessionId: string; clientId: string } | null = null;
  private finishAttempt: FinishAttempt | null = null;
  private finishStarting = false;
  private recoveryKey = '';
  private generation = 0;
  // A document-cache generation is not a navigation intent. Same-session
  // snapshots may describe the server view BEFORE an already requested tab.
  private selectedView: { path: string; projectId: string; sessionId: string } | null = null;
  private selectionRequest = 0;
  private snapshotsRequest = 0;
  private editorView: EditorViewObservationP2 | null = null;
  private editorViewAck: { view: EditorViewObservationP2; version: number } | null = null;
  private pathViewTimer?: ReturnType<typeof setTimeout>;
  private viewFlight: { messageId: string; scope: string; view: EditorViewObservationP2; version: number;
    wait: Promise<boolean>; done: (ok: boolean) => void; timer: ReturnType<typeof setTimeout> } | null = null;
  private viewThrottle = new EditorViewThrottleP2(() => { this.sendEditorView(); });
  private chatSending = false;

  // Exact immutable original requests retained BEFORE dispatch for the frozen reconciliation seam.
  // Metadata from RuntimeClient alone cannot reconstruct lost mode/settings. No guessed read is called.
  private runtimeMutations=new Map<string,MutationIdentity>();
  private languageScope:LanguageAuthorityV2|null=null;
  private retainRuntimeMutation(kind:'RUN'|'SAVE',request:RunRequestV2|UpdateSettingsRequestV2) {
    if(!this.project)throw new Error('Brak bieżącego projektu.');
    const key=JSON.stringify([this.project.projectId,request.sessionId,request.clientId,request.requestId]);
    const body={mutation:{projectId:this.project.projectId,kind,request}};
    if(!validateReconcileMutationRequestV2(body))throw new Error('Niepoprawna tożsamość operacji.');
    const existing=this.runtimeMutations.get(key);
    if(existing&&!sameJSON(existing,body.mutation))throw new Error('Identyfikator użyty dla innej operacji.');
    if(!existing)this.runtimeMutations.set(key,structuredClone(body.mutation));
  }
  private latestRuntimeRun: {run:RunV2;seq:number;projectId:string;sessionId:string}|null=null;
  private connectionGeneration = id();
  private readonly wiring = new RuntimeWiringV2({
    current: () => this.wiringController(), messageId: id,
    send: message => { this.send(message.type, message.payload, message.messageId); },
    problem: message => { this.state.languageProblem = message; },
    status: view => {
      if(this.project&&'language' in this.project.capabilities)this.project.capabilities.language=structuredClone(view);
      this.state.language=structuredClone(view);this.state.languageProblem=view.problem?.message??null;
      if(view.state==='FAILED'||view.state==='OFF')this.wiring.sourceChanged();
      this.publish();
    },
    runtime: {
      current: () => {
        const p = this.project, execution = p && 'execution' in p.capabilities ? p.capabilities.execution : null;
        return p && this.session && execution ? { projectId:p.projectId,sessionId:this.session.sessionId,clientId:this.clientId,
          connectionGeneration:this.connectionGeneration,workspaceVersion:this.state.workspaceVersion,
          configurationGeneration:execution.runtime.configurationGeneration,connected:this.synced && !this.stopped,
          canExecute:this.synced && !this.stopped,
          canSaveSettings:this.synced && !this.stopped && !this.preparing && !this.vetoPending && this.session.writeOwner==='STUDENT' && !this.savesHasConflict() } : null;
      }, requestId:id, http: {
        run:(body,signal)=>{this.retainRuntimeMutation('RUN',body);return this.http('/api/run','POST',body,true,signal);},
        stop:(runId,body,signal)=>this.http(`/api/run/${encodeURIComponent(runId)}/stop`,'POST',body,true,signal),
        saveSettings:(body,signal)=>{this.retainRuntimeMutation('SAVE',body);return this.http('/api/project/settings','PUT',body,true,signal);},
      },
    },
  });
  private wiringController(): WiringControllerV2 | null {
    if (!this.project || !this.session) return null;
    return { projectId:this.project.projectId,sessionId:this.session.sessionId,clientId:this.clientId,connectionGeneration:this.connectionGeneration,
      connected:this.ws?.readyState===1 && !this.stopped,synced:this.synced,writeOwner:this.session.writeOwner,
      controlEpoch:this.session.controlEpoch,preparing:!!this.preparing,vetoPending:!!this.vetoPending,
      language:this.currentLanguageScope(),
      workspaceVersion:this.project.workspaceVersion,
      sourceVector:JSON.stringify([this.project.workspaceVersion,this.project.files]),
      drafts:[...this.saves].map(([path,s])=>({path,content:s.draft.content,baseVersion:s.draft.baseVersion,conflict:s.conflict})).sort((a,b)=>a.path.localeCompare(b.path)),
      document:path=>{const d=this.documents.get(path);return d?{content:d.content,version:d.version,readOnly:d.readOnly,conflict:!!this.saves.get(path)?.conflict}:null;},
    };
  }
  private currentLanguageScope():LanguageAuthorityV2|null {
    const scope=this.languageScope,p=this.project,s=this.session,v=p&&'language' in p.capabilities?p.capabilities.language:null;
    const execution=p&&'execution' in p.capabilities?p.capabilities.execution:null;
    return scope&&p&&s&&v&&v.state!=='FAILED'&&v.state!=='OFF'&&execution&&p.projectId===s.projectId&&p.sessionId===s.sessionId&&scope.projectId===p.projectId&&scope.sessionId===s.sessionId&&
      scope.profileId===v.profileId&&scope.profileId===execution.runtime.profileId&&scope.configurationGeneration===v.configurationGeneration&&
      scope.configurationGeneration===execution.runtime.configurationGeneration&&scope.providerGeneration===v.providerGeneration ? scope : null;
  }
  private installLanguageBootstrap(bundle:BundleSnapshot) {
    this.languageScope=null;
    if(!validateV2WireShape('SessionBundle',bundle)||!('languageBootstrap' in bundle)||!bundle.languageBootstrap)return;
    const p=bundle.project,v=p.capabilities.language,e=p.capabilities.execution;
    if(!validateLanguageView(v)||!validateExecutionView(e)||p.projectId!==bundle.session.projectId||p.sessionId!==bundle.session.sessionId||v.projectId!==p.projectId||
      v.profileId!==e.runtime.profileId||v.configurationGeneration!==e.runtime.configurationGeneration)return;
    this.languageScope={...structuredClone(bundle.languageBootstrap),projectId:p.projectId,sessionId:bundle.session.sessionId,
      profileId:v.profileId,configurationGeneration:v.configurationGeneration,providerGeneration:v.providerGeneration};
  }
  private languagePresentation() {
    const scope=this.currentLanguageScope(),view=this.project&&'language' in this.project.capabilities?this.project.capabilities.language:null;
    const enabled=!!scope&&scope.provider!=='off';
    this.state.language=view?enabled||view.state==='FAILED'?structuredClone(view):{...view,state:'OFF',autocomplete:'OFF'}:null;
    this.state.languageProblem=enabled||view?.state==='FAILED' ? view?.problem?.message??null : 'Autouzupełnianie OFF: brak aktualnego autoryzowanego zakresu serwera. Ręczna edycja dostępna.';
  }
  getEditorLanguageBinding(): EditorLanguageBinding | undefined { return this.project ? this.wiring.getBinding(this.project.projectId) : undefined; }
  retainModelTombstone(path:string,content:string):boolean {
    try {if(!this.storage)throw new Error('localStorage niedostępne');
      this.storage.setItem(`${this.key()}:model-tombstone:${encodeURIComponent(path)}:${Date.now()}`,JSON.stringify({path,content,projectId:this.project?.projectId}));return true;
    } catch {this.state.storageError='Nie można zachować starego modelu. Skopiuj jego tekst przed ponownym użyciem tej samej ścieżki.';this.publish();return false;}
  }
  setBuiltinLanguageProvider(provider: EditorLanguageBinding['builtin']) { this.wiring.setBuiltin(provider); }
  private applyRuntimeProject(run: unknown = this.wiring.runtime.snapshot().run) {
    if(!this.project || !this.synced)return;
    if(validateV2WireShape('Project',this.project))this.wiring.runtime.applyProject(this.project,run);
    else if('execution' in this.project.capabilities && validateExecutionView(this.project.capabilities.execution))this.wiring.runtime.applyExecution(this.project.capabilities.execution);
  }
  constructor(options: LiveOptions = {}) {
    this.baseUrl = (options.baseUrl ?? 'http://127.0.0.1:8080').replace(/\/$/, '');
    this.token = options.token ?? null;
    this.fetcher = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.socketFactory = options.socket ?? (url => new WebSocket(url));
    this.storage = options.storage;
    this.clientId = options.clientId ?? id();
    this.wiring.runtime.subscribe(()=>{
      this.state.runtime=this.wiring.runtime.snapshot();
      if(this.state.runtime.run) this.state.activeRun=mapRun(this.state.runtime.run,this.state.activeRun);
      this.publish();
    });
    if (!this.storage && typeof window !== 'undefined') this.state.storageError = 'localStorage niedostępne. Skopiuj niezapisany draft przed zamknięciem strony.';
  }
  getState() { return this.state; }
  getAuthToken() { return this.token; }
  subscribe(event: string, fn: (value: any) => void) {
    const set = this.listeners.get(event) ?? new Set(); set.add(fn); this.listeners.set(event, set);
    return () => { set.delete(fn); };
  }
  private emit(event: string, value: any) { this.listeners.get(event)?.forEach(fn => fn(value)); }
  private publish() {
    this.state = { ...this.state, pendingPaths: [...this.saves.keys()], isOffline: !this.synced,
      writeOwner: !this.synced ? 'SYNCING' : this.vetoPending ? 'STUDENT' : this.preparing ? 'SYNCING' : this.session?.writeOwner ?? 'SYNCING' };
    this.emit('state', this.state);
  }
  private fail(error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    if (this.finishAttempt && message !== this.finishAttempt.notice && message !== this.proposalDecision?.notice) this.finishAttempt.previousError = message;
    this.state.connectionError = message; this.publish();
  }
  private key() { return `paircoach:draft:v3:${this.baseUrl}:${this.project?.rootPath}`; }
  private persist() {
    if (!this.project || !this.storage) return;
    try {
      const drafts = Object.fromEntries([...this.saves].map(([path, save]) => [path, save.draft]));
      if (this.saves.size) this.storage.setItem(this.key(), JSON.stringify(drafts));
      else this.storage.removeItem(this.key());
      this.state.storageError = null;
    } catch { this.state.storageError = 'Nie można zachować draftu w localStorage. Skopiuj niezapisany tekst przed zamknięciem strony.'; }
  }
  private restoreDrafts() {
    if (!this.project || !this.storage || this.recoveryKey === this.key()) return;
    this.recoveryKey = this.key();
    try {
      const stored = this.storage.getItem(this.key());
      if (!stored) return;
      for (const [path, value] of Object.entries(JSON.parse(stored) as Record<string, Draft>)) {
        if (value && typeof value.content === 'string' && Number.isInteger(value.baseVersion) && value.baseVersion >= 1) this.saves.set(path, { draft: value, conflict: false });
      }
    } catch { this.state.storageError = 'Nie można odczytać zapisanego draftu. Magazyn przeglądarki wymaga sprawdzenia.'; }
  }
  private async http<T>(path: string, method = 'GET', body?: unknown, authenticate = true, signal?: AbortSignal): Promise<T> {
    const controller = new AbortController();
    const abort=()=>controller.abort(); signal?.addEventListener('abort',abort,{once:true}); if(signal?.aborted)controller.abort();
    const timer = setTimeout(() => controller.abort(), 5000);
    try {
      const response = await this.fetcher(`${this.baseUrl}${path}`, { method, signal: controller.signal, headers: {
        ...(authenticate ? { Authorization: `Bearer ${this.token ?? ''}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {})
      }, ...(body ? { body: JSON.stringify(body) } : {}) });
      if (!response.ok) {
        let data: { code?: string; message?: string } | null = null;
        let bodyUnreadable = false;
        try { data = await response.json(); } catch { bodyUnreadable = true; }
        // Lost503 bodies can hide an effect-ambiguous ledger receipt. The status
        // alone cannot release a finish attempt; readable ordinary rejections can.
        const fallback = response.status === 503 && bodyUnreadable ? 'Nie odczytano odpowiedzi błędu serwera.' : 'Żądanie odrzucone';
        throw new HttpRejectedError(`${data?.code ?? response.status}: ${data?.message ?? fallback}`, response.status, data?.code, bodyUnreadable);
      }
      return await response.json() as T;
    } catch (error) {
      if (error instanceof HttpRejectedError) throw error;
      if (controller.signal.aborted) throw new HttpDeadlineError('Brak odpowiedzi serwera (5 s). Wynik operacji jest nieznany; nie ponawiaj mutacji bez sprawdzenia stanu.');
      throw error;
    } finally { clearTimeout(timer); signal?.removeEventListener('abort',abort); }
  }
  private commandBody(extra: object = {}, requestId = id()) {
    if (!this.session) throw new Error('Sesja nie jest jeszcze zsynchronizowana. Połącz ponownie.');
    return { requestId, clientId: this.clientId, sessionId: this.session.sessionId, ...extra };
  }
  private send(type: string, payload: object, messageId: string = id()) {
    if (!this.session || this.ws?.readyState !== 1) throw new Error('Brak połączenia WebSocket. Draft pozostaje lokalny.');
    this.ws.send(JSON.stringify({ protocolVersion: '3.0', messageId, sessionId: this.session.sessionId, clientId: this.clientId, type, payload }));
    return messageId;
  }
  async connect() {
    if (this.connecting || this.stopped) return;
    this.connecting = true;
    try {
      if (!this.token) this.token = (await this.http<{ token: string }>('/dev/bootstrap', 'GET', undefined, false)).token;
      if (!this.token) throw new Error('Brak tokenu lokalnego serwera. Otwórz URL launchera lub uruchom backend.');
      const [project, session] = await Promise.all([this.http<ProjectSnapshot>('/api/project'), this.http<Wire.Session>('/api/session')]);
      if (this.stopped) return;
      if (this.session && this.session.sessionId !== session.sessionId) {
        this.lastSeq = 0; this.invalidInterventions.clear();
        const decision = this.proposalDecision;
        if (decision) {
          clearTimeout(decision.timer); decision.done(); this.proposalDecision = null;
          this.decisionResultError = 'SESSION_REPLACED: Sesja uległa zmianie lub serwer został uruchomiony ponownie; wynik nieznany dla poprzedniej decyzji. Nie ponowiono operacji. Sprawdź pliki i kopie odzyskiwania.';
          this.fail(new Error(this.decisionResultError));
        }
      }
      this.replaceFinishSession(session.sessionId);
      this.clearForeignSnapshots(project.projectId); this.project = project; this.session = session;
      const ws = this.socketFactory(`${this.baseUrl.replace(/^http/, 'ws')}/ws/session`);
      this.connectionGeneration=id(); this.wiring.invalidate('SCOPE'); this.ws = ws;
      this.connectionTimer = setTimeout(() => { if (!this.synced) ws.close(); }, 5000);
      ws.onopen = () => { if (ws === this.ws) { try {
        this.helloSnapshot = { ws, sessionId: this.session!.sessionId, clientId: this.clientId };
        this.send('HELLO', { token: this.token!, lastServerSeq: this.lastSeq });
      } catch (error) { this.helloSnapshot = null; this.fail(error); ws.close(); } } };
      ws.onmessage = event => {
        if (ws !== this.ws) return;
        try { this.receive(JSON.parse(String(event.data))); } catch (error) { this.fail(error); this.resync(); }
      };
      ws.onerror = () => { if (ws === this.ws) { this.fail(new Error('Błąd połączenia z backendem.')); ws.close(); } };
      ws.onclose = () => { if (ws === this.ws) { this.ws = null; this.disconnected(); } };
    } catch (error) { this.fail(error); this.disconnected(); }
    finally { this.connecting = false; }
  }
  reconnect() { this.retries = 0; this.stopped = false; clearTimeout(this.reconnectTimer); this.resync(); }
  private disconnected() {
    this.languageScope=null;this.languagePresentation();
    this.wiring.invalidate('DISCONNECTED');
    if (this.stopped) return;
    this.invalidateEditorView();
    this.synced = false; this.preparing = null; this.pendingSteps.clear(); this.generation++;
    clearTimeout(this.connectionTimer); clearInterval(this.tick);
    for (const save of this.saves.values()) { clearTimeout(save.timer); clearTimeout(save.flight?.timer); save.flight = undefined; }
    this.helloSnapshot = null;
    if (this.proposalDecision) {
      this.proposalDecision.disconnected = true;
      this.unknownDecision(this.proposalDecision, 'Połączenie utracone; wynik nieznany dla decyzji. Połącz ponownie, aby odczytać wcześniejszy wynik.');
    }
    this.persist(); this.publish();
    if (this.retries < 3) {
      const delay = [500, 1000, 2000][this.retries++];
      clearTimeout(this.reconnectTimer); this.reconnectTimer = setTimeout(() => void this.connect(), delay);
    } else {
      this.state.connectionError = this.proposalDecision?.notice ?? this.finishAttempt?.notice ?? this.decisionResultError
        ?? 'Offline. Draft jest lokalny, nie na dysku. Wybierz „Połącz ponownie”.'; this.publish();
    }
  }
  private resync() {
    this.languageScope=null;this.languagePresentation();
    this.wiring.invalidate('DISCONNECTED');
    this.invalidateEditorView();
    this.synced = false; this.pendingSteps.clear(); this.publish();
    if (this.ws) this.ws.close(); else this.disconnected();
  }
  close() {
    this.languageScope=null;this.languagePresentation();
    this.wiring.invalidate('DISCONNECTED');
    this.invalidateEditorView();
    this.stopped = true; this.generation++;
    clearTimeout(this.reconnectTimer); clearTimeout(this.connectionTimer); clearTimeout(this.vetoTimer); clearInterval(this.tick);
    this.saves.forEach(s => { clearTimeout(s.timer); clearTimeout(s.flight?.timer); });
    if (this.proposalDecision) { clearTimeout(this.proposalDecision.timer); this.proposalDecision.done(); }
    this.proposalDecision = null; this.helloSnapshot = null; this.decisionResultError = null;
    this.finishAttempt = null;
    this.persist(); this.ws?.close(); this.ws = null;
  }
  private clearForeignSnapshots(projectId: string) {
    if (this.project?.projectId !== projectId) {
      // Never display recovery copies (or their read error) from another root
      // while its replacement list is still loading.
      this.snapshotsRequest++;
      this.state.snapshots = []; this.state.snapshotsError = null;
    }
  }
  private projectState(project: ProjectSnapshot) {
    this.clearForeignSnapshots(project.projectId);
    const previous=this.project;
    if(previous && (previous.projectId!==project.projectId || JSON.stringify(previous.files)!==JSON.stringify(project.files))) this.wiring.sourceChanged();
    this.project = project;
    this.languagePresentation();
    this.state.workspaceVersion = project.workspaceVersion;
    this.state.projectSettings = mapSettings(project.settings);
    const c = project.capabilities;
    const execution='execution' in c ? c.execution : null;
    this.state.capabilities = { canRunMain:!!execution?.modes.RUN_MAIN.canRun,canRunTests:!!execution?.modes.RUN_TESTS.canRun,
      docsPlugin:'NOT_INSTALLED',autocompletePlugin:'OFF',
      runMainReason:execution?.modes.RUN_MAIN.problem?.message ?? 'Wymagany profil wykonania V2. Otwórz ustawienia wykonania.',
      runTestsReason:execution?.modes.RUN_TESTS.problem?.message ?? 'Wymagany profil wykonania V2. Otwórz ustawienia wykonania.' };
    this.state.scenario = { ...this.state.scenario, id: project.projectId, title: project.rootPath, taskMode: this.state.projectSettings.taskMode,
      taskFilePath: this.state.projectSettings.taskFilePath, reviewNotesPath: this.state.projectSettings.reviewNotesPath, capabilities: this.state.capabilities };
    const taskPath = this.state.projectSettings.taskFilePath;
    const taskError = taskPath ? this.loadErrors.get(taskPath) : undefined;
    this.state.taskReadError = taskPath && taskError ? { path: taskPath, message: taskError } : null;
    const visible = [...project.files];
    this.saves.forEach((save, path) => { if (!visible.some(f => f.path === path)) visible.push({ path, kind: 'FILE', version: save.draft.baseVersion }); });
    this.state.files = visible.map(f => ({ path: f.path, kind: f.kind, version: f.version ?? 0,
      content: this.saves.get(f.path)?.draft.content ?? this.documents.get(f.path)?.content ?? '', loaded: this.documents.has(f.path) || this.saves.has(f.path), loadError: this.loadErrors.get(f.path), readOnly: this.documents.get(f.path)?.readOnly }));
  }
  private sessionState(session: Wire.Session) {
    this.replaceFinishSession(session.sessionId);
    if (this.session && session.controlEpoch < this.session.controlEpoch) return;
    if(this.session && (session.sessionId!==this.session.sessionId || session.controlEpoch!==this.session.controlEpoch || session.writeOwner!==this.session.writeOwner)) this.wiring.sourceChanged();
    this.session = session;
    this.wiring.authoritativeState(session.controlEpoch);
    this.state.controlEpoch = session.controlEpoch; this.state.workspaceVersion = session.workspaceVersion;
    this.state.coachMode = session.coachMode; this.state.aiStatus = session.aiStatus;
    this.state.sessionStatus = session.timer.status; this.state.pauseOnHidden = session.timer.pauseOnHidden;
    this.state.windowPresence = session.presence; this.state.elapsedMs = session.timer.elapsedMs; this.state.limitMs = session.timer.limitMs ?? 0;
    clearInterval(this.tick);
    const at = Date.now();
    if (session.timer.status === 'RUNNING' || session.timer.status === 'OVERTIME') this.tick = setInterval(() => {
      this.state.elapsedMs = session.timer.elapsedMs + Math.max(0, Date.now() - at);
      if (session.timer.limitMs !== null && this.state.elapsedMs >= session.timer.limitMs) this.state.sessionStatus = 'OVERTIME';
      this.publish();
    }, 250);
  }
  private installDocument(doc: Wire.Document, external = true) {
    const previous = this.documents.get(doc.path);
    if (this.editorView?.path === doc.path && (external || previous?.content !== doc.content || previous?.version !== doc.version)) this.invalidateEditorView();
    this.loadErrors.delete(doc.path);
    const save = this.saves.get(doc.path);
    this.documents.set(doc.path, doc);
    if (save) {
      if (save.draft.content === doc.content && !save.flight) { clearTimeout(save.timer); this.saves.delete(doc.path); }
      else if (save.draft.baseVersion !== doc.version || external) {
        save.conflict = true;
        this.state.fileConflict = { path: doc.path, localDraftContent: save.draft.content, diskContent: doc.content };
      }
    }
    this.projectState(this.project!);
    const file = this.state.files.find(f => f.path === doc.path);
    if (file) this.emit('file', { ...file, isExternalOrSnapshot: !this.saves.has(doc.path) });
    this.persist();
  }
  private async loadFile(path: string, external = false) {
    const generation = this.generation;
    let doc: Wire.Document;
    try { doc = await this.http<Wire.Document>(`/api/file?path=${encodeURIComponent(path)}`); }
    catch (error) {
      if (generation !== this.generation || this.stopped) return;
      this.loadErrors.set(path, error instanceof Error ? error.message : String(error));
      if (this.project) this.projectState(this.project); this.publish(); throw error;
    }
    if (generation !== this.generation || this.stopped) return;
    this.loadErrors.delete(path);
    const existing = this.documents.get(path);
    if (existing && existing.version > doc.version) return;
    this.installDocument(doc, external); this.publish();
  }
  private async snapshot(bundle: BundleSnapshot, seq: number) {
    this.wiring.invalidate('SCOPE');
    this.invalidateEditorView();
    const generation = ++this.generation;
    const hello = this.helloSnapshot;
    this.synced = false; this.lastSeq = seq;
    this.saves.forEach(save => { clearTimeout(save.timer); clearTimeout(save.flight?.timer); save.flight = undefined; save.timer = undefined; });
    this.documents.clear(); this.loadErrors.clear(); this.projectState(bundle.project); this.restoreDrafts();
    this.sessionState(bundle.session);
    this.installLanguageBootstrap(bundle);this.languagePresentation();
    if (this.vetoPending && this.vetoCutoff && bundle.session.writeOwner === 'STUDENT'
      && (bundle.session.sessionId !== this.vetoCutoff.sessionId || bundle.session.controlEpoch > this.vetoCutoff.epoch)) {
      // Lost ACK is not success; this authoritative new epoch is the proof of cutoff.
      this.vetoPending = null; this.vetoCutoff = null; clearTimeout(this.vetoTimer);
    }
    const selectable = (path: string | null | undefined): path is string => !!path &&
      (bundle.project.files.some(file => file.path === path && file.kind === 'FILE') || this.saves.has(path));
    const selected = this.selectedView;
    if (selected && (selected.projectId !== bundle.project.projectId || selected.sessionId !== bundle.session.sessionId || bundle.session.writeOwner === 'COACH' || !selectable(selected.path))) this.selectedView = null;
    this.state.activePath = this.selectedView?.path ?? (selectable(bundle.activeDocument?.path) ? bundle.activeDocument!.path
      : selectable(bundle.session.activeFilePath) ? bundle.session.activeFilePath
      : bundle.project.files.find(f => f.kind === 'FILE')?.path ?? '');
    // A retained local selection wins over an older server-view document. Load
    // only the settled selection/task/drafts into this new cache generation.
    if (bundle.activeDocument?.path === this.state.activePath) this.installDocument(bundle.activeDocument, false);
    this.proposals = new Map(bundle.proposals.map(p => [p.proposalId, p]));
    this.state.activeProposal = bundle.proposals[0] ? mapProposal(bundle.proposals[0]) : null;
    this.state.chatEntries = bundle.chat.map(c => ({ id: c.messageId, sender: c.author, message: c.text, timestamp: Date.parse(c.createdAt) }));
    this.state.activeRun = bundle.lastRun ? mapRun(bundle.lastRun, null) : null;
    this.state.report = bundle.report ? mapReport(bundle.report) : null;
    this.pendingSteps.clear(); this.preparing = null; this.readySent = false;
    this.publish();
    try {
      const paths = new Set([this.state.activePath, this.state.projectSettings.taskFilePath, ...this.saves.keys()].filter(Boolean));
      for (const [path, save] of this.saves) {
        if (!bundle.project.files.some(file => file.path === path && file.kind === 'FILE')) {
          save.conflict = true; this.state.fileConflict = { path, localDraftContent: save.draft.content, diskContent: '', diskDeleted: true }; paths.delete(path);
        }
      }
      this.projectState(this.project!);
      const readErrors: string[] = [];
      for (const path of paths) {
        if (generation !== this.generation || this.stopped) return;
        if (!this.documents.has(path!)) {
          try { await this.loadFile(path!); }
          catch (error) {
            const save = this.saves.get(path!); if (save) save.conflict = true;
            readErrors.push(`Nie można odczytać ${path}: ${error instanceof Error ? error.message : String(error)}. Wybierz inny plik lub popraw ścieżkę zadania w ustawieniach; drafty zachowano.`);
          }
        }
      }
      if (generation !== this.generation || this.stopped) return;
      const readError = readErrors.length ? readErrors.join('\n') : null;
      // Keep UNKNOWN/terminal outcome visible even if a background task-file read
      // failed; retain that independent failure for after the decision resolves.
      if (this.proposalDecision && readError) this.decisionResultError ??= readError;
      this.synced = true;
      const observed=this.latestRuntimeRun;
      this.applyRuntimeProject(observed && observed.seq>seq && observed.projectId===bundle.project.projectId && observed.sessionId===bundle.session.sessionId ? observed.run : bundle.lastRun); this.wiring.authoritativeState(bundle.session.controlEpoch); this.retries = 0; clearTimeout(this.connectionTimer);
      if (this.finishAttempt && readError) this.finishAttempt.previousError = readError;
      this.state.connectionError = this.proposalDecision?.notice ?? this.decisionResultError
        ?? this.finishAttempt?.previousError ?? this.finishAttempt?.notice ?? readError ?? null;
      // Only the latest successfully installed generation consumes HELLO. An
      // overlapping broadcast can supersede an earlier async task-file read.
      if (hello && hello === this.helloSnapshot && hello.ws === this.ws && hello.sessionId === bundle.session.sessionId && hello.clientId === this.clientId) {
        this.helloSnapshot = null; this.reconcileDecision(bundle);
      }
      if (bundle.report) this.observeFinishReport(bundle.report);
      else void this.reconcileFinish();
      // Selection made while the snapshot was loading was not sent offline.
      // Advertise only its view, never replay CREATE/RENAME/DELETE or a save.
      if (this.selectedView && this.selectedView.path === this.state.activePath && this.documents.has(this.state.activePath)
        && this.session?.activeFilePath !== this.state.activePath) this.observePathOnly(true);
      this.replayWindowPresence();
      this.saves.forEach((_, path) => this.schedule(path)); this.publish();
      void this.refreshSnapshots();
    } catch (error) { this.fail(error); this.resync(); }
  }
  receive(message: ServerMessage) {
    if (message.protocolVersion !== '3.0' || !Number.isSafeInteger(message.seq) || message.seq < 1 || (this.session && message.sessionId !== this.session.sessionId)) throw new Error('Niepoprawna koperta protokołu.');
    if (message.type === 'SESSION_SNAPSHOT') {
      if (message.seq <= this.lastSeq) return;
      // A shaped V2 project may not silently downgrade a missing/malformed REQUIRED bootstrap
      // to legacy/null. Mixed raw settings retain their explicit manual-migration path only.
      if(validateV2WireShape('Project',message.payload.project)&&!validateV2WireShape('SessionBundle',message.payload)) {
        this.wiring.invalidate('SCOPE');this.languageScope=null;this.synced=false;this.languagePresentation();
        throw new Error('Niepoprawny SESSION_SNAPSHOT V2: wymagany ścisły languageBootstrap.');
      }
      void this.snapshot(message.payload, message.seq);return;
    }
    if (message.seq <= this.lastSeq) return; // duplicate never reapplies
    if (message.seq !== this.lastSeq + 1) { this.fail(new Error('Luka w sekwencji serwera. Wymagana synchronizacja.')); this.resync(); return; }
    this.lastSeq = message.seq;
    if(message.type==='COMPLETE_RESULT'||message.type==='DIAGNOSTICS'||message.type==='LANGUAGE_STATUS') {
      if(!validateLanguageServerMessage(message)) throw new Error('Niepoprawna odpowiedź językowa V2.');
      this.wiring.receive(message); return;
    }
    switch (message.type) {
      case 'ACK':
        this.ack(message.payload,message.messageId,message.sessionId,validateV2WireShape('ServerMessage',message));break;
      case 'CONTROL_PREPARE':
        this.wiring.invalidate('CONTROL_PREPARE');
        if (!this.synced || this.vetoPending || this.savesHasConflict()) { this.send('CONTROL_READY', { requestId: message.payload.requestId, workspaceVersion: this.state.workspaceVersion, ready: false }); break; }
        this.preparing = message.payload.requestId; this.prepareLoaded = false; this.readySent = false;
        this.saves.forEach((_, path) => this.flushFile(path));
        if (this.documents.has(message.payload.path)) { this.prepareLoaded = true; this.ready(); }
        else {
          const requestId = message.payload.requestId;
          void this.loadFile(message.payload.path).then(() => { if (this.preparing === requestId) { this.prepareLoaded = true; this.ready(); } }).catch(error => { this.fail(error); if (this.preparing === requestId) { this.send('CONTROL_READY', { requestId, workspaceVersion: this.state.workspaceVersion, ready: false }); this.preparing = null; this.publish(); } });
        }
        break;
      case 'CONTROL_STATE': {
        if (!this.session || message.payload.controlEpoch < this.session.controlEpoch) break;
        this.wiring.sourceChanged();
        this.session = { ...this.session, ...message.payload };
        this.wiring.authoritativeState(message.payload.controlEpoch);
        this.state.controlEpoch = message.payload.controlEpoch; this.state.coachMode = message.payload.coachMode;
        this.preparing = null;
        // Student CONTROL_STATE acknowledges the cutoff, not permission to overwrite a draft.
        if (message.payload.writeOwner === 'STUDENT') { this.pendingSteps.clear(); this.saves.forEach((_, path) => this.schedule(path)); }
        break;
      }
      case 'COACH_STEP_EDIT': void this.coachStep(message.payload); break;
      case 'SESSION_STATE': this.sessionState(message.payload); void this.reconcileFinish(); break;
      case 'EXTERNAL_FILE_SYNC': {
        this.wiring.sourceChanged();
        const p = message.payload; this.state.workspaceVersion = p.workspaceVersion;
        if(p.operation==='DELETED'||p.operation==='CREATED')this.wiring.fileOperation(p.operation==='DELETED'?'DELETE':'CREATE',p.path);
        if (this.editorView?.path === p.path) this.invalidateEditorView();
        if (this.project) {
          this.project.workspaceVersion = p.workspaceVersion;
          this.project.files = this.project.files.filter(f => f.path !== p.path);
          if (p.operation !== 'DELETED') this.project.files.push({ path: p.path, kind: 'FILE', version: p.version });
          if (p.document) this.installDocument(p.document);
          else if (this.saves.has(p.path)) { const s = this.saves.get(p.path)!; s.conflict = true; this.documents.delete(p.path); this.state.fileConflict = { path: p.path, diskContent: '', localDraftContent: s.draft.content, diskDeleted: true }; this.projectState(this.project); }
          else { this.documents.delete(p.path); this.projectState(this.project); }
        }
        this.state.activePointer = null; this.state.activeHintBubble = null; break;
      }
      case 'COACH_POINTER': {
        const p = message.payload;
        this.state.activePointer = !p.clear && p.range && this.documents.get(p.path)?.version === p.documentVersion && !this.saves.has(p.path) ? { path: p.path, documentVersion: p.documentVersion, ...p.range } : null; break;
      }
      case 'COACH_HINT_BUBBLE': {
        const p = message.payload;
        if (p.path && (this.documents.get(p.path)?.version !== p.documentVersion || this.saves.has(p.path))) break;
        this.state.activeHintBubble = { id: p.id, path: p.path ?? this.state.activePath, documentVersion: p.documentVersion ?? 0, line: p.range?.startLine ?? 1, text: p.text.slice(0, 400), severity: p.severity, createdAt: Date.now() };
        this.state.chatEntries = [...this.state.chatEntries, { id: p.id, sender: 'COACH', message: p.text, timestamp: Date.now() }]; break;
      }
      case 'ACTION_PROPOSAL': {
        this.proposals.set(message.payload.proposalId, message.payload);
        const proposal = mapProposal(message.payload); this.state.activeProposal = proposal;
        this.state.chatEntries = [...this.state.chatEntries, { id: proposal.id, sender: 'COACH', message: proposal.questionText, timestamp: Date.now(), proposal }]; break;
      }
      case 'CHAT_REPLY': this.state.chatEntries = [...this.state.chatEntries, { id: message.messageId, sender: 'COACH', message: message.payload.text, timestamp: Date.now() }]; break;
      case 'RUN_STATE':
        if(!validateRunV2(message.payload)) { this.state.connectionError='Odrzucono wykonanie spoza kontraktu V2; bez uruchamiania na hoście.'; break; }
        if(this.project && this.session)this.latestRuntimeRun={run:structuredClone(message.payload),seq:message.seq,projectId:this.project.projectId,sessionId:this.session.sessionId};
        this.applyRuntimeProject(message.payload); break;
      case 'RUN_OUTPUT': {
        const p = message.payload;
        if (p.outputSeq <= (this.outputSeq.get(p.runId) ?? 0)) break;
        this.outputSeq.set(p.runId, p.outputSeq);
        if (this.state.activeRun?.runId === p.runId) this.state.activeRun = { ...this.state.activeRun,
          logs: this.appendLogs(p) };
        break;
      }
      case 'SESSION_REPORT':
        if (message.payload.sessionId !== this.session?.sessionId) break;
        this.state.report = mapReport(message.payload); this.observeFinishReport(message.payload); break;
      case 'ERROR': this.fail(new Error(`${message.payload.code}: ${message.payload.message}`)); break;
    }
    this.publish();
  }
  private appendLogs(p: ServerPayloads['RUN_OUTPUT']) {
    let remaining = 65536;
    return [...(this.state.activeRun?.logs ?? []), { id: `${p.runId}-${p.outputSeq}`, type: p.stream, text: p.chunk, timestamp: Date.now() }].reverse().flatMap(log => {
      if (!remaining) return [];
      const text = log.text.slice(-remaining); remaining -= text.length; return [{ ...log, text }];
    }).reverse();
  }
  private savesHasConflict() { return [...this.saves.values()].some(s => s.conflict); }
  private schedule(path: string) {
    const save = this.saves.get(path);
    if (!save || save.timer || save.flight || save.conflict) return;
    // A throttle, NOT a debounce: continuous typing cannot postpone the first send.
    save.timer = setTimeout(() => { save.timer = undefined; this.flushFile(path); }, 150);
  }
  private flushFile(path: string) {
    const save = this.saves.get(path), doc = this.documents.get(path);
    if (!save || !doc || save.flight || save.conflict || !this.synced || this.vetoPending || this.session?.writeOwner !== 'STUDENT') return;
    clearTimeout(save.timer); save.timer = undefined;
    const messageId = id();
    save.flight = { messageId, content: save.draft.content, projectId:this.project?.projectId,sessionId:this.session.sessionId,generation:this.generation,baseVersion:doc.version,controlEpoch:this.session.controlEpoch, timer: setTimeout(() => {
      this.fail(new Error('Brak ACK zapisu. Draft zachowany; sprawdzam stan serwera.')); this.resync();
    }, 5000) };
    const sourceId=this.wiring.beginAutosave(messageId,path,save.flight.content,doc.version,this.session.controlEpoch);
    try { this.send('CODE_CHANGED', { path, baseVersion: doc.version, controlEpoch: this.session.controlEpoch, content: save.flight.content, editKind: 'TYPING',
      ...(sourceId?{languageDocumentMessageId:sourceId}:{}) }, messageId); }
    catch (error) { this.wiring.cancelAutosave(messageId);clearTimeout(save.flight?.timer); save.flight = undefined; this.fail(error); }
    this.publish();
  }
  private ready() {
    if (this.preparing && this.prepareLoaded && !this.readySent && this.synced && this.saves.size === 0) {
      const requestId = this.preparing; this.readySent = true;
      this.send('CONTROL_READY', { requestId, workspaceVersion: this.state.workspaceVersion, ready: true });
      // Stay locked until CONTROL_STATE, not just until send().
    }
  }
  private ack(p: ServerPayloads['ACK'],messageId:string,sessionId:string,verifiedEnvelope:boolean) {
    const envelope:AutosaveAckEnvelope={messageId,sessionId,replyTo:p.replyTo,status:p.status,documentVersion:p.documentVersion,workspaceVersion:p.workspaceVersion,controlEpoch:p.controlEpoch};
    // Must precede any local workspace/base/draft mutation. Receipt presence is never enough.
    if(verifiedEnvelope)this.wiring.prepareAutosaveAck(envelope);
    else this.wiring.cancelAutosave(p.replyTo); // Legacy negative VIEW handling is not language-ACK proof.
    const viewFlight = this.viewFlight;
    if (viewFlight?.messageId === p.replyTo) {
      clearTimeout(viewFlight.timer); this.viewFlight = null;
      const ok = p.status !== 'REJECTED' && p.documentVersion === viewFlight.version;
      const sameScope = viewFlight.scope === this.getEditorViewScope();
      if (sameScope) {
        if (ok) this.editorViewAck = { view: viewFlight.view, version: viewFlight.version };
        else { this.editorViewAck = null; this.fail(new Error(`${p.error?.code ?? 'VIEW_REJECTED'}: ${p.error?.message ?? 'Nie potwierdzono kontekstu edytora. Pytanie nie zostało wysłane.'}`)); }
      }
      viewFlight.done(ok && sameScope);
      if ((ok || !sameScope) && this.editorView && this.editorView !== viewFlight.view) {
        // New path-only selection is not cursor motion. Release it on the next
        // transport tick, not reentrantly in an old ACK and not after 120ms.
        if (!this.editorView.cursor && !this.editorView.selection) this.schedulePathOnlyView();
        else this.viewThrottle.schedule();
      }
    }
    this.state.workspaceVersion = Math.max(this.state.workspaceVersion, p.workspaceVersion);
    const decision = this.proposalDecision;
    if (decision?.messageId === p.replyTo && decision.sessionId === this.session?.sessionId && decision.clientId === this.clientId) {
      clearTimeout(decision.timer); this.proposalDecision = null; decision.done();
      this.proposals.delete(decision.proposalId);
      if (this.state.activeProposal?.id === decision.proposalId) this.state.activeProposal = null;
      this.state.chatEntries = this.state.chatEntries.map(c => c.proposal?.id === decision.proposalId ? { ...c, proposal: undefined } : c);
      if (p.status === 'REJECTED') {
        // Cached rejection is still rejection, including RECOVERY_REQUIRED.
        this.decisionResultError = `${p.error?.code ?? 'PROPOSAL_REJECTED'}: ${p.error?.message ?? 'Decyzja odrzucona.'}`;
        this.fail(new Error(this.decisionResultError));
      } else {
        if (decision.notice && this.state.connectionError === decision.notice) this.state.connectionError = this.decisionResultError;
        else if (this.state.connectionError) this.decisionResultError = this.state.connectionError;
        if (decision.accepted) this.resync();
      }
    }
    if (p.replyTo === this.vetoPending && p.status !== 'REJECTED') {
      this.vetoPending = null; this.vetoCutoff = null; clearTimeout(this.vetoTimer);
      if (this.session) { this.session.controlEpoch = p.controlEpoch; this.session.writeOwner = 'STUDENT'; }
      this.state.controlEpoch = p.controlEpoch;
      this.wiring.authoritativeState(p.controlEpoch);
      this.saves.forEach((_, path) => this.schedule(path));
    }
    for (const [path, save] of this.saves) {
      if (save.flight?.messageId !== p.replyTo) continue;
      const flight = save.flight; clearTimeout(flight.timer); save.flight = undefined;
      const doc = this.documents.get(path);
      if (!doc) { save.conflict = true; this.persist(); break; }
      if (flight.projectId!==this.project?.projectId || flight.sessionId!==this.session?.sessionId || flight.generation!==this.generation ||
        flight.controlEpoch!==p.controlEpoch || flight.controlEpoch!==this.session?.controlEpoch || flight.baseVersion!==doc.version) {
        save.conflict=true; this.wiring.invalidate('CONFLICT'); this.persist(); break;
      }
      if (p.status === 'REJECTED' || p.documentVersion === null || p.documentVersion<=doc.version) {
        save.conflict = true; this.fail(new Error(`${p.error?.code ?? 'SAVE_REJECTED'}: ${p.error?.message ?? 'Zapis odrzucony. Draft zachowany.'}`));
        void this.loadFile(path, true).catch(e => this.fail(e));
        if (this.preparing) { this.send('CONTROL_READY', { requestId: this.preparing, workspaceVersion: this.state.workspaceVersion, ready: false }); this.preparing = null; }
      } else if (save.conflict || doc.version > p.documentVersion) {
        // Delayed ACK may precede an already observed external version. Never roll disk state back.
        save.conflict = true;
        this.state.fileConflict = { path, localDraftContent: save.draft.content, diskContent: doc.content };
      } else {
        this.documents.set(path, { ...doc, content: flight.content, version: p.documentVersion });
        if (this.project) { this.project.workspaceVersion = p.workspaceVersion; const entry = this.project.files.find(f => f.path === path); if (entry) entry.version = p.documentVersion; }
        save.draft.baseVersion = p.documentVersion;
        if (save.draft.content === flight.content) this.saves.delete(path);
        else if (this.preparing) this.flushFile(path); else this.schedule(path);
        this.projectState(this.project!);
      }
      this.wiring.ackTransition(envelope);
      this.applyRuntimeProject(); this.persist(); this.ready(); this.viewThrottle.schedule(); break;
    }
  }
  saveFileContent(path: string, content: string) {
    const doc = this.documents.get(path), current = this.saves.get(path);
    // A deleted-on-disk file may still have an editable protected draft. Preserve new typing
    // without manufacturing a disk version or clearing the explicit conflict barrier.
    if ((!doc && !current) || doc?.readOnly || this.preparing || (this.synced && this.session?.writeOwner === 'COACH' && !this.vetoPending)) return;
    if (!current && doc?.content === content) return;
    // Timer callbacks own this Save object. Replacing it would strand the copied
    // timer handle when the original callback expires behind a conflict/veto barrier.
    this.wiring.draftChanged(path,content);
    if (current) current.draft = { ...current.draft, content };
    else this.saves.set(path, { draft: { content, baseVersion: doc!.version }, conflict: false });
    this.state.activePointer = null; this.state.activeHintBubble = null;
    if (this.state.fileConflict?.path === path) this.state.fileConflict = { ...this.state.fileConflict, localDraftContent: content };
    this.projectState(this.project!); this.persist(); this.schedule(path); this.publish();
  }
  private async coachStep(p: ServerPayloads['COACH_STEP_EDIT']) {
    if (!this.synced || this.vetoPending || this.invalidInterventions.has(p.interventionId) || this.session?.writeOwner !== 'COACH' || this.session.controlEpoch !== p.controlEpoch || this.session.interventionId !== p.interventionId) {
      if (this.saves.has(p.path)) void this.loadFile(p.path, true).catch(e => this.fail(e));
      return;
    }
    const doc = this.documents.get(p.path);
    if (!doc || doc.version !== p.baseVersion || this.saves.has(p.path) || this.pendingSteps.size) { this.resync(); return; }
    try {
      const content = applyWireEdit(doc.content, p.range, p.textBlock);
      const generation = this.generation;
      const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(content)))].map(n => n.toString(16).padStart(2, '0')).join('');
      if (generation !== this.generation || this.vetoPending || this.invalidInterventions.has(p.interventionId) || this.session?.controlEpoch !== p.controlEpoch) return;
      if (hash !== p.contentHash) throw new Error('Niezgodny hash kroku. Wymagana synchronizacja.');
      this.invalidateEditorView();
      this.selectedView = null; this.selectionRequest++;
      this.pendingSteps.set(p.stepId, { step: p, content }); this.state.activePath = p.path; this.publish();
      this.emit('step', { ...p, text: p.textBlock } satisfies CoachEditStep);
    } catch (error) { this.fail(error); this.resync(); }
  }
  stepRendered(step: CoachEditStep, actualContent: string) {
    const pending = step.stepId && this.pendingSteps.get(step.stepId);
    if (!pending || this.invalidInterventions.has(step.interventionId) || this.vetoPending || !this.synced || this.session?.controlEpoch !== step.controlEpoch) return;
    if (actualContent !== pending.content) { this.fail(new Error('Model edytora nie zgadza się z zapisanym krokiem.')); this.resync(); return; }
    const p = pending.step;
    this.invalidateEditorView();
    this.documents.set(p.path, { ...this.documents.get(p.path)!, content: pending.content, version: p.version, contentHash: p.contentHash });
    if (this.project) { this.project.workspaceVersion = p.workspaceVersion; const f = this.project.files.find(f => f.path === p.path); if (f) f.version = p.version; this.projectState(this.project); }
    this.pendingSteps.delete(p.stepId); this.state.workspaceVersion = p.workspaceVersion;
    this.send('STEP_RENDERED', { stepId: p.stepId, interventionId: p.interventionId, documentVersion: p.version }); this.publish();
  }
  triggerVeto() {
    this.wiring.invalidate('VETO');
    if (this.vetoPending || !this.session) return;
    if (this.session.interventionId) this.invalidInterventions.add(this.session.interventionId);
    this.pendingSteps.clear(); this.preparing = null;
    const messageId = id(), payload = { controlEpoch: this.session.controlEpoch, activeInterventionId: this.session.interventionId, lastAppliedSeq: this.lastSeq };
    this.vetoCutoff = { sessionId: this.session.sessionId, epoch: this.session.controlEpoch };
    this.vetoPending = messageId; this.emit('veto', payload); this.publish();
    const fallback = async () => {
      if (this.vetoPending !== messageId) return;
      try {
        const session = await this.http<Wire.Session>('/api/session/veto', 'POST', this.commandBody(payload, messageId));
        if (this.vetoPending !== messageId) return;
        this.sessionState(session); this.vetoPending = null; this.vetoCutoff = null; this.saves.forEach((_, path) => this.schedule(path)); this.publish();
      } catch (error) { this.fail(error); }
    };
    try { this.send('VETO_ESCAPE', payload, messageId); this.vetoTimer = setTimeout(() => void fallback(), 500); }
    catch { void fallback(); }
  }
  async selectFile(path: string) {
    // Invalidate old coordinates/chat, retaining only the wire singleflight
    // barrier. Its ACK releases transport, never acknowledges this new scope.
    this.invalidateEditorView(true);
    const request = ++this.selectionRequest, projectId = this.project?.projectId, sessionId = this.session?.sessionId;
    const current = () => !this.stopped && request === this.selectionRequest && projectId === this.project?.projectId && sessionId === this.session?.sessionId;
    if (this.session?.writeOwner === 'COACH' && path !== this.state.activePath) this.triggerVeto();
    try {
      // A valid same-project snapshot invalidates the cache/read, not this latest
      // user intent. Reload into its current generation, never install stale bytes.
      let generation: number;
      do {
        generation = this.generation;
        const save = this.saves.get(path);
        if (!this.documents.has(path) && !(save?.conflict && !this.documents.has(path))) await this.loadFile(path);
        if (!current()) return;
      } while (generation !== this.generation);
      const save = this.saves.get(path), deletedDraft = !!save?.conflict && !this.documents.has(path);
      this.selectedView = projectId && sessionId ? { path, projectId, sessionId } : null;
      this.state.activePath = path;
      if (save?.conflict) this.state.fileConflict = { path, localDraftContent: save.draft.content, diskContent: this.documents.get(path)?.content ?? '', diskDeleted: deletedDraft };
      if (this.synced && !deletedDraft) this.observePathOnly(true); this.publish();
    } catch (error) { if (current()) this.fail(error); }
  }
  async flushAll(stillCurrent: () => boolean = () => true) {
    this.saves.forEach((_, path) => this.flushFile(path));
    const end = Date.now() + 5000;
    while (this.saves.size) {
      if (!stillCurrent()) throw new Error('Projekt, sesja lub plik uległy zmianie. Pytanie nie zostało wysłane.');
      if (!this.synced || this.savesHasConflict()) throw new Error('Nie można zakończyć: niezapisany draft lub konflikt. Zachowaj pracę i rozstrzygnij konflikt.');
      if (Date.now() >= end) throw new Error('Brak ACK zapisu. Nie zakończono sesji; draft zachowany.');
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  }
  async openProject(rootPath: string) {
    try {
      await this.flushAll();
      // New folder means new consent and no inherited executable approval.
      const settings: SettingsV2 = { schemaVersion:2, taskFilePath: 'challenge.md', taskMode: 'IMPLEMENTATION', reviewNotesPath: 'review.md', aiConsent: false, contextPatterns: ['**/*.java', '**/*.py', '**/*.js', '**/*.ts', '**/*.md'], runProfiles: [] };
      const project = await this.http<ProjectSnapshot>('/api/project/open', 'POST', { requestId: id(), clientId: this.clientId, rootPath, settings });
      this.invalidateEditorView();
      this.selectedView = null; this.selectionRequest++;
      this.generation++; this.lastSeq = 0; this.documents.clear(); this.loadErrors.clear(); this.state.fileConflict = null; this.state.activePath = '';
      this.projectState(project); this.reconnect(); return true;
    } catch (error) { this.fail(error); return false; }
  }
  async mutateFile(operation: 'CREATE' | 'RENAME' | 'DELETE', path: string, newPath: string | null = null, content: string | null = null) {
    const projectId = this.project?.projectId, sessionId = this.session?.sessionId, selection = this.selectionRequest;
    const current = () => !this.stopped && projectId === this.project?.projectId && sessionId === this.session?.sessionId;
    try {
      await this.flushAll();
      if (!current()) return;
      const project = await this.http<ProjectSnapshot>('/api/file', 'POST', this.commandBody({ operation, path, newPath, content, baseVersion: operation === 'CREATE' ? null : this.documents.get(path)?.version ?? this.project?.files.find(f => f.path === path)?.version, controlEpoch: this.session?.controlEpoch }));
      if (!current()) return;
      this.wiring.fileOperation(operation,path,newPath ?? undefined);
      this.documents.delete(path); this.projectState(project); this.publish();
      if (operation !== 'DELETE' && selection === this.selectionRequest) await this.selectFile(newPath ?? path);
    } catch (error) { if (current()) this.fail(error); }
  }
  async startTimer() {
    try { this.sessionState(await this.http<Wire.Session>('/api/session/start', 'POST', this.commandBody({ limitMs: this.state.limitMs || null, pauseOnHidden: this.state.pauseOnHidden }))); this.publish(); } catch (error) { this.fail(error); }
  }
  private safeSend(type: string, payload: object) { try { this.send(type, payload); } catch (error) { this.fail(error); } }
  pauseTimer() { this.safeSend('TIMER_ACTION', { action: 'PAUSE', pauseOnHidden: null }); }
  resumeTimer() { this.safeSend('TIMER_ACTION', { action: 'RESUME', pauseOnHidden: null }); }
  setPauseOnHidden(enabled: boolean) { this.safeSend('TIMER_ACTION', { action: 'SET_HIDDEN_POLICY', pauseOnHidden: enabled }); }
  sendWindowState(presence: WindowPresence) {
    // Presence belongs to this page, not the old session snapshot. Retain updates
    // before connect and while resyncing, but send only after an authorized sync.
    this.latestPresence = presence;
    this.replayWindowPresence();
  }
  private replayWindowPresence() {
    if (this.synced && !this.stopped && this.latestPresence !== null) this.safeSend('WINDOW_STATE', { presence: this.latestPresence });
  }
  /** Scope changes invalidate both Monaco callbacks and any awaiting chat submission. */
  getEditorViewScope(): string | null {
    return this.synced && !this.stopped && this.project && this.session && this.ws?.readyState === 1
      ? JSON.stringify([this.project.projectId, this.session.sessionId, this.generation, this.state.activePath, this.selectionRequest]) : null;
  }
  private invalidateEditorView(keepFlight = false) {
    clearTimeout(this.pathViewTimer); this.pathViewTimer = undefined;
    this.viewThrottle.cancel(); this.editorView = null; this.editorViewAck = null;
    if (this.viewFlight) {
      this.viewFlight.done(false);
      if (!keepFlight) { clearTimeout(this.viewFlight.timer); this.viewFlight = null; }
    }
  }
  clearEditorView(scope: string | null) {
    if (!scope || scope !== this.getEditorViewScope()) return;
    this.invalidateEditorView();
    this.safeSend('VIEW_CHANGED', { path: null, documentVersion: null, cursor: null, selection: null });
  }
  updateEditorView(view: EditorViewObservationP2) {
    if (!this.getEditorViewScope() || view.projectId !== this.project?.projectId || view.path !== this.state.activePath) return;
    const copy = { ...view, cursor: view.cursor ? { ...view.cursor } : null, selection: view.selection ? { ...view.selection } : null };
    if (!sameEditorViewP2(this.editorView, copy)) { this.editorView = copy; this.viewThrottle.schedule(); }
  }
  private observePathOnly(immediate = false) {
    const path = this.state.activePath, doc = this.documents.get(path);
    if (!doc || this.saves.has(path) || !this.project) return;
    this.updateEditorView({ projectId: this.project.projectId, path, content: doc.content, cursor: null, selection: null });
    // Selection settlement publishes only this fresh path-only observation, not
    // a pending Monaco sample. sendEditorView retains all content/scope/ACK guards.
    if (immediate) { this.viewThrottle.cancel(); this.sendEditorView(); }
  }
  private schedulePathOnlyView() {
    if (this.pathViewTimer) return;
    const scope = this.getEditorViewScope();
    this.pathViewTimer = setTimeout(() => {
      this.pathViewTimer = undefined;
      if (scope && scope === this.getEditorViewScope() && this.editorView
        && !this.editorView.cursor && !this.editorView.selection) this.sendEditorView();
    }, 0);
  }
  private sendEditorView() {
    const view = this.editorView, scope = this.getEditorViewScope();
    if (!view || !scope || view.projectId !== this.project?.projectId || view.path !== this.state.activePath
      || this.saves.has(view.path) || this.state.fileConflict?.path === view.path || this.pendingSteps.size) return null;
    const doc = this.documents.get(view.path);
    if (!doc || doc.content !== view.content) return null;
    if (this.viewFlight) return this.viewFlight;
    if (this.editorViewAck?.view === view && this.editorViewAck.version === doc.version) return null;
    const messageId = id();
    let done!: (ok: boolean) => void;
    const wait = new Promise<boolean>(resolve => { done = resolve; });
    const flight = { messageId, scope, view, version: doc.version, wait, done, timer: setTimeout(() => {
      if (this.viewFlight?.messageId !== messageId) return;
      this.viewFlight = null; this.editorViewAck = null; done(false);
      this.fail(new Error('Brak ACK widoku edytora. Pytanie nie zostało wysłane; połącz ponownie.'));
    }, 5000) };
    this.viewFlight = flight;
    try { this.send('VIEW_CHANGED', { path: view.path, documentVersion: doc.version, cursor: view.cursor, selection: view.selection }, messageId); }
    catch (error) { clearTimeout(flight.timer); this.viewFlight = null; done(false); this.fail(error); }
    return flight;
  }
  async sendChatMessage(text: string): Promise<boolean> {
    if (this.chatSending || !text.trim()) return false;
    this.chatSending = true;
    const scope = this.getEditorViewScope(), path = this.state.activePath || null;
    const current = () => !!scope && scope === this.getEditorViewScope();
    try {
      if (!current()) throw new Error('Brak zsynchronizowanego połączenia. Pytanie nie zostało wysłane.');
      await this.flushAll(current);
      if (!current()) throw new Error('Projekt, sesja lub plik uległy zmianie. Pytanie nie zostało wysłane.');
      if (this.savesHasConflict() || this.state.fileConflict || this.pendingSteps.size) throw new Error('Rozstrzygnij konflikt przed wysłaniem pytania.');
      // A fresh explicit path-only view is safe after external content invalidated coordinates.
      if (path && !this.editorView) this.observePathOnly();
      this.viewThrottle.cancel();
      if (path) {
        const end = Date.now() + 5000;
        for (;;) {
          if (!current() || this.saves.size) throw new Error('Kontekst edytora zmienił się podczas wysyłania. Pytanie nie zostało wysłane.');
          const view = this.editorView, doc = this.documents.get(path);
          if (!view || view.path !== path || !doc || view.content !== doc.content) throw new Error('Edytor nie odpowiada potwierdzonemu zapisowi. Pytanie nie zostało wysłane.');
          if (this.editorViewAck?.view === view && this.editorViewAck.version === doc.version) break;
          if (Date.now() >= end) throw new Error('Nie potwierdzono aktualnego kontekstu. Pytanie nie zostało wysłane.');
          const flight = this.sendEditorView();
          if (!flight || !await flight.wait) throw new Error('Nie potwierdzono widoku edytora. Pytanie nie zostało wysłane.');
          if (!current()) throw new Error('Projekt, sesja lub plik uległy zmianie. Pytanie nie zostało wysłane.');
          this.viewThrottle.cancel();
        }
      } else this.send('VIEW_CHANGED', { path: null, documentVersion: null, cursor: null, selection: null });
      if (!current() || this.saves.size || this.state.fileConflict) throw new Error('Kontekst uległ zmianie. Pytanie nie zostało wysłane.');
      const messageId = this.send('CHAT_MESSAGE', { text, path, documentVersion: path ? this.documents.get(path)!.version : null,
        selection: path ? this.editorView?.selection ?? null : null });
      this.state.chatEntries = [...this.state.chatEntries, { id: messageId, sender: 'STUDENT', message: text, timestamp: Date.now() }]; this.publish();
      return true;
    } catch (error) { this.fail(error); return false; }
    finally { this.chatSending = false; }
  }
  async respondToProposal(proposalId: string, accepted: boolean) {
    // Repeated/opposite clicks cannot replace an unresolved envelope or consent.
    if (this.proposalDecision) return this.proposalDecision.wait;
    const proposal = this.proposals.get(proposalId); if (!proposal) return;
    if (!this.synced || !this.session || this.ws?.readyState !== 1 || this.stopped) {
      this.fail(new Error('Brak zsynchronizowanej sesji. Nie wysłano decyzji.')); return;
    }
    const messageId = id(), sessionId = this.session.sessionId;
    const raw = JSON.stringify({ protocolVersion: '3.0', messageId, sessionId, clientId: this.clientId, type: 'PROPOSAL_RESPONSE',
      payload: { proposalId, accepted, basedOnWorkspaceVersion: proposal.basedOnWorkspaceVersion } });
    let done!: () => void;
    const wait = new Promise<void>(resolve => { done = resolve; });
    const decision: ProposalDecision = { messageId, sessionId, clientId: this.clientId, proposalId, accepted, raw, wait, done,
      notice: null, disconnected: false, replayed: false };
    this.proposalDecision = decision; this.decisionDeadline(decision);
    try { this.ws.send(raw); }
    catch { this.unknownDecision(decision, 'Nie potwierdzono wysłania decyzji; wynik nieznany. Połącz ponownie, aby sprawdzić stan.'); }
    return wait;
  }
  private decisionDeadline(decision: ProposalDecision) {
    clearTimeout(decision.timer);
    decision.timer = setTimeout(() => this.unknownDecision(decision,
      'Brak ACK decyzji; wynik nieznany. Nie ponawiaj zgody. Połącz ponownie, aby odczytać wcześniejszy wynik.'), 5000);
  }
  private unknownDecision(decision: ProposalDecision, notice: string) {
    if (this.proposalDecision !== decision || this.stopped) return;
    clearTimeout(decision.timer); decision.timer = undefined;
    decision.notice = notice; decision.done(); this.fail(new Error(notice));
  }
  private reconcileDecision(bundle: BundleSnapshot) {
    const decision = this.proposalDecision;
    if (!decision?.disconnected || decision.replayed || decision.sessionId !== bundle.session.sessionId || decision.clientId !== this.clientId) return;
    // ONLY a fresh authorized snapshot after our new HELLO is eligible. A live
    // proposal might execute again after ledger loss: never replay while present.
    if (bundle.proposals.some(proposal => proposal.proposalId === decision.proposalId)) {
      this.unknownDecision(decision, 'Decyzja nadal ma widoczną propozycję; wynik nieznany. Nie ponowiono operacji. Sprawdź stan i kopie odzyskiwania.'); return;
    }
    // Absent proposal is NOT success. Identical bytes can only read the existing
    // outcome ledger (or fail STALE if missing); no new ID/version/approval.
    decision.replayed = true;
    this.decisionDeadline(decision);
    try { this.ws!.send(decision.raw); }
    catch { this.unknownDecision(decision, 'Nie odczytano wcześniejszego wyniku decyzji; wynik nieznany. Nie ponowiono zgody.'); }
  }
  dismissHintBubble() { this.state.activeHintBubble = null; this.publish(); }
  updateBubblePos(x: number, y: number) { if (this.state.activeHintBubble) this.state.activeHintBubble = { ...this.state.activeHintBubble, posX: x, posY: y }; this.publish(); }
  clearCoachPointer() { this.state.activePointer = null; this.publish(); }
  async run(isTest: boolean) {
    if(this.wiring.runtime.snapshot().pending) return;
    const scope=this.getReportHistoryScope();
    try { await this.flushAll(()=>scope===this.getReportHistoryScope());
      if(!scope || scope!==this.getReportHistoryScope()) throw new Error('Sesja zmieniła się przed uruchomieniem.');
      if(this.session?.writeOwner!=='STUDENT'||this.preparing||this.vetoPending)throw new Error('Uruchomienie oczekuje na rozliczenie bieżącego sterowania. Stop pozostaje dostępny.');
      this.applyRuntimeProject();
      if(!await this.wiring.runtime.run(isTest?'RUN_TESTS':'RUN_MAIN')) this.fail(new Error(this.wiring.runtime.snapshot().error ?? 'Wymagany serwer i profil wykonania V2. Bez wykonania na hoście.'));
    } catch(error) {this.fail(error);}
  }
  async reconcileRuntimeMutation():Promise<boolean> {
    // Select an exact already-retained identity, never rewrite current session authority.
    const [selected]=this.wiring.runtime.retainedMutations();if(!selected)return false;
    let settledKey:string|undefined;
    const ok=await this.wiring.runtime.reconcileRetained(selected,async(metadata,signal)=>{
      const key=JSON.stringify([metadata.projectId,metadata.sessionId,metadata.clientId,metadata.requestId]);
      const retained=this.runtimeMutations.get(key),project=this.project,session=this.session;
      if(!retained||!project||!session||retained.kind!==metadata.kind||retained.request.expectedWorkspaceVersion!==metadata.expectedWorkspaceVersion||
        project.projectId!==retained.projectId||retained.request.sessionId!==metadata.sessionId||retained.request.requestId!==metadata.requestId||
        retained.request.clientId!==metadata.clientId||this.clientId!==metadata.clientId)
        throw new Error('Brak oryginalnego żądania w bieżącym autoryzowanym zakresie. Blokada zachowana.');
      const mutation=structuredClone(retained),generation=this.generation,connection=this.connectionGeneration,seq=this.lastSeq;
      const value=await this.http<unknown>('/api/runtime/mutation/reconcile','POST',{mutation},true,signal);
      if(signal.aborted||!this.synced||this.stopped||this.generation!==generation||this.connectionGeneration!==connection||this.lastSeq!==seq||
        this.project!==project||this.session!==session||!validateMutationOutcomeV2(value)||!sameJSON(value.mutation,mutation)||value.state==='UNKNOWN'||
        value.current.project.projectId!==project.projectId||value.current.project.sessionId!==session.sessionId)
        throw new Error('Odczyt nie rozstrzygnął dokładnego żądania w aktualnej sesji. Blokada zachowana.');
      // A definitive authenticated outcome carries a separate coherent CURRENT snapshot, not the retained result.
      // Install only synchronously here; RuntimeClient then checks/applies this same authority before clearing its fence.
      this.wiring.sourceChanged();this.projectState(value.current.project);session.workspaceVersion=value.current.project.workspaceVersion;
      settledKey=key;
      return {project:value.current.project,run:value.current.run};
    });
    if(ok&&settledKey)this.runtimeMutations.delete(settledKey);
    this.publish();return ok;
  }
  async stopExecution() { await this.wiring.runtime.stop(); }
  async saveRuntimeSettings(settings:SettingsV2,expectedWorkspaceVersion:number):Promise<SettingsSaveResultV2> {
    if(this.wiring.runtime.snapshot().pending)return {ok:false,message:'Operacja trwa. Zachowano formularz.'};
    const scope=this.getReportHistoryScope();
    try {
      await this.flushAll(()=>scope===this.getReportHistoryScope());
      if(!scope || scope!==this.getReportHistoryScope()) throw new Error('Sesja zmieniła się. Zachowano formularz.');
      this.applyRuntimeProject();
      const result=await this.wiring.runtime.saveSettings(settings,expectedWorkspaceVersion);
      if(result.ok) {this.wiring.sourceChanged();this.projectState(result.project);if(this.session)this.session.workspaceVersion=result.project.workspaceVersion;this.applyRuntimeProject();this.publish();}
      return result;
    } catch(error) {return {ok:false,message:error instanceof Error?error.message:String(error)};}
  }
  async finishSession(reason: EndReason) {
    // A second click is NOT permission to repeat an unresolved HTTP mutation.
    if (this.finishStarting || this.finishAttempt || this.stopped || this.session?.lifecycle === 'FINISHED') return;
    this.finishStarting = true;
    let attempt: FinishAttempt | null = null;
    try {
      await this.flushAll();
      if (this.stopped) return;
      const body = this.commandBody({ reason, expectedWorkspaceVersion: this.state.workspaceVersion });
      attempt = { ...body, reason, expectedWorkspaceVersion: this.state.workspaceVersion,
        unknown: false, replaced: false, notice: null,
        previousError: this.state.connectionError === this.proposalDecision?.notice ? null : this.state.connectionError,
        observedReport: null, reading: false, readAgain: false };
      this.finishAttempt = attempt;
      const report = await this.http<Wire.Report>('/api/session/finish', 'POST', body);
      if (this.finishAttempt !== attempt || this.stopped) return;
      if (attempt.replaced || !this.finishReportMatches(attempt, report)) { this.unknownFinish(attempt); return; }
      this.state.report = mapReport(this.latestFinishReport(attempt, report)); this.finishAttempt = null; this.publish();
      void this.refreshSnapshots();
    } catch (error) {
      if ((attempt && this.finishAttempt !== attempt) || this.stopped) return;
      if (attempt && (!(error instanceof HttpRejectedError) || error.ambiguous)) this.unknownFinish(attempt,
        error instanceof HttpRejectedError ? error.message : error instanceof HttpDeadlineError ? 'Brak odpowiedzi serwera (5 s).' : 'Nie odebrano poprawnej odpowiedzi serwera.');
      else { if (attempt) this.finishAttempt = null; this.fail(error); }
    } finally { this.finishStarting = false; }
  }
  private unknownFinish(attempt: FinishAttempt, cause = 'Nie potwierdzono odpowiedzi serwera.') {
    attempt.unknown = true;
    attempt.notice = attempt.replaced
      ? `SESSION_REPLACED: Wynik zakończenia poprzedniej sesji ${attempt.sessionId} jest nieznany. Nie ponowiono operacji.`
      : `${cause} Wynik zakończenia jest nieznany; trwa sprawdzanie stanu, bez ponawiania operacji (${attempt.requestId}).`;
    if (!this.proposalDecision?.notice && !this.decisionResultError && this.state.connectionError === attempt.previousError) this.fail(new Error(attempt.notice));
    else this.publish();
    void this.reconcileFinish();
  }
  private replaceFinishSession(sessionId: string) {
    const attempt = this.finishAttempt;
    if (!attempt || attempt.sessionId === sessionId || attempt.replaced) return;
    attempt.replaced = true;
    if (attempt.unknown) {
      const ownNotice = this.state.connectionError === attempt.notice;
      attempt.notice = `SESSION_REPLACED: Wynik zakończenia poprzedniej sesji ${attempt.sessionId} jest nieznany. Nie ponowiono operacji.`;
      if (ownNotice) this.fail(new Error(attempt.notice));
    }
  }
  private finishReportMatches(attempt: FinishAttempt, report: Wire.Report) {
    return report.sessionId === attempt.sessionId && report.sourceWorkspaceVersion === attempt.expectedWorkspaceVersion
      && report.reason === attempt.reason && !!report.reportId && !!report.snapshotId;
  }
  private latestFinishReport(attempt: FinishAttempt, report: Wire.Report) {
    const observed = attempt.observedReport;
    // Generation can complete while an older PENDING HTTP response is in flight.
    return report.status === 'PENDING' && observed?.reportId === report.reportId
      && observed.snapshotId === report.snapshotId && observed.status !== 'PENDING' ? observed : report;
  }
  private observeFinishReport(report: Wire.Report) {
    const attempt = this.finishAttempt;
    if (!attempt || attempt.replaced || !this.finishReportMatches(attempt, report)) return;
    attempt.observedReport = report; void this.reconcileFinish();
  }
  private async reconcileFinish() {
    const attempt = this.finishAttempt;
    if (!attempt?.unknown || attempt.replaced || this.stopped || !this.synced || attempt.sessionId !== this.session?.sessionId) return;
    if (attempt.reading) { attempt.readAgain = true; return; }
    attempt.reading = true;
    try {
      // Read-only, authenticated reconciliation. 404 before durable capture is
      // absence of evidence, NOT proof of failure and never permission to POST.
      const report = await this.http<Wire.Report>(`/api/session/report?sessionId=${encodeURIComponent(attempt.sessionId)}`);
      const session = await this.http<Wire.Session>('/api/session');
      const observed = attempt.observedReport;
      if (this.finishAttempt !== attempt || this.stopped || !this.synced || attempt.replaced
        || this.session?.sessionId !== attempt.sessionId || session.sessionId !== attempt.sessionId
        || session.lifecycle !== 'FINISHED' || session.workspaceVersion !== report.sourceWorkspaceVersion
        || !observed || !this.finishReportMatches(attempt, report)
        || report.reportId !== observed.reportId || report.snapshotId !== observed.snapshotId) return;
      this.state.report = mapReport(this.latestFinishReport(attempt, report)); this.sessionState(session); this.finishAttempt = null;
      if (this.decisionResultError === attempt.notice) this.decisionResultError = null;
      if (this.state.connectionError === attempt.notice) this.state.connectionError = this.proposalDecision?.notice ?? this.decisionResultError ?? attempt.previousError;
      this.publish();
      void this.refreshSnapshots();
    } catch { /* Keep UNKNOWN; a later report/state/authorized snapshot may retry GET only. */ }
    finally {
      attempt.reading = false;
      if (attempt.readAgain) { attempt.readAgain = false; void this.reconcileFinish(); }
    }
  }
  // Read-only history is deliberately outside state.report and finish reconciliation.
  getReportHistoryScope(): string | null {
    return this.synced && !this.stopped && this.project && this.session
      ? JSON.stringify([this.project.projectId, this.session.sessionId, this.generation]) : null;
  }
  private historyGuard() {
    const scope = this.getReportHistoryScope();
    if (!scope) throw new Error('Połącz z projektem, aby odczytać poprzednie raporty.');
    return () => {
      if (scope !== this.getReportHistoryScope()) throw new Error('Projekt lub sesja uległy zmianie. Odśwież listę raportów.');
    };
  }
  async listReports(): Promise<ReportSummary[]> {
    const guard = this.historyGuard();
    const result = await this.http<{ reports: ReportSummary[] }>('/api/session/reports');
    guard();
    return result.reports;
  }
  async readReport(sessionId: string) {
    const guard = this.historyGuard();
    if (!sessionId.trim()) throw new Error('Wybierz sesję raportu.');
    const report = await this.http<Wire.Report>(`/api/session/report?sessionId=${encodeURIComponent(sessionId)}`);
    guard();
    if (report.sessionId !== sessionId) throw new Error('Odpowiedź dotyczy innej sesji raportu.');
    return mapReport(report);
  }
  async retryReport() { try { this.state.report = mapReport(await this.http<Wire.Report>('/api/session/report/retry', 'POST', this.commandBody())); this.publish(); } catch (error) { this.fail(error); } }
  async updateProjectSettings(settings: ProjectSettings) {
    if (!this.project) return false;
    const projectId = this.project.projectId;
    try {
      // Explicit V2 only. No legacy/mixed executable fields ever reach settings persistence.
      const base=this.state.projectSettings.runtimeSettings;
      if(!base) throw new Error('LEGACY_RUN_PROFILE_REQUIRES_MIGRATION. Zachowano oryginalne ustawienia; przygotuj jawny plik V2.');
      const wireSettings:SettingsV2={...base,aiConsent:settings.aiConsent,taskMode:settings.taskMode,taskFilePath:settings.taskFilePath||null,reviewNotesPath:settings.reviewNotesPath,contextPatterns:settings.contextPatterns??base.contextPatterns};
      const result=await this.saveRuntimeSettings(wireSettings,this.state.workspaceVersion);
      if(!result.ok)return false;
      if (wireSettings.taskFilePath) { try { await this.loadFile(wireSettings.taskFilePath); } catch (error) { this.fail(new Error(`Ustawienia zapisano, ale plik zadania jest niedostępny: ${error instanceof Error ? error.message : String(error)}`)); } }
      this.publish(); return true;
    } catch (error) { if (this.project?.projectId === projectId) this.fail(error); return false; }
  }
  async refreshSnapshots() {
    if (!this.project || this.stopped) return;
    const projectId = this.project.projectId, generation = this.generation, request = ++this.snapshotsRequest;
    const current = () => !this.stopped && this.project?.projectId === projectId
      && this.generation === generation && this.snapshotsRequest === request;
    try {
      const snapshots = await this.http<Wire.Snapshot[]>('/api/snapshots');
      if (!current() || snapshots.some(s => s.projectId !== projectId)) return;
      this.state.snapshots = snapshots.map(s => ({ id: s.snapshotId, label: s.label, timestamp: Date.parse(s.createdAt), files: s.paths.map(path => ({ path, content: '' })) }));
      this.state.snapshotsError = null; this.publish();
    } catch (error) {
      if (!current()) return;
      this.state.snapshotsError = error instanceof Error ? error.message : String(error); this.publish();
    }
  }
  restoreSnapshotById(snapshotId: string) { this.safeSend('PROPOSAL_REQUEST', { kind: 'RESTORE_SNAPSHOT', snapshotId }); }
  async resolveConflict(choice: 'KEEP_LOCAL' | 'LOAD_DISK') {
    const conflict = this.state.fileConflict; if (!conflict) return;
    const save = this.saves.get(conflict.path), doc = this.documents.get(conflict.path); if (!save || (!doc && !conflict.diskDeleted)) return;
    if (save.flight) { this.fail(new Error('Najpierw poczekaj na ACK lub połącz ponownie.')); return; }
    // Keep a separate recovery copy for either explicit resolution; local and disk versions remain inspectable.
    try { this.storage?.setItem(`${this.key()}:conflict:${conflict.path}:${Date.now()}`, JSON.stringify(conflict)); }
    catch { this.state.storageError = 'Nie można zachować kopii konfliktu. Skopiuj obie wersje przed rozstrzygnięciem.'; this.publish(); return; }
    if (conflict.diskDeleted) {
      if (choice === 'KEEP_LOCAL') {
        try {
          const project = await this.http<ProjectSnapshot>('/api/file', 'POST', this.commandBody({ operation: 'CREATE', path: conflict.path, newPath: null, content: save.draft.content, baseVersion: null, controlEpoch: this.session?.controlEpoch }));
          clearTimeout(save.timer); this.saves.delete(conflict.path); this.projectState(project); await this.loadFile(conflict.path);
        } catch (error) { this.fail(error); return; }
      } else { clearTimeout(save.timer); this.saves.delete(conflict.path); this.state.activePath = ''; }
      this.state.fileConflict = null; this.projectState(this.project!); this.persist(); this.publish(); return;
    }
    if (choice === 'KEEP_LOCAL') { save.conflict = false; save.draft.baseVersion = doc!.version; this.schedule(conflict.path); }
    else { clearTimeout(save.timer); this.saves.delete(conflict.path); }
    this.state.fileConflict = null; this.projectState(this.project!); this.persist();
    const file = this.state.files.find(f => f.path === conflict.path); if (file) this.emit('file', { ...file, isExternalOrSnapshot: choice === 'LOAD_DISK' });
    this.publish();
  }
}
