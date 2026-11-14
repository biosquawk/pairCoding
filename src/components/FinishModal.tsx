import { t, problemText } from '../i18n';
/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { EndReason } from '../types/paircoach';
import { AlertCircle, CheckCircle2, Flag, X } from 'lucide-react';

interface FinishModalProps {
  isOpen: boolean;
  initialReason: EndReason;
  onClose: () => void;
  onConfirm: (reason: EndReason) => void;
}

export const FinishModal: React.FC<FinishModalProps> = ({
  isOpen,
  initialReason,
  onClose,
  onConfirm,
}) => {
  const [reason, setReason] = React.useState<EndReason>(initialReason);

  React.useEffect(() => {
    setReason(initialReason);
  }, [initialReason]);

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 bg-black/70 backdrop-blur-xs flex items-center justify-center z-50 p-4 select-none">
      <div className="bg-zinc-900 border border-zinc-800 rounded-xl max-w-md w-full shadow-2xl p-5 text-zinc-200">
        <div className="flex items-center justify-between pb-3 border-b border-zinc-800">
          <div className="flex items-center gap-2 font-bold text-sm text-zinc-100">
            <Flag className="w-4 h-4 text-blue-400" />
            <span>{t("Zakończenie Sesji Treningowej")}</span>
          </div>
          <button onClick={onClose} className="p-1 rounded hover:bg-zinc-800 text-zinc-400">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="py-4 space-y-3 text-xs">
          <p className="text-zinc-300 leading-relaxed">
            {t("Wybierz powód zakończenia bieżącej sesji. Po potwierdzeniu czas zostanie zatrzymany, a Trener AI wygeneruje dla Ciebie szczegółowy raport z metrykami i oceną.")}{' '}</p>

          <div className="space-y-2">
            <label
              onClick={() => setReason('COMPLETED')}
              className={`flex items-start gap-2.5 p-3 rounded-lg border cursor-pointer transition-all ${
                reason === 'COMPLETED'
                  ? 'bg-blue-950/60 border-blue-500 text-zinc-100'
                  : 'bg-zinc-950/60 border-zinc-800 text-zinc-400 hover:border-zinc-700'
              }`}
            >
              <input
                type="radio"
                name="finishReason"
                checked={reason === 'COMPLETED'}
                onChange={() => setReason('COMPLETED')}
                className="mt-0.5 text-blue-500 focus:ring-0"
              />
              <div>
                <div className="font-semibold text-zinc-200">{t("Zadanie ukończone (COMPLETED)")}</div>
                <div className="text-[11px] text-zinc-400 mt-0.5">
                  {t("Rozwiązanie jest gotowe, testy przeszły lub notatki z przeglądu są kompletne.")}{' '}</div>
              </div>
            </label>

            <label
              onClick={() => setReason('TIME_LIMIT_REVIEW')}
              className={`flex items-start gap-2.5 p-3 rounded-lg border cursor-pointer transition-all ${
                reason === 'TIME_LIMIT_REVIEW'
                  ? 'bg-amber-950/60 border-amber-500 text-zinc-100'
                  : 'bg-zinc-950/60 border-zinc-800 text-zinc-400 hover:border-zinc-700'
              }`}
            >
              <input
                type="radio"
                name="finishReason"
                checked={reason === 'TIME_LIMIT_REVIEW'}
                onChange={() => setReason('TIME_LIMIT_REVIEW')}
                className="mt-0.5 text-amber-500 focus:ring-0"
              />
              <div>
                <div className="font-semibold text-zinc-200">{t("Przegląd po limicie czasu (TIME_LIMIT_REVIEW)")}</div>
                <div className="text-[11px] text-zinc-400 mt-0.5">
                  {t("Czas na sesję upłynął — chcesz ocenić stan kodu osiągnięty w wyznaczonym limicie.")}{' '}</div>
              </div>
            </label>

            <label
              onClick={() => setReason('ABANDONED')}
              className={`flex items-start gap-2.5 p-3 rounded-lg border cursor-pointer transition-all ${
                reason === 'ABANDONED'
                  ? 'bg-rose-950/60 border-rose-500 text-zinc-100'
                  : 'bg-zinc-950/60 border-zinc-800 text-zinc-400 hover:border-zinc-700'
              }`}
            >
              <input
                type="radio"
                name="finishReason"
                checked={reason === 'ABANDONED'}
                onChange={() => setReason('ABANDONED')}
                className="mt-0.5 text-rose-500 focus:ring-0"
              />
              <div>
                <div className="font-semibold text-zinc-200">{t("Porzucenie próby (ABANDONED)")}</div>
                <div className="text-[11px] text-zinc-400 mt-0.5">
                  {t("Chcesz przerwać bez zaliczenia próby i sprawdzić dotychczasowe uwagi.")}{' '}</div>
              </div>
            </label>
          </div>
        </div>

        <div className="flex items-center justify-end gap-2 pt-3 border-t border-zinc-800">
          <button
            onClick={onClose}
            className="px-3 py-1.5 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-300 text-xs"
          >
            {t("Anuluj")}{' '}</button>
          <button
            onClick={() => onConfirm(reason)}
            className="px-4 py-1.5 rounded bg-blue-600 hover:bg-blue-500 text-white font-semibold text-xs transition-colors shadow-sm"
          >
            {t("Potwierdź i Wygeneruj Raport")}{' '}</button>
        </div>
      </div>
    </div>
  );
};
