import test from "node:test";
import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import { PassThrough } from "node:stream";
import { z } from "zod";

import {
  ConfiguredFileParserLauncher,
  SourceFileParserLauncher,
  TEAM_RUNTIME_FILE_PARSER_ENTRY_ENV,
  resolveRuntimeFileParserLauncher,
  runFileParserProcess,
  type FileParserLauncher,
  type SpawnFileParserProcess,
} from "../../core/file-parser-launcher.js";
import {
  ElectronFileParserLauncher,
  resolveDesktopFileParserEntry,
} from "../../electron/file-parser-launcher.js";

interface FakeChild extends EventEmitter {
  stderr: PassThrough;
}

function fakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stderr = new PassThrough();
  return child;
}

async function waitForFile(filePath: string, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(filePath)) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${path.basename(filePath)}`);
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForProcessStop(target: number, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (processIsAlive(target) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test("runFileParserProcess resolves only after a successful exit", async () => {
  const child = fakeChild();
  const spawnProcess: SpawnFileParserProcess = () =>
    child as unknown as ChildProcess;
  const result = runFileParserProcess({
    command: "parser",
    args: ["input"],
    cwd: "/tmp",
    spawnProcess,
  });

  child.emit("exit", 0, null);
  await result;
});

test("runFileParserProcess surfaces stderr on a failed exit", async () => {
  const child = fakeChild();
  const spawnProcess: SpawnFileParserProcess = () =>
    child as unknown as ChildProcess;
  const result = runFileParserProcess({
    command: "parser",
    args: ["input"],
    cwd: "/tmp",
    spawnProcess,
  });

  child.stderr.write("unsupported document");
  child.emit("exit", 2, null);
  await assert.rejects(result, /exit code 2: unsupported document/);
});

test(
  "runFileParserProcess force-kills a real hung parser after timeout and recovers",
  { skip: process.platform === "win32" },
  async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "hung-file-parser-"));
    const pidPath = path.join(root, "parser.pid");
    const hungScript = [
      "const fs = require('node:fs')",
      "process.on('SIGTERM', () => {})",
      "fs.writeFileSync(process.argv[1], String(process.pid))",
      "setInterval(() => {}, 1000)",
    ].join(";");
    const startedAt = Date.now();

    try {
      await assert.rejects(
        runFileParserProcess({
          command: process.execPath,
          args: ["-e", hungScript, pidPath],
          cwd: root,
          timeoutMs: 500,
          terminationGraceMs: 100,
        }),
        /timed out after 500ms/,
      );
      await waitForFile(pidPath);
      const parserPid = Number(fs.readFileSync(pidPath, "utf8"));
      const parserTarget = process.platform === "win32" ? parserPid : -parserPid;
      await waitForProcessStop(parserTarget);
      assert.equal(processIsAlive(parserTarget), false);
      assert.ok(Date.now() - startedAt < 2_500);

      await runFileParserProcess({
        command: process.execPath,
        args: ["-e", "process.exit(0)"],
        cwd: root,
        timeoutMs: 1_000,
        terminationGraceMs: 100,
      });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  },
);

test(
  "runFileParserProcess aborts and force-kills a real parser that ignores SIGTERM",
  { skip: process.platform === "win32" },
  async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "aborted-file-parser-"));
    const pidPath = path.join(root, "parser.pid");
    const controller = new AbortController();
    const hungScript = [
      "const fs = require('node:fs')",
      "process.on('SIGTERM', () => {})",
      "fs.writeFileSync(process.argv[1], String(process.pid))",
      "setInterval(() => {}, 1000)",
    ].join(";");

    try {
      const result = runFileParserProcess({
        command: process.execPath,
        args: ["-e", hungScript, pidPath],
        cwd: root,
        signal: controller.signal,
        timeoutMs: 5_000,
        terminationGraceMs: 100,
      });
      await waitForFile(pidPath);
      controller.abort();
      await assert.rejects(result, (error: unknown) => {
        assert.equal((error as Error).name, "AbortError");
        return true;
      });
      const parserPid = Number(fs.readFileSync(pidPath, "utf8"));
      const parserTarget = process.platform === "win32" ? parserPid : -parserPid;
      await waitForProcessStop(parserTarget);
      assert.equal(processIsAlive(parserTarget), false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  },
);

test("SourceFileParserLauncher uses the source entry through tsx", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "source-parser-launcher-"));
  const parserDir = path.join(root, "file-parser");
  const inputDir = path.join(root, "inputs");
  fs.mkdirSync(parserDir, { recursive: true });
  fs.mkdirSync(inputDir, { recursive: true });
  fs.writeFileSync(path.join(parserDir, "index.ts"), "", "utf8");
  let invocation:
    | { command: string; args: readonly string[]; cwd: string | undefined }
    | undefined;
  const spawnProcess: SpawnFileParserProcess = (command, args, options) => {
    invocation = { command, args, cwd: options?.cwd?.toString() };
    const child = fakeChild();
    queueMicrotask(() => child.emit("exit", 0, null));
    return child as unknown as ChildProcess;
  };

  try {
    await new SourceFileParserLauncher(root, spawnProcess).parseDirectory(
      inputDir,
    );
    assert.equal(invocation?.command, process.execPath);
    assert.deepEqual(invocation?.args, [
      createRequire(import.meta.url).resolve("tsx/cli"),
      path.join(parserDir, "index.ts"),
      inputDir,
    ]);
    assert.equal(invocation?.cwd, parserDir);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("runtime resolver executes the configured compiled parser entry", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "configured-parser-launcher-"));
  const parserEntry = path.join(root, "file-parser", "dist", "index.js");
  const inputDir = path.join(root, "inputs");
  fs.mkdirSync(path.dirname(parserEntry), { recursive: true });
  fs.mkdirSync(inputDir);
  fs.writeFileSync(parserEntry, "", "utf8");
  let invocation:
    | { command: string; args: readonly string[]; cwd: string | undefined }
    | undefined;
  const spawnProcess: SpawnFileParserProcess = (command, args, options) => {
    invocation = { command, args, cwd: options?.cwd?.toString() };
    const child = fakeChild();
    queueMicrotask(() => child.emit("exit", 0, null));
    return child as unknown as ChildProcess;
  };

  try {
    const launcher = resolveRuntimeFileParserLauncher({
      env: { [TEAM_RUNTIME_FILE_PARSER_ENTRY_ENV]: parserEntry },
      spawnProcess,
    });
    assert.ok(launcher instanceof ConfiguredFileParserLauncher);
    await launcher.parseDirectory(inputDir);
    assert.equal(invocation?.command, process.execPath);
    assert.deepEqual(invocation?.args, [parserEntry, inputDir]);
    assert.equal(invocation?.cwd, path.dirname(parserEntry));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("runtime resolver rejects a missing configured parser entry", () => {
  assert.throws(
    () =>
      resolveRuntimeFileParserLauncher({
        env: {
          [TEAM_RUNTIME_FILE_PARSER_ENTRY_ENV]:
            "/missing/file-parser/dist/index.js",
        },
      }),
    /File parser entry is missing/,
  );
});

test("ElectronFileParserLauncher executes the bundled JavaScript in Node mode", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "desktop-parser-launcher-"));
  const inputDir = path.join(root, "inputs");
  const parserEntry = resolveDesktopFileParserEntry(root);
  fs.mkdirSync(path.dirname(parserEntry), { recursive: true });
  fs.mkdirSync(inputDir, { recursive: true });
  fs.writeFileSync(parserEntry, "", "utf8");
  let invocation:
    | {
        command: string;
        args: readonly string[];
        cwd: string | undefined;
        nodeMode: string | undefined;
      }
    | undefined;
  const spawnProcess: SpawnFileParserProcess = (command, args, options) => {
    invocation = {
      command,
      args,
      cwd: options?.cwd?.toString(),
      nodeMode: options?.env?.ELECTRON_RUN_AS_NODE,
    };
    const child = fakeChild();
    queueMicrotask(() => child.emit("exit", 0, null));
    return child as unknown as ChildProcess;
  };

  try {
    await new ElectronFileParserLauncher(
      root,
      "/Applications/Electron",
      spawnProcess,
    ).parseDirectory(inputDir);
    assert.equal(invocation?.command, "/Applications/Electron");
    assert.deepEqual(invocation?.args, [parserEntry, inputDir]);
    assert.equal(invocation?.cwd, path.dirname(parserEntry));
    assert.equal(invocation?.nodeMode, "1");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ── Single-file parses for folder indexing ──

/** Every variable that turns enrichment on, picks its model, carries its key or names its endpoint. */
const ENRICHMENT_SETTINGS = {
  FILE_PARSER_LLM_ENABLED: "1",
  FILE_PARSER_LM_ENABLED: "1",
  FILE_PARSER_LLM_PROVIDER: "openai",
  FILE_PARSER_LM_PROVIDER: "openai",
  FILE_PARSER_LLM_MODEL: "parent-model",
  FILE_PARSER_LM_MODEL: "parent-model",
  FILE_PARSER_OPENAI_API_KEY: "parent-parser-key",
  FILE_PARSER_OPENAI_BASE_URL: "http://127.0.0.1:9/v1",
  OPENAI_API_KEY: "parent-openai-key",
} as const;

/** OCR's own settings, which a local-only parse keeps. */
const OCR_SETTINGS = {
  FILE_PARSER_OCR_DATA_DIR: "/opt/ocr-language-data",
  FILE_PARSER_MAX_RENDERED_PAGES: "3",
} as const;

/**
 * A stand-in parser entry that records how it was started: its arguments and its environment,
 * written into the output folder it was given.
 */
const REPORTING_PARSER_SOURCE = [
  'const fs = require("node:fs");',
  'const path = require("node:path");',
  "const args = process.argv.slice(2);",
  'const output = args[args.indexOf("--output") + 1];',
  "fs.mkdirSync(output, { recursive: true });",
  'fs.writeFileSync(path.join(output, "launch.json"), JSON.stringify({ args, env: process.env }));',
].join("\n");

const launchReportSchema = z.object({
  args: z.array(z.string()),
  env: z.record(z.string(), z.string()),
});

function readLaunchReport(outputDir: string): z.infer<typeof launchReportSchema> {
  const raw: unknown = JSON.parse(
    fs.readFileSync(path.join(outputDir, "launch.json"), "utf8"),
  );
  return launchReportSchema.parse(raw);
}

async function withParentEnvironment<T>(
  values: Readonly<Record<string, string>>,
  run: () => Promise<T>,
): Promise<T> {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(values)) {
    previous.set(key, process.env[key]);
    process.env[key] = value;
  }
  try {
    return await run();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

interface LauncherUnderTest {
  readonly name: string;
  /** Where this launcher looks for the parser entry under an application root. */
  entryPath(root: string): string;
  create(root: string): FileParserLauncher;
  readonly nodeMode: string | undefined;
}

const launchersUnderTest: readonly LauncherUnderTest[] = [
  {
    name: "ElectronFileParserLauncher",
    entryPath: (root) => resolveDesktopFileParserEntry(root),
    create: (root) => new ElectronFileParserLauncher(root, process.execPath),
    nodeMode: "1",
  },
  {
    name: "ConfiguredFileParserLauncher",
    entryPath: (root) => path.join(root, "file-parser", "dist", "index.js"),
    create: (root) =>
      new ConfiguredFileParserLauncher(
        path.join(root, "file-parser", "dist", "index.js"),
      ),
    nodeMode: undefined,
  },
  {
    name: "SourceFileParserLauncher",
    entryPath: (root) => path.join(root, "file-parser", "index.ts"),
    create: (root) => new SourceFileParserLauncher(root),
    nodeMode: undefined,
  },
];

for (const subject of launchersUnderTest) {
  test(`${subject.name} starts a local-only parse of one file without the parent's enrichment settings`, async () => {
    const root = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "local-only-parser-launch-")),
    );
    const entry = subject.entryPath(root);
    fs.mkdirSync(path.dirname(entry), { recursive: true });
    fs.writeFileSync(entry, REPORTING_PARSER_SOURCE, "utf8");
    const filePath = path.join(root, "shared", "Clients", "MSA.pdf");
    const outputDir = path.join(root, "cache", "msa");

    try {
      await withParentEnvironment({ ...ENRICHMENT_SETTINGS, ...OCR_SETTINGS }, () =>
        subject.create(root).parseFile({ filePath, outputDir, localOnly: true }),
      );

      const launch = readLaunchReport(outputDir);
      assert.deepEqual(launch.args, [
        "--file",
        filePath,
        "--output",
        outputDir,
        "--local-only",
      ]);
      for (const key of Object.keys(ENRICHMENT_SETTINGS)) {
        assert.equal(launch.env[key], undefined, `${key} does not reach the parser`);
      }
      assert.equal(launch.env.FILE_PARSER_LOCAL_ONLY, "1");
      assert.equal(launch.env.FILE_PARSER_OCR_DATA_DIR, OCR_SETTINGS.FILE_PARSER_OCR_DATA_DIR);
      assert.equal(
        launch.env.FILE_PARSER_MAX_RENDERED_PAGES,
        OCR_SETTINGS.FILE_PARSER_MAX_RENDERED_PAGES,
      );
      assert.equal(launch.env.PATH, process.env.PATH, "The rest of the environment is kept");
      assert.equal(launch.env.ELECTRON_RUN_AS_NODE, subject.nodeMode);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
}
