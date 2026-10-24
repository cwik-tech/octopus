/**
 * Strict product-workflow live gate.
 *
 * `npm run test:live:providers:strict` governs only tests written with
 * `liveTest()` (tests/live/live-provider-support.ts:34-41). The six shipped
 * product-workflow files use plain `node:test` with their own opt-in flags, so
 * `PIPELINE_LIVE_REQUIRE=all` never reaches them: the provider runner globs them
 * in (tests/run-live-provider-tests.mjs:20-23), they all skip themselves, and the
 * command exits 0 having proven nothing. This runner closes that gap.
 *
 * It is deliberately NOT the provider runner with a flag. The provider matrix
 * stays provider-only, and `PIPELINE_LIVE_REQUIRE` is not overloaded.
 *
 * Three guarantees:
 *   1. The lane is DECLARED, not globbed. A new provider test cannot wander in,
 *      and a product file cannot silently drop out — the manifest is asserted.
 *   2. It enables the opt-in flags itself, so no file can skip for want of one.
 *   3. A skip is a failure. Even if a file grows a new skip condition later,
 *      this runner exits non-zero rather than reporting a green lane.
 *
 * Prerequisites that are cheap to prove are checked in preflight, before any
 * costed or network work. Prerequisites that are not — an authenticated ChatGPT
 * subscription, managed Chrome, staged YouTube binaries, reachable networks —
 * are deliberately left to fail inside the real tests, because a preflight that
 * guessed at them would either produce false refusals or quietly become a skip.
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const testsDirectory = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(testsDirectory, "..");
const outputDirectory = path.join(repoRoot, ".tests-dist");

const REQUIRE_ENV = "PIPELINE_LIVE_PRODUCT_REQUIRE";

/**
 * The strict lane, declared explicitly.
 *
 * `lane` is the operator-facing family name that appears in diagnostics.
 * `requires` lists only prerequisites that can be proven without spending money
 * or touching the network.
 */
const LANE_MANIFEST = [
  {
    lane: "workflow-subscription",
    file: "tests/live/workflow-subscription-live.test.ts",
    requires: [],
  },
  {
    lane: "deep-research",
    file: "tests/live/deep-research-workflow-live.test.ts",
    requires: [],
  },
  {
    lane: "journal-cutover",
    file: "tests/live/journal-cutover-live.test.ts",
    requires: [],
  },
  {
    lane: "youtube-extraction",
    file: "tests/live/youtube-extraction-live.test.ts",
    requires: [],
  },
  {
    lane: "youtube-workflow",
    file: "tests/live/youtube-workflow-live.test.ts",
    requires: [],
  },
  {
    // Both of its tests are gated on GEMINI_API_KEY
    // (tests/live/youtube-manual-live.test.ts:10), and the full lane adds staged
    // pinned tools — which this runner does NOT preflight, by design.
    lane: "youtube-manual",
    file: "tests/live/youtube-manual-live.test.ts",
    requires: ["GEMINI_API_KEY"],
  },
];

/**
 * Opt-in flags this lane sets for itself.
 *
 * Without these the files skip and the lane is worthless.
 * `PIPELINE_LIVE_JOURNAL_CUTOVER=1` is the authoritative mode on purpose:
 * `control` runs the same workflow with the journal OFF
 * (tests/live/journal-cutover-live.test.ts:36-42), which is a different test.
 * `PIPELINE_LIVE_REQUIRE` is deliberately absent — that switch belongs to the
 * provider matrix.
 */
const LANE_ENV = {
  PIPELINE_LIVE_DEEP_RESEARCH: "1",
  PIPELINE_LIVE_JOURNAL_CUTOVER: "1",
  PIPELINE_LIVE_YOUTUBE: "1",
  PIPELINE_LIVE_YOUTUBE_FULL: "1",
};

// ─── Argument validation ─────────────────────────────────────────────────────
// FIRST, before the opt-in gate, preflight, compile or spawn.
//
// `package.json` arms PIPELINE_LIVE_PRODUCT_REQUIRE=1 for the strict script, so
// anything this file silently ignores becomes a real paid run. A typo such as
// `--prefligth-only` must cost nothing.

/** Modes that inspect or self-check. Each is exclusive and free of costed work. */
const INSPECT_MODES = new Set([
  "--print-manifest",
  "--preflight-only",
  "--self-test",
]);

const argv = process.argv.slice(2);
const unknown = [];
const selectedModes = [];
let selfTestFixtureDirectory;
let missingOperand = false;

for (let index = 0; index < argv.length; index += 1) {
  const argument = argv[index];
  if (argument === "--self-test") {
    selectedModes.push(argument);
    // Consume exactly one non-option operand. Consuming unconditionally would
    // swallow a following flag — `--self-test --print-manifest` would read as a
    // fixture path named `--print-manifest`, making the two-mode rejection
    // silently depend on argument order.
    const operand = argv[index + 1];
    if (operand === undefined || operand.startsWith("-")) {
      missingOperand = true;
      continue;
    }
    selfTestFixtureDirectory = operand;
    index += 1;
    continue;
  }
  if (INSPECT_MODES.has(argument)) {
    selectedModes.push(argument);
    continue;
  }
  unknown.push(argument);
}

if (unknown.length > 0) {
  console.error(
    `Unknown argument(s): ${unknown.join(", ")}\n` +
      `Supported: ${[...INSPECT_MODES].join(", ")}, or no arguments for a ` +
      "strict run. Refusing to continue: this command runs real, paid " +
      "workflows, so an unrecognised argument is never ignored.",
  );
  process.exit(2);
}

if (selectedModes.length > 1) {
  console.error(
    `Mutually exclusive modes: ${selectedModes.join(", ")}\n` +
      "Pass exactly one, or none for a strict run. Choosing a precedence " +
      "silently would hide which one actually ran.",
  );
  process.exit(2);
}

if (missingOperand) {
  console.error(
    "--self-test requires exactly one fixture directory operand, and it may " +
      "not begin with '-'.\n" +
      "Usage: --self-test <fixture-dir>",
  );
  process.exit(2);
}

const printManifest = selectedModes[0] === "--print-manifest";
const preflightOnly = selectedModes[0] === "--preflight-only";
const selfTest = selectedModes[0] === "--self-test";

// ─── Lane result classification and sequencing (shared production path) ──────
//
// These two functions ARE the lane's decision logic. The real run and the
// `--self-test` fixture mode both call them; only the child-process boundary
// differs. Nothing here re-implements a check for tests.

/**
 * Decide whether one lane passed, from its process status and TAP output.
 *
 * A zero exit is not sufficient. `node:test` exits 0 when every test skips,
 * which is precisely how the provider strict lane reported success while
 * proving nothing. A lane that skipped, or ran nothing at all, has failed.
 *
 * Returns `null` when the lane passed, or a human-readable failure string.
 */
function classifyLaneResult(lane, exitStatus, tap) {
  if (exitStatus !== 0) {
    return `${lane}: test process exited ${exitStatus}`;
  }
  if (typeof tap !== "string") {
    return `${lane}: could not read TAP output to verify no tests skipped`;
  }

  const lines = tap.split("\n");
  const skipped = lines.filter((line) =>
    /^\s*(?:not )?ok\b.*#\s*(?:SKIP|skip)\b/.test(line),
  );
  if (skipped.length > 0) {
    return (
      `${lane}: ${skipped.length} test(s) skipped — a strict lane must not ` +
      `skip.\n${skipped.map((line) => `      ${line.trim()}`).join("\n")}`
    );
  }

  const ran = lines.filter((line) => /^\s*(?:not )?ok\b/.test(line));
  if (ran.length === 0) return `${lane}: no tests ran at all`;

  return null;
}

/**
 * Walk the manifest in order, stopping at the first failure.
 *
 * Fail-fast is the safe default for a paid lane: the lanes share prerequisites,
 * so a failure is usually predictive, and continuing would spend money and wait
 * out timeouts (up to 20 minutes for the journal cutover) on runs about to fail
 * for the same reason. `attempted` therefore lists only lanes actually started.
 *
 * `runLane` is the injected boundary: the real spawn in production, on-disk
 * fixtures under `--self-test`.
 */
function sequenceLanes(manifest, runLane) {
  const attempted = [];
  for (const entry of manifest) {
    attempted.push(entry.lane);
    const { exitStatus, tap } = runLane(entry);
    const failure = classifyLaneResult(entry.lane, exitStatus, tap);
    if (failure !== null) return { attempted, failure };
  }
  return { attempted, failure: null };
}

if (selfTest) {
  // Free mode: no opt-in, no preflight, no compile, no spawn. It exercises the
  // real `sequenceLanes`/`classifyLaneResult` over fixture files, so a green
  // result here cannot diverge from what the paid lane would decide.
  const report = sequenceLanes(LANE_MANIFEST, ({ lane }) => {
    const statusPath = path.join(selfTestFixtureDirectory ?? "", `${lane}.status`);
    const tapPath = path.join(selfTestFixtureDirectory ?? "", `${lane}.tap`);
    let exitStatus = 0;
    try {
      exitStatus = Number.parseInt(readFileSync(statusPath, "utf8").trim(), 10);
    } catch {
      exitStatus = 0;
    }
    let tap;
    try {
      tap = readFileSync(tapPath, "utf8");
    } catch {
      tap = undefined;
    }
    return { exitStatus, tap };
  });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.exit(report.failure === null ? 0 : 1);
}

if (printManifest) {
  // Free and side-effect-free, so it does not require the opt-in.
  process.stdout.write(
    `${JSON.stringify(
      {
        testFiles: LANE_MANIFEST.map((entry) => entry.file),
        lanes: LANE_MANIFEST.map(({ lane, file, requires }) => ({
          lane,
          file,
          requires,
        })),
        laneEnv: LANE_ENV,
      },
      null,
      2,
    )}\n`,
  );
  process.exit(0);
}

// ─── Opt-in gate ─────────────────────────────────────────────────────────────
// Checked first for a real run, so an operator who simply forgot the opt-in is
// told that, rather than being handed an unrelated prerequisite error.
// `--preflight-only` skips this gate on purpose: validating a machine is free
// and should not require arming the costed lane.

if (!preflightOnly && process.env[REQUIRE_ENV] !== "1") {
  console.error(
    `Refusing to start the strict product-workflow lane without ${REQUIRE_ENV}=1.\n` +
      "This lane runs real, paid, network-dependent product workflows. " +
      "Use `npm run test:live:product:strict`, or pass --preflight-only " +
      "or --print-manifest to inspect it without running anything.",
  );
  process.exit(1);
}

// ─── Preflight ───────────────────────────────────────────────────────────────
// Still ahead of any compile, spawn, or network call.

const missing = [];
for (const { lane, requires } of LANE_MANIFEST) {
  for (const variable of requires) {
    // Presence only. The value is never read into a message, never logged, and
    // never validated against the provider — that would be a network call.
    if (!process.env[variable]?.trim()) missing.push({ lane, variable });
  }
}

if (missing.length > 0) {
  console.error(
    "Strict product-workflow lane preflight FAILED. " +
      "Missing prerequisites must be fixed before a costed run starts:",
  );
  for (const { lane, variable } of missing) {
    console.error(`  - ${variable} is not set (required by lane '${lane}')`);
  }
  console.error(
    "\nThis lane never converts an absent prerequisite into a skipped test. " +
      "Set the variables above, or run the individual non-strict commands, " +
      "which retain their opt-in skip behaviour.",
  );
  process.exit(1);
}

if (preflightOnly) {
  console.log(
    `Strict product-workflow lane preflight passed for ${LANE_MANIFEST.length} lanes.`,
  );
  process.exit(0);
}

// ─── Compile ─────────────────────────────────────────────────────────────────

rmSync(outputDirectory, { recursive: true, force: true });

const compile = spawnSync("tsc", ["-p", "tests/tsconfig.test.json"], {
  cwd: repoRoot,
  env: process.env,
  stdio: "inherit",
});
if (compile.status !== 0) process.exit(compile.status ?? 1);

// ─── Run, sequentially, failing fast ─────────────────────────────────────────
// One file per child process, in manifest order, through the same
// `sequenceLanes`/`classifyLaneResult` path the self-test exercises. Each file
// keeps its own per-test timeouts; no `--test-timeout` is imposed here, because
// these workflows declare their own (up to 20 minutes for the journal cutover).

const tapDirectory = mkdtempSync(path.join(os.tmpdir(), "live-product-strict-"));
let report;
try {
  report = sequenceLanes(LANE_MANIFEST, ({ lane, file }) => {
    const compiled = path.join(outputDirectory, file.replace(/\.ts$/, ".js"));
    const tapPath = path.join(tapDirectory, `${lane}.tap`);

    console.log(`\n=== strict product lane: ${lane} (${file}) ===`);
    const run = spawnSync(
      // The same pinned runtime that launched this runner, not whatever `node`
      // happens to resolve to on PATH.
      process.execPath,
      [
        "--test",
        "--test-concurrency=1",
        // Human-readable output for the operator, plus a machine-readable copy
        // used only to classify the lane.
        "--test-reporter=spec",
        "--test-reporter-destination=stdout",
        "--test-reporter=tap",
        `--test-reporter-destination=${tapPath}`,
        compiled,
      ],
      { cwd: repoRoot, env: { ...process.env, ...LANE_ENV }, stdio: "inherit" },
    );

    let tap;
    try {
      tap = readFileSync(tapPath, "utf8");
    } catch {
      // Left undefined; `classifyLaneResult` turns that into a failure rather
      // than assuming the lane passed.
      tap = undefined;
    }
    return { exitStatus: run.status, tap };
  });
} finally {
  // Runs even if a lane throws, so the fixture directory cannot leak.
  rmSync(tapDirectory, { recursive: true, force: true });
}

console.log(
  `\nLanes attempted (${report.attempted.length}/${LANE_MANIFEST.length}): ` +
    `${report.attempted.join(", ")}`,
);

if (report.failure !== null) {
  console.error("\nStrict product-workflow lane FAILED:");
  console.error(`  - ${report.failure}`);
  console.error(
    "\nStopped at the first failure. Later lanes were not attempted, because " +
      "they usually fail for the same reason and would spend money proving it.",
  );
  process.exit(1);
}

console.log(
  `\nStrict product-workflow lane passed: ${LANE_MANIFEST.length} lanes, no skips.`,
);
