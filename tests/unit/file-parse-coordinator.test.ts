import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import {
  coordinateFileParserLauncher,
  resolveFileParserLockPath,
} from "../../core/file-parse-coordinator.js";
import type { FileParserLauncher } from "../../core/file-parser-launcher.js";
import { parseFileNotExpected } from "../support/file-parser-launcher-doubles.js";

test("file parser coordination serializes callers and is idempotent", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "file-parse-lock-"));
  const inputDir = path.join(root, "inputs");
  await fs.mkdir(inputDir);
  let active = 0;
  let maximumActive = 0;
  const releases: Array<() => void> = [];
  const launcher: FileParserLauncher = {
    async parseDirectory() {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise<void>((resolve) => releases.push(resolve));
      active -= 1;
    },
    parseFile: parseFileNotExpected,
  };
  const coordinated = coordinateFileParserLauncher(launcher, {
    lockTimeoutMs: 2_000,
  });

  try {
    assert.equal(coordinateFileParserLauncher(coordinated), coordinated);
    const first = coordinated.parseDirectory(inputDir);
    await waitFor(() => releases.length === 1);
    const second = coordinated.parseDirectory(inputDir);
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(releases.length, 1);

    releases.shift()?.();
    await waitFor(() => releases.length === 1);
    releases.shift()?.();
    await Promise.all([first, second]);

    assert.equal(maximumActive, 1);
    await assert.rejects(fs.stat(resolveFileParserLockPath(inputDir)), {
      code: "ENOENT",
    });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("file parser coordination aborts while waiting for another owner", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "file-parse-abort-"));
  const inputDir = path.join(root, "inputs");
  await fs.mkdir(inputDir);
  let releaseFirst: (() => void) | undefined;
  const launcher: FileParserLauncher = {
    async parseDirectory() {
      await new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
    },
    parseFile: parseFileNotExpected,
  };
  const coordinated = coordinateFileParserLauncher(launcher, {
    lockTimeoutMs: 2_000,
  });

  try {
    const first = coordinated.parseDirectory(inputDir);
    await waitFor(() => releaseFirst !== undefined);
    const controller = new AbortController();
    const second = coordinated.parseDirectory(inputDir, {
      signal: controller.signal,
    });
    controller.abort();
    await assert.rejects(second, (error: unknown) => {
      assert.equal((error as Error).name, "AbortError");
      return true;
    });
    releaseFirst?.();
    await first;
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("file parser coordination allows different input directories concurrently", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "file-parse-parallel-"));
  const firstInput = path.join(root, "first");
  const secondInput = path.join(root, "second");
  await Promise.all([fs.mkdir(firstInput), fs.mkdir(secondInput)]);
  let active = 0;
  let maximumActive = 0;
  const releases: Array<() => void> = [];
  const coordinated = coordinateFileParserLauncher({
    async parseDirectory() {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise<void>((resolve) => releases.push(resolve));
      active -= 1;
    },
    parseFile: parseFileNotExpected,
  });

  try {
    const first = coordinated.parseDirectory(firstInput);
    const second = coordinated.parseDirectory(secondInput);
    await waitFor(() => releases.length === 2);
    for (const release of releases.splice(0)) release();
    await Promise.all([first, second]);
    assert.equal(maximumActive, 2);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("file parser coordination reclaims a dead lock owner", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "file-parse-stale-"));
  const inputDir = path.join(root, "inputs");
  await fs.mkdir(inputDir);
  const lockPath = resolveFileParserLockPath(inputDir);
  await fs.writeFile(
    lockPath,
    `${JSON.stringify({
      pid: 2_147_483_647,
      nonce: "stale-owner",
      createdAt: new Date(0).toISOString(),
    })}\n`,
    "utf8",
  );
  let parsed = false;
  const coordinated = coordinateFileParserLauncher(
    {
      async parseDirectory() {
        parsed = true;
      },
      parseFile: parseFileNotExpected,
    },
    { lockTimeoutMs: 2_000 },
  );

  try {
    await coordinated.parseDirectory(inputDir);
    assert.equal(parsed, true);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 2_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for state");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
