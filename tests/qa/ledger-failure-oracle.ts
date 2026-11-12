/** Semantic oracle from HUMAN b25a9d79, not implementation text. */
import assert from 'node:assert/strict';
export function assertAmbiguousMessage(message:string) {
  assert.match(message, /(?:mog[łl]a.*wykona|wynik.*nieznan)/iu, 'warn explicitly that an effect may have happened / outcome is unknown');
  assert.match(message, /synchroniz|sprawd[źz].*stan/iu, 'tell the reader to reconcile state');
  assert.match(message, /nie ponawiaj.*nowym.*id|bez.*nowego.*id/iu, 'do not retry under a new ID');
}
