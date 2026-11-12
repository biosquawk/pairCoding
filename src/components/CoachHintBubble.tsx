import React, { useLayoutEffect, useRef, useState } from 'react';
import { GripHorizontal, X } from 'lucide-react';
import type { CoachHintBubble as Hint } from '../types/paircoach';
import { placeHintBubble, type HintRect, type HintSize } from './hintBubbleGeometryP2';

interface Props {
  hint: Hint;
  container: HintSize;
  protectedCode: HintRect | null;
  onDismiss: () => void;
  onPosition: (x: number, y: number) => void;
}
/** Used inside the editor flex container: a parked hint reserves space instead of covering code. */
export function CoachHintBubble({ hint, container, protectedCode, onDismiss, onPosition }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [preferred, setPreferred] = useState({ x: 20, y: 40 });
  const [requested, setRequested] = useState({ width: 360, height: 240 });
  const [measured, setMeasured] = useState({ width: 0, height: 0 });
  const [parked, setParked] = useState(false);
  const gesture = useRef<null | { pointer: number; kind: 'move' | 'resize'; x: number; y: number; right: number; top: number; width: number; height: number }>(null);
  const width = Math.max(0, Math.min(requested.width, container.width));
  const maxHeight = Math.max(0, Math.min(requested.height, container.height));
  const placement = placeHintBubble(container, { width, height: measured.height }, preferred, protectedCode);
  const docked = parked || (measured.height > 0 && placement.parked);
  const parkedMaxHeight = Math.min(container.height, Math.max(32, Math.min(container.height - 20, Math.max(64, container.height * 0.4))));
  const collapsed = docked && container.height < 80;
  useLayoutEffect(() => { if (measured.height > 0 && placement.parked) setParked(true); }, [placement.parked, measured.height]);
  useLayoutEffect(() => {
    const node = ref.current;
    if (!node) return;
    const measure = () => { const r = node.getBoundingClientRect(); setMeasured(old => old.width === r.width && old.height === r.height ? old : { width: r.width, height: r.height }); };
    const observer = new ResizeObserver(measure); observer.observe(node); measure();
    return () => observer.disconnect();
  }, []);
  const notifyRef = useRef(onPosition); notifyRef.current = onPosition;
  useLayoutEffect(() => { if (!docked) notifyRef.current(placement.x, placement.y); }, [placement.x, placement.y, docked]);
  useLayoutEffect(() => { gesture.current = null; }, [docked]);
  const begin = (event: React.PointerEvent<HTMLButtonElement>, kind: 'move' | 'resize') => {
    if (event.button !== 0) return;
    event.preventDefault(); event.currentTarget.focus();
    event.currentTarget.setPointerCapture(event.pointerId);
    gesture.current = { pointer: event.pointerId, kind, x: event.clientX, y: event.clientY, right: placement.x, top: placement.y, width: measured.width, height: measured.height };
  };
  const move = (event: React.PointerEvent<HTMLButtonElement>) => {
    const g = gesture.current; if (!g || g.pointer !== event.pointerId) return;
    if (g.kind === 'move') setPreferred({ x: g.right - event.clientX + g.x, y: g.top + event.clientY - g.y });
    else setRequested({ width: Math.max(80, g.width + event.clientX - g.x), height: Math.max(44, g.height + event.clientY - g.y) });
  };
  const end = () => { gesture.current = null; };
  const arrows = (event: React.KeyboardEvent, resize = false) => {
    const dx = event.key === 'ArrowRight' ? 12 : event.key === 'ArrowLeft' ? -12 : 0;
    const dy = event.key === 'ArrowDown' ? 12 : event.key === 'ArrowUp' ? -12 : 0;
    if (!dx && !dy) return; event.preventDefault();
    if (resize) setRequested(s => ({ width: Math.max(80, Math.min(container.width, s.width + dx)), height: Math.max(44, Math.min(container.height, s.height + dy)) }));
    else setPreferred({ x: placement.x - dx, y: placement.y + dy });
  };
  const severity = hint.severity === 'WARNING' ? 'bg-rose-950 border-rose-600 text-rose-100' : hint.severity === 'POSITIVE' ? 'bg-emerald-950 border-emerald-600 text-emerald-100' : 'bg-yellow-950 border-yellow-600 text-yellow-100';
  return <div ref={ref} role="region" aria-label="Wskazówka trenera" data-hint-mode={docked ? 'parked' : 'overlay'}
    className={`flex flex-col min-h-0 shrink-0 rounded border shadow-xl text-xs overflow-hidden z-30 ${severity}`}
    style={docked ? { position: 'relative', width: '100%', maxHeight: parkedMaxHeight }
      : { position: 'absolute', right: placement.x, top: placement.y, width, maxHeight }}>
    <div className="flex items-center shrink-0 min-w-0 border-b border-white/10" style={{ height: Math.min(32, container.height) }}>
      <button type="button" aria-label="Przenieś wskazówkę (strzałki)" title={docked ? 'Wskazówka zadokowana poza kodem' : 'Przeciągnij lub użyj strzałek'}
        disabled={docked} onPointerDown={e => begin(e, 'move')} onPointerMove={move} onPointerUp={end} onPointerCancel={end} onLostPointerCapture={end}
        onKeyDown={e => arrows(e)} className="shrink-0 p-1 touch-none cursor-move disabled:cursor-default"><GripHorizontal size={16} /></button>
      <span title={collapsed ? `Powiększ edytor, aby przeczytać wskazówkę: ${hint.text}` : undefined} className="truncate flex-1 min-w-0">{collapsed ? 'Powiększ edytor' : docked ? 'Poza kodem' : hint.severity === 'WARNING' ? 'Uwaga' : hint.severity === 'POSITIVE' ? 'Dobry kierunek' : 'Wskazówka'} · {hint.line}</span>
      <button type="button" onClick={onDismiss} aria-label="Zamknij dymek" title="Zamknij dymek" className="shrink-0 p-1 hover:bg-black/30"><X size={16} /></button>
    </div>
    <div hidden={collapsed} tabIndex={0} aria-label="Treść wskazówki" className="overflow-auto min-h-0 p-1 whitespace-pre-wrap break-words select-text" style={{ overflowWrap: 'anywhere' }}>
      {docked && <p className="mb-1 font-semibold">Brak miejsca nad kodem — wskazówka zadokowana. Kod pozostaje odsłonięty.</p>}{hint.text}
    </div>
    {!docked && <button type="button" aria-label="Zmień rozmiar wskazówki (strzałki)" title="Przeciągnij lub użyj strzałek, aby zmienić rozmiar"
      className="shrink-0 self-end px-2 touch-none cursor-se-resize" onPointerDown={e => begin(e, 'resize')} onPointerMove={move} onPointerUp={end} onPointerCancel={end} onLostPointerCapture={end}
      onKeyDown={e => arrows(e, true)}>↘</button>}
  </div>;
}
