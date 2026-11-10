import type * as Wire from '../shared/protocol';
import type { CoachEditStep, EndReason, ProjectSettings, WindowPresence } from '../types/paircoach';
import type { ClientState, ServerMessage, ServerPayloads, UpdatedFile } from './liveTypes';
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
type Flight = { messageId: string; content: string; timer?: ReturnType<typeof setTimeout> };
type Save = { draft: Draft; flight?: Flight; timer?: ReturnType<typeof setTimeout>; conflict: boolean };
const id = () => globalThis.crypto.randomUUID();

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
  private project: Wire.Project | null = null;
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
  private commandPending = new Map<string, { done: () => void; fail: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private recoveryKey = '';
  private generation = 0;

  constructor(options: LiveOptions = {}) {
    this.baseUrl = (options.baseUrl ?? 'http://127.0.0.1:8080').replace(/\/$/, '');
    this.token = options.token ?? null;
    this.fetcher = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.socketFactory = options.socket ?? (url => new WebSocket(url));
    this.storage = options.storage;
    this.clientId = options.clientId ?? id();
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
    this.state.connectionError = error instanceof Error ? error.message : String(error); this.publish();
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
  private async http<T>(path: string, method = 'GET', body?: unknown, authenticate = true): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    try {
      const response = await this.fetcher(`${this.baseUrl}${path}`, { method, signal: controller.signal, headers: {
        ...(authenticate ? { Authorization: `Bearer ${this.token ?? ''}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {})
      }, ...(body ? { body: JSON.stringify(body) } : {}) });
      const data = await response.json();
      if (!response.ok) throw new Error(`${data.code ?? response.status}: ${data.message ?? 'Żądanie odrzucone'}`);
      return data as T;
    } catch (error) {
      if (controller.signal.aborted) throw new Error('Brak odpowiedzi serwera (5 s). Wynik operacji jest nieznany; nie ponawiaj mutacji bez sprawdzenia stanu.');
      throw error;
    } finally { clearTimeout(timer); }
  }
  private commandBody(extra: object = {}, requestId = id()) {
    if (!this.session) throw new Error('Sesja nie jest jeszcze zsynchronizowana. Połącz ponownie.');
    return { requestId, clientId: this.clientId, sessionId: this.session.sessionId, ...extra };
  }
  private send(type: string, payload: object, messageId = id()) {
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
      const [project, session] = await Promise.all([this.http<Wire.Project>('/api/project'), this.http<Wire.Session>('/api/session')]);
      if (this.stopped) return;
      if (this.session && this.session.sessionId !== session.sessionId) { this.lastSeq = 0; this.invalidInterventions.clear(); }
      this.project = project; this.session = session;
      const ws = this.socketFactory(`${this.baseUrl.replace(/^http/, 'ws')}/ws/session`);
      this.ws = ws;
      this.connectionTimer = setTimeout(() => { if (!this.synced) ws.close(); }, 5000);
      ws.onopen = () => { if (ws === this.ws) { try { this.send('HELLO', { token: this.token!, lastServerSeq: this.lastSeq }); } catch (error) { this.fail(error); ws.close(); } } };
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
    if (this.stopped) return;
    this.synced = false; this.preparing = null; this.pendingSteps.clear(); this.generation++;
    clearTimeout(this.connectionTimer); clearInterval(this.tick);
    for (const save of this.saves.values()) { clearTimeout(save.timer); clearTimeout(save.flight?.timer); save.flight = undefined; }
    for (const cmd of this.commandPending.values()) { clearTimeout(cmd.timer); cmd.fail(new Error('Połączenie utracone; wynik komendy jest nieznany.')); }
    this.commandPending.clear();
    this.persist(); this.publish();
    if (this.retries < 3) {
      const delay = [500, 1000, 2000][this.retries++];
      clearTimeout(this.reconnectTimer); this.reconnectTimer = setTimeout(() => void this.connect(), delay);
    } else { this.state.connectionError = 'Offline. Draft jest lokalny, nie na dysku. Wybierz „Połącz ponownie”.'; this.publish(); }
  }
  private resync() {
    this.synced = false; this.pendingSteps.clear(); this.publish();
    if (this.ws) this.ws.close(); else this.disconnected();
  }
  close() {
    this.stopped = true; this.generation++;
    clearTimeout(this.reconnectTimer); clearTimeout(this.connectionTimer); clearTimeout(this.vetoTimer); clearInterval(this.tick);
    this.saves.forEach(s => { clearTimeout(s.timer); clearTimeout(s.flight?.timer); });
    this.commandPending.forEach(cmd => { clearTimeout(cmd.timer); cmd.fail(new Error('Klient zamknięty.')); }); this.commandPending.clear();
    this.persist(); this.ws?.close(); this.ws = null;
  }
  private projectState(project: Wire.Project) {
    this.project = project;
    this.state.workspaceVersion = project.workspaceVersion;
    this.state.projectSettings = mapSettings(project.settings);
    const c = project.capabilities;
    this.state.capabilities = { ...c, docsPlugin: c.docs, autocompletePlugin: c.autocomplete, runMainReason: c.canRunMain ? undefined : 'Brak zatwierdzonego profilu Run Main.', runTestsReason: c.canRunTests ? undefined : 'Brak zatwierdzonego profilu Run Tests.' };
    this.state.scenario = { ...this.state.scenario, id: project.projectId, title: project.rootPath, taskMode: project.settings.taskMode,
      taskFilePath: project.settings.taskFilePath ?? '', reviewNotesPath: project.settings.reviewNotesPath, capabilities: this.state.capabilities };
    const visible = [...project.files];
    this.saves.forEach((save, path) => { if (!visible.some(f => f.path === path)) visible.push({ path, kind: 'FILE', version: save.draft.baseVersion }); });
    this.state.files = visible.map(f => ({ path: f.path, kind: f.kind, version: f.version ?? 0,
      content: this.saves.get(f.path)?.draft.content ?? this.documents.get(f.path)?.content ?? '', loaded: this.documents.has(f.path) || this.saves.has(f.path), loadError: this.loadErrors.get(f.path), readOnly: this.documents.get(f.path)?.readOnly }));
  }
  private sessionState(session: Wire.Session) {
    if (this.session && session.controlEpoch < this.session.controlEpoch) return;
    this.session = session;
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
    try { doc = await this.http<Wire.Document>(`/api/file?path=${encodeURIComponent(path)}`); this.loadErrors.delete(path); }
    catch (error) {
      this.loadErrors.set(path, error instanceof Error ? error.message : String(error));
      if (this.project) this.projectState(this.project); this.publish(); throw error;
    }
    if (generation !== this.generation || this.stopped) return;
    const existing = this.documents.get(path);
    if (existing && existing.version > doc.version) return;
    this.installDocument(doc, external); this.publish();
  }
  private async snapshot(bundle: Wire.SessionBundle, seq: number) {
    const generation = ++this.generation;
    this.synced = false; this.lastSeq = seq;
    this.saves.forEach(save => { clearTimeout(save.timer); clearTimeout(save.flight?.timer); save.flight = undefined; save.timer = undefined; });
    this.documents.clear(); this.loadErrors.clear(); this.projectState(bundle.project); this.restoreDrafts();
    this.sessionState(bundle.session);
    if (this.vetoPending && this.vetoCutoff && bundle.session.writeOwner === 'STUDENT'
      && (bundle.session.sessionId !== this.vetoCutoff.sessionId || bundle.session.controlEpoch > this.vetoCutoff.epoch)) {
      // Lost ACK is not success; this authoritative new epoch is the proof of cutoff.
      this.vetoPending = null; this.vetoCutoff = null; clearTimeout(this.vetoTimer);
    }
    this.state.activePath = bundle.activeDocument?.path ?? bundle.session.activeFilePath ?? bundle.project.files.find(f => f.kind === 'FILE')?.path ?? '';
    if (bundle.activeDocument) this.installDocument(bundle.activeDocument, false);
    this.proposals = new Map(bundle.proposals.map(p => [p.proposalId, p]));
    this.state.activeProposal = bundle.proposals[0] ? mapProposal(bundle.proposals[0]) : null;
    this.state.chatEntries = bundle.chat.map(c => ({ id: c.messageId, sender: c.author, message: c.text, timestamp: Date.parse(c.createdAt) }));
    this.state.activeRun = bundle.lastRun ? mapRun(bundle.lastRun, null) : null;
    this.state.report = bundle.report ? mapReport(bundle.report) : null;
    this.pendingSteps.clear(); this.preparing = null; this.readySent = false;
    this.publish();
    try {
      const paths = new Set([this.state.activePath, bundle.project.settings.taskFilePath, ...this.saves.keys()].filter(Boolean));
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
      this.synced = true; this.retries = 0; clearTimeout(this.connectionTimer); this.state.connectionError = readErrors[0] ?? null;
      this.saves.forEach((_, path) => this.schedule(path)); this.publish();
      void this.refreshSnapshots();
    } catch (error) { this.fail(error); this.resync(); }
  }
  receive(message: ServerMessage) {
    if (message.protocolVersion !== '3.0' || !Number.isSafeInteger(message.seq) || message.seq < 1 || (this.session && message.sessionId !== this.session.sessionId)) throw new Error('Niepoprawna koperta protokołu.');
    if (message.type === 'SESSION_SNAPSHOT') { if (message.seq <= this.lastSeq) return; void this.snapshot(message.payload, message.seq); return; }
    if (message.seq <= this.lastSeq) return; // duplicate never reapplies
    if (message.seq !== this.lastSeq + 1) { this.fail(new Error('Luka w sekwencji serwera. Wymagana synchronizacja.')); this.resync(); return; }
    this.lastSeq = message.seq;
    switch (message.type) {
      case 'ACK': this.ack(message.payload); break;
      case 'CONTROL_PREPARE':
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
        this.session = { ...this.session, ...message.payload };
        this.state.controlEpoch = message.payload.controlEpoch; this.state.coachMode = message.payload.coachMode;
        this.preparing = null;
        // Student CONTROL_STATE acknowledges the cutoff, not permission to overwrite a draft.
        if (message.payload.writeOwner === 'STUDENT') { this.pendingSteps.clear(); this.saves.forEach((_, path) => this.schedule(path)); }
        break;
      }
      case 'COACH_STEP_EDIT': void this.coachStep(message.payload); break;
      case 'SESSION_STATE': this.sessionState(message.payload); break;
      case 'EXTERNAL_FILE_SYNC': {
        const p = message.payload; this.state.workspaceVersion = p.workspaceVersion;
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
      case 'RUN_STATE': this.state.activeRun = mapRun(message.payload, this.state.activeRun); break;
      case 'RUN_OUTPUT': {
        const p = message.payload;
        if (p.outputSeq <= (this.outputSeq.get(p.runId) ?? 0)) break;
        this.outputSeq.set(p.runId, p.outputSeq);
        if (this.state.activeRun?.runId === p.runId) this.state.activeRun = { ...this.state.activeRun,
          logs: this.appendLogs(p) };
        break;
      }
      case 'SESSION_REPORT': this.state.report = mapReport(message.payload); break;
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
    save.flight = { messageId, content: save.draft.content, timer: setTimeout(() => {
      this.fail(new Error('Brak ACK zapisu. Draft zachowany; sprawdzam stan serwera.')); this.resync();
    }, 5000) };
    try { this.send('CODE_CHANGED', { path, baseVersion: doc.version, controlEpoch: this.session.controlEpoch, content: save.draft.content, editKind: 'TYPING' }, messageId); }
    catch (error) { clearTimeout(save.flight?.timer); save.flight = undefined; this.fail(error); }
    this.publish();
  }
  private ready() {
    if (this.preparing && this.prepareLoaded && !this.readySent && this.synced && this.saves.size === 0) {
      const requestId = this.preparing; this.readySent = true;
      this.send('CONTROL_READY', { requestId, workspaceVersion: this.state.workspaceVersion, ready: true });
      // Stay locked until CONTROL_STATE, not just until send().
    }
  }
  private ack(p: ServerPayloads['ACK']) {
    this.state.workspaceVersion = Math.max(this.state.workspaceVersion, p.workspaceVersion);
    const cmd = this.commandPending.get(p.replyTo);
    if (cmd) { clearTimeout(cmd.timer); this.commandPending.delete(p.replyTo); p.status === 'REJECTED' ? cmd.fail(new Error(`${p.error?.code}: ${p.error?.message}`)) : cmd.done(); }
    if (p.replyTo === this.vetoPending && p.status !== 'REJECTED') {
      this.vetoPending = null; this.vetoCutoff = null; clearTimeout(this.vetoTimer);
      if (this.session) { this.session.controlEpoch = p.controlEpoch; this.session.writeOwner = 'STUDENT'; }
      this.state.controlEpoch = p.controlEpoch;
      this.saves.forEach((_, path) => this.schedule(path));
    }
    for (const [path, save] of this.saves) {
      if (save.flight?.messageId !== p.replyTo) continue;
      const flight = save.flight; clearTimeout(flight.timer); save.flight = undefined;
      const doc = this.documents.get(path);
      if (!doc) { save.conflict = true; this.persist(); break; }
      if (p.status === 'REJECTED' || p.documentVersion === null) {
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
      this.persist(); this.ready(); break;
    }
  }
  saveFileContent(path: string, content: string) {
    const doc = this.documents.get(path), current = this.saves.get(path);
    // A deleted-on-disk file may still have an editable protected draft. Preserve new typing
    // without manufacturing a disk version or clearing the explicit conflict barrier.
    if ((!doc && !current) || doc?.readOnly || this.preparing || (this.synced && this.session?.writeOwner === 'COACH' && !this.vetoPending)) return;
    if (!current && doc?.content === content) return;
    this.saves.set(path, current ? { ...current, draft: { ...current.draft, content } } : { draft: { content, baseVersion: doc!.version }, conflict: false });
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
      this.pendingSteps.set(p.stepId, { step: p, content }); this.state.activePath = p.path; this.publish();
      this.emit('step', { ...p, text: p.textBlock } satisfies CoachEditStep);
    } catch (error) { this.fail(error); this.resync(); }
  }
  stepRendered(step: CoachEditStep, actualContent: string) {
    const pending = step.stepId && this.pendingSteps.get(step.stepId);
    if (!pending || this.invalidInterventions.has(step.interventionId) || this.vetoPending || !this.synced || this.session?.controlEpoch !== step.controlEpoch) return;
    if (actualContent !== pending.content) { this.fail(new Error('Model edytora nie zgadza się z zapisanym krokiem.')); this.resync(); return; }
    const p = pending.step;
    this.documents.set(p.path, { ...this.documents.get(p.path)!, content: pending.content, version: p.version, contentHash: p.contentHash });
    if (this.project) { this.project.workspaceVersion = p.workspaceVersion; const f = this.project.files.find(f => f.path === p.path); if (f) f.version = p.version; this.projectState(this.project); }
    this.pendingSteps.delete(p.stepId); this.state.workspaceVersion = p.workspaceVersion;
    this.send('STEP_RENDERED', { stepId: p.stepId, interventionId: p.interventionId, documentVersion: p.version }); this.publish();
  }
  triggerVeto() {
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
    if (this.session?.writeOwner === 'COACH' && path !== this.state.activePath) this.triggerVeto();
    try {
      const save = this.saves.get(path);
      const deletedDraft = !!save?.conflict && !this.documents.has(path);
      if (!this.documents.has(path) && !deletedDraft) await this.loadFile(path);
      this.state.activePath = path;
      if (save?.conflict) this.state.fileConflict = { path, localDraftContent: save.draft.content, diskContent: this.documents.get(path)?.content ?? '', diskDeleted: deletedDraft };
      if (this.synced && !deletedDraft) this.send('VIEW_CHANGED', { path, documentVersion: this.documents.get(path)?.version ?? null, cursor: null, selection: null }); this.publish();
    } catch (error) { this.fail(error); }
  }
  async flushAll() {
    this.saves.forEach((_, path) => this.flushFile(path));
    const end = Date.now() + 5000;
    while (this.saves.size) {
      if (!this.synced || this.savesHasConflict()) throw new Error('Nie można zakończyć: niezapisany draft lub konflikt. Zachowaj pracę i rozstrzygnij konflikt.');
      if (Date.now() >= end) throw new Error('Brak ACK zapisu. Nie zakończono sesji; draft zachowany.');
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  }
  async openProject(rootPath: string) {
    try {
      await this.flushAll();
      // New folder means new consent and no inherited executable approval.
      const settings: Wire.Settings = { taskFilePath: 'challenge.md', taskMode: 'IMPLEMENTATION', reviewNotesPath: 'review.md', aiConsent: false, contextPatterns: ['**/*.java', '**/*.py', '**/*.js', '**/*.ts', '**/*.md'], runProfiles: [] };
      const project = await this.http<Wire.Project>('/api/project/open', 'POST', { requestId: id(), clientId: this.clientId, rootPath, settings });
      this.generation++; this.lastSeq = 0; this.documents.clear(); this.loadErrors.clear(); this.state.fileConflict = null; this.state.activePath = '';
      this.projectState(project); this.reconnect(); return true;
    } catch (error) { this.fail(error); return false; }
  }
  async mutateFile(operation: 'CREATE' | 'RENAME' | 'DELETE', path: string, newPath: string | null = null, content: string | null = null) {
    try {
      await this.flushAll();
      const project = await this.http<Wire.Project>('/api/file', 'POST', this.commandBody({ operation, path, newPath, content, baseVersion: operation === 'CREATE' ? null : this.documents.get(path)?.version ?? this.project?.files.find(f => f.path === path)?.version, controlEpoch: this.session?.controlEpoch }));
      this.documents.delete(path); this.projectState(project); this.publish();
      if (operation !== 'DELETE') await this.selectFile(newPath ?? path);
    } catch (error) { this.fail(error); }
  }
  async startTimer() {
    try { this.sessionState(await this.http<Wire.Session>('/api/session/start', 'POST', this.commandBody({ limitMs: this.state.limitMs || null, pauseOnHidden: this.state.pauseOnHidden }))); this.publish(); } catch (error) { this.fail(error); }
  }
  private safeSend(type: string, payload: object) { try { this.send(type, payload); } catch (error) { this.fail(error); } }
  pauseTimer() { this.safeSend('TIMER_ACTION', { action: 'PAUSE', pauseOnHidden: null }); }
  resumeTimer() { this.safeSend('TIMER_ACTION', { action: 'RESUME', pauseOnHidden: null }); }
  setPauseOnHidden(enabled: boolean) { this.safeSend('TIMER_ACTION', { action: 'SET_HIDDEN_POLICY', pauseOnHidden: enabled }); }
  sendWindowState(presence: WindowPresence) { if (this.synced) this.safeSend('WINDOW_STATE', { presence }); }
  sendChatMessage(text: string) {
    const path = this.state.activePath || null;
    try { const messageId = this.send('CHAT_MESSAGE', { text, path, documentVersion: path ? this.documents.get(path)?.version ?? null : null, selection: null });
      this.state.chatEntries = [...this.state.chatEntries, { id: messageId, sender: 'STUDENT', message: text, timestamp: Date.now() }]; this.publish();
    } catch (error) { this.fail(error); }
  }
  async respondToProposal(proposalId: string, accepted: boolean) {
    const proposal = this.proposals.get(proposalId); if (!proposal) return;
    try {
      await this.wsCommand('PROPOSAL_RESPONSE', { proposalId, accepted, basedOnWorkspaceVersion: proposal.basedOnWorkspaceVersion });
      this.proposals.delete(proposalId); this.state.activeProposal = null;
      this.state.chatEntries = this.state.chatEntries.map(c => c.proposal?.id === proposalId ? { ...c, proposal: undefined } : c); this.publish();
      if (accepted) { this.resync(); }
    } catch (error) { this.fail(error); }
  }
  private wsCommand(type: string, payload: object) {
    const messageId = id();
    return new Promise<void>((done, fail) => {
      const timer = setTimeout(() => { this.commandPending.delete(messageId); fail(new Error('Brak ACK decyzji; wynik nieznany. Połącz ponownie, aby sprawdzić stan.')); }, 5000);
      this.commandPending.set(messageId, { done, fail, timer });
      try { this.send(type, payload, messageId); } catch (error) { clearTimeout(timer); this.commandPending.delete(messageId); fail(error); }
    });
  }
  dismissHintBubble() { this.state.activeHintBubble = null; this.publish(); }
  updateBubblePos(x: number, y: number) { if (this.state.activeHintBubble) this.state.activeHintBubble = { ...this.state.activeHintBubble, posX: x, posY: y }; this.publish(); }
  clearCoachPointer() { this.state.activePointer = null; this.publish(); }
  async run(isTest: boolean) { try { await this.flushAll(); this.state.activeRun = mapRun(await this.http<Wire.Run>('/api/run', 'POST', this.commandBody({ mode: isTest ? 'RUN_TESTS' : 'RUN_MAIN', expectedWorkspaceVersion: this.state.workspaceVersion })), this.state.activeRun); this.publish(); } catch (error) { this.fail(error); } }
  async stopExecution() { if (!this.state.activeRun) return; try { this.state.activeRun = mapRun(await this.http<Wire.Run>(`/api/run/${encodeURIComponent(this.state.activeRun.runId)}/stop`, 'POST', this.commandBody()), this.state.activeRun); this.publish(); } catch (error) { this.fail(error); } }
  async finishSession(reason: EndReason) { try { await this.flushAll(); this.state.report = mapReport(await this.http<Wire.Report>('/api/session/finish', 'POST', this.commandBody({ reason, expectedWorkspaceVersion: this.state.workspaceVersion }))); this.publish(); } catch (error) { this.fail(error); } }
  async retryReport() { try { this.state.report = mapReport(await this.http<Wire.Report>('/api/session/report/retry', 'POST', this.commandBody())); this.publish(); } catch (error) { this.fail(error); } }
  async updateProjectSettings(settings: ProjectSettings) {
    if (!this.project) return false;
    try {
      // Only human-confirmed structured profiles. Never parse the display command into shell execution.
      const wireSettings: Wire.Settings = { ...this.project.settings, aiConsent: settings.aiConsent, taskMode: settings.taskMode, taskFilePath: settings.taskFilePath || null, reviewNotesPath: settings.reviewNotesPath, runProfiles: settings.wireRunProfiles ?? this.project.settings.runProfiles, contextPatterns: settings.contextPatterns ?? this.project.settings.contextPatterns };
      const project = await this.http<Wire.Project>('/api/project/settings', 'PUT', this.commandBody({ expectedWorkspaceVersion: this.state.workspaceVersion, settings: wireSettings }));
      this.projectState(project);
      if (wireSettings.taskFilePath) { try { await this.loadFile(wireSettings.taskFilePath); } catch (error) { this.fail(new Error(`Ustawienia zapisano, ale plik zadania jest niedostępny: ${error instanceof Error ? error.message : String(error)}`)); } }
      this.publish(); return true;
    } catch (error) { this.fail(error); return false; }
  }
  async refreshSnapshots() {
    try { const snapshots = await this.http<Wire.Snapshot[]>('/api/snapshots'); this.state.snapshots = snapshots.map(s => ({ id: s.snapshotId, label: s.label, timestamp: Date.parse(s.createdAt), files: s.paths.map(path => ({ path, content: '' })) })); this.state.snapshotsError = null; this.publish(); }
    catch (error) { this.state.snapshotsError = error instanceof Error ? error.message : String(error); this.publish(); }
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
          const project = await this.http<Wire.Project>('/api/file', 'POST', this.commandBody({ operation: 'CREATE', path: conflict.path, newPath: null, content: save.draft.content, baseVersion: null, controlEpoch: this.session?.controlEpoch }));
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
