import { whenDefined } from "./optional-properties.js"
import * as path from "node:path";

import {
  acquireProcessFileLock,
  createCrossProcessFileLockRecord,
  crossProcessFileLockAdapter,
} from "./cross-process-file-lock.js";
import type {
  FileParseRequest,
  FileParserLauncher,
  FileParserRequestOptions,
} from "./file-parser-launcher.js";

const DEFAULT_LOCK_TIMEOUT_MS = 6 * 60 * 1_000;
const coordinatedLauncher = Symbol("coordinatedFileParserLauncher");

interface CoordinatedFileParserLauncher extends FileParserLauncher {
  readonly [coordinatedLauncher]: true;
}

export interface FileParseCoordinatorOptions {
  lockTimeoutMs?: number;
}

export function coordinateFileParserLauncher(
  launcher: FileParserLauncher,
  options: FileParseCoordinatorOptions = {},
): FileParserLauncher {
  if (isCoordinatedLauncher(launcher)) return launcher;
  const lockTimeoutMs =
    options.lockTimeoutMs === undefined
      ? DEFAULT_LOCK_TIMEOUT_MS
      : requireNonNegativeDuration(options.lockTimeoutMs);

  return new ProcessLockedFileParserLauncher(launcher, lockTimeoutMs);
}

export function resolveFileParserLockPath(inputDir: string): string {
  const resolvedInputDir = path.resolve(inputDir);
  const inputDirectoryName = path.basename(resolvedInputDir);
  if (!inputDirectoryName) {
    throw new Error("File parser input directory must not be a filesystem root");
  }
  return path.join(
    path.dirname(resolvedInputDir),
    `.${inputDirectoryName}.file-parser.lock`,
  );
}

class ProcessLockedFileParserLauncher
  implements CoordinatedFileParserLauncher
{
  readonly [coordinatedLauncher] = true as const;

  constructor(
    private readonly launcher: FileParserLauncher,
    private readonly lockTimeoutMs: number,
  ) {}

  async parseDirectory(
    inputDir: string,
    options: FileParserRequestOptions = {},
  ): Promise<void> {
    const lock = await acquireProcessFileLock({
      lockPath: resolveFileParserLockPath(inputDir),
      record: createCrossProcessFileLockRecord(),
      adapter: crossProcessFileLockAdapter,
      timeoutMs: this.lockTimeoutMs,
      waitDescription: "file parser lock",
      corruptBehavior: "wait",
      ...whenDefined(options.signal, (definedValue) => ({ signal: definedValue })),
    });
    try {
      await this.launcher.parseDirectory(inputDir, options);
    } finally {
      await lock.release();
    }
  }

  /**
   * Passed straight through. The lock above guards a directory's shared `parsed/` folder; a
   * single-file parse writes only into the output folder its caller chose for it.
   */
  async parseFile(
    input: FileParseRequest,
    options: FileParserRequestOptions = {},
  ): Promise<void> {
    await this.launcher.parseFile(input, options);
  }
}

function isCoordinatedLauncher(
  launcher: FileParserLauncher,
): launcher is CoordinatedFileParserLauncher {
  return (launcher as Partial<CoordinatedFileParserLauncher>)[
    coordinatedLauncher
  ] === true;
}

function requireNonNegativeDuration(value: number): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error("lockTimeoutMs must be a non-negative duration");
  }
  return value;
}
