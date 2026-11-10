import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { ReportService, REPORT_SYSTEM_PROMPT, type FrozenFacts } from '../../src/server/ReportService';
import { LanguageFeatureRegistry } from '../../src/server/LanguageFeatureRegistry';

function facts(): FrozenFacts {
  return {
    aiConsent: true,
    session: { sessionId: 'session:test', projectId: 'project1', lifecycle: 'FINISHED', workspaceVersion: 7,
      controlEpoch: 5, writeOwner: 'STUDENT', coachMode: 'UNAVAILABLE', cooldownAfterVeto: false,
      presence: 'FOCUSED', aiStatus: 'OFF', activeFilePath: 'main.js', interventionId: null,
      lastServerSeq: 30, timer: { status: 'STOPPED', elapsedMs: 12345, limitMs: null, manualPaused: false,
        pauseOnHidden: false, serverTime: new Date().toISOString() } },
    snapshot: { snapshotId: 'snapshot1', projectId: 'project1', createdAt: new Date().toISOString(),
      label: 'final', workspaceVersion: 7, paths: ['main.js'] },
    runs: [], chat: [], events: [],
  };
}
async function until(predicate: () => boolean) {
  const deadline = Date.now() + 5000;
  while (!predicate()) { if (Date.now() > deadline) throw new Error('Condition timeout'); await new Promise(r => setTimeout(r, 5)); }
}
function fixture(t: any) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'paircoach-report-'));
  const services: ReportService[] = [];
  const events: any[] = [];
  const service = (generate?: (f: FrozenFacts, signal: AbortSignal) => Promise<string>) => {
    const s = new ReportService({ dataDir: root, emit: (type, payload) => events.push({ type, payload }), generate });
    services.push(s); return s;
  };
  t.after(() => { services.forEach(s => s.close()); rmSync(root, { recursive: true, force: true }); });
  const materialPath = () => path.join(root, 'reports', readdirSync(path.join(root, 'reports'))[0], 'facts.json');
  return { root, events, service, materialPath };
}

test('TEST-023 finish persists immutable facts before PENDING; later caller edits never change report material', async t => {
  const { service, materialPath } = fixture(t);
  let resolve!: (s: string) => void;
  let received: FrozenFacts | undefined;
  const s = service(async f => { received = f; return new Promise<string>(r => { resolve = r; }); });
  const f = facts();
  const pending = s.finish('COMPLETED', f);
  assert.equal(pending.status, 'PENDING');
  assert.ok(existsSync(materialPath()));
  const before = readFileSync(materialPath(), 'utf8');
  f.session.workspaceVersion = 99; f.events.push({ type: 'later workspace edit' });
  await until(() => !!received);
  assert.equal(received!.session.workspaceVersion, 7);
  assert.ok(Object.isFrozen(received)); assert.ok(Object.isFrozen(received!.session));
  assert.throws(() => { received!.session.workspaceVersion = 100; }, TypeError);
  resolve('## Fakty\nUtrwalono snapshot.\n## Ocena\nBrak wystarczających danych.');
  await until(() => s.get(f.session.sessionId).status !== 'PENDING');
  const report = s.get(f.session.sessionId);
  assert.equal(report.status, 'READY'); assert.equal(report.sourceWorkspaceVersion, 7);
  assert.equal(readFileSync(materialPath(), 'utf8'), before);
  report.markdown = 'mutation'; assert.notEqual(s.get(f.session.sessionId).markdown, 'mutation');
});

test('TEST-024 provider failure retains material, error redacts raw secret, retry reuses identical facts', async t => {
  const { service, materialPath } = fixture(t);
  let calls = 0;
  const received: string[] = [];
  const s = service(async f => { received.push(JSON.stringify(f)); if (++calls === 1) throw new Error('secret-api-token-fixture'); return 'Raport po ponowieniu.'; });
  const f = facts();
  s.finish('ABANDONED', f);
  await until(() => s.get(f.session.sessionId).status === 'FAILED');
  assert.doesNotMatch(JSON.stringify(s.get(f.session.sessionId)), /secret-api-token-fixture/);
  const before = readFileSync(materialPath(), 'utf8');
  assert.equal(s.retry(f.session.sessionId).status, 'PENDING');
  assert.equal(s.retry(f.session.sessionId).status, 'PENDING'); // no second concurrent generator
  await until(() => s.get(f.session.sessionId).status === 'READY');
  assert.equal(calls, 2); assert.equal(received[0], received[1]);
  assert.equal(readFileSync(materialPath(), 'utf8'), before);
});

test('TEST-023 no-key fallback is honest; no consent calls no external provider', async t => {
  const { service } = fixture(t);
  let calls = 0;
  const s = service(async () => { calls++; return 'should not be used'; });
  const f = facts(); f.aiConsent = false;
  s.finish('COMPLETED', f);
  await until(() => s.get(f.session.sessionId).status === 'READY');
  const markdown = s.get(f.session.sessionId).markdown!;
  assert.equal(calls, 0);
  assert.match(markdown, /lokalne fakty, bez oceny AI/);
  assert.match(markdown, /Brak zarejestrowanych uruchomień/);
  assert.ok(markdown.split(/\s+/u).length <= 800);
});

test('TEST-024 restart sees interrupted PENDING as FAILED; explicit retry can recover without mutable workspace', async t => {
  const { service, materialPath } = fixture(t);
  const f = facts();
  const s = service(() => new Promise(() => {}));
  s.finish('TIME_LIMIT_REVIEW', f);
  await new Promise(r => setImmediate(r));
  const before = readFileSync(materialPath(), 'utf8');
  // A second service models process restart, reading the durable PENDING not first instance memory.
  const recovered = service();
  assert.equal(recovered.get(f.session.sessionId).status, 'FAILED');
  assert.equal(recovered.get(f.session.sessionId).error?.code, 'REPORT_INTERRUPTED');
  s.close();
  assert.equal(recovered.retry(f.session.sessionId).status, 'PENDING');
  await until(() => recovered.get(f.session.sessionId).status === 'READY');
  assert.equal(readFileSync(materialPath(), 'utf8'), before);
});

test('Report close aborts a hanging provider; bad facts and oversized output do not become READY', async t => {
  const { service } = fixture(t);
  let signal: AbortSignal | undefined;
  const s = service(async (_, a) => { signal = a; return new Promise(() => {}); });
  const f = facts();
  const notFinal = structuredClone(f); notFinal.session.lifecycle = 'RUNNING';
  assert.throws(() => s.finish('COMPLETED', notFinal), /zatrzymaj Run/);
  s.finish('COMPLETED', f);
  await until(() => !!signal);
  s.close(); assert.equal(signal!.aborted, true);
  assert.equal(s.get(f.session.sessionId).status, 'FAILED');
  assert.throws(() => s.retry(f.session.sessionId), /zamknięta/);
  const oversized = facts(); oversized.session.sessionId = 'long-output';
  const other = service(async () => 'word '.repeat(801));
  other.finish('COMPLETED', oversized);
  await until(() => other.get('long-output').status !== 'PENDING');
  assert.equal(other.get('long-output').status, 'FAILED');
});

test('Immutable facts conflict and corrupted persisted material are rejected', async t => {
  const { service, materialPath } = fixture(t);
  const f = facts();
  const s = service(); s.finish('COMPLETED', f);
  await until(() => s.get(f.session.sessionId).status === 'READY');
  const changed = structuredClone(f); changed.chat.push({ messageId: 'new', author: 'STUDENT', text: 'late edit', createdAt: new Date().toISOString() });
  assert.throws(() => s.finish('COMPLETED', changed), /niezmienny/);
  const stored = JSON.parse(readFileSync(materialPath(), 'utf8'));
  stored.serialized += ' ';
  writeFileSync(materialPath(), JSON.stringify(stored));
  assert.throws(() => service().get(f.session.sessionId), /Integralność/);
});

test('Separate report system instruction is exact; optional plugins never pretend installation', () => {
  assert.equal(REPORT_SYSTEM_PROMPT, 'Podsumuj utrwaloną próbę według DATA-007. Oddziel fakty od oceny. Uwzględnij pomoc AI i granice dostępnych dowodów. Nie dopisuj nieprzeprowadzonych testów, diagnoz psychologicznych ani wyniku samodzielności bez danych. Maksymalnie 800 słów, jedna rekomendacja dalszej nauki.');
  const registry = new LanguageFeatureRegistry();
  assert.deepEqual(registry.getCapabilities(), { canRunMain: false, canRunTests: false, docs: 'NOT_INSTALLED', autocomplete: 'NOT_INSTALLED' });
});

test('TEST-024 real process crash leaves durable facts and interrupted PENDING recoverable', async t => {
  const { spawn } = await import('node:child_process');
  const { fileURLToPath } = await import('node:url');
  const { service, root, materialPath } = fixture(t);
  const source = fileURLToPath(new URL('../../src/server/ReportService.ts', import.meta.url));
  const f = facts();
  const childSource = `import {ReportService} from ${JSON.stringify(source)}; const s=new ReportService({dataDir:${JSON.stringify(root)},emit:()=>{},generate:()=>new Promise(()=>{})}); s.finish('COMPLETED',${JSON.stringify(f)}); console.log('PERSISTED'); setInterval(()=>{},1000);`;
  const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', childSource],
    { cwd: fileURLToPath(new URL('../../', import.meta.url)), stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '', error = '';
  child.stdout.on('data', d => { output += d.toString(); });
  child.stderr.on('data', d => { error += d.toString(); });
  t.after(() => child.kill('SIGKILL'));
  await until(() => { if (child.exitCode !== null) throw new Error('Crash fixture failed to start: ' + error); return output.includes('PERSISTED'); });
  const before = readFileSync(materialPath(), 'utf8');
  const closed = new Promise<void>(resolve => child.once('close', () => resolve()));
  child.kill('SIGKILL'); await closed;
  const restored = service();
  assert.equal(restored.get(f.session.sessionId).error?.code, 'REPORT_INTERRUPTED');
  restored.retry(f.session.sessionId);
  await until(() => restored.get(f.session.sessionId).status === 'READY');
  assert.equal(readFileSync(materialPath(), 'utf8'), before);
});
