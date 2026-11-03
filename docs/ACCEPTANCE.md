# Acceptance — what must be true before this tool is called v0.1.0

Ratified scope: `docs/RESEARCH_OPEN_AI_TOOLING_DEMAND_20261103.md` §7 (four functions, four
acceptance obligations). This file maps each obligation to the check that enforces it, and states the
one thing each check cannot prove.

Run: `npm run build && npm test` → **134 checks, 0 failures**.

| # | Obligation (dossier §7) | Enforced by | Result |
|---|---|---|---|
| 1 | Every rule proven twice — a hostile fixture that must fail and a clean fixture that must pass | 5 hostile + 5 clean fixture pairs, each asserting rule id **and** exit code | 20/20 |
| 2 | The byte-offset locator validated against a hand-built pair with a known split point, not against its own output | `split-point__known` — expected offset produced by `test/fixtures/derive_offsets.py` (Python, its own canonicaliser), never by the TypeScript code under test | pass, offset 524 |
| 3 | The price table's arithmetic unit-tested against §4.2 ($0.00261 / $0.00036 / 7.30×) | `price ::` group, tolerance 1e-5 on costs, 0.01 on the multiple; plus a second provider (DeepSeek, implicit mode) checked against independently computed values | pass |
| 4 | `--max-miss-multiple` boundary tested at exactly 1.0 (equal cost must pass) | flat rate table where write = read = input ⇒ multiple is exactly 1.00×, gated at 1.0 ⇒ exit 0 | pass |
| 5 | Exit 2 must never be conflated with exit 0 | `unusable__not-a-request`, `unusable__no-breakpoint`, missing file, unknown provider, single-payload file | 5/5 exit 2 |
| 6 | Every offset and byte count is a **UTF-8 byte** figure, not a UTF-16 code-unit figure (audit D1) | `byte units` group: canonical bytes equal `Buffer.byteLength(text)`, strictly exceed `text.length`, and the pinned unicode fixture is pinned in bytes; `encoding-unicode__hostile` (926 B) is graded against a byte-derived offset | pass, 926 B / 232 tokens (913 code units), offset 564 |
| 7 | `--json` is honoured by every subcommand that documents it (audit D2) | `diff --json` parsed, asserting `offset` is numeric and `changes` is a non-empty list; the same pair without `--json` still prints prose | pass, offset 524 |
| 8 | A UTF-8 BOM is tolerated, and when the payload is still unreadable the message says so (audit D3) | `encoding-bom__clean` graded at exit 0; a BOM'd non-JSON file is exit 2 with `BOM` in the message | pass, 2/2 |
| 9 | The span byte-accounting is guarded, not merely correct (audit D4) | `byte units`: every span boundary must decode as a complete UTF-8 sequence and the last span must end at the canonical **byte** length; `region`: implicit-prefix (OpenAI) CJK with the change after the prefix stays clean, with a model-swap control proving classification is still live | pass 4/4 (ASCII passes both ways by construction; CJK discriminates); mutation M5 (bytes→code units) fails 4 |

## What each obligation cannot prove

- **Fixtures prove the rules fire on the shapes I thought of.** They cannot prove coverage of shapes I
  did not think of. That is why `unclassified-cached-change` exists: the tool reports a broken prefix
  it cannot name rather than passing it.
- **The independent offset derivation agrees on ASCII payloads.** Both canonicalisers are specified as
  "sorted keys, no insignificant whitespace". The comparison is now made on UTF-8 **bytes** on both
  sides (Python compares `encode("utf-8")`, the tool compares `Buffer`), so a multi-byte payload pins
  a byte offset rather than a code-unit offset — audit D1 was exactly this confusion, and the all-ASCII
  fixture set was blind to it by construction. What is still unproven: escape-style divergence. Python
  `json.dumps` and `JSON.stringify` can escape the same character differently (for example non-ASCII
  emitted literally versus `\uXXXX`), which changes byte offsets without changing the data. The
  unicode and BOM fixtures pin the *escaping this tool actually performs*, not that every escaper in
  the world agrees; a peer implementation that escapes differently would legitimately report a
  different offset. The offset is therefore an internal-consistency claim, not an interchange claim.
- **Price arithmetic is exact; the token count feeding it is not.** `miss`, `hit` and `multiple` are
  exact given the token counts. The counts themselves are `canonical_bytes / 4`, printed with`~`.
- **The 1.0 boundary test uses a synthetic rate table.** Its purpose is to exercise the boundary, not
  to describe a real provider. No provider charges write = read.

## Fixture inventory (16)

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
| `encoding-unicode__hostile` | exit 1, `unclassified-cached-change`, offset pinned at 564, canonical bytes 926 (926 B vs 913 UTF-16 code units — the gap is what audit D1 missed) |
| `encoding-unicode__clean` | exit 0, no rule, canonical bytes 920 |
| `encoding-bom__clean` | exit 0, no rule — the BOM is stripped before parsing, canonical bytes 879 |

Fixtures were authored and committed **before** the detector (commit `72fd930`), and their offsets
were derived by a second implementation at authoring time. The three `encoding-*` fixtures were added
after audit D1/D3 and are pinned by the same independent derivation (`derive_offsets.py`, which now
compares UTF-8 bytes and reads `utf-8-sig`).
