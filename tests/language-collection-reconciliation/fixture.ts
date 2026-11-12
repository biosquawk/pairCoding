import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, fsyncSync, fstatSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { DiskLanguageProcessJournal, assertRealDirectory, intentHash, sha256,
  type LanguageProcessIntent, type LanguageProcessCollection, type CollectedFile } from '../../src/server/language/LanguageProcessJournal';
import { DockerLanguageProcess, LanguageProcessAdmission } from '../../src/server/language/DockerLanguageProcess';
import { NodeLanguageJournalDurability } from '../../src/server/language/LanguageJournalDurability';
import type { LanguageJournalDurability } from '../../src/server/language/LanguageJournalDurability';
interface ShapeEntry { path: string; type: 'directory' | 'file'; bytes: number; base64?: string; magic: string; sha256: string }
interface ActualShape { entries: ShapeEntry[]; stateLog: { base64: string; sha256: string; bytes: number } }
interface PolicyEntry { path: string; type: 'directory' | 'file'; bytes: number; selection?: string; reason?: string }
interface Policy { entries: PolicyEntry[]; selected: CollectedFile[]; completeness: string; version: string; intentSha256: string }
export const shape: ActualShape = JSON.parse(readFileSync(new URL('./actual-shape.json', import.meta.url), 'utf8'));
export const logs = { stdout: 'genuine UNIT stdout\n', stderr: 'genuine UNIT stderr\n', truncated: true };
export const policyPath = 'collection-policy.json';
export const artifactName = (p: string) => p === 'stdout.log' || p === 'stderr.log' ? p : `artifact-${sha256(p)}`;
export const deep = 'jdt-config/org.eclipse.osgi/66/0/.cp/jars';
export function fixture(t: TestContext, actual = true, provider: 'jdt' | 'pylsp' = 'jdt') {
  const root = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'real-collection-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const ownedRoot = join(root, 'owned'), receipts = join(root, 'receipts'), launchId = randomUUID();
  mkdirSync(ownedRoot); mkdirSync(receipts); const launch = join(ownedRoot, launchId); mkdirSync(launch);
  for (const n of ['boot', 'state', 'workspace']) mkdirSync(join(launch, n));
  const boot = join(launch, 'boot'), state = join(launch, 'state');
  if (actual) {
    for (const e of shape.entries) {
      const path = join(boot, e.path);
      if (e.type === 'directory') mkdirSync(path, { recursive: true });
      else {
        const bytes = e.base64 !== undefined ? Buffer.from(e.base64, 'base64') : Buffer.alloc(e.bytes);
        if (e.base64 === undefined) Buffer.from(e.magic, 'hex').copy(bytes);
        else assert.equal(sha256(bytes), e.sha256);
        assert.equal(bytes.length, e.bytes); writeFileSync(path, bytes);
      }
    }
    mkdirSync(join(state, '.metadata'));
    const bytes = Buffer.from(shape.stateLog.base64, 'base64'); assert.equal(sha256(bytes), shape.stateLog.sha256);
    writeFileSync(join(state, '.metadata', '.log'), bytes);
  }
  let filesFlushed = 0, dirsFlushed = 0;
  const real = new NodeLanguageJournalDurability(assertRealDirectory);
  let hook: ((kind: 'file' | 'directory', path?: string) => void) | undefined;
  const durability: LanguageJournalDurability = { policy: real.policy,
    file: fd => { assert.ok(fstatSync(fd).isFile()); fsyncSync(fd); filesFlushed++; hook?.('file'); },
    directory: p => { real.directory(p); dirsFlushed++; hook?.('directory', p); } };
  const journal = new DiskLanguageProcessJournal(receipts, durability);
  // No driver method can run while constructing a trusted intent; no actual Docker exists in this fixture.
  const driver = { engineId: async () => { throw new Error('not a Docker operation'); },
    inspect: async () => { throw new Error('not a Docker operation'); }, command: async () => { throw new Error('not a Docker operation'); },
    attach: () => { throw new Error('not a Docker operation'); } };
  const options = { ownedRoot, journal, driver, admission: new LanguageProcessAdmission() };
  const intent = DockerLanguageProcess.prepare({ launchId, installationId: 'UNIT-installation', engineId: 'UNIT-engine', projectId: 'project', sessionId: 'session',
    profileId: 'java21', providerGeneration: 'provider', configurationGeneration: 'config', shadowGeneration: 'shadow', connectionGeneration: 'connection',
    phase: 'completion', provider, imageId: `sha256:${'a'.repeat(64)}`, argv: ['/opt/jdk27/bin/java', '-version'] }, options).intent as LanguageProcessIntent;
  journal.putIntent(intent);
  const artifact = (path: string) => join(receipts, launchId, artifactName(path));
  const receipt = (collection: LanguageProcessCollection) => ({ schemaVersion: 1 as const, intentSha256: intentHash(intent), containerId: 'b'.repeat(64), exitCode: 137,
    stoppedUTC: '2026-11-12T04:00:00Z', collection });
  return { root, ownedRoot, boot, state, receipts, launchId, intent, journal, options, artifact, receipt,
    hooks: (h?: typeof hook) => { hook = h; }, flushed: () => ({ files: filesFlushed, directories: dirsFlushed }),
    write: (p: string, data: string | Buffer) => { const path = join(boot, p); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, data); } };
}
export function policy(f: ReturnType<typeof fixture>): Policy { return JSON.parse(readFileSync(f.artifact(policyPath), 'utf8')); }
