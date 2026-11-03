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
  /** Offsets are **UTF-8 bytes**, not JavaScript string indices. */
  start: number;
  end: number;
}

export interface Canonical {
  text: string;
  /** The same content as `text`, as UTF-8 bytes — what every offset and length refers to. */
  bytes: Buffer;
  spans: Span[];
}

export function stableStringify(value: Json): Canonical {
  const parts: string[] = [];
  const spans: Span[] = [];
  let length = 0;

  // Byte length, not string length: `cacheproof` names bytes, so every number it
  // prints must be a byte count. A UTF-16 code unit is not a byte the moment the
  // prompt contains anything outside ASCII (audit D1).
  const push = (chunk: string): void => {
    parts.push(chunk);
    length += Buffer.byteLength(chunk, "utf8");
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
  const text = parts.join("");
  return { text, bytes: Buffer.from(text, "utf8"), spans };
}

/** First byte index at which two canonical streams differ; `null` when one is a prefix or they match. */
export function firstDivergence(a: Buffer, b: Buffer): number | null {
  const limit = Math.min(a.length, b.length);
  for (let i = 0; i < limit; i += 1) {
    if (a[i] !== b[i]) return i;
  }
  return a.length === b.length ? null : limit;
}

/** UTF-8 width of the character starting at `index` (1–4 bytes). */
function charWidth(text: string, index: number): number {
  const code = text.codePointAt(index) ?? 0;
  return Buffer.byteLength(String.fromCodePoint(code), "utf8");
}

/** The substring covering a byte range, without splitting a multi-byte character. */
export function byteSlice(text: string, startByte: number, endByte: number): string {
  let bytes = 0;
  let index = 0;
  while (index < text.length && bytes < startByte) {
    const width = charWidth(text, index);
    bytes += width;
    index += width === 4 ? 2 : 1;
  }
  const start = index;
  while (index < text.length && bytes < endByte) {
    const width = charWidth(text, index);
    bytes += width;
    index += width === 4 ? 2 : 1;
  }
  return text.slice(start, index);
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
