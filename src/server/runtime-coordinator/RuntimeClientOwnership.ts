/** Durable authenticated client/project/session linkage. Never grants a current lease by itself. */
import path from 'node:path';
import fs from 'node:fs';
import { AppError } from '../errors';
import { canonical, privateDirectory, createRecord, readRecord, replaceRecord, sha256 } from './storage';
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
interface Binding { version: 1; projectId: string; clientId: string; sessions: string[] }
export class RuntimeClientOwnership {
  private readonly directory: string;
  constructor(directory: string, private readonly projectId: string) {
    this.directory = directory; privateDirectory(directory);
    if (fs.readdirSync(directory).length > 10000) throw Error('Client ownership budget exhausted');
  }
  private read(clientId: string): Binding | null {
    if (!ID.test(clientId)) throw Error('Invalid client identity');
    const bytes = readRecord(path.join(this.directory, sha256(clientId) + '.json'), 2*1024*1024, true);
    if (!bytes) return null;
    const record = JSON.parse(new TextDecoder('utf8', { fatal:true }).decode(bytes)), b = record.body as Binding;
    if (!b || b.version !== 1 || b.projectId !== this.projectId || b.clientId !== clientId ||
        !Array.isArray(b.sessions) || !b.sessions.length || b.sessions.length > 10000 ||
        !b.sessions.every(s => typeof s === 'string' && ID.test(s)) || new Set(b.sessions).size !== b.sessions.length ||
        record.sha256 !== sha256(canonical(b)) || Object.keys(b).sort().join(',') !== 'clientId,projectId,sessions,version')
      throw Error('Invalid durable client ownership');
    return b;
  }
  /** Called only after actual token/lease authentication. Same root kernel owner serializes writes. */
  bind(clientId: string, sessionId: string): void {
    if (!ID.test(sessionId)) throw Error('Invalid session identity');
    const previous = this.read(clientId);
    if (previous?.sessions.includes(sessionId)) return;
    if ((previous?.sessions.length ?? 0) >= 10000 || !previous && fs.readdirSync(this.directory).length >= 10000)
      throw Error('Client ownership budget exhausted; retain original requests');
    const body: Binding = {version:1,projectId:this.projectId,clientId,sessions:[...(previous?.sessions ?? []),sessionId]};
    const bytes = Buffer.from(canonical({body,sha256:sha256(canonical(body))}));
    const file = path.join(this.directory, sha256(clientId)+'.json');
    if (previous) replaceRecord(file,bytes); else createRecord(file,bytes);
  }
  assertBound(clientId: string, sessionId: string): void {
    if (!this.read(clientId)?.sessions.includes(sessionId))
      throw new AppError(403,'MUTATION_SCOPE_FORBIDDEN','Original mutation has no durable authenticated client binding in this project.');
  }
}
