/**
 * Structured JSON logger: one JSON object per line. Required fields:
 * timestamp, level, message. Secrets are redacted from every line.
 */

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

/** Patterns scrubbed from every log line. */
export const REDACTION_PATTERNS = [
  /sk-[A-Za-z0-9_-]{8,}/g,
  /ghp_[A-Za-z0-9]{20,}/g,
  /github_pat_[A-Za-z0-9_]{20,}/g,
  /Bearer\s+[A-Za-z0-9._-]{10,}/g,
  /x-api-key['":\s=]+[A-Za-z0-9._-]{10,}/gi,
  /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/g, // JWT
];

/** @param {string} text */
export function redact(text) {
  let out = String(text);
  for (const pattern of REDACTION_PATTERNS) {
    out = out.replace(pattern, '[REDACTED]');
  }
  return out;
}

/**
 * @param {{level?: "debug"|"info"|"warn"|"error", stream?: {write: Function}, base?: object}} [options]
 */
export function createLogger(options = {}) {
  const minLevel = LEVELS[options.level ?? 'info'] ?? LEVELS.info;
  const stream = options.stream ?? process.stdout;
  const base = options.base ?? {};

  const emit = (level, message, fields) => {
    if (LEVELS[level] < minLevel) return;
    const record = {
      timestamp: new Date().toISOString(),
      level,
      message: redact(String(message)),
      ...base,
      ...(fields ? sanitizeFields(fields) : {}),
    };
    stream.write(JSON.stringify(record) + '\n');
  };

  return {
    debug: (msg, fields) => emit('debug', msg, fields),
    info: (msg, fields) => emit('info', msg, fields),
    warn: (msg, fields) => emit('warn', msg, fields),
    error: (msg, fields) => emit('error', msg, fields),
    child: (childBase) => createLogger({ ...options, base: { ...base, ...childBase } }),
  };
}

function sanitizeFields(fields) {
  /** @type {Record<string, unknown>} */
  const out = {};
  for (const [key, value] of Object.entries(fields)) {
    if (/key|token|secret|password|authorization/i.test(key)) {
      out[key] = '[REDACTED]';
    } else if (typeof value === 'string') {
      out[key] = redact(value);
    } else if (value instanceof Error) {
      out[key] = redact(value.message);
    } else {
      out[key] = value;
    }
  }
  return out;
}
