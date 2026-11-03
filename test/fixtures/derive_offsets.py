#!/usr/bin/env python3
"""Independent derivation of the expected first-divergence offset.

Two implementations must agree before an offset means anything:
  * this one (Python, json.dumps sorted keys, separators=(',', ':')),
  * the TypeScript canonicaliser in src/canonical.ts.
They are written from the same one-line spec — "sorted keys, no insignificant
whitespace" — not from each other. Independence is exact for ASCII payloads,
which is why every fixture is ASCII.

Writes "offset" (and "shared_bytes") into each expected.json.
Run:  python3 derive_offsets.py
"""
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))


def canonical(obj):
    return json.dumps(obj, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def first_divergence(a, b):
    n = min(len(a), len(b))
    for i in range(n):
        if a[i] != b[i]:
            return i
    return None if len(a) == len(b) else n


def main():
    rows = []
    for name in sorted(os.listdir(HERE)):
        d = os.path.join(HERE, name)
        if not os.path.isdir(d):
            continue
        pa, pb = os.path.join(d, "a.json"), os.path.join(d, "b.json")
        pe = os.path.join(d, "expected.json")
        if not (os.path.exists(pa) and os.path.exists(pb) and os.path.exists(pe)):
            continue
        with open(pa, encoding="utf-8") as fh:
            a = json.load(fh)
        with open(pb, encoding="utf-8") as fh:
            b = json.load(fh)
        ca, cb = canonical(a), canonical(b)
        off = first_divergence(ca, cb)
        with open(pe, encoding="utf-8") as fh:
            exp = json.load(fh)
        if off is None:
            exp["offset"] = None
            exp["shared_bytes"] = len(ca)
        else:
            exp["offset"] = off
            exp["shared_bytes"] = off
            exp["expected_byte_a"] = ca[off]
            exp["expected_byte_b"] = cb[off]
        exp["canonical_bytes_a"] = len(ca)
        exp["canonical_bytes_b"] = len(cb)
        with open(pe, "w", encoding="utf-8") as fh:
            json.dump(exp, fh, indent=2, sort_keys=True)
            fh.write("\n")
        rows.append((name, exp.get("rule"), exp.get("exit"), exp.get("offset"),
                     len(ca), len(cb)))
    print(f"{'case':38s} {'rule':32s} exit  offset   |a|    |b|")
    for r in rows:
        print(f"{r[0]:38s} {str(r[1]):32s} {r[2]:4d}  {str(r[3]):7s} {r[4]:6d} {r[5]:6d}")
    print(f"\n{len(rows)} fixtures")
    return 0


if __name__ == "__main__":
    sys.exit(main())
