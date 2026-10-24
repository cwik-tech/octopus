import * as fs from "node:fs";

const logPath = requiredEnvironment(
  "DEVELOPMENT_DESKTOP_LAUNCHER_FIXTURE_LOG",
);
const exitCodes = requiredEnvironment(
  "DEVELOPMENT_DESKTOP_LAUNCHER_FIXTURE_EXIT_CODES",
)
  .split(",")
  .map((value) => Number(value));

if (
  exitCodes.length === 0 ||
  exitCodes.some(
    (value) => !Number.isInteger(value) || value < 0 || value > 255,
  )
) {
  throw new Error("Fixture exit codes must be comma-separated integers from 0 to 255.");
}

const attempt = fs.existsSync(logPath)
  ? fs
      .readFileSync(logPath, "utf8")
      .split("\n")
      .filter(Boolean).length + 1
  : 1;
const record = {
  attempt,
  args: process.argv.slice(2),
  cwd: process.cwd(),
  environment: Object.fromEntries(
    Object.entries(process.env).sort(([left], [right]) =>
      left.localeCompare(right),
    ),
  ),
};

fs.appendFileSync(logPath, `${JSON.stringify(record)}\n`, "utf8");
process.exitCode = exitCodes[Math.min(attempt - 1, exitCodes.length - 1)];

function requiredEnvironment(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable ${name}.`);
  return value;
}
