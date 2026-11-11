import type { ExecutionView, ProjectV2, RunKind, RunProfileV2, RunRequestV2, RunV2, SettingsV2, TaskEntry, TaskField, TaskFieldKey, UpdateSettingsRequestV2 } from '../shared/runtime-v2';
import { TASK_FIELD_KEYS } from '../shared/runtime-v2';
import { validateExecutionView, validateLanguageView, validateRunRequestV2, validateRunV2, validateSettingsV2, validateUpdateSettingsRequestV2, validateV2WireShape } from '../shared/validation-v2';

export interface RuntimeAuthorityV2 {
  projectId: string; sessionId: string; clientId: string; connectionGeneration: string;
  workspaceVersion: number; configurationGeneration: string; connected: boolean; canExecute: boolean; canSaveSettings: boolean;
}
export interface RuntimeClientV2Dependencies {
  current(): Readonly<RuntimeAuthorityV2> | null;
  requestId(): string;
  /** Existing authenticated HTTP caller wrappers. No alternate persistence/socket/host fallback. */
  http: {
    run(body: RunRequestV2, signal: AbortSignal): Promise<unknown>;
    stop(runId: string, body: { requestId: string; clientId: string; sessionId: string }, signal: AbortSignal): Promise<unknown>;
    saveSettings(body: UpdateSettingsRequestV2, signal: AbortSignal): Promise<unknown>; // returns ProjectV2
  };
}
/** Local authority contract, NOT a new wire DTO. The read wrapper must reconcile this exact
 * mutation to a definitive outcome on the authenticated server before returning its snapshot.
 * A cached Project/readiness event or a read while that request may still commit is insufficient. */
export interface RuntimeUnconfirmedMutationV2 {
  kind: 'RUN' | 'SAVE'; requestId: string; projectId: string; sessionId: string; clientId: string; expectedWorkspaceVersion: number;
}
export interface RuntimeClientV2State {
  project: ProjectV2 | null; execution: ExecutionView | null; run: RunV2 | null; pending: 'RUN' | 'STOP' | 'SAVE' | null; error: string | null; reconciliationRequired: boolean;
}
export type SettingsSaveResultV2 = { ok: true; project: ProjectV2 } | { ok: false; message: string };
const clone = <T,>(v: T): T => structuredClone(v);
const equal = (a: unknown, b: unknown): boolean => {
  if (a === b) return true;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every(k => Object.hasOwn(b, k) && equal((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
};
const busyRun = (run: RunV2 | null) => run && ['QUEUED','RUNNING','STOPPING','PROCESS_STOP_UNCONFIRMED'].includes(run.status);
function validProject(value: unknown): value is ProjectV2 {
  if (!validateV2WireShape('Project', value)) return false;
  const project = value as ProjectV2;
  return validateSettingsV2(project.settings) && validateExecutionView(project.capabilities.execution) && validateLanguageView(project.capabilities.language) && project.capabilities.language.projectId === project.projectId &&
    project.capabilities.language.configurationGeneration === project.capabilities.execution.runtime.configurationGeneration &&
    (project.capabilities.execution.runtime.profileId === null || project.capabilities.language.profileId === project.capabilities.execution.runtime.profileId);
}
export class RuntimeClientV2 {
  private state: RuntimeClientV2State = { project: null, execution: null, run: null, pending: null, error: null, reconciliationRequired: false };
  private listeners = new Set<() => void>();
  private operation: AbortController | null = null;
  private revision = 0;
  private disposed = false;
  private bound: RuntimeAuthorityV2 | null = null;
  // Reconnect/invalidate is not evidence that a dispatched mutation did not happen.
  private unresolved = new Map<string, { mutation: RuntimeUnconfirmedMutationV2; inFlight: boolean }>();
  private scope(a: Pick<RuntimeAuthorityV2, 'projectId' | 'sessionId'>): string { return JSON.stringify([a.projectId, a.sessionId]); }
  private requiresReconciliation(): boolean {
    const a = this.dependencies.current();
    return !!a && this.unresolved.has(this.scope(a));
  }
  constructor(private readonly dependencies: RuntimeClientV2Dependencies) {}
  snapshot(): RuntimeClientV2State { return { ...clone(this.state), reconciliationRequired: this.requiresReconciliation() }; }
  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  private publish() { for (const listener of this.listeners) listener(); }
  /** Admission for legacy/mixed/unknown raw settings: read-only readiness is still available.
   * The caller supplies the authenticated project's shared ExecutionView, not guessed V2 settings.
   * Run stays disabled until a real V2 project arrives; explicit human migration uses saveSettings. */
  applyExecution(value: unknown): boolean {
    const a = this.dependencies.current();
    if (this.disposed || busyRun(this.state.run) || !a || !validateExecutionView(value) || value.runtime.configurationGeneration !== a.configurationGeneration) return false;
    this.bound = clone(a); this.revision++;
    this.state = { ...this.state, project: null, execution: clone(value), run: null, error: null };
    this.publish(); return true;
  }
  /** From the existing authoritative snapshot/event dispatcher, never unversioned completion replies. */
  applyProject(value: unknown, run: unknown = null): boolean {
    const a = this.dependencies.current();
    if (this.disposed || !a || !validProject(value) || value.projectId !== a.projectId || value.sessionId !== a.sessionId ||
      value.workspaceVersion !== a.workspaceVersion || value.capabilities.execution.runtime.configurationGeneration !== a.configurationGeneration ||
      (run !== null && (!validateRunV2(run) || run.configurationGeneration !== a.configurationGeneration || run.profileId !== value.capabilities.execution.runtime.profileId || run.workspaceVersionAtStart > value.workspaceVersion))) return false;
    this.revision++;
    this.bound = clone(a);
    this.state = { ...this.state, project: clone(value), execution: clone(value.capabilities.execution), run: clone(run as RunV2 | null), error: null }; this.publish(); return true;
  }
  invalidate(): void {
    this.operation?.abort(); this.operation = null; this.bound = null; this.revision++;
    this.state = { project: null, execution: null, run: null, pending: null, error: null, reconciliationRequired: false }; this.publish();
  }
  private authority(): RuntimeAuthorityV2 {
    const a = this.dependencies.current(), bound = this.bound;
    if (this.disposed || !a?.connected || !bound || !this.state.execution ||
      (['projectId','sessionId','clientId','connectionGeneration','workspaceVersion','configurationGeneration'] as const).some(k => a[k] !== bound[k]) ||
      a.configurationGeneration !== this.state.execution.runtime.configurationGeneration)
      throw new Error('Sesja nieaktualna lub offline. Odśwież połączenie; edycja ręczna pozostaje dostępna.');
    return clone(a);
  }
  /** Starts a NEW, authenticated authoritative read AFTER the mutation has settled locally.
   * The wrapper receives the exact request identity and must establish its definitive server
   * outcome (including no later commit) before returning ProjectV2 + current RunV2|null.
   * Never wrap a pre-existing Promise, cached snapshot, readiness or receipt-presence check.
   * No retry, fabricated Run/ABORTED, or caller-provided boolean can clear this fence.
   * When such a backend read is unavailable, keep the fence; ordinary editor use is unaffected. */
  async reconcile(read: (mutation: Readonly<RuntimeUnconfirmedMutationV2>, signal: AbortSignal) => Promise<{ project: unknown; run: unknown }>): Promise<boolean> {
    const a = this.dependencies.current();
    if (this.disposed || this.operation || !a?.connected) return false;
    const authority = clone(a), key = this.scope(a), unresolved = this.unresolved.get(key);
    if (!unresolved || unresolved.inFlight) return false;
    const operation = new AbortController(), revision = this.revision;
    this.operation = operation;
    try {
      const value = await read(clone(unresolved.mutation), operation.signal), current = this.dependencies.current();
      if (this.disposed || operation.signal.aborted || this.operation !== operation || revision !== this.revision ||
        this.unresolved.get(key) !== unresolved || !current?.connected ||
        (['projectId','sessionId','clientId','connectionGeneration'] as const).some(k => authority[k] !== current[k]) ||
        !value || !Object.hasOwn(value, 'run') || value.run === undefined || !this.applyProject(value.project, value.run))
        throw new Error('Odczyt nie rozstrzygnął niepotwierdzonej operacji. Zachowano blokadę ponowienia i formularz.');
      this.unresolved.delete(key); this.state.error = null;
      return true;
    } catch (error) {
      if (this.operation === operation) this.state.error = error instanceof Error ? error.message : 'Nie potwierdzono odczytu stanu operacji.';
      return false;
    } finally {
      if (this.operation === operation) this.operation = null;
      this.publish();
    }
  }
  private async perform<T>(kind: RuntimeClientV2State['pending'], action: (a: RuntimeAuthorityV2, signal: AbortSignal, dispatched: (requestId: string) => void) => Promise<T>,
    accept: (value: T, a: RuntimeAuthorityV2) => void): Promise<boolean> {
    if (this.operation || this.disposed) return false;
    if (kind !== 'STOP' && this.requiresReconciliation()) {
      this.state.error = 'Wynik poprzedniej operacji jest nieznany. Wymagany autoryzowany odczyt jej rozstrzygnięcia przed nowym Run lub zapisem. Zachowano formularz; edycja ręczna pozostaje dostępna.';
      this.publish(); return false;
    }
    const operation = new AbortController(); this.operation = operation;
    const revision = this.revision;
    const dispatch: { sent?: { key: string; entry: { mutation: RuntimeUnconfirmedMutationV2; inFlight: boolean } } } = {};
    try {
      const a = this.authority(); this.state.pending = kind; this.state.error = null; this.publish();
      const value = await action(a, operation.signal, requestId => {
        if (kind !== 'RUN' && kind !== 'SAVE') return;
        const key = this.scope(a), entry = { mutation: { kind, requestId, projectId: a.projectId, sessionId: a.sessionId, clientId: a.clientId, expectedWorkspaceVersion: a.workspaceVersion }, inFlight: true };
        this.unresolved.set(key, entry); dispatch.sent = { key, entry };
      }), current = this.dependencies.current();
      if (operation.signal.aborted || this.operation !== operation || revision !== this.revision || !current ||
        Object.keys(a).some(key => a[key as keyof RuntimeAuthorityV2] !== current[key as keyof RuntimeAuthorityV2]))
        throw new Error('Odpowiedź dotyczy nieaktualnej sesji lub wersji. Odśwież stan; zachowano wpisane ustawienia.');
      accept(value, a);
      if (dispatch.sent && this.unresolved.get(dispatch.sent.key) === dispatch.sent.entry) this.unresolved.delete(dispatch.sent.key);
      return true;
    } catch (error) {
      if (this.operation === operation) this.state.error = error instanceof Error ? error.message : 'Operacja niepotwierdzona. Odśwież stan przed ponowieniem.';
      return false;
    } finally {
      if (dispatch.sent) dispatch.sent.entry.inFlight = false;
      if (this.operation === operation) { this.operation = null; this.state.pending = null; }
      this.publish();
    }
  }
  async run(mode: RunKind): Promise<boolean> {
    return this.perform('RUN', async (a, signal, dispatched) => {
      const project = this.state.project;
      if (!project) throw new Error('LEGACY_RUN_PROFILE_REQUIRES_MIGRATION. Przygotuj i zapisz jawne ustawienia V2; ręczna edycja pozostaje dostępna.');
      const readiness = project.capabilities.execution.modes[mode];
      if (!a.canExecute || !readiness?.canRun || !project.settings.runProfiles.some(p => p.kind === mode) || busyRun(this.state.run))
        throw new Error(readiness?.problem ? `${readiness.problem.message} ${readiness.problem.recovery}` : 'Uruchomienie niedostępne. Sprawdź ustawienia i stan bieżącego wykonania.');
      const body = { requestId: this.dependencies.requestId(), clientId: a.clientId, sessionId: a.sessionId,
        expectedWorkspaceVersion: a.workspaceVersion, mode, configurationGeneration: a.configurationGeneration };
      if (!validateRunRequestV2(body)) throw new Error('Niepoprawne żądanie wykonania.');
      dispatched(body.requestId);
      return this.dependencies.http.run(body, signal);
    }, (value, a) => {
      if (!validateRunV2(value) || value.mode !== mode || value.configurationGeneration !== a.configurationGeneration ||
        value.profileId !== this.state.project!.capabilities.execution.runtime.profileId || value.workspaceVersionAtStart !== a.workspaceVersion)
        throw new Error('Odrzucono niezgodną odpowiedź wykonania. Odśwież stan przed ponowieniem.');
      this.state.run = clone(value);
    });
  }
  async stop(): Promise<boolean> {
    const run = this.state.run && clone(this.state.run);
    return this.perform('STOP', async (a, signal) => {
      if (!a.canExecute || !busyRun(run)) throw new Error('Brak aktywnego wykonania do zatrzymania.');
      return this.dependencies.http.stop(run!.runId, { requestId: this.dependencies.requestId(), clientId: a.clientId, sessionId: a.sessionId }, signal);
    }, (value, a) => {
      if (!validateRunV2(value) || value.runId !== run!.runId || value.profileId !== run!.profileId || value.configurationGeneration !== run!.configurationGeneration)
        throw new Error('Nie potwierdzono zatrzymania tego wykonania. Odśwież stan i ponów Stop dla tego samego runId.');
      this.state.run = clone(value);
    });
  }
  async saveSettings(settings: SettingsV2, expectedWorkspaceVersion: number): Promise<SettingsSaveResultV2> {
    const captured = clone(settings); let saved: ProjectV2 | null = null;
    const ok = await this.perform('SAVE', async (a, signal, dispatched) => {
      if (!a.canSaveSettings || a.workspaceVersion !== expectedWorkspaceVersion) throw new Error('Konflikt wersji ustawień. Zachowano formularz; odczytaj nową wersję przed ponownym zapisem.');
      const body = { requestId: this.dependencies.requestId(), clientId: a.clientId, sessionId: a.sessionId, expectedWorkspaceVersion, settings: captured };
      if (!validateUpdateSettingsRequestV2(body)) throw new Error('Niepoprawne ustawienia V2.');
      dispatched(body.requestId);
      return this.dependencies.http.saveSettings(body, signal);
    }, (value, a) => {
      if (!validProject(value) || value.projectId !== a.projectId || value.sessionId !== a.sessionId || value.workspaceVersion <= expectedWorkspaceVersion ||
        !equal(value.settings, captured))
        throw new Error('Serwer nie potwierdził zapisu tych ustawień. Zachowano formularz; odśwież stan przed ponowieniem.');
      saved = clone(value); this.state.project = clone(value); this.state.execution = clone(value.capabilities.execution);
      this.bound = { ...a, workspaceVersion: value.workspaceVersion, configurationGeneration: value.capabilities.execution.runtime.configurationGeneration }; this.revision++;
    });
    return ok && saved ? { ok: true, project: saved } : { ok: false, message: this.state.error ?? 'Operacja zajęta lub anulowana. Zachowano formularz.' };
  }
  dispose(): void { this.invalidate(); this.disposed = true; this.listeners.clear(); }
}
export type { ExecutionView };

export type RuntimeSettingsRawModeV2 = { enabled: boolean; fields: Partial<Record<TaskFieldKey, string>> };
export type RuntimeSettingsDraftV2 = Record<RunKind, RuntimeSettingsRawModeV2>;
export function runtimeRawProfileV2(p?: RunProfileV2): RuntimeSettingsRawModeV2 {
  if (!p) return { enabled: false, fields: {} };
  const e = p.task.entry;
  return { enabled: true, fields: {
    workingDirectory: p.task.workingDirectory, 'entry.kind': e.kind,
    'entry.path': 'path' in e ? e.path : '', 'entry.name': 'name' in e ? e.name : '',
    'entry.className': 'className' in e ? e.className : '', 'entry.containerPort': 'containerPort' in e ? String(e.containerPort) : '',
    'entry.healthPath': 'healthPath' in e ? e.healthPath : '',
    'tests.paths': p.task.tests.paths.join('\n'), 'tests.names': p.task.tests.names.join('\n'), timeoutMs: String(p.timeoutMs),
  } };
}
export function createRuntimeSettingsDraftV2(s: SettingsV2): RuntimeSettingsDraftV2 {
  return { RUN_MAIN: runtimeRawProfileV2(s.runProfiles.find(p => p.kind === 'RUN_MAIN')), RUN_TESTS: runtimeRawProfileV2(s.runProfiles.find(p => p.kind === 'RUN_TESTS')) };
}
export function isRuntimeTaskFieldVisibleV2(key: TaskFieldKey, kind: string): boolean {
  if (!key.startsWith('entry.') || key === 'entry.kind') return true;
  return ({ SCRIPT: ['entry.path'], MODULE: ['entry.name'], JAVA_MAIN: ['entry.className'], SPRING_BOOT: ['entry.containerPort','entry.healthPath'], TESTS: [] }[kind] ?? []).includes(key);
}
/** Exact-key dispatch only: never follow arbitrary dotted paths/prototypes. Final shared guard is authoritative. */
export function buildRuntimeSettingsV2(base: SettingsV2, draft: RuntimeSettingsDraftV2, fields: readonly TaskField[]): SettingsV2 {
  if (!validateSettingsV2(base)) throw new Error('Brak poprawnej bazy ustawień V2.');
  const allowed = new Set(fields.map(f => f.key));
  if (fields.some(f => !TASK_FIELD_KEYS.includes(f.key))) throw new Error('Nieznane pole konfiguracji.');
  const runProfiles: RunProfileV2[] = [];
  for (const mode of ['RUN_MAIN','RUN_TESTS'] as const) {
    const d = draft[mode]; if (!d.enabled) continue;
    const previous = base.runProfiles.find(p => p.kind === mode), f = d.fields;
    // Unadvertised existing data is preserved, never fabricated or edited through hidden keys.
    const old = runtimeRawProfileV2(previous).fields;
    for (const key of Object.keys(f) as TaskFieldKey[]) if (!allowed.has(key) && f[key] !== old[key]) throw new Error(`Pole ${key} nie jest udostępnione przez profil.`);
    for (const field of fields) {
      if (!isRuntimeTaskFieldVisibleV2(field.key, f['entry.kind'] ?? '')) continue;
      const value = f[field.key] ?? '';
      if (field.required && !value.trim()) throw new Error(`Uzupełnij: ${field.label}.`);
      if (value && field.input === 'CHOICE' && !field.choices.some(c => c.value === value)) throw new Error(`Wybierz dozwoloną wartość: ${field.label}.`);
      if (value && field.input === 'INTEGER' && (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < field.min! || Number(value) > field.max!)) throw new Error(`Sprawdź zakres: ${field.label}.`);
    }
    let entry: TaskEntry;
    switch (f['entry.kind']) {
      case 'SCRIPT': entry = { kind: 'SCRIPT', path: f['entry.path'] ?? '' }; break;
      case 'MODULE': entry = { kind: 'MODULE', name: f['entry.name'] ?? '' }; break;
      case 'JAVA_MAIN': entry = { kind: 'JAVA_MAIN', className: f['entry.className'] ?? '' }; break;
      case 'SPRING_BOOT': entry = { kind: 'SPRING_BOOT', containerPort: Number(f['entry.containerPort']), healthPath: f['entry.healthPath'] ?? '' }; break;
      case 'TESTS': entry = { kind: 'TESTS' }; break;
      default: throw new Error('Wybierz typ wejścia udostępniony przez profil.');
    }
    const lines = (value = '') => value.split('\n').map(v => v.trim()).filter(Boolean);
    runProfiles.push({ kind: mode, timeoutMs: Number(f.timeoutMs), task: { workingDirectory: f.workingDirectory ?? '', entry,
      tests: { paths: lines(f['tests.paths']), names: lines(f['tests.names']) } } });
  }
  const settings = { ...clone(base), runProfiles };
  if (!validateSettingsV2(settings)) throw new Error('Niepoprawne ustawienia. Sprawdź pola, selektory i timeout. Wejście TESTS służy tylko do testów.');
  return settings;
}
