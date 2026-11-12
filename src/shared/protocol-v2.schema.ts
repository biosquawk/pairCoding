/** Explicit future transport cutover. Legacy ws.schema.json/transport remain untouched: NOT a fallback adapter. */
import legacy from './ws.schema.json';
import { ExecutionViewSchema, RunProfileV2Schema, RunRequestV2Schema, RunV2Schema, SettingsV2Schema, UpdateSettingsRequestV2Schema } from './runtime-v2.schema';
import { LanguageClientMessageSchema, LanguageServerMessageSchema, LanguageViewSchema } from './language-v2.schema';
import { id, nullable, object, enumeration, bool } from './schema-v2';
import { MutationOutcomeV2Schema, ReconcileMutationRequestV2Schema } from './runtime-mutation-v2.schema';
export const ProtocolV2Schema = {
  ...legacy, $id: 'urn:paircoach:runtime-language:v2', title: 'PairCoach runtime/language V2 migration boundary',
  $defs: {
    ...legacy.$defs,
    SessionBundle: {
      ...legacy.$defs.SessionBundle,
      properties: { ...legacy.$defs.SessionBundle.properties,
        languageBootstrap: nullable({ ...object({ connectionGeneration: id, shadowGeneration: id, provider: enumeration('builtin','remote','off'),
          features: object({ completion: bool, diagnostics: bool }) }), required: ['connectionGeneration','shadowGeneration','provider'] }),
      },
      required: [...legacy.$defs.SessionBundle.required, 'languageBootstrap'],
    },
    Client_CODE_CHANGED: {
      ...legacy.$defs.Client_CODE_CHANGED,
      properties: { ...legacy.$defs.Client_CODE_CHANGED.properties,
        payload: { ...legacy.$defs.Client_CODE_CHANGED.properties.payload,
          properties: { ...legacy.$defs.Client_CODE_CHANGED.properties.payload.properties, languageDocumentMessageId: id },
        },
      },
    },
    ReconcileMutationRequest: ReconcileMutationRequestV2Schema, MutationOutcome: MutationOutcomeV2Schema,
    Settings: SettingsV2Schema, RunProfile: RunProfileV2Schema, Run: RunV2Schema,
    Capabilities: object({ execution: ExecutionViewSchema, language: LanguageViewSchema }),
    RunRequest: RunRequestV2Schema, UpdateSettingsRequest: UpdateSettingsRequestV2Schema,
    ClientMessage: { oneOf: [...legacy.$defs.ClientMessage.oneOf, LanguageClientMessageSchema] },
    ServerMessage: { oneOf: [...legacy.$defs.ServerMessage.oneOf, LanguageServerMessageSchema] },
  },
};
