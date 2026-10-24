import { spawnSync } from "node:child_process";
import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { availableParallelism, cpus } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { stageRuntimeAssets } from "../scripts/stage-runtime-assets.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const distDir = path.join(repoRoot, ".tests-dist");
const suite = process.argv[2] ?? "all";
let finishing = false;

const validSuites = new Set(["all", "unit", "integration"]);
if (!validSuites.has(suite)) {
  console.error(`Unknown test suite: ${suite}`);
  process.exit(1);
}

rmSync(distDir, { recursive: true, force: true });

const compile = spawnSync("tsc", ["-p", "tests/tsconfig.test.json"], {
  cwd: repoRoot,
  stdio: "inherit",
});

if (compile.status !== 0) {
  process.exit(compile.status ?? 1);
}

// Assets the compiled modules resolve relative to themselves.
//
// `tsc` emits JavaScript and nothing else, so a module that reads a file from
// `../../examples` finds nothing under `.tests-dist` — and the minutes helper
// treats a missing template as a reason to fall back rather than as an error.
// A test would then pass while asserting the fallback it did not mean to
// exercise. Staged once here, where the compiled tree is built, so no test has
// to create and remove a directory another test is reading.
//
// The same declaration the desktop build uses, deliberately: the compiled tests
// and the shipped application must not be able to disagree about where a
// runtime asset lives, which is how the desktop build came to ship without this
// one at all.
await stageRuntimeAssets(distDir);

// A stand-in, first on every test process's PATH, for each AI CLI the app
// looks up by name.
//
// Listing the CLI agents runs each one it finds, and launching a task lists
// them. Since the app asks Claude Code and Qwen for their models, each listing
// starts both installed CLIs, a handshake of up to 15 seconds each. With the
// pool below running many files at once, that held a 16-core machine's load
// above 30 and pushed the timing-bound suites past their bounds. What is
// installed on the machine running the tests is not something a test should
// depend on. A stand-in is found first and exits at once; a test that needs a
// CLI puts its own fake ahead of it, as every test that sets PATH already does.
const cliStandInDir = path.join(distDir, "cli-stand-ins");
mkdirSync(cliStandInDir);
for (const command of ["claude", "codex", "gemini", "kimi", "pi", "qwen"]) {
  writeFileSync(path.join(cliStandInDir, command), "#!/bin/sh\nexit 127\n", {
    mode: 0o755,
  });
}

// The reaper compiles with the tests, so it is loaded here rather than at the
// top: `.tests-dist` does not exist until the step above has run, and nothing
// has been spawned before it that could need reaping.
const {
  TEST_RUN_ID_ENV,
  createTestRunId,
  findAbandonedSurvivors,
  parseProcessTable,
  readProcessTable,
  reapSurvivors,
} = await import(
  pathToFileURL(
    path.join(distDir, "tests", "support", "test-run-reaper.js"),
  ).href
);

// Stamped into the environment of every test process, and inherited by every
// descendant they spawn — including the detached task hosts that outlive the
// run by design and the grandchildren no test holds a handle for.
const testRunId = createTestRunId();

await reapAbandonedRuns();
installReaperSignalHandlers();

const testTargets = [];
if (suite === "all" || suite === "unit") {
  testTargets.push(...collectTestFiles(path.join(distDir, "tests", "unit")));
}
if (suite === "all" || suite === "integration") {
  testTargets.push(
    ...collectTestFiles(path.join(distDir, "tests", "integration")),
  );
}

if (testTargets.length === 0) {
  console.error(`No compiled test files found for suite: ${suite}`);
  process.exit(1);
}

// These tests intentionally stress real processes/transports or thousands of
// durable records. Run them alone so their timing and cleanup assertions are
// not distorted by unrelated suite-wide CPU and filesystem contention.
const isolatedTestBasenames = new Set([
  // Starts real worker processes per case and kills an owner to prove recovery.
  "agent-question-worker.test.js",
  "agent-runner.test.js",
  // Spawns a real CLI child per case and includes causal stall/cancellation
  // assertions whose first heartbeat must not be delayed by suite-wide CPU
  // contention past the watchdog's failure-safety threshold.
  "codex-provider.test.js",
  "bounded-parallel-cancel-reproduction.test.js",
  "api-server-process-ownership.test.js",
  "browser-agent-e2e.test.js",
  // Launches a real Chrome per compared launch profile and reads a loopback
  // origin through each. Expensive processes plus a shared browser executable,
  // which is exactly what the isolation rule names.
  "browser-countermeasure-bakeoff.test.js",
  // Launches a real Chrome with a debugging port and drives it over CDP, which
  // is the same expensive shared executable the bake-off isolates.
  "cloud-browser-acquisition.test.js",
  "browser-manager-live.test.js",
  "browser-manager-proxied-context.test.js",
  "browser-settings-route.test.js",
  "batch-cancel.test.js",
  "batch-global-admission.test.js",
  "batch-item-launch.test.js",
  // Exercises concurrent resource updates through a real loopback provider and
  // deliberately holds one persistence call for an event-loop turn. Preserve
  // that internal concurrency without unrelated suite-wide scheduling noise.
  "resource-architect-update-batch.test.js",
  "deep-research-plan-approval.test.js",
  // Starts a real API server and a task process while exercising abandoned-turn
  // recovery. Run it outside the parallel pool so suite contention cannot turn
  // its bounded process cleanup into a false timeout.
  "session-messages-turn-outcomes.test.js",
  // Spawns a real detached session worker per case and reads what a scheduled
  // fire dispatched from an owned loopback provider. Real processes plus a
  // shared workspace, which is what the isolation rule names.
  "schedule-legacy-model-override-fire.test.js",
  "research-web-acquisition.test.js",
  "research-web-proxied-retry.test.js",
  "research-web-browser-proxied-retry.test.js",
  "research-web-webshare-wiring.test.js",
  "research-web-activity-order.test.js",
  "research-web-parallel-fanout.test.js",
  "research-web-parallel-safety.test.js",
  "research-web-provider-fanout.test.js",
  // Starts eight real processes that contend for one coordinator receipt and
  // counts the provider invocations between them. Concurrent processes, which
  // is exactly what the isolation rule names.
  "durable-coordinator-call-retry-concurrency.test.js",
  "durable-workflow-process-recovery.test.js",
  // Runs several real Team runtime subprocesses in sequence over one workspace,
  // each spawning its own provider processes, and one of its journeys also
  // stands up a real task queue and dispatcher owner. Expensive processes, which
  // is what the isolation rule names.
  "team-chat-continuation.test.js",
  "team-runtime-discussion-process-recovery.test.js",
  // Spawns the real managed Team host — a Pi child driving two coordinator
  // turns against a loopback provider — and waits for it to exit. An
  // expensive process whose lifetime is the thing under test, so suite-wide
  // contention must not turn its bounded watchdog into a false failure.
  "team-runtime-print-mode-handover.test.js",
  // Spawns a real Node child that loads the whole extension twice and then
  // exits, because process-exit cleanup cannot be observed from inside the
  // process doing the exiting. An expensive child process, which is what the
  // isolation rule names.
  "team-runtime-owned-agent-directory-exit.test.js",
  "development-desktop-launcher.test.js",
  "delegated-capability-authority.test.js",
  // Spawns a real child process per case and drives a full durable workflow
  // run through it. Expensive processes, which is what the isolation rule
  // names.
  "workflow-returned-failure-model-choice.test.js",
  // Runs two real API server processes, SIGKILLs one mid-approval, and holds a
  // real cross-process file lock while it does. Expensive processes plus a
  // timing-bounded lock window, both of which the isolation rule names.
  "workflow-model-choice-admission-crash.test.js",
  // Measures eight concurrent receipt and event commits against the real
  // filesystem with a five-second contract. Suite-wide I/O contention is not
  // part of that store contract and has already pushed the case past its bound.
  "deep-research-store.test.js",
  "engine-capability-dispatch.test.js",
  "capability-dispatch-restart.test.js",
  // Opens, closes and reopens a real assignment journal and its content store
  // around a 200 KiB durable result, then walks every file under both owners.
  // A durable dataset and a reopen, which is what the isolation rule names.
  "capability-dispatch-journal-content-separation.test.js",
  "capability-runtime-journal-cutover.test.js",
  // Journal activation suites. Most either spawn a real worker process or
  // mutate PIPELINE_DURABLE_JOURNAL / TEAM_TENANT_ID. Node runs each test file
  // in its own child process, so the mechanism is not env leakage across files;
  // what is established is that two full parallel runs hung and both completed
  // once these were isolated. Contention with ~140 concurrent files is the
  // plausible cause; it is recorded as open rather than guessed at.
  "composition-journal-cutover.test.js",
  // The two AC18 teardown suites are here for a different reason: neither
  // spawns a worker nor touches the environment, but both assert on real
  // shutdown *timing* — a drain that must run out a configured deadline, and
  // work that must still be unfinished at a given moment — while tearing down
  // real HTTP listeners and workspace directories. Those are exactly the
  // assertions suite-wide CPU and filesystem contention distorts.
  "execution-journal-teardown-races.test.js",
  "api-shutdown-sequencing.test.js",
  // Spawns a real worker process, like the other multi-process entries here.
  "execution-journal-projection-recovery.test.js",
  "workflow-human-input-api.test.js",
  "journal-configuration-boundary.test.js",
  "run-private-runtime-permissions.test.js",
  "session-task-runner-journal-startup.test.js",
  // Creates 10,000 sibling activity directories and measures a cold reopen
  // beside them. A large durable dataset and a timing observation, which is
  // exactly what the isolation rule names — not merely a real transport.
  "conversation-activity-journal-scale.test.js",
  // Creates 3,000 filesystem entries to prove operator inspection is bounded.
  // The file is fast alone but can exhaust its case timeout under the full
  // suite's filesystem contention, so keep its real dataset and assertions.
  "conversation-inspection-boundary.test.js",
  "workflow-journal-authority-restart.test.js",
  // AC13: spawn a real worker, kill it with SIGKILL, and count external
  // effects over a loopback listener.
  "workflow-projection-crash-restart.test.js",
  "dispatch-committed-crash-restart.test.js",
  "execution-journal-crash-replay.test.js",
  "execution-journal-multiprocess.test.js",
  "mcp-connection-lifecycle.test.js",
  // Starts a real API server, loopback provider, and stdio MCP process while
  // completing four interactive tool turns. The contract takes under five
  // seconds alone but exceeded its 30-second bound in the full parallel pool.
  "mcp-interactions-api.test.js",
  "mcp-agent-chat-api.test.js",
  "mcp-agent-grants-api.test.js",
  "mcp-cli-agent-tool-service.test.js",
  "mcp-provider-tool-loop.test.js",
  "mcp-resource-client-service.test.js",
  "mcp-settings-api.test.js",
  "mcp-parent-broker.test.js",
  "mcp-resources-api.test.js",
  "mcp-workflow-launch-api.test.js",
  "mcp-workflow-preflight-service.test.js",
  "mcp-worker-turn-service.test.js",
  "plan-parser.test.js",
  "run-orchestrator-queue-contract.test.js",
  "schedule-task-queue.test.js",
  "session-scoped-run-e2e.test.js",
  "session-task-provider-registration.test.js",
  "session-task-process-lifecycle.test.js",
  // Starts nested real hosts and restarts a queue while holding native process
  // groups. Pooled contention exceeded its startup and readiness bounds.
  "owned-process-native-hold.test.js",
  "session-task-recovery-contract.test.js",
  "session-run-snapshot.test.js",
  "task-queue-api-crash-recovery.test.js",
  "task-queue-cold-rebuild.test.js",
  "task-queue-core.test.js",
  "task-queue-real-process-api.test.js",
  "task-queue-startup-readiness.test.js",
]);
const isolatedTargets = testTargets.filter((target) =>
  isolatedTestBasenames.has(path.basename(target)),
);
const parallelTargets = testTargets.filter(
  (target) => !isolatedTargets.includes(target),
);

// Node defaults `--test-concurrency` to `availableParallelism() - 1`, which is
// 1 on a two-vCPU hosted runner: every file waits for the one before it. The
// pool below then costs the sum of its parts — measured at 800s for 724 files
// on CI, of which only 445s was inside a test and the rest per-file process
// start-up — and the job is cancelled on its timeout before the isolated phase
// is ever reached. Most of that wall time is process spawn, module loading and
// filesystem work rather than CPU, so a small oversubscription of a small
// runner is the right floor. The suites that genuinely cannot take contention
// are not in this pool at all: they are named above and run one at a time.
//
// Left overridable so the next run can be re-measured without another commit.
const cpuCount = availableParallelism();
const testConcurrency =
  Number(process.env.PIPELINE_TEST_CONCURRENCY) || Math.max(4, cpuCount - 1);

// Printed unconditionally: every hypothesis about why this suite is slow on CI
// starts with how many cores it actually had, and that number has never once
// appeared in a log.
console.log(
  `[run-tests] suite=${suite} availableParallelism=${cpuCount} ` +
    `cpus=${cpus().length} --test-concurrency=${testConcurrency} ` +
    `files=${testTargets.length} (pooled=${parallelTargets.length}, ` +
    `isolated=${isolatedTargets.length})`,
);

const parallelStatus = runTests(parallelTargets);
if (parallelStatus !== 0) {
  await finish(parallelStatus);
}

for (const target of isolatedTargets) {
  const status = runTests([target]);
  if (status !== 0) {
    await finish(status);
  }
}

await finish(0);

function collectTestFiles(dir) {
  try {
    return readdirSync(dir)
      .filter((entry) => entry.endsWith(".test.js"))
      .map((entry) => path.join(dir, entry))
      .sort();
  } catch {
    return [];
  }
}

function runTests(targets) {
  if (targets.length === 0) {
    return 0;
  }

  const run = spawnSync(
    "node",
    [
      "--experimental-test-module-mocks",
      "--test",
      `--test-concurrency=${testConcurrency}`,
      ...targets,
    ],
    {
      cwd: repoRoot,
      stdio: "inherit",
      // Deliberately not set on this process: the runner must never match its
      // own sweep.
      env: {
        ...process.env,
        PATH: [cliStandInDir, process.env.PATH]
          .filter(Boolean)
          .join(path.delimiter),
        [TEST_RUN_ID_ENV]: testRunId,
      },
    },
  );

  return run.status ?? 1;
}

/**
 * Stop this run's survivors, then exit.
 *
 * Every exit path goes through here, including the signal handlers, so a run
 * that is interrupted cleans up on the way out like one that finishes.
 */
async function finish(status) {
  if (finishing) return;
  finishing = true;

  const result = await reapSurvivors({
    runId: testRunId,
    excludePids: [process.pid],
  });
  if (result.failure) {
    console.error(`Could not check for leaked test processes: ${result.failure}`);
  }
  const reaped = [...result.terminated, ...result.killed];
  if (reaped.length > 0) {
    console.error(
      `Reaped ${String(reaped.length)} leaked test process(es): ${reaped.join(", ")}` +
        (result.killed.length > 0
          ? ` (SIGKILL needed for ${result.killed.join(", ")})`
          : ""),
    );
  }

  process.exit(status);
}

/**
 * Collect what an earlier run could not.
 *
 * A run killed outright never reaches its own `finish`, so its survivors are
 * left for the next run. A run that is still going is left alone: its runner is
 * still alive, and the run id says so.
 */
async function reapAbandonedRuns() {
  let table;
  try {
    table = readProcessTable();
  } catch (error) {
    console.error(`Could not check for abandoned test processes: ${String(error)}`);
    return;
  }

  const abandoned = findAbandonedSurvivors({
    processTable: parseProcessTable(table),
    currentRunId: testRunId,
  });
  if (abandoned.length === 0) return;

  console.error(
    `Found ${String(abandoned.length)} process(es) left by an earlier test run; stopping them.`,
  );
  for (const pid of abandoned) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // It exited between the process table read and the signal.
    }
  }
}

function installReaperSignalHandlers() {
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => {
      // 128 + signal number, the convention a shell reports for a signalled exit.
      void finish(signal === "SIGINT" ? 130 : 143);
    });
  }
}
