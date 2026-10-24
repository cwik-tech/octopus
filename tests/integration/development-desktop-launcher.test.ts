import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import {
  DevelopmentDesktopReplacementTimeoutError,
  launchDevelopmentDesktop,
} from "../../services/development/development-desktop-launcher.js";
import {
  canonicalDevelopmentRepositoryRoot,
  DEVELOPMENT_DESKTOP_RESTART_ENABLED_ENV,
  DEVELOPMENT_DESKTOP_RESTART_EXIT_CODE,
  DEVELOPMENT_DESKTOP_RESTART_ROOT_ENV,
} from "../../services/development/development-desktop-restart.js";

const FIXTURE_LOG_ENV = "DEVELOPMENT_DESKTOP_LAUNCHER_FIXTURE_LOG";
const FIXTURE_EXIT_CODES_ENV =
  "DEVELOPMENT_DESKTOP_LAUNCHER_FIXTURE_EXIT_CODES";
const FIXTURE_PATH = path.resolve(
  process.cwd(),
  "tests",
  "fixtures",
  "development-desktop-launcher-child.mjs",
);

interface FixtureRecord {
  attempt: number;
  args: string[];
  cwd: string;
  environment: Record<string, string>;
}

test(
  "development desktop launcher retries replacement and preserves exact launch context",
  { timeout: 10_000 },
  async () => {
    const fixture = createFixture("retry");
    const appArguments = ["--workspace", "argument with spaces", "--flag=value"];
    const environment = fixtureEnvironment(fixture.logPath, [
      DEVELOPMENT_DESKTOP_RESTART_EXIT_CODE,
      0,
    ]);

    try {
      const result = await launchDevelopmentDesktop({
        appArguments,
        electronCliPath: FIXTURE_PATH,
        environment,
        executablePath: process.execPath,
        forwardSignals: false,
        repositoryRoot: fixture.repositoryRoot,
        retryDelayMs: 10,
        retryTimeoutMs: 2_000,
        stdio: "ignore",
      });

      assert.deepEqual(result, { attempts: 2, code: 0, signal: null });
      const canonicalRoot = canonicalDevelopmentRepositoryRoot(
        fixture.repositoryRoot,
      );
      const expectedEnvironment = {
        ...environment,
        [DEVELOPMENT_DESKTOP_RESTART_ENABLED_ENV]: "1",
        [DEVELOPMENT_DESKTOP_RESTART_ROOT_ENV]: canonicalRoot,
      };
      const records = readFixtureRecords(fixture.logPath);
      assert.deepEqual(
        records.map(({ attempt, args, cwd }) => ({ attempt, args, cwd })),
        [
          { attempt: 1, args: appArguments, cwd: canonicalRoot },
          { attempt: 2, args: appArguments, cwd: canonicalRoot },
        ],
      );
      for (const record of records) {
        assert.deepEqual(
          selectEnvironment(record.environment, Object.keys(expectedEnvironment)),
          expectedEnvironment,
        );
      }
    } finally {
      fixture.cleanup();
    }
  },
);

test(
  "development desktop launcher propagates a non-retry exit without another process",
  { timeout: 10_000 },
  async () => {
    const fixture = createFixture("non-retry");
    const environment = fixtureEnvironment(fixture.logPath, [23]);

    try {
      const result = await launchDevelopmentDesktop({
        appArguments: ["."],
        electronCliPath: FIXTURE_PATH,
        environment,
        executablePath: process.execPath,
        repositoryRoot: fixture.repositoryRoot,
        retryDelayMs: 0,
        retryTimeoutMs: 2_000,
        stdio: "ignore",
      });

      assert.deepEqual(result, { attempts: 1, code: 23, signal: null });
      assert.equal(readFixtureRecords(fixture.logPath).length, 1);
    } finally {
      fixture.cleanup();
    }
  },
);

test(
  "development desktop launcher bounds repeated replacement attempts by timeout",
  { timeout: 10_000 },
  async () => {
    const fixture = createFixture("timeout");
    const guardExitCode = 24;
    const environment = fixtureEnvironment(fixture.logPath, [
      ...Array.from({ length: 12 }, () =>
        DEVELOPMENT_DESKTOP_RESTART_EXIT_CODE),
      guardExitCode,
    ]);
    const timeoutMs = 100;
    const startedAt = Date.now();

    try {
      await assert.rejects(
        launchDevelopmentDesktop({
          appArguments: ["."],
          electronCliPath: FIXTURE_PATH,
          environment,
          executablePath: process.execPath,
          repositoryRoot: fixture.repositoryRoot,
          retryDelayMs: 10,
          retryTimeoutMs: timeoutMs,
          stdio: "ignore",
        }),
        (error: unknown) => {
          assert.ok(error instanceof DevelopmentDesktopReplacementTimeoutError);
          assert.equal(
            error.repositoryRoot,
            canonicalDevelopmentRepositoryRoot(fixture.repositoryRoot),
          );
          assert.equal(error.timeoutMs, timeoutMs);
          assert.ok(error.attempts >= 1);
          return true;
        },
      );

      const elapsedMs = Date.now() - startedAt;
      assert.ok(
        elapsedMs < 3_000,
        `Replacement timeout took ${elapsedMs}ms instead of remaining bounded.`,
      );
      const records = readFixtureRecords(fixture.logPath);
      assert.ok(records.length >= 1);
      assert.ok(records.length <= 12);
    } finally {
      fixture.cleanup();
    }
  },
);

function createFixture(label: string): {
  cleanup: () => void;
  logPath: string;
  repositoryRoot: string;
} {
  const repositoryRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), `development-desktop-${label}-`),
  );
  return {
    cleanup: () =>
      fs.rmSync(repositoryRoot, { recursive: true, force: true }),
    logPath: path.join(repositoryRoot, "launches.ndjson"),
    repositoryRoot,
  };
}

function fixtureEnvironment(
  logPath: string,
  exitCodes: readonly number[],
): NodeJS.ProcessEnv {
  return {
    [FIXTURE_LOG_ENV]: logPath,
    [FIXTURE_EXIT_CODES_ENV]: exitCodes.join(","),
    DEVELOPMENT_DESKTOP_LAUNCHER_FIXTURE_SENTINEL: "preserved exactly",
  };
}

function readFixtureRecords(logPath: string): FixtureRecord[] {
  return fs
    .readFileSync(logPath, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as FixtureRecord);
}

function selectEnvironment(
  environment: Record<string, string>,
  names: readonly string[],
): Record<string, string> {
  return Object.fromEntries(names.flatMap((name) => {
    const value = environment[name]
    return value === undefined ? [] : [[name, value]]
  }))
}
