import type { Page } from '@playwright/test';
import { createMetricPredicates } from './observer-predicates';

/** Standalone init script. Only public DOM and unmodified native transport. */
export function installMetricObserver(makePredicates: typeof createMetricPredicates) {
  const predicates = makePredicates(), w = window as any;
  const output: any = { vetoes: [], hints: [], recordingErrors: [], keys: [], connections: [], identity: null };
  let current: any = null, pendingHint: any = null, latestControl: any = null, lastServerSeq = 0;
  let panel: HTMLElement | null = null, host: HTMLElement | null = null, header: Element | null = null;
  let input: HTMLElement | null = null, body: HTMLElement | null = null, bubble: Element | null = null;
  let raf = 0, connectionCounter = 0, nextId = 0, queue: any[] = [], flushTimer: any = null;
  let documentEvidence: any = null;
  const pendingWrites = new Map<string, any>();
  const documentVersion = (f: any, connection: number, at: number, path: any, version: any, source: string) => {
    if (path !== 'main.py') return;
    if (documentEvidence?.sessionId === f.sessionId && documentEvidence?.connection === connection
      && Number.isInteger(version) && version < documentEvidence.version) return;
    documentEvidence = Number.isInteger(version) && version > 0
      ? { sessionId: f.sessionId, connection, path, version, seq: f.seq, at, source } : null;
    record({ kind: 'documentVersion', evidence: documentEvidence, source, at, connection });
  };
  const hintFilters = (hint: any) => ({
    shape: predicates.hint(hint.payload),
    knownVersion: Boolean(documentEvidence),
    currentVersion: Boolean(documentEvidence && hint.payload.documentVersion === documentEvidence.version),
    samePath: Boolean(documentEvidence && hint.payload.path === documentEvidence.path && hint.request?.payload.path === documentEvidence.path),
    sameSession: Boolean(output.identity && hint.sessionId === output.identity.sessionId
      && hint.request?.sessionId === hint.sessionId && documentEvidence?.sessionId === hint.sessionId),
    sameConnection: Boolean(hint.connection === output.identity?.connection && hint.request?.connection === hint.connection
      && documentEvidence?.connection === hint.connection),
    requestVersion: Boolean(documentEvidence && hint.request?.payload.documentVersion === documentEvidence.version),
    receiveOrder: Boolean(hint.request && hint.receivedAt >= hint.request.at && Number.isInteger(hint.seq) && hint.seq > hint.request.lastServerSeq),
    noPendingWrite: ![...pendingWrites.values()].some(w => w.path === 'main.py'),
  });
  const ids = new WeakMap<object, number>(), pending = new Set<Promise<any>>();
  const id = (object: object | null) => object ? (ids.get(object) || (ids.set(object, ++nextId), nextId)) : null;
  const error = (stage: string, e: any) => output.recordingErrors.push({ stage, name: e?.name || 'Error', at: performance.now() });
  const flush = () => {
    clearTimeout(flushTimer); flushTimer = null;
    if (!queue.length) return;
    const batch = queue; queue = [];
    // Asynchronous one-way batches; never await the driver in a measured listener.
    const p = Promise.resolve().then(() => w.__qaMetricRecord(batch)).catch(e => error('binding', e));
    pending.add(p); void p.finally(() => pending.delete(p));
  };
  const record = (entry: any) => { queue.push(entry); if (flushTimer === null) flushTimer = setTimeout(flush, 0); };
  const visible = (e: Element | null) => {
    if (!e?.isConnected || !e.getClientRects().length) return false;
    const rect = e.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    for (let n: Element | null = e; n; n = n.parentElement) {
      const style = getComputedStyle(n);
      if (n.hasAttribute('hidden') || style.display === 'none' || style.visibility !== 'visible' || style.opacity === '0') return false;
    }
    return true;
  };
  const snapshot = () => {
    const inputs = host?.querySelectorAll('[role="textbox"][aria-label="Edytor pliku main.py"]');
    const candidate = inputs?.length === 1 ? inputs[0] as HTMLElement : null;
    const selected = header?.querySelector('[role="tab"][aria-selected="true"] > span');
    const coach = header?.querySelector('span.text-blue-400')?.textContent?.trim() === 'Pisze Trener AI';
    const student = header?.querySelector('span.text-red-400')?.textContent?.trim() === 'Tryb ucznia (Piszesz Ty)';
    return { at: performance.now(), panelId: id(panel), hostId: id(host), inputId: id(candidate),
      inputCount: inputs?.length || 0, native: Boolean(candidate?.classList.contains('native-edit-context')),
      connected: Boolean(candidate?.isConnected && panel?.isConnected && host?.isConnected),
      visible: visible(candidate) && visible(host) && visible(panel),
      loaded: visible(host?.querySelector('.view-lines') || null) && visible(candidate),
      activePath: selected?.textContent?.trim() || null, mode: host?.closest('[data-mode-id]')?.getAttribute('data-mode-id') || null,
      owner: coach && !student && panel?.classList.contains('border-blue-500') ? 'COACH'
        : student && !coach && panel?.classList.contains('border-red-600') ? 'STUDENT' : 'UNKNOWN',
      autocomplete: candidate?.getAttribute('aria-autocomplete') || null,
      activeDescendant: candidate?.getAttribute('aria-activedescendant') || null };
  };
  const all = (filters: Record<string, boolean>) => Object.values(filters).every(Boolean);
  const observer = new MutationObserver(() => schedule());
  const parentObserver = new MutationObserver(() => schedule());
  const watchBubble = () => {
    const found = body?.querySelector('.leading-relaxed.select-text.font-sans') || null;
    if (found && found !== bubble) { bubble = found; observer.observe(found, { subtree: true, childList: true, characterData: true }); }
    if (!found) bubble = null;
  };
  const schedule = () => {
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      try {
        const sampleStart = performance.now();
        if (current?.secondEscapeAt !== null && current?.localMs === null) {
          const state = snapshot();
          const filters = predicates.ready(current.baseline, state, current.validBase,
            predicates.pair(current.keys) && current.validAtEscape, current.veto);
          current.lastReadiness = { state, filters };
          if (all(filters)) {
            const observedAt = performance.now();
            current.readinessObservedAt = observedAt; current.localMs = observedAt - current.secondEscapeAt;
            current.readiness = { state, filters, sampleStart, observedAt, probeCostMs: observedAt - sampleStart };
            record({ kind: 'ready', trial: current.trial, at: observedAt, ...current.readiness });
          }
        }
        watchBubble();
        for (const hint of output.hints) if (hint.renderMs === null && hint.valid) {
          const state = snapshot();
          hint.renderFilters = { ...hintFilters(hint), activePath: state.activePath === hint.payload.path,
            loaded: state.loaded && state.visible && state.connected && state.mode === 'python' };
          if (!all(hint.renderFilters)) {
            hint.valid = false;
            record({ kind: 'hintRenderRejected', trial: hint.trial, id: hint.id, at: performance.now(),
              filters: hint.renderFilters, documentEvidence });
            continue;
          }
          if (bubble?.textContent === hint.text && visible(bubble)) {
            const observedAt = performance.now(); hint.renderMs = observedAt - hint.receivedAt;
            hint.renderedAt = observedAt;
            record({ kind: 'hintRendered', trial: hint.trial, id: hint.id, at: observedAt, renderMs: hint.renderMs });
          }
        }
      } catch (e) { error('sampleDOM', e); }
    });
  };
  const bindDOM = () => {
    observer.disconnect(); parentObserver.disconnect();
    const hosts = document.querySelectorAll<HTMLElement>('.monaco-editor');
    host = hosts.length === 1 ? hosts[0] : null;
    panel = host?.closest<HTMLElement>('[class~="border-[4px]"]') || null;
    header = panel?.firstElementChild || null;
    input = host?.querySelector<HTMLElement>('[role="textbox"][aria-label="Edytor pliku main.py"]') || null;
    body = header?.parentElement?.querySelector<HTMLElement>(':scope > .flex-1.relative.overflow-hidden') || null;
    for (const target of [panel, header, input, host, host?.parentElement?.parentElement, body]) if (target) {
      observer.observe(target, { attributes: true, attributeFilter: ['class', 'style', 'hidden', 'aria-autocomplete',
        'aria-label', 'aria-activedescendant', 'aria-selected', 'data-mode-id'],
      ...(target === header ? { subtree: true, childList: true, characterData: true } : {}) });
    }
    // Bubble insertion only; NOT subtree observation of Monaco's 100KiB view-lines.
    if (body) observer.observe(body, { childList: true, attributes: true, attributeFilter: ['hidden', 'class', 'style'] });
    if (panel?.parentElement) parentObserver.observe(panel.parentElement, { childList: true });
    bubble = null; watchBubble();
  };
  w.__qaMetric = {
    output, writes: [] as any[],
    arm(trial: number, marker: string) {
      if (current && (current.secondEscapeAt === null || current.localMs === null || current.ackMs === null)) {
        throw new Error('Previous trial is incomplete; never replace it');
      }
      bindDOM();
      const baseline = snapshot();
      current = { trial, marker, baseline, validBase: predicates.baseline(baseline), ownerWasCoach: predicates.baseline(baseline),
        keys: [], secondEscapeAt: null, messageId: null, veto: null, localMs: null, ackMs: null,
        readiness: null, lastReadiness: null, ackFilters: [], completed: false };
      output.vetoes.push(current); record({ kind: 'armed', trial, marker, baseline, validBase: current.validBase });
      if (!current.validBase) throw new Error('UNSUPPORTED: require native loaded main.py, COACH and aria-autocomplete=none');
      return baseline;
    },
    snapshot, expectHint(trial: number) { pendingHint = { trial, request: null }; },
    async flush() { flush(); await Promise.all([...pending]); if (output.recordingErrors.length) throw new Error('Metric recorder failed'); },
  };
  window.addEventListener('keydown', event => {
    const at = performance.now(); // First operation, before filtering, DOM, parsing or driver calls.
    if (event.key !== 'Escape') return;
    const key = { at, key: event.key, repeat: event.repeat, isTrusted: event.isTrusted };
    output.keys.push(key); record({ kind: 'key', ...key, trial: current?.trial ?? null });
    if (!current || current.secondEscapeAt !== null) return;
    current.keys.push(key);
    if (predicates.pair(current.keys)) {
      const state = snapshot();
      current.escapeState = state;
      current.validAtEscape = predicates.baseline(state) && state.inputId === current.baseline.inputId
        && state.hostId === current.baseline.hostId && state.panelId === current.baseline.panelId;
      current.secondEscapeAt = at;
      record({ kind: 'secondEscape', trial: current.trial, at, state, validAtEscape: current.validAtEscape }); schedule();
    }
  }, true);
  document.addEventListener('click', event => {
    const at = performance.now();
    const label = (event.target as Element)?.closest('button')?.textContent?.trim();
    if (label !== 'Zachowaj mój lokalny draft' && label !== 'Załaduj wersję z dysku') return;
    try {
      record({ kind: 'choice', trial: current?.trial ?? null, at,
        choice: label === 'Zachowaj mój lokalny draft' ? 'KEEP_LOCAL' : 'LOAD_DISK',
        localContent: (panel?.querySelector('[aria-label="Draft lokalny konfliktu"]') as HTMLTextAreaElement)?.value ?? null,
        diskContent: (panel?.querySelector('[aria-label="Wersja z dysku konfliktu"]') as HTMLTextAreaElement)?.value ?? null });
    } catch (e) { error('choice', e); }
  }, true);
  const NativeSocket = window.WebSocket;
  class ObservedSocket extends NativeSocket {
    connection: number;
    constructor(url: string | URL, protocols?: string | string[]) {
      super(url, protocols); this.connection = ++connectionCounter;
      const connection = this.connection;
      const state = { connection, openedAt: null as number | null, closedAt: null as number | null, closeCode: null as number | null };
      output.connections.push(state);
      this.addEventListener('open', () => { state.openedAt = performance.now(); record({ kind: 'open', connection, at: state.openedAt }); });
      this.addEventListener('close', e => { documentEvidence = null; state.closedAt = performance.now(); state.closeCode = e.code;
        record({ kind: 'close', connection, at: state.closedAt, code: e.code }); });
      this.addEventListener('error', () => record({ kind: 'socketError', connection, at: performance.now() }));
      this.addEventListener('message', event => {
        const at = performance.now(); // Includes dispatch, NOT server/network time; before JSON.parse.
        try {
          const f = JSON.parse(event.data), p = f.payload;
          lastServerSeq = f.seq;
          const meta: any = { kind: 'wire', direction: 'in', at, connection, type: f.type,
            messageId: f.messageId, sessionId: f.sessionId, seq: f.seq, trial: current?.trial ?? null, payload: {} };
          for (const key of ['replyTo','status','documentVersion','workspaceVersion','controlEpoch','writeOwner','interventionId',
            'stepId','path','baseVersion','version','contentHash','id','severity','requestId','ready','lastAppliedSeq']) {
            if (p?.[key] !== undefined) meta.payload[key] = p[key];
          }
          if (f.type === 'ACK') meta.payload.error = p.error === null ? null : { code: p.error?.code || 'INVALID' };
          if (f.type === 'SESSION_SNAPSHOT') {
            const identity = { sessionId: p.session.sessionId, projectId: p.project.projectId, rootPath: p.project.rootPath, connection };
            if (output.identity?.sessionId !== identity.sessionId || output.identity?.connection !== connection) pendingWrites.clear();
            output.identity = identity; documentEvidence = null;
            documentVersion(f, connection, at, p.activeDocument?.path, p.activeDocument?.version, 'SESSION_SNAPSHOT');
            meta.identity = identity;
            latestControl = { ...p.session, sessionId: f.sessionId, seq: f.seq, connection, at };
          }
          if (f.type === 'COACH_STEP_EDIT') documentVersion(f, connection, at, p.path, p.version, 'COACH_STEP_EDIT');
          if (f.type === 'EXTERNAL_FILE_SYNC') documentVersion(f, connection, at, p.path,
            p.operation === 'DELETED' ? null : p.document?.version ?? p.version, 'EXTERNAL_FILE_SYNC');
          if (f.type === 'ACK') {
            const write = pendingWrites.get(p.replyTo);
            if (write && write.sessionId === f.sessionId && write.connection === connection) {
              pendingWrites.delete(p.replyTo);
              documentVersion(f, connection, at, write.path,
                p.status === 'OK' && p.error === null && p.documentVersion > write.baseVersion ? p.documentVersion : null, 'WRITE_ACK');
              schedule();
            }
          }
          if (f.type === 'CONTROL_STATE' || f.type === 'SESSION_STATE') latestControl = { ...p, sessionId: f.sessionId, seq: f.seq, connection, at };
          if (f.type === 'ACK' && current?.veto && p.replyTo === current.veto.messageId) {
            const a = { ...p, sessionId: f.sessionId, seq: f.seq, connection, at };
            const filters = predicates.vetoAck(current.veto, a, latestControl);
            current.ackFilters.push({ ack: a, control: latestControl, filters });
            if (all(filters) && current.ackMs === null) { current.ackMs = at - current.secondEscapeAt; current.ack = a; }
            record({ kind: 'vetoAck', trial: current.trial, ack: a, control: latestControl, filters,
              ackMs: all(filters) ? at - current.secondEscapeAt : null });
          }
          if (f.type === 'COACH_HINT_BUBBLE') {
            const request = pendingHint?.request;
            const hint: any = { trial: pendingHint?.trial ?? null, id: p.id, text: p.text, payload: p,
              sessionId: f.sessionId, connection, seq: f.seq, receivedAt: at, renderMs: null, request,
              documentAtReceipt: documentEvidence ? { ...documentEvidence } : null };
            hint.receiptFilters = hintFilters(hint); hint.valid = all(hint.receiptFilters);
            output.hints.push(hint); meta.hint = hint; pendingHint = null; schedule();
          }
          record(meta);
        } catch (e) { error('incoming', e); }
      });
    }
    send(data: Parameters<WebSocket['send']>[0]) {
      const at = performance.now();
      try {
        if (typeof data === 'string') {
          const f = JSON.parse(data), p = f.payload;
          const meta: any = { kind: 'wire', direction: 'out', at, connection: this.connection, type: f.type,
            messageId: f.messageId, sessionId: f.sessionId, clientId: f.clientId, lastServerSeq, trial: current?.trial ?? null, payload: {} };
          for (const key of ['controlEpoch','activeInterventionId','lastAppliedSeq','stepId','interventionId','path','baseVersion',
            'editKind','documentVersion','workspaceVersion','requestId','ready']) if (p?.[key] !== undefined) meta.payload[key] = p[key];
          // HELLO tokens / auth URL / chat / document snapshots are NEVER copied into records.
          if (f.type === 'CODE_CHANGED') { meta.content = p.content; w.__qaMetric.writes.push({ ...meta, ...p });
            pendingWrites.set(f.messageId, { ...meta, path: p.path, baseVersion: p.baseVersion }); }
          if (f.type === 'VETO_ESCAPE' && current) {
            const veto = { ...meta, ...p, lastServerSeq };
            if (current.veto) error('duplicateVeto', new Error());
            else { current.veto = veto; current.messageId = f.messageId; }
            schedule();
          }
          if (f.type === 'CHAT_MESSAGE' && p.text === 'QA:HINT' && pendingHint) pendingHint.request = { ...meta };
          record(meta);
        }
      } catch (e) { error('outgoing', e); }
      return super.send(data); // Original payload, exactly once; original exceptions are not swallowed.
    }
  }
  window.WebSocket = ObservedSocket;
}

export const metricObserverSource = () => `(() => { const __name = (fn, _name) => fn; (${installMetricObserver.toString()})(${createMetricPredicates.toString()}); })();`;
export const observeMetrics = (page: Page) => page.addInitScript({ content: metricObserverSource() });

/** Outside measured windows: actual rendered marker, never a model/API read or body scan. */
export function calibrationMarkerEvidence({ marker, baseline }: { marker: string; baseline: any }) {
  const state = (window as any).__qaMetric.snapshot();
  const inputs = document.querySelectorAll('.monaco-editor [role="textbox"][aria-label="Edytor pliku main.py"]');
  const editor = inputs.length === 1 ? inputs[0].closest('.monaco-editor') : null;
  let renderedMarker = false;
  for (const line of editor?.querySelectorAll('.view-lines .view-line') || []) {
    if (!line.textContent?.replace(/\u00a0/g, ' ').includes(`# ${marker}`)) continue;
    let lineVisible = line.isConnected && line.getClientRects().length > 0;
    for (let n: Element | null = line; n; n = n.parentElement) {
      const style = getComputedStyle(n);
      if (n.hasAttribute('hidden') || style.display === 'none' || style.visibility !== 'visible' || style.opacity === '0') lineVisible = false;
    }
    if (lineVisible) renderedMarker = true;
  }
  return { sameInput: state.inputId === baseline.inputId && state.hostId === baseline.hostId && state.panelId === baseline.panelId,
    loaded: state.loaded && state.visible && state.connected && state.native && state.inputCount === 1,
    activePath: state.activePath === 'main.py' && state.mode === 'python',
    student: state.owner === 'STUDENT' && state.autocomplete === 'both',
    renderedMarker };
}
