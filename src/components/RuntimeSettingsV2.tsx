import React, { useEffect, useId, useRef, useState } from 'react';
import type { ExecutionView, RunKind, SettingsV2, TaskFieldKey } from '../shared/runtime-v2';
import { validateExecutionView, validateSettingsV2 } from '../shared/validation-v2';
import { buildRuntimeSettingsV2, createRuntimeSettingsDraftV2, runtimeRawProfileV2, isRuntimeTaskFieldVisibleV2, type SettingsSaveResultV2, type RuntimeSettingsDraftV2 } from '../services/RuntimeClientV2';
const clone = <T,>(v: T): T => structuredClone(v);
export interface RuntimeSettingsV2Props {
  open: boolean; settings: unknown; expectedWorkspaceVersion: number; execution: ExecutionView | null;
  /** Explicit backend-produced migration draft preserving unrelated settings. Never infer commands. */
  migrationDraft?: SettingsV2 | null;
  connected: boolean; canSave: boolean;
  onSave(settings: SettingsV2, expectedWorkspaceVersion: number): Promise<SettingsSaveResultV2>;
  onClose(): void;
}
export function RuntimeSettingsV2(props: RuntimeSettingsV2Props) {
  const { open, settings, expectedWorkspaceVersion, execution, migrationDraft, connected, canSave, onSave, onClose } = props;
  const closeCallback = useRef(onClose); closeCallback.current = onClose;
  const errorElement = useRef<HTMLParagraphElement>(null);
  const id = useId(), dialog = useRef<HTMLDivElement>(null), wasOpen = useRef(false), saveLock = useRef(false), opening = useRef(0);
  const [base, setBase] = useState<SettingsV2 | null>(() => validateSettingsV2(settings) ? clone(settings) : null);
  const [draft, setDraft] = useState<RuntimeSettingsDraftV2>(() => createRuntimeSettingsDraftV2(validateSettingsV2(settings) ? settings : { runProfiles: [] } as unknown as SettingsV2));
  const [generation, setGeneration] = useState(execution?.runtime.configurationGeneration ?? null);
  const [version, setVersion] = useState(expectedWorkspaceVersion), [saving, setSaving] = useState(false), [error, setError] = useState('');
  useEffect(() => {
    if (open && !wasOpen.current) {
      const s = validateSettingsV2(settings) ? clone(settings) : null;
      setBase(s); setDraft(s ? createRuntimeSettingsDraftV2(s) : { RUN_MAIN: runtimeRawProfileV2(), RUN_TESTS: runtimeRawProfileV2() });
      setVersion(expectedWorkspaceVersion); setGeneration(execution?.runtime.configurationGeneration ?? null); setError(''); opening.current++;
    }
    if (!open && wasOpen.current) opening.current++;
    wasOpen.current = open;
  }, [open, settings, expectedWorkspaceVersion, execution?.runtime.configurationGeneration]);
  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement | null;
    const elements = () => Array.from(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),textarea:not(:disabled),select:not(:disabled)') ?? []);
    (elements()[0] ?? dialog.current)?.focus();
    const keys = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); if (!saveLock.current) closeCallback.current(); }
      if (e.key !== 'Tab') return;
      const all = elements(), first = all[0], last = all[all.length - 1];
      if (!all.length) { e.preventDefault(); dialog.current?.focus(); }
      else if (e.shiftKey && (document.activeElement === first || document.activeElement === dialog.current)) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    };
    dialog.current?.addEventListener('keydown', keys);
    return () => { dialog.current?.removeEventListener('keydown', keys); previous?.focus(); };
  }, [open]);
  useEffect(() => { if (error) { errorElement.current?.focus(); errorElement.current?.scrollIntoView({block:'nearest'}); } }, [error]);
  if (!open) return null;
  const validExecution = execution && validateExecutionView(execution) ? execution : null;
  const fields = validExecution?.runtime.taskFields ?? [];
  const conflict = version !== expectedWorkspaceVersion || generation !== validExecution?.runtime.configurationGeneration;
  const setField = (mode: RunKind, key: TaskFieldKey, value: string) => setDraft(d => ({ ...d, [mode]: { ...d[mode], fields: { ...d[mode].fields, [key]: value } } }));
  const submit = async (event: React.FormEvent) => {
    event.preventDefault(); if (saveLock.current || !base || !connected || !canSave || conflict || !validExecution) return;
    try {
      const next = buildRuntimeSettingsV2(base, draft, fields), epoch = opening.current;
      saveLock.current = true; setSaving(true); setError('');
      const result = await onSave(next, version);
      if (epoch !== opening.current) return;
      if (result.ok) onClose(); else setError('message' in result ? result.message : 'Nie potwierdzono zapisu.');
    } catch (error) { setError(error instanceof Error ? error.message : 'Zapis niepotwierdzony. Zachowano formularz.'); }
    finally { saveLock.current = false; setSaving(false); }
  };
  return <div className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-3">
    <div ref={dialog} role="dialog" aria-modal="true" aria-busy={saving} aria-labelledby={`${id}-title`} tabIndex={-1} className="bg-zinc-950 text-zinc-300 border border-zinc-700 rounded-xl p-4 w-full max-w-xl max-h-[90dvh] overflow-y-auto min-w-0 [overflow-wrap:anywhere]">
      <h2 id={`${id}-title`} className="font-bold">Ustawienia wykonania V2</h2>
      <p>Profil: {validExecution?.runtime.label || 'nieustalony'}. Zapis wymaga potwierdzenia serwera; nie zmienia sposobu ręcznej edycji.</p>
      {!base ? <div role="alert"><p>LEGACY_RUN_PROFILE_REQUIRES_MIGRATION. Stare lub nieznane ustawienia pozostają bez zmian. Nie przepisujemy poleceń automatycznie.</p>
        <p>Przygotuj jawny profil zadania. Kopia zapasowa i migracja następują dopiero przy potwierdzonym zapisie.</p>
        {migrationDraft && validateSettingsV2(migrationDraft) ? <button type="button" onClick={() => { setBase(clone(migrationDraft)); setDraft(createRuntimeSettingsDraftV2(migrationDraft)); }}>Przygotuj migrację V2</button> : <p>Brak bezpiecznego szkicu migracji. Odczytaj go z ustawień projektu po połączeniu.</p>}
      </div> : <form onSubmit={submit}>
        <p>Wyłączenie obu trybów zapisuje pustą listę [] i wyłącza Run/Test.</p>
        {(['RUN_MAIN','RUN_TESTS'] as const).map(mode => <fieldset key={mode} disabled={saving} className="border rounded p-3 my-3 min-w-0">
          <legend>{mode === 'RUN_MAIN' ? 'Program' : 'Testy'}</legend>
          <label className="flex gap-2"><input type="checkbox" checked={draft[mode].enabled} onChange={e => setDraft(d => ({ ...d, [mode]: { ...d[mode], enabled: e.target.checked } }))} />Włącz {mode === 'RUN_MAIN' ? 'program' : 'testy'}</label>
          {draft[mode].enabled && fields.filter(f => isRuntimeTaskFieldVisibleV2(f.key, draft[mode].fields['entry.kind'] ?? '')).map(field => {
            const fid = `${id}-${mode}-${field.key}`, value = draft[mode].fields[field.key] ?? '';
            const classes = 'block w-full min-w-0 rounded border border-zinc-700 bg-zinc-900 p-2';
            return <div key={field.key} className="my-2"><label htmlFor={fid}>{field.label}{field.required ? ' *' : ''}</label>
              {field.input === 'CHOICE' ? <select id={fid} className={classes} value={value} required={field.required} aria-describedby={`${fid}-help`} onChange={e => setField(mode, field.key, e.target.value)}><option value="">Wybierz…</option>{field.choices.filter(c => mode !== 'RUN_MAIN' || field.key !== 'entry.kind' || c.value !== 'TESTS').map(c => <option key={c.value} value={c.value}>{c.label}</option>)}</select>
              : ['tests.paths','tests.names'].includes(field.key) ? <textarea id={fid} className={classes} rows={3} value={value} required={field.required} aria-describedby={`${fid}-help`} onChange={e => setField(mode, field.key, e.target.value)} />
              : <input id={fid} className={classes} type={field.input === 'INTEGER' ? 'number' : 'text'} min={field.min ?? undefined} max={field.max ?? undefined} step={field.input === 'INTEGER' ? 1 : undefined} value={value} required={field.required} aria-describedby={`${fid}-help`} onChange={e => setField(mode, field.key, e.target.value)} />}
              <p id={`${fid}-help`} className="text-sm break-words">{field.help}{['tests.paths','tests.names'].includes(field.key) ? ' Jeden selektor na linię. Pusta lista nazw oznacza wszystkie testy obsługiwane przez profil.' : ''}</p>
            </div>;
          })}
        </fieldset>)}
        {(!connected || !canSave || conflict || !validExecution) && <p role="alert">{conflict ? 'Konflikt wersji. Zachowano wpisane pola; skopiuj je przed zamknięciem i odczytaniem nowej wersji.' : !connected ? 'Offline. Zachowano wpisane pola; połącz ponownie.' : !canSave ? 'Brak uprawnienia do zapisu ustawień.' : 'Ładowanie deskryptorów profilu. Zapis niedostępny.'}</p>}
        {error && <p ref={errorElement} role="alert" tabIndex={-1}>{error} Zachowano wpisane pola.</p>}
        <button type="submit" className="border rounded px-3 py-2 disabled:opacity-50" disabled={saving || !connected || !canSave || conflict || !validExecution}>{saving ? 'Zapisywanie…' : 'Zapisz ustawienia'}</button>
      </form>}
      <button type="button" disabled={saving} className="underline mt-3" onClick={onClose}>Anuluj — bez zapisu</button>
    </div>
  </div>;
}
