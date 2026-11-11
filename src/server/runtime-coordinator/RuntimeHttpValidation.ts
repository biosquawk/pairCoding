/** Existing strict request shape with central V2 Settings ref. No defaults/coercion/legacy fallback. */
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { ProtocolV2Schema } from '../../shared/protocol-v2.schema';
import type { ClientMessage } from '../transport';
import { validateV2WireShape, validateSettingsV2 } from '../../shared/validation-v2';
const ajv = new Ajv2020({ allErrors:false, strict:false });
addFormats(ajv); ajv.addSchema(ProtocolV2Schema);
const openProject = ajv.compile({ $ref: 'urn:paircoach:runtime-language:v2#/$defs/OpenProjectRequest' });
export function validateRuntimeOpenProjectRequest(body:unknown):boolean {
  return !!openProject(body) && validateSettingsV2((body as {settings:unknown}).settings);
}

export function validateRuntimeClientMessage(value:unknown):value is ClientMessage {
  return validateV2WireShape('ClientMessage',value);
}
