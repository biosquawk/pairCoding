import { array, bool, enumeration, hash, id, integer, nullable, object, path, position, problem, range, string } from './schema-v2';
export const DocumentStampSchema = object({
  projectId: id, sessionId: id, path, profileId: id,
  connectionGeneration: id, configurationGeneration: id, providerGeneration: id, shadowGeneration: id,
  modelLifetime: id, localModelVersion: integer(1), baseDocumentVersion: integer(1), documentVersion: nullable(integer(1)),
  contentSha256: hash, controlEpoch: integer(), requestGeneration: integer(1),
});
export const OpenOrChangeSchema = object({ stamp: DocumentStampSchema, content: string(1048576,0),
  reason: enumeration('OPEN','TYPING','COMPLETION','UNDO','REDO','COACH_STEP_EDIT','EXTERNAL_FILE_SYNC','RESTORE_SNAPSHOT','DRAFT_RECOVERY'),
});
export const CompleteRequestSchema = object({ requestId: id, stamp: DocumentStampSchema, position, trigger: nullable(string(8)) });
export const CancelRequestSchema = object({ requestId: id, stamp: DocumentStampSchema });
export const CompletionEditSchema = object({ path, range, text: string(4096,0) });
export const CompletionItemSchema = object({ id, label: string(256), detail: nullable(string(1024)),
  primary: CompletionEditSchema, additionalTextEdits: array(CompletionEditSchema,100),
});
export const CompleteResultSchema = object({ requestId: id, stamp: DocumentStampSchema, items: array(CompletionItemSchema,100), isIncomplete: bool });
export const DiagnosticProvenanceSchema = { oneOf: [
  object({ kind: { const: 'VERSIONED_PUSH' }, lspVersion: integer(1), inputManifestSha256: hash }),
  object({ kind: { const: 'PULL' }, requestId: id, inputManifestSha256: hash }),
  object({ kind: { const: 'IMMUTABLE_GENERATION' }, launchId: id, lspVersion: nullable(integer(1)), inputManifestSha256: hash }),
] };
export const DiagnosticsResultSchema = object({ sourceStamp: DocumentStampSchema, presentationStamp: DocumentStampSchema,
  provenance: DiagnosticProvenanceSchema, association: nullable(object({ saveReceiptId: id })),
  items: array(object({ range, severity: enumeration('ERROR','WARNING','INFO','HINT'), message: string(4096), code: nullable(string(128)) }),500),
  truncated: bool,
});
export const LanguageFileOperationSchema = { oneOf: [
  object({ kind: { const: 'CREATE' }, path, content: string(1048576,0) }),
  object({ kind: { const: 'RENAME' }, path, newPath: path }),
  object({ kind: { const: 'DELETE' }, path }),
] };
export const LanguageViewSchema = object({ projectId: id, profileId: id, configurationGeneration: id, providerGeneration: id,
  state: enumeration('OFF','INDEXING','ON','FAILED'), autocomplete: enumeration('OFF','INDEXING','ON','FAILED'), docs: { const: 'N/A' }, problem: nullable(problem),
});
const client = (type: string, payload: object) => object({ protocolVersion: { const: '3.0' }, messageId: id, sessionId: id, clientId: id, type: { const: type }, payload });
const server = (type: string, payload: object) => object({ protocolVersion: { const: '3.0' }, messageId: id, sessionId: id, seq: integer(1), type: { const: type }, payload });
export const LanguageClientMessageSchema = { oneOf: [
  client('LANGUAGE_OPEN',OpenOrChangeSchema), client('LANGUAGE_CHANGE',OpenOrChangeSchema),
  client('LANGUAGE_CLOSE',object({ stamp: DocumentStampSchema })), client('LANGUAGE_COMPLETE',CompleteRequestSchema), client('LANGUAGE_CANCEL',CancelRequestSchema),
] };
export const LanguageServerMessageSchema = { oneOf: [
  server('COMPLETE_RESULT',CompleteResultSchema), server('DIAGNOSTICS',DiagnosticsResultSchema), server('LANGUAGE_STATUS',LanguageViewSchema),
] };
