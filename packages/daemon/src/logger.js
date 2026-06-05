/**
 * Structured JSON logger: one JSON object per line on stdout/file.
 * Required fields: timestamp, level, message. Secrets are redacted.
 */

/** Patterns scrubbed from every log line. */
export const REDACTION_PATTERNS = [
  /sk-[A-Za-z0-9_-]{8,}/g,
  /ghp_[A-Za-z0-9]{20,}/g,
  /Bearer\s+[A-Za-z0-9._-]{10,}/g,
  /x-api-key['":\s]+[A-Za-z0-9._-]{10,}/gi,
];

/**
 * @param {{level?: "debug"|"info"|"warn"|"error", stream?: NodeJS.WritableStream}} [options]
 * @returns {{debug: Function, info: Function, warn: Function, error: Function, child: Function}}
 */
export function createLogger(options) {
  void options;
  throw new Error('not implemented (P4)');
}
