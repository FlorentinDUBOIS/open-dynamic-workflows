/**
 * JSON-schema validation (ajv wrapper) for structured agent outputs.
 */

/**
 * Compile a JSON schema once; returns a validate function.
 * Accepts both formal JSON Schema and the PRD's shorthand
 * ({findings: "array", confidence: "number"}) which is normalized first.
 *
 * @param {object} schema
 * @returns {(data: any) => {valid: boolean, errors: string[]}}
 */
export function compileSchema(schema) {
  void schema;
  throw new Error('not implemented (P4)');
}

/**
 * One-shot validation helper.
 * @param {any} data
 * @param {object} schema
 * @returns {{valid: boolean, errors: string[]}}
 */
export function validateAgainstSchema(data, schema) {
  void data; void schema;
  throw new Error('not implemented (P4)');
}
