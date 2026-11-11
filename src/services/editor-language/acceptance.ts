import type { AcceptanceResult, AcceptanceState, CompleteResult, CompletionAcceptanceFacade, CompletionCandidate, DocumentStamp } from '../../shared/language-v2';
import { validateCompleteResult, validateCompletionEdits, validateDocumentStamp } from '../../shared/validation-v2';
import { contentSha256, normalizeContent } from './codec';
export const sameStamp = (a: Readonly<DocumentStamp>, b: Readonly<DocumentStamp>) =>
  Object.keys(a).length === Object.keys(b).length && Object.keys(a).every(k => a[k as keyof DocumentStamp] === b[k as keyof DocumentStamp]);
export const mayAccept = (s: AcceptanceState) => s.writeOwner === 'STUDENT' && s.connected === true && s.synced === true &&
  s.controlPrepare === false && s.vetoPending === false && s.conflict === false && s.readOnly === false;
export interface AcceptanceDependencies {
  /** Reads ACTUAL current model bytes/version + synchronous client authority on every call. */
  current(): AcceptanceState;
  /** One public pushEditOperations call, bracketed with pushStackElement. No save call here. */
  push(candidate: CompletionCandidate): void;
  show(candidates: readonly CompletionCandidate[]): void;
  hide(): void;
  cancelRequests(): void;
}
/** Public widget is the ONLY acceptance path; stock command/resolve hooks are not pre-edit hooks. */
export function createCompletionAcceptance(deps: AcceptanceDependencies): CompletionAcceptanceFacade {
  let candidates: CompletionCandidate[] = [];
  const clear = () => { candidates = []; deps.hide(); };
  const actual = () => {
    const state = deps.current();
    return validateDocumentStamp(state.stamp) && state.content.length <= 1048576 &&
      state.content === normalizeContent(state.content) && contentSha256(state.content) === state.stamp.contentSha256 ? state : null;
  };
  return {
    current: () => deps.current(),
    present(result: CompleteResult) {
      clear();
      try {
        const state = actual();
        if (!validateCompleteResult(result) || !state || !mayAccept(state) || !sameStamp(result.stamp,state.stamp) ||
          !result.items.every(item => validateCompletionEdits(item,result.stamp,state.content))) return;
        // No mutable caller object may alter an already presented candidate.
        candidates = JSON.parse(JSON.stringify(result.items.map(item => ({ requestId:result.requestId,stamp:result.stamp,item }))));
        deps.show(candidates.map(c => JSON.parse(JSON.stringify(c))));
      } catch { clear(); }
    },
    accept(candidate: CompletionCandidate): AcceptanceResult {
      try {
        const stored = candidates.find(c => c.requestId === candidate.requestId && c.item.id === candidate.item.id);
        if (!stored || JSON.stringify(stored) !== JSON.stringify(candidate)) return { accepted:false,reason:'STALE' };
        const state = actual();
        if (!state || !mayAccept(state)) { clear(); return { accepted:false,reason:'AUTHORITY' }; }
        if (!sameStamp(stored.stamp,state.stamp)) { clear(); return { accepted:false,reason:'STALE' }; }
        if (!validateCompletionEdits(stored.item,stored.stamp,state.content)) { clear(); return { accepted:false,reason:'UNSAFE_EDIT' }; }
        // No await, callback, renderer or cancellation between final byte/authority read and mutation.
        const final = actual();
        if (!final || !mayAccept(final) || !sameStamp(stored.stamp,final.stamp) || final.content !== state.content) return { accepted:false,reason:'STALE' };
        candidates = [];
        deps.push(stored);
        deps.hide();
        return { accepted:true };
      } catch { clear(); return { accepted:false,reason:'UNSAFE_EDIT' }; }
    },
    invalidate() { clear(); deps.cancelRequests(); },
    cancel() { clear(); deps.cancelRequests(); },
  };
}
