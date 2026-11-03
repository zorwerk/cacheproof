import { Change } from "./diff";
import { Classification, RULE_DESCRIPTIONS } from "./classify";
import { Price, RateTable, formatMultiple, formatUsd } from "./price";
import { Provider } from "./ingest";

export interface ReportContext {
  version: string;
  provider: Provider;
  model: string;
  rates: RateTable;
  aBytes: number;
  bBytes: number;
  cachedBytesA: number;
  cachedBytesB: number;
  sharedBytes: number;
  breakpointPath?: string;
  offset: number | null;
  contextA: string;
  contextB: string;
  classification: Classification;
  changes: Change[];
  price: Price;
  maxMissMultiple: number;
  calls: number;
  notes: string[];
  clean: boolean;
  exitCode: number;
}

function human(bytes: number): string {
  return `${bytes} B`;
}

function truncate(value: string, limit = 120): string {
  if (value.length <= limit) return value;
  return `${value.slice(0, limit - 1)}…`;
}

export function renderHuman(ctx: ReportContext): string {
  const lines: string[] = [];
  const pricingLine = ctx.rates.display ?? `Pricing as of ${ctx.rates.as_of}`;

  lines.push(`cacheproof ${ctx.version} — ${pricingLine}`);
  lines.push(`provider ${ctx.provider} · model ${ctx.model}${ctx.breakpointPath ? ` · breakpoint ${ctx.breakpointPath}` : " · implicit prefix"}`);
  lines.push("");
  lines.push(`request A  ${human(ctx.aBytes)} canonical (~${Math.round(ctx.aBytes / 4)} tokens, estimated)`);
  lines.push(`request B  ${human(ctx.bBytes)} canonical (~${Math.round(ctx.bBytes / 4)} tokens, estimated)`);
  const share = ctx.cachedBytesB > 0 ? (ctx.sharedBytes / ctx.cachedBytesB) * 100 : 0;
  lines.push(
    `cached prefix  A ${human(ctx.cachedBytesA)} · B ${human(ctx.cachedBytesB)} · shared ${human(ctx.sharedBytes)} (${share.toFixed(1)}%)`,
  );
  lines.push("");

  if (ctx.offset === null) {
    lines.push("first divergence: none — the requests are byte-identical in canonical form");
  } else {
    lines.push(`first divergence: byte ${ctx.offset} of the canonical serialisation`);
    lines.push(`  A …${truncate(ctx.contextA)}…`);
    lines.push(`  B …${truncate(ctx.contextB)}…`);
  }
  lines.push("");

  if (ctx.clean) {
    lines.push("verdict: CLEAN — the cached prefix is intact");
  } else {
    const rule = ctx.classification.rule ?? "unknown";
    lines.push(`verdict: BROKEN PREFIX — rule ${rule} (${ctx.classification.confidence})`);
    if (ctx.classification.rule) {
      lines.push(`  ${RULE_DESCRIPTIONS[ctx.classification.rule]}`);
    }
    for (const evidence of ctx.classification.evidence) {
      lines.push(`  evidence: ${evidence}`);
    }
  }
  if (ctx.changes.length > 0 && !ctx.clean) {
    const changedPaths = [...new Set(ctx.changes.map((change) => change.path))].slice(0, 8);
    lines.push(`  paths: ${changedPaths.join(", ")}`);
  }
  lines.push("");

  const p = ctx.price;
  if (ctx.clean) {
    lines.push(
      `cost per request with the prefix intact: ${formatUsd(p.hitCost)}  ` +
        `(prefix ~${p.prefixTokens} tok · tail ~${p.tailTokens} tok)`,
    );
    lines.push(
      `  a broken prefix would cost ${formatUsd(p.missCost)} — ${formatMultiple(p.multiple)} more, ` +
        `with no error and no log line`,
    );
    if (ctx.calls > 1) {
      lines.push(
        `  at ${ctx.calls} calls: ${formatUsd(p.hitCost * ctx.calls)} with the cache vs ` +
          `${formatUsd(p.missCost * ctx.calls)} without`,
      );
    }
  } else {
    lines.push(
      `cost per request as measured (prefix broken): ${formatUsd(p.missCost)}  ` +
        `(prefix ~${p.prefixTokens} tok of ~${p.totalTokens} tok)`,
    );
    lines.push(
      `  with a live prefix it would be ${formatUsd(p.hitCost)} — ${formatMultiple(p.multiple)} less`,
    );
    if (ctx.calls > 1) {
      lines.push(
        `  at ${ctx.calls} calls: ${formatUsd(p.missCost * ctx.calls)} vs ${formatUsd(p.hitCost * ctx.calls)} ` +
          `(burning ${formatUsd((p.missCost - p.hitCost) * ctx.calls)})`,
      );
    }
  }
  lines.push("");

  for (const note of ctx.notes) lines.push(`note: ${note}`);

  lines.push(`gate: --max-miss-multiple ${ctx.maxMissMultiple.toFixed(2)} → exit ${ctx.exitCode}`);
  return `${lines.join("\n").trimEnd()}\n`;
}

export function renderJson(ctx: ReportContext): string {
  return `${JSON.stringify(
    {
      tool: "cacheproof",
      version: ctx.version,
      provider: ctx.provider,
      model: ctx.model,
      pricing: { as_of: ctx.rates.as_of, display: ctx.rates.display ?? null, sources: ctx.rates.sources ?? null },
      requests: {
        a: { canonical_bytes: ctx.aBytes, cached_bytes: ctx.cachedBytesA },
        b: { canonical_bytes: ctx.bBytes, cached_bytes: ctx.cachedBytesB },
        shared_bytes: ctx.sharedBytes,
      },
      breakpoint: ctx.breakpointPath ?? null,
      offset: ctx.offset,
      classification: {
        rule: ctx.classification.rule,
        confidence: ctx.classification.confidence,
        in_cached_region: ctx.classification.inCachedRegion,
        evidence: ctx.classification.evidence,
      },
      changes: ctx.changes.map((change) => ({
        path: change.path,
        kind: change.kind,
        index: change.index ?? null,
      })),
      price: {
        prefix_tokens: ctx.price.prefixTokens,
        total_tokens: ctx.price.totalTokens,
        tail_tokens: ctx.price.tailTokens,
        miss_cost_usd: ctx.price.missCost,
        hit_cost_usd: ctx.price.hitCost,
        miss_multiple: Number.isFinite(ctx.price.multiple) ? ctx.price.multiple : null,
        token_estimate: "canonical_bytes/4 — cacheproof ships no tokeniser",
      },
      calls: ctx.calls,
      gate: { max_miss_multiple: ctx.maxMissMultiple, exit: ctx.exitCode },
      clean: ctx.clean,
      notes: ctx.notes,
    },
    null,
    2,
  )}\n`;
}
