#!/usr/bin/env python3
"""Fixture generator for cacheproof v0.1.0.

AUTHORED BEFORE THE DETECTOR (ratified plan, item 3). Nothing in this file
imports the tool; it only lays out request payloads and pins what the detector
must conclude. If a fixture and the detector disagree, the fixture is the spec
until a COO ruling says otherwise.

Run:  python3 make_fixtures.py        (writes ./*/a.json, b.json, expected.json)
"""
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))

HOUSE_RULES = (
    "HOUSE RULES (stable, never edit):\n"
    "1. Answer with the smallest correct diff.\n"
    "2. Never invent a file path; read before you write.\n"
    "3. Money paths are append-only; migrations are reversible.\n"
    "4. Cite the artifact, not your memory of it.\n"
    "5. If a check cannot decide, say so instead of guessing.\n"
)

RETRIEVED = (
    "RETRIEVED CONTEXT (top 3 chunks, reranked):\n"
    "[1] src/billing/invoice.ts:412 — tax rounding uses half-even, not half-up.\n"
    "[2] src/billing/proration.ts:88 — proration is computed in minor units.\n"
    "[3] docs/adr/0007-money.md — all money is integer cents; floats are banned.\n"
)

QUESTION_A = "Why did invoice 8841 come out 2 cents short?"
QUESTION_B = "Why did invoice 8841 come out 3 cents short?"

TOOLS = [
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
        "name": "run_tests",
        "description": "Run the test suite and return the summary.",
        "input_schema": {
            "type": "object",
            "properties": {"pattern": {"type": "string"}},
            "required": [],
        },
    },
]

BREAK = {"type": "ephemeral"}


def payload(model="claude-3-5-sonnet-20241022", tools=None, system=None, messages=None,
            max_tokens=1024):
    return {
        "model": model,
        "max_tokens": max_tokens,
        "tools": [dict(t) for t in (tools if tools is not None else TOOLS)],
        "system": [dict(s) for s in (system if system is not None else default_system())],
        "messages": [dict(m) for m in (messages if messages is not None else default_messages())],
    }


def default_system():
    return [{"type": "text", "text": HOUSE_RULES, "cache_control": dict(BREAK)}]


def default_messages():
    return [{"role": "user", "content": [{"type": "text", "text": QUESTION_A}]}]


def write_case(name, a, b, expected, bom=False):
    d = os.path.join(HERE, name)
    os.makedirs(d, exist_ok=True)
    enc = "utf-8-sig" if bom else "utf-8"
    for fn, obj in (("a.json", a), ("b.json", b)):
        with open(os.path.join(d, fn), "w", encoding=enc) as fh:
            json.dump(obj, fh, indent=2, sort_keys=False)
            fh.write("\n")
    with open(os.path.join(d, "expected.json"), "w", encoding="utf-8") as fh:
        json.dump(expected, fh, indent=2, sort_keys=True)
        fh.write("\n")
    return name


CASES = []


def case(name, a, b, expected, bom=False):
    CASES.append(write_case(name, a, b, expected, bom=bom))


# ---------------------------------------------------------------- R1 volatile
# A session timestamp lives inside the cached system block. Same request shape,
# same question, but the prefix is rewritten every call.
sys_a = [{"type": "text", "text": "SESSION clock: 2026-11-04T02:41:07Z\n" + HOUSE_RULES,
          "cache_control": dict(BREAK)}]
sys_b = [{"type": "text", "text": "SESSION clock: 2026-11-04T02:41:38Z\n" + HOUSE_RULES,
          "cache_control": dict(BREAK)}]
case("r1-volatile-above-breakpoint__hostile", payload(system=sys_a), payload(system=sys_b), {
    "rule": "volatile-above-breakpoint",
    "exit": 1,
    "why": "only the ISO-8601 timestamp inside the cached system block differs",
})

# Same clock, but the volatile value sits BELOW the breakpoint (in the question).
msgs_a = [{"role": "user", "content": [{"type": "text", "text": QUESTION_A + " [at 02:41:07Z]"}]}]
msgs_b = [{"role": "user", "content": [{"type": "text", "text": QUESTION_A + " [at 02:41:38Z]"}]}]
case("r1-volatile-below-breakpoint__clean", payload(messages=msgs_a), payload(messages=msgs_b), {
    "rule": None,
    "exit": 0,
    "why": "volatile value is below the cache breakpoint; the cached prefix is intact",
})

# ---------------------------------------------------------------- R2 tool order
case("r2-tool-order__hostile", payload(tools=TOOLS), payload(tools=list(reversed(TOOLS))), {
    "rule": "tool-order",
    "exit": 1,
    "why": "identical tool definitions, reversed array order",
})

case("r2-tool-order__clean", payload(), payload(messages=(
    [{"role": "user", "content": [{"type": "text", "text": QUESTION_B}]}])), {
    "rule": None,
    "exit": 0,
    "why": "tools untouched; only the trailing question changed",
})

# ---------------------------------------------------------- R3 retrieval insert
sys_stable = [{"type": "text", "text": HOUSE_RULES, "cache_control": dict(BREAK)}]
sys_with_retrieval = [{"type": "text", "text": RETRIEVED}, {"type": "text", "text": HOUSE_RULES,
                                                            "cache_control": dict(BREAK)}]
case("r3-retrieval-insert__hostile", payload(system=sys_stable),
     payload(system=sys_with_retrieval), {
         "rule": "retrieval-insert",
         "exit": 1,
         "why": "a retrieved-context block is injected above the breakpoint",
     })

msgs_ret = [{"role": "user", "content": [
    {"type": "text", "text": RETRIEVED},
    {"type": "text", "text": QUESTION_A},
]}]
case("r3-retrieval-insert__clean", payload(), payload(messages=msgs_ret), {
    "rule": None,
    "exit": 0,
    "why": "retrieval appended below the breakpoint; the cached prefix is intact",
})

# ------------------------------------------------------- R4 instruction prefix
sys_ins = [{"type": "text", "text": "FOCUS: billing migration only.\n" + HOUSE_RULES,
            "cache_control": dict(BREAK)}]
case("r4-instruction-prefix__hostile", payload(), payload(system=sys_ins), {
    "rule": "instruction-prefix",
    "exit": 1,
    "why": "a per-call instruction block is concatenated in FRONT of the stable rules",
})

msgs_ins = [{"role": "user", "content": [
    {"type": "text", "text": "FOCUS: billing migration only."},
    {"type": "text", "text": QUESTION_A},
]}]
case("r4-instruction-prefix__clean", payload(), payload(messages=msgs_ins), {
    "rule": None,
    "exit": 0,
    "why": "the per-call instruction rides below the breakpoint",
})

# --------------------------------------------------------------- R5 template swap
case("r5-template-swap__hostile", payload(),
     payload(model="claude-3-7-sonnet-20250219"), {
         "rule": "template-swap",
         "exit": 1,
         "why": "model change re-tokenises the cached region",
     })

case("r5-template-swap__clean", payload(), payload(max_tokens=2048), {
    "rule": None,
    "exit": 0,
    "why": "max_tokens rides after the cached region; nothing cacheable moved",
})

# ------------------------------------------------------------- cannot decide
case("unusable__not-a-request", payload(), {"note": "this is not a request"}, {
    "rule": None,
    "exit": 2,
    "why": "no model/system/messages shape: not comparable",
})

case("unusable__no-breakpoint", payload(system=[{"type": "text", "text": HOUSE_RULES}]), payload(
    system=[{"type": "text", "text": HOUSE_RULES}]), {
        "rule": None,
        "exit": 2,
        "why": "provider anthropic needs an explicit cache_control breakpoint; none declared",
    })

# ----------------------------------------------------- known split point (byte offset)
# Constructed so the ONLY difference is the literal marker in the system text.
MARKER_A = "AAAAA|SPLIT-HERE|BBBBB"
MARKER_B = "AAAAA|MOVED-HERE|BBBBB"
split_a = payload(system=[{"type": "text", "text": HOUSE_RULES + MARKER_A, "cache_control": dict(BREAK)}])
split_b = payload(system=[{"type": "text", "text": HOUSE_RULES + MARKER_B, "cache_control": dict(BREAK)}])
case("split-point__known", split_a, split_b, {
    "rule": "unclassified-cached-change",
    "exit": 1,
    "why": "single in-prefix edit that matches no named volatile pattern",
    "offset_derived_by": "derive_offsets.py (independent of the ts canonicaliser)",
})

# ------------------------------------------------- encoding (audit D1 regression)
# The divergence lands AFTER multi-byte text, so a UTF-16 code-unit implementation
# reports a smaller offset than the true UTF-8 byte offset. An all-ASCII suite is
# blind to that by construction.
UNICODE_PREFIX = "Stable \u2615\ufe0f \u65e5\u672c\u8a9e \u00e9 \U0001f680 prefix.\n"
uni_a = [{"type": "text", "text": UNICODE_PREFIX + HOUSE_RULES + "MARK-A", "cache_control": dict(BREAK)}]
uni_b = [{"type": "text", "text": UNICODE_PREFIX + HOUSE_RULES + "MARK-B", "cache_control": dict(BREAK)}]
case("encoding-unicode__hostile", payload(system=uni_a), payload(system=uni_b), {
    "rule": "unclassified-cached-change",
    "exit": 1,
    "why": "divergence lands after multi-byte text; offsets must be UTF-8 bytes, not UTF-16 units",
})

uni_msgs_a = [{"role": "user", "content": [{"type": "text", "text": UNICODE_PREFIX + QUESTION_A}]}]
uni_msgs_b = [{"role": "user", "content": [{"type": "text", "text": UNICODE_PREFIX + QUESTION_B}]}]
case("encoding-unicode__clean", payload(messages=uni_msgs_a), payload(messages=uni_msgs_b), {
    "rule": None,
    "exit": 0,
    "why": "multi-byte text in the tail only; the cached prefix is intact",
})

# A JSON file saved with a UTF-8 BOM is still JSON (audit D3).
case("encoding-bom__clean", payload(), payload(messages=(
    [{"role": "user", "content": [{"type": "text", "text": QUESTION_B}]}])), {
    "rule": None,
    "exit": 0,
    "why": "a UTF-8 BOM must not turn a valid request into a cannot-decide",
}, bom=True)

if __name__ == "__main__":
    print(f"wrote {len(CASES)} fixtures")
    for c in CASES:
        print(" ", c)
    sys.exit(0)
