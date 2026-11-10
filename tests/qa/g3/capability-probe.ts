/** One bounded real REST/WS probe on K-specified base. Missing G3 = exit2 NOT_READY,
 * not a successful acceptance case, not a skipped test, and not a fake implementation. */
import WebSocket from 'ws';
import { randomUUID } from 'node:crypto';
import { fixture } from './fixture';
const f = await fixture();
const observed: Record<string, unknown> = { platform: process.platform, node: process.version, base: f.base };
let ws: WebSocket | undefined;
try {
  const getSession = async () => (await fetch(f.baseURL + '/api/session', { headers: { Authorization: 'Bearer ' + f.token } })).json() as Promise<any>;
  const s = await getSession(), clientId = randomUUID();
  ws = new WebSocket(f.baseURL.replace('http:', 'ws:') + '/ws/session', { origin: f.baseURL });
  const snapshot = new Promise<any>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Real HELLO/session snapshot timeout')), 3000);
    ws!.on('error', reject);
    ws!.on('message', bytes => { const m = JSON.parse(bytes.toString()); if (m.type === 'SESSION_SNAPSHOT') { clearTimeout(timeout); resolve(m); } });
  });
  await new Promise<void>((resolve, reject) => { ws!.once('open', resolve); ws!.once('error', reject); });
  ws.send(JSON.stringify({ protocolVersion: '3.0', messageId: randomUUID(), sessionId: s.sessionId, clientId,
    type: 'HELLO', payload: { token: f.token, lastServerSeq: 0 } }));
  await snapshot;
  const post = async (url: string, data: unknown) => {
    const r = await fetch(f.baseURL + '/api' + url, { method: 'POST', headers: { Authorization: 'Bearer ' + f.token, 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
    return { status: r.status, body: await r.json() as any };
  };
  const commands = { clientId, sessionId: s.sessionId };
  observed.start = await post('/session/start', { ...commands, requestId: randomUUID(), limitMs: 1000, pauseOnHidden: true });
  observed.runMissingProfile = await post('/run', { ...commands, requestId: randomUUID(), mode: 'RUN_TESTS', expectedWorkspaceVersion: s.workspaceVersion });
  observed.finish = await post('/session/finish', { ...commands, requestId: randomUUID(), reason: 'ABANDONED', expectedWorkspaceVersion: s.workspaceVersion });
  try { f.app.workspace.createSnapshot('G3 capability only', ['main.py']); observed.snapshot = 'READY'; }
  catch (e) { observed.snapshot = { code: (e as any).code, message: (e as Error).message }; }
  const ready = (observed.runMissingProfile as any).status === 409 && (observed.runMissingProfile as any).body.code === 'RUN_PROFILE_MISSING'
    && (observed.finish as any).status === 202 && observed.snapshot === 'READY';
  observed.result = ready ? 'CAPABILITIES_PRESENT_NOT_ACCEPTANCE_PASS' : 'NOT_READY'; process.exitCode = ready ? 0 : 2;
} finally { ws?.terminate(); await f.close(); console.log(JSON.stringify(observed, null, 2)); }
