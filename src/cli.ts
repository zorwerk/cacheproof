#!/usr/bin/env node
/**
 * cacheproof — find the byte that killed your prompt cache, and what it cost.
 *
 * Exit codes are the contract:
 *   0  clean (or the gate's threshold was met)
 *   1  broken cached prefix, over the threshold
 *   2  cannot decide — bad input, incomparable payloads, no breakpoint declared
 *
 * Zero runtime dependencies by design: a tool that needs a key, a network call or
 * an install step cannot be tested by the reviewer who decides whether to star it.
 */

import * as fs from "fs";
import * as path from "path";
import { Json, byteSlice, estimateTokens, firstDivergence } from "./canonical";
import { Change, diffJson } from "./diff";
import { classify } from "./classify";
import {
  Provider,
  PROVIDERS,
  IngestError,
  Ingested,
  ingest,
  isInCachedRegion,
} from "./ingest";
import { PriceInput, RateError, computePrice, loadRates, resolveRate } from "./price";
import { ReportContext, renderHuman, renderJson } from "./report";

export const VERSION = "0.1.1";

interface Parsed {
  command: string;
  positionals: string[];
  flags: Map<string, string | true>;
}

const VALUE_FLAGS = new Set([
  "--provider",
  "--model",
  "--rates",
  "--max-miss-multiple",
  "--calls",
  "--tokens-prefix",
  "--tokens-total",
]);

function parseArgs(argv: string[]): Parsed {
  const flags = new Map<string, string | true>();
  const positionals: string[] = [];
  let command = "";
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i] as string;
    if (token.startsWith("--")) {
      const [name, inline] = token.split("=", 2) as [string, string | undefined];
      if (inline !== undefined) {
        flags.set(name, inline);
      } else if (VALUE_FLAGS.has(name)) {
        const next = argv[i + 1];
        if (next === undefined || next.startsWith("--")) {
          throw new IngestError(`flag ${name} needs a value`);
        }
        flags.set(name, next);
        i += 1;
      } else {
        flags.set(name, true);
      }
      continue;
    }
    if (!command) {
      command = token;
    } else {
      positionals.push(token);
    }
  }
  return { command: command || "check", positionals, flags };
}

function readPayloads(file: string): Json[] {
  const target = path.resolve(file);
  let raw: string;
  try {
    raw = fs.readFileSync(target, "utf8");
  } catch {
    throw new IngestError(`cannot read ${file}`);
  }
  try {
    return [JSON.parse(raw.replace(/^\uFEFF/, "")) as Json];
  } catch {
    // JSONL: one JSON value per non-empty line.
  }
  const values: Json[] = [];
  const lines = raw.split(/\r?\n/);
  lines.forEach((line, index) => {
    const trimmed = line.replace(/^\uFEFF/, "").trim();
    if (!trimmed) return;
    try {
      values.push(JSON.parse(trimmed) as Json);
    } catch {
      const bomHint = index === 0 && raw.startsWith("\uFEFF") ? " (file starts with a UTF-8 BOM)" : "";
      throw new IngestError(`${file}:${index + 1}: neither a JSON document nor a JSONL line${bomHint}`);
    }
  });
  if (values.length === 0) throw new IngestError(`${file}: empty`);
  return values;
}

function contextAround(text: string, offset: number, radius = 44): string {
  // `offset` is a UTF-8 byte index; slice by bytes so a multi-byte character is
  // never cut in half and the window still lines up with the offset printed.
  return byteSlice(text, Math.max(0, offset - radius), offset + radius).replace(/\n/g, "\\n");
}

function sharedCachedBlocks(a: Ingested, b: Ingested): number {
  let total = 0;
  const limit = Math.min(a.cachedBlockTexts.length, b.cachedBlockTexts.length);
  for (let index = 0; index < limit; index += 1) {
    const left = a.cachedBlockTexts[index];
    if (left === b.cachedBlockTexts[index] && left !== undefined) {
      total += Buffer.byteLength(left, "utf8");
    } else {
      break;
    }
  }
  return total;
}

interface CompareOptions {
  provider: Provider;
  model?: string;
  ratesFile?: string;
  maxMissMultiple: number;
  calls: number;
  json: boolean;
}

function comparePair(fileA: string, payloadA: Json, fileB: string, payloadB: Json, options: CompareOptions): { ctx: ReportContext; exitCode: number } {
  const table = loadRates(options.ratesFile);
  const resolved = resolveRate(table, options.provider, options.model);
  const cacheMode = resolved.provider.cache_mode;

  const a = ingest(payloadA, options.provider, fileA);
  const b = ingest(payloadB, options.provider, fileB);

  const offset = firstDivergence(a.canonical.bytes, b.canonical.bytes);
  const changes = diffJson(a.raw, b.raw);

  // For an implicit-prefix provider there is no breakpoint to violate: the cached
  // region *is* the shared byte prefix, so it is derived from spans, not from paths.
  let regionA = a;
  let sharedBytes = b.cachedBytes;
  const notes: string[] = ["token counts are estimated as canonical bytes / 4; cacheproof ships no tokeniser"];

  if (cacheMode === "implicit") {
    const shared = offset ?? b.canonical.bytes.length;
    const regionPaths = a.canonical.spans
      .filter((span) => span.end <= shared)
      .map((span) => span.path);
    regionA = { ...a, cachedPaths: regionPaths.length > 0 ? regionPaths : [], cachedBytes: shared };
    sharedBytes = shared;
    const floor = resolved.provider.implicit_prefix_min_tokens ?? 0;
    if (floor > 0 && estimateTokens(shared) < floor) {
      notes.push(
        `shared prefix ~${estimateTokens(shared)} tok is below ${options.provider}'s ${floor}-token minimum: ` +
          `no cache hit was possible even with an intact prefix`,
      );
    }
  } else {
    sharedBytes = isInCachedRegion(changes[0]?.path ?? "", regionA.cachedPaths)
      ? sharedCachedBlocks(a, b)
      : b.cachedBytes;
    if (offset === null) sharedBytes = b.cachedBytes;
  }

  const classification = classify(regionA, b, changes);

  const prefixBytes = cacheMode === "implicit" ? sharedBytes : b.cachedBytes;
  const priceInput: PriceInput = {
    prefixTokens: estimateTokens(prefixBytes),
    totalTokens: estimateTokens(b.canonical.bytes.length),
  };
  const price = computePrice(priceInput, resolved.rate, cacheMode);

  const broken = classification.inCachedRegion;
  const overGate = broken && price.multiple > options.maxMissMultiple;
  const exitCode = overGate ? 1 : 0;

  if (broken && !overGate) {
    notes.push(
      `the cached prefix broke but the miss multiple (${price.multiple.toFixed(2)}x) is within ` +
        `--max-miss-multiple ${options.maxMissMultiple.toFixed(2)}: allowed by the gate, still worth fixing`,
    );
  }
  if (cacheMode === "explicit" && price.prefixTokens === 0) {
    notes.push("cached prefix is empty — nothing was cacheable in this request");
  }

  const ctx: ReportContext = {
    version: VERSION,
    provider: options.provider,
    model: resolved.model,
    rates: table,
    aBytes: a.canonical.bytes.length,
    bBytes: b.canonical.bytes.length,
    cachedBytesA: a.cachedBytes,
    cachedBytesB: b.cachedBytes,
    sharedBytes,
    regionBasis: cacheMode === "implicit" ? "shared_prefix" : "cached_blocks",
    breakpointPath: cacheMode === "explicit" ? a.breakpointPath : undefined,
    offset,
    contextA: offset === null ? "" : contextAround(a.canonical.text, offset),
    contextB: offset === null ? "" : contextAround(b.canonical.text, offset),
    classification,
    changes,
    price,
    maxMissMultiple: options.maxMissMultiple,
    calls: options.calls,
    notes,
    clean: !broken,
    exitCode,
  };

  return { ctx, exitCode };
}

function explainRules(): string {
  const { RULE_IDS, RULE_DESCRIPTIONS } = require("./classify") as typeof import("./classify");
  const lines = ["cacheproof 0.1.0 — rule ids", ""];
  for (const id of RULE_IDS) {
    lines.push(`  ${id}`);
    lines.push(`      ${RULE_DESCRIPTIONS[id]}`);
  }
  lines.push("");
  lines.push("Exit codes: 0 clean · 1 broken prefix over the gate · 2 cannot decide");
  return `${lines.join("\n")}\n`;
}

const HELP = `cacheproof ${VERSION} — find the byte that killed your prompt cache, and what it cost.

Usage
  cacheproof check <a.json> <b.json> [options]   compare two captured requests and gate
  cacheproof check <run.jsonl> [options]         compare consecutive requests in a run
  cacheproof diff  <a.json> <b.json> [options]   offset + structural changes, no gate
  cacheproof price --tokens-prefix N --tokens-total M [options]
  cacheproof rules                               list the five rule ids

Options
  --provider anthropic|openai|deepseek   default anthropic
  --model <name>                         default: the provider's default in rates.json
  --rates <file>                         replace the rate table (data, not code)
  --max-miss-multiple <n>                default 1.0; exit 1 when the miss multiple exceeds it
  --calls <n>                            show the extrapolated bill as well
  --json                                 machine-readable output

Exit codes
  0 clean   1 broken cached prefix over the gate   2 cannot decide (bad input / incomparable)

Nothing leaves your machine: no network, no keys, no telemetry.`;

function main(argv: string[]): number {
  let parsed: Parsed;
  try {
    parsed = parseArgs(argv);
  } catch (error) {
    process.stderr.write(`cacheproof: ${(error as Error).message}\n`);
    return 2;
  }

  if (parsed.flags.has("--help") || parsed.command === "help") {
    process.stdout.write(`${HELP}\n`);
    return 0;
  }
  if (parsed.flags.has("--version") || parsed.command === "version") {
    process.stdout.write(`${VERSION}\n`);
    return 0;
  }
  if (parsed.command === "rules") {
    process.stdout.write(explainRules());
    return 0;
  }

  const providerFlag = parsed.flags.get("--provider");
  const provider = (typeof providerFlag === "string" ? providerFlag : "anthropic") as Provider;
  if (!PROVIDERS.includes(provider)) {
    process.stderr.write(`cacheproof: unknown provider "${String(providerFlag)}" (${PROVIDERS.join(", ")})\n`);
    return 2;
  }
  const json = parsed.flags.has("--json");
  const modelFlag = parsed.flags.get("--model");
  const ratesFlag = parsed.flags.get("--rates");
  const gateFlag = parsed.flags.get("--max-miss-multiple");
  const callsFlag = parsed.flags.get("--calls");

  const maxMissMultiple = typeof gateFlag === "string" ? Number(gateFlag) : 1.0;
  if (!Number.isFinite(maxMissMultiple) || maxMissMultiple < 1) {
    process.stderr.write("cacheproof: --max-miss-multiple must be a number >= 1\n");
    return 2;
  }
  const calls = typeof callsFlag === "string" ? Number(callsFlag) : 1;
  if (!Number.isFinite(calls) || calls < 1) {
    process.stderr.write("cacheproof: --calls must be a number >= 1\n");
    return 2;
  }

  const options: CompareOptions = {
    provider,
    model: typeof modelFlag === "string" ? modelFlag : undefined,
    ratesFile: typeof ratesFlag === "string" ? ratesFlag : undefined,
    maxMissMultiple,
    calls,
    json,
  };

  try {
    if (parsed.command === "price") {
      const table = loadRates(options.ratesFile);
      const resolved = resolveRate(table, provider, options.model);
      const prefixFlag = parsed.flags.get("--tokens-prefix");
      const totalFlag = parsed.flags.get("--tokens-total");
      const prefixTokens = Number(prefixFlag);
      const totalTokens = Number(totalFlag);
      if (!Number.isFinite(prefixTokens) || !Number.isFinite(totalTokens)) {
        process.stderr.write("cacheproof: price needs --tokens-prefix and --tokens-total\n");
        return 2;
      }
      if (totalTokens < prefixTokens) {
        process.stderr.write("cacheproof: --tokens-total must be >= --tokens-prefix\n");
        return 2;
      }
      const price = computePrice(
        { prefixTokens, totalTokens },
        resolved.rate,
        resolved.provider.cache_mode,
      );
      if (json) {
        process.stdout.write(`${JSON.stringify({ tool: "cacheproof", version: VERSION, provider, model: resolved.model, ...price }, null, 2)}\n`);
      } else {
        process.stdout.write(
          `cacheproof ${VERSION} — ${table.display ?? `pricing as of ${table.as_of}`}\n` +
            `${provider} / ${resolved.model}\n\n` +
            `prefix ${price.prefixTokens} tok · tail ${price.tailTokens} tok · total ${price.totalTokens} tok\n` +
            `miss ${price.missCost.toFixed(8)} USD · hit ${price.hitCost.toFixed(8)} USD · ${price.multiple.toFixed(4)}x\n`,
        );
      }
      return 0;
    }

    if (parsed.command !== "check" && parsed.command !== "diff") {
      process.stderr.write(`cacheproof: unknown command "${parsed.command}" (see --help)\n`);
      return 2;
    }

    const [first, second] = parsed.positionals;
    if (!first) {
      process.stderr.write(`cacheproof: ${parsed.command} needs at least one file\n`);
      return 2;
    }

    const pairs: Array<[string, Json, string, Json]> = [];
    if (second) {
      const left = readPayloads(first);
      const right = readPayloads(second);
      if (left.length !== 1 || right.length !== 1) {
        process.stderr.write("cacheproof: when two files are given, each must hold exactly one JSON request\n");
        return 2;
      }
      pairs.push([first, left[0] as Json, second, right[0] as Json]);
    } else {
      const run = readPayloads(first);
      if (run.length < 2) {
        process.stderr.write(`cacheproof: ${first} holds a single request; pass the next request as a second file\n`);
        return 2;
      }
      for (let index = 0; index < run.length - 1; index += 1) {
        pairs.push([
          `${first}#${index + 1}`,
          run[index] as Json,
          `${first}#${index + 2}`,
          run[index + 1] as Json,
        ]);
      }
    }

    let worstExit = 0;
    const rendered: string[] = [];
    for (const [fileA, payloadA, fileB, payloadB] of pairs) {
      const { ctx, exitCode } = comparePair(fileA, payloadA, fileB, payloadB, options);
      worstExit = Math.max(worstExit, exitCode);
      if (parsed.command === "diff") {
        if (json) {
          rendered.push(
            JSON.stringify(
              {
                tool: "cacheproof",
                version: VERSION,
                a: fileA,
                b: fileB,
                offset: ctx.offset,
                clean: ctx.clean,
                changes: ctx.changes.map((change: Change) => ({
                  path: change.path,
                  kind: change.kind,
                  index: change.index ?? null,
                })),
              },
              null,
              2,
            ),
          );
        } else {
          const lines = [
            `${fileA} vs ${fileB}`,
            `first divergence: ${ctx.offset === null ? "none" : `byte ${ctx.offset}`}`,
            ...ctx.changes.map((change: Change) => `  ${change.kind.padEnd(18)} ${change.path}`),
          ];
          rendered.push(lines.join("\n"));
        }
      } else {
        rendered.push(json ? renderJson(ctx).trimEnd() : renderHuman(ctx).trimEnd());
      }
    }

    process.stdout.write(`${rendered.join(parsed.command === "check" && !json ? "\n\n" : "\n")}\n`);
    return parsed.command === "diff" ? 0 : worstExit;
  } catch (error) {
    if (error instanceof IngestError || error instanceof RateError) {
      process.stderr.write(`cacheproof: ${error.message}\n`);
      return 2;
    }
    throw error;
  }
}

if (require.main === module) {
  process.exitCode = main(process.argv.slice(2));
}

export { main };
