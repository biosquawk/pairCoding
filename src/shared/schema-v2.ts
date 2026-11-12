/** Small draft2020 schema builders, all objects closed and all collections bounded. */
export const string = (maxLength: number, minLength = 1) => ({ type: 'string', minLength, maxLength });
export const integer = (minimum = 0, maximum = Number.MAX_SAFE_INTEGER) => ({ type: 'integer', minimum, maximum });
export const enumeration = (...values: (string | number)[]) => ({ enum: values });
export const nullable = (schema: object) => ({ anyOf: [schema, { type: 'null' }] });
export const array = (items: object, maxItems: number, minItems = 0) => ({ type: 'array', items, minItems, maxItems });
export const object = (properties: Record<string, object>) => ({
  type: 'object', properties, required: Object.keys(properties), additionalProperties: false,
});
export const id = { ...string(128), pattern: '^[A-Za-z0-9][A-Za-z0-9._:-]*$' };
export const hash = { type: 'string', pattern: '^[a-f0-9]{64}$' };
export const bool = { type: 'boolean' };
export const path = {
  ...string(1024),
  // Semantic Windows device/ADS/case/symlink/containment validation remains mandatory at filesystem boundary.
  pattern: '^(?!/)(?!.*(?:^|/)\\.\\.?(?:/|$))(?!.*//)(?!.*[\\\\:\\u0000-\\u001f\\u007f])[^/]+(?:/[^/]+)*$',
};
export const directory = { anyOf: [{ const: '.' }, path] };
export const position = object({ line: integer(1), column: integer(1) });
export const range = object({ startLine: integer(1), startColumn: integer(1), endLine: integer(1), endColumn: integer(1) });
export const problem = object({ code: id, message: string(2048), recovery: string(2048), retryable: bool });
