/**
 * Pricing. The rate table is data, not code: `--rates <file>` replaces it whole,
 * so a user whose provider changed price does not wait for a release.
 *
 * Honesty boundary: this tool ships no tokeniser, so token counts are an estimate
 * (canonical bytes / 4) and are labelled `~` everywhere. The *arithmetic* is exact
 * and unit-tested against the published example in the demand dossier §4.2
 * ($0.00261 miss / $0.00036 hit / 7.30x), which is why the tool can be trusted to
 * be right about the multiple while being approximate about the absolute count.
 */

import * as fs from "fs";
import * as path from "path";
import { estimateTokens } from "./canonical";

export interface ModelRate {
  input_per_mtok: number;
  cache_write_per_mtok: number;
  cache_read_per_mtok: number;
  cache_write_multiplier?: number;
  cache_read_multiplier?: number;
}

export interface ProviderRate {
  default_model: string;
  cache_mode: "explicit" | "implicit";
  implicit_prefix_min_tokens?: number;
  note?: string;
  models: { [model: string]: ModelRate };
}

export interface RateTable {
  as_of: string;
  display?: string;
  provenance?: string;
  units?: string;
  sources?: { [provider: string]: string };
  providers: { [provider: string]: ProviderRate };
}

export class RateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RateError";
  }
}

export function defaultRatesPath(): string {
  // dist/price.js -> ../rates/rates.json ; src/price.ts -> ../rates/rates.json
  return path.resolve(__dirname, "..", "rates", "rates.json");
}

export function loadRates(file?: string): RateTable {
  const target = file ? path.resolve(file) : defaultRatesPath();
  let raw: string;
  try {
    raw = fs.readFileSync(target, "utf8");
  } catch {
    throw new RateError(`cannot read rate table at ${target}`);
  }
  let parsed: RateTable;
  try {
    parsed = JSON.parse(raw) as RateTable;
  } catch (error) {
    throw new RateError(`rate table at ${target} is not valid JSON: ${(error as Error).message}`);
  }
  if (!parsed || typeof parsed !== "object" || !parsed.providers) {
    throw new RateError(`rate table at ${target} has no "providers" map`);
  }
  return parsed;
}

export function resolveRate(
  table: RateTable,
  provider: string,
  model?: string,
): { rate: ModelRate; provider: ProviderRate; model: string } {
  const entry = table.providers[provider];
  if (!entry) {
    throw new RateError(
      `provider "${provider}" is not in the rate table (known: ${Object.keys(table.providers).join(", ")})`,
    );
  }
  const chosen = model ?? entry.default_model;
  const rate = entry.models[chosen];
  if (!rate) {
    throw new RateError(
      `model "${chosen}" is not in the rate table for ${provider} (known: ${Object.keys(entry.models).join(", ")})`,
    );
  }
  return { rate, provider: entry, model: chosen };
}

export interface PriceInput {
  /** Tokens in the cacheable prefix. */
  prefixTokens: number;
  /** Tokens in the whole request. */
  totalTokens: number;
}

export interface Price {
  prefixTokens: number;
  totalTokens: number;
  tailTokens: number;
  missCost: number;
  hitCost: number;
  multiple: number;
}

export function estimateFromBytes(prefixBytes: number, totalBytes: number): PriceInput {
  return { prefixTokens: estimateTokens(prefixBytes), totalTokens: estimateTokens(totalBytes) };
}

/**
 * One request, priced twice: as written (prefix rewritten every call) and as it
 * would cost with a live prefix cache.
 *
 * explicit (Anthropic): a miss bills the WHOLE request at the cache-write rate —
 * that is the 1.25x trap — while a hit bills the prefix at the read rate and the
 * tail at input rate.
 * implicit (OpenAI, DeepSeek): no write fee; a miss is plain input, a hit bills
 * the prefix at the cached-input rate.
 */
export function computePrice(input: PriceInput, rate: ModelRate, cacheMode: "explicit" | "implicit"): Price {
  const prefixTokens = Math.max(0, Math.round(input.prefixTokens));
  const totalTokens = Math.max(prefixTokens, Math.round(input.totalTokens));
  const tailTokens = totalTokens - prefixTokens;

  const perToken = (value: number, perMtok: number): number => (value / 1_000_000) * perMtok;

  const missCost =
    cacheMode === "explicit"
      ? perToken(totalTokens, rate.cache_write_per_mtok)
      : perToken(totalTokens, rate.input_per_mtok);

  const hitCost =
    perToken(prefixTokens, rate.cache_read_per_mtok) + perToken(tailTokens, rate.input_per_mtok);

  const multiple = hitCost > 0 ? missCost / hitCost : Number.POSITIVE_INFINITY;

  return { prefixTokens, totalTokens, tailTokens, missCost, hitCost, multiple };
}

export function formatUsd(value: number): string {
  if (!Number.isFinite(value)) return "n/a";
  if (value === 0) return "$0.00";
  if (value < 0.01) return `$${value.toFixed(5)}`;
  if (value < 1) return `$${value.toFixed(4)}`;
  return `$${value.toFixed(2)}`;
}

export function formatMultiple(value: number): string {
  if (!Number.isFinite(value)) return "n/a";
  return `${value.toFixed(2)}x`;
}
