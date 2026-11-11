// Proposal only: no product imports and no claim of real LSP execution.
const keys = ['projectId','path','localModelVersion','documentVersion','profileId','requestGeneration','providerGeneration','ownershipEpoch'];
export function sameContext(expected, actual) {return keys.every(key => expected[key] === actual[key]);}
export function acceptCompletion(current, reply, owner) {
  return owner === 'STUDENT' && !current.controlPrepare && sameContext(current, reply);
}
export function acceptDiagnostic(current, envelope) {
  if (!sameContext(current, envelope.context)) return false;
  if (Number.isInteger(envelope.publishVersion)) return envelope.publishVersion === current.localModelVersion;
  // Unversioned push is accepted ONLY from a dedicated immutable snapshot instance.
  // Mutable completion-provider generation is explicitly NOT a version fence.
  return envelope.sourceKind === 'IMMUTABLE_DIAGNOSTIC_SNAPSHOT'
    && envelope.sourceSnapshotHash === current.snapshotHash
    && envelope.sourceProviderGeneration === current.providerGeneration;
}
export function safeItem(item, uri) {
  return !item.command && !(item.additionalTextEdits ?? []).some(edit => edit.uri && edit.uri !== uri)
    && !item.workspaceEdit; // C implementation must additionally validate/atomically apply ranges.
}

/** Controller-only ACK proof proposal. Never accept `association` from an LSP/AI payload. */
export function linkAckOnly(source, current, association) {
  const contentKeys=['projectId','path','modelLifetime','localModelVersion','profileId','configurationGeneration','providerGeneration','shadowGeneration','contentSha256','snapshotHash','ownershipEpoch'];
  if(!contentKeys.every(key=>source[key]===current[key]))return null;
  if(typeof source.contentSha256!=='string'||!source.contentSha256)return null;
  if(association.contentSha256!==source.contentSha256||association.localModelVersion!==source.localModelVersion
    ||association.documentVersion!==current.documentVersion)return null;
  // Preserve original source stamp; trusted presentation association is a different value.
  return {sourceContext:source,presentationContext:current,ackAssociation:association};
}
