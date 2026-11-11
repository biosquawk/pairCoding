/** Explicit future transport cutover. Legacy ws.schema.json/transport remain untouched: NOT a fallback adapter. */
import legacy from './ws.schema.json';
import { ExecutionViewSchema, RunProfileV2Schema, RunRequestV2Schema, RunV2Schema, SettingsV2Schema, UpdateSettingsRequestV2Schema } from './runtime-v2.schema';
import { LanguageClientMessageSchema, LanguageServerMessageSchema, LanguageViewSchema } from './language-v2.schema';
import { object } from './schema-v2';
export const ProtocolV2Schema = {
  ...legacy, $id: 'urn:paircoach:runtime-language:v2', title: 'PairCoach runtime/language V2 migration boundary',
  $defs: {
    ...legacy.$defs,
    Settings: SettingsV2Schema, RunProfile: RunProfileV2Schema, Run: RunV2Schema,
    Capabilities: object({ execution: ExecutionViewSchema, language: LanguageViewSchema }),
    RunRequest: RunRequestV2Schema, UpdateSettingsRequest: UpdateSettingsRequestV2Schema,
    ClientMessage: { oneOf: [...legacy.$defs.ClientMessage.oneOf, LanguageClientMessageSchema] },
    ServerMessage: { oneOf: [...legacy.$defs.ServerMessage.oneOf, LanguageServerMessageSchema] },
  },
};
