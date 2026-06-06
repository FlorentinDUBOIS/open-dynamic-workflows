/**
 * Structure-preserving compaction (pure odw-core, zero deps).
 *
 * The engine used to shrink oversized context with `JSON.stringify(x).slice(0, N)`
 * — a blind character cut that almost always produces UNPARSEABLE output (a
 * dangling brace, half a string, a broken escape), which the downstream model
 * then errors on or hallucinates structure around. These helpers replace that:
 *
 *  - compactText  — boundary-aware string truncation with an explicit marker.
 *  - compactValue — drops WHOLE trailing array items / object properties until the
 *    serialized form fits the budget, so the output ALWAYS re-parses as valid JSON.
 *
 * Both are byte-identical no-ops when the input already fits (the fit short-circuit
 * is the engine's zero-regression guarantee), and both return a manifest of what
 * was dropped so loss is never silent.
 */

const DEFAULT_MAX_CHARS = 20000;

/**
 * Truncate a plain string to at most `maxChars` characters (marker included),
 * preferring a whitespace boundary near the cut so we don't slice mid-word.
 * Returns the input UNCHANGED when it already fits.
 * @param {string} text
 * @param {number} maxChars
 * @returns {string}
 */
export function compactText(text, maxChars) {
  const s = String(text ?? '');
  const limit = Math.max(1, Math.floor(maxChars));
  if (s.length <= limit) return s;
  // No newline in the marker: JSON.stringify would escape it (\n → \\n) and
  // expand the serialized length past a tight budget when this string sits
  // inside a compacted structure.
  const marker = ` …[truncated ${s.length - limit} chars]`;
  // Budget too small to fit even the marker: hard-cut to the limit. The marker
  // is informational, so dropping it is acceptable — the budget is the contract.
  if (marker.length >= limit) return s.slice(0, limit);
  const room = limit - marker.length;
  let head = s.slice(0, room);
  // back up to the last whitespace so we cut on a boundary (only if it doesn't
  // discard too much — keep within the final 20% of the room).
  const boundary = head.lastIndexOf(' ');
  if (boundary > room * 0.8) head = head.slice(0, boundary);
  return head + marker; // length <= room + marker.length === limit, guaranteed
}

/**
 * Compact any value to fit a character budget by dropping WHOLE elements,
 * never cutting mid-structure. The result re-parses as valid JSON by
 * construction (it is assembled only from whole, already-valid sub-values).
 *
 * @param {any} value
 * @param {number} [maxChars]
 * @param {{keepKeys?: string[]}} [opts]
 * @returns {{value: any, manifest: {droppedCount: number, droppedPaths: string[], originalChars: number, finalChars: number}}}
 */
export function compactValue(value, maxChars = DEFAULT_MAX_CHARS, opts = {}) {
  const limit = Math.max(16, Math.floor(maxChars));
  const originalChars = safeLen(value);
  const droppedPaths = [];

  // Fit short-circuit: identical bytes, no work — the zero-regression path.
  if (originalChars <= limit) {
    return { value, manifest: { droppedCount: 0, droppedPaths, originalChars, finalChars: originalChars } };
  }

  const out = shrink(value, limit, '$', droppedPaths, opts);
  return {
    value: out,
    manifest: {
      droppedCount: droppedPaths.length,
      droppedPaths,
      originalChars,
      finalChars: safeLen(out),
    },
  };
}

function shrink(value, limit, path, droppedPaths, opts) {
  if (typeof value === 'string') return compactText(value, limit);
  if (value === null || typeof value !== 'object') return value; // number/bool/null/undefined fit

  if (Array.isArray(value)) {
    const kept = [];
    let used = 2; // "[]"
    for (let i = 0; i < value.length; i++) {
      const itemLen = safeLen(value[i]) + 1; // + comma
      if (used + itemLen <= limit) {
        kept.push(value[i]);
        used += itemLen;
      } else if (kept.length === 0) {
        // even the first item is too big: recurse into it so we return SOMETHING
        // valid. Reserve room for the JSON wrapper the item will sit inside
        // (`[` `]` plus, for a string, the two quotes) so the serialized array
        // still respects the budget rather than spilling a few chars over.
        let item = shrink(value[i], Math.max(1, limit - 4), `${path}[0]`, droppedPaths, opts);
        // JSON escaping (quotes/backslashes/newlines in the content) can still
        // expand the serialized array past the budget; trim a string leaf until
        // the WHOLE array serializes within limit. Guarantees the contract.
        if (typeof item === 'string') {
          while (item.length > 0 && JSON.stringify([item]).length > limit) {
            const over = JSON.stringify([item]).length - limit;
            item = item.slice(0, Math.max(0, item.length - over));
          }
        }
        kept.push(item);
        for (let j = i + 1; j < value.length; j++) droppedPaths.push(`${path}[${j}]`);
        return kept;
      } else {
        for (let j = i; j < value.length; j++) droppedPaths.push(`${path}[${j}]`);
        break;
      }
    }
    return kept;
  }

  // object: keepKeys first (priority eviction), then insertion order.
  const keep = new Set(opts.keepKeys ?? []);
  const keys = Object.keys(value);
  const ordered = [...keys.filter((k) => keep.has(k)), ...keys.filter((k) => !keep.has(k))];
  const result = {};
  let used = 2; // "{}"
  for (const key of ordered) {
    const entryLen = JSON.stringify(key).length + 1 + safeLen(value[key]) + 1; // "key":value,
    if (used + entryLen <= limit || keep.has(key)) {
      result[key] = value[key];
      used += entryLen;
    } else {
      droppedPaths.push(`${path}.${key}`);
    }
  }
  return result;
}

function safeLen(value) {
  try {
    const s = JSON.stringify(value);
    return s === undefined ? 0 : s.length;
  } catch {
    return Infinity; // circular/unserializable → treat as oversized
  }
}
