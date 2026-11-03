#!/usr/bin/env python3
"""End-to-end prompt fixtures: real multi-turn request captures for three providers.

AUTHORED BEFORE THE DETECTOR, same rule as test/fixtures/make_fixtures.py: nothing
here imports the tool. This file lays out realistic captured requests and pins what
the CLI must conclude — exit code, rule, first-divergence byte, canonical byte
counts, token counts and the two dollar figures. Offsets and sizes are derived by
this file's own canonicaliser (sorted keys, no insignificant whitespace, UTF-8
bytes), i.e. by an implementation that is not the one under test.

What each provider pair is for:
  <p>/turn1.json + <p>/turn2_clean.json   a healthy second turn (append-only):
                                          the cached prefix is intact → exit 0.
  <p>/turn1.json + <p>/turn2_broken.json  one per-call value moved inside the
                                          cached prefix: cache dies, no error,
                                          no log line → exit 1 + a named rule.

Providers differ in where the cache lives, and the fixtures say so:
  anthropic  explicit  — cache_control breakpoints; the cached region is the wire
                         order (tools[], system[], messages[]) up to the LAST one.
  openai     implicit  — longest previously-computed prefix, 1024-token floor.
  deepseek   implicit  — exact prefix match, no floor.

Run:  python3 test/e2e/gen_prompts.py [outdir]      (default: ./fixtures next to this file)
       the harness passes a throwaway directory, so a stale fixture cannot be graded
"""
import json
import math
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
RATES = os.path.join(ROOT, "rates", "rates.json")

# ---------------------------------------------------------------------------
# Independent canonicaliser — the same one-line spec the tool declares:
# sorted keys, no insignificant whitespace, positions counted in UTF-8 bytes.
# ---------------------------------------------------------------------------


def canonical_bytes(value):
    text = json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return text.encode("utf-8")


def first_divergence(a, b):
    limit = min(len(a), len(b))
    for i in range(limit):
        if a[i] != b[i]:
            return i
    return None if len(a) == len(b) else limit


def estimate_tokens(byte_count):
    # Match the tool's declared estimator exactly: max(1, round(bytes / 4)) where
    # round is half-UP. Python's round() is half-even, which disagreed by one token
    # on 2834 bytes and changed a dollar figure in the fifth decimal — a rounding
    # difference, not a defect, but an instrument that silently disagrees with its
    # subject is worse than one that fails loudly.
    return max(1, int(math.floor(byte_count / 4.0 + 0.5)))


# ---------------------------------------------------------------------------
# Realistic request material
# ---------------------------------------------------------------------------

HOUSE_RULES = (
    "HOUSE RULES (stable, never edit):\n"
    "1. Answer with the smallest correct diff.\n"
    "2. Never invent a file path; read before you write.\n"
    "3. Money paths are append-only; migrations are reversible.\n"
    "4. Cite the artifact, not your memory of it.\n"
    "5. If a check cannot decide, say so instead of guessing.\n"
)

POLICY = (
    "REFUND POLICY (stable): refunds are computed in integer minor units. "
    "Proration is daily, not monthly. Any invoice under 5 USD is not refundable "
    "after 30 days. Tax is never refunded; it is credited. "
)

CONTEXT = (
    "REPOSITORY CONTEXT (stable):\n"
    "src/billing/invoice.ts:412 — tax rounding uses half-even, not half-up.\n"
    "src/billing/proration.ts:88 — proration is computed in minor units.\n"
    "docs/adr/0007-money.md — all money is integer cents; floats are banned.\n"
)

TOOLS_ANTHROPIC = [
    {
        "name": "read_file",
        "description": "Read a file from the repository.",
        "input_schema": {
            "type": "object",
            "properties": {"path": {"type": "string"}},
            "required": ["path"],
        },
    },
    {
        "name": "list_invoices",
        "description": "List invoices for a customer, newest first.",
        "input_schema": {
            "type": "object",
            "properties": {"customer_id": {"type": "string"}, "limit": {"type": "integer"}},
            "required": ["customer_id"],
        },
    },
]

TOOLS_OPENAI = [
    {
        "type": "function",
        "function": {
            "name": "read_file",
            "description": "Read a file from the repository.",
            "parameters": {
                "type": "object",
                "properties": {"path": {"type": "string"}},
                "required": ["path"],
            },
        },
    }
]

Q1 = "Why did invoice 8841 come out 2 cents short?"
Q2 = "Show me the line that rounds it."
A1 = "Half-even rounding in src/billing/invoice.ts:412: 2.5 rounds to 2, not 3."


def stable_system_text():
    return (
        "You are a billing engineer's assistant working inside a payments repository.\n\n"
        + HOUSE_RULES
        + "\n"
        + CONTEXT
        + "\n"
        + POLICY
        * 1
    )


def volatile_line(provider_tag):
    """The per-call value that quietly kills the cache: a session stamp."""
    return "Session %s for tenant t_8841.\n" % provider_tag


# ---------------------------------------------------------------------------
# Anthropic — explicit breakpoint on system[0]
# ---------------------------------------------------------------------------


def anthropic_requests():
    stable = stable_system_text()
    stamp = "2026-11-04T03:12:44Z"

    def build(system_text, messages):
        return {
            "model": "claude-3-5-sonnet",
            "max_tokens": 1024,
            "tools": TOOLS_ANTHROPIC,
            "system": [
                {
                    "type": "text",
                    "text": system_text,
                    "cache_control": {"type": "ephemeral"},
                }
            ],
            "messages": messages,
        }

    turn1 = build(stable, [{"role": "user", "content": [{"type": "text", "text": Q1}]}])

    # Healthy second turn: the conversation grows BELOW the breakpoint.
    clean = build(
        stable,
        [
            {"role": "user", "content": [{"type": "text", "text": Q1}]},
            {"role": "assistant", "content": [{"type": "text", "text": A1}]},
            {"role": "user", "content": [{"type": "text", "text": Q2}]},
        ],
    )

    # Broken second turn: a session stamp lands INSIDE the cached system block.
    broken_text = stable.replace(HOUSE_RULES, volatile_line(stamp) + HOUSE_RULES)
    broken = build(
        broken_text,
        [{"role": "user", "content": [{"type": "text", "text": Q1}]}],
    )

    # Must-stay-clean control: the change is AFTER the breakpoint (`max_tokens`),
    # so no cached byte moved even though the request body differs.
    tail = build(stable, [{"role": "user", "content": [{"type": "text", "text": Q1}]}])
    tail["max_tokens"] = 2048
    return turn1, clean, broken, tail


# ---------------------------------------------------------------------------
# OpenAI — implicit prefix, 1024-token floor
# ---------------------------------------------------------------------------


def openai_requests():
    stable = stable_system_text() * 3  # comfortably above the 1024-token floor
    stamp = "2026-11-04T03:12:44Z"

    def build(system_text, messages):
        return {
            "model": "gpt-4o",
            "temperature": 0,
            "tools": TOOLS_OPENAI,
            "messages": [{"role": "system", "content": system_text}] + messages,
        }

    turn1 = build(stable, [{"role": "user", "content": Q1}])

    clean = build(
        stable,
        [
            {"role": "user", "content": Q1},
            {"role": "assistant", "content": A1},
            {"role": "user", "content": Q2},
        ],
    )

    broken = build(
        stable.replace(CONTEXT, volatile_line(stamp) + CONTEXT),
        [{"role": "user", "content": Q1}],
    )
    return turn1, clean, broken, None


# ---------------------------------------------------------------------------
# DeepSeek — implicit prefix, exact match, no floor
# ---------------------------------------------------------------------------


def deepseek_requests():
    stable = stable_system_text() * 2

    def build(system_text, messages):
        return {
            "model": "deepseek-v3",
            "stream": False,
            "messages": [{"role": "system", "content": system_text}] + messages,
        }

    turn1 = build(stable, [{"role": "user", "content": Q1}])

    clean = build(
        stable,
        [
            {"role": "user", "content": Q1},
            {"role": "assistant", "content": A1},
            {"role": "user", "content": Q2},
        ],
    )

    # A policy edit with no volatile shape: still a dead prefix, cause unnamed.
    broken = build(
        stable.replace("Any invoice under 5 USD", "Any invoice under 4 USD"),
        [{"role": "user", "content": Q1}],
    )
    return turn1, clean, broken, None


# ---------------------------------------------------------------------------
# Expectations
# ---------------------------------------------------------------------------


def wire_blocks(raw):
    """Provider wire order: tools[], system[], messages[] — the cached prefix runs
    from the start of the wire order through the last cache_control block."""
    blocks = []

    def collect(entries, path_of):
        if not isinstance(entries, list):
            return
        for index, entry in enumerate(entries):
            path = path_of(index)
            if isinstance(entry, dict):
                blocks.append((path, entry))
                content = entry.get("content")
                if isinstance(content, list):
                    for inner_index, inner in enumerate(content):
                        if isinstance(inner, dict):
                            blocks.append(("%s.content[%d]" % (path, inner_index), inner))

    collect(raw.get("tools"), lambda i: "tools[%d]" % i)
    collect(raw.get("system"), lambda i: "system[%d]" % i)
    collect(raw.get("messages"), lambda i: "messages[%d]" % i)
    return blocks


def cached_prefix_bytes(raw, cache_mode):
    """Bytes of the cached prefix, derived here, not read off the tool."""
    if cache_mode != "explicit":
        return None  # implicit: the shared prefix decides, computed per pair
    blocks = wire_blocks(raw)
    last = -1
    for index, (_, value) in enumerate(blocks):
        if isinstance(value, dict) and "cache_control" in value:
            last = index
    if last < 0:
        return None
    total = 0
    for _, value in blocks[: last + 1]:
        total += len(canonical_bytes(value))
    return total


def price(prefix_bytes, total_bytes, rate, cache_mode):
    prefix_tokens = estimate_tokens(prefix_bytes)
    total_tokens = estimate_tokens(total_bytes)
    prefix_tokens = max(0, round(prefix_tokens))
    total_tokens = max(prefix_tokens, round(total_tokens))
    tail = total_tokens - prefix_tokens
    per = lambda value, mtok: (value / 1_000_000.0) * mtok
    miss = (
        per(total_tokens, rate["cache_write_per_mtok"])
        if cache_mode == "explicit"
        else per(total_tokens, rate["input_per_mtok"])
    )
    hit = per(prefix_tokens, rate["cache_read_per_mtok"]) + per(tail, rate["input_per_mtok"])
    multiple = (miss / hit) if hit > 0 else None
    return {
        "prefix_tokens": int(prefix_tokens),
        "total_tokens": int(total_tokens),
        "tail_tokens": int(tail),
        "miss_cost_usd": round(miss, 12),
        "hit_cost_usd": round(hit, 12),
        "miss_multiple": (round(multiple, 6) if multiple is not None else None),
    }


def expectations(provider, model, cache_mode, rate, turn1, counterpart, case):
    a_bytes = canonical_bytes(turn1)
    b_bytes = canonical_bytes(counterpart)
    offset = first_divergence(a_bytes, b_bytes)

    if cache_mode == "explicit":
        prefix = cached_prefix_bytes(counterpart, cache_mode)
        shared = 0 if (offset is not None and offset < 200) else None
    else:
        prefix = len(a_bytes) if offset is None else offset
        shared = prefix

    clean = case["exit"] == 0
    if cache_mode == "explicit":
        # For an explicit provider the cached prefix is the sum of the cached
        # blocks as they appear in B; a stamp inside the block leaves nothing.
        prefix = cached_prefix_bytes(counterpart, cache_mode)
        if cache_mode == "explicit" and not clean:
            prefix = cached_prefix_bytes(counterpart, cache_mode)
    priced = price(prefix, len(b_bytes), rate, cache_mode)
    return {
        "exit": case["exit"],
        "rule": case["rule"],
        "offset": offset,
        "canonical_bytes_a": len(a_bytes),
        "canonical_bytes_b": len(b_bytes),
        "cached_bytes_a": cached_prefix_bytes(turn1, cache_mode),
        "cached_bytes_b": cached_prefix_bytes(counterpart, cache_mode),
        "shared_bytes": shared,
        "tokens_a": estimate_tokens(len(a_bytes)),
        "tokens_b": estimate_tokens(len(b_bytes)),
        **priced,
    }


def main(outdir=None):
    rates = json.load(open(RATES, encoding="utf-8"))
    root = outdir or os.path.join(HERE, "fixtures")
    rows = []

    providers = [
        ("anthropic", "claude-3-5-sonnet", "explicit", anthropic_requests),
        ("openai", "gpt-4o", "implicit", openai_requests),
        ("deepseek", "deepseek-v3", "implicit", deepseek_requests),
    ]

    for provider, model, cache_mode, factory in providers:
        turn1, clean, broken, tail = factory()
        rate = rates["providers"][provider]["models"][model]
        directory = os.path.join(root, provider)
        os.makedirs(directory, exist_ok=True)

        for name, payload in (
            ("turn1.json", turn1),
            ("turn2_clean.json", clean),
            ("turn2_broken.json", broken),
        ):
            with open(os.path.join(directory, name), "w", encoding="utf-8") as handle:
                handle.write(json.dumps(payload, indent=2, ensure_ascii=False) + "\n")

        if tail is not None:
            with open(os.path.join(directory, "turn2_tail.json"), "w", encoding="utf-8") as handle:
                handle.write(json.dumps(tail, indent=2, ensure_ascii=False) + "\n")

        expected = {
            "provider": provider,
            "model": model,
            "cache_mode": cache_mode,
            "unit": "utf-8 bytes",
            "derived_by": "test/e2e/gen_prompts.py — own canonicaliser, does not import the tool",
            "clean": expectations(provider, model, cache_mode, rate, turn1, clean, {"exit": 0, "rule": None}),
            "broken": expectations(
                provider,
                model,
                cache_mode,
                rate,
                turn1,
                broken,
                {"exit": 1, "rule": case_rule(provider)},
            ),
        }
        with open(os.path.join(directory, "expected.json"), "w", encoding="utf-8") as handle:
            handle.write(json.dumps(expected, indent=2) + "\n")
        if tail is not None:
            expected["tail"] = expectations(
                provider,
                model,
                cache_mode,
                rate,
                turn1,
                tail,
                {"exit": 0, "rule": None},
            )
            with open(os.path.join(directory, "expected.json"), "w", encoding="utf-8") as handle:
                handle.write(json.dumps(expected, indent=2) + "\n")
        rows.append((provider, expected["clean"]["offset"], expected["broken"]["offset"]))

    for provider, clean_offset, broken_offset in rows:
        print("%-10s clean offset %-6s broken offset %-6s" % (provider, clean_offset, broken_offset))


def case_rule(provider):
    return {
        "anthropic": "volatile-above-breakpoint",
        "openai": "volatile-above-breakpoint",
        "deepseek": "unclassified-cached-change",
    }[provider]


if __name__ == "__main__":
    sys.exit(main(sys.argv[1] if len(sys.argv) > 1 else None))
