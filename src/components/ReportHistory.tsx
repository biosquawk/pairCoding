import { t, problemText, stateText, getUiLocale } from '../i18n';
import React, { useEffect, useRef, useState } from 'react';
import type { SessionReport } from '../types/paircoach';
import type { ReportHistorySource, ReportSummary } from '../services/reportHistory';
import { SafeMarkdown } from './SafeMarkdown';

export function ReportContent({ report, onRetry }: { report: SessionReport | null; onRetry?: () => void }) {
  if (!report) return <p className="text-sm text-zinc-400 py-4">{t("Raport końcowy zostanie wygenerowany po zakończeniu próby. Wybierz „Zakończ” na górnym pasku.")}</p>;
  if (report.status === 'PENDING') return <p role="status" className="text-sm text-zinc-400 py-4">{t("Generowanie podsumowania sesji treningowej przez Trenera AI…")}</p>;
  if (report.status === 'FAILED') return <div className="p-3 rounded border border-rose-800 text-rose-200 text-xs">
    <p className="font-semibold">{t("Nie udało się wygenerować raportu końcowego")}</p>
    <p className="my-2 break-words">{problemText(report.error) || t("Wystąpił nieoczekiwany błąd serwera.")}</p>
    {onRetry && <button className="px-3 py-2 rounded bg-rose-700 hover:bg-rose-600" onClick={onRetry}>{t("Ponów generowanie raportu")}</button>}
  </div>;
  return <SafeMarkdown content={report.markdown || ''} />;
}

export function ReportHistory({ source, scope, currentReport, onRetryCurrent }: {
  source?: ReportHistorySource; scope: string | null; currentReport: SessionReport | null; onRetryCurrent: () => void;
}) {
  const [reports, setReports] = useState<ReportSummary[]>([]);
  const [listed, setListed] = useState(false);
  const [listing, setListing] = useState(false);
  const [selected, setSelected] = useState('');
  const [historical, setHistorical] = useState<SessionReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const listRequest = useRef(0), readRequest = useRef(0);
  // Parent keys this component by project/session/connection generation. No old
  // response may update the new instance, even if its request completes late.
  useEffect(() => () => { listRequest.current++; readRequest.current++; }, []);
  const refresh = async () => {
    if (!source || !scope) return;
    const request = ++listRequest.current;
    setListing(true); setError('');
    try {
      const result = await source.listReports();
      if (request !== listRequest.current) return;
      setReports(result); setListed(true);
    } catch (e) { if (request === listRequest.current) setError(e instanceof Error ? e.message : String(e)); }
    finally { if (request === listRequest.current) setListing(false); }
  };
  const select = async (sessionId: string) => {
    const request = ++readRequest.current;
    setSelected(sessionId); setHistorical(null); setError(''); setLoading(!!sessionId);
    if (!sessionId || !source) return;
    try {
      const report = await source.readReport(sessionId);
      if (request === readRequest.current) setHistorical(report);
    } catch (e) { if (request === readRequest.current) setError(e instanceof Error ? e.message : String(e)); }
    finally { if (request === readRequest.current) setLoading(false); }
  };
  return <section aria-label={t("Raporty sesji")} className="min-w-0 [overflow-wrap:anywhere]">
    {source && <div className="mb-3 space-y-2 text-xs">
      <div className="flex flex-wrap items-center gap-2">
        <label htmlFor="report-history-session" className="font-semibold">{t("Poprzednie raporty")}</label>
        <select id="report-history-session" value={selected} disabled={!scope}
          onChange={e => void select(e.target.value)} className="min-w-0 max-w-full rounded border border-zinc-700 bg-zinc-900 p-2">
          <option value="">{t("Bieżący raport")}</option>
          {reports.map(r => <option key={r.reportId} value={r.sessionId}>
            {r.generatedAt ? new Date(r.generatedAt).toLocaleString(getUiLocale()==='en'?'en-US':'pl-PL') : t("Bez daty")} · {stateText(r.status)} {' '}{t("· sesja")}{' '}{r.sessionId}
          </option>)}
        </select>
        <button onClick={() => void refresh()} disabled={!scope || listing}
          className="rounded border border-zinc-700 px-3 py-2 hover:bg-zinc-800 disabled:opacity-50">
          {listing ? t("Ładowanie listy…") : t("Odśwież listę")}
        </button>
        {selected && <button disabled={loading} onClick={() => void select(selected)} className="rounded border border-zinc-700 px-3 py-2">{t("Odśwież raport")}</button>}
        {selected && <button onClick={() => void select('')} className="rounded border border-zinc-700 px-3 py-2">{t("Bieżący raport")}</button>}
      </div>
      {!scope && <p role="status">{t("Połącz z projektem, aby odczytać poprzednie raporty.")}</p>}
      {listed && !reports.length && <p role="status">{t("Brak zapisanych raportów w tym projekcie.")}</p>}
      {!listed && scope && <p>{t("Wybierz „Odśwież listę”, aby znaleźć zapisane raporty tego projektu.")}</p>}
    </div>}
    <h2 className="text-sm font-semibold mb-3">{selected ? t("Poprzedni raport — tylko odczyt") : t("Bieżący raport")}</h2>
    {selected && <p className="text-xs text-zinc-400 mb-3 break-all">{t("Sesja:")}{' '}{selected}{t(". Nie zmienia raportu bieżącej sesji. Aby sprawdzić nowszy stan, wybierz raport ponownie.")}</p>}
    {error && <p role="alert" className="text-xs text-rose-300 mb-3 break-words">{t("Nie można odczytać historii:")}{' '}{problemText(error)}</p>}
    {loading ? <p role="status">{t("Ładowanie raportu…")}</p> : selected
      ? historical && <ReportContent report={historical} />
      : <ReportContent report={currentReport} onRetry={onRetryCurrent} />}
  </section>;
}
