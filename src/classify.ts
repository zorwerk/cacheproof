/**
 * The five rules. Each one names a *cause*, not a symptom, because the fix
 * differs per cause: move the volatile value below the breakpoint, sort the tool
 * list, stop injecting retrieval above the prefix, stop concatenating in front of
 * the house rules, or stop switching model/template mid-run.
 *
 * A rule is only reported when the evidence is structural. When the prefix broke
 * but no rule matches, the verdict still fails — with rule
 * `unclassified-cached-change`, because "the cache died and I can't tell you why"
 * is a truthful failure, while silence would be a false pass.
 */

import { Json, stableStringify } from "./canonical";
import { Change, isPureReorder } from "./diff";
import { Ingested, isInCachedRegion } from "./ingest";

export type RuleId =
  | "tool-order"
  | "template-swap"
  | "retrieval-insert"
  | "instruction-prefix"
  | "volatile-above-breakpoint"
  | "unclassified-cached-change";

export const RULE_IDS: RuleId[] = [
  "volatile-above-breakpoint",
  "tool-order",
  "retrieval-insert",
  "instruction-prefix",
  "template-swap",
  "unclassified-cached-change",
];

export const RULE_DESCRIPTIONS: Record<RuleId, string> = {
  "volatile-above-breakpoint":
    "A value that changes every call (timestamp, id, nonce, session marker) sits inside the cached prefix.",
  "tool-order":
    "Identical tool definitions, different array order — the provider hashes bytes, not meaning.",
  "retrieval-insert":
    "A retrieved-context block is injected above the breakpoint, so every call gets a new prefix.",
  "instruction-prefix":
    "A per-call instruction is concatenated in front of the stable block instead of after it.",
  "template-swap":
    "The model or the message template changed, so the cached region re-tokenises.",
  "unclassified-cached-change":
    "The cached prefix changed but matches no named rule. Still a broken prefix; cause unknown.",
};

export interface Classification {
  rule: RuleId | null;
  confidence: "high" | "medium" | "low" | "none";
  evidence: string[];
  inCachedRegion: boolean;
  cachedChanges: Change[];
  allChanges: Change[];
}

interface VolatilePattern {
  name: string;
  test: RegExp;
}

/** Patterns that say "this value is expected to differ between two identical calls". */
const VOLATILE_PATTERNS: VolatilePattern[] = [
  { name: "ISO-8601 timestamp", test: /\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?/ },
  { name: "UUID", test: /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i },
  { name: "epoch timestamp", test: /\b1[6-9]\d{8}(?:\d{3})?\b/ },
  { name: "hex nonce", test: /\b[0-9a-f]{16,}\b/i },
  { name: "session/request id", test: /\b(?:sess|req|run|trace|span|msg)[_-]?[0-9a-z]{6,}\b/i },
  { name: "clock time", test: /\b\d{2}:\d{2}:\d{2}\b/ },
];

const VOLATILE_PATH = /(timestamp|nonce|request_?id|session_?id|trace_?id|run_?id|uuid|generated_at|now|clock)/i;

function textOf(value: Json | undefined): string {
  if (typeof value === "string") return value;
  if (value === undefined) return "";
  return stableStringify(value).text;
}

function blockTextLength(value: Json | undefined): number {
  if (value === undefined) return 0;
  // Canonical BYTES, not string length: audit D1 also lived in this evidence string, which told the
  // reader "N canonical bytes" while printing a UTF-16 code-unit count.
  return stableStringify(value).bytes.length;
}

// Characters as a reader counts them (code points), not UTF-16 code units — an emoji is one character.
function characterCount(value: string): number {
  return [...value].length;
}

function isRetrievalShaped(value: Json | undefined): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as { [key: string]: Json };
  if (record.type === "tool_result" || record.type === "document") return true;
  const text = textOf(record.text);
  return /\b(retrieved|retrieval|context|chunk|document|search result|memory)\b/i.test(text);
}

function similarityUnused(): void {
  // kept intentionally: no similarity heuristic is used by any rule in v0.1.
}

/**
 * Which volatile pattern actually CHANGED. Extracting matches from both sides and
 * comparing them — rather than testing the changed slice — is the difference
 * between "a timestamp sits here and its value moved" (a defect) and "a timestamp
 * sits here unchanged" (not a defect). Testing the slice alone missed the first
 * case: the timestamp is the thing that moved, so the slice is just `07Z` vs `38Z`
 * and no pattern can see it.
 */
function volatileDiff(before: string, after: string): string | null {
  for (const pattern of VOLATILE_PATTERNS) {
    const flags = pattern.test.flags.includes("g") ? pattern.test.flags : `${pattern.test.flags}g`;
    const re = new RegExp(pattern.test.source, flags);
    const left = before.match(re) ?? [];
    const right = after.match(re) ?? [];
    if (left.length !== right.length) return pattern.name;
    if (left.some((value, index) => value !== right[index])) return pattern.name;
  }
  return null;
}

export function classify(a: Ingested, b: Ingested, changes: Change[]): Classification {
  const cachedChanges = changes.filter((change) => isInCachedRegion(change.path, a.cachedPaths));
  const aRecord = a.raw as { [key: string]: Json };
  const bRecord = b.raw as { [key: string]: Json };

  // A model or template switch invalidates the cache without touching a cached
  // byte, because the cache is keyed on the model too. It is a cache defect even
  // though no path inside the prefix moved.
  const modelChanged =
    aRecord.model !== undefined &&
    bRecord.model !== undefined &&
    String(aRecord.model) !== String(bRecord.model);
  const rolesA = Array.isArray(aRecord.messages)
    ? aRecord.messages.map((m) => textOf((m as { [k: string]: Json }).role))
    : [];
  const rolesB = Array.isArray(bRecord.messages)
    ? bRecord.messages.map((m) => textOf((m as { [k: string]: Json }).role))
    : [];
  const rolesChanged = rolesA.length > 0 && rolesA.join(",") !== rolesB.join(",");

  const inCachedRegion = cachedChanges.length > 0 || modelChanged || rolesChanged;
  const evidence: string[] = [];

  if (!inCachedRegion) {
    return { rule: null, confidence: "none", evidence: ["no change inside the cached prefix"], inCachedRegion, cachedChanges, allChanges: changes };
  }

  // 1. tool-order — same definitions, different array order.
  if (isPureReorder(aRecord.tools, bRecord.tools)) {
    evidence.push("tools[] holds the same definitions in a different order");
    return { rule: "tool-order", confidence: "high", evidence, inCachedRegion, cachedChanges, allChanges: changes };
  }

  // 2. template-swap — model or template identity changed.
  if (modelChanged) {
    evidence.push(`model changed: ${String(aRecord.model)} -> ${String(bRecord.model)} (the cache is keyed on the model)`);
    return { rule: "template-swap", confidence: "high", evidence, inCachedRegion, cachedChanges, allChanges: changes };
  }
  if (rolesChanged) {
    evidence.push(`message role sequence changed: [${rolesA.join(", ")}] -> [${rolesB.join(", ")}]`);
    return { rule: "template-swap", confidence: "medium", evidence, inCachedRegion, cachedChanges, allChanges: changes };
  }

  // 3. retrieval-insert — a whole block appears above the breakpoint.
  for (const change of cachedChanges) {
    if (change.kind !== "array-item-added") continue;
    const length = blockTextLength(change.after);
    if (length >= 200 || isRetrievalShaped(change.after)) {
      evidence.push(
        `block added inside the cached prefix at ${change.path} (${length} canonical bytes` +
          `${isRetrievalShaped(change.after) ? ", retrieval-shaped" : ""})`,
      );
      return { rule: "retrieval-insert", confidence: "high", evidence, inCachedRegion, cachedChanges, allChanges: changes };
    }
  }

  // 4. instruction-prefix — text prepended to an existing cached block.
  for (const change of cachedChanges) {
    if (change.kind !== "changed") continue;
    if (typeof change.before !== "string" || typeof change.after !== "string") continue;
    const before = change.before;
    const after = change.after;
    const beforeChars = characterCount(before);
    const afterChars = characterCount(after);
    if (before.length > 0 && after.endsWith(before) && after.length > before.length) {
      evidence.push(
        `text at ${change.path} gained ${afterChars - beforeChars} characters at the FRONT ` +
          `(the stable block is still a suffix of it)`,
      );
      return { rule: "instruction-prefix", confidence: "high", evidence, inCachedRegion, cachedChanges, allChanges: changes };
    }
    if (before.endsWith(after) && before.length > after.length) {
      evidence.push(`text at ${change.path} lost ${beforeChars - afterChars} characters from the FRONT`);
      return { rule: "instruction-prefix", confidence: "medium", evidence, inCachedRegion, cachedChanges, allChanges: changes };
    }
  }

  // 5. volatile-above-breakpoint — the changed value is expected to differ per call.
  for (const change of cachedChanges) {
    if (typeof change.before === "string" && typeof change.after === "string") {
      const hit = volatileDiff(change.before, change.after);
      if (hit) {
        evidence.push(`${hit} differs inside the cached prefix at ${change.path}`);
        return { rule: "volatile-above-breakpoint", confidence: "high", evidence, inCachedRegion, cachedChanges, allChanges: changes };
      }
      continue;
    }
    const beforeText = textOf(change.before);
    const afterText = textOf(change.after);
    const hit = volatileDiff(beforeText, afterText);
    if (hit) {
      evidence.push(`${hit} differs inside the cached prefix at ${change.path}`);
      return { rule: "volatile-above-breakpoint", confidence: "high", evidence, inCachedRegion, cachedChanges, allChanges: changes };
    }
    if (VOLATILE_PATH.test(change.path)) {
      evidence.push(`field ${change.path} looks per-call by name and differs inside the cached prefix`);
      return { rule: "volatile-above-breakpoint", confidence: "medium", evidence, inCachedRegion, cachedChanges, allChanges: changes };
    }
  }

  // 6. Nothing matched, but the prefix is still broken.
  const worst = cachedChanges[0];
  evidence.push(
    `cached prefix changed at ${worst ? worst.path : "<unknown>"} and matches no named rule ` +
      `(${cachedChanges.length} change${cachedChanges.length === 1 ? "" : "s"} inside the cached region)`,
  );
  return {
    rule: "unclassified-cached-change",
    confidence: "low",
    evidence,
    inCachedRegion,
    cachedChanges,
    allChanges: changes,
  };
}
