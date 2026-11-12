import type { ServicePreparationState } from '../services/ServicePreparationV2';
import React, { useId } from 'react';
import type { ExecutionView, RunKind, RunV2 } from '../shared/runtime-v2';
import type { LanguageView } from '../shared/language-v2';
export interface RuntimeStatusV2Props {
  execution: ExecutionView | null; language: LanguageView | null; run: RunV2 | null;
  connected: boolean; canExecute: boolean; pending?: boolean; error?: string | null;
  preparation?: ServicePreparationState; onPrepare?(reconcile:boolean):void;
  onRun(mode: RunKind): void; onStop(runId: string): void; onSettings(): void;
}
/** Neutral status surface; container/service readiness never means terminal success. No editing controls are disabled. */
export function RuntimeStatusV2({ execution, language, run, connected, canExecute, pending = false, error, preparation, onPrepare, onRun, onStop, onSettings }: RuntimeStatusV2Props) {
  const id = useId();
  const active = run && ['QUEUED','RUNNING','STOPPING','PROCESS_STOP_UNCONFIRMED'].includes(run.status);
  const disabled = !connected || !canExecute || pending;
  return <section aria-label="Środowisko wykonania" className="rounded border border-zinc-700 bg-zinc-950 p-3 text-zinc-300 min-w-0 [overflow-wrap:anywhere]">
    <div className="flex flex-wrap items-center gap-2">
      <strong>Profil: {execution?.runtime.label || 'nieustalony'}</strong>
      <button type="button" onClick={onSettings} className="underline">Ustawienia wykonania</button>
    </div>
    <div role="status" aria-live="polite">
      {!connected ? 'Offline — uruchamianie niedostępne. Połącz ponownie; ręczna edycja i draft pozostają dostępne.' : !execution ? 'Ładowanie gotowości środowiska…' : `Środowisko: ${execution.runtime.state}`}
      {language && <p>Autouzupełnianie: {language.autocomplete} · Diagnostyka: {language.state} · Docs: {language.docs}</p>}
      {language?.problem && <p>{language.problem.message} {language.problem.recovery} Pisanie pozostaje dostępne.</p>}
      {execution?.runtime.problem && <p>{execution.runtime.problem.message} {execution.runtime.problem.recovery}</p>}
      {run && <p>Wykonanie {run.runId}: {run.status} · Testy: {run.testOutcome}{run.testCount !== null ? ` (${run.testCount})` : ''}</p>}
      {run?.serviceReadiness?.ready && <p>Usługa HTTP gotowa: <a className="underline break-all" href={run.serviceReadiness.url!} target="_blank" rel="noreferrer">{run.serviceReadiness.url}</a> — wykonanie nadal trwa.</p>}
      {run?.workspaceChangedDuringRun && <p>Kod zmienił się od uruchomienia. Wynik dotyczy wejścia w wersji {run.workspaceVersionAtStart}.</p>}
      {run?.processProblem && <p>{run.processProblem.message} {run.processProblem.recovery}</p>}
      {run?.status === 'STOPPING' && <p>Oczekiwanie na potwierdzenie zatrzymania. Nowe uruchomienie zablokowane.</p>}
      {run?.status === 'PROCESS_STOP_UNCONFIRMED' && <p>Brak potwierdzenia zatrzymania. Ponów Stop dla tego samego wykonania; nowe uruchomienie zablokowane. Edycja pozostaje dostępna.</p>}
    </div>
    {error && <p role="alert">{error}</p>}
    {onPrepare && <div className="mt-2">
      <button type="button" className="border rounded px-3 py-1 disabled:opacity-50" disabled={!connected || !canExecute || pending || Boolean(active) || !(preparation?.uncertain?preparation.canReconcile:preparation?.canPrepare)}
        aria-describedby={`${id}-prepare`} onClick={()=>onPrepare(!!preparation?.uncertain)}>
        {preparation?.pending?'Przygotowanie / uzgadnianie…':preparation?.uncertain?'Dokończ przygotowanie':'Przygotuj środowisko'}
      </button>
      <p id={`${id}-prepare`} role="status" aria-live="polite" className="text-sm mt-1">{preparation?.message ?? 'Jawne przygotowanie środowiska. Nie uruchamia programu ani testów. Ręczna edycja pozostaje dostępna.'}</p>
    </div>}
    <div className="flex flex-wrap gap-3 mt-2">
      {(['RUN_MAIN','RUN_TESTS'] as const).map(mode => <div key={mode} className="min-w-0 flex-1 basis-40">
        <button type="button" className="border rounded px-3 py-1 disabled:opacity-50" disabled={disabled || Boolean(active) || preparation?.blocked || !execution?.modes[mode].canRun} aria-describedby={`${id}-${mode}-reason`} onClick={() => onRun(mode)}>{mode === 'RUN_MAIN' ? 'Uruchom program' : 'Uruchom testy'}</button>
        <p id={`${id}-${mode}-reason`} className="text-sm break-words">{execution?.modes[mode].problem ? `${execution.modes[mode].problem.message} ${execution.modes[mode].problem.recovery}` : !canExecute ? 'Brak uprawnienia do uruchamiania.' : ''}</p>
      </div>)}
      <button type="button" className="border rounded px-3 py-1 disabled:opacity-50" disabled={disabled || !active || run?.status === 'STOPPING'} onClick={() => run && onStop(run.runId)}>{run?.status === 'PROCESS_STOP_UNCONFIRMED' ? 'Ponów Stop' : 'Stop'}</button>
    </div>
  </section>;
}
