/**
 * Canonical serialisation.
 *
 * cacheproof compares two request payloads as *bytes*, because that is how every
 * provider's prompt cache decides a hit: the prefix must match exactly. We do not
 * have access to the provider's own serialiser, so we define one and say so:
 *
 *   - object keys sorted (deterministic, independent of insertion order),
 *   - no insignificant whitespace,
 *   - strings emitted by JSON.stringify.
 *
 * Consequence, stated in the README and in every report: an offset is a position
 * in *this* canonical stream, not necessarily the same integer the provider would
 * print. It is a stable diagnostic, not a wire pointer.
 */

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

export interface Span {
  /** Dotted path, e.g. `system[0].text`, `messages[0].content[1].text`, `tools[0]`. */
  path: string;
  start: number;
  end: number;
}

export interface Canonical {
  text: string;
  spans: Span[];
}

export function stableStringify(value: Json): Canonical {
  const parts: string[] = [];
  const spans: Span[] = [];
  let length = 0;

  const push = (chunk: string): void => {
    parts.push(chunk);
    length += chunk.length;
  };

  const walk = (node: Json | undefined, path: string): void => {
    if (node === undefined) {
      push("null");
      return;
    }
    if (node === null) {
      push("null");
      return;
    }
    if (typeof node === "string") {
      const start = length;
      push(JSON.stringify(node));
      spans.push({ path, start, end: length });
      return;
    }
    if (typeof node === "number") {
      push(Number.isFinite(node) ? JSON.stringify(node) : "null");
      return;
    }
    if (typeof node === "boolean") {
      push(node ? "true" : "false");
      return;
    }
    if (Array.isArray(node)) {
      const start = length;
      push("[");
      node.forEach((child, index) => {
        if (index > 0) push(",");
        walk(child, `${path}[${index}]`);
      });
      push("]");
      spans.push({ path, start, end: length });
      return;
    }
    const start = length;
    push("{");
    const keys = Object.keys(node).sort();
    keys.forEach((key, index) => {
      if (index > 0) push(",");
      push(JSON.stringify(key));
      push(":");
      walk(node[key], path === "" ? key : `${path}.${key}`);
    });
    push("}");
    spans.push({ path, start, end: length });
  };

  walk(value, "");
  return { text: parts.join(""), spans };
}

/** First index at which two strings differ; `null` when one is a prefix of the other or they match. */
export function firstDivergence(a: string, b: string): number | null {
  const limit = Math.min(a.length, b.length);
  for (let i = 0; i < limit; i += 1) {
    if (a[i] !== b[i]) return i;
  }
  return a.length === b.length ? null : limit;
}

export function deepEqual(a: Json | undefined, b: Json | undefined): boolean {
  if (a === b) return true;
  if (a === null || b === null || a === undefined || b === undefined) return false;
  if (typeof a !== typeof b) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item, index) => deepEqual(item, b[index]));
  }
  if (typeof a === "object" && typeof b === "object") {
    const ak = Object.keys(a).sort();
    const bk = Object.keys(b).sort();
    if (ak.length !== bk.length) return false;
    return ak.every((key, index) => key === bk[index] && deepEqual(a[key], (b as { [k: string]: Json })[key]));
  }
  return false;
}

/** Boutique-free token estimate. Declared, never hidden: the tool ships no tokeniser. */
export function estimateTokens(bytes: number): number {
  return Math.max(1, Math.round(bytes / 4));
}
