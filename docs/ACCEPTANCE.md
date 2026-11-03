# Acceptance — what must be true before this tool is called v0.1.0

Ratified scope: `docs/RESEARCH_OPEN_AI_TOOLING_DEMAND_20261103.md` §7 (four functions, four
acceptance obligations). This file maps each obligation to the check that enforces it, and states the
one thing each check cannot prove.

Run: `npm run build && npm test` → **94 checks, 0 failures**.

| # | Obligation (dossier §7) | Enforced by | Result |
|---|---|---|---|
| 1 | Every rule proven twice — a hostile fixture that must fail and a clean fixture that must pass | 5 hostile + 5 clean fixture pairs, each asserting rule id **and** exit code | 20/20 |
| 2 | The byte-offset locator validated against a hand-built pair with a known split point, not against its own output | `split-point__known` — expected offset produced by `test/fixtures/derive_offsets.py` (Python, its own canonicaliser), never by the TypeScript code under test | pass, offset 524 |
| 3 | The price table's arithmetic unit-tested against §4.2 ($0.00261 / $0.00036 / 7.30×) | `price ::` group, tolerance 1e-5 on costs, 0.01 on the multiple; plus a second provider (DeepSeek, implicit mode) checked against independently computed values | pass |
| 4 | `--max-miss-multiple` boundary tested at exactly 1.0 (equal cost must pass) | flat rate table where write = read = input ⇒ multiple is exactly 1.00×, gated at 1.0 ⇒ exit 0 | pass |
| 5 | Exit 2 must never be conflated with exit 0 | `unusable__not-a-request`, `unusable__no-breakpoint`, missing file, unknown provider, single-payload file | 5/5 exit 2 |

## What each obligation cannot prove

- **Fixtures prove the rules fire on the shapes I thought of.** They cannot prove coverage of shapes I
  did not think of. That is why `unclassified-cached-change` exists: the tool reports a broken prefix
  it cannot name rather than passing it.
- **The independent offset derivation agrees on ASCII payloads.** Both canonicalisers are specified as
  "sorted keys, no insignificant whitespace"; non-ASCII escaping (control characters, astral plane)
  may differ between Python's `json.dumps` and `JSON.stringify`. Every fixture here is ASCII by
  construction. A non-ASCII fixture would test the escaper, not the offset.
- **Price arithmetic is exact; the token count feeding it is not.** `miss`, `hit` and `multiple` are
  exact given the token counts. The counts themselves are `canonical_bytes / 4`, printed with`~`.
- **The 1.0 boundary test uses a synthetic rate table.** Its purpose is to exercise the boundary, not
  to describe a real provider. No provider charges write = read.

## Fixture inventory (13)

| Fixture | Expectation |
|---|---|
| `r1-volatile-above-breakpoint__hostile` | exit 1, `volatile-above-breakpoint` |
| `r1-volatile-below-breakpoint__clean` | exit 0, no rule |
| `r2-tool-order__hostile` | exit 1, `tool-order` |
| `r2-tool-order__clean` | exit 0, no rule |
| `r3-retrieval-insert__hostile` | exit 1, `retrieval-insert` |
| `r3-retrieval-insert__clean` | exit 0, no rule |
| `r4-instruction-prefix__hostile` | exit 1, `instruction-prefix` |
| `r4-instruction-prefix__clean` | exit 0, no rule |
| `r5-template-swap__hostile` | exit 1, `template-swap` |
| `r5-template-swap__clean` | exit 0, no rule |
| `split-point__known` | exit 1, `unclassified-cached-change`, offset pinned at 524 |
| `unusable__not-a-request` | exit 2 |
| `unusable__no-breakpoint` | exit 2 |

Fixtures were authored and committed **before** the detector (commit `72fd930`), and their offsets
were derived by a second implementation at authoring time.
