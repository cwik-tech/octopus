/**
 * Stop processes left behind by test runs that are no longer going.
 *
 * The runner sweeps on its own way out, including when it is interrupted. This
 * is for the case it cannot cover: a runner killed outright, which never reaches
 * its own sweep. A run that is still going is left alone — its runner is alive,
 * and the run id carries the pid that says so — so this is safe to use while
 * another worktree is running tests.
 */
import {
  findAbandonedSurvivors,
  isProcessAlive,
  parseProcessTable,
  readProcessTable,
} from "./support/test-run-reaper.js";

const table = parseProcessTable(readProcessTable());
// No run is current here, so every tagged process with a dead owner qualifies.
const abandoned = findAbandonedSurvivors({
  processTable: table,
  currentRunId: "",
});

if (abandoned.length === 0) {
  console.log("No abandoned test processes.");
  process.exit(0);
}

for (const pid of abandoned) {
  const entry = table.find((candidate) => candidate.pid === pid);
  console.log(`Stopping ${String(pid)}: ${(entry?.line ?? "").slice(0, 120)}`);
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // It exited between the process table read and the signal.
  }
}

const stillAlive = abandoned.filter((pid) => isProcessAlive(pid));
if (stillAlive.length > 0) {
  console.error(`Could not stop: ${stillAlive.join(", ")}`);
  process.exit(1);
}
console.log(`Stopped ${String(abandoned.length)} abandoned test process(es).`);
