import { EventEmitter } from 'node:events';

export function encode(message) {
  const bytes = Buffer.from(JSON.stringify(message));
  return Buffer.concat([Buffer.from(`Content-Length: ${bytes.length}\r\n\r\n`), bytes]);
}

export class Decoder {
  buffer = Buffer.alloc(0);
  feed(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    if (this.buffer.length > 8 * 1024 * 1024) throw new Error('LSP frame buffer limit');
    const messages = [];
    for (;;) {
      const end = this.buffer.indexOf('\r\n\r\n');
      if (end < 0) break;
      const header = this.buffer.subarray(0, end).toString('ascii');
      const matches = [...header.matchAll(/^Content-Length:\s*(\d+)\s*$/gim)];
      if (matches.length !== 1) throw new Error('Invalid Content-Length');
      const length = Number(matches[0][1]);
      if (!Number.isSafeInteger(length) || length > 8 * 1024 * 1024) throw new Error('LSP message limit');
      if (this.buffer.length < end + 4 + length) break;
      messages.push(JSON.parse(this.buffer.subarray(end + 4, end + 4 + length).toString('utf8')));
      this.buffer = this.buffer.subarray(end + 4 + length);
    }
    return messages;
  }
}

/** Raw wire capture deliberately does not synthesize document versions. */
export class Rpc extends EventEmitter {
  decoder = new Decoder(); pending = new Map(); history = []; nextId = 1; fatal = null;
  constructor(child, capture) {
    super(); this.child = child; this.capture = capture;
    child.stdout.on('data', chunk => {
      try { for (const message of this.decoder.feed(chunk)) this.receive(message); }
      catch (error) { this.fail(error); }
    });
    child.on('error', error => this.fail(error));
    child.on('close', code => this.fail(new Error(`LSP transport closed ${code}`)));
  }
  fail(error) {
    this.fatal = error;
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.pending.clear(); this.emit('failure', error);
  }
  write(message) {
    if (this.fatal) throw this.fatal;
    this.capture('out', message); this.child.stdin.write(encode(message));
  }
  notify(method, params) { this.write({jsonrpc:'2.0', method, params}); }
  request(method, params, timeout = 30000) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        try { this.notify('$/cancelRequest', {id}); } catch {}
        reject(new Error(`LSP request timeout ${method} id=${id}`));
      }, timeout);
      this.pending.set(id, {resolve, reject, timer});
      try { this.write({jsonrpc:'2.0', id, method, params}); }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }
  receive(message) {
    this.capture('in', message);
    const event = {sequence:this.history.length, receivedUTC:new Date().toISOString(), message};
    if (this.history.length >= 50000) throw new Error('LSP message count limit');
    this.history.push(event); this.emit('wire', event);
    if (message.method && message.id !== undefined) {
      // Never consent to edits/commands. JDT may request configuration/registration.
      let result = null;
      if (message.method === 'workspace/configuration') result = message.params.items.map(item => item.section ? item.section.split('.').reduce((value, key) => value?.[key], this.configuration) ?? null : this.configuration ?? {});
      else if (message.method === 'workspace/applyEdit') result = {applied:false, failureReason:'Spike is read-only toward original workspace'};
      this.write({jsonrpc:'2.0', id:message.id, result});
    } else if (message.id !== undefined) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timer); this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(JSON.stringify(message.error)));
      else pending.resolve(message.result);
    }
  }
  waitFor(predicate, afterSequence = 0, timeout = 60000) {
    const found = this.history.slice(afterSequence).find(predicate);
    if (found) return Promise.resolve(found);
    if (this.fatal) return Promise.reject(this.fatal);
    return new Promise((resolve,reject) => {
      const dispose = () => {clearTimeout(timer); this.off('wire', listener); this.off('failure', failed);};
      const listener = event => { if (event.sequence >= afterSequence && predicate(event)) { dispose(); resolve(event); } };
      const failed = error => {dispose(); reject(error);};
      const timer = setTimeout(() => {dispose(); reject(new Error('LSP observation timeout'));}, timeout);
      this.on('wire', listener); this.on('failure', failed);
    });
  }
}
