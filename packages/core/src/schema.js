/**
 * JSON-schema validation (ajv) + tolerant JSON extraction for model output.
 */

import AjvImport from 'ajv';

// ajv ships CJS; under Node ESM interop the class may sit on .default.
const Ajv = AjvImport.default ?? AjvImport;
const ajv = new Ajv({ allErrors: true, strict: false, coerceTypes: false });

const SHORTHAND_TYPES = new Set(['string', 'number', 'boolean', 'array', 'object', 'integer', 'null']);

/**
 * Normalize the shorthand schema style used in plans
 * ({findings: "array", confidence: "number"}) into formal JSON Schema.
 * Formal schemas (with a `type` keyword or $-keywords) pass through untouched.
 * @param {object} schema
 * @returns {object}
 */
export function normalizeSchema(schema) {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
    return { type: 'object' };
  }
  if (typeof schema.type === 'string' || schema.$ref || schema.anyOf || schema.oneOf || schema.properties) {
    return schema;
  }
  /** @type {Record<string, object>} */
  const properties = {};
  for (const [key, value] of Object.entries(schema)) {
    if (typeof value === 'string' && SHORTHAND_TYPES.has(value)) {
      properties[key] = value === 'array' ? { type: 'array' } : { type: value };
    } else if (Array.isArray(value)) {
      properties[key] = {
        type: 'array',
        items: value.length ? normalizeSchema(value[0]) : {},
      };
    } else if (value && typeof value === 'object') {
      properties[key] = normalizeSchema(value);
    } else {
      properties[key] = {};
    }
  }
  return { type: 'object', properties, required: Object.keys(properties) };
}

/**
 * Compile a schema once → reusable validate function.
 * @param {object} schema
 * @returns {(data: any) => {valid: boolean, errors: string[]}}
 */
export function compileSchema(schema) {
  const validate = ajv.compile(normalizeSchema(schema));
  return (data) => {
    const valid = validate(data);
    return {
      valid: !!valid,
      errors: valid ? [] : (validate.errors ?? []).map((e) => `${e.instancePath || '/'} ${e.message}`),
    };
  };
}

/**
 * One-shot validation.
 * @param {any} data
 * @param {object} schema
 */
export function validateAgainstSchema(data, schema) {
  return compileSchema(schema)(data);
}

/**
 * Tolerant JSON extraction from model output. Layered:
 * 1. direct parse → 2. fenced block → 3. first balanced {...}/[...] →
 * 4. light repair (trailing commas). Returns undefined when hopeless.
 * @param {string} text
 * @returns {any|undefined}
 */
export function extractJson(text) {
  if (typeof text !== 'string') return undefined;
  const candidates = [];
  const trimmed = text.trim();
  candidates.push(trimmed);

  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) candidates.push(fence[1].trim());

  const balanced = firstBalanced(fence ? fence[1] : trimmed);
  if (balanced) candidates.push(balanced);

  for (const candidate of candidates) {
    for (const variant of [candidate, repairLight(candidate), repairAggressive(candidate)]) {
      if (variant === undefined) continue;
      try {
        return JSON.parse(variant);
      } catch {
        /* next */
      }
    }
  }
  return undefined;
}

/** Find the first balanced JSON object/array substring. */
function firstBalanced(text) {
  const start = text.search(/[{[]/);
  if (start === -1) return undefined;
  const open = text[start];
  const close = open === '{' ? '}' : ']';
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return undefined;
}

/** Remove trailing commas before } or ]. */
function repairLight(text) {
  return text.replace(/,\s*([}\]])/g, '$1');
}

/**
 * Best-effort repair for weaker models: trailing commas, single-quoted strings,
 * unquoted object keys, and Python-style True/False/None. Conservative — it
 * only runs as a last resort after strict parses fail.
 */
function repairAggressive(text) {
  if (typeof text !== 'string') return undefined;
  let out = text.replace(/,\s*([}\]])/g, '$1'); // trailing commas
  // single-quoted strings → double-quoted (only when no double quotes inside)
  out = out.replace(/'([^'"\\]*)'/g, '"$1"');
  // unquoted keys: {key: ...} or , key: ... → quote the key
  out = out.replace(/([{,]\s*)([A-Za-z_$][A-Za-z0-9_$]*)\s*:/g, '$1"$2":');
  out = out.replace(/\bTrue\b/g, 'true').replace(/\bFalse\b/g, 'false').replace(/\bNone\b/g, 'null');
  return out;
}
