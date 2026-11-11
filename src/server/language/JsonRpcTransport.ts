import type { Readable, Writable } from 'node:stream';
import { TextDecoder } from 'node:util';

export type ClientRequestMethod = 'initialize' | 'shutdown' | 'textDocument/completion' | 'workspace/executeCommand';
export type ClientNotificationMethod = 'initialized' | 'exit' | '$/cancelRequest'
  | 'textDocument/didOpen' | 'textDocument/didChange' | 'textDocument/didClose' | 'workspace/didChangeConfiguration';
export type ConfigurationRequestMethod = 'workspace/configuration' | 'workspace/workspaceFolders';
export interface RpcNotification { method: string; params: unknown }
export interface RpcTransportOptions {
  /** Unique connection identity minted by the backend, not a client/LSP value. */
  connectionId: string;
  configuration?: (method: ConfigurationRequestMethod, params: unknown) => unknown | Promise<unknown>;
  onClosed?: (error: Error) => void;
}
export class RpcRemoteError extends Error {
  constructor(readonly code: number, message: string) { super(message); this.name = 'RpcRemoteError'; }
}
interface Pending {
  resolve: (value: unknown) => void; reject: (reason: Error) => void;
  timer: ReturnType<typeof setTimeout>; unsubscribe: () => void; sent: boolean;
}
const MAX_INCOMING = 256 * 1024, MAX_OUTGOING = 8 * 1024 * 1024;
const MAX_HEADERS = 8192, MAX_QUEUED = 16 * 1024 * 1024, MAX_PENDING = 128;
const requests = new Set(['initialize', 'shutdown', 'textDocument/completion', 'workspace/executeCommand']);
const notifications = new Set(['initialized', 'exit', '$/cancelRequest', 'textDocument/didOpen',
  'textDocument/didChange', 'textDocument/didClose', 'workspace/didChangeConfiguration']);
const abortError = (message: string) => Object.assign(new Error(message), { name: 'AbortError' });

/** Real LSP stdio JSON-RPC framing. This class owns no process/container and cannot claim confirmed Stop. */
export class JsonRpcTransport {
  private buffer = Buffer.alloc(0);
  private expected: number | null = null;
  private serial = 0;
  private serverPending = 0;
  private pending = new Map<string, Pending>();
  private listeners = new Set<(notification: RpcNotification) => void>();
  private closedListeners = new Set<(error: Error) => void>();
  private queue: Promise<void> = Promise.resolve();
  private queuedBytes = 0;
  private failure: Error | null = null;
  private decoder = new TextDecoder('utf-8', { fatal: true });
  constructor(private readonly input: Readable, private readonly output: Writable,
    private readonly options: RpcTransportOptions) {
    if (!/^[a-zA-Z0-9_-]{1,100}$/.test(options.connectionId)) throw new Error('Invalid RPC connection identity');
    input.on('data', this.onData);
    input.on('end', this.onEnd);
    input.on('close', this.onEnd);
    input.on('error', this.onError);
    output.on('error', this.onError);
    output.on('close', this.onEnd);
  }
  get closed(): boolean { return this.failure !== null; }
  get pendingCount(): number { return this.pending.size; }
  subscribe(listener: (notification: RpcNotification) => void): () => void {
    if (this.failure) throw this.failure;
    this.listeners.add(listener); return () => this.listeners.delete(listener);
  }
  subscribeClosed(listener: (error: Error) => void): () => void {
    if (this.failure) { listener(this.failure); return () => {}; }
    this.closedListeners.add(listener); return () => this.closedListeners.delete(listener);
  }
  async request(method: ClientRequestMethod, params: unknown,
    options: { signal?: AbortSignal; timeoutMs?: number; onSent?: (id: string) => void } = {}): Promise<unknown> {
    if (!requests.has(method)) throw new Error('Forbidden LSP request method');
    // The ONLY command is pinned JDT read-only project introspection; never a general command tunnel.
    if (method === 'workspace/executeCommand') {
      const p = params as { command?: unknown; arguments?: unknown } | null;
      if (!p || typeof p !== 'object' || Array.isArray(p) || Object.keys(p).sort().join(',') !== 'arguments,command' ||
        p.command !== 'java.project.getAll' || !Array.isArray(p.arguments) || p.arguments.length !== 0) throw new Error('Forbidden LSP command');
    }
    if (this.failure) throw this.failure;
    if (options.signal?.aborted) throw abortError('Cancelled before send');
    const timeout = options.timeoutMs ?? 30000;
    if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 30000) throw new Error('Invalid request deadline');
    if (this.pending.size >= MAX_PENDING) throw new Error('LSP pending request limit');
    const id = `${this.options.connectionId}:${++this.serial}`;
    return new Promise((resolve, reject) => {
      const cancel = (reason: Error) => {
        const entry = this.take(id); if (!entry) return;
        entry.reject(reason);
        if (entry.sent && !this.failure) void this.notify('$/cancelRequest', { id }).catch(this.onError);
      };
      const onAbort = () => cancel(abortError('Cancelled LSP request'));
      const timer = setTimeout(() => cancel(new Error('LSP request deadline exceeded')), timeout);
      this.pending.set(id, { resolve, reject, timer, sent: false,
        unsubscribe: () => options.signal?.removeEventListener('abort', onAbort) });
      options.signal?.addEventListener('abort', onAbort, { once: true });
      void this.write({ jsonrpc: '2.0', id, method, params }, () => {
        const entry = this.pending.get(id); if (!entry) return false;
        entry.sent = true; options.onSent?.(id); return true;
      }).catch(error => { const entry = this.take(id); entry?.reject(error); });
    });
  }
  notify(method: ClientNotificationMethod, params: unknown, onSent?: () => void): Promise<void> {
    if (!notifications.has(method)) return Promise.reject(new Error('Forbidden LSP notification method'));
    return this.write({ jsonrpc: '2.0', method, params }, () => { onSent?.(); return true; });
  }
  /** Rejects all pending requests; lifecycle owner must separately stop+inspect+collect its container. */
  close(reason: Error = new Error('RPC transport disposed')): void { this.fail(reason); }
  private take(id: string): Pending | undefined {
    const entry = this.pending.get(id);
    if (entry) { this.pending.delete(id); clearTimeout(entry.timer); entry.unsubscribe(); }
    return entry;
  }
  private write(message: unknown, admit: () => boolean = () => true): Promise<void> {
    if (this.failure) return Promise.reject(this.failure);
    let body: Buffer;
    try { body = Buffer.from(JSON.stringify(message), 'utf8'); } catch (e) { return Promise.reject(e); }
    if (body.length > MAX_OUTGOING || this.queuedBytes + body.length > MAX_QUEUED)
      return Promise.reject(new Error('LSP outgoing message/queue limit'));
    this.queuedBytes += body.length;
    const frame = Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'ascii'), body]);
    const sent = this.queue.then(() => {
      if (this.failure) throw this.failure;
      if (!admit()) return;
      return new Promise<void>((resolve, reject) => {
        this.output.write(frame, error => error ? reject(error) : resolve());
      });
    }).finally(() => { this.queuedBytes -= body.length; });
    this.queue = sent.catch(error => { this.fail(error); });
    return sent;
  }
  private onData = (chunk: Buffer | string): void => {
    if (this.failure) return;
    try {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, 'utf8');
      // Pipes normally deliver <=64KiB. A chunk may contain multiple frames: consume bounded slices.
      for (let offset = 0; offset < bytes.length; offset += 4096) {
        this.buffer = Buffer.concat([this.buffer, bytes.subarray(offset, offset + 4096)]);
        this.consume(); if (this.failure) break;
      }
    } catch (error) { this.fail(error instanceof Error ? error : new Error(String(error))); }
  };
  private consume(): void {
    for (;;) {
      if (this.expected === null) {
        const end = this.buffer.indexOf('\r\n\r\n');
        if (end < 0) { if (this.buffer.length > MAX_HEADERS) throw new Error('LSP header limit'); return; }
        if (end > MAX_HEADERS) throw new Error('LSP header limit');
        const head = this.buffer.subarray(0, end);
        if ([...head].some(c => c < 32 && c !== 9 && c !== 13 && c !== 10 || c > 126)) throw new Error('Invalid LSP header bytes');
        const lines = head.toString('ascii').split('\r\n'); let length: number | null = null;
        for (const line of lines) {
          const match = /^([A-Za-z-]+):[ \t]*(.*)$/.exec(line); if (!match) throw new Error('Invalid LSP header');
          if (match[1].toLowerCase() === 'content-length') {
            if (length !== null || !/^(0|[1-9][0-9]{0,7})$/.test(match[2])) throw new Error('Duplicate/invalid Content-Length');
            length = Number(match[2]);
          } else if (match[1].toLowerCase() !== 'content-type') throw new Error('Unsupported LSP header');
        }
        if (length === null || length < 2 || length > MAX_INCOMING) throw new Error('LSP body size limit');
        this.expected = length; this.buffer = this.buffer.subarray(end + 4);
      }
      if (this.buffer.length < this.expected) return;
      const body = this.buffer.subarray(0, this.expected);
      this.buffer = this.buffer.subarray(this.expected); this.expected = null;
      this.dispatch(JSON.parse(this.decoder.decode(body)));
      if (this.failure) return;
    }
  }
  private dispatch(value: unknown): void {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid JSON-RPC message');
    const message = value as Record<string, unknown>;
    if (message.jsonrpc !== '2.0') throw new Error('Invalid JSON-RPC version');
    if ('method' in message && typeof message.method !== 'string') throw new Error('Invalid RPC method');
    if (typeof message.method === 'string') {
      if ('result' in message || 'error' in message) throw new Error('Mixed JSON-RPC envelope');
      if ('id' in message) {
        if (!(typeof message.id === 'string' && message.id.length <= 128) &&
          !(typeof message.id === 'number' && Number.isSafeInteger(message.id))) throw new Error('Invalid server request ID');
        void this.serverRequest(message.id as string | number, message.method, message.params).catch(this.onError);
      } else for (const listener of this.listeners) listener({ method: message.method, params: message.params });
      return;
    }
    if (!('id' in message) || ('result' in message) === ('error' in message)) throw new Error('Invalid RPC response');
    // Unknown/duplicate/late IDs have no authority, even if their payload appears current.
    if (typeof message.id !== 'string') return;
    const entry = this.take(message.id); if (!entry) return;
    if ('error' in message) {
      const e = message.error as { code?: unknown; message?: unknown } | null;
      if (!e || typeof e.code !== 'number' || typeof e.message !== 'string') { entry.reject(new Error('Invalid RPC error')); return; }
      entry.reject(new RpcRemoteError(e.code, e.message));
    } else entry.resolve(message.result);
  }
  private async serverRequest(id: string | number, method: string, params: unknown): Promise<void> {
    if (++this.serverPending > 32) { this.serverPending--; throw new Error('Server request concurrency limit'); }
    try {
    // Never execute server commands or permit unsolicited writes, regardless of any injected callback.
    if (method === 'workspace/applyEdit') {
      await this.write({ jsonrpc: '2.0', id, result: { applied: false, failureReason: 'Language provider has no workspace write authority' } });
    } else if ((method === 'workspace/configuration' || method === 'workspace/workspaceFolders') && this.options.configuration) {
      const result = await this.options.configuration(method, params);
      if (!this.failure) await this.write({ jsonrpc: '2.0', id, result: result ?? null });
    } else if (method === 'window/workDoneProgress/create') {
      await this.write({ jsonrpc: '2.0', id, result: null });
    } else await this.write({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Unsupported server request' } });
    } finally { this.serverPending--; }
  }
  private onEnd = (): void => this.fail(new Error('LSP stdio closed; process Stop is not confirmed'));
  private onError = (error: Error): void => this.fail(error);
  private fail(error: Error): void {
    if (this.failure) return;
    this.failure = error;
    this.input.off('data', this.onData); this.input.off('end', this.onEnd); this.input.off('close', this.onEnd);
    this.output.off('close', this.onEnd);
    // Keep idempotent error sinks while owner retires the actual process to avoid unhandled pipe errors.
    for (const id of [...this.pending.keys()]) this.take(id)?.reject(error);
    this.buffer = Buffer.alloc(0); this.listeners.clear();
    for (const listener of this.closedListeners) { try { listener(error); } catch { /* lifecycle observers are isolated */ } }
    this.closedListeners.clear();
    this.options.onClosed?.(error);
  }
}
