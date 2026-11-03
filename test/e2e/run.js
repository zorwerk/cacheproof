#!/usr/bin/env node
/**
 * End-to-end verification: does the built CLI actually run, and are its answers right?
 *
 * Two different questions, graded separately:
 *   1. RUN   — `node dist/cli.js` is spawned as a real process, in a scrubbed
 *              environment (no API keys, no proxy, no NODE_OPTIONS, no network
 *              client), from a neutral cwd, against real multi-turn request
 *              captures for anthropic / openai / deepseek.
 *   2. RIGHT — the three numbers the user acts on (first-divergence byte, token
 *              counts, dollars) are compared against values derived by
 *              test/e2e/gen_prompts.py with its OWN canonicaliser, not by the
 *              code under test. A gate that runs and lies is worse than one that
 *              crashes: it gets trusted.
 *
 * The unit suite (test/run.js) grades the library through in-process calls. This
 * file grades the artifact a user installs, which is why it refuses to run when
 * dist/ is stale.
 *
 * Run:  npm run build && node test/e2e/run.js
 * Exit: 0 all rows pass · 1 at least one row failed · 2 cannot decide (no build,
 *       no fixtures, python3 missing)
 */

const { spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const ROOT = path.resolve(__dirname, "..", "..");
const CLI = path.join(ROOT, "dist", "cli.js");
const GEN = path.join(__dirname, "gen_prompts.py");
// Fixtures are generated into a throwaway directory on every run: a number read
// from a checked-in JSON file is a claim about a previous build.
const FIXTURES = fs.mkdtempSync(path.join(os.tmpdir(), "cacheproof-e2e-"));

let pass = 0;
const failures = [];
let group = "";
const transcript = [];

function section(name) {
  group = name;
}

function check(name, condition, detail) {
  if (condition) {
    pass += 1;
    return;
  }
  failures.push(`${group} :: ${name}${detail === undefined ? "" : ` — ${detail}`}`);
}

/**
 * A scrubbed environment. If the CLI needs an API key, a proxy, a token file or a
 * node flag to work, it fails here — which is the point: the README promises none
 * of them. PATH is kept only so the interpreter can be found.
 */
function cleanEnv() {
  const env = {
    PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
    LANG: "C",
    LC_ALL: "C",
  };
  return env;
}

function runCli(args) {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    cwd: os.tmpdir(),
    env: cleanEnv(),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    // A CLI that has not answered in 60 s is a defect, not a slow machine.
    timeout: 60000,
  });
  return {
    code: typeof result.status === "number" ? result.status : -1,
    stdout: result.stdout || "",
    stderr: result.stderr || "",
  };
}

function usd(text) {
  const match = text.match(/\$([0-9]+(?:\.[0-9]+)?)/);
  return match ? Number(match[1]) : null;
}

function divergenceOffset(text) {
  const match = text.match(/^first divergence: byte (\d+) of the canonical serialisation$/m);
  return match ? Number(match[1]) : null;
}

function near(actual, expected, tolerance) {
  return typeof actual === "number" && Number.isFinite(actual) && Math.abs(actual - expected) <= tolerance;
}

function main() {
  if (!fs.existsSync(CLI)) {
    process.stderr.write(`e2e: ${CLI} is missing — run npm run build first\n`);
    return 2;
  }
  if (!fs.existsSync(GEN)) {
    process.stderr.write(`e2e: ${GEN} is missing\n`);
    return 2;
  }

  // Regenerate the fixtures every run: an E2E number that came from a stale JSON
  // file is a claim about a previous build.
  const generated = spawnSync("python3", [GEN, FIXTURES], { encoding: "utf8" });
  if (generated.status !== 0) {
    process.stderr.write(`e2e: gen_prompts.py failed (rc ${generated.status})\n${generated.stderr || ""}`);
    return 2;
  }
  transcript.push(generated.stdout.trim());

  const providers = ["anthropic", "openai", "deepseek"];

  for (const provider of providers) {
    const directory = path.join(FIXTURES, provider);
    const expectedPath = path.join(directory, "expected.json");
    if (!fs.existsSync(expectedPath)) {
      process.stderr.write(`e2e: ${expectedPath} is missing\n`);
      return 2;
    }
    const expected = JSON.parse(fs.readFileSync(expectedPath, "utf8"));
    const turn1 = path.join(directory, "turn1.json");
    const cleanTurn = path.join(directory, "turn2_clean.json");
    const brokenTurn = path.join(directory, "turn2_broken.json");
    const baseArgs = ["--provider", expected.provider, "--model", expected.model];

    // ---- a healthy second turn: the cached prefix is intact -----------------
    section(`${provider} · clean turn (append-only: must stay clean)`);
    const clean = runCli(["check", turn1, cleanTurn, ...baseArgs]);
    check("exit 0 on a clean pair", clean.code === 0, `rc ${clean.code} · ${clean.stderr.trim().slice(0, 160)}`);
    check("stderr is empty on a clean pair", clean.stderr === "", JSON.stringify(clean.stderr.slice(0, 160)));
    check("says the prefix is intact", /verdict: CLEAN — the cached prefix is intact/.test(clean.stdout));
    const cleanOffset = divergenceOffset(clean.stdout);
    check(
      `prints the diverging byte the fixtures derive (${expected.clean.offset})`,
      cleanOffset === expected.clean.offset,
      `printed ${cleanOffset}`,
    );
    const cleanJson = runCli(["check", turn1, cleanTurn, ...baseArgs, "--json"]);
    let cleanParsed = null;
    try {
      cleanParsed = JSON.parse(cleanJson.stdout);
    } catch {
      cleanParsed = null;
    }
    check("--json parses", cleanParsed !== null);
    if (cleanParsed) {
      check("--json agrees with prose on the offset", cleanParsed.offset === expected.clean.offset);
      check(
        `canonical bytes A = ${expected.clean.canonical_bytes_a}`,
        cleanParsed.requests.a.canonical_bytes === expected.clean.canonical_bytes_a,
        `got ${cleanParsed.requests.a.canonical_bytes}`,
      );
      check(
        `canonical bytes B = ${expected.clean.canonical_bytes_b}`,
        cleanParsed.requests.b.canonical_bytes === expected.clean.canonical_bytes_b,
        `got ${cleanParsed.requests.b.canonical_bytes}`,
      );
      check(
        `prefix tokens = ${expected.clean.prefix_tokens}`,
        cleanParsed.price.prefix_tokens === expected.clean.prefix_tokens,
        `got ${cleanParsed.price.prefix_tokens}`,
      );
      check(
        `total tokens = ${expected.clean.total_tokens}`,
        cleanParsed.price.total_tokens === expected.clean.total_tokens,
        `got ${cleanParsed.price.total_tokens}`,
      );
      check(
        `hit cost = $${expected.clean.hit_cost_usd}`,
        near(cleanParsed.price.hit_cost_usd, expected.clean.hit_cost_usd, 1e-9),
        `got ${cleanParsed.price.hit_cost_usd}`,
      );
    }
    const cleanTokens = clean.stdout.match(/request A\s+(\d+) B canonical \(~(\d+) tokens, estimated\)/);
    check(
      `prose token estimate A = ${expected.clean.tokens_a}`,
      cleanTokens !== null && Number(cleanTokens[2]) === expected.clean.tokens_a,
      cleanTokens ? cleanTokens[2] : "no token line",
    );
    const cleanCostLine = clean.stdout.match(/cost per request with the prefix intact: (\$[0-9.]+)/);
    check(
      `prose hit cost = $${expected.clean.hit_cost_usd}`,
      cleanCostLine !== null && near(usd(cleanCostLine[1]), expected.clean.hit_cost_usd, 1e-5),
      cleanCostLine ? cleanCostLine[1] : "no cost line",
    );

    // ---- a cache-killing second turn ---------------------------------------
    section(`${provider} · broken turn`);
    const broken = runCli(["check", turn1, brokenTurn, ...baseArgs]);
    check("exit 1 on a broken pair", broken.code === 1, `rc ${broken.code} · ${broken.stderr.trim().slice(0, 160)}`);
    check("stderr is empty on a broken pair", broken.stderr === "", JSON.stringify(broken.stderr.slice(0, 160)));
    check(
      `names the rule ${expected.broken.rule}`,
      new RegExp(`verdict: BROKEN PREFIX — rule ${expected.broken.rule}`).test(broken.stdout),
      (broken.stdout.match(/verdict: .*/) || ["no verdict line"])[0],
    );
    const brokenOffset = divergenceOffset(broken.stdout);
    check(
      `prints the diverging byte the fixtures derive (${expected.broken.offset})`,
      brokenOffset === expected.broken.offset,
      `printed ${brokenOffset}`,
    );
    const brokenJson = runCli(["check", turn1, brokenTurn, ...baseArgs, "--json"]);
    let brokenParsed = null;
    try {
      brokenParsed = JSON.parse(brokenJson.stdout);
    } catch {
      brokenParsed = null;
    }
    check("--json parses on a broken pair", brokenParsed !== null);
    if (brokenParsed) {
      check("--json agrees with prose on the offset", brokenParsed.offset === expected.broken.offset);
      check("--json marks the pair not clean", brokenParsed.clean === false);
      check(
        `miss cost = $${expected.broken.miss_cost_usd}`,
        near(brokenParsed.price.miss_cost_usd, expected.broken.miss_cost_usd, 1e-9),
        `got ${brokenParsed.price.miss_cost_usd}`,
      );
      check(
        `miss multiple = ${expected.broken.miss_multiple}x`,
        expected.broken.miss_multiple === null ||
          near(brokenParsed.price.miss_multiple, expected.broken.miss_multiple, 1e-4),
        `got ${brokenParsed.price.miss_multiple}`,
      );
    }
    const brokenCostLine = broken.stdout.match(/cost per request as measured \(prefix broken\): (\$[0-9.]+)/);
    check(
      `prose miss cost = $${expected.broken.miss_cost_usd}`,
      brokenCostLine !== null && near(usd(brokenCostLine[1]), expected.broken.miss_cost_usd, 1e-5),
      brokenCostLine ? brokenCostLine[1] : "no cost line",
    );
    const contextLines = (broken.stdout.match(/^ {2}[AB] ….*…$/gm) || []).length;
    check("prints both context windows around the divergence", contextLines === 2, `got ${contextLines}`);

    // ---- must-stay-clean control: a change AFTER the declared breakpoint -----
    if (fs.existsSync(path.join(directory, "turn2_tail.json")) && expected.tail) {
      section(`${provider} · edit after the breakpoint (must stay clean)`);
      const tailPath = path.join(directory, "turn2_tail.json");
      const tail = runCli(["check", turn1, tailPath, ...baseArgs]);
      check("exit 0 when only the tail moved", tail.code === 0, `rc ${tail.code}`);
      check(
        "the tail edit is outside the cached region",
        /verdict: CLEAN — the cached prefix is intact/.test(tail.stdout),
        (tail.stdout.match(/verdict: .*/) || ["no verdict line"])[0],
      );
      check(
        `the tail edit still prints its divergence byte (${expected.tail.offset})`,
        divergenceOffset(tail.stdout) === expected.tail.offset,
        `printed ${divergenceOffset(tail.stdout)}`,
      );
      const tailJson = runCli(["check", turn1, tailPath, ...baseArgs, "--json"]);
      let tailParsed = null;
      try {
        tailParsed = JSON.parse(tailJson.stdout);
      } catch {
        tailParsed = null;
      }
      check(
        "the tail edit is not marked in the cached region",
        tailParsed !== null && tailParsed.classification.in_cached_region === false,
        JSON.stringify(tailParsed && tailParsed.classification),
      );
    }

    // ---- the same input twice must print the same bytes --------------------
    section(`${provider} · determinism`);
    const again = runCli(["check", turn1, brokenTurn, ...baseArgs]);
    check("two runs print identical bytes", again.stdout === broken.stdout);
  }

  // ---- refusals: exit 2 is a verdict, not a crash ---------------------------
  section("refusals");
  const anthropicDir = path.join(FIXTURES, "anthropic");
  const noBreakpoint = path.join(os.tmpdir(), `cp_nobreak_${process.pid}.json`);
  const turn1 = JSON.parse(fs.readFileSync(path.join(anthropicDir, "turn1.json"), "utf8"));
  delete turn1.system[0].cache_control;
  fs.writeFileSync(noBreakpoint, JSON.stringify(turn1), "utf8");
  const refused = runCli(["check", noBreakpoint, path.join(anthropicDir, "turn2_clean.json"), "--provider", "anthropic"]);
  check("a request with no breakpoint is refused", refused.code === 2, `rc ${refused.code}`);
  check("the refusal names the missing breakpoint", /cache_control/.test(refused.stderr), refused.stderr.trim().slice(0, 160));
  check("the refusal is not a stack trace", !/^\s+at /m.test(refused.stderr));

  const single = runCli(["check", path.join(anthropicDir, "turn1.json")]);
  check("a single request without its successor is refused", single.code === 2, `rc ${single.code}`);

  const truncated = path.join(os.tmpdir(), `cp_trunc_${process.pid}.json`);
  fs.writeFileSync(truncated, '{"model":"gpt-4o","messages":[{"role":"user","content":"hi"', "utf8");
  const bad = runCli(["check", truncated, truncated, "--provider", "openai"]);
  check("a truncated file is refused by name", bad.code === 2 && /cp_trunc/.test(bad.stderr), bad.stderr.trim().slice(0, 160));
  check("a truncated file is not a stack trace", !/^\s+at /m.test(bad.stderr));

  const unknown = runCli(["check", path.join(anthropicDir, "turn1.json"), path.join(anthropicDir, "turn2_clean.json"), "--provider", "mistral"]);
  check("an unknown provider is refused", unknown.code === 2, `rc ${unknown.code}`);
  fs.rmSync(noBreakpoint, { force: true });
  fs.rmSync(truncated, { force: true });

  // ---- the installed artifact's own surfaces -------------------------------
  section("surfaces");
  const help = runCli(["--help"]);
  check("--help exits 0", help.code === 0);
  const version = runCli(["--version"]);
  check("--version exits 0", version.code === 0);
  const rules = runCli(["rules"]);
  check("rules exits 0", rules.code === 0);
  check(
    "the rules banner and --version name the same version",
    rules.stdout.split("\n")[0] === `cacheproof ${version.stdout.trim()} — rule ids`,
    `${JSON.stringify(rules.stdout.split("\n")[0])} vs ${JSON.stringify(version.stdout.trim())}`,
  );
  const listed = (rules.stdout.match(/^ {2}[a-z-]+$/gm) || []).length;
  check("the help's rule count equals the number of ids listed", help.stdout.includes(`list all ${listed} rule ids`), `listed ${listed}`);

  const total = pass + failures.length;
  fs.rmSync(FIXTURES, { recursive: true, force: true });
  const header = `cacheproof e2e — ${total} checks — ${pass} passed, ${failures.length} failed`;
  console.log(`${header}\n`);
  for (const line of transcript) if (line) console.log(`  ${line.replace(/\n/g, "\n  ")}`);
  if (failures.length > 0) {
    console.log("");
    for (const failure of failures) console.log(`  FAIL ${failure}`);
    process.exitCode = 1;
  }
  return process.exitCode === 1 ? 1 : 0;
}

process.exitCode = main();
