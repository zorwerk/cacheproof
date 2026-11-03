/**
 * Ingest: read a captured request payload, prove it is a request, and find the
 * cache boundary.
 *
 * Two cache modes are modelled, because the providers differ:
 *   explicit  (Anthropic) — `cache_control` breakpoints. The cached prefix runs
 *             from the start of the wire order through the LAST breakpoint.
 *   implicit  (OpenAI, DeepSeek) — the cache takes the longest previously-computed
 *             prefix; there is no breakpoint to read, so the shared prefix is the
 *             only thing that can be measured.
 *
 * Wire order matters for what is cached, and canonical order does not preserve it
 * (canonical keys are alphabetical), so the cached region is tracked as a set of
 * JSON paths, never as "everything before byte N".
 */

import { Canonical, Json, stableStringify } from "./canonical";

export type Provider = "anthropic" | "openai" | "deepseek";
export const PROVIDERS: Provider[] = ["anthropic", "openai", "deepseek"];

export interface Ingested {
  raw: Json;
  canonical: Canonical;
  /** Dotted paths of the blocks that make up the cached prefix, in wire order. */
  cachedPaths: string[];
  /** Canonical bytes of the cached prefix, serialised block by block in wire order. */
  cachedBytes: number;
  /** Each cached block's canonical text, in wire order — lets two requests be compared block by block. */
  cachedBlockTexts: string[];
  /** Path of the block carrying the breakpoint, when the provider is explicit. */
  breakpointPath?: string;
}

export class IngestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IngestError";
  }
}

function isRecord(value: Json | undefined): value is { [key: string]: Json } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * A payload is a request when it has a message list and at least one of
 * model / system / tools. Anything else is reported as incomparable (exit 2)
 * rather than guessed at.
 */
export function assertRequestShape(raw: Json, label: string): void {
  if (!isRecord(raw)) {
    throw new IngestError(`${label}: not a JSON object (a request body is expected)`);
  }
  if (!Array.isArray(raw.messages)) {
    throw new IngestError(`${label}: no "messages" array — cannot locate a request prefix`);
  }
  const anchors = ["model", "system", "tools"].filter((key) => raw[key] !== undefined);
  if (anchors.length === 0) {
    throw new IngestError(`${label}: no "model", "system" or "tools" — not a comparable request`);
  }
}

interface WireBlock {
  path: string;
  value: Json;
  declaresBreakpoint: boolean;
}

/** Walk the request in provider wire order: tools, then system, then message content. */
function wireBlocks(raw: { [key: string]: Json }): WireBlock[] {
  const blocks: WireBlock[] = [];
  const collect = (list: Json | undefined, pathOf: (index: number) => string): void => {
    if (!Array.isArray(list)) return;
    list.forEach((entry, index) => {
      const path = pathOf(index);
      if (isRecord(entry)) {
        blocks.push({ path, value: entry, declaresBreakpoint: entry.cache_control !== undefined });
        // message content blocks
        if (Array.isArray(entry.content)) {
          entry.content.forEach((inner, innerIndex) => {
            if (isRecord(inner)) {
              blocks.push({
                path: `${path}.content[${innerIndex}]`,
                value: inner,
                declaresBreakpoint: inner.cache_control !== undefined,
              });
            }
          });
        }
      }
    });
  };
  collect(raw.tools, (index) => `tools[${index}]`);
  collect(raw.system, (index) => `system[${index}]`);
  collect(raw.messages, (index) => `messages[${index}]`);
  return blocks;
}

export function ingest(raw: Json, provider: Provider, label: string): Ingested {
  assertRequestShape(raw, label);
  const canonical = stableStringify(raw);
  const record = raw as { [key: string]: Json };

  if (provider === "anthropic") {
    const blocks = wireBlocks(record);
    let lastBreakpoint = -1;
    blocks.forEach((block, index) => {
      if (block.declaresBreakpoint) lastBreakpoint = index;
    });
    if (lastBreakpoint < 0) {
      throw new IngestError(
        `${label}: no cache_control breakpoint found. Anthropic caches only up to an explicit ` +
          `breakpoint, so a comparison would be a guess. Add cache_control to the last stable block, ` +
          `or run with --provider openai|deepseek for implicit-prefix pricing.`,
      );
    }
    const cachedBlocks = blocks.slice(0, lastBreakpoint + 1);
    const cachedPaths = cachedBlocks.map((block) => block.path);
    const cachedBlockTexts = cachedBlocks.map((block) => stableStringify(block.value).text);
    const cachedBytes = cachedBlockTexts.reduce((total, text) => total + Buffer.byteLength(text, "utf8"), 0);
    return {
      raw,
      canonical,
      cachedPaths,
      cachedBytes,
      cachedBlockTexts,
      breakpointPath: cachedBlocks[cachedBlocks.length - 1]?.path,
    };
  }

  // Implicit providers: nothing is declared, so the whole payload is the region
  // the provider may have cached, and the shared prefix decides the hit.
  return {
    raw,
    canonical,
    cachedPaths: ["tools", "system", "messages"],
    cachedBytes: canonical.bytes.length,
    cachedBlockTexts: [canonical.text],
  };
}

/** True when `path` is a cached block, lives inside one, or CONTAINS one (e.g. `tools`). */
export function isInCachedRegion(path: string, cachedPaths: string[]): boolean {
  return cachedPaths.some((root) => {
    if (path === root) return true;
    if (path.startsWith(`${root}.`) || path.startsWith(`${root}[`)) return true;
    // A container path such as `tools` or `system` covers every cached block under it.
    if (root.startsWith(`${path}.`) || root.startsWith(`${path}[`)) return true;
    return false;
  });
}

/** Prefix of `tools[]`/`system[]`/`messages[]` that is covered by the cached region. */
export function cachedRoots(cachedPaths: string[]): string[] {
  const roots = new Set<string>();
  for (const path of cachedPaths) {
    const match = /^(tools|system|messages)\[\d+\]/.exec(path);
    roots.add(match ? match[0] : path);
  }
  return [...roots];
}
