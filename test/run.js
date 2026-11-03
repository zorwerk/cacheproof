#!/usr/bin/env node
/**
 * Zero-dependency test runner.
 *
 * The rule this file enforces: every rule is proven twice — a hostile fixture that
 * must fire and a clean fixture that must stay quiet — and the byte offset is
 * proven against an implementation that is not the one under test
 * (test/fixtures/derive_offsets.py, Python, its own canonicaliser).
 *
 * Run: npm test    (after npm run build)
 */

const { execFileSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const CLI = path.join(ROOT, "dist", "cli.js");
const FIXTURES = path.join(ROOT, "test", "fixtures");
// The built rule list, so every count in the suite (and in the prose it grades) derives from one array.
const { RULE_IDS } = require(path.join(ROOT, "dist", "classify.js"));

let pass = 0;
const failures = [];
let group = "";

function section(name) {
  group = name;
}

function check(name, condition, detail) {
  if (condition) {
    pass += 1;
    return;
  }
  failures.push(`${group} :: ${name}${detail ? ` — ${detail}` : ""}`);
}

function run(args) {
  try {
    const stdout = execFileSync(process.execPath, [CLI, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { code: 0, stdout, stderr: "" };
  } catch (error) {
    return {
      code: typeof error.status === "number" ? error.status : -1,
      stdout: error.stdout ? String(error.stdout) : "",
      stderr: error.stderr ? String(error.stderr) : "",
    };
  }
}

function runJson(args) {
  const result = run([...args, "--json"]);
  let parsed = null;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    parsed = null;
  }
  return { ...result, json: parsed };
}

function near(actual, expected, tolerance) {
  return Number.isFinite(actual) && Math.abs(actual - expected) <= tolerance;
}

// ---------------------------------------------------------------- fixtures
section("fixtures");
const cases = fs
  .readdirSync(FIXTURES, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();

check("fixture count is 16", cases.length === 16, `found ${cases.length}`);

for (const name of cases) {
  const dir = path.join(FIXTURES, name);
  const expected = JSON.parse(fs.readFileSync(path.join(dir, "expected.json"), "utf8"));
  const result = runJson([
    "check",
    path.join(dir, "a.json"),
    path.join(dir, "b.json"),
  ]);

  check(`${name}: exit ${expected.exit}`, result.code === expected.exit, `got ${result.code} ${result.stderr.trim()}`);

  if (expected.exit === 2) {
    check(`${name}: reported a reason on stderr`, result.stderr.trim().length > 0, "no stderr");
    continue;
  }

  check(`${name}: machine-readable output`, result.json !== null, "stdout was not JSON");
  if (!result.json) continue;

  const rule = result.json.classification ? result.json.classification.rule : undefined;
  check(`${name}: rule ${String(expected.rule)}`, rule === expected.rule, `got ${String(rule)}`);

  // Cross-implementation agreement on the offset: expected.offset was produced by
  // derive_offsets.py, not by the TypeScript canonicaliser under test.
  check(
    `${name}: offset matches the independent Python derivation (${String(expected.offset)})`,
    result.json.offset === expected.offset,
    `got ${String(result.json.offset)}`,
  );
  check(
    `${name}: canonical byte count A (${expected.canonical_bytes_a})`,
    result.json.requests.a.canonical_bytes === expected.canonical_bytes_a,
    `got ${result.json.requests.a.canonical_bytes}`,
  );
  check(
    `${name}: canonical byte count B (${expected.canonical_bytes_b})`,
    result.json.requests.b.canonical_bytes === expected.canonical_bytes_b,
    `got ${result.json.requests.b.canonical_bytes}`,
  );
}

// ------------------------------------------------------------- price arithmetic
section("price");
// The published example from the demand dossier §4.2: a 640-token stable prefix
// inside a 695-token request, Anthropic rates.
const dossier = runJson([
  "price",
  "--provider",
  "anthropic",
  "--model",
  "claude-3-5-sonnet",
  "--tokens-prefix",
  "640",
  "--tokens-total",
  "695",
]);
check("dossier example exits 0", dossier.code === 0, dossier.stderr.trim());
if (dossier.json) {
  check("miss cost $0.00261", near(dossier.json.missCost, 0.00261, 1e-5), `got ${dossier.json.missCost}`);
  check("hit cost $0.00036", near(dossier.json.hitCost, 0.00036, 1e-5), `got ${dossier.json.hitCost}`);
  check("miss multiple 7.30x", near(dossier.json.multiple, 7.3, 0.01), `got ${dossier.json.multiple}`);
  check("tail is 55 tokens", dossier.json.tailTokens === 55, `got ${dossier.json.tailTokens}`);
}

const implicit = runJson([
  "price",
  "--provider",
  "deepseek",
  "--model",
  "deepseek-v2.5",
  "--tokens-prefix",
  "640",
  "--tokens-total",
  "695",
]);
if (implicit.json) {
  // Rates are per million tokens: 640 * 0.014/1e6 + 55 * 0.14/1e6 = 0.00001666
  // (0.00000896 + 0.0000077). A miss is 695 * 0.14/1e6 = 0.0000973.
  check("deepseek hit cost 0.00001666", near(implicit.json.hitCost, 0.00001666, 1e-9), `got ${implicit.json.hitCost}`);
  check("deepseek miss cost 0.0000973", near(implicit.json.missCost, 0.0000973, 1e-9), `got ${implicit.json.missCost}`);
  check("deepseek multiple 5.84x", near(implicit.json.multiple, 5.8403, 0.01), `got ${implicit.json.multiple}`);
}

// ------------------------------------------------------- byte units (audit D1)
section("byte units");
// JavaScript string length is UTF-16 code units. Every number this tool prints is
// a byte count, so it must survive text outside ASCII — that was audit D1.
const { stableStringify } = require("../dist/canonical");
const unicodeDir = path.join(FIXTURES, "encoding-unicode__hostile");
const unicodePayload = JSON.parse(fs.readFileSync(path.join(unicodeDir, "a.json"), "utf8"));
const unicodeCanonical = stableStringify(unicodePayload);
check(
  "canonical.bytes length equals Buffer.byteLength(text)",
  unicodeCanonical.bytes.length === Buffer.byteLength(unicodeCanonical.text, "utf8"),
  `${unicodeCanonical.bytes.length} vs ${Buffer.byteLength(unicodeCanonical.text, "utf8")}`,
);
check(
  "multi-byte text makes byte length strictly greater than UTF-16 length",
  unicodeCanonical.bytes.length > unicodeCanonical.text.length,
  `bytes ${unicodeCanonical.bytes.length} · utf16 ${unicodeCanonical.text.length}`,
);

// Audit D4: the span accounting feeds the implicit-prefix region derivation, and no test failed when
// `Buffer.byteLength(chunk, "utf8")` in canonical.ts was reverted to `chunk.length`. Two independent
// checks, neither of which reuses the implementation's arithmetic:
//   (a) each span slice, decoded strictly, must be a complete JSON string token — a code-unit offset
//       lands mid-character on CJK text and a fatal UTF-8 decode throws;
//   (b) the last span must end exactly at the canonical byte length.
const cjkPayload = {
  system: [{ text: `キャッシュ ${"α".repeat(40)} 安定`, type: "text" }],
  user: "日本語テキスト",
};
const cjkCanonical = stableStringify(cjkPayload);
const strictUtf8 = new TextDecoder("utf-8", { fatal: true });
const spanSlices = cjkCanonical.spans.map((span) => {
  try {
    return strictUtf8.decode(cjkCanonical.bytes.subarray(span.start, span.end));
  } catch {
    return null;
  }
});
check(
  "every span boundary falls on a character boundary in the canonical BYTES",
  spanSlices.every((slice) => slice !== null) &&
    spanSlices.filter((slice) => slice.startsWith('"')).length >= 3,
  `spans ${cjkCanonical.spans.map((s) => `${s.start}-${s.end}`).join(" ")}`,
);
check(
  "the last span ends exactly at the canonical byte length",
  cjkCanonical.spans[cjkCanonical.spans.length - 1].end === cjkCanonical.bytes.length &&
    cjkCanonical.bytes.length > cjkCanonical.text.length,
  `end ${cjkCanonical.spans[cjkCanonical.spans.length - 1].end} · bytes ${cjkCanonical.bytes.length} · utf16 ${cjkCanonical.text.length}`,
);
// The same invariant must hold on ASCII, where bytes and code units coincide. Stated separately so
// the pair is explicit: ASCII passes both before and after a units mutation (it cannot discriminate),
// CJK passes only on correct bytes. A test that failed on ASCII would be broken, not strict.
const asciiCanonical = stableStringify({ system: [{ text: "plain ascii prompt", type: "text" }] });
check(
  "the same span invariant holds on ASCII (bytes == code units there)",
  asciiCanonical.spans[asciiCanonical.spans.length - 1].end === asciiCanonical.bytes.length &&
    asciiCanonical.bytes.length === asciiCanonical.text.length,
  `end ${asciiCanonical.spans[asciiCanonical.spans.length - 1].end} · bytes ${asciiCanonical.bytes.length}`,
);
const unicodeExpected = JSON.parse(fs.readFileSync(path.join(unicodeDir, "expected.json"), "utf8"));
check(
  "the unicode fixture is pinned in bytes, not code units",
  unicodeExpected.canonical_bytes_a === unicodeCanonical.bytes.length &&
    unicodeExpected.canonical_bytes_a !== unicodeCanonical.text.length,
  `pin ${unicodeExpected.canonical_bytes_a} · bytes ${unicodeCanonical.bytes.length} · utf16 ${unicodeCanonical.text.length}`,
);

// -------------------------------------------------------------- gate boundary
section("gate");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cacheproof-"));

// A table where a hit costs exactly what a miss costs: the boundary must PASS.
const flatRates = path.join(tmp, "flat-rates.json");
fs.writeFileSync(
  flatRates,
  JSON.stringify({
    as_of: "test",
    providers: {
      anthropic: {
        default_model: "flat",
        cache_mode: "explicit",
        models: {
          flat: { input_per_mtok: 3, cache_write_per_mtok: 3, cache_read_per_mtok: 3 },
        },
      },
    },
  }),
);

const flat = runJson([
  "price",
  "--rates",
  flatRates,
  "--model",
  "flat",
  "--tokens-prefix",
  "640",
  "--tokens-total",
  "695",
]);
if (flat.json) {
  check("equal cost gives exactly 1.00x", near(flat.json.multiple, 1.0, 1e-9), `got ${flat.json.multiple}`);
}

const hostile = path.join(FIXTURES, "r1-volatile-above-breakpoint__hostile");
const boundaryPass = run([
  "check",
  path.join(hostile, "a.json"),
  path.join(hostile, "b.json"),
  "--rates",
  flatRates,
  "--model",
  "flat",
  "--max-miss-multiple",
  "1.0",
]);
check("multiple exactly 1.0 passes the 1.0 gate", boundaryPass.code === 0, `got ${boundaryPass.code}`);

const strict = run([
  "check",
  path.join(hostile, "a.json"),
  path.join(hostile, "b.json"),
  "--max-miss-multiple",
  "0.5",
]);
check("a threshold below 1 is rejected as unusable input", strict.code === 2, `got ${strict.code}`);

// This fixture's measured multiple is ~4.33x, so 10.0 is loose enough to pass it.
const brokenGate = run([
  "check",
  path.join(hostile, "a.json"),
  path.join(hostile, "b.json"),
  "--max-miss-multiple",
  "10.0",
]);
check("a real miss below a loose threshold passes but stays reported", brokenGate.code === 0, `got ${brokenGate.code}`);
check(
  "the loose-threshold pass still prints BROKEN PREFIX",
  /BROKEN PREFIX/.test(brokenGate.stdout),
  brokenGate.stdout.slice(0, 120),
);

// ------------------------------------------------------------- input handling
section("input");
const missing = run(["check", path.join(tmp, "nope.json"), path.join(tmp, "nope2.json")]);
check("missing file is cannot-decide (2)", missing.code === 2, `got ${missing.code}`);

const unknownProvider = run([
  "check",
  path.join(hostile, "a.json"),
  path.join(hostile, "b.json"),
  "--provider",
  "acme",
]);
check("unknown provider is cannot-decide (2)", unknownProvider.code === 2, `got ${unknownProvider.code}`);

// A UTF-8 BOM must be tolerated; a BOM'd file that is still not JSON must say why.
section("encoding");
const bomGarbage = path.join(tmp, "bom_garbage.json");
fs.writeFileSync(bomGarbage, `\uFEFFthis is not json`, "utf8");
const bomResult = run(["check", bomGarbage, bomGarbage]);
check("BOM + invalid content is cannot-decide (2)", bomResult.code === 2, `got ${bomResult.code}`);
check(
  "BOM + invalid content names the BOM instead of blaming the syntax",
  /BOM/.test(bomResult.stderr),
  bomResult.stderr.trim().slice(0, 120),
);
const bomFixture = run([
  "check",
  path.join(FIXTURES, "encoding-bom__clean", "a.json"),
  path.join(FIXTURES, "encoding-bom__clean", "b.json"),
]);
check("a valid BOM'd request pair is graded, not rejected", bomFixture.code === 0, `got ${bomFixture.code}`);

// The retrieval-insert evidence string once printed a code-unit count while calling it "canonical
// bytes" — the same defect as D1, one layer deeper. A CJK block makes the two units differ 3:1, so
// the number in the message is checkable against the canonicalisation the tool itself performs.
const r3a = JSON.parse(fs.readFileSync(path.join(FIXTURES, "r3-retrieval-insert__hostile", "a.json"), "utf8"));
const r3b = JSON.parse(fs.readFileSync(path.join(FIXTURES, "r3-retrieval-insert__hostile", "b.json"), "utf8"));
const insertedBlock = r3b.system[0];
insertedBlock.text = `RETRIEVED CONTEXT\n${"檢".repeat(100)}`;
const cjkA = path.join(tmp, "cjk_r3_a.json");
const cjkB = path.join(tmp, "cjk_r3_b.json");
fs.writeFileSync(cjkA, JSON.stringify(r3a), "utf8");
fs.writeFileSync(cjkB, JSON.stringify(r3b), "utf8");
const cjkResult = runJson(["check", cjkA, cjkB]);
const cjkEvidence = cjkResult.json && cjkResult.json.classification
  ? String(cjkResult.json.classification.evidence[0])
  : "";
const cjkBytes = stableStringify(insertedBlock).bytes.length;
check(
  "retrieval-insert evidence counts canonical bytes, not code units",
  cjkEvidence.includes(`(${cjkBytes} canonical bytes`),
  `expected ${cjkBytes} B in: ${cjkEvidence.slice(0, 120)}`,
);
check(
  "that evidence number is genuinely larger than a code-unit count",
  cjkBytes > insertedBlock.text.length,
  `bytes ${cjkBytes} · units ${insertedBlock.text.length}`,
);

// JSONL run: three stacked payloads, the middle one carrying a broken prefix.
const cleanDir = path.join(FIXTURES, "r2-tool-order__clean");
const runFile = path.join(tmp, "run.jsonl");
const p1 = fs.readFileSync(path.join(cleanDir, "a.json"), "utf8").trim();
const p2 = fs.readFileSync(path.join(cleanDir, "b.json"), "utf8").trim();
const p3 = fs.readFileSync(path.join(hostile, "a.json"), "utf8").trim();
const p4 = fs.readFileSync(path.join(hostile, "b.json"), "utf8").trim();
fs.writeFileSync(runFile, [p1, p2, p3, p4].map((line) => line.replace(/\n/g, " ")).join("\n"));

const jsonlClean = run(["check", runFile]);
check(
  "a JSONL run with a broken pair somewhere exits 1 (worst pair wins)",
  jsonlClean.code === 1,
  `got ${jsonlClean.code}`,
);

const jsonlSingle = path.join(tmp, "single.json");
fs.writeFileSync(jsonlSingle, p1);
const single = run(["check", jsonlSingle]);
check("one file with one payload cannot decide (2)", single.code === 2, `got ${single.code}`);

// ------------------------------------------------- implicit prefix (D4 / D1c)
section("region");
// OpenAI declares no breakpoint, so the cached region is the shared byte prefix, derived from span
// ends. Iris's D1c: a CJK payload whose change lands *after* the prefix must stay clean and outside
// the region. Nothing in the suite failed when the span arithmetic was reverted to code units, so
// this is the end-to-end half of that hole.
function cjkPair(tag, tailA, tailB, prefixText) {
  const make = (tail) => ({
    model: "gpt-4o",
    messages: [{ role: "user", content: `${prefixText}${tail}` }],
  });
  const pa = path.join(tmp, `${tag}_a.json`);
  const pb = path.join(tmp, `${tag}_b.json`);
  fs.writeFileSync(pa, JSON.stringify(make(tailA)), "utf8");
  fs.writeFileSync(pb, JSON.stringify(make(tailB)), "utf8");
  return [pa, pb];
}
const cjkPrefix = `安定した前置き ${"日本語".repeat(30)} `;
const [afterA, afterB] = cjkPair("implicit_after", "ALPHA", "ALPHA2", cjkPrefix);
const afterResult = runJson(["check", afterA, afterB, "--provider", "openai"]);
check(
  "implicit prefix + CJK: a change after the prefix stays clean (exit 0)",
  afterResult.code === 0,
  `exit ${afterResult.code} · ${afterResult.stderr.trim()}`,
);
check(
  "implicit prefix + CJK: the change is outside the cached region",
  afterResult.json !== null &&
    afterResult.json.classification.in_cached_region === false &&
    afterResult.json.classification.rule === null,
  JSON.stringify(afterResult.json && afterResult.json.classification),
);
// Control: same provider and encoding, but the change is one that must always be classified — a model
// swap. It proves the region logic is live for openai on this path, so the clean verdict above is a
// measurement and not a tool that stopped classifying.
const modelA = path.join(tmp, "implicit_model_a.json");
const modelB = path.join(tmp, "implicit_model_b.json");
fs.writeFileSync(modelA, JSON.stringify({ model: "gpt-4o", messages: [{ role: "user", content: cjkPrefix }] }), "utf8");
fs.writeFileSync(modelB, JSON.stringify({ model: "gpt-4-turbo", messages: [{ role: "user", content: cjkPrefix }] }), "utf8");
const modelResult = runJson(["check", modelA, modelB, "--provider", "openai"]);
check(
  "implicit prefix + CJK control: a model swap is classified (exit 1, in region)",
  modelResult.code === 1 &&
    modelResult.json !== null &&
    modelResult.json.classification.in_cached_region === true,
  `exit ${modelResult.code} · ${JSON.stringify(modelResult.json && modelResult.json.classification)}`,
);
// D5: one number, two objects — the report must name which object it counted.
const explicitRun = runJson(["check", path.join(hostile, "a.json"), path.join(hostile, "b.json")]);
check(
  "explicit breakpoint names its region basis (cached_blocks)",
  explicitRun.json !== null && explicitRun.json.requests.region_basis === "cached_blocks",
  JSON.stringify(explicitRun.json && explicitRun.json.requests),
);
check(
  "implicit prefix names its region basis (shared_prefix)",
  afterResult.json !== null && afterResult.json.requests.region_basis === "shared_prefix",
  JSON.stringify(afterResult.json && afterResult.json.requests),
);
check(
  "human output states which object the shared number counts",
  /region: (explicit breakpoint|implicit prefix)/.test(
    run(["check", path.join(hostile, "a.json"), path.join(hostile, "b.json")]).stdout,
  ),
);
// D5 rename: `cached_region_bytes` is the name; `shared_bytes` stays for one release as a documented
// alias, because v0.1.0 shipped that key meaning two different objects.
check(
  "cached_region_bytes is present and equal to the deprecated alias",
  afterResult.json !== null &&
    typeof afterResult.json.requests.cached_region_bytes === "number" &&
    afterResult.json.requests.cached_region_bytes === afterResult.json.requests.shared_bytes,
  JSON.stringify(afterResult.json && afterResult.json.requests),
);

// ------------------------------------------------------------ output contract
section("output");
const text = run(["check", path.join(hostile, "a.json"), path.join(hostile, "b.json")]);
check("human output names the first divergence byte", /first divergence: byte \d+/.test(text.stdout));
check("human output names the rule", /rule volatile-above-breakpoint/.test(text.stdout));
check("human output prints the pricing date", /Pricing: Nov 2026/.test(text.stdout));
check("human output states the token estimate is an estimate", /estimated/.test(text.stdout));

const rulesOut = run(["rules"]);
check(
  "rules command lists exactly RULE_IDS plus the fallback",
  (rulesOut.stdout.match(/^ {2}[a-z-]+$/gm) || []).length === RULE_IDS.length,
  `got ${(rulesOut.stdout.match(/^ {2}[a-z-]+$/gm) || []).length}, RULE_IDS has ${RULE_IDS.length}`,
);

// `--json` is documented as global, so `diff` must honour it (audit D2).
const diffText = run(["diff", path.join(hostile, "a.json"), path.join(hostile, "b.json")]);
check("diff without --json prints prose", /first divergence: byte \d+/.test(diffText.stdout));
const diffJson = run(["diff", path.join(hostile, "a.json"), path.join(hostile, "b.json"), "--json"]);
let diffParsed = null;
try {
  diffParsed = JSON.parse(diffJson.stdout);
} catch {
  diffParsed = null;
}
check("diff --json emits JSON", diffJson.code === 0 && diffParsed !== null, diffJson.stdout.slice(0, 80));
if (diffParsed) {
  check("diff --json carries the byte offset", typeof diffParsed.offset === "number");
  check("diff --json carries a change list", Array.isArray(diffParsed.changes) && diffParsed.changes.length > 0);
}

const version = run(["--version"]);
check("--version prints 0.1.1", version.stdout.trim() === "0.1.1", version.stdout.trim());

// F1: the `rules` banner was a hardcoded version literal in a second output surface, so it still said
// 0.1.0 after the bump while `--version`, the header and the JSON said 0.1.1. Assert the built
// surface, and assert it agrees with this same binary's `--version`, so the two can never drift apart
// while both being "correct".
const rulesBanner = run(["rules"]).stdout.split("\n")[0];
check(
  "rules banner prints 0.1.1",
  /^cacheproof 0\.1\.1 — rule ids$/.test(rulesBanner) &&
    rulesBanner === `cacheproof ${version.stdout.trim()} — rule ids`,
  `banner: ${JSON.stringify(rulesBanner)}`,
);

const RULES_NUMERALS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };

check(
  "help derives its rule count from RULE_IDS",
  run(["--help"]).stdout.includes(`list all ${RULE_IDS.length} rule ids`),
  `RULE_IDS.length=${RULE_IDS.length}`,
);
check(
  "rules listing matches RULE_IDS exactly",
  run(["rules"])
    .stdout.match(/^ {2}[a-z-]+$/gm)
    .map((line) => line.trim())
    .join(",") === RULE_IDS.join(","),
  `listed ${run(["rules"]).stdout.match(/^ {2}[a-z-]+$/gm).length}, RULE_IDS ${RULE_IDS.length}`,
);

// The numeral in prose is a second surface of the same fact (the F1/F3 class): a spelled count
// that disagrees with RULE_IDS.length must fail here rather than ship. Both surfaces that carry
// prose — --help and README.md — are graded against the array itself.
const proseSurfaces = [
  { name: "--help", text: run(["--help"]).stdout },
  { name: "README.md", text: fs.readFileSync(path.join(ROOT, "README.md"), "utf8") },
];
for (const surface of proseSurfaces) {
  const claims = surface.text.match(/\b(one|two|three|four|five|six|seven|eight|nine|ten)\s+(?:rule ids|rules)\b/gi) || [];
  for (const claim of claims) {
    const word = claim.match(/^[a-z]+/i)[0].toLowerCase();
    check(
      `${surface.name} rule-count word "${word}" equals RULE_IDS.length (${RULE_IDS.length})`,
      RULES_NUMERALS[word] === RULE_IDS.length,
      `claimed ${RULES_NUMERALS[word]}, actual ${RULE_IDS.length}`,
    );
  }
}
check(
  "README.md states the real rule count at least once",
  proseSurfaces[1].text.search(/\b(one|two|three|four|five|six|seven|eight|nine|ten)\s+(?:rule ids|rules)\b/i) >= 0,
);

// F2: a consumer that closes the pipe first (`| true`, `head -n 0`, `grep -q`) used to kill the run
// with an unhandled EPIPE stack trace. Destroy the child's stdout immediately and assert a clean 0.
const epipeProbe = `
const { spawn } = require("child_process");
const child = spawn(process.execPath, [process.env.CP_CLI, "rules"], { stdio: ["ignore", "pipe", "pipe"] });
let err = "";
child.stderr.on("data", (chunk) => { err += chunk; });
child.stdout.destroy();
child.on("close", (code) => { process.stdout.write(JSON.stringify({ code: code, err: err })); });
`;
const epipeOut = execFileSync(process.execPath, ["-e", epipeProbe], {
  encoding: "utf8",
  env: { ...process.env, CP_CLI: CLI },
});
const epipe = JSON.parse(epipeOut);
check(
  "a prematurely closed stdout exits 0",
  epipe.code === 0,
  `rc ${epipe.code} · stderr ${JSON.stringify(String(epipe.err).slice(0, 200))}`,
);
check(
  "a prematurely closed stdout writes nothing to stderr",
  String(epipe.err) === "",
  JSON.stringify(String(epipe.err).slice(0, 200)),
);

// ----------------------------------------------------------------------------
fs.rmSync(tmp, { recursive: true, force: true });

const total = pass + failures.length;
console.log(`\ncacheproof ${total} checks — ${pass} passed, ${failures.length} failed\n`);
if (failures.length > 0) {
  for (const failure of failures) console.log(`  FAIL ${failure}`);
  process.exitCode = 1;
}
