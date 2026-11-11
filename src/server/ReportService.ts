import { createHash, randomUUID } from 'node:crypto';
import { closeSync, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync,
  realpathSync, renameSync, unlinkSync, writeFileSync, type BigIntStats } from 'node:fs';
import path from 'node:path';
import type { ChatEntry, Report, Run, Session, Snapshot } from '../shared/protocol';
import { AppError } from './errors';

export const REPORT_SYSTEM_PROMPT = 'Podsumuj utrwaloną próbę według DATA-007. Oddziel fakty od oceny. Uwzględnij pomoc AI i granice dostępnych dowodów. Nie dopisuj nieprzeprowadzonych testów, diagnoz psychologicznych ani wyniku samodzielności bez danych. Maksymalnie 800 słów, jedna rekomendacja dalszej nauki.';

export type FrozenFacts = {
  session: Session; snapshot: Snapshot; runs: Run[]; chat: ChatEntry[]; events: unknown[];
  [key: string]: unknown;
};
type Entry = { report: Report; facts: FrozenFacts; hash: string; generation?: symbol; abort?: AbortController };
const copy = <T>(v: T): T => structuredClone(v);
const hash = (s: string) => createHash('sha256').update(s).digest('hex');
function freeze<T>(v: T): T {
  if (v && typeof v === 'object') { Object.values(v).forEach(freeze); Object.freeze(v); }
  return v;
}
function id(value: string): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) throw new AppError(400, 'INVALID_ID', 'Niepoprawny identyfikator sesji.');
  // Protocol Id allows ':', but it must never become a Windows ADS path.
  return hash(value);
}

/** Synchronous persistence precedes PENDING; no generator ever reads live workspace files. */
export class ReportService {
  private directory: string;
  private entries = new Map<string, Entry>();
  private closed = false;
  constructor(private options: {
    dataDir: string; emit: (type: string, payload: unknown) => void;
    generate?: (facts: FrozenFacts, signal: AbortSignal) => Promise<string>;
  }) {
    mkdirSync(options.dataDir, { recursive: true, mode: 0o700 });
    this.directory = path.join(realpathSync(options.dataDir), 'reports');
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    if (lstatSync(this.directory).isSymbolicLink()) throw new AppError(403, 'UNSAFE_REPORT_STORAGE', 'Niedozwolony magazyn raportów.');
  }

  finish(reason: Report['reason'], facts: FrozenFacts): Report {
    this.assertOpen();
    if (!['COMPLETED', 'ABANDONED', 'TIME_LIMIT_REVIEW'].includes(reason) ||
        !facts?.session || !facts.snapshot || !Array.isArray(facts.runs) || !Array.isArray(facts.chat) || !Array.isArray(facts.events) ||
        facts.session.lifecycle !== 'FINISHED' || facts.session.projectId !== facts.snapshot.projectId ||
        facts.session.workspaceVersion !== facts.snapshot.workspaceVersion ||
        facts.runs.some(r => r.status === 'RUNNING' || r.status === 'QUEUED')) {
      throw new AppError(409, 'REPORT_FACTS_NOT_FINAL', 'Najpierw zatrzymaj Run i utrwal końcowy snapshot zamkniętej sesji.');
    }
    const sessionId = facts.session.sessionId;
    const dir = this.sessionDir(sessionId);
    let serialized: string;
    try { serialized = JSON.stringify(facts); }
    catch { throw new AppError(400, 'INVALID_REPORT_FACTS', 'Fakty muszą być danymi JSON.'); }
    const digest = hash(serialized);
    if (this.entries.has(sessionId) || existsSync(path.join(dir, 'report.json'))) {
      const entry = this.load(sessionId);
      if (entry.hash !== digest || entry.report.reason !== reason) throw new AppError(409, 'REPORT_FACTS_CONFLICT', 'Materiał zakończonej próby jest niezmienny.');
      return copy(entry.report);
    }
    const frozen = freeze(JSON.parse(serialized) as FrozenFacts);
    const report: Report = {
      reportId: randomUUID(), sessionId, status: 'PENDING', reason,
      sourceWorkspaceVersion: frozen.snapshot.workspaceVersion, snapshotId: frozen.snapshot.snapshotId,
      generatedAt: null, markdown: null,
      evidenceIds: [...new Set([frozen.snapshot.snapshotId, ...frozen.runs.map(r => r.runId), ...frozen.chat.map(c => c.messageId)])].slice(0, 1000),
      error: null,
    };
    // Exclusive creation: a crash/retry must not overwrite even an orphaned original facts file.
    const factsPath = path.join(dir, 'facts.json'), storedFacts = JSON.stringify({ sha256: digest, serialized });
    const ownedFacts = this.writeExclusive(factsPath, storedFacts);
    const entry: Entry = { report, facts: frozen, hash: digest };
    try { this.persist(entry); }
    catch (error) {
      // Only this unpublished attempt is ours to discard. A committed/ambiguous report wins.
      try {
        if (this.reportUncommitted(path.join(dir, 'report.json'))) this.removeOwnFile(factsPath, ownedFacts, storedFacts);
      } catch { /* Keep evidence on cleanup failure; never mask the original persistence error. */ }
      throw error;
    }
    this.entries.set(sessionId, entry);
    this.options.emit('SESSION_REPORT', copy(report));
    this.schedule(entry);
    return copy(report);
  }

  get(sessionId: string): Report { return copy(this.load(sessionId).report); }
  retry(sessionId: string): Report {
    this.assertOpen();
    const entry = this.load(sessionId);
    if (entry.report.status === 'PENDING') return copy(entry.report);
    if (entry.report.status !== 'FAILED') throw new AppError(409, 'REPORT_NOT_FAILED', 'Ponowienie dotyczy wyłącznie nieudanego raportu.');
    entry.report = { ...entry.report, status: 'PENDING', error: null, generatedAt: null, markdown: null };
    this.persist(entry);
    this.options.emit('SESSION_REPORT', copy(entry.report));
    this.schedule(entry);
    return copy(entry.report);
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const entry of this.entries.values()) {
      if (entry.report.status !== 'PENDING') continue;
      entry.generation = undefined;
      entry.abort?.abort();
      this.fail(entry, 'REPORT_INTERRUPTED', 'Generowanie przerwano. Fakty zachowano; możesz ponowić.');
    }
  }

  private assertOpen(): void {
    if (this.closed) throw new AppError(503, 'REPORT_SERVICE_CLOSED', 'Usługa raportowania została zamknięta.');
  }
  private sessionDir(sessionId: string): string {
    const dir = path.join(this.directory, id(sessionId));
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (lstatSync(dir).isSymbolicLink()) throw new AppError(403, 'UNSAFE_REPORT_STORAGE', 'Dowiązanie w magazynie raportów.');
    return dir;
  }
  private removeOwnFile(file: string, identity: BigIntStats, exactContent?: string): void {
    const current = lstatSync(file, { bigint: true });
    if (current.isFile() && current.dev === identity.dev && current.ino === identity.ino &&
        (exactContent === undefined || readFileSync(file, 'utf8') === exactContent)) unlinkSync(file);
  }
  private reportUncommitted(file: string): boolean {
    try { return lstatSync(file).isDirectory(); } // Leave the foreign obstruction itself untouched.
    catch (error) { return (error as NodeJS.ErrnoException).code === 'ENOENT'; }
  }
  private writeExclusive(file: string, content: string): BigIntStats {
    // A failed open (especially EEXIST) gives us no ownership and must never run cleanup.
    const fd = openSync(file, 'wx', 0o600);
    let identity: BigIntStats | undefined;
    let failure: { error: unknown } | undefined;
    try {
      // Exact dev/ino, including Windows values above 2^53, captured before write/fsync can fail.
      identity = fstatSync(fd, { bigint: true });
      writeFileSync(fd, content, 'utf8'); fsyncSync(fd);
    } catch (error) { failure = { error }; }
    try { closeSync(fd); } catch (error) { failure ??= { error }; }
    if (failure) {
      try { if (identity) this.removeOwnFile(file, identity); }
      catch { /* An ambiguous/replaced file or failed cleanup is retained, not silently adopted. */ }
      throw failure.error;
    }
    return identity!;
  }
  private persist(entry: Entry): void {
    const dir = this.sessionDir(entry.report.sessionId);
    const temporary = path.join(dir, `${randomUUID()}.tmp`);
    const serialized = JSON.stringify(entry.report);
    // writeExclusive owns cleanup on write failure; a failed wx grants no ownership.
    const ownedTemporary = this.writeExclusive(temporary, serialized);
    try { renameSync(temporary, path.join(dir, 'report.json')); }
    catch (error) {
      try { this.removeOwnFile(temporary, ownedTemporary, serialized); }
      catch { /* Keep evidence on cleanup failure; preserve the original commit error. */ }
      throw error;
    }
  }
  private load(sessionId: string): Entry {
    if (this.entries.has(sessionId)) return this.entries.get(sessionId)!;
    const dir = this.sessionDir(sessionId);
    if (!existsSync(path.join(dir, 'report.json'))) throw new AppError(404, 'REPORT_NOT_FOUND', 'Nie znaleziono raportu sesji.');
    const factsPath = path.join(dir, 'facts.json'), reportPath = path.join(dir, 'report.json');
    if ([factsPath, reportPath].some(f => lstatSync(f).isSymbolicLink())) throw new AppError(403, 'UNSAFE_REPORT_STORAGE', 'Dowiązanie w magazynie raportów.');
    const stored = JSON.parse(readFileSync(factsPath, 'utf8'));
    if (typeof stored.serialized !== 'string' || hash(stored.serialized) !== stored.sha256) throw new AppError(500, 'REPORT_FACTS_CORRUPTED', 'Integralność materiału raportu jest niepoprawna.');
    const facts = freeze(JSON.parse(stored.serialized) as FrozenFacts);
    const report = JSON.parse(readFileSync(reportPath, 'utf8')) as Report;
    if (report.sessionId !== sessionId || facts.session.sessionId !== sessionId || report.snapshotId !== facts.snapshot.snapshotId ||
        report.sourceWorkspaceVersion !== facts.snapshot.workspaceVersion) throw new AppError(500, 'REPORT_FACTS_CORRUPTED', 'Metadane nie odpowiadają materiałowi raportu.');
    const entry: Entry = { facts, report, hash: stored.sha256 };
    this.entries.set(sessionId, entry);
    if (report.status === 'PENDING') this.fail(entry, 'REPORT_INTERRUPTED', 'Przerwano poprzednią próbę generowania. Fakty zachowano; wybierz Ponów.');
    return entry;
  }
  private schedule(entry: Entry): void {
    const generation = Symbol('report generation');
    const abort = new AbortController();
    entry.generation = generation; entry.abort = abort;
    queueMicrotask(() => {
      if (this.closed || entry.generation !== generation) return;
      void this.generate(entry, generation, abort);
    });
  }
  private async generate(entry: Entry, generation: symbol, abort: AbortController): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    try {
      const cancelled = new Promise<never>((_, reject) => {
        onAbort = () => reject(new Error('REPORT_INTERRUPTED'));
        abort.signal.addEventListener('abort', onAbort, { once: true });
      });
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => { abort.abort(); reject(new Error('REPORT_GENERATION_TIMEOUT')); }, 30000);
      });
      // Consent is captured in frozen facts, never re-read from mutable project settings.
      // The injected provider must apply REPORT_SYSTEM_PROMPT and context/secret filtering.
      const generationWork = this.options.generate && entry.facts.aiConsent === true
        ? this.options.generate(entry.facts, abort.signal)
        : Promise.resolve(this.localReport(entry));
      const markdown = await Promise.race([generationWork, timeout, cancelled]);
      if (this.closed || entry.generation !== generation) return;
      if (typeof markdown !== 'string' || !markdown.trim() || markdown.length > 16000 || markdown.trim().split(/\s+/u).length > 800) {
        throw new Error('INVALID_REPORT_OUTPUT');
      }
      entry.report = { ...entry.report, status: 'READY', generatedAt: new Date().toISOString(), markdown, error: null };
      this.persist(entry);
      this.options.emit('SESSION_REPORT', copy(entry.report));
    } catch {
      if (!this.closed && entry.generation === generation) {
        try { this.fail(entry, 'REPORT_GENERATION_FAILED',
          'Nie udało się wygenerować raportu (błąd providera, limit czasu lub formatu). Fakty zachowano; wybierz Ponów.'); }
        catch {
          // Disk may become unavailable after facts were committed. Never leak a raw fs/provider error.
          entry.report.error = { code: 'REPORT_PERSIST_FAILED', message: 'Nie zapisano stanu raportu. Niezmienne fakty zachowano; sprawdź magazyn danych.', retryable: true, requestId: null, currentVersion: null };
          this.options.emit('SESSION_REPORT', copy(entry.report));
        }
      }
    } finally {
      clearTimeout(timer);
      if (onAbort) abort.signal.removeEventListener('abort', onAbort);
      if (entry.generation === generation) { entry.generation = undefined; entry.abort = undefined; }
    }
  }
  private fail(entry: Entry, code: string, message: string): void {
    entry.report = { ...entry.report, status: 'FAILED', generatedAt: null, markdown: null,
      error: { code, message, retryable: true, requestId: null, currentVersion: null } };
    this.persist(entry);
    this.options.emit('SESSION_REPORT', copy(entry.report));
  }
  private localReport(entry: Entry): string {
    const f = entry.facts;
    const events = f.events as { type?: string; payload?: { path?: string; interventionId?: string } }[];
    const steps = events.filter(e => e?.type === 'COACH_STEP_EDIT');
    const interventions = new Set(steps.map(e => e.payload?.interventionId).filter(Boolean));
    const vetoes = events.filter(e => e?.type === 'VETO_EXECUTED'); // request receipt alone is not an executed cutoff
    const lines = [
      '# Podsumowanie próby — lokalne fakty, bez oceny AI',
      '', '## Fakty',
      `Powód zakończenia: ${{COMPLETED:'ukończono zadanie',ABANDONED:'przerwano zadanie',TIME_LIMIT_REVIEW:'przegląd po upływie czasu'}[entry.report.reason]}.`,
      `Zachowano końcowy stan kodu (wersja ${f.snapshot.workspaceVersion}).`,
      `Czas sesji: ${Math.floor(f.session.timer.elapsedMs / 60000)} min ${Math.floor(f.session.timer.elapsedMs / 1000) % 60} s.`,
      `Zarejestrowane interwencje AI: ${interventions.size}; kroki AI: ${steps.length}; zdarzenia weta: ${vetoes.length}.`,
      'Te liczby opisują wyłącznie dostarczony dziennik; brak zdarzeń nie dowodzi samodzielności.',
      ...f.runs.slice(0, 30).map((r, i) => `- Uruchomienie ${i + 1} (${r.mode === 'RUN_TESTS' ? 'testy' : 'program'}): ${r.testOutcome === 'PASSED' ? 'testy zaliczone' : r.testOutcome === 'FAILED' ? 'testy niezaliczone' : r.status === 'SUCCEEDED' ? 'wykonano' : r.status}; liczba testów: ${r.testCount ?? 'nie dotyczy'}${r.workspaceChangedDuringRun ? '; kod zmieniono podczas wykonania' : ''}.`),
      ...(f.runs.length ? [] : ['Brak zarejestrowanych uruchomień — nie przeprowadzono dowodu zaliczenia testów.']),
      ...(steps.length ? [`Fragmenty przypisane AI w utrwalonych krokach: ${[...new Set(steps.map(e => e.payload?.path).filter(Boolean))].slice(0, 20).join(', ')}. Nie przypisujemy ich uczniowi.`] : []),
      '', '## Ocena i granice dowodów',
      f.aiConsent !== true ? 'Raport AI wyłączony: w tej próbie nie zapisano zgody na jego generowanie. To lokalne zestawienie faktów.' : 'Raport AI niedostępny: nie skonfigurowano dostawcy do generowania raportów. To lokalne zestawienie faktów.',
      'Nie oceniono kompletności review, złożoności, cech psychologicznych ani samodzielności. Zielony wynik dotyczy tylko wskazanego Run i nie kończył sesji automatycznie.',
      '', '## Jedna rekomendacja',
      'Powtórz samodzielnie najmniejszy fragment ćwiczenia wymagający pomocy, a następnie zweryfikuj go jawnym uruchomieniem.',
    ];
    // Keep fallback bounded even if facts contain many runs. Full facts remain on disk.
    return lines.join('\n').split(/\s+/u).length <= 800 ? lines.join('\n') :
      lines.filter(l => !l.startsWith('- Run ')).join('\n') + '\nSzczegółowe wyniki Run zachowano w niezmiennych faktach sesji.';
  }
}
