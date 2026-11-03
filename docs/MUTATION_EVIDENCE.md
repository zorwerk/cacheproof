# Mutation evidence — proving the suite can fail

A green test run is a claim about the checker as much as about the tool. On 2026-11-04 three
deliberate defects were injected into a throwaway copy of `dist/` (`/tmp/cp_mut`, the repo's own
`test/run.js` unchanged) and the suite re-run. All three were caught.

| Mutation | Injected defect | Result |
|---|---|---|
| M1 | `volatileDiff()` forced to return `null` — the volatile rule can never fire | **2 failures** (92/94): fixture `r1-volatile-above-breakpoint__hostile` fell through to `unclassified-cached-change` |
| M2 | `const exitCode = overGate ? 1 : 0` → `const exitCode = 0` — the gate can never fail | **7 failures** (87/94): all five hostile fixtures reported `exit 1 — got 0` |
| M3 | `firstDivergence()` returns `i + 1` — offsets off by one | **11 failures** (83/94): every fixture's offset disagreed with the independent Python derivation |

## What this does and does not prove

- **Proves** the suite is wired to the behaviour, not to a cached green result: three independent
  defects, each caught by the rows that should catch it, with no false failures in the clean rows.
- **Does not prove** the rules cover real-world payload shapes nobody has captured yet. That is why
  `unclassified-cached-change` is a *failing* verdict: an unrecognised broken prefix can never read
  as a pass.
- **M3 is the interesting one.** It only fires because the expected offsets come from a second
  implementation (`derive_offsets.py`). A suite that derived its own expectations would have agreed
  with the off-by-one and reported 94/94.

## Reproducing

```bash
rm -rf /tmp/cp_mut && mkdir /tmp/cp_mut
tar cf - --exclude=node_modules --exclude=.git . | (cd /tmp/cp_mut && tar xf -)
cd /tmp/cp_mut
python3 - <<'EOF'
p = 'dist/classify.js'; s = open(p).read()
open(p, 'w').write(s.replace("function volatileDiff(before, after) {",
                             "function volatileDiff(before, after) {\n    return null;", 1))
EOF
node test/run.js   # expect 2 failures, not 0
```

Note on reading exit codes: `node test/run.js | tail -5` reports **tail's** exit status, not the
runner's. Capture `rc=$?` on the line immediately after the run, or read the counts it prints.
