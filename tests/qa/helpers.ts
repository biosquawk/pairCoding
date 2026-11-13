/** Real product fixtures. This module never substitutes a server or WriteGate. */
import assert from 'node:assert/strict';
import httpRequest from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { TestContext } from 'node:test';
import WebSocket from 'ws';
import type { Document, Session, Settings } from '../../src/shared/protocol';

export const DEADLINE = 5000; // hang guard only, NOT the 50ms WriteGate criterion
export const id = () => randomUUID();
export const hash = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
export const settings: Settings = {
  taskFilePath: 'challenge.md', taskMode: 'IMPLEMENTATION', reviewNotesPath: 'review.md',
  runProfiles: [], aiConsent: false, contextPatterns: ['**/*.py', '**/*.md'],
};

/** Explicit fixture input, before constructing the production V2 owner. */
export async function seedRuntimeSettings(rootPath: string, value: Settings) {
  const dataDir=path.join(rootPath,'.paircoach');
  await mkdir(dataDir,{recursive:true,mode:0o700});
  await writeFile(path.join(dataDir,'settings.json'),JSON.stringify({...value,schemaVersion:2}),{mode:0o600});
}

export async function workspaceFiles(t: TestContext, files: Record<string, string | Buffer> = {}) {
  const parent = path.resolve(process.env.PAIRCOACH_QA_TMP || 'tests/qa/.runtime');
  await mkdir(parent, { recursive: true });
  const base = await mkdtemp(path.join(parent, 'case-'));
  const rootPath = path.join(base, 'project');
  const dataDir = path.join(rootPath, '.paircoach');
  await mkdir(rootPath); await mkdir(dataDir, { mode: 0o700 });
  for (const [name, content] of Object.entries({ 'challenge.md': '# Independent QA challenge\n', ...files })) {
    const dest = path.join(rootPath, name);
    await mkdir(path.dirname(dest), { recursive: true });
    await writeFile(dest, content);
  }
  const cleanup = async () => {
    if (process.env.PAIRCOACH_QA_KEEP === '1') t.diagnostic(`preserved fixture: ${base}`);
    else await rm(base, { recursive: true, force: true });
  };
  return { base, rootPath, dataDir, cleanup };
}

export function assertDocument(value: Document) {
  assert.equal(typeof value.path, 'string');
  assert(Number.isInteger(value.version) && value.version >= 1);
  assert.equal(typeof value.content, 'string');
  assert(!value.content.includes('\r'), 'wire text is LF');
  assert.equal(value.contentHash, hash(value.content));
  assert.equal(typeof value.utf8Bom, 'boolean');
  assert.equal(typeof value.readOnly, 'boolean');
}

export function assertApiError(value: any) {
  assert.equal(typeof value.code, 'string'); assert(value.code.length > 0);
  assert.equal(typeof value.message, 'string'); assert(value.message.length > 0);
  assert.equal(typeof value.retryable, 'boolean');
  assert(value.requestId === null || typeof value.requestId === 'string');
  assert(value.currentVersion === null || Number.isInteger(value.currentVersion));
}

export async function coreFixture(t: TestContext, files: Record<string, string | Buffer> = {}) {
  const dirs = await workspaceFiles(t, files);
  let workspace: any, session: any;
  t.after(async () => { session?.close(); workspace?.close(); await dirs.cleanup(); });
  // All three imports are actual owned P1 modules, never a test reimplementation.
  const { WorkspaceService } = await import('../../src/server/WorkspaceService');
  const { SessionController } = await import('../../src/server/SessionController');
  const { WriteGate } = await import('../../src/server/WriteGate');
  workspace = new WorkspaceService(dirs.rootPath, dirs.dataDir);
  session = new SessionController(workspace);
  const gate = new WriteGate(workspace, session);
  const clientId = id();
  assert.equal(session.claimLease(clientId), true);
  const state = session.getSession();
  return { ...dirs, workspace, session, gate, clientId, sessionId: state.sessionId };
}

export async function serverFixture(t: TestContext, files: Record<string, string | Buffer> = {}) {
  const dirs = await workspaceFiles(t, files);
  let app: any;
  const peers = new Set<{ close(): void }>();
  t.after(async () => {
    for (const peer of peers) peer.close();
    try { await app?.close(); } finally { await dirs.cleanup(); }
  });
  // K owns this export/path. Missing implementation is NOT_RUN, not a fallback to mock.
  const { createPairCoachServer } = await import('../../src/server/http');
  const token = `qa-fixture-${id()}`; // ephemeral, fixture only; never a production secret
  app = createPairCoachServer({ rootPath:dirs.rootPath, token, port: 0, enableCoach: false });
  const port = await app.listen();
  assert(Number.isInteger(port) && port > 0 && port <= 65535);
  assert(![8765, 8766, 8767, 8768].includes(port), 'reserved platform ports forbidden');
  const address = app.server.address();
  assert(address && typeof address !== 'string');
  assert.equal(address.address, '127.0.0.1');
  const baseURL = `http://127.0.0.1:${port}`;
  const clientId = id();
  async function http(method: string, target: string, payload?: unknown, headers: Record<string, string> = {}) {
    const response = await fetch(baseURL + target, {
      method, signal: AbortSignal.timeout(DEADLINE),
      headers: { Authorization: `Bearer ${token}`, ...(payload === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers },
      body: payload === undefined ? undefined : JSON.stringify(payload),
    });
    assert.notEqual(response.headers.get('access-control-allow-origin'), '*');
    const body = await response.json();
    return { status: response.status, body, headers: response.headers };
  }
  async function rawHttp(target: string, headers: Record<string, string>) {
    // Native fetch rewrites Host in Node22; raw http.request preserves the actual attack header.
    return new Promise<{ status: number; body: any }>((resolve, reject) => {
      const req = httpRequest.get(baseURL + target, { headers: { Authorization: `Bearer ${token}`, ...headers } }, res => {
        const chunks: Buffer[] = [];
        res.on('data', chunk => chunks.push(Buffer.from(chunk)));
        res.once('end', () => {
          try { resolve({ status: res.statusCode!, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) }); }
          catch (error) { reject(error); }
        });
        res.once('error', reject);
      });
      req.once('error', reject); req.setTimeout(DEADLINE, () => req.destroy(new Error('raw HTTP timeout')));
    });
  }
  const sessionReply = await http('GET', '/api/session');
  assert.equal(sessionReply.status, 200);
  const state = sessionReply.body as Session;
  return { ...dirs, app, peers, token, port, baseURL, http, rawHttp, clientId, sessionId: state.sessionId, state };
}

type Frame = { protocolVersion: string; messageId: string; sessionId: string; seq: number; type: string; payload: any };
type Match = (frame: Frame) => boolean;

/** Actual WebSocket; keeps ALL messages so events preceding ACK cannot get lost. */
export class Peer {
  readonly socket: WebSocket;
  readonly frames: Frame[] = [];
  readonly violations: string[] = [];
  private waits = new Set<() => void>();
  private closed = false;
  private seen = 0;
  constructor(private fixture: Awaited<ReturnType<typeof serverFixture>>, readonly clientId = fixture.clientId) {
    fixture.peers.add(this);
    this.socket = new WebSocket(`ws://127.0.0.1:${fixture.port}/ws/session`, { origin: fixture.baseURL });
    this.socket.on('message', data => {
      try {
        const frame = JSON.parse(data.toString()) as Frame;
        if (frame.protocolVersion !== '3.0') this.violations.push('protocolVersion');
        if (frame.sessionId !== fixture.sessionId) this.violations.push('sessionId');
        if (!Number.isInteger(frame.seq) || frame.seq <= this.seen) this.violations.push(`non-increasing seq ${this.seen}->${frame.seq}`);
        this.seen = frame.seq;
        this.frames.push(frame);
      } catch (error) { this.violations.push(String(error)); }
      for (const wake of this.waits) wake();
    });
    this.socket.on('close', () => { this.closed = true; for (const wake of this.waits) wake(); });
    this.socket.on('error', () => { /* surfaced by connect/wait, no uncaught EventEmitter error */ });
  }
  async connect(lastServerSeq = 0) {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('WS open timeout')), DEADLINE);
      this.socket.once('open', () => { clearTimeout(timer); resolve(); });
      this.socket.once('error', err => { clearTimeout(timer); reject(err); });
    });
    this.send('HELLO', { token: this.fixture.token, lastServerSeq });
    return this.take(frame => frame.type === 'SESSION_SNAPSHOT');
  }
  send(type: string, payload: unknown, messageId = id()) {
    this.socket.send(JSON.stringify({ protocolVersion: '3.0', messageId,
      sessionId: this.fixture.sessionId, clientId: this.clientId, type, payload }));
    return messageId;
  }
  async take(match: Match, timeoutMs = DEADLINE): Promise<Frame> {
    return new Promise<Frame>((resolve, reject) => {
      const timer = setTimeout(() => { this.waits.delete(check); reject(new Error('WS matching-frame timeout')); }, timeoutMs);
      const check = () => {
        const index = this.frames.findIndex(match);
        if (index >= 0) {
          clearTimeout(timer); this.waits.delete(check);
          resolve(this.frames.splice(index, 1)[0]);
        } else if (this.closed) {
          clearTimeout(timer); this.waits.delete(check); reject(new Error('WS closed before expected frame'));
        }
      };
      this.waits.add(check); check();
    });
  }
  ack(messageId: string, timeoutMs = DEADLINE) { return this.take(frame => frame.type === 'ACK' && frame.payload.replyTo === messageId, timeoutMs); }
  close() { this.socket.terminate(); }
  assertProtocol() { assert.deepEqual(this.violations, []); }
}

export async function connected(t: TestContext, fixture: Awaited<ReturnType<typeof serverFixture>>) {
  const peer = new Peer(fixture); t.after(() => peer.close());
  const snapshot = await peer.connect();
  assert.equal(snapshot.payload.session.sessionId, fixture.sessionId);
  return peer;
}
