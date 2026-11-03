# cacheproof

**Your agent's prompt cache silently died at byte 412. Here is the field that killed it, and what it cost.**

Prompt caching is byte-exact: the provider hashes a prefix, and any change above the breakpoint
turns a 0.1× cache read into a 1.25× cache write — with **no error, no warning and no log line**.
The only trace is a counter that reads `0`.

`cacheproof` is a linter for that failure. It takes two captured requests, finds the first byte that
diverged, names the cause among six rules, and prices what the miss costs you per call and per month.

Offline. Zero runtime dependencies. No API key, no network, no telemetry, no proxy.

```
$ cacheproof check requests/008.json requests/009.json --calls 18420

cacheproof 0.1.1 — Pricing: Nov 2026 — Anthropic / OpenAI / DeepSeek public rates
provider anthropic · model claude-3-5-sonnet · breakpoint system[0]

request A  916 B canonical (~229 tokens, estimated)
request B  916 B canonical (~229 tokens, estimated)
cached prefix  A 725 B · B 725 B · shared 331 B (45.7%)

first divergence: byte 255 of the canonical serialisation
  A …l"},"text":"SESSION clock: 2026-11-04T02:41:07Z\nHOUSE RULES (stable, never edit):\n1. A…
  B …l"},"text":"SESSION clock: 2026-11-04T02:41:38Z\nHOUSE RULES (stable, never edit):\n1. A…

verdict: BROKEN PREFIX — rule volatile-above-breakpoint (high)
  A value that changes every call (timestamp, id, nonce, session marker) sits inside the cached prefix.
  evidence: ISO-8601 timestamp differs inside the cached prefix at system[0].text

cost per request as measured (prefix broken): $0.00086  (prefix ~181 tok of ~229 tok)
  with a live prefix it would be $0.00020 — 4.33x less
  at 18420 calls: $15.82 vs $3.65 (burning $12.17)

gate: --max-miss-multiple 1.00 → exit 1
```

## Install

v0.1.0 is not on npm yet. Install from source — three commands, each offline after the clone:

```bash
git clone https://github.com/zorwerk/cacheproof.git
cd cacheproof && npm install && npm run build
npm link                       # puts `cacheproof` on your PATH

# or, without linking:
node dist/cli.js check a.json b.json
```

npm distribution is enabled at v0.1.0 publication; until then `npx cacheproof` will not resolve.
Nothing is sent anywhere. The tool reads two local files and prints.

## Install (from npm, after release)

Not available yet — publishing is gated on the v0.1.0 certification. When it lands:

```bash
npx cacheproof check a.json b.json
```

## What it checks

| Rule | What it catches |
|---|---|
| `volatile-above-breakpoint` | a timestamp, session id, request id or nonce sits **inside** the cached prefix |
| `tool-order` | identical tool definitions, different array order — providers hash bytes, not meaning |
| `retrieval-insert` | retrieved context or "project memory" injected above the breakpoint |
| `instruction-prefix` | a per-call instruction concatenated **in front of** the stable block instead of after it |
| `template-swap` | the model or the message template changed, so the cached region re-tokenises |
| `unclassified-cached-change` | the prefix broke and no rule matches — reported as a failure with the cause unknown, never as a pass |

Every rule is proven twice in this repository: a hostile fixture that must fire, and a clean fixture
that must stay quiet. A rule that cannot fail is not a rule.

## Usage

```bash
cacheproof check a.json b.json                       # gate: exit 1 on a broken prefix
cacheproof check run.jsonl                           # compare consecutive requests in one run
cacheproof diff  a.json b.json                       # offset + changed paths, no gate
cacheproof price --tokens-prefix 640 --tokens-total 695
cacheproof rules                                     # the six rule ids
```

Options: `--provider anthropic|openai|deepseek` · `--model <name>` · `--rates <file>` ·
`--max-miss-multiple <n>` (default 1.0) · `--calls <n>` · `--json`.

### The JSON contract, and one number that used to lie

`requests.cached_region_bytes` is the number of bytes the two requests hold in common **as a cached
region**. What that region *is* depends on the provider, so the report names the object it counted in
`requests.region_basis`:

| `region_basis` | meaning of `cached_region_bytes` |
|---|---|
| `cached_blocks` | an explicit breakpoint was declared (Anthropic): the cached blocks A and B hold in common |
| `shared_prefix` | no breakpoint (OpenAI, DeepSeek): the shared byte prefix, since there are no blocks |

`requests.shared_bytes` carries the **same value** and is a deprecated alias kept for one release:
v0.1.0 shipped that key with both meanings above and no way to tell which one you were reading. Read
`cached_region_bytes` plus `region_basis`; `shared_bytes` will be removed in v0.2.

### In CI

Until the npm release, build it once in the job from a pinned commit:

```yaml
- name: build cacheproof
  run: |
    git clone https://github.com/zorwerk/cacheproof.git tools/cacheproof
    cd tools/cacheproof && git checkout v0.1.0 && npm ci && npm run build

- name: prompt cache did not regress
  run: |
    node tools/cacheproof/dist/cli.js check captured/prev.json captured/curr.json \
      --max-miss-multiple 1.0
```

### Exit codes

| Code | Meaning |
|---|---|
| `0` | clean — the cached prefix is intact (or the miss multiple is within your threshold) |
| `1` | broken cached prefix, over the threshold |
| `2` | cannot decide — unreadable input, a payload that is not a request, or no breakpoint declared |

`2` is never conflated with `0`. A tool that cannot decide must say so; a silent pass is how this
class of bug survives in the first place.

## What it does not do (read this before trusting a number)

- **It does not call a provider.** It compares two payloads you already captured. No keys, no network.
- **Token counts are estimated** as canonical bytes / 4. `cacheproof` ships no tokeniser, because a
  tokeniser per provider is a dependency tree per provider. The *arithmetic* is exact and
  unit-tested; the absolute token count is labelled `~` everywhere on purpose.
- **Every byte count is a UTF-8 byte, never a code unit.** Offsets, canonical sizes and the shared
  prefix are measured on the encoded bytes, so non-ASCII text in a prompt (emoji, CJK, accented
  identifiers) is reported at its true wire position. A UTF-8 BOM is stripped before parsing rather
  than being reported as corrupt JSON.
- **The byte offset is canonical, not wire.** Keys are sorted and whitespace removed before
  comparison, so `byte 255` is a position in that canonical stream, not necessarily the integer your
  provider would print. It is stable across runs and comparable between two requests — which is what
  a diagnosis needs.
- **It does not measure token-level cache boundaries.** Providers cache in token and block units
  (OpenAI: 1024-token minimum, 128-token increments). `cacheproof` reports whether the prefix broke
  and what the miss costs; it does not predict the provider's exact block accounting.
- **It cannot see a cache that is already broken at capture time.** Garbage in, accurate grief out.

## Rates

`rates/rates.json` is **data, not code**: `--rates my-rates.json` replaces it whole. It ships with
dated, sourced public rates for Anthropic, OpenAI and DeepSeek, and prints its own date in every
report. If your provider changed price, edit the file — do not wait for a release.

## Design notes

- **Zero runtime dependencies.** A reviewer who must install a tree to evaluate a linter does not
  evaluate it.
- **Two canonicalisers.** Offsets in the test suite are derived by an independent Python
  implementation (`test/fixtures/derive_offsets.py`), so the TypeScript code has something to agree
  with that it did not write. Both sides compare UTF-8 bytes; the fixture set includes unicode and
  BOM payloads, because an all-ASCII fixture set agrees with itself no matter which unit you count.
- **Failures are loud.** When no rule matches a broken prefix, the verdict is still a failure. The
  category `unclassified-cached-change` exists so that "I don't know" can never be mistaken for "fine".

MIT licensed. Built by [Zorwerk Systems](https://zorwerk.com).
