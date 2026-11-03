/**
 * Structural diff. Byte offsets tell you *where* the prefix broke; this tells you
 * *what* broke, in terms of the request you wrote.
 */

import { Json, deepEqual, stableStringify } from "./canonical";

export type ChangeKind = "changed" | "array-item-added" | "array-item-removed" | "reordered";

export interface Change {
  path: string;
  kind: ChangeKind;
  before?: Json;
  after?: Json;
  /** Index of the element for array-item-* kinds. */
  index?: number;
}

function isRecord(value: Json | undefined): value is { [key: string]: Json } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function multiset(values: Json[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const value of values) {
    const key = stableStringify(value).text;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

function diffArray(a: Json[], b: Json[], path: string, out: Change[]): void {
  // Equal lengths: the arrays are the same shape, so only element-wise edits and
  // pure permutations are possible. Multiset add/remove here would report an
  // edited block as "removed + added", which mis-reads an in-place edit as an
  // insertion and fires the retrieval rule on a timestamp change.
  if (a.length === b.length) {
    if (isPureReorder(a, b)) {
      out.push({ path, kind: "reordered", before: "order", after: "order" });
      return;
    }
    for (let index = 0; index < a.length; index += 1) {
      const left = a[index];
      const right = b[index];
      if (left !== undefined && right !== undefined) {
        walk(left, right, `${path}[${index}]`, out);
      }
    }
    return;
  }

  // Different lengths: report the elements that exist on one side only.
  const counts = multiset(a);
  b.forEach((value, index) => {
    const key = stableStringify(value).text;
    const left = counts.get(key) ?? 0;
    if (left > 0) {
      counts.set(key, left - 1);
    } else {
      out.push({ path, kind: "array-item-added", index, after: value });
    }
  });
  const reverseCounts = multiset(b);
  a.forEach((value, index) => {
    const key = stableStringify(value).text;
    const left = reverseCounts.get(key) ?? 0;
    if (left > 0) {
      reverseCounts.set(key, left - 1);
    } else {
      out.push({ path, kind: "array-item-removed", index, before: value });
    }
  });

  // Recurse over the aligned head so co-occurring edits are still seen.
  const limit = Math.min(a.length, b.length);
  for (let index = 0; index < limit; index += 1) {
    const left = a[index];
    const right = b[index];
    if (left !== undefined && right !== undefined) {
      walk(left, right, `${path}[${index}]`, out);
    }
  }
}

function walk(a: Json, b: Json, path: string, out: Change[]): void {
  if (deepEqual(a, b)) return;

  if (Array.isArray(a) && Array.isArray(b)) {
    diffArray(a, b, path, out);
    return;
  }
  if (isRecord(a) && isRecord(b)) {
    const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
    for (const key of keys) {
      const child = path === "" ? key : `${path}.${key}`;
      const left = a[key];
      const right = b[key];
      if (left === undefined && right !== undefined) {
        out.push({ path: child, kind: "array-item-added", after: right });
      } else if (left !== undefined && right === undefined) {
        out.push({ path: child, kind: "array-item-removed", before: left });
      } else if (left !== undefined && right !== undefined) {
        walk(left, right, child, out);
      }
    }
    return;
  }
  out.push({ path, kind: "changed", before: a, after: b });
}

export function diffJson(a: Json, b: Json): Change[] {
  const out: Change[] = [];
  walk(a, b, "", out);
  return out;
}

/** True when two arrays hold the same elements in a different order. */
export function isPureReorder(a: Json | undefined, b: Json | undefined): boolean {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length || a.length === 0) return false;
  if (deepEqual(a, b)) return false;
  const left = multiset(a);
  const right = multiset(b);
  if (left.size !== right.size) return false;
  for (const [key, count] of left) {
    if (right.get(key) !== count) return false;
  }
  return true;
}

/** Common prefix and suffix of two strings, so the changed span can be inspected. */
export function changedSpan(a: string, b: string): { prefix: number; suffix: number; a: string; b: string } {
  const limit = Math.min(a.length, b.length);
  let prefix = 0;
  while (prefix < limit && a[prefix] === b[prefix]) prefix += 1;
  let suffix = 0;
  while (suffix < limit - prefix && a[a.length - 1 - suffix] === b[b.length - 1 - suffix]) suffix += 1;
  return {
    prefix,
    suffix,
    a: a.slice(prefix, a.length - suffix),
    b: b.slice(prefix, b.length - suffix),
  };
}
