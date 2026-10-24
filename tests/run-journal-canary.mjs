import * as path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Entry point for AC15's controlled live canary.
 *
 * The coordination lives in `tests/live/journal-canary-driver.ts` so the
 * attribution rule stays single-sourced with the arms and is unit-testable;
 * this file only resolves paths and turns the report into an exit code.
 */
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { runJournalCanary } = await import("./live/journal-canary-driver.ts");

const report = runJournalCanary({
  repoRoot,
  keepWorkspace: process.env.PIPELINE_KEEP_LIVE_WORKSPACE === "1",
});

// Both arms must run. A failing arm is data for the verdict, not a reason to
// stop; the gate itself passes only when both arms completed.
process.exit(report.passed ? 0 : 1);
