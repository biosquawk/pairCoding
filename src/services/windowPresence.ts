import type { WindowPresence } from '../types/paircoach';

/** Read the browser, not the last session's presence. Return effect cleanup. */
export function observeWindowPresence(
  doc: Pick<Document, 'hidden' | 'hasFocus' | 'addEventListener' | 'removeEventListener'>,
  win: Pick<Window, 'addEventListener' | 'removeEventListener'>,
  send: (presence: WindowPresence) => void,
) {
  const update = () => send(doc.hidden ? 'HIDDEN' : doc.hasFocus() ? 'FOCUSED' : 'BLURRED');
  doc.addEventListener('visibilitychange', update);
  win.addEventListener('focus', update);
  win.addEventListener('blur', update);
  update();
  return () => {
    doc.removeEventListener('visibilitychange', update);
    win.removeEventListener('focus', update);
    win.removeEventListener('blur', update);
  };
}
