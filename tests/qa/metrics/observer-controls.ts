/** Synthetic JS/DOM transport harness. Never native, browser, backend or timing evidence. */
import vm from 'node:vm';
import { metricObserverSource } from './observer';
export function observerControl() {
  let now = 100, nextSeq = 0, raf: (() => void) | null = null;
  const records: any[] = [];
  const node = (parent: any = null): any => ({ parentElement: parent, isConnected: true,
    getClientRects: () => [{}], getBoundingClientRect: () => ({ width: 10, height: 10 }),
    getAttribute: (key: string) => key === 'data-mode-id' ? 'python' : null,
    hasAttribute: () => false, classList: { contains: () => false }, querySelector: () => null });
  const panel = node(), host = node(panel), header = node(panel), input = node(host), view = node(host), body = node(panel), bubble = node(body);
  bubble.textContent = 'current hint';
  panel.classList.contains = (c: string) => c === 'border-blue-500'; panel.firstElementChild = header;
  panel.querySelector = () => body;
  header.querySelector = (s: string) => s.includes('aria-selected') ? { textContent: 'main.py' }
    : s === 'span.text-blue-400' ? { textContent: 'Pisze Trener AI' } : null;
  input.classList.contains = (c: string) => c === 'native-edit-context';
  input.getAttribute = (key: string) => key === 'aria-autocomplete' ? 'none' : null;
  host.closest = (s: string) => s === '[data-mode-id]' ? host : panel;
  host.querySelectorAll = () => [input]; host.querySelector = (s: string) => s === '.view-lines' ? view : input;
  body.querySelector = () => bubble;
  class Socket {
    listeners: Record<string, Function[]> = {};
    addEventListener(type: string, cb: Function) { (this.listeners[type] ||= []).push(cb); }
    send(_data: any) {}
    incoming(frame: any) { for (const cb of this.listeners.message || []) cb({ data: JSON.stringify(frame) }); }
  }
  const win: any = { addEventListener() {}, WebSocket: Socket, __qaMetricRecord: async (batch: any[]) => records.push(...batch) };
  const context = vm.createContext({ window: win,
    document: { addEventListener() {}, querySelectorAll: () => [host] },
    getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1' }),
    MutationObserver: class { disconnect() {} observe() {} },
    requestAnimationFrame: (f: () => void) => { raf = f; return 1; },
    performance: { now: () => now++ }, setTimeout, clearTimeout, Promise, WeakMap, Set, Map });
  new vm.Script(metricObserverSource()).runInContext(context);
  win.__qaMetric.arm(0, 'qa_probe_0');
  const socket = new win.WebSocket('ws://synthetic');
  const incoming = (type: string, payload: any, sessionId = 's1', target = socket) =>
    target.incoming({ type, payload, sessionId, seq: ++nextSeq, messageId: `in${nextSeq}` });
  const snapshot = (version: number | null = 8) => incoming('SESSION_SNAPSHOT', {
    session: { sessionId: 's1' }, project: { projectId: 'p1', rootPath: '/fixture' },
    activeDocument: version === null ? null : { path: 'main.py', version } });
  const request = (version = 8, path = 'main.py') => {
    win.__qaMetric.expectHint(0);
    socket.send(JSON.stringify({ type: 'CHAT_MESSAGE', sessionId: 's1', messageId: 'request1', payload: { text: 'QA:HINT', path, documentVersion: version } }));
  };
  const hint = (version = 8, path = 'main.py', session = 's1', target = socket) => incoming('COACH_HINT_BUBBLE', {
    id: 'hint1', path, text: 'current hint', severity: 'NEUTRAL', documentVersion: version, evidenceIds: [], range: null,
  }, session, target);
  return { win, socket, snapshot, request, hint, incoming, records,
    render() { const f = raf; raf = null; f?.(); }, flush: () => win.__qaMetric.flush() };
}
