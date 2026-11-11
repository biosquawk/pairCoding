/** Coordinates are local to the editor content container; x remains a RIGHT offset. */
export interface HintRect { left: number; top: number; width: number; height: number }
export interface HintSize { width: number; height: number }
export interface HintPosition { x: number; y: number }
export const intersectsHintRect = (a: HintRect, b: HintRect) =>
  a.left < b.left + b.width && a.left + a.width > b.left && a.top < b.top + b.height && a.top + a.height > b.top;
const bound = (v: number, max: number) => Math.max(0, Math.min(Number.isFinite(v) ? v : 0, Math.max(0, max)));
export function placeHintBubble(container: HintSize, measured: HintSize, preferred: HintPosition, protectedCode: HintRect | null) {
  const width = bound(measured.width, container.width), height = bound(measured.height, container.height);
  const position = (x: number, y: number) => ({ x: bound(x, container.width - width), y: bound(y, container.height - height) });
  const first = position(preferred.x, preferred.y);
  const candidates = [first];
  if (protectedCode) {
    // Closest alternatives along each edge of the protected selection/cursor rectangle.
    candidates.push(position(first.x, protectedCode.top - height - 4),
      position(first.x, protectedCode.top + protectedCode.height + 4),
      position(container.width - protectedCode.left + 4, first.y),
      position(container.width - protectedCode.left - protectedCode.width - width - 4, first.y));
  }
  for (const p of candidates) {
    const rect = { left: container.width - p.x - width, top: p.y, width, height };
    if (!protectedCode || !intersectsHintRect(rect, protectedCode)) return { ...p, width, height, parked: false };
  }
  return { ...first, width, height, parked: true };
}
